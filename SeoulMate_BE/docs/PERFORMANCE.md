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

### 충분한 후보가 있으면 보강 쿼리 생략

기존에는 기본 후보가 80건 확보되어도 데이터셋별 다양성 보강 쿼리를 최대 9개 더 실행했다. 기본 후보가 40건 이상이면 보강 조회를 생략하고, 후보가 부족한 지역에서만 기존 병렬 보강 쿼리를 실행한다.

window function으로 9개 쿼리를 한 번에 합치는 시도도 측정했지만 후보 node 평균이 85.40ms에서 105.69ms로 악화되어 폐기했다. 최적화는 코드 모양이 아니라 실측 결과를 기준으로 선택했다.

### 후보 검색 인덱스

정규화된 후보 검색 필드와 최신 데이터 정렬을 위해 `place_family`, `place_type`, `place_subtype` GIN trigram index와 `(source_dataset, updated_at DESC, id DESC)` B-tree index를 migration으로 추가했다.

대표 `성수 / 성동구` 요청을 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`으로 비교한 결과다.

| 지표              | 기존 후보 조회 묶음 | 최적화 후 |            변화 |
| ----------------- | ------------------: | --------: | --------------: |
| SQL query 수      |                  10 |         1 |    **90% 감소** |
| plan scan tuple   |             449,789 |   172,821 | **61.58% 감소** |
| shared hit block  |              39,867 |    15,526 | **61.06% 감소** |
| DB execution 합계 |            304.71ms |  121.19ms | **60.23% 감소** |

이 수치는 대표 지역 한 건의 PostgreSQL 실행계획 비교이며 모든 지역의 평균값은 아니다. 원본은 [`candidate-explain.json`](../reports/benchmark/candidate-explain.json)에 있다.

## 품질 회귀 확인

최적화 후 별도의 서울 20개 지역 direct benchmark도 다시 실행했다.

- 성공·validation·예산·시간·DB 실재성·추천 좌표·지역 alias 일치율: 모두 100%
- 평균 1,245ms, p50 1,215ms, p95 1,415ms
- 평균 후보 54.95개로 감소했지만 20개 시나리오 모두 코스를 정상 생성
- 자동 테스트 37/37 통과

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
