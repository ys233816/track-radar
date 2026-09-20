import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRACKS, FIELDS, CONFIDENCE, summarize, FIELD_KEYS } from "./lib/schema.mjs";
import { GRADES } from "./lib/source-grade.mjs";
import { discoverProducts, runResearch } from "./lib/research.mjs";
import { appendCorrection, loadCorrections, recurringIssues, ensureStore, CSV } from "./lib/store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const PORT = Number(process.env.PORT) || 5178;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

// 最近一次报告缓存在内存里：刷新页面不丢结果，也方便直接打开 ?report=last
let lastReport = null;

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1e6) req.destroy();
    });
    req.on("end", () => {
      // 必须先把 Buffer 拼齐再整体按 UTF-8 解码。
      // 逐块 toString() 会把跨块切断的多字节汉字解成乱码 —— 中文用户改一个格子就可能踩到。
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// NDJSON 流：每行一个事件。比 SSE 更省事，且能配 POST。
function openStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  return (obj) => { try { res.write(JSON.stringify(obj) + "\n"); } catch {} };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ── 静态资源 ──────────────────────────────────────────────
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const f = path.join(PUBLIC, "index.html");
      res.writeHead(200, { "Content-Type": MIME[".html"] });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === "GET" && (p === "/app.js" || p === "/styles.css")) {
      const f = path.join(PUBLIC, p.slice(1));
      if (fs.existsSync(f)) {
        res.writeHead(200, { "Content-Type": MIME[path.extname(f)] });
        return res.end(fs.readFileSync(f));
      }
      return json(res, 404, { error: "not found" });
    }

    // ── 配置 ─────────────────────────────────────────────────
    if (req.method === "GET" && p === "/api/config") {
      return json(res, 200, { tracks: TRACKS, fields: FIELDS, confidence: CONFIDENCE, grades: GRADES });
    }

    // ── 上次报告 ─────────────────────────────────────────────
    if (req.method === "GET" && p === "/api/last-report") {
      return json(res, 200, lastReport ? { report: lastReport } : { report: null });
    }

    // ── 已沉淀的校正记录 ──────────────────────────────────────
    if (req.method === "GET" && p === "/api/corrections") {
      return json(res, 200, {
        corrections: loadCorrections(),
        recurring: recurringIssues(),
      });
    }

    // ── 选品 ─────────────────────────────────────────────────
    if (req.method === "POST" && p === "/api/discover") {
      const body = await readBody(req);
      const track = TRACKS.find((t) => t.id === body.trackId);
      if (!track) return json(res, 400, { error: "未知赛道" });

      const send = openStream(res);
      const log = (msg) => send({ type: "log", msg });
      try {
        const products = await discoverProducts(track, log);
        send({ type: "products", products });
      } catch (e) {
        send({ type: "error", msg: String(e.message).slice(0, 300) });
      }
      return res.end();
    }

    // ── 调研 ─────────────────────────────────────────────────
    if (req.method === "POST" && p === "/api/research") {
      const body = await readBody(req);
      const track = TRACKS.find((t) => t.id === body.trackId);
      const products = Array.isArray(body.products) ? body.products.filter((x) => x && x.name).slice(0, 6) : [];
      if (!track || !products.length) return json(res, 400, { error: "缺少赛道或产品名单" });

      const send = openStream(res);
      const log = (msg) => send({ type: "log", msg });
      const t0 = Date.now();
      try {
        log(`开始调研「${track.name}」的 ${products.length} 个产品…`);
        const results = await runResearch(products, track, log);
        const summary = summarize(results);
        const payload = {
          type: "report",
          track: { id: track.id, name: track.name },
          products: results,
          summary,
          recurring: recurringIssues(),
          generated_at: new Date().toISOString(),
          elapsed_ms: Date.now() - t0,
        };
        lastReport = payload;
        send(payload);
        log(`全部完成，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
      } catch (e) {
        send({ type: "error", msg: String(e.message).slice(0, 300) });
      }
      return res.end();
    }

    // ── 记录一条校正（自进化钩子）───────────────────────────────
    if (req.method === "POST" && p === "/api/correct") {
      const b = await readBody(req);
      if (!b.product || !b.field) return json(res, 400, { error: "缺少产品或字段" });
      appendCorrection({
        product: b.product, field: b.field,
        ai_value: b.ai_value ?? "", new_value: b.new_value ?? "",
        reason: b.reason ?? "", source_url: b.source_url ?? "",
      });
      return json(res, 200, { ok: true, corrections: loadCorrections().length, recurring: recurringIssues() });
    }

    // ── 下载校正记录 ──────────────────────────────────────────
    if (req.method === "GET" && p === "/corrections.csv") {
      ensureStore();
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="corrections.csv"' });
      return res.end(fs.readFileSync(CSV));
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message).slice(0, 300) });
  }
});

ensureStore();
server.listen(PORT, () => {
  console.log(`\n  赛道雷达  →  http://localhost:${PORT}\n`);
  console.log(`  模型端点: ${process.env.ANTHROPIC_BASE_URL || "Anthropic 官方"}`);
  console.log(`  字段数: ${FIELD_KEYS.length} | 赛道数: ${TRACKS.length}\n`);
});
