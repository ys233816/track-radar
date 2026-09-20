/* 赛道雷达 · 前端
   设计约束：图表颜色低于 3:1 对比度 → 必须印可见数字标签，不能只靠颜色区分。

   双模式：同一份源码既能跑在 Node 后端上（联网调研），
   也能被构建脚本内联成单文件演示版（数据烘焙进 HTML，双击即开）。 */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 单文件演示版会内联一段 <script id="demo-data" type="application/json">；没有就是联网模式。
const DEMO = (() => {
  const el = document.getElementById("demo-data");
  try { return el ? JSON.parse(el.textContent) : null; } catch { return null; }
})();
const DEMO_STORE_KEY = "track-radar-corrections";

// 校正记录的存储后端：联网模式走服务器 CSV，演示模式走 localStorage。
// 两种模式跑的是同一套「同产品同字段改 ≥2 次 → 升级为高频错误点」逻辑。
const store = DEMO ? {
  all() { try { return JSON.parse(localStorage.getItem(DEMO_STORE_KEY) || "[]"); } catch { return []; } },
  add(rec) { const a = this.all(); a.push({ ts: new Date().toISOString(), ...rec }); localStorage.setItem(DEMO_STORE_KEY, JSON.stringify(a)); return a.length; },
  recurring() {
    const m = new Map();
    for (const c of this.all()) {
      const k = c.product + "||" + c.field;
      if (!m.has(k)) m.set(k, { product: c.product, field: c.field, count: 0, last: c });
      m.get(k).count++;
    }
    return [...m.values()].filter((e) => e.count >= 2);
  },
  csv() {
    const head = ["时间", "产品", "字段", "AI原值", "用户改后值", "修改原因", "原来源URL"];
    const q = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v ?? "").replace(/"/g, '""')}"` : String(v ?? ""));
    return "﻿" + [head.join(","), ...this.all().map((c) => [c.ts, c.product, c.field, c.ai_value, c.new_value, c.reason, c.source_url].map(q).join(","))].join("\n") + "\n";
  },
} : null;

const state = { cfg: null, track: null, products: [], report: null };

/* ── NDJSON 流读取 ─────────────────────────────────────────── */
async function streamNDJSON(url, body, onEvent) {
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`请求失败 ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const drain = () => {
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) { try { onEvent(JSON.parse(line)); } catch {} }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    drain();
  }
  drain();
  if (buf.trim()) { try { onEvent(JSON.parse(buf)); } catch {} }
}

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ── 步骤 1：赛道 ──────────────────────────────────────────── */
function renderTracks() {
  const has = (id) => !DEMO || !!(DEMO.reports && DEMO.reports[id]);
  $("track-grid").innerHTML = state.cfg.tracks.map((t) => {
    const ok = has(t.id);
    return `
    <button class="track-card" type="button" data-id="${esc(t.id)}" aria-pressed="false" ${ok ? "" : "disabled"}>
      <div class="tc-name">${esc(t.name)}</div>
      <div class="tc-seed">${ok ? esc(t.seed.split("/")[0].trim()) : "演示版未包含该赛道"}</div>
    </button>`;
  }).join("");

  $("track-grid").querySelectorAll(".track-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      $("track-grid").querySelectorAll(".track-card").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      state.track = state.cfg.tracks.find((t) => t.id === btn.dataset.id);
      if (DEMO) loadDemoReport(state.track.id); else discover();
    });
  });
}

