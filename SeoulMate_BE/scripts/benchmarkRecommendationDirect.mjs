import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scenarios = [
  ["성수", ["조용한", "부담 적은"], 30000, 4, "첫 데이트"],
  ["홍대", ["실내", "감성적인"], 40000, 4, "비 오는 날 데이트"],
  ["강남", ["활기찬", "대화하기 좋은"], 50000, 2, "퇴근 후 데이트"],
  ["잠실", ["야경", "로맨틱한"], 60000, 4, "기념일 데이트"],
  ["종로", ["전통적인", "조용한"], 35000, 4, "첫 만남"],
  ["이태원", ["이국적인", "맛집"], 60000, 4, "저녁 데이트"],
  ["망원", ["편안한", "산책"], 30000, 4, "주말 데이트"],
  ["연남", ["감성적인", "카페"], 45000, 4, "대화 중심 데이트"],
  ["건대", ["활기찬", "가성비"], 35000, 2, "가벼운 데이트"],
  ["명동", ["관광", "실내"], 50000, 4, "서울 구경 데이트"],
  ["북촌", ["전통적인", "산책"], 30000, 4, "천천히 걷는 데이트"],
  ["여의도", ["산책", "야경"], 40000, 4, "한강 데이트"],
  ["합정", ["조용한", "감성적인"], 35000, 4, "첫 데이트"],
  ["혜화", ["문화", "공연"], 50000, 4, "공연 전후 데이트"],
  ["신촌", ["가성비", "편안한"], 30000, 2, "학생 데이트"],
  ["서울숲", ["산책", "카페"], 35000, 4, "낮 데이트"],
  ["압구정", ["세련된", "맛집"], 70000, 4, "기념일 데이트"],
  ["문래", ["감성적인", "문화"], 40000, 4, "사진 찍기 좋은 데이트"],
  ["청계천", ["산책", "부담 적은"], 25000, 2, "가벼운 첫 만남"],
  ["DDP", ["실내", "전시"], 45000, 4, "전시 데이트"]
];

const ratio = (numerator, denominator) =>
  denominator ? Number(((numerator / denominator) * 100).toFixed(2)) : null;

const percentile = (values, percentileRatio) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileRatio) - 1)];
};

const normalizeRegionAliases = (region) => {
  const aliases = {
    성수: ["성수", "성동구"],
    홍대: ["홍대", "마포구", "서교동"],
    강남: ["강남", "강남구"],
    잠실: ["잠실", "송파구"],
    종로: ["종로", "종로구"],
    이태원: ["이태원", "용산구"],
    망원: ["망원", "마포구"],
    연남: ["연남", "마포구"],
    건대: ["건대", "광진구"],
    명동: ["명동", "중구"],
    북촌: ["북촌", "종로구"],
    여의도: ["여의도", "영등포구"],
    합정: ["합정", "마포구"],
    혜화: ["혜화", "종로구"],
    신촌: ["신촌", "서대문구", "마포구"],
    서울숲: ["서울숲", "성동구"],
    압구정: ["압구정", "강남구"],
    문래: ["문래", "영등포구"],
    청계천: ["청계천", "종로구", "중구"],
    DDP: ["ddp", "동대문디자인플라자", "중구"]
  };
  return aliases[region] ?? [region];
};

const reportMarkdown = (summary, results) => `# SeoulMate Direct LangGraph Benchmark

측정 시각: ${summary.measuredAt}

HTTP 서버 없이 로컬 PostgreSQL과 compiled LangGraph를 직접 호출한 결과다. OpenAI, Kakao, 기상청 key를 비운 provider-fallback 조건에서 실행했다.

## 결과

| 지표 | 값 |
| --- | ---: |
| 시나리오 | ${summary.scenarioCount}건 |
| 성공률 | ${summary.successRatePct}% (${summary.successCount}/${summary.scenarioCount}) |
| validation 통과율 | ${summary.validationPassRatePct}% |
| 예산 준수율 | ${summary.budgetCompliancePct}% |
| 시간 준수율 | ${summary.durationCompliancePct}% |
| DB 장소 실재성 | ${summary.groundedPlacePct}% |
| 좌표 보유율 | ${summary.coordinateCoveragePct}% |
| 지역 alias 일치율 | ${summary.regionAliasMatchPct}% |
| fallback route 사용률 | ${summary.routeFallbackRatePct}% |
| 평균 후보 수 | ${summary.averageCandidateCount}개 |
| 처리시간 평균 | ${summary.latencyMs.average}ms |
| 처리시간 p50 | ${summary.latencyMs.p50}ms |
| 처리시간 p95 | ${summary.latencyMs.p95}ms |

## 로컬 데이터

| 지표 | 값 |
| --- | ---: |
| 장소 | ${summary.dataQuality.totalPlaces.toLocaleString("ko-KR")}건 |
| 데이터셋 | ${summary.dataQuality.datasetCount}개 |
| category 정규화율 | ${summary.dataQuality.normalizedCategoryCoveragePct}% |
| 좌표 보유율 | ${summary.dataQuality.coordinateCoveragePct}% |

## 시나리오

| # | 지역 | 성공 | validation | 후보 | 장소 | 예산 | 시간 | 지역 | latency |
| ---: | --- | :---: | :---: | ---: | ---: | :---: | :---: | ---: | ---: |
${results
  .map(
    (result) =>
      `| ${result.caseNo} | ${result.region} | ${result.success ? "O" : "X"} | ${result.validationPassed ? "O" : "X"} | ${result.candidateCount} | ${result.placeCount} | ${result.budgetCompliant ? "O" : "X"} | ${result.durationCompliant ? "O" : "X"} | ${result.regionMatchedCount}/${result.placeCount} | ${result.latencyMs}ms |`
  )
  .join("\n")}
`;

