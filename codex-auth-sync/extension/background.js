/**
 * Codex 登录态同步 —— 后台 Service Worker
 *
 * 职责：chrome.alarms 定时唤醒（无需任何 chatgpt.com 标签页）
 *   → fetch /api/auth/session（host_permissions 免 CORS，自动带登录 Cookie）
 *   → 距上次推送超过「推送间隔」则组装 auth.json
 *   → 经 Native Messaging 发送给原生助手写入 ~/.codex/auth.json
 * 所有状态存 chrome.storage.local，service worker 被杀后状态不丢。
 */
'use strict';

const ALARM_NAME = 'codex-auth-sync.tick';
const HOST_NAME = 'com.isquare.codex_auth_sync';
const SESSION_URL = 'https://chatgpt.com/api/auth/session';

const DEFAULTS = {
  enabled: true,          // 总开关：自动检查 + 自动推送
  checkPeriodMin: 60,     // 闹钟检查周期（分钟，最小 1）
  pushIntervalHours: 24,  // 推送间隔（小时）：距上次成功推送超过该时长才再次推送
};

const LIMITS = {
  checkPeriodMin: { min: 1, max: 720 },
  pushIntervalHours: { min: 1, max: 240 },
};

function normalizeConfig(input) {
  const raw = input || {};
  const clampNumber = (name, fallback) => {
    const value = Number(raw[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(LIMITS[name].max, Math.max(LIMITS[name].min, Math.round(value)));
  };
  return {
    enabled: raw.enabled === undefined ? DEFAULTS.enabled : Boolean(raw.enabled),
    checkPeriodMin: clampNumber('checkPeriodMin', DEFAULTS.checkPeriodMin),
    pushIntervalHours: clampNumber('pushIntervalHours', DEFAULTS.pushIntervalHours),
  };
}

/******************** 配置与状态存取 ********************/
async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return normalizeConfig(config);
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state || {};
}

async function patchState(patch) {
  const state = await getState();
  await chrome.storage.local.set({ state: { ...state, ...patch } });
}

/******************** 闹钟调度 ********************/
async function ensureAlarm() {
  const cfg = await getConfig();
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!cfg.enabled) {
    if (existing) await chrome.alarms.clear(ALARM_NAME);
    return;
  }
  const period = cfg.checkPeriodMin;
  if (!existing || existing.periodInMinutes !== period) {
    // Chrome 的最小闹钟延迟为 30 秒；重复周期仍按用户配置执行。
    await chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 0.5,
      periodInMinutes: period,
      persistAcrossSessions: true,
    });
  }
}

// 监听器必须顶层同步注册，否则 service worker 冷启动后收不到唤醒事件
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) enqueue(tick);
});
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); });
ensureAlarm(); // 每次冷启动兜底，防止闹钟在浏览器重启后丢失

// 串行化检查、推送和状态写入，避免定时任务与手动操作互相覆盖。
let operationChain = Promise.resolve();
function enqueue(operation) {
  const result = operationChain.then(operation, operation);
  operationChain = result.catch(() => {});
  return result;
}

/******************** 会话提取与组装 ********************/
async function fetchSession() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(SESSION_URL, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) throw new Error('未登录或会话已失效');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || typeof data.accessToken !== 'string' || !data.accessToken) {
      throw new Error('未登录或会话已失效');
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(b64).split('').map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
    );
    return JSON.parse(json);
  } catch (e) {
    try { return JSON.parse(atob(String(token).split('.')[1])); } catch (e2) { return null; }
  }
}

function tokenRemainDays(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return null;
  return Math.max(0, Math.round(((payload.exp * 1000 - Date.now()) / 86400000) * 10) / 10);
}

function buildAuthJson(session) {
  const token = session.accessToken;
  const payload = decodeJwtPayload(token) || {};
  const authClaim = payload['https://api.openai.com/auth'] || {};
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: token,
      access_token: token,
      refresh_token: 'rt_mock_token',
      account_id: authClaim.chatgpt_account_id || '',
    },
    last_refresh: new Date().toISOString(),
  };
}

