# Installs tether-node on Windows as a per-user background task. No admin rights needed.
#
# The hub's "Add machine" sheet generates a one-liner that works from both PowerShell and cmd.exe:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=3072; & ([scriptblock]::Create((irm '<hub>/node/install.ps1'))) -Hub '<hub>' -Token '<token>'"
#
# The token is base64url ([A-Za-z0-9_-]), so single quotes are always safe around it. It is written
# to %USERPROFILE%\.tether-node\.env (readable only by you) and never put on a command line that
# Task Scheduler or the process list would show.
param(
  [Parameter(Mandatory = $true)][string]$Hub,
  [Parameter(Mandatory = $true)][string]$Token,
  [switch]$NoPsmux
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$Hub = $Hub.TrimEnd('/')
if ($Token -notmatch '^[A-Za-z0-9_-]{20,}$') { throw 'That token does not look right. Copy the command again from the hub.' }

$Dir = Join-Path $env:USERPROFILE '.tether-node'
$Bin = Join-Path $Dir 'bin'
New-Item -ItemType Directory -Force -Path $Dir, $Bin | Out-Null

$arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'ARM64' { 'arm64' } default { 'x64' } }

function Get-File([string]$Url, [string]$Out) {
  $tmp = "$Out.download"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $tmp
  Move-Item -Force $tmp $Out
}

# Stop a running copy first, or Windows keeps the .exe locked.
$TaskName = 'Tether node'
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
Get-Process -Name 'tether-node' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# 1. tether-node itself: the hub compiles tether-node.ts into a single .exe (Bun runtime included,
#    console window hidden), so Bun does not have to be installed here.
Write-Host 'Downloading tether-node...'
Get-File "$Hub/node/tether-node.exe?arch=$arch" (Join-Path $Dir 'tether-node.exe')

# 2. A small POSIX shell (busybox-w32). The hub drives every machine with short sh scripts, and this
#    keeps them working on Windows without Git Bash or WSL. Served (and pinned) by the hub.
Write-Host 'Downloading the shell helper (busybox-w32)...'
Get-File "$Hub/node/busybox.exe?arch=$arch" (Join-Path $Bin 'busybox.exe')

# 3. The secrets file. A compiled Bun app loads .env from its working directory.
$envFile = Join-Path $Dir '.env'
Set-Content -Path $envFile -Encoding ASCII -Value @(
  "TETHER_HUB=$Hub",
  "TETHER_TOKEN=$Token",
  "TETHER_SH=$(Join-Path $Bin 'busybox.exe')"
)
# only this user (and SYSTEM) may read it
icacls $envFile /inheritance:r /grant:r "${env:USERNAME}:(R,W)" "SYSTEM:(F)" | Out-Null

# 4. psmux, the Windows tmux. Tether lists and drives its sessions.
$mux = Get-Command psmux, tmux -ErrorAction SilentlyContinue | Select-Object -First 1
if ($mux -and $mux.Name -eq 'tmux.exe' -and -not (Get-Command psmux -ErrorAction SilentlyContinue)) {
  Write-Host "Found $($mux.Source); Tether expects psmux's tmux.exe here."
}
if (-not $mux -and -not $NoPsmux) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Installing psmux with winget...'
    # psmux ships psmux.exe, pmux.exe and tmux.exe (same program), so the hub's `tmux ...` calls work
    winget install psmux --silent --accept-source-agreements --accept-package-agreements | Out-Host
  } else {
    Write-Host 'Note: psmux is not installed. Install it (winget install psmux, or scoop install psmux) so Tether can see your sessions.'
  }
}

# 5. Start at sign-in and keep running. A scheduled task can restart it if it ever crashes;
#    if task creation is blocked by policy, fall back to the Startup folder.
$exe = Join-Path $Dir 'tether-node.exe'
$started = $false
try {
  $action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'Outbound connection to your Tether hub' -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  $started = $true
  Write-Host "tether-node is running (Task Scheduler: '$TaskName'; log: $Dir\node.log)."
} catch {
  Write-Host "Could not create a scheduled task ($($_.Exception.Message)); using the Startup folder instead."
}

if (-not $started) {
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Tether node.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.WorkingDirectory = $Dir
  $s.WindowStyle = 7
  $s.Save()
  Start-Process -FilePath $exe -WorkingDirectory $Dir -WindowStyle Hidden
  Write-Host "tether-node is running and starts when you sign in (log: $Dir\node.log)."
}
