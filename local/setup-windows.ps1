# Films in Oxford: sets up the daily Vue + Curzon fetch on this Windows computer. No admin rights needed.
# Run in PowerShell:  irm https://raw.githubusercontent.com/Undertow6248/FilmsInOxford/main/local/setup-windows.ps1 | iex
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repo = "https://raw.githubusercontent.com/Undertow6248/FilmsInOxford/main/local"
$Dir = Join-Path $env:LOCALAPPDATA "FilmsInOxford"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir
Write-Host "Setting up in $Dir" -ForegroundColor Cyan

# 1. Node.js: use the installed one, or download a private copy into this folder.
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
  $NodeDir = Join-Path $Dir "node"
  $Node = Join-Path $NodeDir "node.exe"
  if (-not (Test-Path $Node)) {
    Write-Host "Downloading Node.js (about 30 MB)..."
    $v = "v22.20.0"
    $zip = Join-Path $Dir "node.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath $Dir -Force
    Remove-Item $zip
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    Rename-Item (Join-Path $Dir "node-$v-win-x64") "node"
  }
}
$Npm = Join-Path (Split-Path $Node) "npm.cmd"
Write-Host "Using Node at $Node"

# 2. The fetch script and its one dependency.
foreach ($f in "fetch.mjs", "package.json") { Invoke-WebRequest "$Repo/$f" -OutFile (Join-Path $Dir $f) }
& $Npm install --no-audit --no-fund --silent
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

# 3. GitHub token (stored only in this folder).
$Config = Join-Path $Dir "config.json"
if (-not (Test-Path $Config)) {
  Write-Host ""
  Write-Host "Paste your GitHub token (starts github_pat_). It won't show as you paste, then press Enter:" -ForegroundColor Yellow
  $sec = Read-Host -AsSecureString
  $tok = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
  if (-not $tok) { throw "No token entered" }
  [IO.File]::WriteAllText($Config, (@{ token = $tok } | ConvertTo-Json))  # UTF-8 without BOM
  icacls $Config /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

# 4. A hidden launcher, so no console window pops up.
$Vbs = Join-Path $Dir "run.vbs"
"Set sh = CreateObject(""WScript.Shell"")`r`nsh.CurrentDirectory = ""$Dir""`r`nsh.Run """"""$Node"""" """"$Dir\fetch.mjs"""""", 0, True" | Set-Content -Encoding ASCII $Vbs

# 5. Scheduled task: 10:15 every day, plus 15 minutes after you log in. It skips itself if it already ran that day,
#    and catches up when the computer is next on if it was off at 10:15.
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$Vbs`"" -WorkingDirectory $Dir
$daily = New-ScheduledTaskTrigger -Daily -At 10:15
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logon.Delay = "PT15M"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Films in Oxford" -Action $action -Trigger $daily, $logon -Settings $settings -Description "Fetches Vue and Curzon times for the Films in Oxford site" -Force | Out-Null
Write-Host "Scheduled task 'Films in Oxford' added." -ForegroundColor Green

# 6. First run now, so you can see it work.
Write-Host "Running it once now (a browser window opens off-screen for a minute or two)..."
& $Node (Join-Path $Dir "fetch.mjs") --force
if ($LASTEXITCODE -eq 0) { Write-Host "Done. Vue and Curzon times are on their way to the site." -ForegroundColor Green }
else { Write-Host "The first run had a problem; see $Dir\fetch.log" -ForegroundColor Red }
