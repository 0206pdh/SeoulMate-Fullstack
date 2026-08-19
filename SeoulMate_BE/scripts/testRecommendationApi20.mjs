import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import pg from "pg";

const { Pool } = pg;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000/api";
const outputDir = path.resolve(process.env.BENCHMARK_OUTPUT_DIR ?? "reports/benchmark");
const scenarioLimit = Number(process.env.BENCHMARK_LIMIT ?? "20");
const scenarioStart = Number(process.env.START_INDEX ?? "0");
const runLabel = process.env.BENCHMARK_LABEL ?? "normal";

const unique = Date.now();
const credentials = {
  email: process.env.TEST_EMAIL ?? `benchmark_${unique}@example.com`,
  password: process.env.TEST_PASSWORD ?? "password123",
  nickname: `bm${String(unique).slice(-6)}`
};

const testCases = [
  ["성수", ["조용한", "부담 적은"], 30000, "half-day", "첫 데이트"],
  ["홍대", ["실내", "감성적인"], 40000, "half-day", "비 오는 날 데이트"],
  ["강남", ["활기찬", "대화하기 좋은"], 50000, "2h", "퇴근 후 데이트"],
  ["잠실", ["야경", "로맨틱한"], 60000, "half-day", "기념일 데이트"],
  ["종로", ["전통적인", "조용한"], 35000, "half-day", "첫 만남"],
  ["이태원", ["이국적인", "맛집"], 60000, "half-day", "저녁 데이트"],
  ["망원", ["편안한", "산책"], 30000, "half-day", "주말 데이트"],
  ["연남", ["감성적인", "카페"], 45000, "half-day", "대화 중심 데이트"],
  ["건대", ["활기찬", "가성비"], 35000, "2h", "가벼운 데이트"],
  ["명동", ["관광", "실내"], 50000, "half-day", "서울 구경 데이트"],
  ["북촌", ["전통적인", "산책"], 30000, "half-day", "천천히 걷는 데이트"],
  ["여의도", ["산책", "야경"], 40000, "half-day", "한강 데이트"],
  ["합정", ["조용한", "감성적인"], 35000, "half-day", "첫 데이트"],
  ["혜화", ["문화", "공연"], 50000, "half-day", "공연 전후 데이트"],
  ["신촌", ["가성비", "편안한"], 30000, "2h", "학생 데이트"],
  ["서울숲", ["산책", "카페"], 35000, "half-day", "낮 데이트"],
  ["압구정", ["세련된", "맛집"], 70000, "half-day", "기념일 데이트"],
  ["문래", ["감성적인", "문화"], 40000, "half-day", "사진 찍기 좋은 데이트"],
  ["청계천", ["산책", "부담 적은"], 25000, "2h", "가벼운 첫 만남"],
  ["DDP", ["실내", "전시"], 45000, "half-day", "전시 데이트"]
];

const durationMinutes = (duration) => {
  if (duration === "half-day") return 240;
  if (duration === "full-day") return 480;
  const match = duration.match(/^(\d+(?:\.\d+)?)h$/);
  return match ? Number(match[1]) * 60 : undefined;
};

const percentile = (values, ratio) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
};

const ratio = (numerator, denominator) =>
  denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : null;

