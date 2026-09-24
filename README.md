# extensions-hub

自用浏览器扩展仓库（Chrome / Edge，Manifest V3），按功能分目录整理。

## 扩展列表

| 扩展名称 | 功能描述 | 链接 |
| -------- | -------- | ---- |
| Codex 登录态同步 | 后台定时提取 ChatGPT 网页会话，自动组装 auth.json 并经原生消息助手安全写入 ~/.codex；无需打开 chatgpt.com 标签页，无需常驻服务 | [目录](codex-auth-sync/) |

## 安装方式（通用）

1. 打开 `chrome://extensions/`（Edge 为 `edge://extensions/`），开启「开发者模式」
2. 点击「加载已解压的扩展程序」，选择对应扩展的 `extension/` 目录
3. 各扩展的额外安装步骤见各自目录下的 README