param([Parameter(Mandatory=$true)][int]$OldAppProcess)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSCommandPath
$receipt=Join-Path $root 'overlay-runner-state.json'
$exe=Join-Path $env:LOCALAPPDATA 'Programs\Chat On Steroids\Chat On Steroids.exe'
function Save-State($state,$detail) {
  @{state=$state;detail=$detail;at=(Get-Date -Format o);runner=$PID;oldApp=$OldAppProcess}|
    ConvertTo-Json|Set-Content -LiteralPath $receipt -Encoding utf8
}
Save-State 'waiting-for-normal-quit' 'One-shot window: 120 seconds. No force-kill or repeated timer.'
try {
  $deadline=(Get-Date).AddSeconds(120)
  while(Get-Process -Id $OldAppProcess -ErrorAction SilentlyContinue) {
    if((Get-Date) -gt $deadline){throw 'App did not quit normally within the bounded window; nothing installed'}
    Start-Sleep -Milliseconds 250
  }
  if(Get-Process -Name 'Chat On Steroids' -ErrorAction SilentlyContinue){throw 'Another app process is active; no files changed'}
  if((Get-Item -LiteralPath $exe).VersionInfo.FileVersion -ne '2.1.44'){throw 'Installed app version differs from the pinned baseline'}
  Save-State 'app-stopped' 'Publishing only the two verified extension files and their full build stamp.'
  & 'C:\Program Files\nodejs\node.exe' (Join-Path $root 'install-local-extension.mjs')
  if($LASTEXITCODE -ne 0){throw 'Overlay installation failed; inspect rollback receipt'}
  Save-State 'restart-requested' 'Bundled overlay verified; native app must materialize and load it before acceptance.'
  Start-Process -FilePath $exe -ArgumentList '--updated'
} catch {
  Save-State 'failed' $_.Exception.Message
  # Restart only after the independent verifier establishes all official bundled bytes.
  if(-not(Get-Process -Name 'Chat On Steroids' -ErrorAction SilentlyContinue)) {
    & 'C:\Program Files\nodejs\node.exe' (Join-Path $root 'restore-local-extension.mjs') --live --verify-only
    if($LASTEXITCODE -eq 0) {
      Start-Process -FilePath $exe -ArgumentList '--updated'
    } else {
      Save-State 'restoration-unverified-app-stopped' 'No restart: use the independent restore helper and verify official bytes first.'
    }
  }
  exit 1
}
