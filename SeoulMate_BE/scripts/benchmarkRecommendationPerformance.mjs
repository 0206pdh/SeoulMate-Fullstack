import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scenarios = [
  ["성수", ["조용한", "부담 적은"], 30000, 4, "첫 데이트"],
  ["홍대", ["실내", "감성적인"], 40000, 4, "비 오는 날 데이트"],
  ["강남", ["활기찬", "대화하기 좋은"], 50000, 2, "퇴근 후 데이트"],
  ["잠실", ["야경", "로맨틱한"], 60000, 4, "기념일 데이트"],
  ["종로", ["전통적인", "조용한"], 35000, 4, "첫 만남"],
  ["망원", ["편안한", "산책"], 30000, 4, "주말 데이트"],
  ["명동", ["관광", "실내"], 50000, 4, "서울 구경 데이트"],
  ["여의도", ["산책", "야경"], 40000, 4, "한강 데이트"],
  ["서울숲", ["산책", "카페"], 35000, 4, "낮 데이트"],
  ["청계천", ["산책", "부담 적은"], 25000, 2, "가벼운 첫 만남"]
];

const percentile = (values, ratio) => {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)].toFixed(2)
  );
};

const summarize = (values) => ({
  average: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: Number(Math.max(...values).toFixed(2))
});

const main = async () => {
  const warmupCount = Number(process.env.BENCHMARK_WARMUP ?? 5);
  const measuredCount = Number(process.env.BENCHMARK_RUNS ?? 40);
  const label = process.env.BENCHMARK_LABEL ?? "performance";
  const nodeModules = await Promise.all([
    import("../dist/graphs/nodes/parseUserRequest.node.js"),
    import("../dist/graphs/nodes/fetchCandidatePlaces.node.js"),
    import("../dist/graphs/nodes/verifyCandidatePlaces.node.js"),
    import("../dist/graphs/nodes/fetchContextData.node.js"),
    import("../dist/graphs/nodes/scorePlaces.node.js"),
    import("../dist/graphs/nodes/buildCourse.node.js"),
    import("../dist/graphs/nodes/validateRecommendation.node.js"),
    import("../dist/graphs/nodes/buildAlternativeCourse.node.js"),
    import("../dist/graphs/nodes/generateRiskNotice.node.js"),
    import("../dist/graphs/nodes/formatRecommendationResult.node.js"),
    import("../dist/config/db.js")
  ]);
  const [
    { parseUserRequestNode },
    { fetchCandidatePlacesNode },
    { verifyCandidatePlacesNode },
    { fetchContextDataNode },
    { scorePlacesNode },
    { buildCourseNode },
    { validateRecommendationNode },
    { buildAlternativeCourseNode },
    { generateRiskNoticeNode },
    { formatRecommendationResultNode },
    { db }
  ] = nodeModules;
  const nodes = [
    ["parseUserRequest", parseUserRequestNode],
    ["fetchCandidatePlaces", fetchCandidatePlacesNode],
    ["verifyCandidatePlaces", verifyCandidatePlacesNode],
    ["fetchContextData", fetchContextDataNode],
    ["scorePlaces", scorePlacesNode],
    ["buildCourse", buildCourseNode],
    ["validateRecommendation", validateRecommendationNode],
    ["buildAlternativeCourse", buildAlternativeCourseNode],
    ["validateRecommendationFinal", validateRecommendationNode],
    ["generateRiskNotice", generateRiskNoticeNode],
    ["formatRecommendationResult", formatRecommendationResultNode]
  ];
  const measurements = [];

  const execute = async (iteration, record) => {
    const [region, mood, budget, durationHours, purpose] = scenarios[iteration % scenarios.length];
    let state = {
      rawInput: `${region}에서 ${budget}원 이하로 ${mood.join(", ")} ${purpose} 코스`,
      parsedRequest: {
        region,
        mood,
        budget,
        durationHours,
        purpose,
        dateTime: "2026-08-22T06:00:00.000Z"
      },
      warnings: [],
      errors: []
    };
    const nodeLatencyMs = {};
    const startedAt = performance.now();
    for (const [name, node] of nodes) {
      const nodeStartedAt = performance.now();
      const update = await node(state);
      nodeLatencyMs[name] = performance.now() - nodeStartedAt;
      state = {
        ...state,
        ...update,
        warnings: [...(state.warnings ?? []), ...(update.warnings ?? [])],
        errors: [...(state.errors ?? []), ...(update.errors ?? [])]
      };
    }
    if (record) {
      measurements.push({
        iteration: measurements.length + 1,
        region,
        latencyMs: performance.now() - startedAt,
        candidateCount: state.candidatePlaces?.length ?? 0,
        success: Boolean(state.course?.places.length),
        validationPassed: state.validation?.isValid === true,
        nodeLatencyMs
      });
    }
  };

  try {
    for (let index = 0; index < warmupCount; index += 1) await execute(index, false);
    const benchmarkStartedAt = performance.now();
    for (let index = 0; index < measuredCount; index += 1) {
      await execute(index, true);
      process.stdout.write(`\r${label}: ${index + 1}/${measuredCount}`);
    }
    process.stdout.write("\n");
    const elapsedSecond = (performance.now() - benchmarkStartedAt) / 1000;
    const nodeNames = nodes.map(([name]) => name);
    const summary = {
      label,
      measuredAt: new Date().toISOString(),
      warmupCount,
      measuredCount,
      successRatePct: Number(
        ((measurements.filter((item) => item.success).length / measurements.length) * 100).toFixed(
          2
        )
      ),
      validationPassRatePct: Number(
        (
          (measurements.filter((item) => item.validationPassed).length / measurements.length) *
          100
        ).toFixed(2)
      ),
      throughputPerSecond: Number((measuredCount / elapsedSecond).toFixed(3)),
      latencyMs: summarize(measurements.map((item) => item.latencyMs)),
      nodes: Object.fromEntries(
        nodeNames.map((name) => [
          name,
          summarize(measurements.map((item) => item.nodeLatencyMs[name]))
        ])
      )
    };
    const outputDirectory = path.resolve("reports/benchmark");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, `${label}.json`),
      `${JSON.stringify({ summary, measurements }, null, 2)}\n`,
      "utf8"
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db.end();
  }
};

await main();
