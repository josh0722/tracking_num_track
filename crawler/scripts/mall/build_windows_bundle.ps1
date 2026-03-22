param(
  [string]$BundleDir = "dist/windows-bundle"
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "이 스크립트는 Windows에서 실행해야 합니다."
}

$root = Resolve-Path (Join-Path $PSScriptRoot "../..")
Set-Location $root

Write-Host "[INFO] root: $root"

# Portable bundle에 브라우저를 포함하기 위해 프로젝트 내부에 설치
$env:PLAYWRIGHT_BROWSERS_PATH = "0"

python -m pip install --upgrade pip
python -m pip install pyinstaller openpyxl

npm install
npx playwright install chromium

python -m PyInstaller --noconfirm --clean --windowed --name ExcelDeliveryUpdater scripts/mall/manual_update_app.py
python -m PyInstaller --noconfirm --clean --console --onefile --name FillSheetWorker scripts/mall/fill_sheet2_delivery.py

$bundlePath = Join-Path $root $BundleDir
if (Test-Path $bundlePath) {
  Remove-Item $bundlePath -Recurse -Force
}
New-Item -ItemType Directory -Path $bundlePath | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundlePath "app") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundlePath "project") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundlePath "runtime/node") | Out-Null

Copy-Item (Join-Path $root "dist/ExcelDeliveryUpdater/*") (Join-Path $bundlePath "app") -Recurse -Force
Copy-Item (Join-Path $root "dist/FillSheetWorker.exe") (Join-Path $bundlePath "app/FillSheetWorker.exe") -Force
Copy-Item (Join-Path $root "package.json") (Join-Path $bundlePath "project/package.json") -Force
Copy-Item (Join-Path $root "scripts") (Join-Path $bundlePath "project/scripts") -Recurse -Force
Copy-Item (Join-Path $root "node_modules") (Join-Path $bundlePath "project/node_modules") -Recurse -Force

$nodePath = (Get-Command node).Source
Copy-Item $nodePath (Join-Path $bundlePath "runtime/node/node.exe") -Force

$nodeDir = Split-Path $nodePath -Parent
$npmCmd = Join-Path $nodeDir "npm.cmd"
if (Test-Path $npmCmd) {
  Copy-Item $npmCmd (Join-Path $bundlePath "runtime/node/npm.cmd") -Force
}

$launcher = @"
@echo off
setlocal
set ROOT=%~dp0
set MALL_REPO_ROOT=%ROOT%project
set PLAYWRIGHT_BROWSERS_PATH=0
if exist "%ROOT%app\FillSheetWorker.exe" set MALL_FILL_WORKER_BIN=%ROOT%app\FillSheetWorker.exe
if exist "%ROOT%runtime\node\node.exe" set MALL_NODE_BIN=%ROOT%runtime\node\node.exe
if exist "%ROOT%runtime\node\npm.cmd" set MALL_NPM_BIN=%ROOT%runtime\node\npm.cmd
start "" "%ROOT%app\ExcelDeliveryUpdater.exe"
"@

Set-Content -Path (Join-Path $bundlePath "Run_ExcelDeliveryUpdater.bat") -Value $launcher -Encoding ASCII

Write-Host "[DONE] Windows bundle created:"
Write-Host "       $bundlePath"