// 演示模式：直接载入烘焙好的真实报告，不走后端
function loadDemoReport(trackId) {
  const r = DEMO.reports[trackId];
  if (!r) return toast("演示版未包含该赛道");
  state.report = JSON.parse(JSON.stringify(r));
  state.report.recurring = store.recurring();
  state.products = state.report.products.map((p) => ({ name: p.name, vendor: p.vendor || "" }));
  renderReport();
  show("step-report");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── 步骤 2：选品 ──────────────────────────────────────────── */
async function discover() {
  show("step-products");
  $("product-list").innerHTML = `<div class="progress-log" id="disc-log">正在联网检索「${esc(state.track.name)}」的主流产品…</div>`;
  const logEl = () => $("disc-log");

  try {
    await streamNDJSON("/api/discover", { trackId: state.track.id }, (ev) => {
      if (ev.type === "log") logEl().textContent += `\n${ev.msg}`;
      else if (ev.type === "products") { state.products = ev.products; renderProducts(); }
      else if (ev.type === "error") { logEl().textContent += `\n✗ ${ev.msg}`; }
    });
  } catch (e) {
    logEl().textContent += `\n✗ ${e.message}`;
  }
  if (!state.products.length) {
    state.products = [{ name: "", vendor: "", why: "自动检索失败，请手动填写产品名" }];
    renderProducts();
  }
}

function renderProducts() {
  $("product-list").innerHTML = state.products.map((p, i) => `
    <div class="product-row" data-i="${i}">
      <input type="text" class="pr-name-input" value="${esc(p.name)}" placeholder="产品名" aria-label="产品名">
      <input type="text" class="pr-vendor-input" value="${esc(p.vendor || "")}" placeholder="公司" aria-label="公司">
      <span class="pr-why">${esc(p.why || "")}</span>
      <button class="rm" type="button" title="移除" aria-label="移除该产品">×</button>
    </div>`).join("");

  $("product-list").querySelectorAll(".product-row").forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector(".pr-name-input").addEventListener("input", (e) => { state.products[i].name = e.target.value; });
    row.querySelector(".pr-vendor-input").addEventListener("input", (e) => { state.products[i].vendor = e.target.value; });
    row.querySelector(".rm").addEventListener("click", () => {
      state.products.splice(i, 1); renderProducts();
    });
  });
}

function addProduct() {
  if (state.products.length >= 6) return toast("最多 6 个产品");
  state.products.push({ name: "", vendor: "", why: "手动添加" });
  renderProducts();
  const inputs = $("product-list").querySelectorAll(".pr-name-input");
  inputs[inputs.length - 1].focus();
}

