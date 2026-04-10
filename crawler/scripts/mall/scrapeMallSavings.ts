import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import pLimit from 'p-limit';

import { login, unique, type Account, type LoginConfig } from './mallLogin.js';

// 안전망: Playwright 내부 등에서 발생할 수 있는 미처리 rejection이 프로세스를 크래시하지 않도록 방지
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] unhandled rejection (suppressed):', reason);
});

// config.json 은 scrapeMallShipments.ts 의 것을 그대로 쓴다.
// 여기서 실제로 참조하는 필드만 뽑은 최소 타입.
type SavingsConfig = LoginConfig & {
  slowMoMs?: number;
};

type SavingsExpiration = {
  expireDate: string; // 예: '2026.04.30'
  amount: number | null; // 숫자만 (예: 7971)
  rawAmount: string; // 원문 (예: '-7,971원')
};

type SavingsRow = {
  scrapedAt: string;
  accountId: string;
  accountUsername: string;
  membershipDiscount: number | null;
  membershipRawText: string;
  expirations: SavingsExpiration[];
  error: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = process.env.MALL_CONFIG_PATH
  ? path.resolve(process.env.MALL_CONFIG_PATH)
  : path.join(__dirname, 'config.json');
const accountsPath = process.env.MALL_ACCOUNTS_PATH
  ? path.resolve(process.env.MALL_ACCOUNTS_PATH)
  : path.join(__dirname, 'accounts.json');
const outputDir = process.env.MALL_OUTPUT_DIR
  ? path.resolve(process.env.MALL_OUTPUT_DIR)
  : path.join(__dirname, 'output');

const MYPAGE_MAIN_URL = 'https://www.skstoa.com/mypage/myPage';
const SAVEAMT_URL = 'https://www.skstoa.com/mypage/saveamt';

function parseNumber(text: string): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9-]/g, '');
  if (!cleaned || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

async function assertRequiredFiles(): Promise<void> {
  try {
    await fs.access(configPath);
  } catch {
    throw new Error(
      `Missing config file: ${configPath}\nCreate it from template:\ncp ${path.join(__dirname, 'config.example.json')} ${configPath}`,
    );
  }
  try {
    await fs.access(accountsPath);
  } catch {
    throw new Error(
      `Missing accounts file: ${accountsPath}\nCreate it from template:\ncp ${path.join(__dirname, 'accounts.example.json')} ${accountsPath}`,
    );
  }
}

async function tryReadFirstText(page: Page, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    const count = await loc.count().catch(() => 0);
    if (count === 0) continue;
    const txt = (await loc.innerText().catch(() => '')).trim();
    if (txt) return txt;
  }
  return '';
}

async function readMembershipDiscount(page: Page): Promise<{ value: number | null; rawText: string }> {
  // 사용자 제공 HTML:
  // <a href="javascript: goUrl('/mypage/membDcAmt');" class="ga-event" ...>
  //   <div class="txt">멤버십할인</div>
  //   <div class="num"><strong>4,780원</strong></div>
  // </a>
  const candidates = unique([
    'a[href*="membDcAmt"] .num strong',
    'a[ga-label="멤버십할인"] .num strong',
    'a.ga-event:has(.txt:has-text("멤버십할인")) .num strong',
    'a:has(.txt:has-text("멤버십할인")) .num',
  ]);
  const rawText = await tryReadFirstText(page, candidates);
  return { value: parseNumber(rawText), rawText };
}

async function openExpirationPopup(page: Page, timeoutMs: number): Promise<boolean> {
  // 사용자 제공 HTML:
  // <a href="javascript:void(0);" data-target="#pop01" class="openPopNew_js">
  //   <span class="extinction">소멸예정<span>(30일 이내)</span></span>
  //   <span class="won_box nanum_s_b">7,971<span class="won nanum_s_r">원</span></span>
  // </a>
  const buttonCandidates = unique([
    'a.openPopNew_js:has(span.extinction)',
    'a[data-target="#pop01"]:has(.extinction)',
    'a:has(span.extinction:has-text("소멸예정"))',
  ]);

  for (const selector of buttonCandidates) {
    const btn = page.locator(selector).first();
    const count = await btn.count().catch(() => 0);
    if (count === 0) continue;
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      await btn.click({ timeout: Math.min(timeoutMs, 5_000) });
    } catch {
      continue;
    }
    // 팝업 컨테이너 감지
    const popupCandidates = unique([
      'div.savelist.tbl_type1',
      '#pop01 .savelist',
      '.layerPop.active .savelist',
    ]);
    for (const popupSel of popupCandidates) {
      const popup = page.locator(popupSel).first();
      const appeared = await popup
        .waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5_000) })
        .then(() => true)
        .catch(() => false);
      if (appeared) return true;
    }
  }
  return false;
}

