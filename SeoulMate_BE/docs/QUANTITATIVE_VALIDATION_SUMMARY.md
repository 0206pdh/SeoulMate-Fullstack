# SeoulMate 정량 검증 및 성능 개선 총정리

> 측정일: 2026-08-19~2026-08-20 KST  
> 범위: 추천 LangGraph, 공공데이터 품질, PostgreSQL 후보 조회, 코스 다양성  
> 원칙: 동일 조건의 전후 비교, 원본 JSON 보존, 품질 저하 여부 동시 검증

## 1. 결론

SeoulMate의 개선은 단순히 benchmark를 추가한 작업이 아니다. 먼저 추천 결과가 맞는지 측정할 수 있는 기반을 만들고, LangGraph 노드별 병목을 계측한 뒤, 애플리케이션 I/O와 PostgreSQL 검색 구조를 각각 개선했다. 마지막에는 조회 속도를 위해 후보를 줄였을 때 추천 다양성이 손상될 수 있다는 문제를 별도 지표로 발견하고 MMR 기반 variant 생성으로 보완했다.

| 검증 영역                                 |           최초 상태 |   최종 상태 |                          변화 |
| ----------------------------------------- | ------------------: | ----------: | ----------------------------: |
| 결정론적 자동 테스트                      |               34/34 |       39/39 | 회귀 항목 5개 추가, 100% 통과 |
| 20개 지역 추천 성공률                     |                100% |        100% |                          유지 |
| validation 통과율                         |                 90% |        100% |                         +10%p |
| 예산·시간·DB 실재성·추천 좌표·지역 일치율 | 일부 시간 검증 누락 |   각각 100% |                제약 검증 보강 |
| 전체 graph 평균 latency                   |          1,639.13ms |  1,193.39ms |                  27.19% 감소¹ |
| 전체 graph p95 latency                    |          2,389.70ms |  1,292.67ms |                  45.91% 감소¹ |
| 순차 처리량                               |         0.610 req/s | 0.838 req/s |                  37.38% 증가¹ |
| 후보 조회 node 평균                       |             85.40ms |     16.32ms |                  80.89% 감소² |
| 대표 후보 SQL 수                          |                10개 |         1개 |                      90% 감소 |
| 대표 SQL 실행시간                         |           301.317ms |    13.182ms |                   95.63% 감소 |
| 대표 SQL plan scan tuple                  |             450,286 |      11,206 |                   97.51% 감소 |
| 평균 코스 variant                         |               2.9개 |       3.9개 |                   34.48% 증가 |
| 평균 category entropy                     |              1.6552 |      1.6928 |                    2.27% 증가 |
| 평균 코스 간 Jaccard                      |                   0 |      0.0111 |    확장 후에도 매우 낮은 중복 |

¹ 같은 graph 성능 단계의 `performance-before`와 `performance-after` 비교다.  
² 최초 baseline 85.40ms와 DB 정규화 완료 후 16.32ms의 단계 간 비교다. DB 단계 직전 53.81ms와 비교하면 69.67% 감소다.

## 2. 측정 환경과 해석 범위

### 2.1 환경

