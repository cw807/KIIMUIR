// kiimuir-monitor/collect_viewers.js
// 키뮤어(Kiimuir) 브랜드 상품 실시간 관심고객수 모니터링
// GitHub Actions 자동 실행용. 환경변수(GitHub Secrets)로 인증정보를 받습니다.
//
// 필요한 환경변수:
//   GOOGLE_SERVICE_ACCOUNT_JSON  -> 서비스계정 키 파일 내용 전체(JSON 텍스트)
//   KIIMUIR_SPREADSHEET_ID       -> 이 모니터링 전용 새 스프레드시트 ID
//   KIIMUIR_SHEET_NAME           -> (선택) 탭 이름. 없으면 첫 번째 탭을 자동으로 사용
//   SLACK_WEBHOOK_URL            -> (선택) 슬랙 알림용

const { chromium } = require('playwright');
const { google } = require('googleapis');

// ===== 설정 =====
const LISTING_URL = 'https://www.musinsa.com/content/1535169529421128174?gf=A&brandIds=kiimuir&gender=A&contentIndex=0';
const SPREADSHEET_ID = process.env.KIIMUIR_SPREADSHEET_ID;
const VIEWER_THRESHOLD = 30;
const MAX_MORE_CLICKS = 30;     // 더보기 클릭 최대 횟수 (안전장치)
const BUTTON_RETRY = 6;         // 버튼이 안 보일 때 재시도 횟수 (클릭 후 리렌더링 대기용)
// ================

function productUrl(code) {
  return `https://www.musinsa.com/products/${code}`;
}

// 1. 리스팅 페이지에서 상품 목록(코드+이름) 수집
// 상품 카드들은 ExpansibleGoodsTabRow__CustomGoodsRow-sc-xxxx 라는 div 안에 있음.
// 뒤의 해시(sc-oz6xp3-0 등)는 배포마다 바뀔 수 있어서 앞부분만 부분일치로 찾음.
// 하단 "인기 키뮤어 발매" 같은 다른 섹션은 이 div 밖에 있어서 자연스럽게 제외됨.
const GOODS_ROW_SELECTOR = 'div[class*="ExpansibleGoodsTabRow__CustomGoodsRow"]';
const PRODUCT_SELECTOR = `${GOODS_ROW_SELECTOR} a[href*="/products/"]`;
// 더보기 버튼: <button data-button-id="more" data-button-name="더보기">더보기 (9/35)</button>
const MORE_BUTTON_SELECTOR = 'button[data-button-id="more"]';

async function collectVisibleProducts(page, products) {
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
}

// 현재 DOM에 붙어있는 상품 링크 수 (dedup 전)
async function countProductLinks(page) {
  return page.$$eval(PRODUCT_SELECTOR, (links) => links.length).catch(() => 0);
}

// 더보기 버튼을 찾고 "더보기 (9/35)" 텍스트에서 현재/전체 개수를 파싱
async function findMoreButton(page) {
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
}

// 버튼이 클릭 직후 리렌더링되며 잠깐 사라지는 경우가 있어서, 몇 번 스크롤+대기하며 다시 찾음
async function waitForMoreButton(page) {
  for (let attempt = 1; attempt <= BUTTON_RETRY; attempt++) {
    const info = await findMoreButton(page);
    if (info) return info;
    await page.mouse.wheel(0, 2500).catch(() => {});
    await page.waitForTimeout(800);
  }
  return null;
}

// 펼쳐진 뒤 화면에 들어와야 렌더링되는(lazy) 카드들을 위해,
// 마지막으로 렌더된 카드를 화면에 넣고 조금씩 내려가며 반복 수집
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
    await page.waitForTimeout(700);
    await collectVisibleProducts(page, products);

    if (products.size !== before) {
      stale = 0;
      console.log(`   -> 스크롤 ${step}회 -> 현재까지 ${products.size}개${total ? ` / 전체 ${total}개` : ''}`);
    } else {
      stale++;
    }
    if (total && products.size >= total) break;
    if (stale >= 4) break; // 4번 연속 안 늘어나면 더 이상 렌더될 게 없다고 판단
  }
}