function sessionInfo(session) {
  const payload = decodeJwtPayload(session.accessToken) || {};
  const authClaim = payload['https://api.openai.com/auth'] || {};
  return {
    account: (session.user && (session.user.email || session.user.name)) || '',
    plan: authClaim.chatgpt_plan_type || '',
    remainDays: tokenRemainDays(session.accessToken),
  };
}

/******************** 原生消息 ********************/
function sendNative(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, payload, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message || '原生助手调用失败'));
      if (!resp) return reject(new Error('原生助手无响应'));
      if (resp.success === false) return reject(new Error(resp.error || '原生助手处理失败'));
      resolve(resp);
    });
  });
}

/******************** 徽标提示 ********************/
function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (text) chrome.action.setBadgeBackgroundColor({ color: color || '#ef4444' });
}

/******************** 核心流程 ********************/
// 仅检查：取会话并刷新状态，不推送
async function checkOnly() {
  const session = await fetchSession();
  const info = sessionInfo(session);
  await patchState({
    loggedIn: true,
    account: info.account,
    plan: info.plan,
    tokenExpDays: info.remainDays,
    lastCheckAt: Date.now(),
    lastCheckMsg: '已登录，Token 剩余 ' + (info.remainDays === null ? '未知' : info.remainDays + ' 天'),
  });
  return info;
}

// 推送：取会话 → 组装 → 原生助手写入
async function pushNow(source) {
  const label = source === 'auto' ? '自动' : '手动';
  try {
    const session = await fetchSession();
    const auth = buildAuthJson(session);
    const resp = await sendNative({ type: 'write_auth', auth });
    const msg = label + '推送成功：' + (resp.message || '已写入');
    await patchState({ lastPushAt: Date.now(), lastPushMsg: msg, nativeOk: true });
    setBadge('');
    return msg;
  } catch (e) {
    const msg = label + '推送失败：' + (e.message || e);
    await patchState({ lastPushMsg: msg, nativeOk: false });
    setBadge('!');
    throw new Error(msg);
  }
}

// 定时入口：检查 + 按间隔决定是否推送
async function tick() {
  let pushFailed = false;
  try {
    await checkOnly();
    const cfg = await getConfig();
    const { lastPushAt = 0 } = await getState();
    if (Date.now() - lastPushAt >= cfg.pushIntervalHours * 3600 * 1000) {
      await pushNow('auto').catch(() => { pushFailed = true; });
    }
    if (!pushFailed) setBadge('');
  } catch (e) {
    await patchState({
      loggedIn: false,
      lastCheckAt: Date.now(),
      lastCheckMsg: '检查失败：' + (e.message || e),
    });
    setBadge('!');
  }
}

/******************** Popup 消息路由 ********************/
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'get_snapshot':
        sendResponse({ ok: true, config: await getConfig(), state: await getState() });
        break;
      case 'save_config':
        await chrome.storage.local.set({ config: normalizeConfig(msg.config) });
        await ensureAlarm(); // 按新配置重排闹钟
        sendResponse({ ok: true });
        break;
      case 'manual_check':
        try {
          await enqueue(() => checkOnly());
          sendResponse({ ok: true, state: await getState() });
        } catch (e) {
          await patchState({ loggedIn: false, lastCheckAt: Date.now(), lastCheckMsg: '检查失败：' + (e.message || e) });
          sendResponse({ ok: false, error: e.message, state: await getState() });
        }
        break;
      case 'manual_push':
        try {
          const text = await enqueue(() => pushNow('manual'));
          sendResponse({ ok: true, msg: text, state: await getState() });
        } catch (e) {
          sendResponse({ ok: false, error: e.message, state: await getState() });
        }
        break;
      case 'ping_native':
        try {
          const r = await sendNative({ type: 'ping' });
          sendResponse({ ok: true, version: r.version });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      default:
        sendResponse({ ok: false, error: '未知消息类型' });
    }
  })().catch((e) => sendResponse({ ok: false, error: e.message }));
  return true; // 保持异步通道
});