async function readExpirations(page: Page): Promise<SavingsExpiration[]> {
  // 팝업 내부 항목 구조:
  // <div class="savelist tbl_type1">
  //   <div class="list_ty ty02">
  //     <dl class="tit">...헤더...</dl>
  //     <dl>
  //       <dt><div class="date type2 t_center">2026.04.30</div></dt>
  //       <dd><div class="history_amount">-7,971원</div></dd>
  //     </dl>
  //     ... (추가 항목)
  //   </div>
  // </div>
  const popupCandidates = unique([
    'div.savelist.tbl_type1',
    '#pop01 .savelist',
    '.layerPop.active .savelist',
  ]);

  for (const popupSel of popupCandidates) {
    const popup = page.locator(popupSel).first();
    const count = await popup.count().catch(() => 0);
    if (count === 0) continue;

    const raw = await popup
      .evaluate((root: Element) => {
        const out: { expireDate: string; rawAmount: string }[] = [];
        const dls = root.querySelectorAll('dl');
        dls.forEach((dl) => {
          if (dl.classList.contains('tit')) return;
          const dateEl = dl.querySelector('.date') as HTMLElement | null;
          const amountEl = dl.querySelector('.history_amount') as HTMLElement | null;
          const expireDate = (dateEl?.textContent ?? '').trim();
          const rawAmount = (amountEl?.textContent ?? '').trim();
          if (expireDate || rawAmount) {
            out.push({ expireDate, rawAmount });
          }
        });
        return out;
      })
      .catch(() => [] as { expireDate: string; rawAmount: string }[]);

    if (raw.length > 0) {
      return raw.map((r) => ({
        expireDate: r.expireDate,
        rawAmount: r.rawAmount,
        amount: parseNumber(r.rawAmount),
      }));
    }
  }

  return [];
}

