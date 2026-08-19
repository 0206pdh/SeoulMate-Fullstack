# SeoulMate 추천 성능 최적화

## 결론

로컬 PostgreSQL 172,821건과 동일한 10개 지역 시나리오를 사용해 warm-up 5회 후 40회를 순차 측정했다. 외부 provider key는 비워 fallback 경로를 사용했고 HTTP 서버와 인증 비용은 제외했다.

| 지표              |     개선 전 |     개선 후 |            변화 |
| ----------------- | ----------: | ----------: | --------------: |
| 평균 latency      |  1,639.13ms |  1,193.39ms | **27.19% 감소** |
| p50 latency       |  1,520.51ms |  1,166.74ms | **23.27% 감소** |
| p95 latency       |  2,389.70ms |  1,292.67ms | **45.91% 감소** |
| 최대 latency      |  2,877.54ms |  1,353.91ms | **52.95% 감소** |
| 순차 처리량       | 0.610 req/s | 0.838 req/s | **37.38% 증가** |
| 성공률            |        100% |        100% |            유지 |
| validation 통과율 |        100% |        100% |            유지 |

원본 측정값은 [`performance-before.json`](../reports/benchmark/performance-before.json)과 [`performance-after.json`](../reports/benchmark/performance-after.json)에 있다.

## 노드별 병목 분석

| LangGraph node         | 개선 전 평균 | 개선 후 평균 |            변화 |
| ---------------------- | -----------: | -----------: | --------------: |
| `parseUserRequest`     |     169.82ms |       0.08ms | **99.95% 감소** |
| `fetchCandidatePlaces` |      85.40ms |      53.81ms | **36.99% 감소** |
| `fetchContextData`     |   1,359.06ms |   1,118.10ms | **17.73% 감소** |
| `scorePlaces`          |       1.57ms |       1.07ms |     31.85% 감소 |
| `buildCourse`          |      23.12ms |      20.19ms |     12.67% 감소 |

나머지 node는 평균 0.1ms 미만이라 최적화 대상에서 제외했다.

## 적용한 최적화

### 완전한 구조화 입력의 LLM parsing 생략

API body에서 지역·예산·시간·분위기·목적이 이미 typed 값으로 전달된 경우에도 `parseUserRequest`가 OpenAI를 호출하고 있었다. 완전한 preset이면 heuristic 결과와 preset을 즉시 병합하고, 자연어 해석이 필요한 요청에만 LLM을 사용하도록 경계를 변경했다.

### 독립적인 context I/O 병렬화

서울 실시간 도시데이터, 기상 예보, 생활인구는 서로의 결과에 의존하지 않지만 순차 호출되고 있었다. 각 작업의 개별 fallback과 warning 정책은 유지하면서 `Promise.all`로 동시에 실행했다. 가장 느린 provider 시간만 critical path에 남게 된다.

### 1차 개선: 충분한 후보가 있으면 보강 쿼리 생략

기존에는 기본 후보가 80건 확보되어도 데이터셋별 다양성 보강 쿼리를 최대 9개 더 실행했다. 기본 후보가 40건 이상이면 보강 조회를 생략하고, 후보가 부족한 지역에서만 기존 병렬 보강 쿼리를 실행한다.

window function으로 9개 쿼리를 한 번에 합치는 시도도 측정했지만 후보 node 평균이 85.40ms에서 105.69ms로 악화되어 폐기했다. 최적화는 코드 모양이 아니라 실측 결과를 기준으로 선택했다.

### 1차 개선: 후보 검색 인덱스

정규화된 후보 검색 필드와 최신 데이터 정렬을 위해 `place_family`, `place_type`, `place_subtype` GIN trigram index와 `(source_dataset, updated_at DESC, id DESC)` B-tree index를 migration으로 추가했다.