// 수집이 부족할 때 원인 파악용 정보 출력 + 스크린샷 저장
async function dumpDiagnostics(page, products, total) {
  const info = await page.evaluate((rowSel) => {
    const allLinks = document.querySelectorAll('a[href*="/products/"]').length;
    const inRow = document.querySelectorAll(`${rowSel} a[href*="/products/"]`).length;
    const rows = document.querySelectorAll(rowSel).length;
    const moreButtons = Array.from(document.querySelectorAll('button'))
      .filter((b) => /더보기/.test(b.innerText || ''))
      .map((b) => ({
        text: (b.innerText || '').trim(),
        id: b.getAttribute('data-button-id'),
        cls: (b.className || '').slice(0, 60),
      }));
    return { allLinks, inRow, rows, moreButtons, scrollHeight: document.body.scrollHeight };
  }, GOODS_ROW_SELECTOR);
  console.log(`   [진단] 페이지 전체 상품링크 ${info.allLinks}개 / 컨테이너 안 ${info.inRow}개 / 컨테이너 ${info.rows}개 / 페이지 높이 ${info.scrollHeight}`);
  console.log(`   [진단] '더보기' 포함 버튼: ${JSON.stringify(info.moreButtons)}`);
  try {
    await page.screenshot({ path: 'debug_listing.png', fullPage: true });
    console.log('   [진단] 스크린샷 저장: debug_listing.png (워크플로우에 upload-artifact 단계를 넣으면 다운로드 가능)');
  } catch (e) {
    console.log(`   [진단] 스크린샷 실패: ${e.message}`);
  }
}

async function getProductList(page) {
  console.log('[1/3] 상품 목록 수집 중...');
  await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForSelector(PRODUCT_SELECTOR, { timeout: 20000 });
  } catch (e) {
    console.log('   [경고] 20초 내에 상품 링크를 못 찾았어요. (셀렉터가 바뀌었을 수 있음)');
  }

  const products = new Map();
  await collectVisibleProducts(page, products);
  console.log(`   -> 처음 로드된 ${products.size}개 수집`);

  let total = null;      // 더보기 버튼에서 읽은 전체 상품 수 (예: 35)
  let staleRounds = 0;   // 클릭했는데 상품 수가 안 늘어난 횟수

  for (let round = 1; round <= MAX_MORE_CLICKS; round++) {
    const info = await waitForMoreButton(page);
    if (!info) {
      console.log('   -> 더보기 버튼 없음, 펼치기는 끝난 것으로 판단');
      break;
    }
    if (info.total) total = info.total;
    if (total && products.size >= total) {
      console.log(`   -> 전체 ${total}개 모두 수집됨, 더보기 중단`);
      break;
    }

    const domBefore = await countProductLinks(page);
    const sizeBefore = products.size;

    try {
      await info.handle.scrollIntoViewIfNeeded();
      await info.handle.click();
    } catch (e) {
      console.log(`   [경고] 더보기 버튼 클릭 실패: ${e.message}`);
      break;
    }

    // 상품 링크가 실제로 늘어날 때까지 최대 8초 대기
    try {
      await page.waitForFunction(
        ({ sel, before }) => document.querySelectorAll(sel).length > before,
        { sel: PRODUCT_SELECTOR, before: domBefore },
        { timeout: 8000 }
      );
    } catch (e) {
      console.log(`   [안내] 더보기 ${round}번째 클릭 후 8초 내 상품 증가 없음`);
    }
    await page.waitForTimeout(500);
    await collectVisibleProducts(page, products);
    console.log(`   -> 더보기 ${round}번째 클릭 [${info.text}] -> 현재까지 ${products.size}개${total ? ` / 전체 ${total}개` : ''}`);

    // 펼쳐진 카드 중 아직 렌더 안 된 것들을 스크롤로 마저 불러옴
    await revealLazyProducts(page, products, total);

    if (products.size === sizeBefore) {
      staleRounds++;
      if (staleRounds >= 3) {
        console.log('   [경고] 3번 연속 상품이 늘지 않아 중단');
        break;
      }
    } else {
      staleRounds = 0;
    }
  }

  // 버튼이 없어진 뒤에도 lazy 렌더링이 남아 있을 수 있어서 한 번 더 스크롤 수집
  if (!total || products.size < total) {
    await revealLazyProducts(page, products, total);
  }

  if (total && products.size < total) {
    console.log(`   [경고] 전체 ${total}개 중 ${products.size}개만 수집됨. 아래 진단 정보를 확인하세요.`);
    await dumpDiagnostics(page, products, total);
  }
  console.log(`   -> 최종 ${products.size}개 상품 수집 완료`);
  return Array.from(products.entries()).map(([code, name]) => ({ code, name }));
}