async function scrapeAccountSavings(params: {
  browser: Browser;
  account: Account;
  config: SavingsConfig;
}): Promise<SavingsRow> {
  const { browser, account, config } = params;
  const scrapedAt = new Date().toISOString();

  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent:
      process.platform === 'win32'
        ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);

    console.log(`[INFO] ${account.accountId} logging in (username=${account.username})...`);
    await login(page, account, config);
    console.log(`[INFO] ${account.accountId} login success`);

    // 1) 멤버십할인: /mypage/myPage
    let membership = { value: null as number | null, rawText: '' };
    try {
      await page.goto(MYPAGE_MAIN_URL, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
      await page.waitForTimeout(400);
      membership = await readMembershipDiscount(page);
      console.log(
        `[INFO] ${account.accountId} membershipDiscount=${membership.value} raw="${membership.rawText}"`,
      );
    } catch (err) {
      console.warn(
        `[WARN] ${account.accountId} 멤버십할인 조회 실패:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    // 2) 소멸예정 적립금: /mypage/saveamt
    let expirations: SavingsExpiration[] = [];
    try {
      await page.goto(SAVEAMT_URL, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
      await page.waitForTimeout(500);
      const opened = await openExpirationPopup(page, config.timeoutMs);
      if (opened) {
        expirations = await readExpirations(page);
        console.log(`[INFO] ${account.accountId} expirations=${expirations.length}`);
      } else {
        console.log(`[INFO] ${account.accountId} 소멸예정 버튼 없음 (소멸 적립금 없음으로 간주)`);
      }
    } catch (err) {
      console.warn(
        `[WARN] ${account.accountId} 소멸예정 조회 실패:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    return {
      scrapedAt,
      accountId: account.accountId,
      accountUsername: account.username,
      membershipDiscount: membership.value,
      membershipRawText: membership.rawText,
      expirations,
      error: '',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[ERROR] ${account.accountId} savings scrape failed:`, msg);
    return {
      scrapedAt,
      accountId: account.accountId,
      accountUsername: account.username,
      membershipDiscount: null,
      membershipRawText: '',
      expirations: [],
      error: msg,
    };
  } finally {
    await Promise.race([
      context.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 10_000);
        t.unref();
      }),
    ]);
  }
}

// 재시도 3회 래퍼 — shipments 의 scrapeAccountWithRetry 와 동일 패턴
async function scrapeAccountSavingsWithRetry(
  browser: Browser,
  account: Account,
  config: SavingsConfig,
): Promise<SavingsRow> {
  const MAX_RETRIES = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[INFO] retry attempt=${attempt} account=${account.accountId}`);
      }
      const scrapePromise = scrapeAccountSavings({ browser, account, config });
      const timeoutPromise = new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('account timeout (180s)')), 180_000);
        t.unref();
      });
      scrapePromise.catch(() => undefined);
      timeoutPromise.catch(() => undefined);
      const row = await Promise.race([scrapePromise, timeoutPromise]);
      if (row.error && attempt < MAX_RETRIES) {
        // login 실패 등으로 row.error 가 비어있지 않으면 재시도 루프로 올림
        throw new Error(row.error);
      }
      console.log(`[OK] ${account.accountId} - membership=${row.membershipDiscount} expirations=${row.expirations.length}`);
      return row;
    } catch (error) {
      lastError = error;
      console.error(
        `[ERROR] ${account.accountId} attempt=${attempt} error:`,
        error instanceof Error ? error.message : String(error),
      );
      if (attempt < MAX_RETRIES) {
        console.warn(`[RETRY] ${account.accountId} attempt=${attempt} failed, retrying...`);
        const delayMs = attempt * 5_000;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delayMs);
          t.unref();
        });
      }
    }
  }

  console.error(`[FAIL] ${account.accountId}`, lastError);
  return {
    scrapedAt: new Date().toISOString(),
    accountId: account.accountId,
    accountUsername: account.username,
    membershipDiscount: null,
    membershipRawText: '',
    expirations: [],
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

async function main(): Promise<void> {
  await assertRequiredFiles();

  const config = await readJsonFile<SavingsConfig>(configPath);
  const accounts = await readJsonFile<Account[]>(accountsPath);

  if (accounts.length === 0) {
    throw new Error('accounts.json is empty');
  }

  await fs.mkdir(outputDir, { recursive: true });

  console.log('[INFO] launching browser for savings scrape...');
  console.log(`[INFO] PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? '(unset)'}`);
  console.log(`[INFO] cwd=${process.cwd()}`);
  console.log(`[INFO] headless=${config.headless}`);
  console.log(`[INFO] accounts=${accounts.length}`);

  // Playwright 브라우저 실행 파일 존재 확인
  try {
    const execPath = chromium.executablePath();
    console.log(`[INFO] chromium executablePath=${execPath}`);
    try {
      await fs.access(execPath);
      console.log('[INFO] chromium executable exists');
    } catch {
      console.error(`[FATAL] chromium executable NOT found at: ${execPath}`);
      console.error('[FATAL] Playwright 브라우저가 설치되지 않았습니다. npx playwright install chromium 실행 필요');
      throw new Error(`Chromium not found: ${execPath}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Chromium not found')) throw e;
    console.warn('[WARN] could not check chromium path:', e);
  }

  let browser: Browser;
  try {
    browser = await chromium.launch({
      headless: config.headless,
      slowMo: config.slowMoMs ?? 0,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
    console.log('[INFO] browser launched successfully');
  } catch (launchError) {
    console.error('[FATAL] browser launch failed:', launchError);
    throw launchError;
  }

  const ACCOUNT_CONCURRENCY = 3;
  const limit = pLimit(ACCOUNT_CONCURRENCY);

  const results: SavingsRow[] = [];
  try {
    const settled = await Promise.allSettled(
      accounts.map((account) =>
        limit(() => scrapeAccountSavingsWithRetry(browser, account, config)),
      ),
    );
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        results.push(r.value);
      } else {
        console.error('[ERROR] unexpected rejected settlement:', r.reason);
      }
    }
  } finally {
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 15_000);
        t.unref();
      }),
    ]);
  }

  const now = new Date().toISOString().replaceAll(':', '-');
  const jsonPath = path.join(outputDir, `savings-${now}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(results, null, 2), 'utf-8');

  const ok = results.filter((r) => !r.error).length;
  console.log(`[DONE] savings json: ${jsonPath}`);
  console.log(`[DONE] success=${ok}/${accounts.length}`);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
