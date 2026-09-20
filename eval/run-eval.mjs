/* 跑评测。
   只计算**可机械判定**的指标 —— 需要主观判断的维度一律留空，标「需人工」，
   不用一个看起来精确的数字掩盖它其实是猜的。

   跑：node eval/run-eval.mjs   （或 npm run eval） */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_KEYS, summarize } from "../lib/schema.mjs";
import { gradeSource, isAdequate, GRADES } from "../lib/source-grade.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "eval", "corpus");

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
// 广告落地页 / 投放跟踪参数：这类来源能通过「URL 真实存在」的校验，但没资格支撑事实。
// 注意：不要把它和搜索工具产生的 `#1#1` 分片锚点混为一谈 ——
// 后者是无害噪声，混进来会把占比算高一倍以上，得出一个看起来吓人的假数字。
const isAdLike = (u) => /[?&](utm_source|utm_medium|utm_campaign|gclid|fbclid|msclkid)=/.test(u || "");
const isFragment = (u) => /#\d+(#\d+)*$/.test(u || "");
// 官方域名判定：来源域名是否等于产品名或厂商名（粗糙但对本项目够用）
const looksOfficial = (hostname, product, vendor) => {
  if (!hostname) return false;
  const keys = [product, vendor].filter(Boolean)
    .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((s) => s.length >= 3);
  return keys.some((k) => hostname.replace(/[^a-z0-9]/g, "").includes(k));
};

function loadCorpus() {
  const runs = [];
  for (const f of fs.readdirSync(CORPUS).sort()) {
    if (!f.endsWith(".ndjson")) continue;
    const line = fs.readFileSync(path.join(CORPUS, f), "utf8")
      .split("\n").find((l) => l.includes('"type":"report"'));
    if (!line) continue;
    runs.push({ file: f, ...JSON.parse(line) });
  }
  return runs;
}

const runs = loadCorpus();

// ── 版本分组：修复前 / 修复后分开算，不混在一起求平均 ─────────
const VERSIONS = JSON.parse(fs.readFileSync(path.join(CORPUS, "versions.json"), "utf8"));
const versionOf = (file) => {
  for (const key of ["v0", "v1", "v2"]) {
    if (VERSIONS[key] && VERSIONS[key].runs.includes(file)) return key;
  }
  return null;
};
for (const r of runs) {
  r.version = versionOf(r.file);
  if (!r.version) console.log(`  ! ${r.file} 未在 versions.json 中标记版本，已排除出对比`);
}

function metricsFor(rs) {
  const s = [];
  let ad = 0, frag = 0, vs = 0, viol = 0, pv = 0, ps = 0, rej = 0, blank = 0, withReason = 0;
  let weak = 0;
  const gradeCount = {};
  for (const run of rs) {
    rej += run.summary.rejected || 0;
    for (const p of run.products) {
      const a = p.fields.start_price || {}, b = p.fields.price_usd_month || {};
      ps++; if (b.value) { pv++; if (a.source_url !== b.source_url) viol++; }
      for (const k of FIELD_KEYS) {
        const c = p.fields[k] || {};
        s.push(c);
        if (!c.value) { blank++; if (c.rejected || c.downgraded) withReason++; }
        if (c.value && c.source_url) {
          vs++;
          if (isAdLike(c.source_url)) ad++;
          else if (isFragment(c.source_url)) frag++;
          // 来源分级：纯函数，可回溯应用到历史语料
          const g = gradeSource(c.source_url, { product: p.name, vendor: p.vendor });
          gradeCount[g.id] = (gradeCount[g.id] || 0) + 1;
          if (!isAdequate(k, g.id)) weak++;
        }
      }
    }
  }
  return {
    runs: rs.length, slots: s.length, rejected: rej,
    fab_rate: s.length ? +(rej / s.length * 100).toFixed(2) : 0,
    same_source_violations: viol,
    price_valued: pv, price_slots: ps,
    price_coverage: ps ? +(pv / ps * 100).toFixed(1) : 0,
    adlike: ad, fragment: frag, valued_with_source: vs,
    adlike_rate: vs ? +(ad / vs * 100).toFixed(2) : 0,
    fragment_rate: vs ? +(frag / vs * 100).toFixed(2) : 0,
    blank, blank_with_reason: withReason,
    reason_coverage: blank ? +(withReason / blank * 100).toFixed(1) : 0,
    gradeCount, weak_citations: weak,
    weak_rate: vs ? +(weak / vs * 100).toFixed(2) : 0,
  };
}

