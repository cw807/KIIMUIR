# -*- coding: utf-8 -*-
"""
무신사 키뮤어 상세페이지 깨진 이미지(엑박) 점검
- 각 상품의 상세페이지 HTML(goodsContents)에서 <img> 주소를 모두 뽑아
  실제로 살아있는지(200) 죽었는지(404 등) 확인한다.
"""
import asyncio, json, re, sys, csv, time
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
BRAND = "kiimuir"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

FETCH_JS = """
async (brand) => {
  // 1) 상품 목록
  const items = [];
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
      if (!seen.has(g.goodsNo)) { seen.add(g.goodsNo);
        items.push({ goodsNo: g.goodsNo, name: g.goodsName || '' }); }
    });
    const pg = d.pagination || {};
    url = (pg.hasNext && pg.nextPageUrl) ? pg.nextPageUrl : null;
  }

  // 2) 각 상품 상세 HTML에서 이미지 주소 추출 (동시 12개)
  const out = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const it = items[idx++];
      try {
        const r = await fetch(
          `https://goods-detail.musinsa.com/api2/goods/${it.goodsNo}`,
          { credentials: 'include' });
        if (!r.ok) { out.push({ ...it, error: 'HTTP ' + r.status, images: [] }); continue; }
        const j = await r.json();
        const html = (j.data && j.data.goodsContents) || '';
        const imgs = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
        out.push({ ...it, images: [...new Set(imgs)] });
      } catch (e) {
        out.push({ ...it, error: String(e).slice(0, 80), images: [] });
      }
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  return out;
}
"""


def log(m):
    print(f"[{datetime.now():%H:%M:%S}] {m}", flush=True)


async def gather_products():
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(user_agent=UA, locale="ko-KR")

        async def router(route):
            if route.request.resource_type in ("image", "media", "font"):
                return await route.abort()
            return await route.continue_()
        await ctx.route("**/*", router)

        page = await ctx.new_page()
        await page.goto(f"https://www.musinsa.com/brand/{BRAND}",
                        wait_until="domcontentloaded", timeout=60000)
        log("상품 목록 + 상세 이미지 주소 수집 중...")
        data = await page.evaluate(FETCH_JS, BRAND)
        await b.close()
    return data


def normalize(url):
    """브라우저가 실제로 요청하는 형태로 주소를 맞춘다.
    반환: (요청주소 or None, 사유). None이면 브라우저에서도 못 부르는 잘못된 주소."""
    u = url.strip()
    if u.startswith("//"):            # 프로토콜 생략 — 브라우저는 https 로 붙여 정상 로드
        return "https:" + u, None
    if u.startswith(("http://", "https://")):
        rest = u.split("://", 1)[1]
        if "://" in rest:             # https:https://... 처럼 주소가 겹쳐 쓰인 오류
            return None, "주소 중복 오류"
        return u, None
    if u.startswith("/"):
        return "https://www.musinsa.com" + u, None
    return None, "잘못된 주소 형식"


def check_url(url):
    """이미지가 살아있는지 확인. (원본url, 상태) 반환."""
    orig = url
    req_url, bad = normalize(url)
    if bad:
        return orig, (bad, None)
    url = req_url
    for method in ("HEAD", "GET"):
        try:
            req = urllib.request.Request(url, method=method,
                                         headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                if method == "GET":
                    r.read(1024)
                cl = r.headers.get("Content-Length")
                return orig, (r.status, int(cl) if cl and cl.isdigit() else None)
        except urllib.error.HTTPError as e:
            if e.code == 405 and method == "HEAD":
                continue          # HEAD 미지원 서버면 GET 으로 재시도
            return orig, (e.code, None)
        except Exception as e:
            return orig, (type(e).__name__, None)
    return orig, ("UNKNOWN", None)


def main():
    t0 = time.time()
    products = asyncio.run(gather_products())
    log(f"상품 {len(products)}개 수집 완료")

    all_urls = sorted({u for p in products for u in p.get("images", [])})
    log(f"검사할 이미지 주소 {len(all_urls)}개 (중복 제거)")

    results = {}
    done = 0
    with ThreadPoolExecutor(max_workers=16) as ex:
        for url, status in ex.map(check_url, all_urls):
            results[url] = status
            done += 1
            if done % 200 == 0:
                log(f"  이미지 확인 {done}/{len(all_urls)}")
    log(f"이미지 확인 완료 ({time.time()-t0:.0f}초)")

    # 판정 기준: 서버가 200 이 아닌 응답을 주면 그 이미지는 실제로 없는 것.
    # (파일 크기는 판정에 쓰지 않는다 — 1500x1 여백 이미지처럼 정상인데 작은 파일이 많다.)
    def verdict(u):
        st, ln = results.get(u, ("NONE", None))
        if st != 200:
            return f"없음({st})"
        return None

    broken_products = []
    for p in products:
        bad = [u for u in p.get("images", []) if verdict(u)]
        if bad:
            broken_products.append({**p, "broken": bad,
                                    "total": len(p.get("images", []))})
    broken_products.sort(key=lambda x: -len(x["broken"]))

    ts = datetime.now()
    out = BASE / "data" / f"broken_images_{ts:%Y%m%d_%H%M}.csv"
    out.parent.mkdir(exist_ok=True)
    with out.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["상품번호", "상품명", "상품링크", "깨진이미지수",
                    "전체이미지수", "깨진이미지주소", "응답코드"])
        for p in broken_products:
            for u in p["broken"]:
                w.writerow([p["goodsNo"], p["name"],
                            f"https://www.musinsa.com/products/{p['goodsNo']}",
                            len(p["broken"]), p["total"], u, verdict(u)])

    no_img = [p for p in products if not p.get("images")]
    print("\n" + "=" * 70)
    print(f"검사 상품: {len(products)}개 | 이미지 주소: {len(all_urls)}개")
    print(f"엑박 있는 상품: {len(broken_products)}개")
    print(f"상세페이지에 이미지가 아예 없는 상품: {len(no_img)}개")
    print("=" * 70)
    for p in broken_products[:40]:
        print(f"  {p['goodsNo']}  깨짐 {len(p['broken']):>2}/{p['total']:<2}  {p['name'][:45]}")
    if len(broken_products) > 40:
        print(f"  ... 외 {len(broken_products)-40}개 (CSV 참고)")
    codes = {}
    for p in broken_products:
        for u in p["broken"]:
            c = results.get(u); codes[c] = codes.get(c, 0) + 1
    print(f"\n응답코드 분포: {codes}")
    print(f"저장: {out}")


if __name__ == "__main__":
    main()
