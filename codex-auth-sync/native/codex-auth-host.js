/**
 * Codex 登录态同步 —— 原生消息主机（Native Messaging Host）
 *
 * 由浏览器按需拉起（无需常驻、无开放端口）：
 *   stdin  接收 4 字节小端长度 + UTF-8 JSON 消息
 *   stdout 回同格式响应后退出
 *
 * 消息类型：
 *   { "type": "ping" }                        → { success:true, version }
 *   { "type": "write_auth", "auth": {...} }   → 校验+备份+原子写入 ~/.codex/auth.json
 *
 * 写入目标：环境变量 CODEX_HOME 或 用户目录/.codex（与 Codex 官方约定一致）
 * 日志：同目录 host.log（只记账号与有效期，不记 token 本体）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '1.0.0';
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_BACKUPS = 10;
const LOG_PATH = path.join(__dirname, 'host.log');

function log(msg) {
  try { fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`); } catch { }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/******************** JWT 与内容校验 ********************/
function decodeJwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function validateAuth(auth) {
  const errors = [];
  let accountId = '';
  let expDays = null;

  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return { errors: ['auth 不是有效的 JSON 对象'], accountId, expDays };
  }
  if (auth.auth_mode !== 'chatgpt') errors.push('auth_mode 必须是 "chatgpt"');

  const tokens = auth.tokens || {};
  if (typeof tokens.id_token !== 'string' || !tokens.id_token) errors.push('缺少 tokens.id_token');
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) errors.push('缺少 tokens.access_token');

  if (typeof tokens.access_token === 'string' && tokens.access_token) {
    const payload = decodeJwtPayload(tokens.access_token);
    if (!payload) {
      errors.push('access_token 不是有效的 JWT');
    } else {
      if (typeof payload.exp !== 'number') {
        errors.push('access_token 缺少 exp 字段');
      } else {
        const msLeft = payload.exp * 1000 - Date.now();
        if (msLeft <= 3600 * 1000) errors.push('access_token 已过期或 1 小时内即将过期');
        expDays = Math.round((msLeft / 86400000) * 10) / 10;
      }
      const claim = payload['https://api.openai.com/auth'];
      accountId = (claim && claim.chatgpt_account_id) || tokens.account_id || '';
    }
  }
  return { errors, accountId, expDays };
}

/******************** 备份与原子写入 ********************/
function localTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function pruneBackups(home) {
  try {
    const backups = fs.readdirSync(home)
      .filter((f) => /^auth\.json\.bak_\d{8}_\d{6}$/.test(f))
      .sort();
    const excess = backups.length - MAX_BACKUPS;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(path.join(home, backups[i])); } catch { }
    }
  } catch { }
}

function writeAuthSafely(content) {
  const home = codexHome();
  fs.mkdirSync(home, { recursive: true });
  const target = path.join(home, 'auth.json');
  let backup = '';
  if (fs.existsSync(target)) {
    backup = path.join(home, `auth.json.bak_${localTimestamp()}`);
    fs.copyFileSync(target, backup);
    pruneBackups(home);
  }
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target); // 同目录重命名 = 原子替换
  return backup;
}

/******************** 原生消息协议 ********************/
function sendMessage(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(data.length, 0);
  process.stdout.write(Buffer.concat([head, data]));
}

function respondAndExit(obj) {
  sendMessage(obj);
  setTimeout(() => process.exit(0), 50); // 给 stdout flush 的机会再退出
}

function handleMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return respondAndExit({ success: false, error: '消息不是有效 JSON' });
  }

  if (msg.type === 'ping') {
    return respondAndExit({ success: true, version: VERSION });
  }

  if (msg.type === 'write_auth') {
    const { errors, accountId, expDays } = validateAuth(msg.auth);
    if (errors.length > 0) {
      log(`[拒绝] 内容校验失败: ${errors.join('; ')}`);
      return respondAndExit({ success: false, error: errors.join('; ') });
    }
    try {
      const backup = writeAuthSafely(JSON.stringify(msg.auth, null, 2) + '\n');
      log(`[成功] 已写入 ${path.join(codexHome(), 'auth.json')}（账号 ${accountId || '未知'}，Token 剩余 ${expDays} 天${backup ? '，旧文件已备份' : ''}）`);
      return respondAndExit({ success: true, message: `已写入，Token 剩余 ${expDays} 天`, accountId, expDays });
    } catch (e) {
      log(`[失败] 写入异常: ${e.message}`);
      return respondAndExit({ success: false, error: '写入失败: ' + e.message });
    }
  }

  respondAndExit({ success: false, error: '未知消息类型: ' + String(msg.type) });
}

// 攒够一条长度前缀消息后处理（sendNativeMessage 一次只发一条）
let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length < 4) return;
  const len = buffer.readUInt32LE(0);
  if (len > MAX_MESSAGE_BYTES) {
    log(`[拒绝] 消息过大: ${len} 字节`);
    respondAndExit({ success: false, error: '消息过大' });
    return;
  }
  if (buffer.length >= 4 + len) {
    handleMessage(buffer.slice(4, 4 + len).toString('utf8'));
  }
});
process.stdin.on('end', () => {
  if (buffer.length === 0) log('[提示] stdin 在无消息情况下关闭');
});