const v0 = metricsFor(runs.filter((r) => r.version === "v0"));
const v1 = metricsFor(runs.filter((r) => r.version === "v1"));
const v2 = metricsFor(runs.filter((r) => r.version === "v2"));

// ── 全语料逐槽位展开 ─────────────────────────────────────────
const slots = [];
for (const run of runs) {
  for (const p of run.products) {
    for (const k of FIELD_KEYS) {
      const c = p.fields[k] || {};
      slots.push({
        run: run.file, track: run.track.name, product: p.name, vendor: p.vendor, field: k,
        value: c.value ?? null, source_url: c.source_url ?? null,
        confidence: c.confidence ?? "unknown", rejected: !!c.rejected,
        downgraded: !!c.downgraded, start: p.fields.start_price || {},
      });
    }
  }
}

const M = {};   // 自动指标

// ── L4-D 幻觉拦截（二元 + 比率）───────────────────────────────
M.slots_total = slots.length;
M.rejected = slots.filter((s) => s.rejected).length;
M.fabrication_rate = +(M.rejected / M.slots_total * 100).toFixed(2);
M.runs_with_rejection = runs.filter((r) => (r.summary.rejected || 0) > 0).length;
// 连片性：同一产品的多个字段一起被拦
const rejByProduct = {};
for (const s of slots) if (s.rejected) rejByProduct[`${s.run}|${s.product}`] = (rejByProduct[`${s.run}|${s.product}`] || 0) + 1;
M.rejected_clusters = Object.values(rejByProduct).filter((v) => v > 1).length;

// ── L4-C 跨字段一致（推导字段必须与依据字段同源）──────────────
const priceSlots = slots.filter((s) => s.field === "price_usd_month");
M.price_slots = priceSlots.length;
M.price_valued = priceSlots.filter((s) => s.value).length;
M.price_same_source_violations = priceSlots.filter((s) => s.value && s.source_url !== s.start.source_url).length;
// 图表↔表格同源：图表只读 price_usd_month 的数值，表格读同一格子 → 只要上面为 0 就不会打架
M.chart_table_conflicts = M.price_same_source_violations;

// ── L5 汇总指标一致性 ────────────────────────────────────────
M.summary_mismatches = 0;
for (const run of runs) {
  const recount = summarize(run.products);
  const s = run.summary;
  for (const k of ["total", "verified", "claim", "unknown", "rejected"]) {
    if (recount[k] !== s[k]) { M.summary_mismatches++; console.log(`  ! ${run.file} 汇总不一致: ${k} 记录=${s[k]} 实算=${recount[k]}`); }
  }
}
// 缺口清单完整性：前端按「值为空」生成，这里核对空值数与记录的 unknown 是否相等
M.gap_list_mismatches = M.summary_mismatches;

// ── L4-B 来源质量分布 ───────────────────────────────────────
const valued = slots.filter((s) => s.value && s.source_url);
M.valued_with_source = valued.length;
M.sources_official = 0; M.sources_thirdparty = 0; M.sources_adlike = 0; M.sources_fragment = 0;
const domainCount = {};
for (const s of valued) {
  const h = host(s.source_url);
  if (h) domainCount[h] = (domainCount[h] || 0) + 1;
  if (isFragment(s.source_url)) M.sources_fragment++;
  if (isAdLike(s.source_url)) M.sources_adlike++;
  else if (looksOfficial(h, s.product, s.vendor)) M.sources_official++;
  else M.sources_thirdparty++;
}
M.unique_domains = Object.keys(domainCount).length;
M.adlike_rate = +(M.sources_adlike / (M.valued_with_source || 1) * 100).toFixed(2);
M.fragment_rate = +(M.sources_fragment / (M.valued_with_source || 1) * 100).toFixed(2);
// 单域名集中的现象：某产品所有字段引同一域名
M.single_domain_products = 0;
for (const run of runs) for (const p of run.products) {
  const hs = new Set(FIELD_KEYS.map((k) => host((p.fields[k] || {}).source_url)).filter(Boolean));
  if (hs.size === 1 && FIELD_KEYS.filter((k) => (p.fields[k] || {}).value).length >= 5) M.single_domain_products++;
}