- Windows 로컬 호스트, Docker PostgreSQL 16
- 전용 benchmark DB: `seoulmate_benchmark`, 포트 `15433`
- 운영 서버를 켜지 않고 compiled LangGraph를 프로세스 내부에서 직접 호출
- Express, 인증 middleware, Nginx, PM2, 운영 네트워크 제외
- OpenAI·Kakao·기상 API key를 비워 provider fallback 경로로 고정
- 성능 비교: warm-up 5회 후 10개 서울 지역 시나리오를 순환하며 40회 순차 실행
- 품질 비교: 20개 서울 지역 시나리오
- 다양성 비교: 10개 지역, 동일 예산·4시간 조건
- DB 비교: 성수/성동구 대표 요청을 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`으로 측정

### 2.2 데이터 규모

| 데이터셋                |     장소 수 |
| ----------------------- | ----------: |
| `LOCALDATA_072404`      |     120,332 |
| `LOCALDATA_072405`      |      29,730 |
| `culturalEventInfo`     |      19,509 |
| `TbVwRestaurants`       |       1,343 |
| `culturalSpaceInfo`     |       1,076 |
| `TbVwAttractions`       |         497 |
| `TbVwNature`            |         150 |
| `SearchParkInfoService` |         133 |
| `viewNightSpot`         |          51 |
| **합계**                | **172,821** |

- category 정규화율: 100%
- 좌표 보유율: 98.84%
- 검색 문서 생성률: 100%
- 자치구 정규화율: 99.93% (`172,693 / 172,821`)
- 서울 25개 자치구 모두 존재

## 3. Phase 0 — 재현 가능한 측정 기반 구축

### 문제

기존에는 추천이 “동작한다”는 확인은 가능했지만, 서버·외부 API 상태와 분리된 반복 측정, 노드별 시간, DB scan 양, 추천 다양성을 같은 조건으로 비교하기 어려웠다. 이 상태에서는 코드 변경이 실제 개선인지 환경 변동인지 구분할 수 없다.

### 구현

1. PostgreSQL 16 전용 컨테이너를 만들고 9개 원천 데이터셋 172,821건을 적재했다.
2. HTTP 서버 없이 LangGraph를 직접 실행하는 `benchmarkRecommendationDirect.mjs`를 추가했다.
3. provider key를 비워 fallback 경로를 고정하고 외부 API 성공 여부가 결과를 바꾸지 않게 했다.
4. 성공, validation, 예산, 전체 소요시간, DB grounding, 좌표, 지역 alias, 후보 수와 latency를 JSON/Markdown으로 저장했다.
5. 이후 성능·SQL·다양성 benchmark도 모두 원본 JSON을 저장하도록 확장했다.

### 결과

- 최초 결정론적 테스트: 34/34 통과
- benchmark가 실제 전체 데이터 172,821건과 연결됨을 확인
- category 정규화 100%, 좌표 보유 98.84%
- 각 후속 phase를 같은 데이터와 시나리오로 비교할 수 있는 기준선 확보

### 의미

이 phase의 결과는 성능 개선 수치가 아니라 **측정 신뢰성 확보**다. 이후의 개선 수치는 이 기반 위에서만 해석한다.

## 4. Phase 1 — 추천 정확성 및 제약조건 검증

### 최초 측정

전체 데이터에 20개 지역 요청을 실행했을 때 성공률은 100%였지만 validation 통과율은 90%, 시간 준수율은 95%였다.

### 발견한 결함

1. 후보 검색은 `망원`을 `마포구`와 연결할 수 있었지만 validator는 주소 문자열의 단순 포함만 검사해 정상 추천을 실패로 판단했다.
2. 코스 제한시간을 검증할 때 장소 체류시간뿐 아니라 장소 간 이동시간까지 합산해야 하는데 해당 검증이 충분하지 않았다.

### 코드 개선

- 검색과 validation이 같은 `resolveRegion`, `placeMatchesRegion` 규칙을 공유하도록 변경했다.
- 장소 체류시간과 이동시간의 합을 사용자 요청 duration과 비교하도록 검증을 강화했다.
- 지역 alias와 코스 시간 상한 회귀 테스트를 추가했다.

### 전후 결과

| 지표                | 개선 전 | 개선 후 |
| ------------------- | ------: | ------: |
| 성공률              |    100% |    100% |
| validation 통과율   |     90% |    100% |
| 예산 준수율         |    100% |    100% |
| 시간 준수율         |     95% |    100% |
| DB grounding        |    100% |    100% |
| 추천 장소 좌표 보유 |    100% |    100% |
| 지역 alias 일치     |    100% |    100% |
| fallback route 생성 |    100% |    100% |
| 자동 테스트         |    34개 |    36개 |

### 의미

성능을 높이기 전에 품질 guardrail을 먼저 고정했다. 이후 최적화에서도 위 지표가 100%인지 함께 측정해 “빠르지만 틀린 추천”을 방지했다.

## 5. Phase 2 — LangGraph 노드 계측과 실행 경로 최적화

### 병목 측정

warm-up 5회 후 40회 측정한 최초 전체 graph 결과는 다음과 같다.

| 항목                   |       평균 |        p50 |        p95 |       최대 |
| ---------------------- | ---------: | ---------: | ---------: | ---------: |
| 전체 graph             | 1,639.13ms | 1,520.51ms | 2,389.70ms | 2,877.54ms |
| `parseUserRequest`     |   169.82ms |   163.67ms |   197.76ms |   221.15ms |
| `fetchCandidatePlaces` |    85.40ms |    43.86ms |   230.67ms |   256.56ms |
| `fetchContextData`     | 1,359.06ms | 1,262.99ms | 2,087.43ms | 2,664.76ms |
| `scorePlaces`          |     1.57ms |     1.98ms |     3.00ms |     4.08ms |
| `buildCourse`          |    23.12ms |    22.36ms |    40.26ms |    44.82ms |

`fetchContextData`가 평균 전체 시간의 약 82.9%를 차지했고, 이미 구조화된 요청도 parsing 경로를 다시 거쳤으며, 후보가 충분해도 데이터셋 보강 SQL을 추가 실행했다.

### 구현 1 — 구조화 입력 parsing 우회

프론트엔드가 region, budget, duration 등 완전한 preset을 전달한 경우 중복 LLM parsing을 생략했다. 자연어만 전달되는 요청은 기존 parsing 경로를 유지했다.

- `parseUserRequest`: 평균 169.82ms → 0.08ms, **99.95% 감소**
- 구조화 입력 우회 회귀 테스트 추가

### 구현 2 — 독립 context I/O 병렬화

도시 데이터, 날씨, 생활인구는 서로의 결과에 의존하지 않는다. 이를 순차 호출에서 `Promise.all` 병렬 호출로 변경했다. 각 provider의 fallback과 warning은 독립적으로 유지해 하나의 실패가 전체 추천 실패로 전파되지 않게 했다.

- `fetchContextData`: 평균 1,359.06ms → 1,118.10ms, **17.73% 감소**

### 구현 3 — 불필요한 후보 보강 조회 생략

1차 검색에서 40개 이상의 후보를 얻으면 추가 데이터셋 enrichment query를 생략했다. 후보가 부족한 지역은 기존 보강 경로를 유지했다.

- `fetchCandidatePlaces`: 평균 85.40ms → 53.81ms, **36.99% 감소**
- 한 번에 합친 window query도 실험했지만 평균이 105.69ms로 악화되어 폐기했다. 실패한 접근까지 측정으로 판별한 사례다.

### 구현 4 — 초기 인덱스 보강

- `place_family`, `place_type`, `place_subtype` trigram GIN index
- `(source_dataset, updated_at DESC, id DESC)` index

### 전체 graph 전후 결과

| 지표            |     개선 전 |     개선 후 |        변화 |
| --------------- | ----------: | ----------: | ----------: |
| 평균            |  1,639.13ms |  1,193.39ms | 27.19% 감소 |
| p50             |  1,520.51ms |  1,166.74ms | 23.27% 감소 |
| p95             |  2,389.70ms |  1,292.67ms | 45.91% 감소 |
| 최대            |  2,877.54ms |  1,353.91ms | 52.95% 감소 |
| 순차 처리량     | 0.610 req/s | 0.838 req/s | 37.38% 증가 |
| 성공·validation |        100% |        100% |        유지 |

자동 테스트는 36개에서 37개로 늘었고 모두 통과했다.

## 6. Phase 3 — DB 정규화, 검색 전용 컬럼, 2단계 quota 조회

### 남은 문제

애플리케이션 경로를 개선한 뒤에도 후보 검색은 요청마다 여러 `ILIKE OR` 조건과 `metadata::text` 검색을 수행했다. 데이터셋을 순차적으로 조회하면 SQL round trip이 늘고, 특정 대형 데이터셋이 결과를 독점할 수 있었다. 단순히 전체 후보 수를 줄이면 빠를 수는 있지만 작은 문화·관광 데이터셋이 사라져 추천 다양성이 훼손될 위험이 있었다.

### 스키마 정규화

`20260820_normalize_public_data_search.sql` migration으로 다음 컬럼을 추가·backfill했다.

- `district_name`: 정규화된 자치구 명칭
- `district_code`: 자치구 코드
- `region_search_text`: 지역 검색 전용 문자열
- `search_text`: 제목·주소·분류 등 후보 검색 전용 문자열

insert/update trigger가 파생 컬럼을 계속 유지하며, 자치구 exact-match, 자치구+데이터셋 정렬, 지역/검색 문서 trigram index를 추가했다.

### 단일 SQL의 2단계 후보 조회

1. `district_name` exact match로 검색 범위를 먼저 축소한다.
2. 요청 대상 데이터셋 목록을 기준으로 `CROSS JOIN LATERAL`을 실행한다.
3. 각 데이터셋에서 최대 12개 ID와 경량 컬럼만 선택한다.
4. 전체 최대 80개 후보로 합친다.
5. 최종 선택된 ID만 원본 행과 JOIN해 `pd.*`를 hydrate한다.
6. migration이 적용되지 않은 환경이나 지원하지 않는 source는 legacy fallback을 유지한다.

이 구조는 대형 데이터셋의 독점을 막는 quota와, 상세 JSON/metadata를 뒤늦게 읽는 late materialization을 결합한다.

### `EXPLAIN ANALYZE BUFFERS` 결과

대표 성수/성동구 요청에서 기존 10-query workload와 신규 단일 SQL을 비교했다.

| 지표              |      기존 | 정규화·quota SQL |              변화 |
| ----------------- | --------: | ---------------: | ----------------: |
| SQL 수            |        10 |                1 |          90% 감소 |
| 실행시간          | 301.317ms |         13.182ms |       95.63% 감소 |
| plan scan tuple   |   450,286 |           11,206 |       97.51% 감소 |
| shared hit block  |    29,105 |            2,009 |       93.10% 감소 |
| shared read block |    42,452 |               93 |       99.78% 감소 |
| 결과 후보         |         - |               55 |                 - |
| 대표 데이터셋     |         - |              6개 | quota 다양성 확보 |

### 40회 node 재측정

| 지표           | Phase 2 이후 | DB 정규화 이후 |        변화 |
| -------------- | -----------: | -------------: | ----------: |
| 후보 node 평균 |      53.81ms |        16.32ms | 69.67% 감소 |
| 후보 node p95  |     136.38ms |        33.17ms | 75.68% 감소 |

최초 baseline과 비교하면 후보 node 평균은 85.40ms에서 16.32ms로 80.89% 감소했다.

DB 정규화 측정 회차의 전체 graph는 평균 1,231.25ms, p50 1,170.58ms, p95 1,303.38ms, 처리량 0.812 req/s였다. 최초 baseline 대비 평균 24.88%, p95 45.46% 감소하고 처리량은 33.11% 증가했다. 다만 Phase 2 최선 평균 1,193.39ms보다 37.86ms 느렸다. 같은 회차의 `fetchContextData`가 1,193.89ms로 변동했기 때문에 이를 DB 회귀로 해석하지 않는다. DB 개선 효과는 context 변동과 분리된 후보 node 및 `EXPLAIN` 수치로 판단한다.

### 품질 재검증

20개 지역을 다시 실행한 최종 direct 결과는 다음과 같다.

- 성공 20/20, validation 100%
- 예산·시간·DB grounding·추천 좌표·지역 alias 일치 각각 100%
- 평균 후보 25.75개, 평균 후보 데이터셋 2.7개
- 전체 graph 평균 1,195ms, p50 1,179ms, p95 1,259ms, 최대 1,347ms

## 7. Phase 4 — 속도와 추천 다양성의 균형

### 별도 검증이 필요했던 이유

데이터셋 quota는 후보군의 출처 다양성을 보장할 뿐, 사용자에게 반환하는 최종 코스의 다양성을 자동으로 보장하지 않는다. 기존 방식은 이미 사용한 모든 장소를 전역 제외해 코스 간 중복은 0이었지만 후보가 적은 지역에서는 variant 자체가 사라졌다.

### 개선 전 다양성

- 10개 지역 평균 variant: 2.9개
- 4개 variant 반환 지역: 0/10
- 고유 장소 비율: 100%
- 평균 pairwise Jaccard: 0
- 평균 category entropy: 1.6552
- 평균 category 수: 3.5개

### 구현

1. mood 요청도 mood variant 뒤에 `best`, `balanced`, `indoor`, `low-budget` 목적을 중복 제거하며 최대 4개까지 보충했다.
2. 단순 최고점 정렬 대신 MMR을 적용했다.

```text
MMR = λ × relevance
      - (1 - λ) × maxSimilarity(selected, candidate)
      + variantObjectiveBonus
