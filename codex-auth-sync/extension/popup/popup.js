/**
 * Codex 登录态同步 Popup 逻辑
 * 只负责渲染与转发用户操作，所有业务都在 background.js。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('enabled'),
  statusPill: $('statusPill'),
  account: $('account'),
  plan: $('plan'),
  meterFill: $('meterFill'),
  days: $('days'),
  btnPing: $('btnPing'),
  lastCheck: $('lastCheck'),
  lastPush: $('lastPush'),
  btnCheck: $('btnCheck'),
  btnPush: $('btnPush'),
  checkPeriodMin: $('checkPeriodMin'),
  pushIntervalHours: $('pushIntervalHours'),
  toast: $('toast'),
};

let toastTimer = null;
function showToast(text) {
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3000);
}

function send(type, extra) {
  return chrome.runtime.sendMessage({ type, ...(extra || {}) });
}

function fmtTime(ts) {
  if (!ts) return '从未';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/******************** 渲染 ********************/
function render(snapshot) {
  if (!snapshot) return;
  const { config } = snapshot;
  const state = snapshot.state || {};

  if (config) {
    els.enabled.checked = Boolean(config.enabled);
    els.checkPeriodMin.value = config.checkPeriodMin;
    els.pushIntervalHours.value = config.pushIntervalHours;
  }

  // 登录状态徽标
  if (state.loggedIn) {
    els.statusPill.textContent = '已登录';
    els.statusPill.className = 'pill ok';
  } else if (state.lastCheckMsg) {
    els.statusPill.textContent = '异常';
    els.statusPill.className = 'pill err';
  } else {
    els.statusPill.textContent = '检测中…';
    els.statusPill.className = 'pill muted';
  }

  // 账号与套餐
  els.account.textContent = state.account || (state.lastCheckMsg || '—');
  if (state.plan) {
    els.plan.textContent = state.plan;
    els.plan.classList.remove('hidden');
  } else {
    els.plan.classList.add('hidden');
  }

  // Token 有效期进度条（满刻度 10 天）
  const days = typeof state.tokenExpDays === 'number' ? state.tokenExpDays : null;
  els.days.textContent = 'Token 剩余 ' + (days === null ? '—' : days + ' 天');
  const pct = days === null ? 0 : Math.min(100, (days / 10) * 100);
  els.meterFill.style.width = pct + '%';
  els.meterFill.classList.toggle('warn', days !== null && days <= 2);

  // 时间线
  els.lastCheck.textContent = fmtTime(state.lastCheckAt);
  els.lastPush.textContent = (state.lastPushMsg ? state.lastPushMsg.replace(/^(自动|手动)推送(成功|失败)：/, '') + ' · ' : '') + fmtTime(state.lastPushAt);
  els.lastPush.title = state.lastPushMsg || '';
}

async function refresh() {
  try {
    const r = await send('get_snapshot');
    if (r && r.ok) render(r);
  } catch (e) { /* background 未就绪 */ }
}

/******************** 事件 ********************/
// 总开关：保存即生效（后台会重排闹钟）
els.enabled.addEventListener('change', async () => {
  await saveConfig();
  showToast(els.enabled.checked ? '自动同步已开启' : '自动同步已关闭');
});

// 数字输入：变更后防抖保存
let saveTimer = null;
function onNumberInput() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveConfig();
    showToast('设置已保存');
  }, 600);
}
els.checkPeriodMin.addEventListener('change', onNumberInput);
els.pushIntervalHours.addEventListener('change', onNumberInput);

async function saveConfig() {
  const cfg = {
    enabled: els.enabled.checked,
    checkPeriodMin: Math.max(1, Number(els.checkPeriodMin.value) || 60),
    pushIntervalHours: Math.max(1, Number(els.pushIntervalHours.value) || 24),
  };
  await send('save_config', { config: cfg });
}

els.btnCheck.addEventListener('click', async () => {
  els.btnCheck.disabled = true;
  try {
    const r = await send('manual_check');
    if (r && r.ok) { showToast('检查完成'); render(r); }
    else { showToast('检查失败：' + ((r && r.error) || '未知错误')); render(r); }
  } finally {
    els.btnCheck.disabled = false;
  }
});

els.btnPush.addEventListener('click', async () => {
  els.btnPush.disabled = true;
  els.btnPush.textContent = '推送中…';
  try {
    const r = await send('manual_push');
    if (r && r.ok) { showToast(r.msg || '推送成功'); render(r); }
    else { showToast((r && r.error) || '推送失败'); render(r); }
  } finally {
    els.btnPush.disabled = false;
    els.btnPush.textContent = '立即推送';
  }
});

els.btnPing.addEventListener('click', async () => {
  els.btnPing.disabled = true;
  await pingNative();
  els.btnPing.disabled = false;
});

async function pingNative() {
  els.btnPing.textContent = '检测中…';
  els.btnPing.className = 'pill ghost as-btn';
  try {
    const r = await send('ping_native');
    if (r && r.ok) {
      els.btnPing.textContent = '助手 v' + (r.version || '?') + ' 已连接';
      els.btnPing.classList.add('ok');
    } else {
      els.btnPing.textContent = '助手未连接';
      els.btnPing.classList.add('err');
      els.btnPing.title = (r && r.error) || '';
    }
  } catch (e) {
    els.btnPing.textContent = '助手未连接';
    els.btnPing.classList.add('err');
    els.btnPing.title = e.message || '';
  }
}

/******************** 启动 ********************/
refresh();
pingNative();