const main = async () => {
  const [{ runRecommendationGraphWithoutAiExplanation }, { db }] = await Promise.all([
    import("../dist/graphs/recommendation.graph.js"),
    import("../dist/config/db.js")
  ]);

  const results = [];
  const targetDateTime = "2026-08-22T06:00:00.000Z";

  try {
    for (const [index, [region, mood, budget, durationHours, purpose]] of scenarios.entries()) {
      const rawInput = `${region}에서 ${budget}원 이하로 ${mood.join(", ")} ${purpose} 코스`;
      const startedAt = performance.now();
      let state;
      let error;
      try {
        state = await runRecommendationGraphWithoutAiExplanation(rawInput, {
          region,
          budget,
          dateTime: targetDateTime,
          durationHours,
          mood,
          purpose
        });
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
      const latencyMs = Math.round(performance.now() - startedAt);
      const places = state?.course?.places ?? [];
      const ids = places.map((place) => place.placeId);
      const evidence = ids.length
        ? await db.query(
            `SELECT id, title, region, address, latitude, longitude
               FROM public_data
              WHERE id = ANY($1::bigint[])`,
            [ids]
          )
        : { rows: [] };
      const evidenceById = new Map(evidence.rows.map((row) => [Number(row.id), row]));
      const aliases = normalizeRegionAliases(region).map((alias) => alias.toLowerCase());
      const groundedCount = ids.filter((id) => evidenceById.has(id)).length;
      const coordinateCount = ids.filter((id) => {
        const row = evidenceById.get(id);
        return row?.latitude !== null && row?.longitude !== null;
      }).length;
      const regionMatchedCount = ids.filter((id) => {
        const row = evidenceById.get(id);
        const text = `${row?.title ?? ""} ${row?.region ?? ""} ${row?.address ?? ""}`.toLowerCase();
        return aliases.some((alias) => text.includes(alias));
      }).length;
      const totalDuration = places.reduce(
        (sum, place) => sum + place.estimatedTimeMinute + (place.moveTimeMinute ?? 0),
        0
      );

      results.push({
        caseNo: index + 1,
        region,
        success: places.length > 0,
        validationPassed: state?.validation?.isValid === true,
        validationErrors: state?.validation?.errors ?? [],
        validationWarnings: state?.validation?.warnings ?? [],
        candidateCount: state?.candidatePlaces?.length ?? 0,
        placeCount: places.length,
        estimatedBudget: state?.course?.estimatedBudget ?? null,
        totalDurationMinute: totalDuration,
        budgetCompliant: Boolean(state?.course && state.course.estimatedBudget <= budget),
        durationCompliant: places.length > 0 && totalDuration <= durationHours * 60,
        groundedCount,
        coordinateCount,
        regionMatchedCount,
        routeFallback: state?.contextData?.route?.isFallback === true,
        weatherSource: state?.contextData?.weather?.source ?? "unavailable",
        warningCount: state?.warnings?.length ?? 0,
        error: error ?? null,
        latencyMs
      });
      process.stdout.write(
        `[${index + 1}/${scenarios.length}] ${region}: ${places.length ? "OK" : "FAIL"} (${latencyMs}ms)\n`
      );
    }

    const dataResult = await db.query(`
      SELECT count(*)::int AS total,
             count(DISTINCT source_dataset)::int AS datasets,
             count(*) FILTER (WHERE place_family IS NOT NULL)::int AS normalized,
             count(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int AS coordinates
        FROM public_data
    `);
    const data = dataResult.rows[0];
    const successful = results.filter((result) => result.success);
    const totalPlaces = successful.reduce((sum, result) => sum + result.placeCount, 0);
    const trueCount = (field) => successful.filter((result) => result[field] === true).length;
    const latencies = results.map((result) => result.latencyMs);
    const sum = (field) => successful.reduce((total, result) => total + result[field], 0);
    const summary = {
      measuredAt: new Date().toISOString(),
      mode: "direct-provider-fallback",
      scenarioCount: results.length,
      successCount: successful.length,
      successRatePct: ratio(successful.length, results.length),
      validationPassRatePct: ratio(trueCount("validationPassed"), successful.length),
      budgetCompliancePct: ratio(trueCount("budgetCompliant"), successful.length),
      durationCompliancePct: ratio(trueCount("durationCompliant"), successful.length),
      groundedPlacePct: ratio(sum("groundedCount"), totalPlaces),
      coordinateCoveragePct: ratio(sum("coordinateCount"), totalPlaces),
      regionAliasMatchPct: ratio(sum("regionMatchedCount"), totalPlaces),
      routeFallbackRatePct: ratio(trueCount("routeFallback"), successful.length),
      averageCandidateCount: Number(
        (
          results.reduce((sumValue, result) => sumValue + result.candidateCount, 0) / results.length
        ).toFixed(2)
      ),
      latencyMs: {
        average: Math.round(
          latencies.reduce((sumValue, value) => sumValue + value, 0) / latencies.length
        ),
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        max: Math.max(...latencies)
      },
      dataQuality: {
        totalPlaces: Number(data.total),
        datasetCount: Number(data.datasets),
        normalizedCategoryCoveragePct: ratio(Number(data.normalized), Number(data.total)),
        coordinateCoveragePct: ratio(Number(data.coordinates), Number(data.total))
      }
    };

    const outputDirectory = path.resolve("reports/benchmark");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "direct-local.json"),
      `${JSON.stringify({ summary, results }, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(outputDirectory, "direct-local.md"),
      reportMarkdown(summary, results),
      "utf8"
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db.end();
  }
};

await main();
