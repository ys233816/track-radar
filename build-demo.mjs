/* 把整个应用烤成一个自包含 HTML。
   产物：双击即开，无后端、无密钥、无 CDN、离线可用。
   跑：node build-demo.mjs   （或 npm run build:demo）
   源码仍是 public/ 与 lib/，这个脚本只做内联，不产生第二份实现。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKS, FIELDS, CONFIDENCE } from "./lib/schema.mjs";
import { GRADES, gradeReport } from "./lib/source-grade.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

// ── 1. 收集要烘焙的真实报告 ──────────────────────────────────
// 每份都来自真实联网调研，不是构造数据。文件名 → 赛道 ID
const SOURCES = [
  { file: process.argv[2] || "eval/corpus/r10-writing-retry4.ndjson",  trackId: "ai-writing", label: "AI 写作 × 4 产品" },
  { file: process.argv[3] || "reports/ai-meeting-x5.ndjson", trackId: "ai-meeting", label: "AI 会议纪要 × 5 产品" },
];

const reports = {};
const baked = [];
for (const s of SOURCES) {
  const p = path.isAbsolute(s.file) ? s.file : path.join(ROOT, s.file);
  if (!fs.existsSync(p)) { console.warn(`  ! 跳过（找不到文件）: ${s.file}`); continue; }
  const line = fs.readFileSync(p, "utf8").split("\n").find((l) => l.includes('"type":"report"'));
  if (!line) { console.warn(`  ! 跳过（无 report 事件）: ${s.file}`); continue; }
  const r = JSON.parse(line);
  delete r.recurring;               // 演示版从 localStorage 现算，不烘焙历史

  // 来源分级是 source_url 的纯函数 → 对历史语料**回溯应用**，
  // 不用为了拿到等级去重跑一遍调研。
  r.products = gradeReport(r.products);
  let weak = 0, tot = 0;
  for (const p of r.products) for (const c of Object.values(p.fields || {})) {
    if (c.value && c.source_grade) { tot++; if (!c.source_adequate) weak++; }
  }

  reports[s.trackId] = r;
  baked.push(`${s.trackId}  ←  ${s.label}  (${r.summary.total} 槽位, 拦截编造 ${r.summary.rejected}, 来源不够格 ${weak}/${tot})`);
}

if (!Object.keys(reports).length) {
  console.error("\n没有可烘焙的报告。先跑一次调研，把 ndjson 路径作为参数传进来：");
  console.error("  node build-demo.mjs /path/to/report.ndjson\n");
  process.exit(1);
}

// ── 2. 组装演示数据 ─────────────────────────────────────────
const reportList = baked.map((b) => b.split("  ←  ")[1].split("  (")[0]);
const demoData = {
  config: { tracks: TRACKS, fields: FIELDS, confidence: CONFIDENCE, grades: GRADES },
  reports,
  note: `<strong>这是演示版，不是空壳。</strong>页面里 ${Object.keys(reports).length} 份报告都是<strong>真实联网调研跑出来的原始结果</strong>（${reportList.join("、")}），数据<strong>未经人工修饰</strong>——包括模型答得含糊的地方和查不到的字段。<br>
        <strong>动手试一下：</strong>点表格里任意一格就能改数据、选修改原因。同一个字段改满 <strong>2 次</strong>，它会当场升级为「高频错误点」并出现在顶部横幅——这是自进化钩子的真实行为，记录存在你浏览器本地，不联网。<br>
        <strong>关于「拦截的编造」为什么显示 0：</strong>0 才是目标值。它的机制是——模型每给出一个来源 URL，代码都会拿去和本次检索真实返回的 URL 集合比对，对不上就判定为编造、清空该值并降级为「未获取」。实测中确实拦截到过，例如模型给 Fathom 的「起步价」标注来源 <code>comparedge.com</code>，而该 URL 在本次检索结果里从未出现。<br>
        <strong>表格里的来源等级徽章：</strong>URL 能点开 <strong>≠</strong> 够格支撑这条事实。每个来源都被独立定级，标红的「广告 / 聚合」意味着这个链接真实存在、但内容来自投放落地页或对比目录站，不足以作为事实依据。<br>
        <strong>两份报告恰好能对比：</strong>「AI 写作」那份跑在<strong>补证闭环上线之后</strong>——不够格的来源已经先被定向重搜过一轮，救不回来的降级为「未获取」，所以你看不到标红的引用，代价是<strong>那几格是空的</strong>；「AI 会议纪要」那份跑在补证之前，还留着原始的标红引用。<strong>这两种状态哪个更好，取决于你要的是「多一些数字」还是「每个数字都站得住」。</strong><br>
        <strong>演示版不含：</strong>实时调研新赛道（需要后端持有 API 密钥，且浏览器直连多数 API 会被跨域拦截）。完整版用 <code>npm start</code> 启动。`,
};

// 内联进 <script> 时必须转义 '<'，否则内容里的 </script> 会截断文档
const jsonForScript = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

// ── 3. 内联 ────────────────────────────────────────────────
let html = read("public/index.html");
const css = read("public/styles.css");
const js = read("public/app.js");

html = html
  .replace('<link rel="stylesheet" href="/styles.css">', `<style>\n${css}\n</style>`)
  .replace('<script src="/app.js"></script>',
    `<script type="application/json" id="demo-data">${jsonForScript(demoData)}</script>\n<script>\n${js}\n</script>`)
  .replace("<title>赛道雷达 · AI 赛道可比信息抽取</title>", "<title>赛道雷达 · 演示版</title>");

if (html.includes('href="/styles.css"') || html.includes('src="/app.js"')) {
  console.error("内联失败：index.html 里仍有外部引用，检查选择器是否变了");
  process.exit(1);
}

const OUT = path.join(ROOT, "track-radar-demo.html");
fs.writeFileSync(OUT, html, "utf8");

// 同时输出一份到 docs/index.html —— GitHub Pages 从 /docs 发布时，
// 仓库地址根路径直接就是这个页面
const DOCS = path.join(ROOT, "docs");
fs.mkdirSync(DOCS, { recursive: true });
fs.writeFileSync(path.join(DOCS, "index.html"), html, "utf8");

const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
console.log(`\n  ✅ 已生成 ${path.basename(OUT)}  (${kb} KB)`);
console.log(`  ✅ 已同步 docs/index.html（GitHub Pages 用）\n`);
baked.forEach((b) => console.log(`     · ${b}`));
console.log(`\n  双击即可打开，无需 Node、无需联网、无需密钥。\n`);