대표 `성수 / 성동구` 요청을 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`으로 비교한 결과다.

| 지표              | 기존 후보 조회 묶음 | 최적화 후 |            변화 |
| ----------------- | ------------------: | --------: | --------------: |
| SQL query 수      |                  10 |         1 |    **90% 감소** |
| plan scan tuple   |             450,286 |    11,206 | **97.51% 감소** |
| shared hit block  |              29,105 |     2,009 | **93.10% 감소** |
| DB execution 합계 |            301.32ms |   13.18ms | **95.63% 감소** |

이 수치는 대표 지역 한 건의 PostgreSQL 실행계획 비교이며 모든 지역의 평균값은 아니다. 단일 SQL 결과 55개에는 6개 데이터셋이 포함됐다. 원본은 [`candidate-explain.json`](../reports/benchmark/candidate-explain.json)에 있다.

## 2차 개선: DB 정규화와 2단계 후보 조회

1차 개선은 중복 SQL을 줄였지만 여러 `ILIKE OR`와 `metadata::text` 검색이 남아 있었다. 이를 적재 시점 정규화와 가벼운 ID 선별 구조로 교체했다.

### 적재 시 유지되는 정규화 컬럼

| 컬럼                 | 역할                                                       |
| -------------------- | ---------------------------------------------------------- |
| `district_name`      | 주소·region에서 추출한 서울 25개 자치구 이름               |
| `district_code`      | 행정표준코드 기반 5자리 자치구 코드                        |
| `region_search_text` | 지역·주소·제목을 합친 지역 alias 검색 문서                 |
| `search_text`        | 제목·category taxonomy·선별 metadata를 합친 후보 검색 문서 |

DB trigger가 insert/update 때 네 컬럼을 갱신하므로 API 요청마다 JSON을 문자열로 변환하지 않는다. 기존 172,821건도 migration에서 backfill했다.

- 자치구 정규화: 172,693/172,821건, **99.93%**
- 검색 문서 생성: 172,821/172,821건, **100%**
- 확인된 자치구: 서울 25개 전체

### exact region → quota ID → hydrate

```text
district_name exact match
  → source_dataset별 LATERAL subquery
  → 데이터셋별 최대 12개 ID 선정
  → 전체 상위 80개 ID 확정
  → 선택된 ID만 public_data 상세 행 JOIN
```

이 방식은 하나의 SQL statement 안에서 두 단계를 수행한다. 큰 JSON metadata를 후보 선별 전에 읽지 않고, `source_dataset`별 quota로 대형 음식점 데이터가 결과 전체를 독점하지 못하게 한다. 정규화되지 않은 지역이나 source 목록이 없는 특수 검색은 기존 검색을 fallback으로 유지한다.

### DB node 반복 측정

동일한 warm-up 5회 + 40회 측정에서 `fetchCandidatePlaces` 평균은 **53.81ms → 16.32ms(69.67% 감소)**, p95는 **136.38ms → 33.17ms(75.68% 감소)**했다. 전체 graph는 외부 context fallback 변동의 영향을 받아 1차 최적화본보다 평균이 3.17% 높았지만, 최초 baseline과 비교하면 다음 수준을 유지했다.

| 전체 graph 지표 | 최초 baseline | DB 정규화 후 |            변화 |
| --------------- | ------------: | -----------: | --------------: |
| 평균 latency    |    1,639.13ms |   1,231.25ms | **24.88% 감소** |
| p95 latency     |    2,389.70ms |   1,303.38ms | **45.46% 감소** |
| 순차 처리량     |   0.610 req/s |  0.812 req/s | **33.11% 증가** |

원본은 [`performance-normalized-db.json`](../reports/benchmark/performance-normalized-db.json)에 있다.

## 품질 회귀 확인

최적화 후 별도의 서울 20개 지역 direct benchmark도 다시 실행했다.

- 성공·validation·예산·시간·DB 실재성·추천 좌표·지역 alias 일치율: 모두 100%
- 평균 1,195ms, p50 1,179ms, p95 1,259ms
- 평균 후보 25.75개, 평균 2.7개 데이터셋이며 20개 시나리오 모두 코스를 정상 생성
- 자동 테스트 39/39 통과

## 재현 방법

```powershell
$env:BENCHMARK_WARMUP = "5"
$env:BENCHMARK_RUNS = "40"
$env:BENCHMARK_LABEL = "performance-after"
npm run benchmark:performance
npm run benchmark:explain
```

DB 환경변수와 provider fallback 설정은 [BENCHMARK.md](BENCHMARK.md)를 따른다.

## 해석 범위

- 이 결과는 단일 로컬 장비의 순차 실행이다. 동시 사용자 처리량이나 운영 네트워크 latency가 아니다.
- 외부 provider key를 비웠으므로 실제 OpenAI·Kakao·기상청 응답시간은 포함하지 않는다.
- 완전한 구조화 입력에서 parsing 생략 효과가 크며, 자연어만 전달하는 요청은 계속 LLM parsing 비용이 발생한다.
- 운영 성능 주장은 Nginx와 Express를 포함한 부하 테스트를 별도로 수행한 뒤 갱신해야 한다.
