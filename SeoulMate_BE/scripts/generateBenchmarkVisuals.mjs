import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const reportsDir = "reports/benchmark";
const outputDir = "../docs/assets/benchmark";
const readJson = async (name) => JSON.parse(await readFile(path.join(reportsDir, name), "utf8"));

const performanceBefore = await readJson("performance-before.json");
const performanceAfter = await readJson("performance-after.json");
const performanceNormalizedDb = await readJson("performance-normalized-db.json");
const explain = await readJson("candidate-explain.json");
const explainPlans = await readJson("candidate-explain-plans.json");
const diversityBefore = await readJson("diversity-before.json");
const diversityAfter = await readJson("diversity-after.json");

await mkdir(outputDir, { recursive: true });

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const page = (title, eyebrow, body, footer) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
*{box-sizing:border-box}body{margin:0;background:#07111f;color:#e8f0ff;font-family:Inter,"Pretendard",Arial,sans-serif}
.page{width:1600px;height:900px;padding:58px 68px;background:radial-gradient(circle at 90% 5%,#17325a 0,transparent 32%),#07111f;overflow:hidden}
.eyebrow{font-size:18px;letter-spacing:.16em;color:#55d6be;font-weight:800;text-transform:uppercase}.title{font-size:45px;font-weight:850;margin:10px 0 8px}.sub{color:#94a8c7;font-size:18px}.grid{display:grid;gap:22px;margin-top:36px}.cols3{grid-template-columns:repeat(3,1fr)}.cols4{grid-template-columns:repeat(4,1fr)}
.card{background:#0d1c31;border:1px solid #1f3859;border-radius:20px;padding:25px;box-shadow:0 18px 40px #0005}.metric{font-size:17px;color:#a8bad3;font-weight:700}.delta{color:#55d6be;font-size:18px;font-weight:800}.values{display:flex;align-items:end;gap:12px;margin:21px 0}.before{font-size:27px;color:#8295b2;text-decoration:line-through}.arrow{font-size:24px;color:#4d6282}.after{font-size:38px;color:#fff;font-weight:900}.unit{font-size:16px;color:#8295b2;margin-left:5px}.bars{height:285px;display:flex;align-items:end;justify-content:center;gap:34px;padding-top:25px}.bar{width:100px;border-radius:12px 12px 3px 3px;position:relative;min-height:4px}.bar.beforebar{background:linear-gradient(#8295b2,#42536e)}.bar.afterbar{background:linear-gradient(#5ce1c5,#168f83)}.bar span{position:absolute;top:-34px;width:100%;text-align:center;font-weight:800;font-size:16px}.legend{display:flex;gap:24px;justify-content:center;color:#a8bad3}.dot{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:7px}.footer{position:absolute;left:68px;bottom:35px;color:#6f85a5;font-size:14px}.note{margin-top:20px;color:#91a6c5;font-size:16px}.wide{grid-column:span 2}
.tree-wrap{display:grid;grid-template-columns:.72fr 1.28fr;gap:24px;margin-top:25px}.tree-panel{background:#0d1c31;border:1px solid #1f3859;border-radius:18px;padding:18px;height:680px;overflow:hidden}.tree-title{font-size:20px;font-weight:850;margin-bottom:10px}.node{border-left:3px solid #55d6be;background:#10243d;border-radius:8px;padding:5px 10px;margin:3px 0 3px calc(var(--depth)*21px);font-size:11px}.node.seq{border-color:#ff7b88}.node.index{border-color:#55d6be}.node.join{border-color:#ffc857}.node .name{font-weight:900;font-size:13px}.node .meta{color:#9fb2ce;margin-top:2px}.tag{float:right;font-size:10px;color:#07111f;background:#55d6be;border-radius:10px;padding:2px 7px;font-weight:850}.seq .tag{background:#ff7b88}.join .tag{background:#ffc857}
</style></head><body><main class="page"><div class="eyebrow">${eyebrow}</div><h1 class="title">${title}</h1>${body}<div class="footer">${footer}</div></main></body></html>`;

const card = (label, before, after, unit, improvement, max) => {
  const beforeHeight = Math.max(5, (before / max) * 270);
  const afterHeight = Math.max(5, (after / max) * 270);
  return `<section class="card"><div class="metric">${label}</div><div class="values"><span class="before">${before.toLocaleString()}</span><span class="arrow">→</span><span class="after">${after.toLocaleString()}</span><span class="unit">${unit}</span></div><div class="delta">${improvement}</div><div class="bars"><div class="bar beforebar" style="height:${beforeHeight}px"><span>${before.toLocaleString()}</span></div><div class="bar afterbar" style="height:${afterHeight}px"><span>${after.toLocaleString()}</span></div></div><div class="legend"><span><i class="dot" style="background:#8295b2"></i>Before</span><span><i class="dot" style="background:#55d6be"></i>After</span></div></section>`;
};

const perfBefore = performanceBefore.summary;
const perfAfter = performanceAfter.summary;
const graphHtml = page(
  "Graph Latency Before vs After",
  "Phase 2 · LangGraph Performance",
  `<p class="sub">Warm-up 5회 후 동일한 10개 지역 시나리오를 40회 순차 측정</p><div class="grid cols3">
  ${card("평균 latency", perfBefore.latencyMs.average, perfAfter.latencyMs.average, "ms", "▼ 27.19%", 1800)}
  ${card("p95 latency", perfBefore.latencyMs.p95, perfAfter.latencyMs.p95, "ms", "▼ 45.91%", 2600)}
  ${card("순차 처리량", perfBefore.throughputPerSecond, perfAfter.throughputPerSecond, "req/s", "▲ 37.38%", 0.95)}
  </div>`,
  "Source: performance-before.json · performance-after.json | Local direct graph, provider fallback"
);

const nodeNames = [
  ["parseUserRequest", "Request parsing"],
  ["fetchCandidatePlaces", "Candidate DB query"],
  ["fetchContextData", "Context I/O"]
];
const nodeCards = nodeNames
  .map(([key, label]) => {
    const before = perfBefore.nodes[key].average;
    const after =
      key === "fetchCandidatePlaces"
        ? performanceNormalizedDb.summary.nodes[key].average
        : perfAfter.nodes[key].average;
    const reduction = (((before - after) / before) * 100).toFixed(2);
    return card(label, before, after, "ms", `▼ ${reduction}%`, 1450);
  })
  .join("");
const nodeHtml = page(
  "LangGraph Node Bottleneck",
  "Node-level Profiling",
  `<p class="sub">구조화 입력 우회 · 독립 context Promise.all · 후보 보강 query 생략</p><div class="grid cols3">${nodeCards}</div>`,
  "각 node wall-clock 평균 · 동일 40회 측정"
);

const dbCards = [
  ["SQL round trip", explain.before.queryCount, explain.after.queryCount, "queries", "▼ 90%"],
  ["DB 실행시간", explain.before.executionTimeMs, explain.after.executionTimeMs, "ms", "▼ 95.63%"],
  ["Plan scan tuple", explain.before.rowsVisited, explain.after.rowsVisited, "rows", "▼ 97.51%"],
  [
    "Shared hit block",
    explain.before.sharedHitBlocks,
    explain.after.sharedHitBlocks,
    "blocks",
    "▼ 93.10%"
  ]
];
const dbHtml = page(
  "PostgreSQL Query Reduction",
  "Phase 3 · EXPLAIN ANALYZE BUFFERS",
  `<p class="sub">지역 정규화 + 데이터셋별 LATERAL quota + ID 선별 후 상세 row hydrate</p><div class="grid cols4">${dbCards
    .map(([label, before, after, unit, improvement]) =>
      card(label, before, after, unit, improvement, Math.max(before, after) * 1.08)
    )
    .join("")}</div>`,
  "Representative query: 성수 / 성동구 · FORMAT JSON 원본 보존"
);

const divBefore = diversityBefore.summary;
const divAfter = diversityAfter.summary;
const regionRows = diversityAfter.results
  .map(
    (result) =>
      `<span style="display:inline-block;margin:5px 9px 5px 0;padding:7px 11px;border-radius:10px;background:#152a45;color:#c8d7eb">${result.region} <b style="color:#55d6be">${result.variantCount}</b></span>`
  )
  .join("");
const diversityHtml = page(
  "Recommendation Diversity",
  "Phase 4 · MMR & Variant Objectives",
  `<p class="sub">10개 지역 · relevance와 유사도 penalty를 함께 최적화</p><div class="grid cols4">
    ${card("평균 variant", divBefore.averageVariantCount, divAfter.averageVariantCount, "courses", "▲ 34.48%", 4.4)}
    ${card("Category entropy", divBefore.averageCategoryEntropy, divAfter.averageCategoryEntropy, "bits", "▲ 2.27%", 1.9)}
    <section class="card"><div class="metric">평균 pairwise Jaccard</div><div class="values"><span class="after">${divAfter.averagePairwiseJaccard}</span></div><div class="delta">코스 간 중복을 매우 낮게 유지</div><p class="note">고유 장소 비율 ${divAfter.averageUniquePlaceRatioPct}%<br>예산·시간 준수율 각각 ${divAfter.budgetCompliancePct}%</p></section>
    <section class="card"><div class="metric">지역별 variant 수</div><div style="margin-top:17px">${regionRows}</div><p class="note">10개 중 9개 지역이 4개 variant 반환<br>망원은 후보 6개로 3개 반환</p></section>
  </div>`,
  "Source: diversity-before.json · diversity-after.json"
);

const nodeClass = (type) => {
  if (type.includes("Seq Scan")) return "seq";
  if (type.includes("Index") || type.includes("Bitmap")) return "index";
  if (type.includes("Loop") || type.includes("Join")) return "join";
  return "";
};
const renderPlan = (node, depth = 0) => {
  const type = node["Node Type"];
  const relation = node["Relation Name"] ? ` · ${node["Relation Name"]}` : "";
  const index = node["Index Name"] ? ` · ${node["Index Name"]}` : "";
  const rows = (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1);
  const elapsed = ((node["Actual Total Time"] ?? 0) * (node["Actual Loops"] ?? 1)).toFixed(2);
  const label = type.includes("Loop")
    ? "JOIN / LATERAL"
    : type.includes("Scan")
      ? "SCAN"
      : type.toUpperCase();
  return `<div class="node ${nodeClass(type)}" style="--depth:${depth}"><span class="tag">${label}</span><div class="name">${escapeHtml(type + relation)}</div><div class="meta">actual rows ${rows.toLocaleString()} · loops ${node["Actual Loops"]} · ${elapsed}ms · hit ${node["Shared Hit Blocks"] ?? 0}${escapeHtml(index)}</div></div>${(node.Plans ?? []).map((child) => renderPlan(child, depth + 1)).join("")}`;
};
const planHtml = page(
  "PostgreSQL Execution Plan Tree",
  "Seq Scan → Index / LATERAL Quota",
  `<div class="tree-wrap"><section class="tree-panel"><div class="tree-title">Before · primary query</div>${renderPlan(explainPlans.before.primary.plan)}</section><section class="tree-panel"><div class="tree-title">After · normalized single SQL</div>${renderPlan(explainPlans.after.plan)}</section></div>`,
  "Actual rows = Actual Rows × Actual Loops · 색상: Seq Scan(red), Index/Bitmap(green), Join/LATERAL(yellow)"
);

const files = {
  "graph-latency.html": graphHtml,
  "langgraph-node-bottleneck.html": nodeHtml,
  "postgresql-query-reduction.html": dbHtml,
  "recommendation-diversity.html": diversityHtml,
  "postgresql-execution-plan.html": planHtml
};
for (const [name, html] of Object.entries(files)) {
  await writeFile(path.join(outputDir, name), html, "utf8");
}
console.log(`Generated ${Object.keys(files).length} visual reports in ${outputDir}`);
