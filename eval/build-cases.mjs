/* 从真实报告语料里抽出评测样本。
   样本单元 = 字段槽位（产品 × 字段），外加少量产品级与报告级样本。

   分类规则是**机械的**，不含主观判断 —— 谁跑都是同一批样本：
     边界/高风险 ← 被拦截的幻觉字段、值为空的字段
     易混淆     ← 推导字段与依据字段不同源、数值含多数字被降级
     高频常规   ← 有值且未被降级的字段
     输入模糊   ← 产品级（选品）
     报告级     ← 报告级（缺口暴露、图表一致性）

   跑：node eval/build-cases.mjs */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIELD_KEYS, summarize } from "../lib/schema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = path.join(ROOT, "eval", "corpus");

// ── 读语料 ───────────────────────────────────────────────────
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
const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const cases = [];
let n = 0;
const cid = (p) => `C${String(++n).padStart(3, "0")}`;

// ── 字段槽位样本 ─────────────────────────────────────────────
for (const run of runs) {
  for (const p of run.products) {
    for (const k of FIELD_KEYS) {
      const c = p.fields[k] || {};
      let type, why;

      if (c.rejected) {
        type = "边界"; why = "幻觉来源被拦截（声称的 URL 不在本次检索结果里）";
      } else if (!c.value) {
        type = "边界"; why = c.downgraded ? `主动降级：${c.downgraded.reason}` : "公开渠道未找到";
      } else if (k === "price_usd_month" && c.source_url !== (p.fields.start_price || {}).source_url) {
        type = "易混淆"; why = "推导字段与依据字段不同源";
      } else if (k === "price_usd_month" && /[,、]|\d.*\d/.test(String(c.value))) {
        type = "易混淆"; why = "数值口径可能歧义";
      } else if (k === "price_usd_month") {
        type = "易混淆"; why = "归一化字段：口径换算是否稳定";
      } else {
        type = "高频常规"; why = "有值且通过校验";
      }

      cases.push({
        case_id: cid(), case_type: type, unit: "字段槽位", stage_id: "", run: run.file,
        track: run.track.name, product: p.name, field: k,
        system_output: c.rejected
          ? `[已拦截] 模型原值「${c.rejected.value}」声称来源 ${c.rejected.claimed_url}`
          : (c.value || "未获取"),
        source_url: c.rejected ? "(已清除)" : (c.source_url || ""),
        confidence: c.confidence || "unknown",
        expected: "",
        classification_note: why,
        human_content_hit: "", human_source_quality: "", score: "",
      });
    }
  }

  // 产品级：选品（输入模糊）
  for (const p of run.products) {
    cases.push({
      case_id: cid(), case_type: "输入模糊", unit: "产品级", stage_id: "L2", run: run.file,
      track: run.track.name, product: p.name, field: "(选品)",
      system_output: `${p.name}${p.vendor ? " / " + p.vendor : ""}${p.url ? " / " + p.url : ""}`,
      source_url: "", confidence: "",
      expected: "", classification_note: "该产品是否真的属于本赛道",
      human_content_hit: "", human_source_quality: "", score: "",
    });
  }
}

// ── 报告级样本 ───────────────────────────────────────────────
const reportChecks = [
  { id: "R1", sid: "L5-A", name: "缺口清单完整性", desc: "报告中所有「未获取」的字段是否都出现在缺口清单里" },
  { id: "R2", sid: "L5-B", name: "图表↔表格同源", desc: "图表读取的数据是否与表格是同一份（不得出现图表有值、表格写未获取）" },
  { id: "R3", sid: "L5", name: "汇总指标一致", desc: "顶部指标卡的计数是否与明细逐格核对一致" },
  { id: "R4", sid: "L4-D", name: "编造拦截可追溯", desc: "被拦截的字段是否保留了原始声称，可供人工复核" },
  { id: "R5", sid: "L8-A", name: "主动提示准确性", desc: "缺口/冲突提示是否真反映报告实际状态，无假阳性" },
];
for (const rc of reportChecks.slice(0, Math.max(1, Math.min(5, runs.length)))) {
  const run = runs[Math.min(reportChecks.indexOf(rc), runs.length - 1)];
  cases.push({
    case_id: cid(), case_type: "报告级", unit: "报告级", stage_id: rc.sid, run: run.file,
    track: run.track.name, product: `(${rc.name})`, field: rc.id,
    system_output: `${runs.length} 份报告待检`,
    source_url: "", confidence: "", expected: rc.desc,
    classification_note: rc.desc,
    human_content_hit: "", human_source_quality: "", score: "",
  });
}

// ── 抽样到目标分布 ───────────────────────────────────────────
// 目标：高频 10 / 易混淆 10 / 边界 15 / 模糊 5 / 报告级 5 = 45
// 用确定性等距抽样（不随机），保证任何人重跑都得到同一批样本
const TARGET = { "高频常规": 10, "易混淆": 10, "边界": 15, "输入模糊": 5, "报告级": 5 };
const picked = [];
for (const [type, want] of Object.entries(TARGET)) {
  const pool = cases.filter((c) => c.case_type === type);
  if (!pool.length) { console.log(`  ! 无「${type}」样本`); continue; }
  const step = pool.length / Math.min(want, pool.length);
  for (let i = 0; i < Math.min(want, pool.length); i++) picked.push(pool[Math.floor(i * step)]);
}

// ── 输出 ─────────────────────────────────────────────────────
const COLS = ["case_id", "case_type", "unit", "stage_id", "run", "track", "product", "field",
  "system_output", "source_url", "confidence", "expected", "classification_note",
  "human_content_hit", "human_source_quality", "score"];

const csv = "﻿" + [COLS.join(","), ...picked.map((c) => COLS.map((k) => csvCell(c[k])).join(","))].join("\n") + "\n";
fs.writeFileSync(path.join(ROOT, "eval", "cases.csv"), csv, "utf8");
fs.writeFileSync(path.join(ROOT, "eval", "cases.json"), JSON.stringify(picked, null, 1), "utf8");

// ── 控制台概览 ───────────────────────────────────────────────
const byType = {};
for (const c of picked) byType[c.case_type] = (byType[c.case_type] || 0) + 1;
console.log(`\n  语料：${runs.length} 轮 · ${runs.reduce((s, r) => s + r.summary.total, 0)} 个槽位`);
console.log(`  抽出样本：${picked.length} 条\n`);
for (const [t, v] of Object.entries(byType)) console.log(`     ${t.padEnd(8)} ${v} 条`);
console.log(`\n  → eval/cases.csv（含空的人工标注列，待填）`);
console.log(`  → eval/cases.json\n`);
console.log("  抽样为确定性等距抽样，不含随机数 —— 任何人重跑都是同一批样本。\n");
