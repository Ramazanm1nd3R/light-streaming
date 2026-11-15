# Light Streaming как постоянный хост на Windows-ноутбуке, подключённом по кабелю: сервер комнаты,
# чат, сигнализация голоса и туннель запускаются вместе с ноутбуком — даже до входа в систему —
# и перезапускаются, если упали. Видео по-прежнему идёт зрителям прямо из облака Hyperbeam.
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows-host.ps1           установить
#   powershell -ExecutionPolicy Bypass -File scripts\windows-host.ps1 -Update   обновить до свежего main
#
# Нужны права администратора, Node.js, Git и файл .env в корне проекта (ключ Hyperbeam туда кладут
# вручную — в репозитории его нет). Для постоянной ссылки — Tailscale: tailscale up --unattended.
param([switch]$Update)
$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$hostDir = "$repo-host"
$task = "LightStreaming"
$node = (Get-Command node).Source

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrators")
if (-not $admin) { throw "Нужны права администратора: Win+X -> Терминал (администратор)" }
if (-not (Test-Path "$repo\.env")) { Write-Warning "Нет $repo\.env — без ключа Hyperbeam сервис запустится в демо-режиме" }

function Stop-Host {
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  # задача гасит только cmd.exe — сам сервер и туннель завершаем отдельно
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like "*server\index.ts*" -or $_.CommandLine -like "*tailscale*funnel*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Build-Host {
  Push-Location $repo
  try {
    npm ci --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE) { throw "npm ci завершился с ошибкой" }
    npm run build
    if ($LASTEXITCODE) { throw "сборка завершилась с ошибкой" }
  } finally { Pop-Location }
}

if ($Update) {
  Stop-Host
  git -C $repo pull --ff-only
  if ($LASTEXITCODE) { throw "git pull не прошёл — есть локальные изменения?" }
  Build-Host
  Start-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 8
  "Обновлено до $(git -C $repo log --oneline -1)"
  "Сервис: $((Get-ScheduledTask -TaskName $task).State)"
  return
}

Build-Host
New-Item -ItemType Directory -Force -Path $hostDir | Out-Null
@"
@echo off
rem Light Streaming: сервер комнаты и туннель. Лог — server.log рядом.
cd /d "$repo"
set NODE_ENV=production
"$node" node_modules\tsx\dist\cli.mjs server\index.ts >> "$hostDir\server.log" 2>&1
"@ | Set-Content -Path "$hostDir\start.cmd" -Encoding ascii

# Гости из той же Wi-Fi сети заходят напрямую по адресу ноутбука — открываем порт только для домашней сети.
$port = (Select-String -Path "$repo\.env" -Pattern '^PORT=(\d+)' -ErrorAction SilentlyContinue).Matches.Groups[1].Value
if (-not $port) { $port = "8787" }
if (-not (Get-NetFirewallRule -Name "light-streaming-$port" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name "light-streaming-$port" -DisplayName "Light Streaming (LAN)" -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private | Out-Null
}

# Запуск вместе с ноутбуком, без входа в систему (S4U), с перезапуском после падения.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$hostDir\start.cmd`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

# От сети ноутбук не засыпает и продолжает работать с закрытой крышкой.
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

Stop-Host
Start-ScheduledTask -TaskName $task
Start-Sleep -Seconds 8
# адрес того адаптера, через который идёт интернет: не VPN и не виртуальные адаптеры с похожими именами
$route = Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
$lan = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex | Where-Object IPAddress -notlike "169.254.*").IPAddress | Select-Object -First 1
"Сервис: $((Get-ScheduledTask -TaskName $task).State)"
"В домашней сети: http://${lan}:$port"
"Публичная ссылка и статус туннеля: http://${lan}:$port/api/status (поле publicUrl), лог: $hostDir\server.log"