const extractPlaceId = (id) => {
  const parsed = Number(String(id ?? "").replace(/^plc_/, ""));
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const pairwiseOverlap = (courses) => {
  const pairs = [];
  for (let left = 0; left < courses.length; left += 1) {
    for (let right = left + 1; right < courses.length; right += 1) {
      const a = new Set(courses[left].places.map((place) => place.id));
      const b = new Set(courses[right].places.map((place) => place.id));
      const intersection = [...a].filter((id) => b.has(id)).length;
      const union = new Set([...a, ...b]).size;
      pairs.push(union ? intersection / union : 0);
    }
  }
  return pairs;
};

const requestJson = async (endpoint, options = {}) => {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  const latencyMs = Math.round(performance.now() - startedAt);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${options.method ?? "GET"} ${endpoint}: ${response.status}`);
    error.status = response.status;
    error.body = body;
    error.latencyMs = latencyMs;
    throw error;
  }
  return { body, latencyMs };
};

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl:
          process.env.DATABASE_SSL === "true" && process.env.NODE_ENV !== "test"
            ? { rejectUnauthorized: false }
            : false
      }
    : {
        host: process.env.POSTGRES_HOST,
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        database: process.env.POSTGRES_DB,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        ssl:
          process.env.DATABASE_SSL === "true" && process.env.NODE_ENV !== "test"
            ? { rejectUnauthorized: false }
            : false
      }
);

const fetchPlaceEvidence = async (ids) => {
  if (!ids.length) return new Map();
  const result = await pool.query(
    `SELECT id, title, region, address, latitude, longitude,
            kakao_place_url, kakao_match_confidence, place_family
       FROM public_data
      WHERE id = ANY($1::bigint[])`,
    [ids]
  );
  return new Map(result.rows.map((row) => [Number(row.id), row]));
};

const fetchDataQuality = async () => {
  const result = await pool.query(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int AS coordinates,
           count(*) FILTER (WHERE place_family IS NOT NULL)::int AS normalized_categories,
           count(*) FILTER (WHERE kakao_place_url IS NOT NULL)::int AS kakao_urls,
           count(*) FILTER (WHERE kakao_match_confidence IS NOT NULL)::int AS kakao_confidence,
           count(DISTINCT source_dataset)::int AS datasets
      FROM public_data
  `);
  const row = result.rows[0];
  return {
    totalPlaces: Number(row.total),
    datasetCount: Number(row.datasets),
    coordinateCount: Number(row.coordinates),
    coordinateCoveragePct: ratio(Number(row.coordinates), Number(row.total)),
    normalizedCategoryCount: Number(row.normalized_categories),
    normalizedCategoryCoveragePct: ratio(Number(row.normalized_categories), Number(row.total)),
    kakaoUrlCount: Number(row.kakao_urls),
    kakaoUrlCoveragePct: ratio(Number(row.kakao_urls), Number(row.total)),
    kakaoConfidenceCount: Number(row.kakao_confidence),
    kakaoConfidenceCoveragePct: ratio(Number(row.kakao_confidence), Number(row.total))
  };
};

const authenticate = async () => {
  const endpoint = process.env.TEST_EMAIL ? "/auth/login" : "/auth/signup";
  const { body } = await requestJson(endpoint, {
    method: "POST",
    body: JSON.stringify(credentials)
  });
  return `Bearer ${body.accessToken}`;
};

const evaluateScenario = async (index, testCase, authorization, dateTime) => {
  const [region, vibes, budget, duration, purpose] = testCase;
  const query = `${region}에서 ${budget.toLocaleString("ko-KR")}원 이하로 ${vibes.join(", ")} ${purpose} 코스 추천해줘`;
  const request = { query, region, vibes, budget, duration, dateTime, purpose };

  try {
    const { body: recommendation, latencyMs } = await requestJson("/courses/recommend", {
      method: "POST",
      headers: { Authorization: authorization },
      body: JSON.stringify(request)
    });
    const courses = Array.isArray(recommendation.courses) ? recommendation.courses : [];
    const recommended = courses[0];
    const placeIds = courses
      .flatMap((course) => course.places ?? [])
      .map((place) => extractPlaceId(place.id))
      .filter(Boolean);
    const evidence = await fetchPlaceEvidence([...new Set(placeIds)]);
    const groundedCount = placeIds.filter((id) => evidence.has(id)).length;
    const coordinateCount = placeIds.filter((id) => {
      const row = evidence.get(id);
      return row?.latitude !== null && row?.longitude !== null;
    }).length;
    const kakaoVerifiedCount = placeIds.filter((id) => {
      const row = evidence.get(id);
      return Boolean(row?.kakao_place_url || row?.kakao_match_confidence !== null);
    }).length;
    const regionMatchedCount = placeIds.filter((id) => {
      const row = evidence.get(id);
      const searchable =
        `${row?.title ?? ""} ${row?.region ?? ""} ${row?.address ?? ""}`.toLowerCase();
      return searchable.includes(region.toLowerCase());
    }).length;
    const overlaps = pairwiseOverlap(courses);
    const maxOverlap = overlaps.length ? Math.max(...overlaps) : 0;

    let detailConsistency = null;
    let detailLatencyMs = null;
    if (recommended?.id) {
      const detail = await requestJson(`/courses/${recommended.id}`, {
        headers: { Authorization: authorization }
      });
      detailLatencyMs = detail.latencyMs;
      detailConsistency =
        detail.body.id === recommended.id &&
        detail.body.totalCost === recommended.totalCost &&
        detail.body.duration === recommended.duration &&
        JSON.stringify((detail.body.places ?? []).map((place) => place.id)) ===
          JSON.stringify((recommended.places ?? []).map((place) => place.id));
    }

    return {
      caseNo: index + 1,
      request,
      success: Boolean(recommended?.places?.length),
      status: 200,
      latencyMs,
      detailLatencyMs,
      courseCount: courses.length,
      recommendedPlaceCount: recommended?.places?.length ?? 0,
      totalPlaceReferences: placeIds.length,
      groundedCount,
      coordinateCount,
      kakaoVerifiedCount,
      regionMatchedCount,
      budgetCompliant: Boolean(recommended && recommended.totalCost <= budget),
      durationCompliant: Boolean(
        recommended && recommended.duration <= (durationMinutes(duration) ?? Infinity)
      ),
      uniqueVariants: new Set(
        courses.map((course) =>
          (course.places ?? [])
            .map((place) => place.id)
            .sort()
            .join("|")
        )
      ).size,
      maxVariantJaccardOverlap: Number(maxOverlap.toFixed(4)),
      diversityCompliant: maxOverlap < 0.5,
      detailConsistency,
      warnings: recommendation.warnings ?? []
    };
  } catch (error) {
    return {
      caseNo: index + 1,
      request,
      success: false,
      status: error.status ?? null,
      latencyMs: error.latencyMs ?? null,
      error: error.message,
      errorBody: error.body ?? null
    };
  }
};

