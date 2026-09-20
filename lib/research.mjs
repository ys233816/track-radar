import Anthropic from "@anthropic-ai/sdk";
import { FIELDS, FIELD_KEYS, extractJSON, coerceProduct } from "./schema.mjs";
import { gradeReport } from "./source-grade.mjs";

const MODEL = process.env.TRACK_RADAR_MODEL || "claude-opus-5";
const client = new Anthropic({ timeout: 600000 });

const WEB_SEARCH = { type: "web_search_20260209", name: "web_search" };

// 从一次响应的所有 web_search_tool_result 块里收集真实出现过的 URL。
// 这就是后面判定「编造」的基准清单。
function collectUrls(message) {
  const urls = new Set();
  for (const b of message.content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
      for (const item of b.content) if (item && item.url) urls.add(item.url);
    }
  }
  return urls;
}

function textOf(message) {
  return (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

// 必须走流式：调研单次请求可能跑几分钟，非流式会被网关按 180s 掐断。
async function call(prompt, { search = false, maxUses = 6, system, maxTokens = 16000 } = {}) {
  const req = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) req.system = system;
  if (search) req.tools = [{ ...WEB_SEARCH, max_uses: maxUses }];

  const stream = client.messages.stream(req);
  const msg = await stream.finalMessage();
  return { text: textOf(msg), urls: collectUrls(msg), stop: msg.stop_reason, raw: msg };
}

// ── 阶段 0：选品 ────────────────────────────────────────────────
export async function discoverProducts(track, log) {
  log(`正在联网查找「${track.name}」赛道的主流产品…`);
  const { text, urls } = await call(
    `联网查找「${track.name}」（${track.seed}）这个 AI 细分赛道里最主流的 6 个产品。

对每个产品给出：
- name：产品名（品牌名，不要写公司全称）
- vendor：所属公司
- url：产品官网地址
- why：一句话说明它为什么是这个赛道的主流玩家

只输出一个 JSON 数组，不要任何解释文字，不要 markdown 代码块。格式：
[{"name":"...","vendor":"...","url":"...","why":"..."}]`,
    { search: true, maxUses: 5 }
  );

  const arr = extractJSON(text);
  const seen = new Set();
  const list = (Array.isArray(arr) ? arr : [])
    .filter((p) => p && p.name && String(p.name).trim())
    .map((p) => ({
      name: String(p.name).trim(),
      vendor: String(p.vendor || "").trim(),
      url: String(p.url || "").trim(),
      why: String(p.why || "").trim(),
    }))
    .filter((p) => {
      const k = p.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);

  log(`找到 ${list.length} 个候选产品（本次检索触碰 ${urls.size} 个页面）`);
  return list;
}

// ── 阶段 1：联网调研（不约束输出，只收集事实和真实 URL）────────────
async function gather(product, track, log) {
  const dims = FIELDS.map((f) => `- ${f.label}：${f.hint}`).join("\n");

  const { text, urls } = await call(
    `联网调研「${product.name}」这个产品，赛道是「${track.name}」。

需要查清以下维度：
${dims}

输出要求：
1. 逐维度列出你**实际查到的原文事实**，每条事实后面紧跟支撑它的确切 URL。
2. 格式：每条写成 【维度名】事实内容 —— 来源：<url>
3. **查不到的维度，明确写【维度名】未找到**。这是完全可接受的答案。
4. 严禁根据印象、常识或同类产品推断。你只能写页面上真实出现过的内容。
5. 若不同来源说法冲突，把冲突双方都列出来，不要自己选一个。
6. 只记录**能直接回答该维度**的内容。如果页面上只有沾边但答非所问的片段（帮助文档的导航文字、安装步骤、模板占位符、政策条款的通用段落），**不要记录**，视为该维度未找到。宁缺勿滥。

先搜索，再阅读，最后汇总。`,
    { search: true, maxUses: 8 }
  );

  log(`${product.name}：读取 ${urls.size} 个页面，记录 ${text.length} 字`);
  return { text: text.slice(0, 14000), urls };
}

// ── 阶段 2：归一为结构化字段（不联网，只做整理）──────────────────
const NORMALIZE_SYSTEM = `你在做信息归一：把一份调研原始记录，整理成结构化字段。

硬性规则（违反即视为失败）：
1. 每个字段的 source_url 必须从用户给出的【URL 清单】里**原样复制**，一个字都不能改。
2. 原始记录里没有 URL 支撑的字段 → value 填 null，confidence 填 "unknown"。
3. **绝对禁止编造 URL，禁止用常识补全内容。**
4. confidence 取值只能是这三个字符串之一（判定标准见第 7 条）：
   - "verified" —— 有**独立第三方**页面支撑该事实
   - "official_claim" —— 仅有**厂商自己**的官网/文档/博客
   - "unknown" —— 查不到，或只有答非所问的片段
5. price_usd_month 取**最低付费档**，按**年付口径**折算成 USD/月的**单个数字**：
   不带单位、不带货币符号、不带区间、不带任何文字。官网同时列月付与年付两个价时取年付。
   折算不出来（如「联系销售」「定制报价」）就填 null。
6. value 必须是**对该维度问题的直接回答**，用完整通顺的话表述。
   如果原始记录里只有答非所问的页面片段、导航文字、安装步骤或模板占位符，
   **视为未找到**：value 填 null，confidence 填 "unknown"。宁可标未获取，也不要塞一段没意义的话进去。
7. 当来源是产品官网或官方文档时 confidence 用 "official_claim"；
   只有当来源是独立的第三方页面（评测媒体、对比站、新闻报道）时才用 "verified"。

只输出 JSON 对象，不要 markdown 代码块，不要任何解释文字。`;

function normalizePrompt(product, rawText, urlList) {
  const tmpl = FIELD_KEYS.map((k) => `    "${k}": {"value": null, "source_url": null, "confidence": "unknown"}`).join(",\n");
  return `【URL 清单】
${urlList.join("\n") || "（本次没有取到任何 URL）"}

【调研原始记录】
${rawText}

【输出格式】严格照此结构输出 JSON：
{
  "name": "${product.name}",
  "fields": {
${tmpl}
  }
}`;
}

async function normalize(product, rawText, seenUrls, log) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text } = await call(
      normalizePrompt(product, rawText, [...seenUrls]),
      { search: false, system: NORMALIZE_SYSTEM }
    );
    const parsed = extractJSON(text);
    if (parsed) {
      if (attempt > 1) log(`${product.name}：重试后归一成功`);
      return parsed;
    }
    log(`${product.name}：归一输出不是合法 JSON${attempt === 1 ? "，重试一次" : "，放弃"}`);
  }
  return null;
}

