/**
 * 鱼声 Fish Audio TTS 工具 —— MiniMax 的平行实现，供聊天 / 约会 / 电话二选一复用。
 *
 * 与 MiniMax 的关键差异：
 *  1. 鱼声直接返回二进制音频（mp3），不是 JSON 里塞 hex；
 *  2. 选音色用 reference_id（voiceProfile.fishReferenceId），不是 MiniMax 的 voice_id；
 *  3. 模型走 `model` 请求头（s2.1-pro / s2-pro / s1）；
 *  4. 没有 MiniMax 的 <#秒#> 停顿标记 —— 那套标记鱼声不认、会被原样念出来，
 *     所以这里绝不 insertSpeechBreaks，还要把混进来的 <#x#> 清掉做兜底。
 *  5. 情绪用方括号 cue（[happy] 等），这里把上层传来的 emotion 前置成一个方括号标签。
 *
 * 文本清洗 / <语音> 标签解析仍复用 minimaxTts 的那套（与服务商无关）。
 */
import { CharacterProfile, APIConfig } from '../types';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { hashTtsParams, getCachedTts, saveCachedTts } from './ttsCache';
import { normalizeApiKey } from './minimaxApiKey';
import type { TtsResult } from './minimaxTts';

const FISH_PROXY_PATH = '/api/fishaudio/tts';
const FISH_UPSTREAM = 'https://api.fish.audio/v1/tts';
const DEFAULT_FISH_MODEL = 's2.1-pro';

/**
 * 鱼声语音演出规范 —— 与 MiniMax 版同源（呼吸、句长、情绪节奏的原理一致），
 * 但删掉了 MiniMax 专属的 <#秒#> 停顿标记机制，换成鱼声能吃的方式：靠标点和
 * 省略号控制停顿，情绪统一走 <语音 emotion="…"> 属性。
 */
export const FISH_VOICE_ACTING_GUIDE = `### 让它听起来像活人在说话（重要）

你写的字会被鱼声原样念出来。目标不是"写一段通顺的话"，而是"写一段读出来有呼吸、有情绪起伏的对白"。读稿感、客服腔、新闻播报腔一旦出现就重写。

**1. 段与段之间要换气，别无缝冲。**
同一条语音里换行或停顿之后，如果还是你在继续说，第二段开头别一上来就冲进正题——加一个语气词或一次叹气当缓冲。
✅ 我知道你不是故意的……只是，我还是会有点难过。
❌ 我知道你不是故意的。只是我还是会有点难过。（两句贴死，像棒读）
这些地方下一句开头尤其要缓一下：解释原因、情绪转折（吐槽转温柔 / 强硬转示弱 / 玩笑转认真）、沉默后再开口、安抚对方、委屈撒娇别扭的时候。

**2. 句子长短交错。** 一连串等长的句子是棒读的头号来源。让短句砸下来，让长句铺开。想强调某个词就拆开念："我。没。拿。"

**3. 停顿靠标点和省略号，别写 MiniMax 的 <#秒#> 标记。**
鱼声不认 <#0.5#> 这类标记，写了会被原样念出来变成杂音。要停顿就用标点：逗号轻顿、句号收住、破折号拉长、省略号"……"表示欲言又止/犹豫沉默。需要明显停顿就多用一个省略号。

**4. 情绪不同，节奏不同：**
- 温柔安抚：慢、稳、短句多。"没事……先别急着吓自己。"
- 委屈撒娇：语气软、省略号多一点但别太戏剧。"嗯……你刚刚是不是又不理我。"
- 别扭傲娇：前半句嘴硬后半句放软，中间停一下。"哈，你还真会折腾我。算了，我帮你就是了。"
- 难过压抑：更慢、更多省略号、少用长句。"……我知道。只是有点难受。"
- 紧张犹豫：断裂感，短句多。"等等……我好像，有点不确定。"
- 吐槽轻松：别太慢，轻微停顿即可。"行吧。人类又发明了新的折磨方式。"

**5. 整条语音的情绪用 \`<语音 emotion="…">\` 属性标，别在正文里写方括号情绪标签。** 正文只写会被念出来的字。

（朗读语种不是中文时，上面示例里的中文语气词换成该语言里自然的叹词 / 填充词即可，呼吸和节奏的原理不变。）`;

/** 鱼声情绪 cue 取值（映射自上层的 MiniMax 情绪命名）。'fluent' 鱼声没有，丢弃。 */
const FISH_EMOTION_MAP: Record<string, string> = {
  happy: 'happy',
  sad: 'sad',
  angry: 'angry',
  fearful: 'scared',
  disgusted: 'disgusted',
  surprised: 'surprised',
  calm: 'calm',
};

