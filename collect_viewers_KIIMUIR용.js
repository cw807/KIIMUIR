// kiimuir-monitor/collect_viewers.js
// 키뮤어(Kiimuir) 브랜드 상품 실시간 관심고객수 모니터링
// GitHub Actions 자동 실행용. 환경변수(GitHub Secrets)로 인증정보를 받습니다.
//
// 필요한 환경변수:
//   GOOGLE_SERVICE_ACCOUNT_JSON  -> 서비스계정 키 파일 내용 전체(JSON 텍스트)
//   KIIMUIR_SPREADSHEET_ID       -> 이 모니터링 전용 새 스프레드시트 ID

const { chromium } = require('playwright');
const { google } = require('googleapis');

// ===== 설정 =====
const LISTING_URL = 'https://www.musinsa.com/content/1535169529421128174?gf=A&brandIds=kiimuir&gender=A&contentIndex=0';
const SPREADSHEET_ID = process.env.KIIMUIR_SPREADSHEET_ID;
const SHEET_NAME = '시트1'; // 실제 탭 이름과 다르면 여기 수정
const VIEWER_THRESHOLD = 30;
// ================

function productUrl(code) {
  return `https://www.musinsa.com/products/${code}`;
}

// 1. 리스팅 페이지에서 상품 목록(코드+이름) 수집 (가상 스크롤 대응)
async function getProductList(page) {
  console.log('[1/3] 상품 목록 수집 중...');
  await page.goto(LISTING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  try {
    await page.waitForSelector('a[href*="/products/"]', { timeout: 20000 });
  } catch (e) {
    console.log('   [경고] 20초 내에 상품 링크를 못 찾았어요.');
  }

  const products = new Map();
  let prevCount = 0;
  let stableRounds = 0;
  let round = 0;

  while (stableRounds < 4 && round < 40) {
    round++;
    const items = await page.$$eval('a[href*="/products/"]', (links) => {
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

    if (products.size === prevCount) {
      stableRounds++;
    } else {
      stableRounds = 0;
      prevCount = products.size;
    }

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5));
    await page.waitForTimeout(1200);
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
async function writeToSheet(rows) {
  console.log('[3/3] 구글시트에 기록 중...');
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:E`,
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
  const hot = []; // 임계치(30명) 이상인 상품 (링크 포함, 시트 기록 & 슬랙 알림에서 사용)

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

  // 임계치(30명) 이상인 상품만 시트에 기록 (전체 61개 다 기록하면 데이터가 너무 빨리 쌓여서 이렇게 걸러요)
  const sheetRows = hot.map((h) => [h.code, h.name, h.date, h.time, h.viewers]);
  if (sheetRows.length > 0) {
    await writeToSheet(sheetRows);
  } else {
    console.log('[3/3] 30명 이상인 상품이 없어서 시트 기록은 건너뜁니다.');
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