// ── 阶段 3：重新取证（来源不够格时触发）──────────────────────────
// 不够格 → 定向重搜一次 → 还是不够格 → 降级为「未获取」。
// 这里的关键不是"再搜一次"，而是**搜的时候不许拿原来源充数** ——
// 否则模型会为了填坑而把刚才那条不合格的链接再交一遍。
const RETRY_ENABLED = process.env.RADAR_NO_RETRY !== "1";

const REGATHER_SYSTEM = `你在做**定向补证**：某些字段当前引用的来源不够格，需要你重新去找够格的来源。

【什么算够格】
- 价格类字段（起步价、免费额度、计价方式）：官方定价页，或独立第三方评测
- 其他字段：厂商官方文档 / 帮助中心最好

【什么算不够格，不要再用】
- 广告落地页：URL 带 utm_ / gclid / fbclid 等投放参数的页面
- 聚合目录站 / 对比站：vendr、g2、capterra、geekflare、techreviewer、saaszap 这类
- 官网首页或营销博客上的**价格**（档位不全、易过时）

【最高优先级的做法】
直接去厂商官网的 pricing / plans / docs 路径下找，并给出你**实际访问的确切 URL**。

找不到就说找不到。**为了填补空缺而放宽标准，比空着更糟。**`;

function weakList(product) {
  return FIELD_KEYS
    .map((k) => ({ key: k, cell: product.fields[k] }))
    .filter((x) => x.cell && x.cell.value && x.cell.source_adequate === false);
}

async function regather(product, track, weak, log) {
  const fieldDef = (k) => FIELDS.find((f) => f.key === k) || { label: k, hint: "" };
  const list = weak.map((w) => {
    const f = fieldDef(w.key);
    return `- ${f.label}：${f.hint}\n    当前值「${String(w.cell.value).slice(0, 60)}」，来源 ${w.cell.source_grade.label}（${w.cell.source_grade.why}）`;
  }).join("\n");

  const { text, urls } = await call(
    `产品：「${product.name}」　赛道：「${track.name}」

以下字段当前的来源**不够格**，请专门为它们重新查找：

${list}

要求：
1. 逐个字段去找**够格的来源**（标准见系统提示）
2. 每条事实后必须紧跟支撑它的**确切 URL**
3. 确实找不到够格来源的，明确写「【字段名】未找到够格来源」—— 这是完全可接受的答案
4. **严禁把上面列出的原来源再交一遍**，也严禁为了填空而降低标准
5. 严禁凭印象或常识推断

先搜索，再阅读，最后汇总。`,
    { search: true, maxUses: 8 }
  );

  log(`${product.name}：重新取证读取 ${urls.size} 个页面`);
  const parsed = await normalize(product, text.slice(0, 14000), urls, log);
  // 同样要过 coerceProduct：重搜来的来源也必须能对上前一轮的 URL 清单
  return parsed ? coerceProduct(parsed, product.name, urls) : null;
}

/** 只把"确实改善了"的格子换掉，其余原样保留 —— 不做整行替换。 */
function mergeRetry(original, retry) {
  if (!retry) return { ...original, _rescued: 0 };
  const fields = { ...original.fields };
  let rescued = 0;
  for (const { key, cell } of weakList(original)) {
    const nf = retry.fields[key];
    if (nf && nf.value && nf.source_url) {
      fields[key] = nf;
      rescued++;
    }
  }
  return { ...original, fields, _rescued: rescued };
}

