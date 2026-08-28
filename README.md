# 무신사 실시간 시청자 모니터 (키뮤어)

무신사에 올라간 **키뮤어(KIIMUIR) 전 상품**을 훑어서, 상품 상세페이지의
`OO명이 보고 있어요` 배지 값을 수집하고 **30명 이상**인 상품만 슬랙으로 알려줍니다.

## 왜 브라우저로 긁는가

이 숫자는 무신사 API나 HTML 응답 어디에도 담겨 있지 않습니다. 브라우저에서
페이지가 실제로 실행돼야만 화면에 나타나고, **로드 1.7초 뒤 떴다가 약 15초 후
사라집니다.** 그래서 헤드리스 브라우저(Playwright)로 페이지를 열어 배지 텍스트를
읽는 방식이 유일한 방법입니다.

상품 목록만은 API로 가져오지만, 이 API도 일반 HTTP 요청은 403으로 막혀 있어
브라우저 컨텍스트 안에서 호출합니다.

## 실행

```bash
python monitor.py              # 전체 수집 + 슬랙 발송
python monitor.py --dry-run    # 수집만 하고 슬랙 발송은 생략
python monitor.py --limit=30   # 상위 30개만 (테스트용)
```

전체 400개 기준 약 **14분** 소요됩니다.

## 설정

`config.json` — 공개돼도 안전한 설정만 둡니다.

| 항목 | 설명 |
|---|---|
| `brand` | 무신사 브랜드 코드 (`kiimuir`) |
| `threshold` | 알림 기준 인원 (기본 30) |
| `concurrency` | 동시에 열 페이지 수 (기본 10) |
| `page_timeout_sec` | 배지를 기다리는 최대 시간 |
| `max_products` | 0이면 전체 |

## 슬랙 웹훅 (중요)

웹훅 URL은 **비밀값**입니다. 아는 사람은 누구나 해당 채널에 글을 쓸 수 있으므로
저장소에 올리지 않습니다. `secrets.example.json`을 복사해 `secrets.json`을 만들고
그 안에 넣으세요. `secrets.json`은 `.gitignore`로 제외돼 있습니다.

```json
{ "slack_webhook_url": "https://hooks.slack.com/services/..." }
```

환경변수 `SLACK_WEBHOOK_URL`로 넣어도 됩니다.

## 수집 데이터

`data/YYYY-MM-DD.csv`에 실행할 때마다 누적됩니다(엑셀에서 바로 열립니다).
시각·상품번호·상품명·시청자수·링크가 기록되므로 **시간대별 관심도 추이** 분석에
쓸 수 있습니다. 데이터는 저장소에 올리지 않습니다(`.gitignore`).

## 파일

| 파일 | 역할 |
|---|---|
| `monitor.py` | 수집 + 알림 본체 |
| `config.json` | 설정 |
| `secrets.json` | 슬랙 웹훅 (깃 제외) |
| `run.bat` | 자동 실행용 실행 파일 |
