# Benchmark 시각화

SeoulMate의 정량 검증 결과는 정적 포트폴리오 차트와 로컬 Grafana dashboard 두 형태로 제공한다. 두 시각화 모두 `reports/benchmark/*.json`에 보존된 측정 결과를 근거로 한다.

## 생성 결과

| 시각화                   | PNG                                                                                            | HTML                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| PostgreSQL 실행계획 트리 | [`postgresql-execution-plan.png`](../../docs/assets/benchmark/postgresql-execution-plan.png)   | [`postgresql-execution-plan.html`](../../docs/assets/benchmark/postgresql-execution-plan.html)   |
| Graph latency            | [`graph-latency.png`](../../docs/assets/benchmark/graph-latency.png)                           | [`graph-latency.html`](../../docs/assets/benchmark/graph-latency.html)                           |
| LangGraph node 병목      | [`langgraph-node-bottleneck.png`](../../docs/assets/benchmark/langgraph-node-bottleneck.png)   | [`langgraph-node-bottleneck.html`](../../docs/assets/benchmark/langgraph-node-bottleneck.html)   |
| PostgreSQL query 감소    | [`postgresql-query-reduction.png`](../../docs/assets/benchmark/postgresql-query-reduction.png) | [`postgresql-query-reduction.html`](../../docs/assets/benchmark/postgresql-query-reduction.html) |
| 추천 다양성              | [`recommendation-diversity.png`](../../docs/assets/benchmark/recommendation-diversity.png)     | [`recommendation-diversity.html`](../../docs/assets/benchmark/recommendation-diversity.html)     |
| Grafana 전체 dashboard   | [`grafana-dashboard.png`](../../docs/assets/benchmark/grafana-dashboard.png)                   | Docker 실행 필요                                                                                 |
| 실제 DB 데이터           | [`dbeaver-database-data.png`](../../docs/assets/benchmark/dbeaver-database-data.png)           | DBeaver 계열 도구 연결 필요                                                                      |
| 실제 DB ERD              | [`dbeaver-erd.png`](../../docs/assets/benchmark/dbeaver-erd.png)                               | DBeaver Desktop 연결 필요                                                                        |
| 기존 SQL graphical plan  | [`pgadmin-explain-before.png`](../../docs/assets/benchmark/pgadmin-explain-before.png)         | pgAdmin 연결 필요                                                                                |
| 개선 SQL graphical plan  | [`pgadmin-explain-after.png`](../../docs/assets/benchmark/pgadmin-explain-after.png)           | pgAdmin 연결 필요                                                                                |

## PostgreSQL 실행계획 생성

```powershell
$env:DATABASE_URL = ""
$env:DATABASE_SSL = "false"
$env:POSTGRES_HOST = "127.0.0.1"
$env:POSTGRES_PORT = "15433"
$env:POSTGRES_DB = "seoulmate_benchmark"
$env:POSTGRES_USER = "seoulmate"
$env:POSTGRES_PASSWORD = "seoulmate-local-only"

npm run benchmark:explain
npm run benchmark:visualize
```

`candidate-explain-plans.json`에는 기존 primary query와 9개 dataset 보강 query, 개선된 단일 query의 원본 `FORMAT JSON` plan을 저장한다. 트리에는 다음 값을 표시한다.

- node type: Seq Scan, Bitmap/Index Scan, Nested Loop, Sort, Limit
- 실제 방문 row: `Actual Rows × Actual Loops`
- node 반복 횟수
- 실제 실행시간: `Actual Total Time × Actual Loops`
- shared hit block
- relation과 index 이름

개선된 query의 내부 Nested Loop는 dataset source 9개에 대해 inner plan을 반복하는 `CROSS JOIN LATERAL` 실행을 나타낸다. 이후 복합 index로 경량 ID를 고른 다음 최종 55개 ID만 PK Index Scan으로 hydrate한다.

## 정적 차트 생성

```powershell
npm run benchmark:visualize
```

이 명령은 HTML 5개를 생성한다. 저장소의 PNG는 1600×900 viewport에서 해당 HTML을 캡처한 결과다. 차트를 수정할 때 숫자를 HTML에 직접 입력하지 않고 benchmark JSON 또는 generator를 변경한다.

## Grafana 실행

