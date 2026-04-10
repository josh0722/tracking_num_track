param(
  [string]$BundleDir = "dist/savings-bundle"
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

# node_modules / playwright chromium 은 build_windows_bundle.ps1 가 먼저 돌아갔다면
# 이미 설치돼 있을 가능성이 크다. 멱등성을 위해 다시 호출해도 OK.
npm install
npx playwright install chromium

# PyInstaller 빌드 시 UTF-8 인코딩 강제 (한글 깨짐 방지)
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"
chcp 65001

python -m PyInstaller --noconfirm --clean --windowed --name SavingsLookup scripts/mall/savings_update_app.py
python -m PyInstaller --noconfirm --clean --console --onefile --name SavingsWorker scripts/mall/fill_savings.py

$bundlePath = Join-Path $root $BundleDir
if (Test-Path $bundlePath) {
  Remove-Item $bundlePath -Recurse -Force
}
New-Item -ItemType Directory -Path $bundlePath | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundlePath "app") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundlePath "project") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $bundlePath "runtime/node") | Out-Null

Copy-Item (Join-Path $root "dist/SavingsLookup/*") (Join-Path $bundlePath "app") -Recurse -Force
Copy-Item (Join-Path $root "dist/SavingsWorker.exe") (Join-Path $bundlePath "app/SavingsWorker.exe") -Force
Copy-Item (Join-Path $root "package.json") (Join-Path $bundlePath "project/package.json") -Force
Copy-Item (Join-Path $root "scripts") (Join-Path $bundlePath "project/scripts") -Recurse -Force
Copy-Item (Join-Path $root "node_modules") (Join-Path $bundlePath "project/node_modules") -Recurse -Force

$nodePath = (Get-Command node).Source
Copy-Item $nodePath (Join-Path $bundlePath "runtime/node/node.exe") -Force

# npm 패키지도 함께 복사 (npm.cmd만으로는 동작하지 않음)
$nodeDir = Split-Path $nodePath -Parent
$npmCmd = Join-Path $nodeDir "npm.cmd"
if (Test-Path $npmCmd) {
  Copy-Item $npmCmd (Join-Path $bundlePath "runtime/node/npm.cmd") -Force
}
$npmPkgDir = Join-Path $nodeDir "node_modules/npm"
if (Test-Path $npmPkgDir) {
  New-Item -ItemType Directory -Path (Join-Path $bundlePath "runtime/node/node_modules") -Force | Out-Null
  Copy-Item $npmPkgDir (Join-Path $bundlePath "runtime/node/node_modules/npm") -Recurse -Force
  Write-Host "[INFO] npm package copied to bundle"
} else {
  Write-Host "[WARN] npm package not found at $npmPkgDir - npm.cmd may not work in bundle"
}

$launcher = @"
@echo off
setlocal
chcp 65001 > nul
set ROOT=%~dp0
set MALL_REPO_ROOT=%ROOT%project
set PLAYWRIGHT_BROWSERS_PATH=0
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
if exist "%ROOT%app\SavingsWorker.exe" set MALL_SAVINGS_WORKER_BIN=%ROOT%app\SavingsWorker.exe
if exist "%ROOT%runtime\node\node.exe" set MALL_NODE_BIN=%ROOT%runtime\node\node.exe
if exist "%ROOT%runtime\node\npm.cmd" set MALL_NPM_BIN=%ROOT%runtime\node\npm.cmd
start "" "%ROOT%app\SavingsLookup.exe"
"@

Set-Content -Path (Join-Path $bundlePath "Run_SavingsLookup.bat") -Value $launcher -Encoding ASCII

Write-Host "[DONE] Savings bundle created:"
Write-Host "       $bundlePath"