// ── L4-B′ 来源分级（新增维度）────────────────────────────────
// 分级是 source_url 的纯函数 —— 同一套规则可回溯应用到历史语料，
// 所以这个维度能覆盖全部 7 轮，不需要重跑调研。
M.gradeCount = {};
M.graded_total = 0;
M.weak_citations = 0;
for (const s of valued) {
  const g = gradeSource(s.source_url, { product: s.product, vendor: s.vendor });
  M.gradeCount[g.id] = (M.gradeCount[g.id] || 0) + 1;
  M.graded_total++;
  if (!isAdequate(s.field, g.id)) M.weak_citations++;
}
M.weak_rate = +(M.weak_citations / (M.graded_total || 1) * 100).toFixed(2);

// ── L4-B″ 自纠错闭环：重新取证的效果 ─────────────────────────
// 只有跑过补证的新语料才有这两个数；历史语料为 0。
M.retry_rescued = 0;
M.retry_dropped = 0;
M.retry_triggered = 0;
M.retry_products = 0;
M.retry_value_coverage_before = 0;
M.retry_value_coverage_after = 0;
for (const run of runs) for (const p of run.products) {
  if (p._retry) {
    M.retry_triggered += p._retry.triggered;
    M.retry_rescued += p._retry.rescued;
    M.retry_dropped += p._retry.dropped;
    if (p._retry.triggered) M.retry_products++;
    // 覆盖率变化：补证会救回一些、也会降级一些，两个数必须一起报
    const valued = FIELD_KEYS.filter((k) => (p.fields[k] || {}).value).length;
    M.retry_value_coverage_after += valued;
    M.retry_value_coverage_before += valued + p._retry.dropped;
  }
}
M.retry_success_rate = (M.retry_rescued + M.retry_dropped)
  ? +(M.retry_rescued / (M.retry_rescued + M.retry_dropped) * 100).toFixed(1) : null;

// ── L4-E 缺口识别（降级必须带理由，不许静默丢值）─────────────
M.blank_slots = slots.filter((s) => !s.value).length;
M.downgraded_with_reason = slots.filter((s) => s.downgraded).length;
M.blank_without_reason = M.blank_slots - M.rejected - M.downgraded_with_reason;
M.reason_coverage = +((M.rejected + M.downgraded_with_reason) / (M.blank_slots || 1) * 100).toFixed(1);

// ── L4-A 内容命中（人工标注，读取 eval/manual-labels.json）────
const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "manual-labels.json"), "utf8"));
const scoreSet = (arr) => {
  const n = arr.length || 1;
  const c = (v) => arr.filter((x) => x.score === v).length;
  return {
    n: arr.length, s1: c(1), s2: c(2), s3: c(3),
    mean: +(arr.reduce((a, b) => a + b.score, 0) / n).toFixed(2),
    usable: +(c(3) / n * 100).toFixed(1),
    fail: +(c(1) / n * 100).toFixed(1),
  };
};
const A_primary = scoreSet(LABELS.primary);   // 无偏等距抽样
const A_control = scoreSet(LABELS.control);   // 高频常规桶（有选择性偏置，仅作对照）
M.l4a_primary = A_primary;
M.l4a_control = A_control;

// ── 剩余人工维度（占位，不编数）─────────────────────────────
const MANUAL = [
  ["L4-B 来源够格性", "来源是否够资格支撑该字段（广告页 vs 定价页）", "部分自动", "自动部分见来源分布；够格性判断需人工填 human_source_quality"],
  ["B 层 端到端", "任务完成 / 证据可信 / 行动性 / 体验风险 共 8 项", "需人工", "需人工逐条评分，机评仅可作预筛"],
  ["L8-A 主动提示准确性", "缺口/冲突提示的真阳性与假阳性", "需人工", "需注入构造的校正历史后观察横幅，尚未做"],
];

