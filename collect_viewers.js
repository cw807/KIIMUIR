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
        const domBefore = await countProductLinks(page);
        await page.waitForFunction(
          ({ sel, before }) => document.querySelectorAll(sel).length > before,
          { sel: PRODUCT_SELECTOR, before: domBefore },
          { timeout: 8000 }
        );
      } catch (e) {}

      await page.waitForTimeout(300);
      await collectVisibleProducts(page, products);
      console.log(`   -> 더보기 ${round}회 -> ${products.size}개`);

      await revealLazyProducts(page, products, total);

      if (products.size === sizeBefore) {
        staleRounds++;
        if (staleRounds >= 3) {
          console.log('   [안내] 3회 연속 증가 없음, 중단');
          break;
        }
      } else {
        staleRounds = 0;
      }
    }
  } else {
    console.log('   -> "더보기" 버튼 없음, 무한 스크롤 모드');
  }

  if (!total || products.size < total) {
    await revealLazyProducts(page, products, total);
  }

  if (total && products.size < total) {
    console.log(`   [경고] 전체 ${total}개 중 ${products.size}개만 수집`);
    await dumpDiagnostics(page, products, total);
  }

  console.log(`   -> 최종 ${products.size}개 상품 수집 완료`);
  return Array.from(products.entries()).map(([code, name]) => ({ code, name }));
}

async function checkViewer(context, code) {
  let page = null;
  try {
    page = await context.newPage();
    page.setDefaultTimeout(PAGE_LOAD_TIMEOUT);

    await page.goto(productUrl(code), { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT });
    await page.waitForTimeout(500);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const match = bodyText.match(/(\d+)\s*명이\s*보고\s*있어요/);

    return match ? parseInt(match[1], 10) : 0;
  } catch (e) {
    console.log(`   [경고] ${code} 확인 실패`);
    return null;
  } finally {
    if (page) await page.close();
  }
}

async function resolveSheetName(sheets) {
  const gid = SHEET_GID;
  const name = process.env.KIIMUIR_SHEET_NAME;
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties(sheetId,title)',
  });
  const tabs = (meta.data.sheets || []).map((s) => s.properties);
  console.log(`   -> 탭 목록: ${tabs.map((t) => `${t.title}(${t.sheetId})`).join(', ')}`);

  if (gid) {
    const tab = tabs.find((t) => String(t.sheetId) === String(gid));
    if (!tab) throw new Error(`gid=${gid}인 탭 없음`);
    return tab.title;
  }
  if (name) {
    if (!tabs.some((t) => t.title === name)) throw new Error(`탭 '${name}' 없음`);
    return name;
  }
  throw new Error('KIIMUIR_SHEET_GID 또는 KIIMUIR_SHEET_NAME 필요');
}

async function writeToSheet(rows) {
  console.log('[3/3] 구글시트 기록 중...');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetName = await resolveSheetName(sheets);
  console.log(`   -> 탭: '${sheetName}'`);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A:E`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
  console.log(`   -> ${rows.length}개 행 기록 완료`);
}

function nowKST() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 16);
  return { date, time };
}

async function sendSlackAlert(hot) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('   [안내] SLACK_WEBHOOK_URL 없음');
    return;
  }
  if (hot.length === 0) return;

  console.log('[슬랙] 알림 발송 중...');
  const lines = hot
    .map((h) => `• *<${h.url}|${h.name}>* (${h.code}) — *${h.viewers}명*`)
    .join('\n');
  const message = {
    text: `🔥 관심고객 ${VIEWER_THRESHOLD}명 이상 상품 ${hot.length}개! (${hot[0].date} ${hot[0].time})\n${lines}`,
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (res.ok) {
    console.log('   -> 슬랙 발송 완료');
  } else {
    console.log(`   [경고] 슬랙 발송 실패 (status: ${res.status})`);
  }
}

async function checkViewersInParallel(context, productList) {
  console.log('[2/3] 각 상품 보는인원 확인 중... (병렬 처리)');

  const hot = [];
  const totalBatches = Math.ceil(productList.length / PARALLEL_BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * PARALLEL_BATCH_SIZE;
    const end = Math.min(start + PARALLEL_BATCH_SIZE, productList.length);
    const batch = productList.slice(start, end);

    const batchResults = await Promise.allSettled(
      batch.map(async (product) => {
        const viewers = await checkViewer(context, product.code);
        return { product, viewers };
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        const { product, viewers } = result.value;
        const { date, time } = nowKST();
        const idx = start + batchResults.indexOf(result) + 1;
        const total = productList.length;

        console.log(`   (${idx}/${total}) ${product.code} ${product.name} -> ${viewers}명`);

        if (typeof viewers === 'number' && viewers >= VIEWER_THRESHOLD) {
          hot.push({
            code: product.code,
            name: product.name,
            viewers,
            date,
            time,
            url: productUrl(product.code),
          });
        }
      } else {
        console.log(`   [에러] 배치 처리 실패: ${result.reason}`);
      }
    }
  }

  return hot;
}

async function main() {
  if (!SPREADSHEET_ID) throw new Error('KIIMUIR_SPREADSHEET_ID 필요');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 필요');

  const browser = await chromium.launch({ headless: true });

  try {
    const listingPage = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const productList = await getProductList(listingPage);
    await listingPage.close();

    const context = await browser.newContext();
    const hot = await checkViewersInParallel(context, productList);
    await context.close();

    const sheetRows = hot.map((h) => [h.code, h.name, h.date, h.time, h.viewers]);
    if (sheetRows.length > 0) {
      await writeToSheet(sheetRows);
    } else {
      console.log(`[3/3] ${VIEWER_THRESHOLD}명 이상 상품 없음, 시트 기록 생략`);
    }

    if (hot.length > 0) {
      console.log(`\n🔥 ${VIEWER_THRESHOLD}명 이상 보는 상품 ${hot.length}개:`);
      hot.forEach((h) => console.log(`   - ${h.name} (${h.code}): ${h.viewers}명`));
    } else {
      console.log(`\n${VIEWER_THRESHOLD}명 이상 보는 상품 없음`);
    }

    await sendSlackAlert(hot);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('에러 발생:', err);
  process.exit(1);
});
