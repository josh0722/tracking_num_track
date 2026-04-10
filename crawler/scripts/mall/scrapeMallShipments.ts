import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import pLimit from 'p-limit';

import { login, unique, type Account } from './mallLogin.js';

// 안전망: Playwright 내부 등에서 발생할 수 있는 미처리 rejection이 프로세스를 크래시하지 않도록 방지
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] unhandled rejection (suppressed):', reason);
});

type TabKey = 'productReady' | 'shippingReady' | 'inTransit' | 'delivered';

type Config = {
  maxPagesPerTab: number;
  timeoutMs: number;
  headless: boolean;
  slowMoMs: number;
  debug?: {
    enabled?: boolean;
    verbose?: boolean;
    saveArtifactsOnError?: boolean;
    saveArtifactsOnTrackingMiss?: boolean;
    outputSubdir?: string;
  };
  dateRange?: {
    enabled: boolean;
    lookbackDays: number;
  };
  urls: {
    login: string;
    orderStatus: string;
    cancelStatus: string;
    orderTabs?: Partial<Record<TabKey, string>>;
  };
  selectors: {
    login: {
      tLoginButton: string;
      idInput: string;
      passwordInput: string;
      submitButton: string;
      postLoginReady: string;
    };
    orderStatus: {
      tabButtons: Record<TabKey, string>;
      list: {
        row: string;
        emptyHint?: string;
      };
      fields: {
        orderNumber?: string;
        productName?: string;
        statusText?: string;
      };
      trackingNumberCandidates: string[];
      shippingLayer?: {
        openButtonInRowSelector?: string;
        modalRootSelector?: string;
        trackingNumberCandidates?: string[];
        closeButtonSelector?: string;
        waitTimeoutMs?: number;
      };
    };
    cancelStatus: {
      list: {
        row: string;
        emptyHint?: string;
      };
      fields: {
        orderNumber?: string;
        productName?: string;
        statusText?: string;
      };
    };
    pagination: {
      pageButtonTemplate: string;
      activePage?: string;
    };
  };
};

type DebugRuntime = {
  enabled: boolean;
  verbose: boolean;
  saveArtifactsOnError: boolean;
  saveArtifactsOnTrackingMiss: boolean;
  dir: string;
};

type ScrapedItem = {
  scrapedAt: string;
  accountId: string;
  accountUsername: string;
  section: 'order_status' | 'cancel_status';
  tab: string;
  page: number;
  orderNumber: string;
  productName: string;
  rawStatus: string;
  logisticsCompany: string;
  displayValue: string;
  trackingNumbers: string[];
  trackingCount: number;
  note: string;
};

type TargetOrderFilter = {
  enabled: boolean;
  byAccountUsername: Map<string, Set<string>>;
};

type AbortFlag = { cancelled: boolean };

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

function sanitizeFileToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}

async function captureDebugSnapshot(params: {
  debug: DebugRuntime;
  page: Page;
  prefix: string;
  note?: string;
  row?: Locator;
}): Promise<void> {
  const { debug, page, prefix, note, row } = params;
  if (!debug.enabled) {
    return;
  }

  const stamp = new Date().toISOString().replaceAll(':', '-');
  const safePrefix = sanitizeFileToken(prefix);
  const pngPath = path.join(debug.dir, `${stamp}-${safePrefix}.png`);
  const htmlPath = path.join(debug.dir, `${stamp}-${safePrefix}.html`);
  const txtPath = path.join(debug.dir, `${stamp}-${safePrefix}.txt`);
  const rowHtmlPath = path.join(debug.dir, `${stamp}-${safePrefix}.row.html`);

  try {
    await page.screenshot({ path: pngPath, fullPage: true });
  } catch {
    // best effort
  }

  try {
    const html = await page.content();
    await fs.writeFile(htmlPath, html, 'utf8');
  } catch {
    // best effort
  }

  try {
    const lines = [`url=${page.url()}`];
    if (note) {
      lines.push(`note=${note}`);
    }
    await fs.writeFile(txtPath, lines.join('\n'), 'utf8');
  } catch {
    // best effort
  }

  if (row) {
    try {
      await row.screenshot({ path: path.join(debug.dir, `${stamp}-${safePrefix}.row.png`) });
    } catch {
      // best effort
    }
    try {
      const rowHtml = await row.innerHTML();
      await fs.writeFile(rowHtmlPath, rowHtml, 'utf8');
    } catch {
      // best effort
    }
  }
}

