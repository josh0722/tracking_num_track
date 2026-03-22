# 배송 관리기 (Tracking Number Tracker)

`Sheet2` 양식 엑셀을 대상으로, 프로젝트 내부에 포함된 SK스토아 크롤러와 송장 기반 배송현황 업데이트를 한 번에 반영하는 웹 앱입니다.

## 기술 스택
- FastAPI
- httpx
- Vanilla HTML/CSS/JS
- tracker.delivery API (무료로 시작 가능)

## 실행 방법

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

브라우저에서 `http://127.0.0.1:8000` 접속.

## API

### `POST /api/workflows/sync-sheet2`
`Sheet2` 엑셀에 대해 아래 통합 작업을 순서대로 수행합니다.
- 1) 기본 내장 `crawler/scripts/mall/fill_sheet2_delivery.py` 실행
- 2) AB(택배사), AC(송장번호)를 기준으로 tracker.delivery 조회
- 3) AD~AG(배송상태, 이동시간, 현재위치, 배송기사) 컬럼 업데이트

요청 예시:

```json
{
  "excel_path": "/Users/you/Downloads/통합 문서1.xlsx",
  "crawler_path": "/Users/you/apps/tracking_num_track/crawler"
}
```

## 비용 절감을 위한 운영 팁
- 첫 단계는 무료 API로 MVP를 운영합니다.
- 조회량이 늘면 캐시(예: Redis)로 API 호출량을 줄입니다.
- API 장애 대비를 위해 `서비스 레이어`를 유지하고, 다른 제공사 API를 추가로 붙일 수 있게 확장합니다.

## 통합 실행(웹)
1. 서버 실행 후 `http://127.0.0.1:8000` 접속
2. `Sheet2 통합 실행` 섹션에서 엑셀 경로 입력
3. `통합 실행` 클릭
4. 엑셀 경로 오른쪽 `선택` 버튼으로 파일 탐색기에서 직접 선택 가능

기본적으로는 현재 프로젝트 안의 `crawler/`를 자동 사용합니다.

실행 결과:
- 결과 엑셀 파일 경로 출력
- 업데이트 행 수, 택배사 매칭 실패 수, 조회 실패 수 요약 표시

## 다음 확장 아이디어
- 조회 이력 저장(최근 조회 목록)
- 배송 상태 변경 알림(이메일/카카오톡)
- 다중 API fallback(주 API 실패 시 보조 API 호출)