/** 补证后来源仍不够格的，按「宁缺勿猜」降级 —— 留着一条撑不住的引用，比空着更糟。 */
function downgradeStillWeak(product, log) {
  const fields = { ...product.fields };
  const dropped = [];
  for (const { key, cell } of weakList(product)) {
    fields[key] = {
      value: null, source_url: null, confidence: "unknown", verified: false,
      downgraded: {
        reason: `重新取证后来源仍不够格（${cell.source_grade.label}），按「宁缺勿猜」降级为未获取`,
        dropped: cell.value, weak_url: cell.source_url,
      },
    };
    dropped.push(key);
  }
  if (dropped.length) {
    log(`${product.name}：↓ ${dropped.length} 个字段补证失败，降级为未获取（${dropped.join(", ")}）`);
  }
  return { ...product, fields };
}

// ── 单个产品的完整链路 ───────────────────────────────────────────
export async function researchProduct(product, track, log) {
  try {
    const { text, urls } = await gather(product, track, log);
    if (urls.size === 0) {
      log(`${product.name}：⚠ 未取到任何页面，全部字段将标为未获取`);
    }
    const parsed = await normalize(product, text, urls, log);
    const coerced = coerceProduct(parsed, product.name, urls);

    const rejected = FIELD_KEYS.filter((k) => coerced.fields[k].rejected);
    if (rejected.length) {
      log(`${product.name}：⛔ 拦截 ${rejected.length} 个来源对不上的字段（判定为编造，已降级为未获取）`);
    }

    let result = { ...coerced, vendor: product.vendor, url: product.url, page_count: urls.size };
    result = gradeReport([result])[0];

    // ── 触发条件：有"能点开但不够格"的字段 ──
    const weakBefore = weakList(result).map((w) => w.key);
    if (weakBefore.length && RETRY_ENABLED) {
      const byGrade = {};
      for (const w of weakList(result)) byGrade[w.cell.source_grade.id] = (byGrade[w.cell.source_grade.id] || 0) + 1;
      log(`${product.name}：↻ ${weakBefore.length} 个字段来源不够格（${Object.entries(byGrade).map(([k, v]) => k + "×" + v).join(" ")}），触发重新取证`);

      const retry = await regather(product, track, weakList(result), log);
      result = mergeRetry(result, retry);
      result = gradeReport([result])[0];
      result = downgradeStillWeak(result, log);

      // 统计必须在**降级之后**做。
      // 降级前统计会把「换到了一个新值、但新来源同样不够格」也算成救回 ——
      // 日志上看起来成功，实际白跑一趟。实测中这种情况占多数。
      const survived = weakBefore.filter((k) => {
        const c = result.fields[k];
        return c && c.value && c.source_adequate !== false;
      });
      // 给救回的格子打标记，让语料**自我描述** ——
      // 否则评测只能靠「降级理由里有没有某句话」去猜，那是脆弱的字符串匹配。
      for (const k of survived) result.fields[k] = { ...result.fields[k], source_retried: true };

      result._retry = {
        triggered: weakBefore.length,
        rescued: survived.length,
        dropped: weakBefore.length - survived.length,
      };
      log(`${product.name}：补证结果 —— 救回 ${survived.length} / ${weakBefore.length}，降级 ${weakBefore.length - survived.length}`);
    }

    const filled = FIELD_KEYS.filter((k) => result.fields[k].value).length;
    log(`${product.name}：完成，${filled}/${FIELD_KEYS.length} 个字段有值`);
    return result;
  } catch (e) {
    log(`${product.name}：✗ 调研失败 —— ${String(e.message).slice(0, 160)}`);
    return {
      name: product.name, vendor: product.vendor, url: product.url,
      fields: Object.fromEntries(FIELD_KEYS.map((k) => [k, { value: null, source_url: null, confidence: "unknown", verified: false }])),
      error: String(e.message).slice(0, 200),
    };
  }
}

// ── 全赛道调研，并发 3 ───────────────────────────────────────────
const CONCURRENCY = Number(process.env.RADAR_CONCURRENCY) || 3;

export async function runResearch(products, track, log) {
  const out = new Array(products.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= products.length) return;
      out[i] = await researchProduct(products[i], track, log);
    }
  }

  const n = Math.max(1, Math.min(CONCURRENCY, products.length));
  await Promise.all(Array.from({ length: n }, worker));

  // 来源分级：在返回前补上等级与「够不够格支撑该字段」。
  // 这一步是纯函数，所以同一套规则也能回溯应用到历史语料和评测。
  const graded = gradeReport(out);
  let weak = 0, total = 0;
  for (const p of graded) for (const c of Object.values(p.fields || {})) {
    if (!c.value || !c.source_grade) continue;
    total++;
    if (!c.source_adequate) weak++;
  }
  if (total) log(`来源分级完成：${weak}/${total} 个引用不够格支撑其字段（${(weak / total * 100).toFixed(1)}%）`);
  return graded;
}