const aggregate = (results, dataQuality) => {
  const successful = results.filter((result) => result.success);
  const latencies = results.map((result) => result.latencyMs).filter(Number.isFinite);
  const totalPlaceReferences = successful.reduce(
    (sum, result) => sum + result.totalPlaceReferences,
    0
  );
  const sum = (field) => successful.reduce((total, result) => total + (result[field] ?? 0), 0);
  const trueCount = (field) => successful.filter((result) => result[field] === true).length;
  const warningCount = successful.reduce((total, result) => total + result.warnings.length, 0);

  return {
    runLabel,
    apiBaseUrl: baseUrl,
    measuredAt: new Date().toISOString(),
    scenarioCount: results.length,
    successCount: successful.length,
    successRatePct: ratio(successful.length, results.length),
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : null,
      average: latencies.length
        ? Math.round(latencies.reduce((sumValue, value) => sumValue + value, 0) / latencies.length)
        : null,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null
    },
    budgetCompliancePct: ratio(trueCount("budgetCompliant"), successful.length),
    durationCompliancePct: ratio(trueCount("durationCompliant"), successful.length),
    groundedPlacePct: ratio(sum("groundedCount"), totalPlaceReferences),
    coordinateCoverageInRecommendationsPct: ratio(sum("coordinateCount"), totalPlaceReferences),
    kakaoVerificationPct: ratio(sum("kakaoVerifiedCount"), totalPlaceReferences),
    strictRegionMatchPct: ratio(sum("regionMatchedCount"), totalPlaceReferences),
    variantDiversityCompliancePct: ratio(trueCount("diversityCompliant"), successful.length),
    detailSnapshotConsistencyPct: ratio(trueCount("detailConsistency"), successful.length),
    averageCourseCount: successful.length
      ? Number(
          (
            successful.reduce((total, result) => total + result.courseCount, 0) / successful.length
          ).toFixed(2)
        )
      : null,
    warningCount,
    dataQuality
  };
};

