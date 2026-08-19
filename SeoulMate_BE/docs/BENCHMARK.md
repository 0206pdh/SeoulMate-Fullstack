# SeoulMate 정량 검증

측정하지 못한 값을 추정하거나 포트폴리오 수치로 사용하지 않는다.

## 현재 검증 결과

측정일: 2026-08-19

| 검증                   |                  결과 | 범위                                                                     |
| ---------------------- | --------------------: | ------------------------------------------------------------------------ |
| TypeScript compilation |                  성공 | 전체 backend source                                                      |
| 결정론적 자동 테스트   | **34/34 통과 (100%)** | 장소 수, role, KST, category, route fallback, scoring, signup validation |
| ESLint                 |             error 0건 | 전체 backend source                                                      |
| E2E 추천 benchmark     |             측정 보류 | 운영 EC2와 RDS tunnel 연결 불가                                          |

E2E 측정 시점에 `api.seoulmate.my`와 EC2 EIP가 timeout이었고 private RDS도 SSH tunnel 없이 접근할 수 없었다. 따라서 성공률이나 latency를 임의 값으로 기록하지 않았다.

## 결정론적 테스트

```bash
cd SeoulMate_BE
npm test
```

`npm test`는 TypeScript를 compile한 뒤 Node.js test runner로 34개 검증을 수행한다.

- 2~13시간 요청의 장소 수 경계값 7개
- 사용자 category를 course role로 변환하는 대표 사례 11개
- 동일 role 중복 제거와 KST 18시 전후 순서
- 공공데이터/Kakao category 정규화와 제외 category
- 좌표 기반 이동 거리·시간 fallback
- scoring 가중치 총합 100점
- 회원가입 입력 정규화와 validation

## 20개 E2E benchmark

```bash
cd SeoulMate_BE
npm run benchmark:recommendation
```

Endpoint 변경:

```powershell
$env:API_BASE_URL = "https://api.seoulmate.my/api"
npm run benchmark:recommendation
```

### 자동 산출 지표

| 지표             | 계산 방식                                              |
| ---------------- | ------------------------------------------------------ |
| 추천 성공률      | 첫 코스에 장소가 포함된 요청 / 전체 요청               |
| p50/p95 latency  | 추천 API end-to-end latency percentile                 |
| 예산 준수율      | `course.totalCost <= request.budget`                   |
| 시간 준수율      | `course.duration <= requested duration`                |
| DB 장소 실재성   | 응답의 `plc_<id>`가 `public_data.id`에 존재하는 비율   |
| 좌표 보유율      | 추천 장소 중 latitude/longitude가 모두 존재하는 비율   |
| Kakao 검증률     | Kakao URL 또는 match confidence 보유 비율              |
| 엄격 지역 일치율 | 장소명·region·주소에 요청 문자열이 포함되는 비율       |
| variant 다양성   | 코스 쌍의 Jaccard overlap이 0.5 미만인 요청 비율       |
| snapshot 일관성  | 추천과 상세조회에서 ID·비용·시간·장소 순서가 같은 비율 |
| 데이터 품질      | 전체 장소의 좌표·category·Kakao coverage               |

결과는 `reports/benchmark/<label>.json`과 `.md`로 생성된다. JSON에는 시나리오별 원시 측정값, Markdown에는 집계표가 저장된다.

### 일부 시나리오와 fallback 측정

```powershell
$env:BENCHMARK_LIMIT = "5"
$env:BENCHMARK_LABEL = "smoke"
npm run benchmark:recommendation
```

측정용 API 프로세스에만 무효 provider key를 적용하면 fallback 복구율도 측정할 수 있다.

```powershell
$env:PORT = "3101"
$env:OPENAI_API_KEY = "invalid-benchmark-key"
$env:KAKAO_REST_API_KEY = "invalid-benchmark-key"
npm start
```

다른 terminal에서:

```powershell
$env:API_BASE_URL = "http://127.0.0.1:3101/api"
$env:BENCHMARK_LIMIT = "5"
$env:BENCHMARK_LABEL = "provider-fallback"
npm run benchmark:recommendation
```

## DB 연결 조건

로컬 `.env`는 RDS를 `127.0.0.1:15432`로 접근하므로 benchmark 전에 tunnel이 필요하다.

```bash
ssh -N tunnel-rds
```

EC2 SSH, RDS tunnel, API health와 인증이 모두 정상이어야 전체 측정이 가능하다.

## 해석상의 한계

- 엄격 지역 일치율은 행정구역 동의어를 처리하지 않는다. “성수”와 “성동구”처럼 의미상 일치하지만 문자열이 다른 사례는 불일치로 집계될 수 있다.
- Kakao URL 보유는 장소 실재성의 근거지만 측정 당일 영업 여부를 보장하지 않는다.
- latency에는 외부 API와 원격 RDS의 네트워크 상태가 포함되므로 환경과 시각을 함께 기록해야 한다.
- 20건은 회귀 검증 표본이다. 통계적 일반화를 위해서는 더 큰 별도 평가 dataset이 필요하다.