// 2. 상품 상세페이지에서 "N명이 보고 있어요" 값 추출
async function checkViewer(page, code) {
  try {
    await page.goto(productUrl(code), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    const match = bodyText.match(/(\d+)\s*명이\s*보고\s*있어요/);
    return match ? parseInt(match[1], 10) : 0;
  } catch (e) {
    console.log(`   [경고] ${code} 확인 실패: ${e.message}`);
    return null;
  }
}

// 3. 구글시트에 결과 쓰기 (서비스계정 키를 환경변수에서 직접 읽음)
// 탭 이름은 KIIMUIR_SHEET_NAME 환경변수가 있으면 그걸 쓰고, 없으면 첫 번째 탭 이름을 API로 읽어옴.
// (기존 에러 "Unable to parse range: 시트1!A:E" = 실제 탭 이름이 '시트1'이 아니어서 발생)
async function resolveSheetName(sheets) {
  if (process.env.KIIMUIR_SHEET_NAME) return process.env.KIIMUIR_SHEET_NAME;
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
    fields: 'sheets.properties.title',
  });
  const titles = (meta.data.sheets || []).map((s) => s.properties.title);
  console.log(`   -> 스프레드시트 탭 목록: ${JSON.stringify(titles)}`);
  if (titles.length === 0) throw new Error('스프레드시트에 탭이 없습니다.');
  return titles[0];
}

async function writeToSheet(rows) {
  console.log('[3/3] 구글시트에 기록 중...');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const sheetName = await resolveSheetName(sheets);
  console.log(`   -> 기록할 탭: '${sheetName}'`);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetName}'!A:E`, // 탭 이름에 공백/특수문자가 있어도 안전하게 따옴표로 감쌈
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

// 4. 슬랙으로 알림 보내기 (임계치 이상인 상품이 있을 때만)
async function sendSlackAlert(hot) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('   [안내] SLACK_WEBHOOK_URL이 없어서 슬랙 알림은 건너뜁니다.');
    return;
  }
  if (hot.length === 0) return;

  console.log('[슬랙] 알림 발송 중...');

  const lines = hot
    .map((h) => `• *<${h.url}|${h.name}>* (${h.code}) — *${h.viewers}명* 보는 중`)
    .join('\n');

  const message = {
    text: `🔥 실시간 관심고객 ${VIEWER_THRESHOLD}명 이상 상품 ${hot.length}개 발견! (${hot[0].date} ${hot[0].time})\n${lines}`,
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  if (res.ok) {
    console.log('   -> 슬랙 알림 발송 완료');
  } else {
    console.log(`   [경고] 슬랙 발송 실패 (status: ${res.status})`);
  }
}

async function main() {
  if (!SPREADSHEET_ID) throw new Error('KIIMUIR_SPREADSHEET_ID 환경변수가 없습니다.');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON 환경변수가 없습니다.');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const productList = await getProductList(page);

  console.log('[2/3] 각 상품 보는인원 확인 중...');
  const hot = []; // 임계치 이상인 상품 (링크 포함, 시트 기록 & 슬랙 알림에서 사용)

  for (let i = 0; i < productList.length; i++) {
    const { code, name } = productList[i];
    const viewers = await checkViewer(page, code);
    const { date, time } = nowKST();
    console.log(`   (${i + 1}/${productList.length}) ${code} ${name} -> ${viewers}명`);

    if (typeof viewers === 'number' && viewers >= VIEWER_THRESHOLD) {
      hot.push({ code, name, viewers, date, time, url: productUrl(code) });
    }
  }

  await browser.close();

  // 임계치 이상인 상품만 시트에 기록 (전부 기록하면 데이터가 너무 빨리 쌓임)
  const sheetRows = hot.map((h) => [h.code, h.name, h.date, h.time, h.viewers]);
  if (sheetRows.length > 0) {
    await writeToSheet(sheetRows);
  } else {
    console.log(`[3/3] ${VIEWER_THRESHOLD}명 이상인 상품이 없어서 시트 기록은 건너뜁니다.`);
  }

  if (hot.length > 0) {
    console.log(`\n🔥 ${VIEWER_THRESHOLD}명 이상 보는 상품 ${hot.length}개:`);
    hot.forEach((h) => console.log(`   - ${h.name} (${h.code}): ${h.viewers}명 -> ${h.url}`));
  } else {
    console.log(`\n${VIEWER_THRESHOLD}명 이상 보는 상품 없음`);
  }

  await sendSlackAlert(hot);
}

main().catch((err) => {
  console.error('에러 발생:', err);
  process.exit(1);
});