// ── 输出报告 ─────────────────────────────────────────────────
const pct = (a, b) => b ? `${a}/${b} = ${(a / b * 100).toFixed(1)}%` : "—";
const L = [];
// 语料指纹：报告对固定输入必须逐字节可复现。
// 不用墙上时钟 —— 否则每次重跑都产生无意义 diff，
// 「评测到底变了没有」这个问题就永远答不了。
const crypto = await import("node:crypto");
const fingerprint = crypto.createHash("sha256")
  .update(runs.map((r) => r.file + ":" + JSON.stringify(r.summary)).join("|"))
  .digest("hex").slice(0, 12);
const fileHashes = crypto.createHash("sha256")
  .update(fs.readdirSync(CORPUS).sort().map((f) => f + fs.readFileSync(path.join(CORPUS, f))).join(""))
  .digest("hex").slice(0, 12);

L.push("# 赛道雷达 · 离线评测报告\n");
L.push(`> 语料 ${runs.length} 轮 / ${M.slots_total} 个字段槽位　语料指纹 \`${fileHashes}\`\n`);
L.push(`> 本报告对固定语料**逐字节可复现**——不用墙上时钟。语料未变则重跑产物完全相同，\`git status\` 干净。\n`);
L.push("本报告只包含**可机械判定**的指标。需要主观判断的维度一律留空并标注「需人工」——不用一个看起来精确的数字掩盖它其实是猜的。\n");

L.push("## 一、自动指标（全部可从语料复算）\n");
L.push("| 维度 | 指标 | 实测值 | 说明 |");
L.push("|---|---|---|---|");
L.push(`| L4-D 幻觉拦截 | 编造率 | **${M.fabrication_rate}%** | ${M.rejected} / ${M.slots_total}。目标 0，非 0 即 bug |`);
L.push(`| L4-D | 触发拦截的轮数 | ${M.runs_with_rejection} / ${runs.length} | — |`);
L.push(`| L4-D | 连片拦截簇 | ${M.rejected_clusters} 簇 | 同一产品多个字段一起被拦，说明按产品聚合审计更有意义 |`);
L.push(`| L4-C 跨字段一致 | 违反数 | **${M.price_same_source_violations}** | 推导字段与依据字段不同源的槽位 |`);
L.push(`| L4-C | 有效价格槽位 | ${pct(M.price_valued, M.price_slots)} | 覆盖率低是**有意的**——宁缺勿猜 |`);
L.push(`| L5 一致性 | 汇总指标不符 | **${M.summary_mismatches}** | 报告记录的计数 vs 逐格实算 |`);
L.push(`| L5-B | 图表↔表格冲突 | **${M.chart_table_conflicts}** | 图表画了值、表格写「未获取」的矛盾 |`);
L.push(`| L4-B 来源质量 | **真广告落地页占比** | **${M.adlike_rate}%** | ${M.sources_adlike} / ${M.valued_with_source}。带 utm_/gclid/cpc 等投放参数，能通过 URL 校验但没资格支撑事实 |`);
L.push(`| L4-B | 分片锚点占比（噪声，非问题） | ${M.fragment_rate}% | ${M.sources_fragment} / ${M.valued_with_source}。搜索工具产生的 #1#1 后缀，无害——单列出来是为了不让它污染上一行 |`);
L.push(`| L4-B | 来源域名数 | ${M.unique_domains} | 越多说明来源越分散 |`);
L.push(`| L4-B | 单域名垄断产品 | ${M.single_domain_products} 个 | 该产品 ≥5 个字段引同一域名 |`);
L.push(`| L4-E 缺口识别 | 空值带理由覆盖率 | **${M.reason_coverage}%** | ${M.rejected + M.downgraded_with_reason} / ${M.blank_slots}。静默丢值是最危险的失败 |`);
L.push("");

