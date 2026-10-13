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

Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
$lines = Get-Content $sums
Remove-Item -Force $sums
function Sum-For($file) { ($lines | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($file))$" } | ForEach-Object { $Matches[1] }) | Select-Object -First 1 }
function Sum-Of($file) { (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower() }
function Mismatch {
  Remove-Item -Force $tmp, "$tmp.gz" -ErrorAction SilentlyContinue
  throw "The download didn't match the release's checksum. Run the command again."
}
$want = Sum-For $name
$wantGz = Sum-For "$name.gz"
# the gzipped copy is under half the size; releases before 0.11 have none
if ($wantGz) {
  Write-Host "Downloading $name.gz..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$name.gz" -OutFile "$tmp.gz"
  if ((Sum-Of "$tmp.gz") -ne $wantGz) { Mismatch }
  # GZipStream is in System.dll, so this works on PowerShell 5.1 without anything else
  $src = [IO.File]::OpenRead("$tmp.gz")
  try {
    $gz = New-Object IO.Compression.GZipStream($src, [IO.Compression.CompressionMode]::Decompress)
    $dst = [IO.File]::Create($tmp)
    try { $gz.CopyTo($dst) } finally { $dst.Dispose(); $gz.Dispose() }
  } finally { $src.Dispose() }
  Remove-Item -Force "$tmp.gz"
} else {
  Write-Host "Downloading $name..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $tmp
}
if (-not $want -or (Sum-Of $tmp) -ne $want) { Mismatch }

# a running copy can't be replaced, but it can be renamed; setup restarts the background one
if (Test-Path $exe) {
  try { Remove-Item -Force $exe } catch { Move-Item -Force $exe "$exe.old-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())" }
}
Move-Item -Force $tmp $exe

$env:INYON_NO_PAUSE = '1'
& $exe setup