/* ── 步骤 3：调研 ──────────────────────────────────────────── */
async function run() {
  const list = state.products.filter((p) => p.name && p.name.trim());
  if (!list.length) return toast("至少需要一个产品名");

  show("step-progress");
  $("progress-log").innerHTML = "";
  const push = (msg, cls) => {
    const el = document.createElement("div");
    if (cls) el.className = cls;
    el.textContent = msg;
    $("progress-log").appendChild(el);
    $("progress-log").scrollTop = $("progress-log").scrollHeight;
  };

  const t0 = Date.now();
  try {
    await streamNDJSON("/api/research", { trackId: state.track.id, products: list }, (ev) => {
      if (ev.type === "log") push(ev.msg, /✗|⛔|⚠/.test(ev.msg) ? "ln-err" : "");
      else if (ev.type === "report") { state.report = ev.report; }
      else if (ev.type === "error") push(`✗ ${ev.msg}`, "ln-err");
    });
  } catch (e) {
    push(`✗ ${e.message}`, "ln-err");
    return toast("调研中断，请查看日志");
  }

  if (!state.report) return toast("未拿到报告数据");
  renderReport();
  push(`完成，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
  setTimeout(() => { show("step-report"); window.scrollTo({ top: 0, behavior: "smooth" }); }, 500);
}

/* ── 步骤 4：报告 ──────────────────────────────────────────── */
function renderReport() {
  const r = state.report;
  const s = r.summary;

  $("report-title").textContent = `${r.track.name} · 赛道速览`;
  $("report-meta").textContent =
    `调研时间 ${new Date(r.generated_at).toLocaleString("zh-CN")} · ${r.products.length} 个产品 × ${state.cfg.fields.length} 个字段 · 用时 ${Math.round(r.elapsed_ms / 1000)} 秒`;

  renderBanner();
  renderStats();
  renderConfidenceChart();
  renderPriceChart();
  renderTable();
  renderGaps();
}

/* 主动服务钩子：把最容易出事的地方顶到最前面 */
function renderBanner() {
  const r = state.report, s = r.summary, b = $("banner");
  const items = [];

  if (s.unknown) items.push(`<div class="bn-item"><strong>${s.unknown} 个字段未找到公开来源</strong> —— 报告里显示为「未获取」，需要你人工确认或留空。见下方缺口清单。</div>`);
  if (s.rejected) items.push(`<div class="bn-item"><strong>${s.rejected} 个字段被来源校验拦截</strong> —— 模型给出了值，但它声称的来源在这次检索中不存在，已判定为编造并降级。</div>`);

  const w = weakCitations();
  if (w.weak) {
    items.push(`<div class="bn-item"><strong>${w.weak} 个引用不够格支撑它所在的字段</strong> —— 这些链接<strong>能点开、也真实存在</strong>，但可能是广告落地页、聚合目录站，或价格取自营销博客。表格里标红为「广告 / 聚合」的格子就是。见下方来源分级说明。</div>`);
  }

  const stale = (r.recurring || []).filter((x) => r.products.some((p) => p.name === x.product));
  for (const x of stale.slice(0, 3)) {
    const f = state.cfg.fields.find((y) => y.key === x.field);
    items.push(`<div class="bn-item"><strong>「${esc(x.product)}」的「${esc(f ? f.label : x.field)}」历史被改过 ${x.count} 次</strong> —— 该字段是高频错误点，请重点核对。</div>`);
  }

  if (!items.length) {
    b.className = "banner ok";
    b.innerHTML = `<div class="bn-title">✓ 本次没有发现缺口或来源冲突</div>
      <div class="bn-item">所有字段都有可点开的来源。但这不代表内容一定正确 —— 仍建议抽查关键数字。</div>`;
    b.hidden = false;
    return;
  }
  b.className = "banner";
  b.innerHTML = `<div class="bn-title">⚠ 拿到报告前，先看这几处不能信的地方</div>${items.join("")}`;
  b.hidden = false;
}

// 统计「来源不够格支撑其字段」的引用数（分级是纯函数，前端直接算）
function weakCitations() {
  let weak = 0, total = 0;
  for (const p of state.report.products) {
    for (const c of Object.values(p.fields || {})) {
      if (!c.value || !c.source_grade) continue;
      total++;
      if (c.source_adequate === false) weak++;
    }
  }
  return { weak, total };
}

function renderStats() {
  const s = state.report.summary;
  const w = weakCitations();
  const tiles = [
    { label: "字段槽位", value: s.total, sub: `${state.report.products.length} 产品 × ${state.cfg.fields.length} 字段`, dot: "" },
    { label: "已核实", value: s.verified, sub: "有页面可点开", dot: "good" },
    { label: "官方声明", value: s.claim, sub: "仅厂商自述", dot: "warning" },
    { label: "未获取", value: s.unknown, sub: "公开渠道查不到", dot: "neutral" },
    { label: "拦截的编造", value: s.rejected, sub: "来源对不上，已降级", dot: s.rejected ? "critical" : "" },
    { label: "来源不够格", value: w.weak, sub: `共 ${w.total} 个有源引用 · 广告页/聚合站等`, dot: w.weak ? "critical" : "good" },
  ];
  $("stat-row").innerHTML = tiles.map((t) => `
    <div class="stat">
      <div class="s-label">${t.dot ? `<span class="dot ${t.dot}"></span>` : ""}${esc(t.label)}</div>
      <div class="s-value">${t.value}</div>
      <div class="s-sub">${esc(t.sub)}</div>
    </div>`).join("");
}

/* 通用：水平条形容器 */
function barLayout(n, rowH = 34) {
  const W = 560, padTop = 6, labelW = 118, rightW = 82;
  return { W, H: padTop * 2 + n * rowH, rowH, padTop, labelW, rightW, barW: W - labelW - rightW };
}

/* 图 1：可信度构成 —— 堆叠条，段间 2px 留缝，外端 4px 圆角，直接标数字 */
function renderConfidenceChart() {
  const r = state.report;
  const keys = state.cfg.fields.map((f) => f.key);
  const rows = r.products.map((p) => {
    const c = { verified: 0, official_claim: 0, unknown: 0 };
    for (const k of keys) { const cell = p.fields[k]; if (cell) c[cell.confidence]++; }
    return { name: p.name, c, total: keys.length };
  });

  const L = barLayout(rows.length);
  const barH = 17;
  const segs = [
    { key: "verified", fill: "var(--good)", label: "已核实" },
    { key: "official_claim", fill: "var(--warning)", label: "官方声明" },
    { key: "unknown", fill: "var(--neutral)", label: "未获取" },
  ];

  let svg = `<svg viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="每个产品的字段可信度构成">`;
  svg += `<defs>`;
  rows.forEach((row, i) => {
    const y = L.padTop + i * L.rowH + (L.rowH - barH) / 2 - 3;
    svg += `<clipPath id="cbar${i}"><rect x="${L.labelW}" y="${y}" width="${L.barW}" height="${barH}" rx="4"/></clipPath>`;
  });
  svg += `</defs>`;

  rows.forEach((row, i) => {
    const y = L.padTop + i * L.rowH + (L.rowH - barH) / 2 - 3;
    svg += `<text x="${L.labelW - 12}" y="${y + barH / 2 + 4}" text-anchor="end" fill="var(--text-primary)">${esc(row.name)}</text>`;

    let x = L.labelW;
    svg += `<g clip-path="url(#cbar${i})">`;
    segs.forEach((sg, si) => {
      const n = row.c[sg.key];
      if (!n) return;
      const w = (n / row.total) * L.barW;
      const isFirst = segs.slice(0, si).every((s2) => !row.c[s2.key]);
      const isLast = segs.slice(si + 1).every((s2) => !row.c[s2.key]);
      const gl = isFirst ? 0 : 1, gr = isLast ? 0 : 1;
      svg += `<rect x="${x + gl}" y="${y}" width="${Math.max(w - gl - gr, 0.6)}" height="${barH}" fill="${sg.fill}">
                <title>${esc(row.name)} · ${esc(sg.label || sg.key)}：${n} 个字段</title></rect>`;
      x += w;
    });
    svg += `</g>`;

    // 直接标签。数字必须自带色点 —— 否则「8 · 2」读者无从判断哪个数对应哪种颜色，
    // 而这两种颜色的对比度都低于 3:1，颜色本身承担不了信息。
    let lx = L.labelW + L.barW + 14;
    const cy = y + barH / 2;
    for (const sg of segs) {
      const n = row.c[sg.key];
      if (!n) continue;
      svg += `<circle cx="${lx + 3.5}" cy="${cy}" r="3.5" fill="${sg.fill}"><title>${esc(sg.label)}</title></circle>`;
      svg += `<text x="${lx + 11}" y="${cy + 4}" fill="var(--text-secondary)">${n}</text>`;
      lx += 21;
    }
  });
  svg += `</svg>`;
  $("chart-confidence").innerHTML = svg;
  const tEl = $("chart1-total"); if (tEl) tEl.textContent = rows.length * keys.length;

  $("legend-confidence").innerHTML = [
    { f: "var(--good)", n: "已核实", d: "有页面可点开" },
    { f: "var(--warning)", n: "官方声明", d: "仅厂商自述" },
    { f: "var(--neutral)", n: "未获取", d: "公开渠道查不到" },
  ].map((x) => `<span class="lg"><span class="dot" style="background:${x.f}"></span>${x.n}<span style="color:var(--muted)">· ${x.d}</span></span>`).join("");
}

/* 图 2：起步月费 —— 单系列，无需图例（标题已命名） */
function renderPriceChart() {
  const r = state.report;
  const rows = r.products.map((p) => {
    const cell = p.fields.price_usd_month;
    // 只用代码层已确认过的纯数值（cell.numeric），不在前端二次解析字符串 —— 避免把带单位/多数字的串读成一个错数
    const n = cell && Number.isFinite(cell.numeric) ? cell.numeric
            : (cell && /^\d+(\.\d+)?$/.test(String(cell.value || "")) ? Number(cell.value) : NaN);
    return { name: p.name, v: n > 0 ? n : null, cell };
  });
  const withVal = rows.filter((x) => x.v !== null);

  if (withVal.length < 2) {
    $("chart-price").innerHTML = `<p style="color:var(--muted);font-size:13px;padding:22px 0">可明确折算成美元月费的产品不足 2 个，无法做价格对比。<br>这是诚实的结果，不做估算补齐。</p>`;
    $("price-note").hidden = true;
    return;
  }

  const L = barLayout(rows.length);
  const max = Math.max(...withVal.map((x) => x.v));
  const barH = 17;

  let svg = `<svg viewBox="0 0 ${L.W} ${L.H}" role="img" aria-label="各产品起步月费对比">`;
  // 基线
  svg += `<line x1="${L.labelW}" y1="${L.padTop}" x2="${L.labelW}" y2="${L.H - L.padTop}" stroke="var(--baseline)" stroke-width="1"/>`;

  rows.forEach((row, i) => {
    const y = L.padTop + i * L.rowH + (L.rowH - barH) / 2 - 3;
    svg += `<text x="${L.labelW - 12}" y="${y + barH / 2 + 4}" text-anchor="end" fill="var(--text-primary)">${esc(row.name)}</text>`;
    if (row.v === null) {
      svg += `<text x="${L.labelW + 10}" y="${y + barH / 2 + 4}" fill="var(--muted)" font-style="italic">未获取，不做估算</text>`;
      return;
    }
    const w = Math.max((row.v / max) * (L.barW - 46), 3);
    svg += `<rect x="${L.labelW + 2}" y="${y}" width="${w}" height="${barH}" rx="4" fill="var(--series-1)">
              <title>${esc(row.name)}：$${row.v}/月</title></rect>`;
    svg += `<text x="${L.labelW + 2 + w + 9}" y="${y + barH / 2 + 4}" fill="var(--text-secondary)">$${row.v}</text>`;
  });
  svg += `</svg>`;
  $("chart-price").innerHTML = svg;

  const skipped = rows.length - withVal.length;
  const note = $("price-note");
  note.hidden = false;
  note.textContent = skipped
    ? `有 ${skipped} 个产品未计入：官网定价无法在不做假设的前提下折算成美元月费。`
    : "";
}

/* 对比表 */
function renderTable() {
  const r = state.report;
  const fields = state.cfg.fields;
  const conf = state.cfg.confidence;

  let html = `<thead><tr><th>字段</th>`;
  for (const p of r.products) {
    html += `<th>${esc(p.name)}${p.vendor ? `<span class="th-vendor">${esc(p.vendor)}</span>` : ""}</th>`;
  }
  html += `</tr></thead><tbody>`;

  for (const f of fields) {
    html += `<tr><th scope="row">${esc(f.label)}</th>`;
    for (const p of r.products) {
      const c = p.fields[f.key] || { value: null, confidence: "unknown" };
      const badge = conf[c.confidence] || conf.unknown;
      const rejected = c.rejected;

      let inner = c.value
        ? `<span class="cell-val">${esc(c.value)}</span>`
        : `<span class="cell-val empty">未获取</span>`;

      let foot = `<div class="cell-foot"><span class="badge"><span class="dot ${c.confidence === "verified" ? "good" : c.confidence === "official_claim" ? "warning" : "neutral"}"></span>${esc(badge.label)}</span>`;

      if (c.source_url) {
        let host = c.source_url;
        try { host = new URL(c.source_url).hostname.replace(/^www\./, ""); } catch {}
        foot += `<a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer" title="${esc(c.source_url)}">↗ ${esc(host)}</a>`;

        // 来源等级：URL 能点开 ≠ 够格支撑这条事实。
        // 不够格的引用直接标红，不用等读者自己去判断域名。
        const g = c.source_grade && (state.cfg.grades || {})[c.source_grade.id];
        if (g) {
          const weak = c.source_adequate === false;
          foot += `<span class="grade${weak ? " weak" : ""}" title="${esc(g.desc)}${weak ? " —— 这个来源不足以支撑本字段" : ""}">${esc(g.short)}</span>`;
        }
      }
      foot += `</div>`;

      html += `<td class="editable${rejected ? " flag-rejected" : ""}"
                   data-product="${esc(p.name)}" data-field="${esc(f.key)}"
                   data-value="${esc(c.value || "")}" data-url="${esc(c.source_url || "")}">
                 ${inner}${foot}
                 ${rejected ? `<span class="rejected-note">⛔ 来源校验不通过，已拦截。模型声称来自 ${esc(rejected.claimed_url)}（本次检索未出现），原值：${esc(rejected.value)}</span>` : ""}
               </td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody>`;
  $("compare-table").innerHTML = html;

  $("compare-table").querySelectorAll("td.editable").forEach((td) => {
    td.addEventListener("click", (e) => {
      if (e.target.tagName === "A") return;
      openEditor(td);
    });
  });
}

