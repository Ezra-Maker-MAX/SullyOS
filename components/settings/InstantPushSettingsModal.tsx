import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import { useOS } from '../../context/OSContext';
import { generateVapidKeyPair, generateClientToken } from '../../utils/vapidGen';
import {
  loadInstantConfig,
  saveInstantConfig,
  getOrCreateInstantSubscription,
  sendTestInstantPush,
} from '../../utils/instantPushClient';
import { InstantPushConfig } from '../../types';

interface InstantPushSettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export const InstantPushSettingsModal: React.FC<InstantPushSettingsModalProps> = ({ open, onClose }) => {
  const { apiConfig, addToast } = useOS();

  const [workerUrl, setWorkerUrl] = useState('');
  const [vapidPublicKey, setVapidPublicKey] = useState('');
  const [clientToken, setClientToken] = useState('');
  const [enabled, setEnabled] = useState(false);

  // One-time private key display — never stored
  const [privateKeyPreview, setPrivateKeyPreview] = useState('');
  const [generating, setGenerating] = useState(false);

  const [testStatus, setTestStatus] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    const cfg = loadInstantConfig();
    setWorkerUrl(cfg.workerUrl);
    setVapidPublicKey(cfg.vapidPublicKey);
    setClientToken(cfg.clientToken ?? '');
    setEnabled(cfg.enabled);
    setPrivateKeyPreview('');
    setTestStatus('');
    setCopyStatus('');
  }, [open]);

  const currentCfg = (): InstantPushConfig => ({
    enabled,
    workerUrl: workerUrl.trim().replace(/\/+$/, ''),
    vapidPublicKey: vapidPublicKey.trim(),
    clientToken: clientToken.trim() || undefined,
  });

  const handleGenerateKeys = async () => {
    setGenerating(true);
    try {
      const kp = await generateVapidKeyPair();
      setVapidPublicKey(kp.publicKey);
      setPrivateKeyPreview(kp.privateKey);
    } catch (e) {
      const err = e as { message?: string } | null;
      addToast(err?.message ?? '生成密钥对失败', 'error');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyPrivateKey = async () => {
    if (!privateKeyPreview) return;
    await navigator.clipboard.writeText(privateKeyPreview);
    addToast('私钥已复制', 'success');
  };

  const handleGenerateToken = () => {
    setClientToken(generateClientToken());
  };

  const handleCopyWorkerCode = async () => {
    setCopyStatus('加载中…');
    try {
      const res = await fetch('/instant-worker.bundle.js');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setCopyStatus('已复制');
      setTimeout(() => setCopyStatus(''), 2000);
    } catch (e) {
      const err = e as { message?: string } | null;
      setCopyStatus('');
      addToast(`复制失败：${err?.message ?? '未知错误'}`, 'error');
    }
  };

  const handleCopyEnv = async () => {
    const pub = vapidPublicKey.trim();
    const token = clientToken.trim();
    const lines = [
      `VAPID_PUBLIC_KEY=${pub || '<填入生成的公钥>'}`,
      `VAPID_PRIVATE_KEY=<去刚生成的弹窗复制>`,
      `# 可选：`,
      `# VAPID_EMAIL=mailto:you@example.com`,
      token ? `# AMSG_CLIENT_TOKEN=${token}` : `# AMSG_CLIENT_TOKEN=<你填的 Client Token>`,
    ];
    await navigator.clipboard.writeText(lines.join('\n'));
    addToast('env 清单已复制', 'success');
  };

  const handleOpenCF = () => {
    window.open('https://dash.cloudflare.com/?to=/:account/workers-and-pages/create', '_blank');
  };

  const handleTest = async () => {
    if (testBusy) return;
    const cfg = currentCfg();
    saveInstantConfig(cfg);
    setTestBusy(true);
    setTestStatus('正在获取订阅…');
    try {
      const { sub, reason } = await getOrCreateInstantSubscription(cfg.vapidPublicKey);
      if (!sub) {
        setTestStatus(`订阅失败：${reason ?? '未知'}`);
        return;
      }
      setTestStatus('调用 LLM 并推送中…');
      const result = await sendTestInstantPush(apiConfig);
      if (result.ok) {
        setTestStatus('推送已发出，请查看系统通知');
      } else {
        setTestStatus(`失败：${result.error ?? '未知错误'}`);
      }
    } catch (e) {
      const err = e as { message?: string } | null;
      setTestStatus(`错误：${err?.message ?? String(e)}`);
    } finally {
      setTestBusy(false);
    }
  };

  const handleSave = () => {
    saveInstantConfig(currentCfg());
    addToast('Instant Push 配置已保存', 'success');
    onClose();
  };

  const testStatusColor = testStatus.includes('推送已发出')
    ? 'text-emerald-600'
    : testStatus.includes('失败') || testStatus.includes('错误')
    ? 'text-rose-500'
    : 'text-slate-500';

  return (
    <Modal
      isOpen={open}
      title="Instant Push 配置"
      onClose={onClose}
      footer={
        <div className="flex gap-2 w-full">
          <button
            onClick={onClose}
            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl text-sm"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 text-sm"
          >
            保存
          </button>
        </div>
      }
    >
      <div className="space-y-5 text-sm">

        {/* ① VAPID 密钥对 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">① 生成 VAPID 密钥对</p>

          <button
            onClick={() => void handleGenerateKeys()}
            disabled={generating}
            className={`w-full py-2.5 rounded-xl text-sm font-bold ${generating ? 'bg-slate-200 text-slate-400' : 'bg-indigo-500 text-white hover:bg-indigo-600'}`}
          >
            {generating ? '生成中…' : '生成新密钥对'}
          </button>

          {privateKeyPreview && (
            <div className="space-y-2">
              <p className="text-[11px] text-slate-500">私钥（一次性显示，关闭弹窗即消失）</p>
              <div className="flex gap-2 items-start">
                <textarea
                  readOnly
                  value={privateKeyPreview}
                  rows={3}
                  className="flex-1 font-mono text-[11px] bg-white border border-slate-200 rounded-xl p-2 resize-none leading-relaxed"
                />
                <button
                  onClick={() => void handleCopyPrivateKey()}
                  className="shrink-0 px-3 py-2 text-[11px] bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 font-medium"
                >
                  复制
                </button>
              </div>
              <p className="text-[11px] text-amber-600 font-medium">⚠ 关闭弹窗即丢失，请立即复制</p>
            </div>
          )}
        </div>

        {/* ② Worker 配置 */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-3">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">② Worker 配置</p>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 font-medium">Worker URL</label>
            <input
              type="url"
              value={workerUrl}
              onChange={(e) => setWorkerUrl(e.target.value)}
              placeholder="https://instant-push.xxx.workers.dev"
              className="w-full text-xs bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 font-medium">VAPID 公钥（生成后自动填入）</label>
            <input
              type="text"
              value={vapidPublicKey}
              onChange={(e) => setVapidPublicKey(e.target.value)}
              placeholder="BA…（生成密钥对后自动填入）"
              className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 font-medium">Client Token（可选，防止他人滥用 Worker）</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={clientToken}
                onChange={(e) => setClientToken(e.target.value)}
                placeholder="留空则裸跑"
                className="flex-1 text-[11px] font-mono bg-white border border-slate-200 rounded-xl px-3 py-2 focus:outline-none focus:border-indigo-400"
              />
              <button
                onClick={handleGenerateToken}
                className="shrink-0 px-3 py-2 text-[11px] bg-white border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50 font-medium"
              >
                随机
              </button>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-indigo-500"
            />
            <span className="text-[12px] text-slate-600 font-medium">启用 Instant Push</span>
          </label>
        </div>

        {/* ③ 部署 Worker */}
        <div className="bg-slate-50 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">③ 部署 Worker</p>
          <p className="text-[11px] text-slate-500 leading-relaxed">部署前先完成①，然后把 Worker 代码贴进 CF 后台。</p>

          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => void handleCopyWorkerCode()}
              className="py-2 rounded-xl text-[11px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              {copyStatus || '复制 Worker 代码'}
            </button>
            <button
              onClick={() => void handleCopyEnv()}
              className="py-2 rounded-xl text-[11px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              复制 env 清单
            </button>
            <button
              onClick={handleOpenCF}
              className="py-2 rounded-xl text-[11px] font-bold bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              ↗ CF Dashboard
            </button>
          </div>
        </div>

        {/* ④ 测试推送 */}
        <div className="space-y-2">
          <button
            onClick={() => void handleTest()}
            disabled={testBusy}
            className={`w-full py-3 rounded-xl text-sm font-bold ${testBusy ? 'bg-slate-200 text-slate-400' : 'bg-emerald-500 text-white hover:bg-emerald-600'}`}
          >
            {testBusy ? '测试中…' : '🔔 发送测试推送'}
          </button>
          {testStatus && (
            <p className={`text-[11px] text-center ${testStatusColor}`}>{testStatus}</p>
          )}
          {!apiConfig.baseUrl && (
            <p className="text-[11px] text-amber-600 text-center">请先在 Settings → API 配置 Chat API，测试推送会复用它</p>
          )}
        </div>

      </div>
    </Modal>
  );
};