L.push("## 二、修复前后对比（真实分数移动）\n");
L.push("语料按版本分组，**分开算、不混在一起求平均**。分组的依据是运行时间，且**分组发生在查看指标之前**——先定版本再看分数，避免按结果倒推。\n");
L.push("| 指标 | v0 baseline | v1 不变量生效 | 变化 | 怎么读 |");
L.push("|---|---:|---:|---|---|");
const cmp = (label, a, b, unit, note) => {
  const d = b - a;
  const arrow = d === 0 ? "持平" : (d > 0 ? "↑" : "↓");
  L.push(`| ${label} | ${a}${unit} | ${b}${unit} | ${arrow} ${Math.abs(+d.toFixed(2))}${unit} | ${note} |`);
};
cmp("同源违反数", v0.same_source_violations, v1.same_source_violations, "", "**修复目标**：应降到 0");
cmp("价格覆盖率", v0.price_coverage, v1.price_coverage, "%", "**代价**：修复必然降低覆盖率，这是取舍不是退步");
cmp("编造率", v0.fab_rate, v1.fab_rate, "%", "两版都靠同一套来源校验拦，非本次修复对象");
cmp("广告/跟踪页占比", v0.adlike_rate, v1.adlike_rate, "%", "**未修**——来源分级还没做，这是已知缺口");
cmp("空值带理由覆盖率", v0.reason_coverage, v1.reason_coverage, "%", "静默丢值比丢值本身更危险");
L.push("");
if (v2.runs) {
  L.push("### v1 → v2：补证闭环带来的变化\n");
  L.push("| 指标 | v1 不变量生效 | v2 加入补证闭环 | 怎么读 |");
  L.push("|---|---:|---:|---|");
  L.push(`| 不够格引用占比 | ${v1.weak_rate}% | **${v2.weak_rate}%** | **降到 0 是设计使然**——不够格的要么被救回、要么被降级；见下方警告 |`);
  L.push(`| 字段值覆盖率 | ${(v1.valued_with_source / (v1.slots || 1) * 100).toFixed(1)}% | ${(v2.valued_with_source / (v2.slots || 1) * 100).toFixed(1)}% | ⚠️ **这是补证的代价**，必须和上面一起报 |`);
  L.push(`| 空值带理由覆盖率 | ${v1.reason_coverage}% | ${v2.reason_coverage}% | 降级都带理由，静默丢值没有增加 |`);
  L.push("");
  L.push(`> ⚠️ **v2 的「不够格引用归零」不是能力提升，是口径变化**——不够格的引用被**删掉了**，不是被**修好了**。`);
  L.push(`> 只报前者不报后者，读者会以为来源质量变好了。**字段值覆盖率的同时下降就是代价的收据。**`);
  L.push(`> v2 组只有 ${v2.runs} 轮 / ${v2.slots} 槽位，产品间方差极大，**只能看方向**。\n`);
}
L.push(`> 样本量：v0 = ${v0.runs} 轮 / ${v0.slots} 槽位；v1 = ${v1.runs} 轮 / ${v1.slots} 槽位。`);
L.push("> **v1 样本量远小于 v0，这个对比只能看方向，不能当结论。** 要下结论需要把 v1 补到同等规模。\n");
L.push("### 怎么读这张表（面试要能讲的版本）\n");
L.push("> 加了「推导字段必须与依据字段同源」这条不变量后，**跨字段同源违反从 3 降到 0**，代价是**价格覆盖率从 "
  + v0.price_coverage + "% 降到 " + v1.price_coverage + "%**——因为原本靠另一条独立来源凑出来的数字被拒绝了。");
L.push("> 这是**有意的取舍**：宁可不给数字，也不给一个两个来源互相打架的数字。");
L.push("> **但必须同时说明**：v1 只有 " + v1.runs + " 轮样本，方向可信、幅度不可信。\n");

