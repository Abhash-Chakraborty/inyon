# Gets inyon for this PC and sets it up for the Inyon phone app. In PowerShell:
#   irm https://inyon.abhashchakraborty.tech/get.ps1 | iex
# It downloads inyon into %USERPROFILE%\.inyon\bin, checks it against the release's checksums,
# starts it in the background when you sign in, and shows a code to scan with the app.
# No admin rights needed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$base = if ($env:INYON_DOWNLOAD) { $env:INYON_DOWNLOAD } elseif ($env:TETHER_DOWNLOAD) { $env:TETHER_DOWNLOAD } else { 'https://github.com/Abhash-Chakraborty/inyon/releases/latest/download' }
# Windows on ARM runs the x64 build
$name = 'inyon-windows-x64.exe'
$dir = Join-Path $env:USERPROFILE '.inyon\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'inyon.exe'
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

# a running copy can't be replaced, but it can be renamed; setup restarts the background one
if (Test-Path $exe) {
  try { Remove-Item -Force $exe } catch { Move-Item -Force $exe "$exe.old-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" }
}
Move-Item -Force $tmp $exe

$env:INYON_NO_PAUSE = '1'
& $exe setup