```powershell
docker compose -f docker-compose.visualization.yml up -d
```

- URL: `http://127.0.0.1:13000/d/seoulmate-benchmark/seoulmate-quantitative-validation`
- 로그인 없이 viewer 권한으로 열람 가능
- dashboard와 datasource는 시작 시 자동 provisioning
- 포트 `13000`은 로컬 시각화 전용

Grafana는 실시간 운영 monitoring 용도가 아니라 저장된 benchmark 결과를 포트폴리오 dashboard로 재현하기 위한 구성이다. 운영 지표를 연결할 때는 TestData datasource를 PostgreSQL·Prometheus datasource로 교체한다.

## DBeaver·pgAdmin 실제 DB 검증

같은 compose 파일은 기존 benchmark PostgreSQL에 직접 연결하는 공식 DB 도구도 실행한다.

- DBeaver CloudBeaver: `http://127.0.0.1:18978`
- pgAdmin 4: `http://127.0.0.1:15050`
- 컨테이너 내부 DB endpoint: `seoulmate-benchmark-db:5432/seoulmate_benchmark`
- 호스트 DB endpoint: `127.0.0.1:15433/seoulmate_benchmark`

CloudBeaver SQL editor에서 실제 `public_data`를 집계한 결과는 172,821행, 원천 데이터셋 9개, 좌표 보유 170,822행, 서울 자치구 25개다. Community 웹 버전에서 ERD 편집기는 제공 범위가 제한되므로 관계도는 같은 DB에 연결한 DBeaver Desktop Community에서 캡처했다.

![DBeaver 계열 도구 실제 데이터](../../docs/assets/benchmark/dbeaver-database-data.png)

![DBeaver Desktop 실제 ERD](../../docs/assets/benchmark/dbeaver-erd.png)

pgAdmin Query Tool에서 기존 SQL과 개선 SQL을 각각 실행한 뒤 `Shift+F7`의 `EXPLAIN ANALYZE` graphical plan을 캡처했다. 기존 plan은 전체 후보를 정렬하는 `Sort → Gather Merge → Limit` 흐름을, 개선 plan은 `idx_public_data_district_source_updated` 복합 인덱스, 데이터셋별 `CROSS JOIN LATERAL` quota, 선택 ID의 PK hydrate 흐름을 보여준다.

| 기존 SQL                                                                                   | 개선 SQL                                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| ![pgAdmin 기존 SQL graphical plan](../../docs/assets/benchmark/pgadmin-explain-before.png) | ![pgAdmin 개선 SQL graphical plan](../../docs/assets/benchmark/pgadmin-explain-after.png) |

화면 하단 시간은 cache 상태가 반영된 개별 warm 실행값이다. 포트폴리오의 `301.32 → 13.18ms`, scan tuple `450,286 → 11,206`, hit block `29,105 → 2,009` 비교는 저장된 `FORMAT JSON` plan과 반복 benchmark를 기준으로 한다.

종료할 때는 다음 명령을 사용한다.

```powershell
docker compose -f docker-compose.visualization.yml down
```

## Grafana 캡처

Chrome/Edge가 설치되어 있다면 Playwright CLI로 렌더 완료 후 전체 화면을 캡처할 수 있다.

```powershell
npx --yes playwright@1.55.0 screenshot `
  --channel chrome `
  --color-scheme dark `
  --viewport-size "1920,1080" `
  --wait-for-timeout 8000 `
  --full-page `
  "http://127.0.0.1:13000/d/seoulmate-benchmark/seoulmate-quantitative-validation?orgId=1&kiosk=tv&from=now-6h&to=now" `
  "../docs/assets/benchmark/grafana-dashboard.png"
```

## 해석 주의사항

- 정적 차트의 DB 수치는 문서에 채택한 동일 측정 회차를 사용한다.
- 실행계획 트리는 plan node를 보존하기 위해 다시 실행한 회차이므로 cache와 background I/O에 따라 총 실행시간이 달라질 수 있다.
- Grafana의 `Scan tuple (x1k)`와 `Hit blocks (x100)`은 한 panel에서 비교 가능하도록 표시 단위만 축소했다.
- 처리량은 단일 프로세스 순차 실행 결과이며 동시 사용자 처리량이 아니다.
