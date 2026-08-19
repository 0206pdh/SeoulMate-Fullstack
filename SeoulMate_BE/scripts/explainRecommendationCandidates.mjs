import "dotenv/config";

import { writeFile } from "node:fs/promises";

const sourceDatasets = [
  "TbVwRestaurants",
  "TbVwAttractions",
  "TbVwNature",
  "SearchParkInfoService",
  "culturalEventInfo",
  "culturalSpaceInfo",
  "viewNightSpot",
  "LOCALDATA_072404",
  "LOCALDATA_072405"
];

const scanMetrics = (plan) => {
  const children = plan.Plans ?? [];
  const ownRows = /Scan$/.test(plan["Node Type"])
    ? (plan["Actual Rows"] + (plan["Rows Removed by Filter"] ?? 0)) * plan["Actual Loops"]
    : 0;
  return ownRows + children.reduce((total, child) => total + scanMetrics(child), 0);
};

const main = async () => {
  const { db } = await import("../dist/config/db.js");
  const commonRegion = `(
    region = ANY($1::text[])
    OR region ILIKE ANY($2::text[])
    OR address ILIKE ANY($2::text[])
  )`;
  const primarySql = `
    SELECT *
      FROM public_data
     WHERE ${commonRegion}
       AND source_dataset = ANY($3::text[])
     ORDER BY CASE
       WHEN region ILIKE ANY($2::text[])
         OR address ILIKE ANY($2::text[])
         OR title ILIKE ANY($2::text[]) THEN 0
       WHEN region = ANY($1::text[]) THEN 1
       ELSE 1
     END, updated_at DESC, id DESC
     LIMIT 80`;
  const diversitySql = `
    SELECT *
      FROM public_data
     WHERE ${commonRegion}
       AND source_dataset = ANY($3::text[])
     ORDER BY CASE
       WHEN region ILIKE ANY($2::text[])
         OR address ILIKE ANY($2::text[])
         OR title ILIKE ANY($2::text[]) THEN 0
       WHEN region = ANY($1::text[]) THEN 1
       ELSE 1
     END, updated_at DESC, id DESC
     LIMIT 12`;
  const explain = async (sql, datasets) => {
    const result = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [
      ["성동구"],
      ["%성수%", "%성동구%"],
      datasets
    ]);
    const root = result.rows[0]["QUERY PLAN"][0];
    return {
      planningTimeMs: root["Planning Time"],
      executionTimeMs: root["Execution Time"],
      rowsVisited: scanMetrics(root.Plan),
      sharedHitBlocks: root.Plan["Shared Hit Blocks"] ?? 0,
      sharedReadBlocks: root.Plan["Shared Read Blocks"] ?? 0
    };
  };

  try {
    const primary = await explain(primarySql, sourceDatasets);
    const diversity = [];
    for (const sourceDataset of sourceDatasets) {
      diversity.push(await explain(diversitySql, [sourceDataset]));
    }
    const sum = (items, field) => items.reduce((total, item) => total + item[field], 0);
    const before = {
      queryCount: 1 + diversity.length,
      executionTimeMs: primary.executionTimeMs + sum(diversity, "executionTimeMs"),
      rowsVisited: primary.rowsVisited + sum(diversity, "rowsVisited"),
      sharedHitBlocks: primary.sharedHitBlocks + sum(diversity, "sharedHitBlocks"),
      sharedReadBlocks: primary.sharedReadBlocks + sum(diversity, "sharedReadBlocks")
    };
    const after = { queryCount: 1, ...primary };
    const reductionPct = (beforeValue, afterValue) =>
      Number((((beforeValue - afterValue) / beforeValue) * 100).toFixed(2));
    const report = {
      measuredAt: new Date().toISOString(),
      representativeRegion: "성수 / 성동구",
      method: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
      before,
      after,
      improvement: {
        queryCountReductionPct: reductionPct(before.queryCount, after.queryCount),
        executionTimeReductionPct: reductionPct(before.executionTimeMs, after.executionTimeMs),
        rowsVisitedReductionPct: reductionPct(before.rowsVisited, after.rowsVisited),
        sharedHitBlocksReductionPct: reductionPct(before.sharedHitBlocks, after.sharedHitBlocks)
      }
    };
    await writeFile(
      "reports/benchmark/candidate-explain.json",
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.end();
  }
};

await main();
