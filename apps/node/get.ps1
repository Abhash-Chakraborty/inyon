# Gets tether-node for this PC and sets it up for the Tether phone app. In PowerShell:
#   irm https://github.com/Abhash-Chakraborty/tether/releases/latest/download/get.ps1 | iex
# It downloads tether-node into %USERPROFILE%\.tether-node\bin, checks it against the release's
# checksums, starts it in the background when you sign in, and shows a code to scan with the app.
# No admin rights needed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$base = if ($env:TETHER_DOWNLOAD) { $env:TETHER_DOWNLOAD } else { 'https://github.com/Abhash-Chakraborty/tether/releases/latest/download' }
# Windows on ARM runs the x64 build
$name = 'tether-node-windows-x64.exe'
$dir = Join-Path $env:USERPROFILE '.tether-node\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'tether-node.exe'
$tmp = "$exe.download"
$sums = "$exe.sums"

Write-Host "Downloading $name..."
Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $tmp
Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
$want = (Get-Content $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($name))$" } | ForEach-Object { $Matches[1] }) | Select-Object -First 1
Remove-Item -Force $sums
if (-not $want -or (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower() -ne $want) {
  Remove-Item -Force $tmp
  throw "The download didn't match the release's checksum. Run the command again."
}

# a running copy can't be replaced: stop the background one first
Stop-ScheduledTask -TaskName 'Tether link' -ErrorAction SilentlyContinue
Get-Process tether-node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
Start-Sleep -Milliseconds 500
Move-Item -Force $tmp $exe

$env:TETHER_NO_PAUSE = '1'
& $exe setup