```

3. similarity는 같은 역할 0.35, 같은 source dataset 0.15, 같은 가격대 0.15, 같은 실내외 0.15, 거리 500m 이내 0.20 또는 1,200m 이내 0.10으로 계산했다.
4. relevance를 더 중시하는 `best`는 λ=0.78, 다양성을 더 중시하는 `balanced`는 0.52, 그 외 variant는 0.64를 사용했다.
5. indoor·low-budget·mood·근거리 목적별 bonus를 추가했다.
6. 기존 “전역 사용 장소와 겹치면 제거”를 코스 쌍별 Jaccard 검사로 교체하고, 어느 쌍이든 0.5 이상이면 거부했다.
7. 후보가 부족할 때는 장소 재사용을 완전히 금지하지 않고 global-used penalty 0.4를 부과했다.
8. benchmark helper와 실제 API service가 같은 variant builder를 사용하도록 연결해 측정용 코드와 운영 로직의 차이를 없앴다.

### 전후 결과

| 지표                  |     개선 전 |   개선 후 |           변화 |
| --------------------- | ----------: | --------: | -------------: |
| 평균 variant          |         2.9 |       3.9 |    34.48% 증가 |
| 4개 variant 지역      |        0/10 |      9/10 |      +9개 지역 |
| 고유 장소 비율        |        100% |    98.33% |    1.67%p 감소 |
| 평균 pairwise Jaccard |           0 |    0.0111 | 낮은 중복 유지 |
| 평균 category entropy |      1.6552 |    1.6928 |     2.27% 증가 |
| 평균 category 수      |         3.5 |       3.6 |     2.86% 증가 |
| 예산·시간 준수        | 측정 미포함 | 각각 100% | guardrail 확인 |

망원은 후보가 6개뿐이어서 중복 장소로 억지로 4개를 만들지 않고 3개를 반환했다. 평균 고유 장소 비율의 소폭 하락은 코스 수를 늘리는 과정에서 망원 한 지역이 장소 1개를 재사용한 결과이며, 전체 pairwise Jaccard 0.0111과 함께 해석해야 한다.

자동 테스트는 37개에서 39개로 늘었다. mood가 있어도 최대 4개 목적 variant를 구성하는지, 같은 역할·출처 후보가 더 높은 MMR similarity를 갖는지를 추가 검증했다.

## 8. 최종 품질 게이트

| 검증                           | 최종 결과                   |
| ------------------------------ | --------------------------- |
| 결정론적 테스트                | 39/39 통과                  |
| TypeScript build               | 성공                        |
| ESLint                         | error 0건, 기존 warning 4건 |
| 20개 지역 direct graph         | 20/20 성공                  |
| validation·예산·시간           | 각각 100%                   |
| DB 실재성·추천 좌표·지역 alias | 각각 100%                   |
| 다양성 10개 시나리오 예산·시간 | 각각 100%                   |

기존 ESLint warning은 미사용 선언 `summarizeCityDataWeather`, `matchKakaoUrlsForDatasets`, `syncPermitSingleDataset`, `FOOD_TITLE_RULES` 4건이며 이번 성능 변경에서 새 error는 추가되지 않았다.

## 9. 지표 정의

- **평균 latency**: 측정 요청 wall-clock latency의 산술평균
- **p50/p95**: 정렬된 표본의 50/95 백분위 지연시간
- **순차 처리량**: 단일 프로세스 순차 실행에서 초당 완료한 요청 수. 동시 사용자 처리량과 같지 않다.
- **validation 통과율**: 추천 graph의 최종 validator가 error 없이 통과한 비율
- **DB grounding**: 추천 장소 ID가 benchmark DB의 실제 행과 일치하는 비율
- **plan scan tuple**: PostgreSQL 실행 계획 각 scan node의 방문 row 추정/실측치를 집계한 비교 지표
- **고유 장소 비율**: 모든 variant 배치 장소 중 고유 place ID 비율
- **pairwise Jaccard**: 두 코스 장소 집합의 `교집합 / 합집합`; 모든 코스 쌍의 평균
- **category entropy**: category 분포의 Shannon entropy. 같은 배치 수에서는 높을수록 범주 분산이 크다.

## 10. 재현 방법

PowerShell 기준이다.

```powershell
cd SeoulMate_BE
npm install
npm run benchmark:db:setup

