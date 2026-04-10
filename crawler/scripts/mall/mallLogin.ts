import type { Page } from 'playwright';

// SK스토아 로그인/세션 공용 모듈.
// scrapeMallShipments.ts 와 scrapeMallSavings.ts 가 같이 쓴다.
// 여기 있는 함수를 바꾸면 두 기능 모두에 영향이 가니 주의.

export type Account = {
  accountId: string;
  username: string;
  password: string;
};

/**
 * login() 이 실제로 참조하는 Config 필드만 뽑은 최소 타입.
 * scrapeMallShipments.ts 의 풀 Config 는 구조적으로 이 타입을 만족한다.
 */
export type LoginConfig = {
  timeoutMs: number;
  headless: boolean;
  urls: {
    login: string;
  };
  selectors: {
    login: {
      tLoginButton: string;
      idInput: string;
      passwordInput: string;
      submitButton: string;
      postLoginReady: string;
    };
  };
};

export function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

export async function login(page: Page, account: Account, config: LoginConfig): Promise<void> {
  const isVisibleNow = async (selector: string): Promise<boolean> =>
    page
      .locator(selector)
      .first()
      .isVisible()
      .then((v) => v)
      .catch(() => false);

  const hasLoggedInSignals = async (): Promise<boolean> => {
    const hintSelectors = unique([
      config.selectors.login.postLoginReady,
      'a[href*="logout"]',
      'button:has-text("로그아웃")',
      'a:has-text("로그아웃")',
    ]);
    for (const selector of hintSelectors) {
      if (await isVisibleNow(selector)) {
        return true;
      }
    }
    return false;
  };

  const isUnavailablePage = async (): Promise<boolean> => {
    const text = (await page.locator('body').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const html = await page.content().catch(() => '');
    return (
      /페이지를\s*표시할\s*수\s*없습니다/.test(text) ||
      /cannot display|page cannot|access denied|forbidden/i.test(text) ||
      html.includes('íŽ˜ì´ì§€')
    );
  };

  const waitVisible = async (selector: string, timeoutMs: number): Promise<boolean> =>
    page
      .locator(selector)
      .first()
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);

  const directLoginUrl = config.urls.login.includes('/member/login')
    ? config.urls.login
    : `https://www.skstoa.com/member/login?forwardUrl=${encodeURIComponent('/mypage/order/list')}`;
  const loginEntryUrls = unique([
    directLoginUrl,
    'https://www.skstoa.com/member/login',
    'https://www.skstoa.com/',
  ]);
  const shortTimeout = Math.min(config.timeoutMs, 4000);

  let lastOpenError = '';
  for (const url of loginEntryUrls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
      await page.waitForTimeout(300);
    } catch (err) {
      lastOpenError = String(err);
      continue;
    }

    if (await hasLoggedInSignals()) {
      return;
    }

    if (await isUnavailablePage()) {
      continue;
    }

    // 홈페이지에서 시작한 경우 로그인 화면으로 한 번 더 진입 시도
    if (!/\/member\/login/.test(page.url())) {
      const loginLinkCandidates = unique([
        'a[href*="/member/login"]',
        'a:has-text("로그인")',
        'button:has-text("로그인")',
      ]);
      for (const selector of loginLinkCandidates) {
        if (!(await waitVisible(selector, 1200))) {
          continue;
        }
        await Promise.all([
          page.waitForLoadState('domcontentloaded').catch(() => undefined),
          page.click(selector, { timeout: shortTimeout }),
        ]);
        await page.waitForTimeout(250);
        break;
      }
    }

    if (await isVisibleNow(config.selectors.login.idInput)) {
      break;
    }
    if (await waitVisible(config.selectors.login.tLoginButton, shortTimeout)) {
      break;
    }
  }

  if (await hasLoggedInSignals()) {
    return;
  }
  if (await isUnavailablePage()) {
    const headlessHint = config.headless
      ? ' (config.headless=true 상태에서 차단될 수 있습니다. config.json에서 headless를 false로 변경 후 재시도 권장)'
      : '';
    throw new Error(`login page unavailable: url=${page.url()}${headlessHint}`);
  }

  // #inputId 가 이미 보이면 T 로그인 버튼 클릭을 건너뛰고 바로 폼 입력으로 진행.
  // T 로그인 클릭 시 auth.skt-id.co.kr 로 리다이렉트되는데, Windows 에서
  // UA/platform 불일치 등으로 봇 탐지에 걸려 로그인이 실패하는 문제를 회피한다.
  let tLoginClicked = false;
  const idInputAlreadyVisible = await isVisibleNow(config.selectors.login.idInput);
  if (!idInputAlreadyVisible) {
    const tLoginSelectors = unique([
      config.selectors.login.tLoginButton,
      'button.sns-tword',
      'a.sns-tword',
      '[class*="sns"][class*="tword"]',
      'button:has-text("T로그인")',
      'a:has-text("T로그인")',
      'button:has-text("티로그인")',
      'a:has-text("티로그인")',
    ]);
    for (const selector of tLoginSelectors) {
      if (!(await waitVisible(selector, shortTimeout))) {
        continue;
      }
      const loc = page.locator(selector).first();
      try {
        await loc.click({ timeout: shortTimeout });
      } catch {
        // Windows에서 onclick은 실행됐지만 Playwright가 timeout을 보고하는 경우가 있음.
        await page.waitForTimeout(600);
        const stillOnLogin = /skstoa\.com\/member\/login/i.test(page.url());
        if (stillOnLogin) {
          await loc.click({ timeout: shortTimeout, force: true }).catch(() => undefined);
        }
      }
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await page.waitForTimeout(300);
      tLoginClicked = true;
      break;
    }
  }

  // 이미 T 로그인 폼이 열린 상태면 버튼이 없을 수 있음
  if (!tLoginClicked && !(await isVisibleNow(config.selectors.login.idInput))) {
    const reason = lastOpenError ? `lastError=${lastOpenError}` : `url=${page.url()}`;
    throw new Error(`T 로그인 버튼을 찾지 못했습니다. ${reason}`);
  }

  await page.waitForSelector(config.selectors.login.idInput, { timeout: config.timeoutMs });
  await page.fill(config.selectors.login.idInput, account.username, { timeout: config.timeoutMs });
  await page.fill(config.selectors.login.passwordInput, account.password, { timeout: config.timeoutMs });

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => undefined),
    page.click(config.selectors.login.submitButton, { timeout: config.timeoutMs }),
  ]);

  // auth.skt-id.co.kr 에서 SK스토아로 리다이렉트 완료 대기 (T 로그인 경유 시)
  if (/auth\.skt-id\.co\.kr/i.test(page.url())) {
    await page
      .waitForURL((url) => !/auth\.skt-id\.co\.kr/i.test(url.toString()), {
        timeout: config.timeoutMs,
      })
      .catch(() => undefined);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  }

  const loginReady = await page
    .waitForSelector(config.selectors.login.postLoginReady, { timeout: Math.min(config.timeoutMs, 12_000) })
    .then(() => true)
    .catch(() => false);
  if (loginReady) {
    return;
  }

  // 비밀번호 변경 권고 등 중간 페이지 처리 (3개월마다 뜨는 팝업 등)
  if (!/\/mypage\//.test(page.url())) {
    const bodyText = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const isInterstitial = /비밀번호.{0,30}변경|변경.{0,30}비밀번호|password.{0,30}change/i.test(bodyText);
    if (isInterstitial) {
      const dismissCandidates = [
        'button:has-text("나중에")',
        'a:has-text("나중에")',
        'button:has-text("다음에")',
        'a:has-text("다음에")',
        'button:has-text("건너뛰기")',
        'a:has-text("건너뛰기")',
        'button:has-text("다음에 변경")',
        'a:has-text("다음에 변경")',
        'button:has-text("다음에 하기")',
        'a:has-text("다음에 하기")',
        'button:has-text("확인")',
        'a:has-text("확인")',
      ];
      for (const selector of dismissCandidates) {
        const btn = page.locator(selector).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 3000 }).catch(() => undefined);
          await page.waitForLoadState('domcontentloaded').catch(() => undefined);
          console.log(`[INFO] 비밀번호 변경 권고 페이지 감지 → "${selector}" 클릭`);
          break;
        }
      }
    }
  }

  const mypageReached = /\/mypage\//.test(page.url());
  if (!mypageReached) {
    throw new Error(`login completed check failed: url=${page.url()}`);
  }
}