/** 解析 apiConfig 里的鱼声 Key（独立 Key，不复用通用 apiKey —— 那是 LLM 的）。 */
export const resolveFishAudioApiKey = (apiConfig: APIConfig): string =>
  normalizeApiKey(apiConfig.fishAudioApiKey || '');

/** 该角色能否用鱼声合成（必须有 Key + reference_id）。 */
export const canSynthesizeFish = (char: CharacterProfile, apiConfig: APIConfig): boolean =>
  !!resolveFishAudioApiKey(apiConfig) && !!char.voiceProfile?.fishReferenceId;

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const shouldBypassWebProxy = (): boolean => {
  if (typeof window === 'undefined') return false;
  const protocol = String(window.location.protocol || '').toLowerCase();
  if (protocol === 'file:') return true;
  const host = String(window.location.hostname || '').toLowerCase();
  return host === 'github.io' || host.endsWith('.github.io');
};

/** base64 → Blob（CapacitorHttp 二进制响应是 base64 字符串）。 */
const base64ToBlob = (b64: string, mime = 'audio/mpeg'): Blob => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};

/**
 * 调鱼声 /v1/tts，拿回音频 Blob。
 * web：默认走 /api/fishaudio/tts 代理；静态预览（github.io / file:）直连上游兜底。
 * native：CapacitorHttp 直连上游，responseType='blob' 绕过浏览器 CORS。
 */
const fishFetchAudio = async (
  payload: any,
  apiKey: string,
  model: string,
): Promise<Blob> => {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    model,
  };

  if (isNative()) {
    const response = await CapacitorHttp.request({
      url: FISH_UPSTREAM,
      method: 'POST',
      headers: jsonHeaders,
      data: payload,
      responseType: 'blob',
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`鱼声 TTS 失败 (HTTP ${response.status})`);
    }
    // CapacitorHttp blob 响应：data 是 base64 字符串
    return base64ToBlob(String(response.data || ''));
  }

  const url = shouldBypassWebProxy() ? FISH_UPSTREAM : FISH_PROXY_PATH;
  const res = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(`鱼声 TTS 失败 (HTTP ${res.status})${detail ? `：${detail}` : ''}`);
  }
  const blob = await res.blob();
  if (!blob.size) throw new Error('鱼声 TTS 返回空音频');
  return blob;
};

/**
 * 调鱼声 TTS，返回可播放 URL + 原始 blob（可写 IndexedDB 持久化）。
 * 与 minimaxTts.synthesizeSpeechDetailed 同签名，方便 ttsRouter 透明切换。
 */
export async function synthesizeSpeechFishDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<TtsResult> {
  const apiKey = resolveFishAudioApiKey(apiConfig);
  if (!apiKey) throw new Error('缺少鱼声 Fish Audio API Key');
  const vp = char.voiceProfile;
  const referenceId = (vp?.fishReferenceId || '').trim();
  if (!referenceId) throw new Error('角色未配置鱼声音色（reference_id）');

  const model = (vp?.fishModel || apiConfig.fishAudioModel || DEFAULT_FISH_MODEL).trim() || DEFAULT_FISH_MODEL;

  // 兜底清掉混进来的 MiniMax 停顿标记，避免鱼声把 <#0.5#> 原样念出来。
  let spoken = (text || '').replace(/<#\s*[\d.]+\s*#>/g, '').replace(/\s+/g, ' ').trim();
  // 整条情绪：前置一个方括号 cue（鱼声会演绎、不会念出来）。
  const fishEmotion = options?.emotion ? FISH_EMOTION_MAP[options.emotion.toLowerCase()] : undefined;
  if (fishEmotion) spoken = `[${fishEmotion}] ${spoken}`;
  if (!spoken) throw new Error('鱼声 TTS 文本为空');

  const payload: any = {
    text: spoken,
    reference_id: referenceId,
    format: 'mp3',
    // 展开数字/日期为自然读法，长文本更稳。
    normalize: true,
  };
  if (vp?.speed && vp.speed !== 1) {
    payload.prosody = { speed: Math.max(0.5, Math.min(2, vp.speed)) };
  }

  const cacheKey = hashTtsParams({
    kind: 'fishaudio-tts',
    text: payload.text,
    model,
    reference_id: payload.reference_id,
    format: payload.format,
    prosody: payload.prosody,
  });
  const cached = await getCachedTts(cacheKey);
  if (cached) {
    return { url: URL.createObjectURL(cached), blob: cached };
  }

  const blob = await fishFetchAudio(payload, apiKey, model);
  saveCachedTts(cacheKey, blob).catch(() => { /* ignore */ });
  return { url: URL.createObjectURL(blob), blob };
}

/** 薄封装：只要可播放 URL 时用。 */
export async function synthesizeSpeechFish(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: { languageBoost?: string; groupId?: string; emotion?: string },
): Promise<string> {
  const { url } = await synthesizeSpeechFishDetailed(text, char, apiConfig, options);
  return url;
}
