# -*- coding: utf-8 -*-
"""
무신사 실시간 시청자 모니터
- 브랜드의 전체 상품을 훑어 '__명이 보고 있어요' 배지 값을 수집
- 임계값(기본 30명) 이상인 상품만 슬랙으로 알림
"""
import asyncio, json, re, sys, csv, os, time, urllib.request
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
CFG = json.loads((BASE / "config.json").read_text(encoding="utf-8"))

# 웹훅 URL은 비밀값이므로 깃에 올라가지 않는 secrets.json 또는 환경변수에서 읽는다.
_SECRETS = {}
_sp = BASE / "secrets.json"
if _sp.exists():
    _SECRETS = json.loads(_sp.read_text(encoding="utf-8"))


def slack_webhook():
    return (os.environ.get("SLACK_WEBHOOK_URL")
            or _SECRETS.get("slack_webhook_url")
            or CFG.get("slack_webhook_url", "")).strip()

LIST_API = ("https://api.musinsa.com/api2/dp/v2/plp/goods"
            "?brand={brand}&sortCode=POPULAR&size=100&page={page}"
            "&caller=FLAGSHIP&countryCode=KR&localeCode=ko-KR&gf=A")
PRODUCT_URL = "https://www.musinsa.com/products/{no}"
SLACK_MAX_ITEMS = 10   # 슬랙에는 시청자 많은 상위 10개만 싣는다
BADGE_RE = re.compile(r"(\d+)\s*명이\s*보고\s*있어요")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

BLOCK_HOSTS = ("doubleclick", "googleads", "google-analytics", "googletagmanager",
               "pinterest", "tiktok", "twitter", "facebook", "criteo", "appier",
               "moloco", "braze", "amplitude", "youtube", "adsystem")


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


LIST_JS = """
async (brand) => {
  const out = [];
  let url = `https://api.musinsa.com/api2/dp/v2/plp/goods?brand=${brand}`
          + `&sortCode=POPULAR&size=100&page=1`
          + `&caller=FLAGSHIP&countryCode=KR&localeCode=ko-KR&gf=A`;
  const seen = new Set();
  for (let i = 0; i < 30 && url; i++) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) break;
    const j = await r.json();
    const d = j.data || {};
    (d.list || []).forEach(g => {
      if (!seen.has(g.goodsNo)) {
        seen.add(g.goodsNo);
        out.push({ goodsNo: g.goodsNo, name: g.goodsName || '' });
      }
    });
    const pg = d.pagination || {};
    url = (pg.hasNext && pg.nextPageUrl) ? pg.nextPageUrl : null;
  }
  return out;
}
"""


async def fetch_product_list(context, brand):
    """상품 목록 API는 순수 HTTP 요청을 차단(403)하므로 브라우저 안에서 호출한다."""
    page = await context.new_page()
    try:
        await page.goto(f"https://www.musinsa.com/brand/{brand}",
                        wait_until="domcontentloaded", timeout=40000)
        return await page.evaluate(LIST_JS, brand)
    finally:
        await page.close()


async def scrape_one(context, item, timeout_s):
    """상품 페이지를 열어 배지 숫자를 읽는다. 배지가 없으면 0."""
    no = item["goodsNo"]
    page = await context.new_page()
    try:
        await page.goto(PRODUCT_URL.format(no=no), wait_until="domcontentloaded", timeout=30000)
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                txt = await page.inner_text("body")
            except Exception:
                txt = ""
            m = BADGE_RE.search(txt)
            if m:
                return int(m.group(1))
            await asyncio.sleep(0.4)
        return 0
    except Exception as e:
        log(f"  ! {no} 실패: {type(e).__name__}")
        return None
    finally:
        try:
            await page.close()
        except Exception:
            pass


async def collect(brand, cap, concurrency, timeout_s):
    from playwright.async_api import async_playwright
    results, done = [], 0

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=UA, viewport={"width": 1280, "height": 900},
            locale="ko-KR", timezone_id="Asia/Seoul")

        async def router(route):
            r = route.request
            if r.resource_type in ("image", "media", "font"):
                return await route.abort()
            if any(h in r.url for h in BLOCK_HOSTS):
                return await route.abort()
            return await route.continue_()

        await context.route("**/*", router)

        log("상품 목록 조회 중...")
        items = await fetch_product_list(context, brand)
        if cap:
            items = items[:cap]
        total = len(items)
        log(f"상품 {total}개 확인. 시청자 수 수집 시작 (동시 {concurrency}개)")

        sem = asyncio.Semaphore(concurrency)
        lock = asyncio.Lock()

        async def worker(it):
            nonlocal done
            async with sem:
                v = await scrape_one(context, it, timeout_s)
            async with lock:
                done += 1
                if done % 25 == 0 or done == total:
                    log(f"  진행 {done}/{total}")
            results.append({**it, "viewers": v})

        await asyncio.gather(*(worker(it) for it in items))
        await browser.close()
    return results


