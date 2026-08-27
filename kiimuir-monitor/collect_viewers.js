// kiimuir-monitor/collect_viewers_optimized.js (최적화 버전)
// 키뮤어(Kiimuir) 브랜드 상품 실시간 관심고객수 모니터링
// 개선사항: 병렬 처리, 무한 스크롤 대응, 대기시간 최적화

const { chromium } = require('playwright');
const { google } = require('googleapis');

const LISTING_URL = 'https://www.musinsa.com/brand/kiimuir/products?gf=A';
const SPREADSHEET_ID = process.env.KIIMUIR_SPREADSHEET_ID;
const SHEET_GID = process.env.KIIMUIR_SHEET_GID || '2056737982';
const VIEWER_THRESHOLD = 50;
const MAX_MORE_CLICKS = 30;
const BUTTON_RETRY = 6;

const PARALLEL_BATCH_SIZE = 6;
const SCROLL_WAIT_TIME = 1000;
const PAGE_LOAD_TIMEOUT = 8000;

function productUrl(code) {
  return `https://www.musinsa.com/products/${code}`;
}

const GOODS_ROW_SELECTOR = 'div[class*="ExpansibleGoodsTabRow__CustomGoodsRow"]';
const PRODUCT_SELECTOR = `${GOODS_ROW_SELECTOR} a[href*="/products/"]`;
const MORE_BUTTON_SELECTOR = 'button[data-button-id="more"]';

async function collectVisibleProducts(page, products) {
  try {
    const items = await page.$$eval(PRODUCT_SELECTOR, (links) => {
      return links.map((a) => {
        const href = a.getAttribute('href') || '';
        const match = href.match(/\/products\/(\d+)/);
        if (!match) return null;
        const img = a.querySelector('img');
        const name = img ? img.getAttribute('alt') : null;
        return { code: match[1], name: name || '' };
      }).filter(Boolean);
    });

    items.forEach((item) => {
      if (item.code && !products.has(item.code)) {
        products.set(item.code, item.name);
      }
    });
  } catch (e) {
    console.log(`   [안내] collectVisibleProducts: ${e.message}`);
  }
}

async function countProductLinks(page) {
  try {
    return await page.$$eval(PRODUCT_SELECTOR, (links) => links.length);
  } catch {
    return 0;
  }
}

async function findMoreButton(page) {
  try {
    const btn = await page.$(MORE_BUTTON_SELECTOR);
    if (!btn) return null;
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) return null;
    const text = ((await btn.innerText().catch(() => '')) || '').trim();
    const m = text.match(/(\d+)\s*\/\s*(\d+)/);
    return {
      handle: btn,
      text,
      loaded: m ? parseInt(m[1], 10) : null,
      total: m ? parseInt(m[2], 10) : null,
    };
  } catch {
    return null;
  }
}

async function waitForMoreButton(page) {
  for (let attempt = 1; attempt <= BUTTON_RETRY; attempt++) {
    const info = await findMoreButton(page);
    if (info) return info;
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(500);
  }
  return null;
}

async function revealLazyProducts(page, products, total) {
  let stale = 0;
  for (let step = 1; step <= 60; step++) {
    const before = products.size;
    await page.evaluate((sel) => {
      const links = document.querySelectorAll(sel);
      const last = links[links.length - 1];
      if (last) last.scrollIntoView({ block: 'end' });
      window.scrollBy(0, 400);
    }, PRODUCT_SELECTOR);

    await page.waitForTimeout(SCROLL_WAIT_TIME);
    await collectVisibleProducts(page, products);

    if (products.size !== before) {
      stale = 0;
      console.log(`   -> 스크롤 ${step}회 -> 현재까지 ${products.size}개${total ? ` / 전체 ${total}개` : ''}`);
    } else {
      stale++;
    }

    if (total && products.size >= total) break;
    if (stale >= 4) break;
  }
}

async function dumpDiagnostics(page, products, total) {
  const info = await page.evaluate((rowSel) => {
    const allLinks = document.querySelectorAll('a[href*="/products/"]').length;
    const inRow = document.querySelectorAll(`${rowSel} a[href*="/products/"]`).length;
    const rows = document.querySelectorAll(rowSel).length;
    return { allLinks, inRow, rows, scrollHeight: document.body.scrollHeight };
  }, GOODS_ROW_SELECTOR);
  console.log(`   [진단] 페이지 상품 ${info.allLinks}개 / 컨테이너 ${info.inRow}개`);
  try {
    await page.screenshot({ path: 'debug_listing.png', fullPage: true });
    console.log('   [진단] 스크린샷: debug_listing.png');
  } catch (e) {
    console.log(`   [진단] 스크린샷 실패`);
  }
}

async function getProductList(page) {
  console.log('[1/3] 상품 목록 수집 중...');
  await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  try {
    await page.waitForSelector(PRODUCT_SELECTOR, { timeout: 15000 });
  } catch (e) {
    console.log('   [경고] 15초 내 상품을 못 찾았습니다.');
  }

  const products = new Map();
  await collectVisibleProducts(page, products);
  console.log(`   -> 처음 로드된 ${products.size}개`);

  let total = null;
  let staleRounds = 0;

  const hasMoreButton = await page.$(MORE_BUTTON_SELECTOR).catch(() => null);

  if (hasMoreButton) {
    console.log('   -> "더보기" 버튼 감지, 클릭 시작');
    for (let round = 1; round <= MAX_MORE_CLICKS; round++) {
      const info = await waitForMoreButton(page);
      if (!info) {
        console.log('   -> "더보기" 버튼 없음, 펼치기 완료');
        break;
      }

      if (info.total) total = info.total;
      if (total && products.size >= total) {
        console.log(`   -> 전체 ${total}개 모두 수집됨`);
        break;
      }

      const sizeBefore = products.size;
      try {
        await info.handle.scrollIntoViewIfNeeded();
        await info.handle.click();
      } catch (e) {
        console.log(`   [경고] 더보기 클릭 실패`);
        break;
      }

      try {
        const domBefore =
