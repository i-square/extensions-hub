# Codex 登录态同步（浏览器扩展）

后台定时提取 ChatGPT 网页会话 Token，自动组装为 Codex `auth.json`，经**原生消息助手**安全写入 `~/.codex/auth.json`。

与油猴脚本方案（userscripts-hub/chatgpt/codex-auth-sync）的区别：**不需要打开 chatgpt.com 标签页**，也**不需要常驻 HTTP 服务**——浏览器按需拉起原生助手，写完即退，零开放端口。

---

## 组成

| 文件 | 作用 |
| ---- | ---- |
| `extension/manifest.json` | MV3 清单：权限 `alarms` / `nativeMessaging` / `storage` + `https://chatgpt.com/` |
| `extension/background.js` | Service Worker：定时唤醒 → 后台取会话 → 组装 → 调用原生助手 |
| `extension/popup/` | 弹窗界面（浅色/深色自适应）：状态卡、有效期进度条、手动检查/推送、设置 |
| `native/codex-auth-host.js` | 原生消息主机（Node 零依赖）：校验 + 备份 + 原子写入 auth.json |
| `native/install-host.ps1` | 注册原生主机（生成清单与启动器，写 HKCU 注册表，免管理员） |
| `native/uninstall-host.ps1` | 注销原生主机 |

## 工作原理

```
chrome.alarms（按「检查周期」定时唤醒，默认 60 分钟）
  → Service Worker 后台 fetch chatgpt.com/api/auth/session（自动带登录 Cookie）
  → 距上次成功推送超过「推送间隔」（默认 24 小时）时：
      组装 auth.json → sendNativeMessage → 浏览器拉起原生助手
      → 校验（密钥由 allowed_origins 锁定扩展 ID 天然鉴权）→ 备份旧文件 → 原子写入
  → 结果写入 chrome.storage，Popup 实时展示
```

每次推送都是全新的 10 天有效期 Token——只要浏览器按周期运行（不需要任何标签页），登录态就永续保鲜。

## 安装步骤

1. **加载扩展**：`chrome://extensions/` 开启开发者模式 →「加载已解压的扩展程序」→ 选择本目录下的 `extension/` 文件夹。
2. **复制扩展 ID**：加载后在扩展卡片上可见（32 位小写字母）。
3. **注册原生主机**（需要本机装有 Node.js）：
   ```powershell
   cd native
   .\install-host.ps1 -ExtensionId <粘贴扩展ID>
   ```
   脚本会同时注册 Chrome 与 Edge（HKCU，免管理员）。
4. **完全重启浏览器**，点击扩展图标 → 弹窗中「助手检测」应显示已连接。
5. 确认已在该浏览器登录 chatgpt.com，点「立即推送」完成首次写入。

> 注意：扩展 ID 由扩展目录路径决定。**移动文件夹后 ID 会变，需重新运行 `install-host.ps1`。**

## 设置说明（弹窗内）

| 设置项 | 默认值 | 说明 |
| ------ | ------ | ---- |
| 总开关 | 开启 | 关闭后停止一切自动检查与推送 |
| 检查周期（分钟） | 60 | 闹钟唤醒频率，每次唤醒都会刷新登录状态 |
| 推送间隔（小时） | 24 | 距上次成功推送超过该时长才再次推送 |

## 安全设计

- **零第三方**：Token 只经 `chatgpt.com → 浏览器扩展 → 本机原生助手`，不出本机；
- **零开放端口**：原生助手走 stdio 管道，`allowed_origins` 锁定扩展 ID，其他扩展/网页无法调用；
- **无常驻进程**：浏览器按需拉起助手，响应后即刻退出；
- **写入校验**：JWT 三段结构、`exp` 有效期（不足 1 小时拒绝）、`auth_mode` 逐一校验；
- **备份与原子写入**：旧文件备份为 `auth.json.bak_时间戳`（保留最近 10 份），临时文件 + 重命名替换；
- **不碰其他配置**：只写 `auth.json`，绝不修改 `config.toml`；日志不记录 Token 本体。

## 已知限制

- **浏览器需保持运行**（任意窗口即可，不需要 chatgpt.com 标签页）；浏览器关闭期间不刷新，下次启动按闹钟补跑；
- 该 auth.json 的 `refresh_token` 是占位符，Codex 无法自行刷新，这正是需要持续推送的原因；
- 本方案仅覆盖本机；**跨机器同步请使用 userscripts-hub 中的油猴脚本 + HTTP 微服务方案**。