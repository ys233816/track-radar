import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const CSV = path.join(DATA_DIR, "corrections.csv");

const HEADER = ["时间", "产品", "字段", "AI原值", "用户改后值", "修改原因", "原来源URL"];

function esc(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, "﻿" + HEADER.join(",") + "\n", "utf8");
}

export function appendCorrection(rec) {
  ensureStore();
  const row = [
    new Date().toISOString(),
    rec.product, rec.field, rec.ai_value, rec.new_value, rec.reason, rec.source_url,
  ].map(esc).join(",");
  fs.appendFileSync(CSV, row + "\n", "utf8");
}

export function loadCorrections() {
  ensureStore();
  const txt = fs.readFileSync(CSV, "utf8").replace(/^﻿/, "");
  const lines = txt.split("\n").filter((l) => l.trim());
  const out = [];
  for (const line of lines.slice(1)) {
    // 最小 CSV 解析：处理引号包裹与转义引号
    const cells = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    if (cells.length >= 6) {
      out.push({
        ts: cells[0], product: cells[1], field: cells[2],
        ai_value: cells[3], new_value: cells[4], reason: cells[5], source_url: cells[6] || "",
      });
    }
  }
  return out;
}

// 同一产品同一字段被改过 >=2 次 → 升级为「高频错误模式」，下次调研时提示。
export function recurringIssues() {
  const map = new Map();
  for (const c of loadCorrections()) {
    const k = `${c.product}||${c.field}`;
    if (!map.has(k)) map.set(k, { product: c.product, field: c.field, count: 0, last: c });
    const e = map.get(k);
    e.count++;
    e.last = c;
  }
  return [...map.values()].filter((e) => e.count >= 2);
}

export { CSV };
