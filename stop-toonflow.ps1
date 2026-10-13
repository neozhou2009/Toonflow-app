# Toonflow Windows 停止脚本
# 用法：在该文件所在目录（Toonflow-app\）打开 PowerShell，执行
#   .\stop-toonflow.ps1
# ---------------------------------------------------------------------------
$ErrorActionPreference = "SilentlyContinue"

# 1) 按端口找进程（最可靠：脚本记录的 PID 在后台启动时不一定拿得到）
$conns = Get-NetTCPConnection -LocalPort 3000 -State Listen
if (-not $conns) {
    Write-Host "[toonflow] 没有发现正在运行的 Toonflow" -ForegroundColor Gray
    exit 0
}

$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $pids) {
    $p = Get-Process -Id $procId
    Write-Host "[toonflow] 正在停止 PID $procId ($($p.ProcessName)) …" -ForegroundColor Cyan
    Stop-Process -Id $procId -Force
}

Start-Sleep -Seconds 2
$still = Get-NetTCPConnection -LocalPort 3000 -State Listen
if ($still) {
    Write-Host "[toonflow] 端口 3000 仍被占用，请检查是否有别的程序在用" -ForegroundColor Yellow
} else {
    Write-Host "[toonflow] Toonflow 已停止" -ForegroundColor Green
}
