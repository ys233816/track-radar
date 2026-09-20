/* 来源分级的测试。
   测试用的 URL **全部取自真实调研语料**（eval/corpus/），不是我编的样例。

   跑：node test/source-grade.mjs */

import { gradeSource, isAdequate, PRICE_FIELDS } from "../lib/source-grade.mjs";

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
  if (cond) { pass++; console.log("  ✓ " + label); }
  else { fail++; console.log("  ✗ " + label + (detail ? "\n      " + detail : "")); }
};
// 每个 URL 必须配它自己产品的上下文 —— 官方域名判定靠的是
// 域名里是否含产品名/厂商名，上下文配错就会把官方页判成第三方。
const CTX = {
  otter:     { product: "Otter.ai",    vendor: "Otter.ai" },
  granola:   { product: "Granola",     vendor: "Granola" },
  writesonic:{ product: "Writesonic",  vendor: "Writesonic" },
  jasper:    { product: "Jasper",      vendor: "Jasper" },
  grammarly: { product: "Grammarly",   vendor: "Superhuman" },
};
const g = (url, c = CTX.otter) => gradeSource(url, c).id;

console.log("\n── 定级：全部取自真实语料 ──────────────────────────────");

// T6 广告落地页 —— 这是本项目最关键的一类，占 17.1%
ok(g("https://otter.ai/?utm_source=growthwithgary.com&utm_medium=referral") === "T6",
  "官网首页带 utm 投放参数 → T6（官方域名也救不了）");
ok(g("https://otter.ai/start-for-free?gad_source=1&gclid=CjwKCAiAqfe8BhBwEiwAs") === "T6",
  "带 gclid 的 Google Ads 落地页 → T6");
ok(g("https://www.grammarly.com/pt/?utm_source=bing&utm_campaign=627596517", CTX.grammarly) === "T6",
  "Bing 广告落地页（实测中 Grammarly 6 个字段都引这一条）→ T6");

// T5 聚合/目录站
ok(g("https://www.vendr.com/marketplace/otter-ai#1") === "T5", "vendr.com → T5");
ok(g("https://techreviewer.co/pdf/otter-ai?resource_class=Product") === "T5", "techreviewer.co → T5");
ok(g("https://geekflare.com/reviews/writesonic-review/") === "T5", "geekflare 评测 → T5");
ok(g("https://www.g2.com/products/otter-ai/reviews") === "T5", "G2 对比站 → T5");

// T2 官方文档 —— 子域名必须能认出来（这里曾经有 bug）
ok(g("https://help.otter.ai/hc/en-us/articles/360035266494-What-is-Otter") === "T2",
  "help.otter.ai 帮助中心 → T2（信号在子域名里，不是路径）");
ok(g("https://docs.granola.ai/help-center/managing-your-account/subscriptions", CTX.granola) === "T2",
  "docs.granola.ai → T2");
ok(g("https://docs.writesonic.com/v1.0/docs/overview", CTX.writesonic) === "T2", "docs.writesonic.com → T2");

// T1 官方定价页
ok(g("https://writesonic.com/pricing?hubs_content-cta=global-nav", CTX.writesonic) === "T1",
  "官方定价页带营销参数 → T1（HubSpot 参数不是投放跟踪）");
ok(g("https://www.jasper.ai/pricing?fpr=akshayhallur", CTX.jasper) === "T1",
  "官方定价页带联盟参数 → T1（内容是真实定价页）");

// T3 官方其他
ok(g("https://www.granola.ai/blog/granola-free-trial-get-started", CTX.granola) === "T3", "官方博客 → T3");
ok(g("https://www.otter.ai/") === "T3", "官网首页（无投放参数）→ T3");

// T4 第三方
ok(g("https://sonix.ai/resources/otter-ai-pricing/amp/#1") === "T4", "第三方行业站 → T4");

console.log("\n── 够格性：来源能不能支撑这个字段 ──────────────────────");

ok(isAdequate("start_price", "T6") === false, "价格字段 + 广告页 → 不够格");
ok(isAdequate("positioning", "T6") === false, "非价格字段 + 广告页 → 也不够格（T6 对任何字段都不够格）");
ok(isAdequate("key_limit", "T5") === false, "聚合站 → 对任何字段都不够格");
ok(isAdequate("start_price", "T3") === false, "价格字段 + 官网博客 → 不够格（营销页价格易过时）");
ok(isAdequate("positioning", "T3") === true, "非价格字段 + 官网博客 → 够格");
ok(isAdequate("free_tier", "T2") === true, "价格字段 + 官方文档 → 够格（帮助中心讲订阅是有权威性的）");
ok(isAdequate("start_price", "T1") === true, "价格字段 + 官方定价页 → 够格");
ok(isAdequate("core_capability", "NONE") === false, "无来源 → 不够格");

console.log("\n── 边界：不合法的输入不能抛异常 ────────────────────────");
ok(gradeSource("").id === "NONE", "空字符串 → NONE，不崩");
ok(gradeSource(null).id === "NONE", "null → NONE");
ok(gradeSource("不是URL").id === "NONE",
  "非法 URL → NONE（降级成 T4 会让垃圾串看起来像个合格引用）");
ok(gradeSource("https://example.com/x", {}).id === "T4",
  "缺 product/vendor 上下文时不崩，降级为第三方");

console.log("\n── 价格字段清单与 schema 一致 ──────────────────────────");
ok(PRICE_FIELDS.includes("price_usd_month") && PRICE_FIELDS.includes("start_price"),
  "价格字段清单包含 price_usd_month 与 start_price");

console.log("\n" + "─".repeat(56));
console.log(`  通过 ${pass} · 失败 ${fail}`);
console.log("─".repeat(56) + "\n");
process.exit(fail ? 1 : 0);