$env:DATABASE_URL = ""
$env:DATABASE_SSL = "false"
$env:POSTGRES_HOST = "127.0.0.1"
$env:POSTGRES_PORT = "15433"
$env:POSTGRES_DB = "seoulmate_benchmark"
$env:POSTGRES_USER = "seoulmate"
$env:POSTGRES_PASSWORD = "seoulmate-local-only"
$env:OPENAI_API_KEY = ""
$env:KAKAO_REST_API_KEY = ""
$env:KMA_API_KEY = ""

npm run sync:public-data
npm run normalize:categories
npm test
npm run benchmark:direct

$env:BENCHMARK_WARMUP = "5"
$env:BENCHMARK_RUNS = "40"
$env:BENCHMARK_LABEL = "performance-reproduction"
npm run benchmark:performance

npm run benchmark:explain
$env:BENCHMARK_LABEL = "diversity-reproduction"
npm run benchmark:diversity
```

동일 비교에서는 DB 데이터, 시나리오, warm-up, 실행 횟수, provider key 상태를 고정해야 한다. 로컬 background process와 Docker resource contention도 결과에 영향을 줄 수 있으므로 여러 회차를 수행하고 p50·p95를 함께 보는 것이 좋다.

## 11. 근거 자료와 구현 위치

### 원본 측정 결과

- [최종 20개 지역 품질 측정](../reports/benchmark/direct-local.json)
- [최종 20개 지역 사람이 읽는 보고서](../reports/benchmark/direct-local.md)
- [LangGraph 성능 개선 전](../reports/benchmark/performance-before.json)
- [LangGraph 성능 개선 후](../reports/benchmark/performance-after.json)
- [DB 정규화 후 성능](../reports/benchmark/performance-normalized-db.json)
- [후보 SQL EXPLAIN 비교](../reports/benchmark/candidate-explain.json)
- [다양성 개선 전](../reports/benchmark/diversity-before.json)
- [다양성 개선 후](../reports/benchmark/diversity-after.json)

### 주요 코드

- `scripts/benchmarkRecommendationDirect.mjs`: 20개 지역 품질 benchmark
- `scripts/benchmarkRecommendationPerformance.mjs`: 노드별 40회 성능 benchmark
- `scripts/explainRecommendationCandidates.mjs`: 기존/신규 후보 SQL 실행계획 비교
- `scripts/benchmarkCourseDiversity.mjs`: variant 수·중복·entropy 측정
- `src/graphs/nodes/parseUserRequest.node.ts`: 구조화 preset parsing 우회
- `src/graphs/nodes/fetchContextData.node.ts`: 독립 context 병렬화
- `src/repositories/publicData.repository.ts`: 정규화·quota 기반 2단계 후보 조회
- `src/services/recommendation.service.ts`: 실제 API와 공유하는 MMR variant builder
- `db/migrations/20260820_normalize_public_data_search.sql`: 검색 컬럼·trigger·index

### 단계별 커밋

| 커밋      | Phase | 내용                                 |
| --------- | ----- | ------------------------------------ |
| `f8e465e` | 0~1   | 정량 추천 benchmark와 품질 검증      |
| `4e16873` | 0     | 서버 없는 로컬 direct benchmark      |
| `fb43008` | 2     | LangGraph latency와 DB scan 1차 개선 |
| `c2c038b` | 3     | 검색 정규화와 dataset quota SQL      |
| `6e2e55d` | 4     | MMR 기반 코스 variant 다양화         |

## 12. 한계와 다음 운영 검증

이 결과는 로컬에서 알고리즘과 DB 경로를 분리해 검증한 수치다. 다음 항목을 증명하지는 않는다.

- Nginx, Express, 인증, TLS, 실제 네트워크를 포함한 운영 HTTP E2E latency
- 실제 OpenAI·Kakao·기상 API의 응답시간과 rate limit 영향
- 동시 사용자 부하에서의 최대 처리량과 connection pool 포화점
- RDS instance class, IOPS, Multi-AZ 전환 상황의 성능
- 장소의 현재 영업 여부. DB grounding과 좌표 존재는 실시간 영업을 보장하지 않는다.
- 사용자가 느끼는 주관적 만족도. entropy와 Jaccard는 다양성의 proxy다.

운영 환경이 준비되면 같은 요청 세트를 HTTP 계층에서 30~100회 실행하고 concurrency 단계별 p50/p95/p99, error rate, DB connection wait, CPU·memory, external provider latency를 측정해야 한다. 추천 품질은 코스 선택률, 저장률, 장소 클릭률, 완주율, 반복 노출률, 추천 후 이탈률을 event로 수집해 검증해야 한다.

## 13. 포트폴리오 요약 문장

> 17만 2,821건의 9개 서울 공공데이터를 PostgreSQL 16에 적재하고 LangGraph 노드별 latency와 SQL 실행계획을 계측했다. 구조화 입력의 중복 parsing 제거, 독립 context I/O 병렬화, 검색 컬럼 정규화, 데이터셋 quota 기반 2단계 단일 SQL을 적용해 전체 graph 평균 latency 27.19%, p95 45.91%를 줄이고 순차 처리량을 37.38% 높였다. 대표 후보 SQL은 10개에서 1개로, 실행시간은 301.317ms에서 13.182ms로 줄였으며 plan scan tuple을 97.51% 감소시켰다. 성능 최적화로 추천 다양성이 손상되지 않도록 MMR과 variant 목적함수를 추가해 평균 코스 수를 2.9개에서 3.9개로 늘리고 평균 코스 간 Jaccard 0.0111, 예산·시간 준수율 100%를 유지했다.