def save_csv(rows, ts):
    min_v = int(os.environ.get("CSV_MIN_VIEWERS") or 0)
    path = BASE / "data" / f"{ts:%Y-%m-%d}.csv"
    new = not path.exists()
    (BASE / "data").mkdir(exist_ok=True)
    with path.open("a", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        if new:
            w.writerow(["수집시각", "상품번호", "상품명", "시청자수", "상품링크"])
        for r in rows:
            if r["viewers"] is not None and r["viewers"] < min_v:
                continue
            w.writerow([f"{ts:%Y-%m-%d %H:%M}", r["goodsNo"], r["name"],
                        "" if r["viewers"] is None else r["viewers"],
                        PRODUCT_URL.format(no=r["goodsNo"])])
    return path


def build_slack_message(hot, ts, threshold, brand_label, total, scanned):
    lines = [f"*🔥 {brand_label} 실시간 시청자 {threshold}명 이상* ({ts:%m/%d %H:%M} 기준)"]
    if not hot:
        lines.append(f"\n해당 상품 없음 (상품 {scanned}개 확인)")
    else:
        lines.append(f"\n총 *{len(hot)}개* 상품 · 합계 *{sum(h['viewers'] for h in hot)}명*\n")
        for i, h in enumerate(hot[:SLACK_MAX_ITEMS], 1):
            name = h["name"] if len(h["name"]) <= 40 else h["name"][:39] + "…"
            lines.append(f"{i}. <{PRODUCT_URL.format(no=h['goodsNo'])}|{name}> — *{h['viewers']}명*")
        rest = len(hot) - SLACK_MAX_ITEMS
        if rest > 0:
            lines.append(f"\n_외 {rest}개 상품 생략 ({threshold}명 이상)_")
    return "\n".join(lines)


def send_slack(webhook, text):
    body = json.dumps({"text": text}).encode("utf-8")
    req = urllib.request.Request(webhook, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status


def _cfg_int(env_key, cfg_key, default):
    v = os.environ.get(env_key)
    if v:
        return int(v)
    return int(CFG.get(cfg_key, default))


def main():
    ts = datetime.now()
    brand = CFG["brand"]
    threshold = _cfg_int("THRESHOLD", "threshold", 30)
    dry = "--dry-run" in sys.argv
    limit = 0
    for a in sys.argv[1:]:
        if a.startswith("--limit="):
            limit = int(a.split("=", 1)[1])

    cap = limit or int(CFG.get("max_products") or 0)

    t0 = time.time()
    rows = asyncio.run(collect(brand, cap,
                               _cfg_int("CONCURRENCY", "concurrency", 10),
                               _cfg_int("PAGE_TIMEOUT_SEC", "page_timeout_sec", 20)))
    log(f"수집 완료 ({time.time() - t0:.0f}초)")

    ok = [r for r in rows if r["viewers"] is not None]
    hot = sorted([r for r in ok if r["viewers"] >= threshold],
                 key=lambda r: -r["viewers"])

    path = save_csv(rows, ts)
    log(f"저장: {path}")

    text = build_slack_message(hot, ts, threshold, CFG.get("brand_label", brand),
                               len(rows), len(ok))
    print("\n" + "=" * 60)
    print(text.replace("*", ""))
    print("=" * 60 + "\n")

    hook = slack_webhook()
    if dry:
        log("--dry-run: 슬랙 전송 생략")
    elif not hook:
        log("슬랙 웹훅 미설정 → 전송 생략 (config.json의 slack_webhook_url 입력 필요)")
    else:
        try:
            send_slack(hook, text)
            log(f"슬랙 전송 완료 ({len(hot)}개 상품)")
        except Exception as e:
            log(f"슬랙 전송 실패: {e}")


if __name__ == "__main__":
    main()
