# 注销 Codex 登录态同步的原生消息主机
$hostName = 'com.isquare.codex_auth_sync'
$dir = $PSScriptRoot

foreach ($base in @('HKCU\Software\Google\Chrome\NativeMessagingHosts', 'HKCU\Software\Microsoft\Edge\NativeMessagingHosts')) {
    & reg delete "$base\$hostName" /f 2>$null | Out-Null
    Write-Host "[OK] 已删除注册表项: $base\$hostName"
}
foreach ($f in @("$hostName.json", 'run-host.cmd')) {
    $p = Join-Path $dir $f
    if (Test-Path $p) { Remove-Item -LiteralPath $p -Force; Write-Host "[OK] 已删除: $p" }
}
Write-Host "[完成] 原生主机已注销（host.log 保留，可手动删除）" -ForegroundColor Green