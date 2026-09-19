import Anthropic from "@anthropic-ai/sdk";
import { FIELDS, FIELD_KEYS, extractJSON, coerceProduct } from "./schema.mjs";

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
    const filled = FIELD_KEYS.filter((k) => coerced.fields[k].value).length;
    log(`${product.name}：完成，${filled}/${FIELD_KEYS.length} 个字段有值`);

    return { ...coerced, vendor: product.vendor, url: product.url, page_count: urls.size };
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
  return out;
}
