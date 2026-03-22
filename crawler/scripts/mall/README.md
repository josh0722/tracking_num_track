# Mall Shipment Scraper

로그인이 필요한 쇼핑몰 마이페이지에서 주문/배송 상태와 송장번호를 수집하는 Playwright 스크립트입니다.

## 요구사항 반영
- `주문배송현황 > 상품준비` 탭: 결과 상태를 `상품 준비`로 기록
- `주문배송현황 > 배송준비`, `배송중` 탭: 송장번호 수집 및 기록
- 각 탭은 1~3페이지까지 확인
- `취소/교환/반품현황`에서 취소 건 별도 수집
- 한 상품에 송장번호 2개 이상일 때 모두 기록

## 1) 설치
```bash
npm i -D playwright
npx playwright install chromium
```

필수 사전 설치:
- Python 3 (`python3`)
- Node.js + npm
- Python 패키지 `openpyxl` (`python3 -m pip install openpyxl`)

## 2) 설정
1. `scripts/mall/config.example.json`을 복사해 `scripts/mall/config.json` 생성
2. `scripts/mall/accounts.example.json`을 복사해 `scripts/mall/accounts.json` 생성
3. 각 selector/URL을 실제 쇼핑몰 DOM에 맞게 채움

## 3) 실행
```bash
npm run scrape:mall
```

`dateRange.enabled=true`이면 실행 시점 기준으로 `fromDate/toDate`를 자동 갱신합니다.
`debug.enabled=true`이면 실패 분석 파일을 저장합니다.

기본 결과물:
- `scripts/mall/output/results-YYYY-MM-DDTHH-mm-ss.csv`
- `scripts/mall/output/results-YYYY-MM-DDTHH-mm-ss.json`
- `scripts/mall/output/debug-*/` 또는 `scripts/mall/output/debug-latest/` (디버그 아티팩트)

## 오류 확인 방법
1. 실행 로그에서 `[FAIL] account-id` 또는 `[DEBUG] tracking-miss ...` 라인을 확인
2. `scripts/mall/output/debug-latest/` 폴더에서 같은 prefix 파일 4종 확인
- `*.png`: 당시 전체 화면 캡처
- `*.html`: 당시 DOM 전체
- `*.txt`: URL과 에러 메모
- `*.row.html`/`*.row.png`: 송장 미검출이 난 특정 행 정보
3. `tracking-miss`가 반복되면 다음 셀렉터를 우선 수정
- `selectors.orderStatus.shippingLayer.modalRootSelector`
- `selectors.orderStatus.shippingLayer.trackingNumberCandidates`
- `selectors.orderStatus.shippingLayer.closeButtonSelector`
4. 로그인 진입에서 `login page unavailable`이 뜨면 `scripts/mall/config.json`의 `headless`를 `false`로 두고 재실행

## 디버그 추천 설정
- 처음 튜닝 시: `headless=false`, `slowMoMs=150`, `debug.verbose=true`
- 안정화 후: `headless=true`, `slowMoMs=0`, `debug.verbose=false`

## 4) Sheet2 자동 반영 실행
`Sheet2`의 `F(주문번호)`, `W(아이디)`, `X(패스워드)`를 읽어 크롤링 후 `AB(택배사)`, `AC(송장번호)`를 채웁니다.
취소건은 6행 스타일 템플릿으로 서식 처리합니다.
이미 `AB(택배사)` 또는 `AC(송장번호)`가 채워진 행은 건너뛰고, **AB/AC가 모두 빈 행만 처리**합니다.
또한 대상 주문번호만 크롤링하도록 필터링되어 불필요한 행 조회를 줄입니다.

```bash
npm run fill:sheet2-delivery
```

기본 입력/출력:
- 입력(우선순위): `프로젝트루트/통합 문서1.xlsx` → `~/Downloads/통합 문서1.xlsx`
- 출력: 입력 파일과 같은 폴더의 `*_updated.xlsx`

옵션 예시:
```bash
python3 scripts/mall/fill_sheet2_delivery.py --excel "/path/input.xlsx" --output "/path/output.xlsx"
python3 scripts/mall/fill_sheet2_delivery.py --skip-crawl --result-json "/path/results-*.json"
```

## 5) 수동 실행 프로그램(파일 선택 + 돌리기)
자동 스케줄 없이, 사용자가 원할 때만 실행하는 GUI 프로그램입니다.

최초 1회:
```bash
npm install
npx playwright install chromium
```

```bash
npm run run:manual-updater
```

사용 흐름:
- `입력 엑셀`에서 원본 `.xlsx` 선택
- 필요 시 `출력 엑셀` 저장 경로 지정(미입력 시 `_updated.xlsx` 자동 제안)
- `돌리기` 클릭 후 완료 팝업에서 결과 확인

## 팁
- 캡차/2차 인증이 있으면 완전 자동화가 제한됩니다.
- 로그인 후 특정 요소가 나타나야 안정적이라 `postLoginReady` 셀렉터를 정확히 넣어주세요.
- 송장번호가 링크/버튼 내부에 있으면 `trackingNumberCandidates`에 해당 selector를 추가하세요.

## 6) 터미널 없이 앱처럼 실행(macOS)
`.app`으로 빌드한 뒤 더블클릭으로 실행할 수 있습니다.

빌드:
```bash
python3 -m pip install pyinstaller
npm run build:manual-updater-app
```

생성 결과:
- `dist/ExcelDeliveryUpdater.app`

문제 해결:
- 실행 중 `No module named openpyxl` 오류가 나면:
  - `python3 -m pip install openpyxl`
  - 필요 시 실행 전에 `MALL_PYTHON_BIN`으로 Python 경로 지정  
    예: `export MALL_PYTHON_BIN=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3`
- 실행 중 `npm을 찾지 못했습니다` 오류가 나면:
  - `MALL_NPM_BIN`으로 npm 경로 지정  
    예: `export MALL_NPM_BIN=/opt/homebrew/bin/npm`

## 속도 튜닝
- `scripts/mall/config.json`에서 `debug.enabled=false`로 설정 (디버그 파일 저장 비용 절감)
- `maxPagesPerTab`를 실제 필요 페이지 수로 낮추기 (예: 3 -> 1~2)
- `dateRange.lookbackDays`를 필요한 기간으로 축소
- 안정화된 환경이면 `headless=true` 유지

## 7) Windows 사용자 배포용 번들 만들기
Windows에서 아래 스크립트를 실행하면, 사용자가 더블클릭으로 실행 가능한 배포 번들을 만듭니다.
이 번들은 `Worker exe`를 포함하므로 사용자 PC에 Python 설치가 필요 없습니다.

```powershell
npm run build:windows-bundle
```

결과물:
- `dist/windows-bundle/Run_ExcelDeliveryUpdater.bat`
- `dist/windows-bundle/app/ExcelDeliveryUpdater.exe`
- `dist/windows-bundle/app/FillSheetWorker.exe`
- `dist/windows-bundle/project/*` (스크립트 + node_modules + playwright 브라우저 포함)

Windows 사용자에게는 `dist/windows-bundle` 폴더 전체를 전달하면 됩니다.
사용자는 `Run_ExcelDeliveryUpdater.bat`만 실행하면 됩니다.