function debugLog(debug: DebugRuntime, message: string): void {
  if (!debug.enabled) {
    return;
  }
  console.log(`[DEBUG] ${message}`);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
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

function normalizeOrderNoLike(value: string): string {
  const trimmed = value.trim();
  return (trimmed.match(/\d+/g) ?? []).join('') || trimmed;
}

function loadTargetOrderFilter(): TargetOrderFilter {
  const raw = process.env.MALL_TARGET_ORDERS_JSON?.trim() ?? '';
  if (!raw) {
    return { enabled: false, byAccountUsername: new Map() };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const byAccountUsername = new Map<string, Set<string>>();
    for (const [username, orders] of Object.entries(parsed)) {
      const normUsername = username.trim();
      if (!normUsername || !Array.isArray(orders)) {
        continue;
      }
      const set = new Set(
        orders
          .map((v) => normalizeOrderNoLike(String(v ?? '')))
          .filter((v) => Boolean(v)),
      );
      if (set.size > 0) {
        byAccountUsername.set(normUsername, set);
      }
    }

    if (byAccountUsername.size === 0) {
      return { enabled: false, byAccountUsername: new Map() };
    }

    return { enabled: true, byAccountUsername };
  } catch {
    return { enabled: false, byAccountUsername: new Map() };
  }
}

function toCsvCell(value: string): string {
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"`;
}

async function safeText(locator: Locator): Promise<string> {
  try {
    const text = await locator.first().innerText({ timeout: 1_500 });
    return text.replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

async function maybeClick(page: Page, selector: string): Promise<boolean> {
  const node = page.locator(selector).first();
  if ((await node.count()) === 0) {
    return false;
  }
  await node.click({ timeout: 5_000 });
  return true;
}

function extractNumericTrackingCandidates(text: string): string[] {
  const allMatches = text.match(/\b\d{8,20}\b/g) ?? [];
  return unique(
    allMatches.filter((v) => {
      // 8자리 YYYYMMDD 날짜 패턴 제외 (예: 19900101, 20260313)
      if (/^(19|20)\d{6}$/.test(v)) return false;
      // 14자리 주문번호 패턴 제외 (예: 20260313830641)
      if (/^20\d{12}$/.test(v)) return false;
      return true;
    }),
  );
}

function extractOrderNumberCandidates(text: string): string[] {
  // SK스토아 주문번호 예시: 20260313829655
  const allMatches = text.match(/\b20\d{12}\b/g) ?? [];
  return unique(allMatches);
}

function normalizeLogisticsName(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/※.*$/g, '')
    .trim();
}

type LayerTrackingResult = {
  trackingNumbers: string[];
  logisticsCompany: string;
};

async function collectTrackingNumbersFromRow(row: Locator, candidateSelectors: string[]): Promise<string[]> {
  const collected: string[] = [];

  for (const selector of candidateSelectors) {
    const nodes = row.locator(selector);
    const count = await nodes.count();
    for (let i = 0; i < count; i += 1) {
      const txt = (await nodes.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (txt) {
        collected.push(txt);
      }
      const invoiceAttr = (await nodes.nth(i).getAttribute('data-invoice-no').catch(() => '')) ?? '';
      if (invoiceAttr.trim()) {
        collected.push(invoiceAttr.trim());
      }
    }
  }

  const fromCandidates = unique(
    collected
      .flatMap((txt) => extractNumericTrackingCandidates(txt))
      .map((txt) => txt.trim())
      .filter(Boolean),
  );

  return unique(fromCandidates);
}

// API 직접 호출로 배송 추적 정보를 가져옴 (팝업 DOM 방식 대신 ~200ms)
async function tryFetchDeliveryApi(params: {
  context: BrowserContext;
  onclickAttr: string;
  baseUrl: string;
}): Promise<LayerTrackingResult> {
  const { context, onclickAttr, baseUrl } = params;
  const traceMatch = onclickAttr.match(
    /deliveryTrace\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/,
  );
  if (!traceMatch) return { trackingNumbers: [], logisticsCompany: '' };

  const [, orderNo, orderGSeq, orderDSeq, orderWSeq] = traceMatch;
  try {
    const response = await context.request.post(`${baseUrl}/mypage/delivery/trace`, {
      form: { orderNo, orderGSeq, orderDSeq, orderWSeq },
    });
    if (!response.ok()) return { trackingNumbers: [], logisticsCompany: '' };

    const html = await response.text();
    const trackingNumbers = extractNumericTrackingCandidates(html);

    let logisticsCompany = '';
    const codeMatch = html.match(/id="current-logistics-code"[^>]*>([^<]*)</);
    if (codeMatch?.[1]?.trim()) logisticsCompany = normalizeLogisticsName(codeMatch[1]);
    if (!logisticsCompany) {
      const nameMatch = html.match(/id="current-logistics-name"[^>]*>([^<]*)</);
      if (nameMatch?.[1]?.trim()) logisticsCompany = normalizeLogisticsName(nameMatch[1]);
    }
    if (!logisticsCompany) {
      const attrMatch = html.match(/data-logistics-name="([^"]+)"/);
      if (attrMatch?.[1]?.trim()) logisticsCompany = normalizeLogisticsName(attrMatch[1]);
    }

    return { trackingNumbers, logisticsCompany };
  } catch {
    return { trackingNumbers: [], logisticsCompany: '' };
  }
}

// 로그인 페이지를 제외한 탭 페이지에서 이미지/CSS/폰트 요청 차단
async function setupPageResourceBlocking(
  page: Page,
  opts?: { skipBlocking?: boolean },
): Promise<void> {
  if (opts?.skipBlocking) return;
  await page.route(/\.(png|jpg|jpeg|gif|svg|css|woff|woff2|ttf|ico)(\?.*)?$/i, (route) =>
    route.abort(),
  );
}

async function collectTrackingNumbersFromLayer(params: {
  page: Page;
  row: Locator;
  config: Config;
  context?: BrowserContext;
  debug?: DebugRuntime;
  debugPrefix?: string;
}): Promise<LayerTrackingResult> {
  const { page, row, config, context, debug, debugPrefix } = params;
  const layer = config.selectors.orderStatus.shippingLayer;
  if (!layer) {
    return { trackingNumbers: [], logisticsCompany: '' };
  }

  const openSelector =
    layer.openButtonInRowSelector ??
    [
      'a[title="배송현황조회"]',
      'button.js_open_pop10[onclick*="deliveryTrace("]',
      'button:has-text("배송조회")',
      'a:has-text("배송조회")',
    ].join(', ');
  const modalRootSelector =
    layer.modalRootSelector ??
    '.ui-dialog:has-text("배송조회"), .modal:has-text("배송조회"), .layer:has-text("배송조회")';
  const closeSelector = layer.closeButtonSelector ?? 'button:has-text("닫기"), button[aria-label*="닫기"]';
  const waitTimeout = layer.waitTimeoutMs ?? 5000;
  const layerTrackingCandidates = layer.trackingNumberCandidates ?? [];

  const openBtn = row.locator(openSelector).first();
  if ((await openBtn.count()) === 0) {
    return { trackingNumbers: [], logisticsCompany: '' };
  }

  // 버튼 속성을 클릭 전에 읽어 API 직접 호출 시도 (1차 시도)
  const openHref = ((await openBtn.getAttribute('href').catch(() => '')) ?? '').trim();
  const openOnclick = ((await openBtn.getAttribute('onclick').catch(() => '')) ?? '').trim();
  const traceSource = [openHref, openOnclick].find((value) => value.includes('deliveryTrace(')) ?? '';
  const traceMatch = traceSource.match(
    /deliveryTrace\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/,
  );

  if (traceSource && context) {
    const apiResult = await tryFetchDeliveryApi({
      context,
      onclickAttr: traceSource,
      baseUrl: 'https://www.skstoa.com',
    });
    if (apiResult.trackingNumbers.length > 0 || apiResult.logisticsCompany) {
      return apiResult;
    }
  }

  // 2차 시도: 기존 버튼 클릭 → 모달 DOM 방식 (fallback)
  await openBtn.click({ timeout: waitTimeout });
  await page.waitForTimeout(250);

  // SK스토아는 onclick 핸들러/비동기 로딩 타이밍 이슈로 클릭이 누락되는 경우가 있음.
  // onclick의 deliveryTrace(...)를 직접 파싱해서 함수 호출 fallback 수행.
  if (traceMatch) {
    const hasVisiblePopup = await page
      .locator('.js_pop10:has-text("배송조회"), .js_pop10 .popupContent')
      .first()
      .isVisible()
      .catch(() => false);
    if (!hasVisiblePopup) {
      const [, orderNo, orderGSeq, orderDSeq, orderWSeq] = traceMatch;
      await page
        .evaluate(
          ({ orderNo: o, orderGSeq: g, orderDSeq: d, orderWSeq: w }) => {
            const fn = (window as unknown as { deliveryTrace?: (...args: string[]) => void }).deliveryTrace;
            if (typeof fn === 'function') {
              fn(o, g, d, w);
            }
          },
          { orderNo, orderGSeq, orderDSeq, orderWSeq },
        )
        .catch(() => undefined);
      await page.waitForTimeout(350);
    }
  }

  // Some SK스토아 pages render layer root with dynamic class names.
  // Fallback: wait for invoice buttons globally even if modal root selector misses.
  const modal = page.locator(modalRootSelector).first();
  const skModal = page.locator('.js_pop10:has-text("배송조회"), .js_pop10 .popupContent').first();
  const globalInvoice = page.locator('button[data-invoice-no], [data-invoice-no]').first();
  const modalVisible = await modal
    .waitFor({ state: 'visible', timeout: waitTimeout })
    .then(() => true)
    .catch(() => false);
  const skModalVisible = await skModal
    .waitFor({ state: 'visible', timeout: Math.max(1500, Math.floor(waitTimeout / 2)) })
    .then(() => true)
    .catch(() => false);
  if (!modalVisible && !skModalVisible) {
    const invoiceAppeared = await globalInvoice
      .waitFor({ state: 'visible', timeout: Math.max(2000, Math.floor(waitTimeout / 2)) })
      .then(() => true)
      .catch(() => false);
    if (!invoiceAppeared) {
      if (debug && debug.saveArtifactsOnTrackingMiss) {
        await captureDebugSnapshot({
          debug,
          page,
          row,
          prefix: `${debugPrefix ?? 'layer-open'}-modal-not-found`,
          note: `modal selector timeout: ${modalRootSelector}`,
        });
      }
      return { trackingNumbers: [], logisticsCompany: '' };
    }
  }

  const collected: string[] = [];
  const useBodyRoot = !modalVisible && !skModalVisible;
  const activeModalRoot = modalVisible ? modal : skModalVisible ? skModal : page.locator('body');
  const searchRoots = useBodyRoot ? [page.locator('body')] : [activeModalRoot, page.locator('body')];
  const logisticsNamePrimary = normalizeLogisticsName(await safeText(activeModalRoot.locator('#current-logistics-code')));
  const logisticsNameFallback = normalizeLogisticsName(await safeText(activeModalRoot.locator('#current-logistics-name')));
  let logisticsCompany = logisticsNamePrimary || logisticsNameFallback;

  if (!logisticsCompany) {
    const logisticsAttrNode = activeModalRoot.locator('[data-logistics-name]').first();
    const logisticsAttr = ((await logisticsAttrNode.getAttribute('data-logistics-name').catch(() => '')) ?? '').trim();
    if (logisticsAttr) {
      logisticsCompany = normalizeLogisticsName(logisticsAttr);
    }
  }

  const logisticsPanelText = normalizeLogisticsName(await safeText(activeModalRoot.locator('#current-logistics-name')));
  if (logisticsPanelText) {
    collected.push(logisticsPanelText);
  }
  for (const selector of layerTrackingCandidates) {
    for (const root of searchRoots) {
      const nodes = root.locator(selector);
      const count = await nodes.count();
      for (let i = 0; i < count; i += 1) {
        const txt = (await nodes.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (txt) {
          collected.push(txt);
        }
      }
    }
  }

  // Always include data-invoice-no values directly for robustness.
  for (const root of searchRoots) {
    const nodes = root.locator('[data-invoice-no]');
    const count = await nodes.count();
    for (let i = 0; i < count; i += 1) {
      const attr = (await nodes.nth(i).getAttribute('data-invoice-no').catch(() => '')) ?? '';
      const txt = (await nodes.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (attr.trim()) {
        collected.push(attr.trim());
      }
      if (txt) {
        collected.push(txt);
      }
    }
  }

  const explicitInvoiceButtons = activeModalRoot.locator(
    '.numberList__tab[data-goodstab] button[data-invoice-no], .numberList__tab button[data-invoice-no]',
  );
  const explicitCount = await explicitInvoiceButtons.count();
  for (let i = 0; i < explicitCount; i += 1) {
    const attr = (await explicitInvoiceButtons.nth(i).getAttribute('data-invoice-no').catch(() => '')) ?? '';
    if (attr.trim()) {
      collected.push(attr.trim());
    }
    const txt = (await explicitInvoiceButtons.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (txt) {
      collected.push(txt);
    }
  }

  // Single-waybill fallback: track-container id can include invoice number even without tab buttons.
  const trackingContainers = activeModalRoot.locator('[id^="tracking-"]');
  const trackingContainerCount = await trackingContainers.count();
  for (let i = 0; i < trackingContainerCount; i += 1) {
    const idAttr = (await trackingContainers.nth(i).getAttribute('id').catch(() => '')) ?? '';
    const idMatches = idAttr.match(/\btracking-(\d{8,20})\b/);
    if (idMatches?.[1]) {
      collected.push(idMatches[1]);
    }
  }

  const fromCollected = unique(collected.flatMap((txt) => extractNumericTrackingCandidates(txt)));
  const tracking = unique(fromCollected);

  const closeBtn = activeModalRoot.locator(closeSelector).first();
  if ((await closeBtn.count()) > 0) {
    const clicked = await closeBtn
      .click({ timeout: waitTimeout })
      .then(() => true)
      .catch(() => false);
    if (!clicked) {
      const clickableParent = closeBtn.locator('xpath=ancestor::*[self::button or self::a][1]').first();
      if ((await clickableParent.count()) > 0) {
        await clickableParent.click({ timeout: waitTimeout }).catch(() => undefined);
      }
    }
  } else {
    await page.keyboard.press('Escape').catch(() => undefined);
  }
  await page.waitForTimeout(150);

  return {
    trackingNumbers: tracking,
    logisticsCompany,
  };
}

async function gotoPageNumber(
  page: Page,
  pageNumber: number,
  config: Config,
  rowSelector?: string,
): Promise<boolean> {
  if (pageNumber === 1) {
    return true;
  }

  const pageText = String(pageNumber);
  const selector = config.selectors.pagination.pageButtonTemplate.replaceAll('{page}', pageText);

  let clicked = false;
  const aNode = page.locator(`a:has-text("${pageText}")`).first();
  if ((await aNode.count()) > 0) {
    clicked = await aNode.click({ timeout: 5_000 }).then(() => true).catch(() => false);
  }
  if (!clicked) {
    const genericNode = page.locator(selector).first();
    if ((await genericNode.count()) > 0) {
      clicked = await genericNode.click({ timeout: 5_000 }).then(() => true).catch(() => false);
    }
  }
  if (!clicked) {
    // SK스토아 페이지네이션 JS fallback
    clicked = await page
      .evaluate((nextPage) => {
        const w = window as unknown as {
          setOrderListPage?: (p: number) => void;
          setCounselPage?: (p: number) => void;
        };
        if (typeof w.setOrderListPage === 'function') {
          w.setOrderListPage(nextPage);
          return true;
        }
        if (typeof w.setCounselPage === 'function') {
          w.setCounselPage(nextPage);
          return true;
        }
        return false;
      }, pageNumber)
      .catch(() => false);
  }
  if (!clicked) {
    return false;
  }

  if (rowSelector) {
    await page.waitForSelector(rowSelector, { timeout: 3000 }).catch(() => {});
  } else {
    await page.waitForTimeout(700);
  }

  if (!config.selectors.pagination.activePage) {
    return true;
  }

  const activeText = await safeText(page.locator(config.selectors.pagination.activePage));
  return activeText.includes(String(pageNumber));
}

async function readOrderTabRows(params: {
  page: Page;
  accountId: string;
  accountUsername: string;
  tabKey: TabKey;
  tabSelector?: string;
  config: Config;
  scrapedAt: string;
  debug: DebugRuntime;
  targetOrders?: Set<string>;
  foundTargetOrders?: Set<string>;
  abortFlag?: AbortFlag;
  context?: BrowserContext;
}): Promise<ScrapedItem[]> {
  const {
    page,
    accountId,
    accountUsername,
    tabKey,
    tabSelector,
    config,
    scrapedAt,
    debug,
    targetOrders,
    foundTargetOrders,
    abortFlag,
    context,
  } = params;

  if (tabSelector) {
    const clicked = await maybeClick(page, tabSelector);
    if (!clicked) {
      debugLog(debug, `account=${accountId} tab=${tabKey} selector not found: ${tabSelector}`);
      return [];
    }
    await page.waitForTimeout(600);
  }

  const items: ScrapedItem[] = [];

  for (let currentPage = 1; currentPage <= config.maxPagesPerTab; currentPage += 1) {
    if (abortFlag?.cancelled) break;

    if (debug.verbose) {
      debugLog(debug, `account=${accountId} tab=${tabKey} moving page=${currentPage}`);
    }
    const moved = await gotoPageNumber(page, currentPage, config, config.selectors.orderStatus.list.row);
    if (!moved) {
      debugLog(debug, `account=${accountId} tab=${tabKey} page=${currentPage} move failed`);
      break;
    }

    const rows = page.locator(config.selectors.orderStatus.list.row);
    const rowCount = await rows.count();

    if (rowCount === 0) {
      if (config.selectors.orderStatus.list.emptyHint) {
        const emptyFound = (await page.locator(config.selectors.orderStatus.list.emptyHint).count()) > 0;
        if (emptyFound) {
          break;
        }
      }
      continue;
    }

    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i);
      const orderNumber = config.selectors.orderStatus.fields.orderNumber
        ? await safeText(row.locator(config.selectors.orderStatus.fields.orderNumber))
        : '';
      const rowHtml = await row.innerHTML().catch(() => '');
      const orderNumberFromRow = extractOrderNumberCandidates(
        `${orderNumber} ${rowHtml} ${(await row.innerText().catch(() => ''))}`.replace(/\s+/g, ' '),
      );
      const normalizedOrderNo = normalizeOrderNoLike(orderNumber || orderNumberFromRow[0] || '');
      if (targetOrders && targetOrders.size > 0) {
        if (!normalizedOrderNo || !targetOrders.has(normalizedOrderNo)) {
          continue;
        }
      }

      const productName = config.selectors.orderStatus.fields.productName
        ? await safeText(row.locator(config.selectors.orderStatus.fields.productName))
        : '';
      const rawStatus = config.selectors.orderStatus.fields.statusText
        ? await safeText(row.locator(config.selectors.orderStatus.fields.statusText))
        : '';
      const logisticsFromRowAttr = ((await row.locator('[data-logistics-name]').first().getAttribute('data-logistics-name').catch(() => '')) ?? '').trim();
      let logisticsCompany = normalizeLogisticsName(logisticsFromRowAttr);

      const trackingNumbers =
        tabKey === 'productReady'
          ? []
          : await collectTrackingNumbersFromRow(row, config.selectors.orderStatus.trackingNumberCandidates);

      const layerResult =
        tabKey === 'productReady'
          ? { trackingNumbers: [], logisticsCompany: '' }
          : await collectTrackingNumbersFromLayer({
              page,
              row,
              config,
              context,
              debug,
              debugPrefix: `${accountId}-${tabKey}-p${currentPage}-r${i + 1}`,
            });

      const finalTrackingNumbers = unique([...trackingNumbers, ...layerResult.trackingNumbers]);
      if (!logisticsCompany) {
        logisticsCompany = layerResult.logisticsCompany;
      }

      const displayValue =
        tabKey === 'productReady'
          ? '상품 준비'
          : finalTrackingNumbers.length > 0
            ? finalTrackingNumbers.join(' | ')
            : '송장확인필요';

      const note =
        tabKey === 'productReady'
          ? '상품준비 탭'
          : finalTrackingNumbers.length > 1
            ? '복수 송장 감지'
            : finalTrackingNumbers.length === 1
              ? '단일 송장'
              : '송장 미검출';

      if (tabKey !== 'productReady' && finalTrackingNumbers.length === 0) {
        debugLog(
          debug,
          `tracking-miss account=${accountId} tab=${tabKey} page=${currentPage} row=${i + 1} product=${productName || '-'}`,
        );
        if (debug.saveArtifactsOnTrackingMiss) {
          await captureDebugSnapshot({
            debug,
            page,
            row,
            prefix: `${accountId}-${tabKey}-p${currentPage}-r${i + 1}-tracking-miss`,
            note: `tracking number not found, rawStatus=${rawStatus}`,
          });
        }
      }

      items.push({
        scrapedAt,
        accountId,
        accountUsername,
        section: 'order_status',
        tab: tabKey,
        page: currentPage,
        orderNumber: orderNumber || orderNumberFromRow[0] || '',
        productName,
        rawStatus,
        logisticsCompany,
        displayValue,
        trackingNumbers: finalTrackingNumbers,
        trackingCount: finalTrackingNumbers.length,
        note,
      });

      if (foundTargetOrders && normalizedOrderNo) {
        foundTargetOrders.add(normalizedOrderNo);
      }
    }

    if (targetOrders && foundTargetOrders && targetOrders.size > 0 && foundTargetOrders.size >= targetOrders.size) {
      if (debug.verbose) {
        debugLog(debug, `account=${accountId} tab=${tabKey} target orders satisfied`);
      }
      if (abortFlag) abortFlag.cancelled = true;
      break;
    }
  }

  return items;
}

async function readCancelRows(params: {
  page: Page;
  accountId: string;
  accountUsername: string;
  config: Config;
  scrapedAt: string;
  cancelStatusUrl: string;
  debug: DebugRuntime;
  targetOrders?: Set<string>;
  foundTargetOrders?: Set<string>;
}): Promise<ScrapedItem[]> {
  const { page, accountId, accountUsername, config, scrapedAt, cancelStatusUrl, debug, targetOrders, foundTargetOrders } = params;
  const items: ScrapedItem[] = [];

  await page.goto(cancelStatusUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
  await page.waitForSelector(config.selectors.cancelStatus.list.row, { timeout: 3000 }).catch(() => {});

  for (let currentPage = 1; currentPage <= config.maxPagesPerTab; currentPage += 1) {
    if (debug.verbose) {
      debugLog(debug, `account=${accountId} cancel page=${currentPage} moving`);
    }
    const moved = await gotoPageNumber(page, currentPage, config, config.selectors.cancelStatus.list.row);
    if (!moved) {
      debugLog(debug, `account=${accountId} cancel page=${currentPage} move failed`);
      break;
    }

    const rows = page.locator(config.selectors.cancelStatus.list.row);
    const rowCount = await rows.count();

    if (rowCount === 0) {
      if (config.selectors.cancelStatus.list.emptyHint) {
        const emptyFound = (await page.locator(config.selectors.cancelStatus.list.emptyHint).count()) > 0;
        if (emptyFound) {
          break;
        }
      }
      continue;
    }

    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i);
      const orderNumber = config.selectors.cancelStatus.fields.orderNumber
        ? await safeText(row.locator(config.selectors.cancelStatus.fields.orderNumber))
        : '';
      const rowHtml = await row.innerHTML().catch(() => '');
      const orderNumberFromRow = extractOrderNumberCandidates(
        `${orderNumber} ${rowHtml} ${(await row.innerText().catch(() => ''))}`.replace(/\s+/g, ' '),
      );
      const normalizedOrderNo = normalizeOrderNoLike(orderNumber || orderNumberFromRow[0] || '');
      if (targetOrders && targetOrders.size > 0) {
        if (!normalizedOrderNo || !targetOrders.has(normalizedOrderNo)) {
          continue;
        }
      }
      const productName = config.selectors.cancelStatus.fields.productName
        ? await safeText(row.locator(config.selectors.cancelStatus.fields.productName))
        : '';
      const rawStatus = config.selectors.cancelStatus.fields.statusText
        ? await safeText(row.locator(config.selectors.cancelStatus.fields.statusText))
        : '';

      const rowText = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      const isCanceled = /취소|반품|교환|환불|cancell?ed|refund|return|exchange/i.test(`${rawStatus} ${rowText}`);
      if (!isCanceled) {
        continue;
      }

      items.push({
        scrapedAt,
        accountId,
        accountUsername,
        section: 'cancel_status',
        tab: 'cancel',
        page: currentPage,
        orderNumber: orderNumber || orderNumberFromRow[0] || '',
        productName,
        rawStatus,
        logisticsCompany: '',
        displayValue: '취소',
        trackingNumbers: [],
        trackingCount: 0,
        note: '취소/교환/반품현황에서 취소 건 수집',
      });

      if (foundTargetOrders && normalizedOrderNo) {
        foundTargetOrders.add(normalizedOrderNo);
      }
    }

    if (targetOrders && foundTargetOrders && targetOrders.size > 0 && foundTargetOrders.size >= targetOrders.size) {
      if (debug.verbose) {
        debugLog(debug, `account=${accountId} cancel target orders satisfied`);
      }
      break;
    }
  }

  return items;
}

function formatYyyymmdd(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function withDynamicDateRange(rawUrl: string, config: Config): string {
  if (!config.dateRange?.enabled) {
    return rawUrl;
  }

  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - Math.max(0, config.dateRange.lookbackDays));

  const parsed = new URL(rawUrl);
  parsed.searchParams.set('fromDate', formatYyyymmdd(from));
  parsed.searchParams.set('toDate', formatYyyymmdd(today));
  return parsed.toString();
}

function toCsv(rows: ScrapedItem[]): string {
  const header = [
    'scrapedAt',
    'accountId',
    'accountUsername',
    'section',
    'tab',
    'page',
    'orderNumber',
    'productName',
    'rawStatus',
    'logisticsCompany',
    'displayValue',
    'trackingNumbers',
    'trackingCount',
    'note',
  ];

  const lines = rows.map((row) =>
    [
      row.scrapedAt,
      row.accountId,
      row.accountUsername,
      row.section,
      row.tab,
      String(row.page),
      row.orderNumber,
      row.productName,
      row.rawStatus,
      row.logisticsCompany,
      row.displayValue,
      row.trackingNumbers.join('|'),
      String(row.trackingCount),
      row.note,
    ]
      .map(toCsvCell)
      .join(','),
  );

  return [header.join(','), ...lines].join('\n');
}

// 단일 계정 전체 처리: 로그인 → 탭 4개 병렬 → 취소현황
async function scrapeAccount(params: {
  browser: Browser;
  account: Account;
  config: Config;
  debug: DebugRuntime;
  targetOrderFilter: TargetOrderFilter;
}): Promise<ScrapedItem[]> {
  const { browser, account, config, debug, targetOrderFilter } = params;
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
    // 로그인 (로그인 페이지는 리소스 차단 제외)
    const loginPage = await context.newPage();
    await setupPageResourceBlocking(loginPage, { skipBlocking: true });
    loginPage.setDefaultTimeout(config.timeoutMs);

    try {
      console.log(`[INFO] ${account.accountId} logging in (username=${account.username})...`);
      await login(loginPage, account, config);
      console.log(`[INFO] ${account.accountId} login success`);
    } catch (error) {
      console.error(`[ERROR] ${account.accountId} login failed:`, error instanceof Error ? error.message : String(error));
      if (debug.saveArtifactsOnError) {
        await captureDebugSnapshot({
          debug,
          page: loginPage,
          prefix: `${account.accountId}-login-fail`,
          note: error instanceof Error ? error.message : String(error),
        });
      }
      await loginPage.close().catch(() => undefined);
      throw error;
    }
    await loginPage.close();

    const targetOrders = targetOrderFilter.enabled
      ? targetOrderFilter.byAccountUsername.get(account.username.trim())
      : undefined;
    const foundTargetOrders = new Set<string>();
    const abortFlag: AbortFlag = { cancelled: false };

    const cancelStatusUrl = withDynamicDateRange(config.urls.cancelStatus, config);
    const orderStatusUrl = withDynamicDateRange(config.urls.orderStatus, config);
    const orderTabUrls = config.urls.orderTabs
      ? {
          productReady: config.urls.orderTabs.productReady
            ? withDynamicDateRange(config.urls.orderTabs.productReady, config)
            : undefined,
          shippingReady: config.urls.orderTabs.shippingReady
            ? withDynamicDateRange(config.urls.orderTabs.shippingReady, config)
            : undefined,
          inTransit: config.urls.orderTabs.inTransit
            ? withDynamicDateRange(config.urls.orderTabs.inTransit, config)
            : undefined,
          delivered: config.urls.orderTabs.delivered
            ? withDynamicDateRange(config.urls.orderTabs.delivered, config)
            : undefined,
        }
      : undefined;

    const tabEntries: Array<[TabKey, string]> = [
      ['productReady', config.selectors.orderStatus.tabButtons.productReady],
      ['shippingReady', config.selectors.orderStatus.tabButtons.shippingReady],
      ['inTransit', config.selectors.orderStatus.tabButtons.inTransit],
      ['delivered', config.selectors.orderStatus.tabButtons.delivered],
    ];

    // 탭 4개 병렬 처리
    const tabTasks = tabEntries.map(([tabKey, tabSelector]) =>
      (async () => {
        const tabPage = await context.newPage();
        try {
          await setupPageResourceBlocking(tabPage);
          tabPage.setDefaultTimeout(config.timeoutMs);

          if (abortFlag.cancelled) return [];

          const directUrl = orderTabUrls?.[tabKey];
          if (directUrl) {
            await tabPage.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
          } else {
            // 직접 URL 없는 경우 orderStatus 페이지로 이동 후 탭 클릭
            await tabPage.goto(orderStatusUrl, { waitUntil: 'domcontentloaded', timeout: config.timeoutMs });
          }

          return await readOrderTabRows({
            page: tabPage,
            accountId: account.accountId,
            accountUsername: account.username,
            tabKey,
            tabSelector: directUrl ? undefined : tabSelector,
            config,
            scrapedAt,
            debug,
            targetOrders,
            foundTargetOrders,
            abortFlag,
            context,
          });
        } finally {
          await tabPage.close().catch(() => undefined);
        }
      })(),
    );

    const tabResults = await Promise.allSettled(tabTasks);
    const tabRows: ScrapedItem[] = [];
    for (const result of tabResults) {
      if (result.status === 'fulfilled') {
        tabRows.push(...result.value);
      } else {
        debugLog(debug, `account=${account.accountId} tab task failed: ${result.reason}`);
      }
    }

    // 취소현황 (타겟 미만족 시)
    const cancelRows: ScrapedItem[] = [];
    if (!targetOrders || targetOrders.size === 0 || foundTargetOrders.size < targetOrders.size) {
      const cancelPage = await context.newPage();
      try {
        await setupPageResourceBlocking(cancelPage);
        cancelPage.setDefaultTimeout(config.timeoutMs);
        const rows = await readCancelRows({
          page: cancelPage,
          accountId: account.accountId,
          accountUsername: account.username,
          config,
          scrapedAt,
          cancelStatusUrl,
          debug,
          targetOrders,
          foundTargetOrders,
        });
        cancelRows.push(...rows);
      } finally {
        await cancelPage.close().catch(() => undefined);
      }
    } else if (debug.verbose) {
      debugLog(debug, `account=${account.accountId} cancel crawl skipped (targets already found)`);
    }

    return [...tabRows, ...cancelRows];
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

// 재시도 3회 래퍼
async function scrapeAccountWithRetry(
  browser: Browser,
  account: Account,
  config: Config,
  debug: DebugRuntime,
  targetOrderFilter: TargetOrderFilter,
): Promise<ScrapedItem[]> {
  const MAX_RETRIES = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) {
        debugLog(debug, `retry attempt=${attempt} account=${account.accountId}`);
      }
      debugLog(debug, `start account=${account.accountId}`);
      const scrapePromise = scrapeAccount({ browser, account, config, debug, targetOrderFilter });
      const timeoutPromise = new Promise<never>((_, reject) => {
        const t = setTimeout(() => reject(new Error('account timeout (180s)')), 180_000);
        t.unref();
      });
      // race 패자의 reject가 unhandled가 되지 않도록 양쪽 모두 catch 부착
      scrapePromise.catch(() => undefined);
      timeoutPromise.catch(() => undefined);
      const rows = await Promise.race([scrapePromise, timeoutPromise]);
      console.log(`[OK] ${account.accountId} - collected ${rows.length} rows`);
      return rows;
    } catch (error) {
      lastError = error;
      console.error(`[ERROR] ${account.accountId} attempt=${attempt} error:`, error instanceof Error ? error.message : String(error));
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
  return [];
}

async function main(): Promise<void> {
  await assertRequiredFiles();

  const config = await readJsonFile<Config>(configPath);
  const accounts = await readJsonFile<Account[]>(accountsPath);
  const targetOrderFilter = loadTargetOrderFilter();

  if (accounts.length === 0) {
    throw new Error('accounts.json is empty');
  }
  if (targetOrderFilter.enabled) {
    const cnt = [...targetOrderFilter.byAccountUsername.values()].reduce((sum, s) => sum + s.size, 0);
    console.log(`[INFO] target-order filter enabled: ${cnt} orders`);
  }

  await fs.mkdir(outputDir, { recursive: true });
  const runStamp = new Date().toISOString().replaceAll(':', '-');
  const debugDir = path.join(outputDir, config.debug?.outputSubdir ?? `debug-${runStamp}`);
  const debug: DebugRuntime = {
    enabled: config.debug?.enabled ?? true,
    verbose: config.debug?.verbose ?? true,
    saveArtifactsOnError: config.debug?.saveArtifactsOnError ?? true,
    saveArtifactsOnTrackingMiss: config.debug?.saveArtifactsOnTrackingMiss ?? true,
    dir: debugDir,
  };
  if (debug.enabled) {
    await fs.mkdir(debug.dir, { recursive: true });
  }

  console.log('[INFO] launching browser...');
  console.log(`[INFO] PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH ?? '(unset)'}`);
  console.log(`[INFO] cwd=${process.cwd()}`);
  console.log(`[INFO] headless=${config.headless}`);

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
      slowMo: config.slowMoMs,
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

  const allRows: ScrapedItem[] = [];

  const ACCOUNT_CONCURRENCY = 3;
  const limit = pLimit(ACCOUNT_CONCURRENCY);

  try {
    const accountResults = await Promise.allSettled(
      accounts.map((account) =>
        limit(() => scrapeAccountWithRetry(browser, account, config, debug, targetOrderFilter)),
      ),
    );

    for (const result of accountResults) {
      if (result.status === 'fulfilled') {
        allRows.push(...result.value);
      }
      // 에러는 scrapeAccountWithRetry 내에서 이미 로깅됨
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
  const jsonPath = path.join(outputDir, `results-${now}.json`);
  const csvPath = path.join(outputDir, `results-${now}.csv`);

  await fs.writeFile(jsonPath, JSON.stringify(allRows, null, 2), 'utf8');
  await fs.writeFile(csvPath, toCsv(allRows), 'utf8');

  console.log(`Saved JSON: ${jsonPath}`);
  console.log(`Saved CSV : ${csvPath}`);
  console.log(`Total rows: ${allRows.length}`);
  if (debug.enabled) {
    console.log(`Debug dir : ${debug.dir}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
