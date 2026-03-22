#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
APP_NAME="ExcelDeliveryUpdater"

cd "$ROOT_DIR"
export PYINSTALLER_CONFIG_DIR="$ROOT_DIR/.pyinstaller"
mkdir -p "$PYINSTALLER_CONFIG_DIR"

if ! command -v pyinstaller >/dev/null 2>&1; then
  echo "[ERROR] pyinstaller가 설치되어 있지 않습니다."
  echo "설치: python3 -m pip install pyinstaller"
  exit 1
fi

python3 -m PyInstaller \
  --noconfirm \
  --clean \
  --windowed \
  --name "$APP_NAME" \
  scripts/mall/manual_update_app.py

echo "[DONE] 앱 빌드 완료: $ROOT_DIR/dist/$APP_NAME.app"
echo "[INFO] 이 앱은 현재 프로젝트 폴더(크롤러 스크립트, config.json)와 함께 사용해야 합니다."
