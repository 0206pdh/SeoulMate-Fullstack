# SeoulMate 정량 검증

측정하지 못한 값은 추정하지 않는다. 로컬 Direct benchmark와 운영 HTTP E2E의 범위를 분리해 기록한다.

## 2026-08-19 실측 결과

| 검증                   |                  결과 | 측정 범위                          |
| ---------------------- | --------------------: | ---------------------------------- |
| TypeScript compilation |                  성공 | 전체 backend source                |
| 결정론적 자동 테스트   | **39/39 통과 (100%)** | 추천 규칙, validation, 인증 입력   |
| ESLint                 |             error 0건 | 기존 unused warning 4건 제외       |
| Direct LangGraph       | **20/20 성공 (100%)** | 로컬 PostgreSQL, provider fallback |
| validation 통과율      |              **100%** | 최종 코스 validator                |
| 예산 / 시간 준수율     |       **100% / 100%** | 요청별 상한                        |
| DB 장소 실재성         |              **100%** | 추천 장소 ID와 `public_data` 대조  |
| 추천 좌표 보유율       |              **100%** | 추천 결과의 위·경도                |
| 지역 alias 일치율      |              **100%** | 동네명과 자치구 alias 포함         |
| 처리시간               |      평균 **1,195ms** | p50 1,179ms, p95 1,259ms           |

로컬 DB에는 공공데이터 **172,821건 / 9개 데이터셋**을 적재했다. category 정규화율은 **100%**, 자치구 정규화율은 **99.93%**, 검색 문서 생성률은 **100%**, 전체 장소 좌표 보유율은 **98.84%**다. 결과 원본은 [`direct-local.json`](../reports/benchmark/direct-local.json), 사람이 읽는 표는 [`direct-local.md`](../reports/benchmark/direct-local.md)에 보존한다.

## 서버 없이 재현하기

Docker Desktop과 Node.js 20이 필요하다. 운영 RDS나 Express 서버는 필요하지 않다.

```powershell
cd SeoulMate_BE
npm install
npm run benchmark:db:setup
```

`benchmark:db:setup`은 격리된 PostgreSQL 16 컨테이너를 `127.0.0.1:15433`에 만들고 migration을 순서대로 적용한다. 최초 한 번 공공데이터를 적재하고 category를 정규화한다.

```powershell
$env:DATABASE_URL = ""
$env:DATABASE_SSL = "false"
$env:POSTGRES_HOST = "127.0.0.1"
$env:POSTGRES_PORT = "15433"
$env:POSTGRES_DB = "seoulmate_benchmark"
$env:POSTGRES_USER = "seoulmate"
$env:POSTGRES_PASSWORD = "seoulmate-local-only"

npm run sync:public-data
npm run normalize:categories
```

공공데이터 수집에는 `.env`의 서울 열린데이터 API 설정이 필요하며 전체 수집은 네트워크 상황에 따라 수 분 걸린다. 이후 외부 provider를 끄고 graph를 직접 측정한다.

```powershell
$env:OPENAI_API_KEY = ""
$env:KAKAO_REST_API_KEY = ""
$env:KMA_API_KEY = ""
npm run benchmark:direct
```

이 runner는 `runRecommendationGraphWithoutAiExplanation`을 직접 호출한다. 따라서 HTTP listen, 로그인, Nginx가 없어도 후보 조회 → context fallback → scoring → 코스 구성 → validation → 대안 구성 흐름을 실제 DB 데이터로 실행한다.

컨테이너만 멈추려면 데이터 volume을 삭제하지 않는 다음 명령을 사용한다.

```powershell
docker compose -f docker-compose.benchmark.yml stop
```

## 측정 지표 정의

| 지표                | 계산 방식                                                               |
| ------------------- | ----------------------------------------------------------------------- |
| 추천 성공률         | 최종 코스에 장소가 포함된 시나리오 / 전체 시나리오                      |
| validation 통과율   | 최종 validator의 `isValid=true` 비율                                    |
| 예산 준수율         | `course.totalCost <= request.budget`                                    |
| 시간 준수율         | 장소 체류시간 + 구간 이동시간 합계가 요청 시간을 넘지 않는 비율         |
| DB 장소 실재성      | 추천 장소 ID가 `public_data.id`에 존재하는 비율                         |
| 추천 좌표 보유율    | 추천 장소 중 위도와 경도가 모두 있는 비율                               |
| 지역 alias 일치율   | 요청 지역을 자치구·동네 alias로 확장해 장소명·주소·region과 대조한 비율 |
| route fallback 비율 | 외부 경로 API 대신 좌표 기반 거리·시간 추정을 사용한 구간 비율          |
| latency             | 각 graph 호출의 wall-clock 시간; p50/p95 포함                           |

## 측정이 발견한 결함과 수정

첫 실행은 20/20 추천에 성공했지만 validation 통과율이 90%, 시간 준수율이 95%였다.

- `망원` 요청에 `마포구` 주소가 반환되면 후보 조회에서는 정상으로 보면서 validator는 단순 문자열 비교로 실패했다. 후보 조회의 `resolveRegion`과 `placeMatchesRegion`을 export해 validator도 같은 alias 정책을 재사용하도록 수정했다.
- validator가 예산과 지역은 확인하면서 장소 체류시간과 이동시간의 총합을 검사하지 않았다. 요청 시간 상한 검증을 추가하고 실패 시 대안 코스 노드가 보정하도록 했다.

수정 후 동일 데이터와 동일 20개 시나리오에서 validation과 시간 준수율이 모두 100%가 됐다. 두 회귀 조건은 자동 테스트에도 추가했다.

## 결정론적 테스트

```powershell
npm test
```

TypeScript compile 후 Node.js test runner가 다음 39개 조건을 검증한다.

- 2~13시간 요청별 장소 수 경계
- category → course role 변환과 중복 제거
- KST 18시 전후 방문 순서
- 공공데이터/Kakao category 정규화와 제외 규칙
- 좌표 기반 이동 거리·시간 fallback
- scoring 가중치 총합 100점
- 회원가입 정규화와 validation
- 지역 alias 검증과 요청 시간 초과 거부
- 완전한 구조화 입력의 외부 LLM parsing 생략
- mood 입력의 4개 목적 variant 구성
- 역할·데이터셋 기반 MMR 의미 유사도

## 운영 HTTP E2E

```powershell
$env:API_BASE_URL = "https://api.seoulmate.my/api"
npm run benchmark:recommendation
```

이 runner는 인증, Express, Nginx, 네트워크, 실제 외부 provider 지연까지 포함한다. 현재 운영 EC2와 private RDS tunnel에 연결할 수 없어 운영 E2E 수치는 보류했다. Direct benchmark의 1.195초를 운영 API latency로 해석하면 안 된다. 성능 최적화 전후 조건과 노드별 결과는 [PERFORMANCE.md](PERFORMANCE.md)에 정리했다.

## 해석상의 한계

- 20건은 회귀·스모크 표본이며 통계적 일반화를 위한 대규모 사용자 평가가 아니다.
- provider key를 끈 측정이므로 Kakao 경로 정확도나 실제 날씨 API 품질을 평가하지 않는다.
- latency는 로컬 장비, warm PostgreSQL, 단일 순차 실행 결과이며 부하 처리량이나 동시성 수치가 아니다.
- DB 실재성과 좌표 보유는 hallucination 방지의 근거지만 장소의 실시간 영업 여부를 보장하지 않는다.
- 추천의 주관적 만족도는 별도의 사용자 평가셋, 클릭·저장·완주율 같은 운영 지표가 필요하다.
