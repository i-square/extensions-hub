# 注册 Codex 登录态同步的"原生消息主机"（Chrome + Edge，写 HKCU 免管理员）
# 用法：install-host.ps1 -ExtensionId <32位扩展ID>
# 扩展 ID 获取：chrome://extensions 打开开发者模式，加载扩展后可见（形如 mfifd.... 的 32 位小写字母）
param(
    [string]$ExtensionId = ""
)
$ErrorActionPreference = 'Stop'

$hostName = 'com.isquare.codex_auth_sync'
$dir = $PSScriptRoot
$hostJs = Join-Path $dir 'codex-auth-host.js'
if (-not (Test-Path $hostJs)) { Write-Host "[错误] 未找到 $hostJs" -ForegroundColor Red; exit 1 }

# 解析 node 路径
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "[错误] 未检测到 Node.js，请先安装: https://nodejs.org/" -ForegroundColor Red; exit 1 }

# 扩展 ID（allowed_origins 锁定调用方，相当于鉴权）
if (-not $ExtensionId) {
    $ExtensionId = (Read-Host "请输入扩展 ID（chrome://extensions 开发者模式下加载扩展后可见）").Trim()
}
if ($ExtensionId -notmatch '^[a-p]{32}$') {
    Write-Host "[错误] 扩展 ID 格式不正确（应为 32 位 a-p 小写字母）" -ForegroundColor Red
    exit 1
}

# 1. 生成启动器（Windows 上 path 指向 .cmd 启动器比直接指 node 更稳）
$launcher = Join-Path $dir 'run-host.cmd'
$launcherContent = "@echo off`r`n`"$node`" `"$hostJs`" %*`r`n"
[System.IO.File]::WriteAllText($launcher, $launcherContent, [System.Text.Encoding]::ASCII)
Write-Host "[OK] 启动器已生成: $launcher"

# 2. 生成主机清单
$manifestPath = Join-Path $dir "$hostName.json"
$manifest = [ordered]@{
    name            = $hostName
    description     = 'Codex Auth Sync Native Host'
    path            = $launcher
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding $false))
Write-Host "[OK] 主机清单已生成: $manifestPath"

# 3. 写注册表（Chrome + Edge，当前用户，免管理员）
$escaped = $manifestPath -replace '\\', '\\'
foreach ($base in @('HKCU\Software\Google\Chrome\NativeMessagingHosts', 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts')) {
    $key = "$base\$hostName"
    & reg add "$key" /ve /t REG_SZ /d "$manifestPath" /f | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "[OK] 已注册: $key" }
    else { Write-Host "[警告] 注册失败: $key" -ForegroundColor Yellow }
}

Write-Host ""
Write-Host "[完成] 原生主机注册成功。请完全重启浏览器后，点击扩展弹窗中的「助手检测」验证连接。" -ForegroundColor Green
Write-Host "注意：若之后移动了本扩展文件夹，扩展 ID 会变，需重新运行本脚本。" -ForegroundColor Yellow