import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const scenarios = [
  ["성수", ["조용한", "감성적인"], 40000, 4, "첫 데이트"],
  ["홍대", ["힙한", "활기찬"], 45000, 4, "주말 데이트"],
  ["강남", ["현대적인", "로맨틱"], 60000, 4, "기념일 데이트"],
  ["종로", ["고즈넉한", "조용한"], 40000, 4, "문화 데이트"],
  ["망원", ["자연친화적", "감성적인"], 35000, 4, "산책 데이트"],
  ["명동", ["활기찬", "현대적인"], 50000, 4, "서울 구경"],
  ["여의도", ["로맨틱", "자연친화적"], 50000, 4, "한강 데이트"],
  ["혜화", ["감성적인", "조용한"], 45000, 4, "공연 데이트"],
  ["서울숲", ["자연친화적", "힙한"], 40000, 4, "낮 데이트"],
  ["DDP", ["현대적인", "감성적인"], 50000, 4, "전시 데이트"]
];

const jaccard = (left, right) => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union ? intersection / union : 0;
};

const entropy = (values) => {
  if (!values.length) return 0;
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.values()].reduce((sum, count) => {
    const probability = count / values.length;
    return sum - probability * Math.log2(probability);
  }, 0);
};

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const main = async () => {
  const label = process.env.BENCHMARK_LABEL ?? "diversity";
  const [{ runRecommendationGraphForApi }, { buildCourseVariantsForBenchmark }, { db }] =
    await Promise.all([
      import("../dist/graphs/recommendation.graph.js"),
      import("../dist/services/recommendation.service.js"),
      import("../dist/config/db.js")
    ]);
  const results = [];

  try {
    for (const [region, mood, budget, durationHours, purpose] of scenarios) {
      const state = await runRecommendationGraphForApi(
        `${region}에서 ${mood.join(", ")} ${purpose}`,
        {
          region,
          mood,
          budget,
          durationHours,
          purpose,
          dateTime: "2026-08-22T06:00:00.000Z"
        }
      );
      const variants = await buildCourseVariantsForBenchmark(state);
      const placeLists = variants.map((variant) =>
        variant.course.places.map((place) => place.placeId)
      );
      const pairwise = [];
      for (let left = 0; left < placeLists.length; left += 1) {
        for (let right = left + 1; right < placeLists.length; right += 1) {
          pairwise.push(jaccard(placeLists[left], placeLists[right]));
        }
      }
      const allPlaces = variants.flatMap((variant) => variant.course.places);
      const uniquePlaceCount = new Set(allPlaces.map((place) => place.placeId)).size;
      const budgetCompliant = variants.every((variant) => variant.course.estimatedBudget <= budget);
      const durationCompliant = variants.every(
        (variant) =>
          variant.course.places.reduce(
            (sum, place) => sum + place.estimatedTimeMinute + (place.moveTimeMinute ?? 0),
            0
          ) <=
          durationHours * 60
      );
      results.push({
        region,
        variantCount: variants.length,
        variantTypes: variants.map((variant) => variant.type),
        totalPlacements: allPlaces.length,
        uniquePlaceCount,
        uniquePlaceRatio: allPlaces.length ? uniquePlaceCount / allPlaces.length : 0,
        meanPairwiseJaccard: pairwise.length ? mean(pairwise) : 0,
        categoryEntropy: entropy(allPlaces.map((place) => place.category)),
        categoryCount: new Set(allPlaces.map((place) => place.category)).size,
        budgetCompliant,
        durationCompliant
      });
      process.stdout.write(`${region}: ${variants.length} variants\n`);
    }

    const summary = {
      label,
      measuredAt: new Date().toISOString(),
      scenarioCount: results.length,
      averageVariantCount: Number(mean(results.map((item) => item.variantCount)).toFixed(3)),
      averageUniquePlaceRatioPct: Number(
        (mean(results.map((item) => item.uniquePlaceRatio)) * 100).toFixed(2)
      ),
      averagePairwiseJaccard: Number(
        mean(results.map((item) => item.meanPairwiseJaccard)).toFixed(4)
      ),
      averageCategoryEntropy: Number(mean(results.map((item) => item.categoryEntropy)).toFixed(4)),
      averageCategoryCount: Number(mean(results.map((item) => item.categoryCount)).toFixed(3)),
      budgetCompliancePct: Number(
        ((results.filter((item) => item.budgetCompliant).length / results.length) * 100).toFixed(2)
      ),
      durationCompliancePct: Number(
        ((results.filter((item) => item.durationCompliant).length / results.length) * 100).toFixed(
          2
        )
      )
    };
    const outputDirectory = path.resolve("reports/benchmark");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, `${label}.json`),
      `${JSON.stringify({ summary, results }, null, 2)}\n`,
      "utf8"
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await db.end();
  }
};

await main();