/* 缺口清单 */
function renderGaps() {
  const r = state.report;
  const fields = state.cfg.fields;
  const rows = [];

  for (const f of fields) {
    const missing = r.products.filter((p) => !(p.fields[f.key] || {}).value);
    if (!missing.length) continue;
    rows.push(`
      <div class="gap-row">
        <span class="g-field">${esc(f.label)}</span>
        <span class="g-missing">${missing.map((p) => esc(p.name)).join(" · ")} <em>未获取</em></span>
        <span class="chip">${missing.length}/${r.products.length} 个产品缺失</span>
      </div>`);
  }

  $("gap-list").innerHTML = rows.length
    ? rows.join("")
    : `<div class="gap-row"><span class="g-missing">本次全部字段都找到了来源。<em>仍建议抽查关键数字。</em></span></div>`;
}

/* ── 校正编辑器（自进化钩子入口）───────────────────────────── */
const REASONS = ["定价错误", "功能描述错误", "不适用该产品", "信息已过时", "来源不可信"];

function openEditor(td) {
  document.querySelector(".editor")?.remove();

  const product = td.dataset.product, fieldKey = td.dataset.field;
  const f = state.cfg.fields.find((x) => x.key === fieldKey);
  const ed = document.createElement("div");
  ed.className = "editor";
  ed.innerHTML = `
    <h4>${esc(product)} · ${esc(f ? f.label : fieldKey)}</h4>
    <div class="ed-sub">AI 原值：${td.dataset.value ? esc(td.dataset.value) : "（未获取）"}</div>
    <label for="ed-val">改成什么（留空 = 确认为「未获取」）</label>
    <input type="text" id="ed-val" value="${esc(td.dataset.value)}">
    <label>修改原因</label>
    <div class="ed-reasons">${REASONS.map((x) => `<button type="button" class="reason" aria-pressed="false">${x}</button>`).join("")}</div>
    <div class="ed-actions">
      <button type="button" class="btn ghost" data-act="cancel">取消</button>
      <button type="button" class="btn primary" data-act="save">保存并记录</button>
    </div>`;

  document.body.appendChild(ed);
  const rect = td.getBoundingClientRect();
  const top = rect.bottom + 8 + 250 > window.innerHeight ? Math.max(8, rect.top - 258) : rect.bottom + 8;
  ed.style.top = `${Math.max(8, top)}px`;
  ed.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 346)}px`;

  let reason = "";
  ed.querySelectorAll(".reason").forEach((b) => b.addEventListener("click", () => {
    ed.querySelectorAll(".reason").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    reason = b.textContent;
  }));
  ed.querySelector("#ed-val").focus();

  const close = () => ed.remove();
  ed.addEventListener("click", (e) => e.stopPropagation());
  setTimeout(() => document.addEventListener("click", close, { once: true }), 0);

  ed.querySelector('[data-act="cancel"]').addEventListener("click", close);
  ed.querySelector('[data-act="save"]').addEventListener("click", async () => {
    if (!reason) return toast("请选一个修改原因");
    const newVal = ed.querySelector("#ed-val").value.trim();
    const rec = {
      product, field: fieldKey,
      ai_value: td.dataset.value, new_value: newVal, reason,
      source_url: td.dataset.url,
    };

    let total, recurring;
    try {
      if (DEMO) {
        total = store.add(rec);
        recurring = store.recurring();
      } else {
        const res = await fetch("/api/correct", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec),
        });
        const data = await res.json();
        total = data.corrections; recurring = data.recurring;
      }
    } catch (e) { return toast(`记录失败：${e.message}`); }

    close();
    toast(`已记录：${product} · ${f ? f.label : fieldKey}（累计 ${total} 条校正）`);

    // 本地立即反映，不必重跑调研
    const cell = state.report.products.find((p) => p.name === product)?.fields[fieldKey];
    if (cell) {
      cell.value = newVal || null;
      if (newVal && !cell.source_url) cell.confidence = "official_claim";
      renderTable();
    }

    // 自进化钩子：同产品同字段改满 2 次 → 当场升级为高频错误点，横幅立即更新
    if (recurring?.some((x) => x.product === product && x.field === fieldKey)) {
      state.report.recurring = recurring;
      renderBanner();
      toast(`「${product} · ${f ? f.label : fieldKey}」已升级为高频错误点 —— 见顶部横幅`, 4600);
    }
  });
}

/* ── 流程控制 ──────────────────────────────────────────────── */
function show(id) {
  ["step-track", "step-products", "step-progress", "step-report"].forEach((s) => { $(s).hidden = s !== id; });
}

function restart() {
  state.track = null; state.products = []; state.report = null;
  $("track-grid").querySelectorAll(".track-card").forEach((b) => b.setAttribute("aria-pressed", "false"));
  show("step-track");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── 主题 ─────────────────────────────────────────────────── */
function initTheme() {
  const saved = localStorage.getItem("radar-theme");
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  $("theme-toggle").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const isDark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("radar-theme", next);
    if (state.report) { renderConfidenceChart(); renderPriceChart(); }
  });
}

/* ── 启动 ─────────────────────────────────────────────────── */
(async function init() {
  initTheme();
  $("btn-run").addEventListener("click", run);
  $("btn-add-product").addEventListener("click", addProduct);
  $("btn-restart").addEventListener("click", restart);

  // ── 配置来源：演示版从内联数据取，联网版从后端取 ──
  if (DEMO) {
    state.cfg = DEMO.config;
    document.body.classList.add("is-demo");
    const n = Object.keys(DEMO.reports || {}).length;
    $("foot-endpoint").textContent =
      `演示版 · 内含 ${n} 份真实调研报告 · ${state.cfg.fields.length} 个字段 · 无后端、无密钥、离线可用`;
    // 校正记录导出改成浏览器内生成，不依赖服务器
    const a = $("corrections-link");
    if (a) {
      a.removeAttribute("href");
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const blob = new Blob([store.csv()], { type: "text/csv;charset=utf-8" });
        const u = URL.createObjectURL(blob);
        const t = document.createElement("a");
        t.href = u; t.download = "corrections.csv"; t.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      });
    }
    if (DEMO.note) {
      const d = document.createElement("div");
      d.className = "demo-note";
      d.innerHTML = DEMO.note;
      document.querySelector(".app").prepend(d);
    }
  } else {
    try {
      state.cfg = await (await fetch("/api/config")).json();
      $("foot-endpoint").textContent = `${state.cfg.fields.length} 个字段 · ${state.cfg.tracks.length} 条赛道 · 数据源：公开网页`;
    } catch (e) {
      toast("无法连接后端，请确认 server.mjs 已启动");
      return;
    }
  }

  renderTracks();

  // 演示版：打开即载入第一份报告，不让访客面对一个空页面。
  // 想看别的赛道点右上角「↺ 换一条赛道」。
  if (DEMO) {
    const first = state.cfg.tracks.find((t) => DEMO.reports[t.id]);
    if (first) {
      state.track = first;
      const card = $("track-grid").querySelector(`.track-card[data-id="${first.id}"]`);
      if (card) card.setAttribute("aria-pressed", "true");
      loadDemoReport(first.id);
      return;
    }
  }

  // 联网版：?report=last 回到上一次调研结果（刷新不丢）
  if (!DEMO && new URLSearchParams(location.search).get("report") === "last") {
    try {
      const r = await (await fetch("/api/last-report")).json();
      if (r.report) {
        state.report = r.report;
        state.track = state.cfg.tracks.find((t) => t.id === r.report.track.id) || null;
        renderReport();
        show("step-report");
        return;
      }
    } catch {}
    toast("还没有可查看的报告，请先跑一次调研");
  }
})();
