/**
 * 知乎照妖镜 — Service Worker（MV3）
 * 职责：处理内容脚本的二审请求（缓存/限流/调用云端），安装时初始化默认设置。
 * 注意：SW 会被回收，所有状态存 chrome.storage，监听器必须同步注册在顶层。
 */
'use strict';

importScripts(
  '/src/shared/constants.js',
  '/src/shared/hash.js',
  '/src/shared/storage.js',
  '/src/cloud/second-opinion.js'
);

const ZD = globalThis.ZhihuDetector;

// 安装/更新时确保默认设置落盘（覆盖默认值在读取时兜底）
chrome.runtime.onInstalled.addListener(async () => {
  const raw = await chrome.storage.local.get(ZD.KEYS.SETTINGS);
  if (!raw[ZD.KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [ZD.KEYS.SETTINGS]: { ...ZD.DEFAULTS } });
  }
});

// 点击工具栏图标 → 打开完整 SPA 设置页（已去掉 default_popup）
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== ZD.MSG.SECOND_OPINION) return undefined;
  (async () => {
    try {
      const tabId = (sender.tab && sender.tab.id) || 0;
      const settings = await ZD.storage.getSettings();
      const ruleContext = {
        ruleScore: message.ruleScore,
        hits: message.hits || [],
      };
      const result = await ZD.cloud.secondOpinion(message.text, tabId, settings, ruleContext);
      if (!result) {
        sendResponse({ ok: false });
        return;
      }
      sendResponse({
        ok: true,
        score: result.score,
        aiSignals: result.aiSignals,
        humanSignals: result.humanSignals,
        cached: !!result.cached,
      });
    } catch (err) {
      console.error('[知乎照妖镜] 二审失败:', err);
      sendResponse({ ok: false });
    }
  })();
  return true; // 保持通道打开等待异步 sendResponse
});
