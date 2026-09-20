/* 文档数字校验。
   防止 README / RESUME / JOURNAL 里的数字在语料增长后过期。
   我在这件事上已经犯过三次：写过「4 轮实跑」（真实 7 轮）、猜过「240 槽位」
   （真实 280）、语料扩到 370 后忘了同步全部文档。

   做法刻意保持简单：
     ① 权威值必须出现（值来自 eval/key-numbers.json）
     ② 已作废的值不许出现（SUPERSEDED 列表）
   不去解析散文 —— 正则匹配散文会报一堆假警，最后没人看。
   每次指标变动，把旧值加进 SUPERSEDED 即可。

   跑：node test/docs-numbers.mjs */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const K = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "key-numbers.json"), "utf8"));

const DOCS = ["README.md", "RESUME.md", "JOURNAL.md"];

// ① 权威值：这些字符串必须出现（允许文档只引用其中一部分）
const REQUIRED = {
  "README.md": [
    `${K.编造率.值}%`, `${K.编造率.分子}/${K.编造率.分母}`,
    `${K.不够格引用.值}%`, `${K.不够格引用.分子}/${K.不够格引用.分母}`,
    `${K.补证成功率}%`, `${K.槽位总数} 个字段槽位`,
  ],
  "RESUME.md": [
    `${K.编造率.值}%`, `${K.不够格引用.值}%`, `${K.槽位总数} 个字段槽位`,
  ],
  "JOURNAL.md": [
    `${K.编造率.值}%`, `${K.不够格引用.值}%`, `${K.槽位总数} 个字段槽位`,
  ],
};

// ② 已作废的值：这些不许再出现。语料每增长一次就把旧值挪进来。
//
// 豁免：「4 轮实跑」「240」不在列内。它们是 JOURNAL.md 里**作为教训被引用**的
// 历史错误（"我曾在 README 里写 4 轮实跑，真实是 7 轮"），不是仍在流通的声明。
// 把教训也一并禁掉，等于禁止项目记录自己犯过的错。
const SUPERSEDED = [
  // 「1.79%」「5/280」不列入 —— 它们同样出现在 JOURNAL 的教训段里
  "41.06%", "108/263",       // 语料 263 槽位时期
  "36.6%", "108/295",        // 语料 295 槽位时期
  "补证成功率约 58%",
];

let fail = 0;
for (const f of DOCS) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  const problems = [];

  for (const need of REQUIRED[f] || []) {
    if (!text.includes(need)) problems.push(`缺权威值「${need}」`);
  }
  for (const stale of SUPERSEDED) {
    if (text.includes(stale)) problems.push(`含已作废的值「${stale}」`);
  }

  if (problems.length) {
    fail += problems.length;
    console.log(`\n  ✗ ${f}`);
    problems.forEach((x) => console.log(`      ${x}`));
  } else {
    console.log(`  ✓ ${f}`);
  }
}

console.log("\n" + "─".repeat(58));
if (fail) {
  console.log(`  ${fail} 处问题`);
  console.log(`  当前权威值：编造率 ${K.编造率.值}% (${K.编造率.分子}/${K.编造率.分母})　` +
    `不够格 ${K.不够格引用.值}% (${K.不够格引用.分子}/${K.不够格引用.分母})　` +
    `补证 ${K.补证成功率}%　槽位 ${K.槽位总数}`);
  console.log("─".repeat(58) + "\n");
  process.exit(1);
}
console.log(`  三份文档均与 eval/key-numbers.json 一致`);
console.log(`  语料：${K.语料轮数} 轮 / ${K.槽位总数} 槽位　指纹 ${K._语料指纹}`);
console.log("─".repeat(58) + "\n");