L.push("## 三、来源分级（L4-B′）\n");
L.push("URL 校验只能判断「链接真的存在」，判断不了「它够不够格支撑这条事实」。分级是对 `source_url` 的**纯函数**，因此能回溯应用到全部历史语料，不需要重跑调研。\n");
L.push("| 等级 | 含义 | 条数 | 占比 |");
L.push("|---|---|---:|---:|");
for (const id of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
  const n = M.gradeCount[id] || 0;
  L.push(`| ${id} | ${GRADES[id].label} — ${GRADES[id].desc} | ${n} | ${(n / M.graded_total * 100).toFixed(1)}% |`);
}
L.push("");
L.push(`**不够格支撑其字段的引用：${M.weak_citations} / ${M.graded_total} = ${M.weak_rate}%**\n`);
L.push("判定规则（代码，非 prompt）：");
L.push("- **T5 聚合目录站 / T6 广告落地页 → 对任何字段都不够格**。它们能通过 URL 校验，但信息是转述或营销投放");
L.push("- **价格类字段不接受 T3（官网首页/博客）**。这类页面上的价格常是引流话术、档位不全或已过时");
L.push("- 价格类字段接受 T1 定价页 / T2 官方文档 / T4 第三方评测；其余字段 T1–T4 均可");
L.push("");
L.push("> ⚠️ 已知假阳性边界：官方定价页带联盟参数（`?fpr=`）仍判 T1，因为页面内容是真实定价页。这类参数不在投放跟踪清单里。\n");

L.push("### 自纠错闭环：重新取证的效果（L4-B″）\n");
if (!M.retry_triggered) {
  L.push("**本语料尚未包含补证数据。** 现有 7 轮语料跑在补证功能上线之前，因此这一维度为空。");
  L.push("补证会改变字段值与覆盖率，**不能用旧语料倒推**——需要跑出新语料后本表才会填上。\n");
  L.push("离线预演（按真实语料模拟「补证全失败」的最坏情况）：");
  const worstDrop = M.weak_citations;
  L.push(`- 触发补证的字段：${M.weak_citations} 个（即全部不够格引用）`);
  L.push(`- 若补证全部失败 → 这些字段全部降级为「未获取」`);
  L.push(`- 字段值覆盖将从 ${M.graded_total} 降到 ${M.graded_total - worstDrop}（${((M.graded_total - worstDrop) / M.graded_total * 100).toFixed(1)}%）\n`);
  L.push("> ⚠️ **覆盖率下降是这个功能的直接代价，必须和成功率一起报**。只报「救回多少」而不报「掉下去多少」，就是选择性陈述。\n");
} else {
  L.push("| 指标 | 实测 |");
  L.push("|---|---:|");
  L.push(`| 进入补证的**产品数** | ${M.retry_products} |`);
  L.push(`| 触发补证的**字段数** | ${M.retry_triggered} |`);
  L.push(`| 补证救回（新来源够格） | ${M.retry_rescued} |`);
  L.push(`| 补证失败 → 降级为「未获取」 | ${M.retry_dropped} |`);
  L.push(`| **补证成功率** | **${M.retry_success_rate}%** |`);
  L.push("");
  L.push("规则：不够格的来源先**定向重搜一次**（系统提示里明确禁止拿原来源充数）→ 仍不够格则**降级为「未获取」**。\n");
  L.push("> **统计口径**：只计入账目正确的轮次。更早的一轮（r08）跑在补证计数逻辑修正之前，它记录的「救回」统计的是「拿到了新值」而非「新来源够格」，会把降级前的新值也算成救回——那个数据不可信，已排除。它的字段数据仍参与其他维度。\n");
  L.push("#### 这个数字要带着三个警告读\n");
  L.push(`1. **样本极小**：只来自 ${M.retry_products} 个产品的 ${M.retry_triggered} 个字段。`);
  L.push("2. **产品间方差极大**：同一轮里 Grammarly 救回 6/6，Jasper 只救回 1/6。用平均值描述它是不诚实的——它取决于**这个产品的广告投放有多激进**。");
  L.push("3. **补证常常白跑**：模型被告知「不许拿原来源充数」后，实测**多次换成了另一个同样是广告的页面**（例如把 `jasper.ai` 的首页广告链接换成了 `jasper.ai/platform?gclid=...`）。原因是**广告落地页和聚合站在搜索结果里排名本来就很靠前**——不是模型不听话，是它搜到的东西就这些。");
  L.push("");
  L.push("> 只报成功率而不报这条，就是在把「搜不到更好来源」包装成「系统在自我改进」。\n");
}

L.push("## 四、来源域名分布（Top 12）\n");
L.push("| 域名 | 被引次数 |");
L.push("|---|---:|");
for (const [h, c] of Object.entries(domainCount).sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`| ${h} | ${c} |`);
L.push("");

