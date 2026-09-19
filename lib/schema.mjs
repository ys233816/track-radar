// 对比表的字段定义。改这里就能改报告比什么 —— 流水线其余部分不用动。
export const FIELDS = [
  { key: "positioning",  label: "产品定位",        hint: "一句话说明它是什么、给谁用" },
  { key: "target_user",  label: "目标用户",        hint: "主要面向的个人或团队类型" },
  { key: "core_capability", label: "核心能力",     hint: "最关键的功能特性，不要罗列全部功能" },
  { key: "free_tier",    label: "免费额度",        hint: "免费版的限制；没有免费版就写「无免费版」" },
  { key: "start_price",  label: "起步价（原文）",   hint: "官网写的最低付费档原文，含币种和周期" },
  { key: "price_model",  label: "计价方式",        hint: "按席位 / 按用量 / 一次性 / 定制报价" },
  { key: "price_usd_month", label: "起步月费",     hint: "最低付费档按年付口径折算成 USD/月的单个数字（不带单位、不带区间）；折算不出来就 null", numeric: true },
  { key: "key_limit",    label: "关键限制",        hint: "官网明写的硬限制：额度、并发、席位、字数" },
  { key: "deployment",   label: "部署方式",        hint: "SaaS / 私有化 / 本地 / 浏览器插件" },
  { key: "data_policy",  label: "数据使用政策",     hint: "用户数据是否被用于训练模型" },
];

export const FIELD_KEYS = FIELDS.map((f) => f.key);

// 置信度三档。unknown 不是失败，是「查不到」的正常输出。
export const CONFIDENCE = {
  verified:       { label: "已核实",   desc: "有可点开的第三方或官方页面支撑" },
  official_claim: { label: "官方声明", desc: "仅有厂商自述，未经独立验证" },
  unknown:        { label: "未获取",   desc: "公开渠道未找到，需人工补" },
};

export const TRACKS = [
  { id: "ai-writing",  name: "AI 写作",     seed: "AI writing assistant / AI 文案写作工具" },
  { id: "ai-support",  name: "AI 客服",     seed: "AI customer support / AI 客服机器人平台" },
  { id: "ai-coding",   name: "AI 编程",     seed: "AI coding assistant / AI 编程助手" },
  { id: "ai-design",   name: "AI 设计",     seed: "AI image design / AI 设计生成工具" },
  { id: "ai-meeting",  name: "AI 会议纪要", seed: "AI meeting notes / AI 会议转写纪要工具" },
  { id: "ai-search",   name: "AI 搜索问答", seed: "AI search engine / AI 搜索问答产品" },
];

// 从模型返回的文本里抠出 JSON —— 不依赖任何厂商专有的结构化输出特性。
export function extractJSON(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const open = t[start];
  const close = open === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 把归一阶段的产物强行掰成合法结构：缺字段补 unknown，值类型不对就丢弃。
// 这一步是「不合格就降级」而不是「猜一个」。
export function coerceProduct(raw, productName, seenUrls) {
  const r = raw && typeof raw === "object" ? raw : {};
  const fieldsRaw = r.fields && typeof r.fields === "object" ? r.fields : r;

  const fields = {};
  for (const f of FIELD_KEYS) {
    const cell = fieldsRaw[f];
    let value = cell && typeof cell === "object" ? cell.value : cell;
    let source_url = cell && typeof cell === "object" ? cell.source_url : null;
    let confidence = cell && typeof cell === "object" ? cell.confidence : null;

    if (value === undefined || value === null || value === "") {
      fields[f] = { value: null, source_url: null, confidence: "unknown", verified: false };
      continue;
    }
    value = String(value).trim();

    // 代码层硬校验：声称的来源必须真的在这次调研见过，否则判定为编造。
    const cited = typeof source_url === "string" ? source_url.trim() : null;
    const isReal = cited && seenUrls.has(cited);

    if (!cited) {
      fields[f] = { value, source_url: null, confidence: "official_claim", verified: false, note: "无来源" };
    } else if (!isReal) {
      // 来源对不上 —— 不采信，降级为未获取，原始值留档供人工判断
      fields[f] = {
        value: null, source_url: null, confidence: "unknown", verified: false,
        rejected: { claimed_url: cited, value },
      };
    } else {
      const conf = confidence === "verified" || confidence === "official_claim" ? confidence : "official_claim";
      fields[f] = { value, source_url: cited, confidence: conf, verified: true };
    }
  }

  // 数值字段必须真的是数值。模型爱回「16.99 美元/用户/月」这种带单位的串，
  // 或者「$10 年付 / $18 月付」这种含两个数的串 —— 后者有歧义，绝不猜。
  const pmv = fields.price_usd_month;
  if (pmv && pmv.value) {
    const nums = String(pmv.value).match(/\d+(?:[.,]\d+)?/g) || [];
    if (nums.length === 1) {
      pmv.numeric = Number(nums[0].replace(",", ""));
      pmv.value = String(pmv.numeric);
    } else {
      fields.price_usd_month = {
        value: null, source_url: null, confidence: "unknown", verified: false,
        downgraded: { reason: nums.length ? "数值有歧义，含多个数字，不做取舍" : "不是数值", dropped: pmv.value },
      };
    }
  }

  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u || "?"; } };

  // 不变量一：月费必须与它所依据的「起步价原文」**同源**。
  // 不同源就是两条互相独立的证据，可能互相打架 ——
  // 实测：Writesonic 官方博客写「$99/月，年付 $79」，第三方 geekflare 写「39」，
  // 模型拿了第三方那个数，还因为它是第三方而标成 verified。方向完全反了。
  const pm = fields.price_usd_month;
  const sp = fields.start_price;
  if (pm && pm.value && (pm.source_url || null) !== (sp && sp.source_url ? sp.source_url : null)) {
    fields.price_usd_month = {
      value: null, source_url: null, confidence: "unknown", verified: false,
      downgraded: {
        reason: `换算来源与起步价来源不同（${host(pm.source_url)} ≠ ${host(sp && sp.source_url)}），可能不是同一口径，不予采信`,
        dropped: pm.value, conflicting_url: pm.source_url,
      },
    };
  }

  // 不变量二：归一后的月费不能比它的原始依据更可信。
  // 拿不到「起步价原文」却说能算出「起步月费」，读者看到的就是自相矛盾。
  // 这两条约束写在代码里，不写进 prompt —— prompt 拦不住。
  const pm2 = fields.price_usd_month;
  if (pm2 && pm2.value && (!sp || !sp.value || sp.confidence === "unknown")) {
    fields.price_usd_month = {
      value: null, source_url: null, confidence: "unknown", verified: false,
      downgraded: { reason: "起步价原文未获取，月费换算不予采信", dropped: pm2.value },
    };
  }

  return {
    name: (r.name && String(r.name).trim()) || productName,
    fields,
  };
}

export function summarize(products) {
  const total = products.length * FIELD_KEYS.length;
  let verified = 0, claim = 0, unknown = 0, rejected = 0;
  for (const p of products) {
    for (const k of FIELD_KEYS) {
      const c = p.fields[k];
      if (!c) continue;
      if (c.rejected) rejected++;
      if (c.confidence === "verified") verified++;
      else if (c.confidence === "official_claim") claim++;
      else unknown++;
    }
  }
  return {
    total, verified, claim, unknown, rejected,
    coverage: total ? Math.round(((verified + claim) / total) * 100) : 0,
    fabrication_rate: total ? Math.round((rejected / total) * 1000) / 10 : 0,
  };
}