const markdownReport = (summary, results) => `# SeoulMate Recommendation Benchmark

측정 시각: ${summary.measuredAt}

실행 구분: \`${summary.runLabel}\`

## 핵심 결과

| 지표 | 결과 |
| --- | ---: |
| 시나리오 | ${summary.scenarioCount}건 |
| 추천 성공률 | ${summary.successRatePct ?? "N/A"}% (${summary.successCount}/${summary.scenarioCount}) |
| 예산 준수율 | ${summary.budgetCompliancePct ?? "N/A"}% |
| 시간 준수율 | ${summary.durationCompliancePct ?? "N/A"}% |
| DB 장소 실재성 | ${summary.groundedPlacePct ?? "N/A"}% |
| 추천 장소 좌표 보유율 | ${summary.coordinateCoverageInRecommendationsPct ?? "N/A"}% |
| 추천 장소 Kakao 검증률 | ${summary.kakaoVerificationPct ?? "N/A"}% |
| 요청 지역 문자열 엄격 일치율 | ${summary.strictRegionMatchPct ?? "N/A"}% |
| variant 다양성 기준 충족률 | ${summary.variantDiversityCompliancePct ?? "N/A"}% |
| 상세조회 snapshot 일치율 | ${summary.detailSnapshotConsistencyPct ?? "N/A"}% |
| 평균 반환 코스 수 | ${summary.averageCourseCount ?? "N/A"}개 |
| 추천 latency p50 | ${summary.latencyMs.p50 ?? "N/A"}ms |
| 추천 latency p95 | ${summary.latencyMs.p95 ?? "N/A"}ms |
| 추천 latency 평균 | ${summary.latencyMs.average ?? "N/A"}ms |

## 데이터 품질

| 지표 | 결과 |
| --- | ---: |
| 적재 장소 | ${summary.dataQuality.totalPlaces.toLocaleString("ko-KR")}건 |
| source dataset | ${summary.dataQuality.datasetCount}개 |
| 좌표 보유율 | ${summary.dataQuality.coordinateCoveragePct}% |
| category 정규화율 | ${summary.dataQuality.normalizedCategoryCoveragePct}% |
| Kakao URL 매칭률 | ${summary.dataQuality.kakaoUrlCoveragePct}% |
| Kakao confidence 보유율 | ${summary.dataQuality.kakaoConfidenceCoveragePct}% |

## 시나리오별 결과

| # | 지역 | 성공 | latency | 코스 | 예산 | 시간 | 실재 장소 | 지역 일치 | 최대 variant 중복 |
| ---: | --- | :---: | ---: | ---: | :---: | :---: | ---: | ---: | ---: |
${results
  .map(
    (result) =>
      `| ${result.caseNo} | ${result.request.region} | ${result.success ? "O" : "X"} | ${result.latencyMs ?? "-"}ms | ${result.courseCount ?? 0} | ${result.budgetCompliant ? "O" : "X"} | ${result.durationCompliant ? "O" : "X"} | ${result.groundedCount ?? 0}/${result.totalPlaceReferences ?? 0} | ${result.regionMatchedCount ?? 0}/${result.totalPlaceReferences ?? 0} | ${result.maxVariantJaccardOverlap ?? "-"} |`
  )
  .join("\n")}

## 해석 시 주의사항

- 지역 일치율은 장소명·region·주소에 요청 문자열이 직접 포함되는지를 보는 보수적인 지표다. “성수” 요청에 “성동구” 주소가 반환되는 경우처럼 행정구역 의미는 맞지만 문자열이 다른 사례는 불일치로 집계될 수 있다.
- Kakao 검증률은 적재 데이터의 URL 또는 match confidence 보유 여부이며 측정 시점의 영업 여부를 보장하지 않는다.
- latency는 로컬 측정 환경에서 외부 API와 원격 RDS 왕복을 포함한 end-to-end 값이다.
`;

let exitCode = 0;
try {
  const authorization = await authenticate();
  const dateTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const selectedCases = testCases.slice(scenarioStart, scenarioStart + scenarioLimit);
  const results = [];

  for (const [offset, testCase] of selectedCases.entries()) {
    const index = scenarioStart + offset;
    process.stdout.write(`[${index + 1}/${testCases.length}] ${testCase[0]} 측정 중... `);
    const result = await evaluateScenario(index, testCase, authorization, dateTime);
    results.push(result);
    process.stdout.write(`${result.success ? "OK" : "FAIL"} (${result.latencyMs ?? "-"}ms)\n`);
  }

  const dataQuality = await fetchDataQuality();
  const summary = aggregate(results, dataQuality);
  const payload = { summary, results };
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, `${runLabel}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
  await writeFile(path.join(outputDir, `${runLabel}.md`), markdownReport(summary, results), "utf8");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.successRatePct !== 100) exitCode = 1;
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await pool.end();
  process.exitCode = exitCode;
}
