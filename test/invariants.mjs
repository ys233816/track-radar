/* 三条不变量是这个产品的全部价值，所以它们有测试。
   数据全部取自 2026-09-20 那次真实调研的实际输出。
   跑：node test/invariants.mjs   （或 npm test） */

import { coerceProduct, summarize, FIELD_KEYS } from "../lib/schema.mjs";

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (detail ? "\n      " + detail : "")); }
};

const U = {
  toolchaseJasper: "https://toolchase.com/tool/jasper/",
  toolchaseCopy:   "https://toolchase.com/tool/copy-ai/",
  writesonicBlog:  "https://writesonic.com/blog/profound-vs-writesonic",
  geekflare:       "https://geekflare.com/reviews/writesonic-review/",
  grammarlyAd:     "https://www.grammarly.com/pt/?utm_source=bing&utm_campaign=627596517",
  jasperHome:      "https://www.jasper.ai/",
};

const mk = (over) => ({
  name: over.name,
  fields: {
    start_price:     over.start,
    price_usd_month: over.month,
  },
});
const cell = (value, url, confidence = "official_claim") => ({ value, source_url: url, confidence });

console.log("\n── 不变量三：来源编造必须拦截 ──────────────────────────");
{
  const seen = new Set([U.jasperHome]);
  const out = coerceProduct(mk({
    name: "X",
    start: cell("$49/月", "https://totally-made-up.example/pricing"),
    month: cell("49", "https://totally-made-up.example/pricing"),
  }), "X", seen);
  ok(out.fields.start_price.rejected, "声称的来源不在本次检索结果里 → 拦截");
  ok(out.fields.start_price.value === null, "被拦截的字段值必须清空");
  ok(out.fields.start_price.rejected.claimed_url.includes("made-up"), "留档原始声称的 URL 供人工判断");
}

console.log("\n── 不变量一：月费必须与起步价原文同源 ──────────────────");
{
  // 实测案例：Writesonic 官方博客说 $99/月 或年付 $79，第三方 geekflare 说 39
  const urls = [U.writesonicBlog, U.geekflare];
  const out = coerceProduct(mk({
    name: "Writesonic",
    start: cell("Starts at $99/mo, or $79 billed yearly.", U.writesonicBlog),
    month: cell("39", U.geekflare, "verified"),
  }), "Writesonic", new Set(urls));
  ok(out.fields.price_usd_month.value === null, "换来源的月费 → 不予采信（实测：$79 vs $39 打架）");
  ok(/不同/.test(out.fields.price_usd_month.downgraded.reason), "降级理由写明是来源不一致");
  ok(out.fields.start_price.value !== null, "起步价原文保留 —— 有问题的只是换算，不是原文");
}
{
  const out = coerceProduct(mk({
    name: "Jasper",
    start: cell("69 美元/月（月付）或 59 美元/月（年付）", U.toolchaseJasper, "verified"),
    month: cell("59", U.toolchaseJasper, "verified"),
  }), "Jasper", new Set([U.toolchaseJasper]));
  ok(out.fields.price_usd_month.value === "59", "同源 → 正常采信（实测通过案例）");
  ok(out.fields.price_usd_month.numeric === 59, "numeric 已填充");
}

console.log("\n── 不变量二：月费不能比起步价原文更可信 ────────────────");
{
  const out = coerceProduct(mk({
    name: "Y",
    start: cell(null, null, "official_claim"),
    month: cell("19", U.jasperHome, "verified"),
  }), "Y", new Set([U.jasperHome]));
  ok(out.fields.price_usd_month.value === null, "起步价原文未获取 → 月费同步降级（实测 Fathom 案例）");
}

console.log("\n── 数值歧义：含多个数字必须拒绝，不许猜 ────────────────");
{
  const out = coerceProduct(mk({
    name: "Z",
    start: cell("$69/月（月付）或 $59/月（年付）", U.jasperHome),
    month: cell("$69/月（月付）或 $59/月（年付）", U.jasperHome),
  }), "Z", new Set([U.jasperHome]));
  ok(out.fields.price_usd_month.value === null, "两个数字 → 拒绝，不替用户选口径");
  ok(/歧义/.test(out.fields.price_usd_month.downgraded.reason), "降级理由写明歧义");
}
{
  const out = coerceProduct(mk({
    name: "W",
    start: cell("$12/人/月，年付", U.grammarlyAd),
    month: cell("12 美元/用户/月", U.grammarlyAd),
  }), "W", new Set([U.grammarlyAd]));
  ok(out.fields.price_usd_month.value === "12", "带单位的单值 → 剥成纯数字，不算歧义");
}

console.log("\n── 汇总口径：编造率必须可被算出来 ──────────────────────");
{
  const out = coerceProduct(mk({
    name: "V",
    start: cell("$9/月", "https://never-seen.example/x"),
    month: cell("9", "https://never-seen.example/x"),
  }), "V", new Set([U.jasperHome]));
  const s = summarize([out]);
  ok(s.rejected >= 1, "编造计数 > 0（可算出编造率）");
  ok(typeof s.fabrication_rate === "number", "fabrication_rate 是数值");
}

console.log("\n" + "─".repeat(56));
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log("─".repeat(56) + "\n");
process.exit(fail ? 1 : 0);
