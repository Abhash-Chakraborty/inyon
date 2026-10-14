# Gets inyon for this PC and sets it up for the Inyon phone app. In PowerShell:
#   irm https://inyon.abhashchakraborty.tech/get.ps1 | iex
# It downloads the inyon command into %USERPROFILE%\.inyon\bin from the download host's copy of
# the newest release, checks it against the release's checksums, and runs its setup, which fetches
# the engine behind it, starts it in the background when you sign in, and shows a code to scan
# with the app. No admin rights needed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is very slow with the progress bar on PS 5.1
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$base = if ($env:INYON_DOWNLOAD) { $env:INYON_DOWNLOAD } elseif ($env:TETHER_DOWNLOAD) { $env:TETHER_DOWNLOAD } else { 'https://dl.abhashchakraborty.tech' }
$dir = Join-Path $env:USERPROFILE '.inyon\bin'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'inyon.exe'
$tmp = "$exe.download"
$sums = "$exe.sums"

Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
# the list is signed with minisign; checked when minisign is on PATH (scoop or the zip from
# jedisct1/minisign), else trusted as it comes, as before 0.14
$key = 'RWRTvQv/ifQnD3jarY1oarS0AKdhogH+mdgn/o0NzT/Ro8L43nFqqfp6'
# a mock release for tests signs with a key of its own; it only counts with downloads pointed
# somewhere other than the download host, the website or GitHub (-match ignores case)
$official = $base -match '^https?://(dl|inyon)\.abhashchakraborty\.tech(/|$)|^https://github\.com/Abhash-Chakraborty/inyon/releases/'
if (($env:INYON_DOWNLOAD -or $env:TETHER_DOWNLOAD) -and $env:INYON_SIGNING_KEY -and -not $official) { $key = $env:INYON_SIGNING_KEY }
if (Get-Command minisign -ErrorAction SilentlyContinue) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.minisig" -OutFile "$sums.minisig"
    & minisign -V -q -m $sums -x "$sums.minisig" -P $key | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'bad signature' }
  } catch {
    Remove-Item -Force $sums, "$sums.minisig" -ErrorAction SilentlyContinue
    throw "The release's checksum list isn't signed by Inyon's release key, so nothing was installed."
  }
  Remove-Item -Force "$sums.minisig"
} else {
  Write-Host "(minisign isn't installed, so the checksums weren't signature-checked)"
}
$lines = Get-Content $sums
Remove-Item -Force $sums
function Sum-For($file) { ($lines | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($file))$" } | ForEach-Object { $Matches[1] }) | Select-Object -First 1 }
function Sum-Of($file) { (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower() }
# Windows on ARM gets its own inyon command from 0.13 on (the engine behind it stays x64); a
# release without one, and every x64 PC, takes the x64 build
$name = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -and (Sum-For 'inyon-windows-arm64.exe')) { 'inyon-windows-arm64.exe' } else { 'inyon-windows-x64.exe' }
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
