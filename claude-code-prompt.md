# scrapeMallShipments.ts 크롤링 속도 최적화

## 목표
현재 순차 실행 중심인 크롤링 로직을 병렬화 + 불필요한 대기 제거로 속도를 최대한 끌어올려줘.
기존 동작(결과 데이터 구조, 파일 저장 형식)은 그대로 유지해야 해.

## 적용할 최적화 (우선순위순)

### 1. 송장번호 수집: 팝업 클릭 → API 직접 호출로 전환
- 현재: 행마다 "배송조회" 버튼 클릭 → 모달 오픈 → DOM에서 추출 → 닫기 (가장 큰 병목)
- 변경: 브라우저 DevTools Network 탭 기준으로, 배송조회 팝업이 내부적으로 호출하는 API 엔드포인트를 `context.request.get()` 또는 `page.evaluate(() => fetch(...))` 로 직접 호출해서 송장번호를 가져와줘
- `context.request`를 쓰면 세션 쿠키가 자동 전달되니까 별도 인증 불필요
- API 엔드포인트를 코드에서 특정할 수 없으면, `page.route('**/delivery/trace**')` 같은 intercept 패턴으로 응답을 가로채는 방식을 fallback으로 구현해줘
- 기존 2-layer 로직(DOM 직접 추출 + 팝업 fallback)은 최종 fallback으로 남겨둬

### 2. 탭 4개 병렬 순회
- 현재: productReady → shippingReady → inTransit → delivered 순차 순회
- 변경: 같은 context 안에서 `context.newPage()`로 탭별 별도 페이지를 열고 `Promise.all`로 병렬 실행
- productReady는 송장번호 수집 안 하니까 가장 빨리 끝남 — 별도 처리 불필요

### 3. 계정 병렬 처리
- 현재: 계정별 순차 실행
- 변경: `p-limit` (없으면 설치해줘) 으로 동시 실행 수 제한하면서 병렬화
- 기본 concurrency = 3, 상수로 빼서 조절 가능하게

```typescript
import pLimit from 'p-limit';
const ACCOUNT_CONCURRENCY = 3;
const limit = pLimit(ACCOUNT_CONCURRENCY);

const results = await Promise.all(
  accounts.map(acc => limit(() => scrapeAccount(browser, acc)))
);
```

### 4. 페이지 로드 대기 최적화
- `waitForLoadState('networkidle')` 사용하는 곳을 모두 찾아서 → `waitForSelector`로 교체 (실제 필요한 DOM 요소가 렌더링되면 바로 진행)
- 페이지네이션 이동 시에도 동일하게 적용

### 5. 불필요한 리소스 차단
- 각 page 생성 직후 아래 route 추가:

```typescript
await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ttf}', route => route.abort());
```

- 브라우저 launch args에 추가:

```typescript
args: [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  // 기존 --disable-blink-features=AutomationControlled 유지
]
```

### 6. 조기 종료 강화
- 타겟 주문이 모두 수집되면 남은 탭/페이지 순회를 즉시 중단하는 로직이 이미 있으면 유지, 없으면 추가

## 제약사항
- 봇 감지 우회 로직(webdriver 주입, disable-blink-features 등) 절대 제거하지 마
- 로그인 흐름(T 로그인 버튼 → ID/PW) 변경하지 마
- 최대 재시도 3회 로직 유지
- 결과 JSON/CSV 저장 형식 동일하게 유지
- 에러 핸들링: 병렬 실행 중 한 계정/탭이 실패해도 나머지는 계속 진행 (Promise.allSettled 검토)

## 작업 순서
1. 먼저 현재 코드를 전체 읽고 구조 파악
2. 위 최적화를 우선순위순으로 적용
3. 기존 테스트가 있으면 깨지지 않는지 확인
4. 변경사항 요약 출력
