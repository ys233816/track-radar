/* 来源分级。
   解决的问题：URL 校验只能判断「这个链接真的存在」，判断不了「它够不够格支撑这条事实」。
   实测中 17.11% 的引用是广告落地页或聚合站 —— 它们全部通过了 URL 校验。

   分级是 source_url 的纯函数，所以可以**回溯应用**到历史语料，不需要重跑调研。

   这是确定性的代码规则，不是让模型自己判断 —— 与项目其余部分一致：
   能写成不变量的事，不写进 prompt。 */

// ── 等级定义（由强到弱）────────────────────────────────────
export const GRADES = {
  T1: { id: "T1", label: "官方定价页", short: "定价", weight: 1.0, desc: "厂商自己的定价/套餐页面，价格类字段的最强来源" },
  T2: { id: "T2", label: "官方文档",   short: "文档", weight: 0.9, desc: "厂商官方文档、帮助中心、开发者文档" },
  T3: { id: "T3", label: "官方其他",   short: "官方", weight: 0.75, desc: "官网首页、博客、法务页 —— 属厂商自述" },
  T4: { id: "T4", label: "第三方评测", short: "三方", weight: 0.8, desc: "独立媒体、评测站、行业报告" },
  T5: { id: "T5", label: "聚合目录站", short: "聚合", weight: 0.3, desc: "对比站、工具目录、导购站 —— 信息多为转述，易过时" },
  T6: { id: "T6", label: "广告落地页", short: "广告", weight: 0.1, desc: "带投放跟踪参数的页面，内容为营销投放而非产品事实" },
};

// 价格类字段：只有官方定价页和第三方评测够格，博客/首页的自述不作为价格依据
export const PRICE_FIELDS = ["start_price", "price_model", "price_usd_month", "free_tier"];

// ── 判定信号 ────────────────────────────────────────────────
// 投放跟踪参数：出现即判为广告落地页，优先级最高（其他信号一律让位）
const TRACKING = /[?&](utm_source|utm_medium|utm_campaign|utm_content|utm_term|gclid|fbclid|msclkid|yclid)=/i;

// 官方定价页 / 文档页的关键词。
// 注意：必须同时匹配**子域名**和**路径** —— `help.otter.ai`、`docs.granola.ai`
// 这类把信号放在域名里，只在路径里找会全部漏判成「官方其他」。
const OFFICIAL_PRICING = /(^|[./])(pricing|plans?|price|packages?|billing)([./]|$)/i;
const OFFICIAL_DOCS = /(^|[./])(docs?|documentation|help|support|kb|manual|guide|developers?)([./]|$)/i;

// 聚合/目录/对比站的路径特征
const AGGREGATOR_PATH = /(^|\/)(reviews?|compare|comparison|alternatives?|tools?|directory|categories|software)(\/|$)/i;
// 已知聚合站域名（首版，说明在 README 里 —— 这是个会过时的清单，不是完备规则）
const AGGREGATOR_HOST = /(^|\.)(g2\.com|capterra\.com|getapp\.com|softwareadvice\.[a-z.]+|alternativeto\.net|toolchase\.com|techreviewer\.co|comparison|comparedge|costbench\.com|vendr\.com|saaszap\.com|sourceforge\.net|producthunt\.com|slashdot\.org|trustradius\.com|softwaresuggest\.com|goodfirms\.co|geekflare\.com)$/i;

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };
const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ""; } };

// 官方域名判定：域名里是否含产品名或厂商名的关键片段
function isOfficialHost(host, product, vendor) {
  if (!host) return false;
  const h = host.replace(/[^a-z0-9]/g, "");
  return [product, vendor]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((k) => k.length >= 3)
    .some((k) => h.includes(k));
}

/**
 * 给一个来源 URL 定级。
 * @param {string} url
 * @param {{product?:string, vendor?:string}} ctx
 * @returns {{id:string,label:string,short:string,weight:number,why:string}}
 */
export function gradeSource(url, ctx = {}) {
  if (!url || typeof url !== "string") {
    return { ...GRADES.T6, id: "NONE", label: "无来源", short: "无", weight: 0, why: "没有来源 URL" };
  }
  const host = hostOf(url);
  const path = pathOf(url);

  // 解析不出域名 = 这不是一个可用来源，而不是"第三方来源"。
  // 降级成 T4 会让垃圾串看起来像个合格引用。
  if (!host) {
    return { ...GRADES.T6, id: "NONE", label: "无来源", short: "无", weight: 0, why: "URL 无法解析出域名" };
  }

  // 1. 投放参数优先 —— 广告落地页，无论域名多"官方"
  if (TRACKING.test(url)) {
    return { ...GRADES.T6, why: "URL 含投放跟踪参数，是广告落地页而非产品事实页" };
  }
  // 2. 已知聚合/目录站
  if (host && AGGREGATOR_HOST.test(host)) {
    return { ...GRADES.T5, why: `${host} 是对比/目录站，信息多为转述` };
  }
  // 3. 非官方域名 + 聚合路径特征
  const official = isOfficialHost(host, ctx.product, ctx.vendor);
  if (!official && AGGREGATOR_PATH.test(path)) {
    return { ...GRADES.T5, why: `路径 ${path} 呈目录/评测站特征` };
  }
  // 4. 官方域名细分。匹配目标 = 域名 + 路径，
  //    因为 help./docs./support. 这类子域名把信号放在域名里。
  const target = `${host || ""}${path || ""}`;
  if (official) {
    if (OFFICIAL_PRICING.test(target)) return { ...GRADES.T1, why: "官方定价页" };
    if (OFFICIAL_DOCS.test(target)) return { ...GRADES.T2, why: "官方文档 / 帮助中心" };
    return { ...GRADES.T3, why: "官方站点，但非定价页或文档页" };
  }
  // 5. 其余按第三方评测
  return { ...GRADES.T4, why: `独立第三方站点 ${host}` };
}

/**
 * 判断某个字段能否被这个等级的来源支撑。
 *
 * 判定分两类，边界刻意划得保守，避免把「正当来源」误判成「不合格」：
 *   1. 来源本身就没权威性（聚合站 T5、广告页 T6）→ 对**任何**字段都不够格
 *   2. 来源有权威性，但不足以支撑**这一类**声明 ——
 *      价格类字段不接受 T3（官网首页/博客/营销页），因为这类页面上的价格
 *      常是引流话术、档位不全或已过时；T1 定价页 / T2 官方文档 / T4 第三方评测 都可以。
 */
export function isAdequate(fieldKey, gradeId) {
  if (gradeId === "NONE") return false;
  if (gradeId === "T5" || gradeId === "T6") return false;
  if (PRICE_FIELDS.includes(fieldKey)) return ["T1", "T2", "T4"].includes(gradeId);
  return ["T1", "T2", "T3", "T4"].includes(gradeId);
}

/** 给整份报告的所有字段补上来源等级与是否够格。纯函数，可回溯应用。 */
export function gradeReport(products) {
  const out = [];
  for (const p of products) {
    const fields = {};
    for (const [k, cell] of Object.entries(p.fields || {})) {
      if (!cell || !cell.value || !cell.source_url) { fields[k] = cell; continue; }
      const grade = gradeSource(cell.source_url, { product: p.name, vendor: p.vendor });
      fields[k] = { ...cell, source_grade: grade, source_adequate: isAdequate(k, grade.id) };
    }
    out.push({ ...p, fields });
  }
  return out;
}