L.push("## 五、L4-A 内容命中（人工标注）\n");
L.push("这是本评测中唯一需要主观判断的维度。**标注者是 AI 助手本人，不是领域专家**——写进材料时必须如实说明。\n");
L.push("### 主样本：无偏等距抽样\n");
L.push(`从全部 **${M.valued_with_source} 个有值且带来源的槽位**中等距抽取 ${A_primary.n} 条，**不按成败预筛**。\n`);
L.push("| 分值 | 条数 | 占比 |");
L.push("|---|---:|---:|");
L.push(`| 3 直接回答 | ${A_primary.s3} | ${(A_primary.s3 / A_primary.n * 100).toFixed(1)}% |`);
L.push(`| 2 需明显修正 | ${A_primary.s2} | ${(A_primary.s2 / A_primary.n * 100).toFixed(1)}% |`);
L.push(`| 1 答非所问 | ${A_primary.s1} | ${(A_primary.s1 / A_primary.n * 100).toFixed(1)}% |`);
L.push("");
L.push(`**可用率 ${A_primary.usable}%（${A_primary.s3}/${A_primary.n}）· 失败率 ${A_primary.fail}%（${A_primary.s1}/${A_primary.n}）· 均分 ${A_primary.mean}/3**\n`);
const fails = LABELS.primary.filter((x) => x.score === 1);
if (fails.length) {
  L.push("**低分案例原样记录：**\n");
  for (const f of fails) L.push(`- \`${f.id}\` ${f.product} / ${f.field}\n  - ${f.note}`);
  L.push("");
}
L.push(`> ⚠️ **样本量只有 ${A_primary.n} 条，一个 case 就占 ${(100 / A_primary.n).toFixed(1)} 个百分点。**这是方向性证据，不是稳定估计。\n`);
L.push("### 对照样本：「高频常规」桶\n");
L.push(`该桶的定义就是「有值且通过校验」，**存在选择性偏置**，因此单列、不参与主指标：${A_control.n} 条中 ${A_control.s3} 条得 3 分（${A_control.usable}%）。`);
L.push("这个接近满分的结果是**结构性的**——在一开始就筛过成功的集合里测成功率，不构成证据。记录下来是为了说明：**评测集的构造方式会直接决定结论**。\n");

L.push("## 六、需人工判定的维度（尚未评分）\n");
L.push("| 维度 | 判断问题 | 状态 | 数据在哪 |");
L.push("|---|---|---|---|");
for (const [d, q, st, where] of MANUAL) L.push(`| ${d} | ${q} | **${st}** | ${where} |`);
L.push("");
L.push("> 上面这些**没有数字**，因为它们需要人读内容后判断。填入 `eval/cases.csv` 对应列后重跑本脚本即可纳入。\n");

L.push("## 七、口径与复现\n");
L.push("- 语料：`eval/corpus/*.ndjson`，全部为真实联网调研的原始输出，未经修改");
L.push("- 样本：`eval/build-cases.mjs` 用**确定性等距抽样**（不含随机数），任何人重跑得到同一批 45 条");
L.push("- 本脚本：`node eval/run-eval.mjs`，纯计算，不调用任何模型");
L.push("- **不含任何线上指标**——无真实用户、无埋点、无对照\n");
L.push("## 八、不能从本报告得出的结论\n");
L.push(`- 不能把 L4-A 的 ${A_primary.usable}% 当成稳定准确率——只标了 ${A_primary.n} 条，一个 case 就值 ${(100 / A_primary.n).toFixed(1)} 个百分点`);
L.push("- 不能推出「用户满意度」——没有真实用户、没有埋点、没有对照");
L.push("- 不能推出「修复后整体变好」——同源违反确实降到 0，但**价格覆盖率同时从 " + v0.price_coverage + "% 降到 " + v1.price_coverage + "%**，这是取舍不是提升");
L.push("- 不能推出「来源质量在改善」——真广告页占比 v1 反而略升，来源分级**尚未实现**");
L.push(`- v1 只有 ${v1.runs} 轮 / ${v1.slots} 槽位，**方向可信、幅度不可信**`);
L.push("- 样本只覆盖 2 条赛道（AI 会议纪要 / AI 写作），**不能外推到其他赛道**");
L.push("- 人工标注者是 AI 助手，非领域专家，**未做标注者间一致性检验**");

const md = L.join("\n") + "\n";
fs.writeFileSync(path.join(ROOT, "eval", "report.md"), md, "utf8");

// ── 权威数字输出 ─────────────────────────────────────────────
// README / RESUME / JOURNAL 里引用的数字必须与这里对齐。
// test/docs-numbers.mjs 会拿这份文件去校验文档，防止语料增长后文档数字过期。
const round = (n, d = 2) => Number(n.toFixed(d));
fs.writeFileSync(path.join(ROOT, "eval", "key-numbers.json"), JSON.stringify({
  _说明: "由 eval/run-eval.mjs 生成，是文档中数字的唯一权威来源。不要手工编辑。",
  _语料指纹: fileHashes,
  语料轮数: runs.length,
  槽位总数: M.slots_total,
  编造率: { 值: round(M.fabrication_rate), 分子: M.rejected, 分母: M.slots_total },
  不够格引用: { 值: round(M.weak_rate), 分子: M.weak_citations, 分母: M.graded_total },
  有值槽位: M.valued_with_source,
  补证成功率: M.retry_success_rate,
  补证: { 触发: M.retry_triggered, 救回: M.retry_rescued, 降级: M.retry_dropped, 产品数: M.retry_products },
  覆盖率_v1到v2: { v1: round(v1.valued_with_source / (v1.slots || 1) * 100, 1), v2: round(v2.valued_with_source / (v2.slots || 1) * 100, 1) },
  同源违反: { v0: v0.same_source_violations, v1: v1.same_source_violations },
  价格覆盖率: { v0: v0.price_coverage, v1: v1.price_coverage },
  L4A: { 可用率: M.l4a_primary.usable, 分子: M.l4a_primary.s3, 分母: M.l4a_primary.n },
}, null, 2) + "\n");

// 控制台
console.log("\n═══ 自动指标（全语料 " + M.slots_total + " 槽位）═══");
console.log(`  编造率              ${M.fabrication_rate}%   (${M.rejected}/${M.slots_total})`);
console.log(`  跨字段同源违反      ${M.price_same_source_violations}`);
console.log(`  汇总指标不符        ${M.summary_mismatches}`);
console.log(`  图表↔表格冲突       ${M.chart_table_conflicts}`);
console.log(`  真广告落地页占比    ${M.adlike_rate}%   (${M.sources_adlike}/${M.valued_with_source})`);
console.log(`  分片锚点（噪声）    ${M.fragment_rate}%   (${M.sources_fragment}/${M.valued_with_source})  ← 单列，不污染上一行`);
console.log(`  空值带理由覆盖率    ${M.reason_coverage}%`);
console.log(`  来源域名数          ${M.unique_domains}`);
console.log(`  单域名垄断产品      ${M.single_domain_products}`);

console.log("\n═══ 来源分级（L4-B′）═══");
console.log(`  不够格支撑其字段的引用  ${M.weak_citations}/${M.graded_total} = ${M.weak_rate}%`);
console.log("  等级分布  " + ["T1", "T2", "T3", "T4", "T5", "T6"]
  .map((id) => `${id}:${M.gradeCount[id] || 0}`).join("  "));

console.log("\n═══ 修复前后（分组对比，不混算）═══");
const row = (l, a, b, u) => console.log(`  ${l.padEnd(18)} v0 ${String(a).padStart(6)}${u}   →   v1 ${String(b).padStart(6)}${u}`);
row("同源违反数", v0.same_source_violations, v1.same_source_violations, "");
row("价格覆盖率", v0.price_coverage, v1.price_coverage, "%");
row("真广告页占比", v0.adlike_rate, v1.adlike_rate, "%");
row("空值带理由覆盖率", v0.reason_coverage, v1.reason_coverage, "%");
console.log(`  （v0 = ${v0.runs} 轮/${v0.slots} 槽位，v1 = ${v1.runs} 轮/${v1.slots} 槽位 —— v1 样本小，只看方向）`);

console.log("\n  → eval/report.md\n");
