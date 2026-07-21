// rule-engine.js — Module ADJUST A3: đánh giá rule → sinh proposed_changes (dry-run).
//
// - Input: rules (Rule Set v1), records (từ bulk-etl), context (target ACoS, rank ToS, ...).
// - Output: proposals[] {k, entity, entity_id, entity_name, field, old_value, new_value, rule_id, rule_name, reason}.
// - Rule khớp ĐẦU TIÊN (priority thấp = ưu tiên) thắng cho mỗi (record, field).
// - Dry-run: KHÔNG sửa gì, chỉ đề xuất → user duyệt → mới export file Update.

import { rowKey, r2 } from "./bulk-etl.js";

/** ASIN của record: dòng Keyword/PT KHÔNG có ASIN Info (chỉ Product Ad có) → parse từ tên campaign. */
export function asinOfRecord(rec) {
  const a = String(rec.asin || "").toUpperCase();
  if (/^B0[A-Z0-9]{8}$/.test(a)) return a;
  const m = String(rec.name || "").toUpperCase().match(/B0[A-Z0-9]{8}/);
  return m ? m[0] : "";
}

/** Suy objective từ tên campaign (fuzzy — UI cho phép chọn nhóm rule chạy). */
export function inferObjective(name = "") {
  const s = String(name);
  if (/\brank\b/i.test(s)) return "RANK";
  if (/\bharvest\b/i.test(s) || /\bauto\b/i.test(s) || /\bbroad\b/i.test(s)) return "HARVEST";
  return "PROFIT";
}

const SCOPE = {
  target: (e) => e === "Keyword" || e === "Product Targeting",
  campaign: (e) => e === "Campaign",
  placement: (e) => e === "Bidding Adjustment",
  adgroup: (e) => e === "Ad Group",
  productad: (e) => e === "Product Ad"
};

/** Lấy giá trị metric từ record (acos null = ∞: spend>0, sales=0). */
function metricVal(rec, metric, ctx) {
  switch (metric) {
    case "acos": return rec.acos === null ? Infinity : rec.acos;
    case "ctr": return rec.ctr;
    case "cr": return rec.cr;
    case "spend": return rec.sp;
    case "sales": return rec.sa;
    case "clicks": return rec.clk;
    case "orders": return rec.or;
    case "impressions": return rec.imp;
    case "bid": return rec.bid;
    case "budget": return rec.bud;
    case "state": return rec.st;
    case "tosPos": return ctx.tosPos != null ? ctx.tosPos : null; // chỉ có trong rank pass
    default: return null;
  }
}

/** Giải giá trị so sánh: literal, hoặc {ref:'target_acos', mul} (target % → tỷ lệ). */
function resolveValue(value, rec, ctx) {
  if (value && typeof value === "object" && value.ref === "target_acos") {
    const t = ctx.targetAcosByAsin ? ctx.targetAcosByAsin[asinOfRecord(rec)] : null;
    if (t == null) return null; // thiếu target → điều kiện không đánh giá được
    return (Number(t) / 100) * (value.mul || 1);
  }
  return value;
}

function cmp(a, op, b) {
  if (b === null || b === undefined) return false;
  switch (op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "==": return a === b || String(a) === String(b);
    case "!=": return !(a === b || String(a) === String(b));
    default: return false;
  }
}

function passMinData(rec, md = {}) {
  if (md.clicks != null && (rec.clk || 0) < md.clicks) return false;
  if (md.orders != null && (rec.or || 0) < md.orders) return false;
  return true;
}

function passConditions(rec, conds = [], ctx) {
  for (const c of conds) {
    const v = metricVal(rec, c.metric, ctx);
    if (v === null || v === undefined) return false;
    const target = resolveValue(c.value, rec, ctx);
    if (!cmp(v, c.op, target)) return false;
  }
  return true;
}

/** Tính giá trị mới + clamp guardrails. Trả {old, val} hoặc null (không áp dụng được). */
function applyAction(rec, action) {
  const g = action.guardrails || {};
  const f = action.field;
  if (f === "st") return { old: rec.st, val: action.value };

  const curMap = { bid: rec.bid, bud: rec.bud, pct: rec.pct, agbid: rec.agbid };
  let cur = curMap[f];
  if (cur === null || cur === undefined) return null;

  let val;
  if (action.change_type === "set") val = action.value;
  else if (action.change_type === "pct") val = cur * (1 + action.value / 100);
  else if (action.change_type === "add") val = cur + action.value;
  else return null;
  if (val === null || val === undefined || isNaN(val)) return null;

  // clamp
  if (g.max_change_pct != null) {
    const d = Math.abs(cur) * (g.max_change_pct / 100);
    val = Math.max(cur - d, Math.min(cur + d, val));
  }
  if (f === "bid") {
    if (g.min_bid != null) val = Math.max(val, g.min_bid);
    if (g.max_bid != null) val = Math.min(val, g.max_bid);
  }
  if (f === "pct" && g.max_pct != null) val = Math.min(val, g.max_pct);
  if (val < 0) val = 0;
  return { old: cur, val: r2(val) };
}

function labelOf(rec) {
  return rec.e === "Campaign" ? rec.name
    : rec.e === "Bidding Adjustment" ? `${rec.name} · ${rec.pl}`
      : (rec.kw || rec.ex || rec.agname || rec.sku || rec.name || "");
}

function mkProposal(rec, field, old, val, rule, reason) {
  return {
    k: rowKey(rec), entity: rec.e,
    entity_id: rec.kid || rec.tid || rec.adid || rec.cid,
    entity_name: labelOf(rec),
    campaign: rec.name, asin: asinOfRecord(rec),
    field, old_value: old, new_value: val,
    rule_id: rule.id, rule_name: rule.name,
    reason: reason || `${rule.name.split(" · ")[0]}: ${rule.description} · ${field} ${old}→${val}`
  };
}

/**
 * @param {Array} rules  - rule objects (đã gồm cả disabled — engine tự lọc enabled)
 * @param {Array} records - record từ bulk-etl (dataset.records)
 * @param {object} context - { targetAcosByAsin:{asin:%}, rankByAsinKw:{`ASIN|kw`:{tosPos}} }
 * @returns {Array} proposals
 */
export function evaluate(rules, records, context = {}) {
  const ctx = { targetAcosByAsin: context.targetAcosByAsin || {}, rankByAsinKw: context.rankByAsinKw || {} };
  const active = (rules || []).filter((r) => r.enabled).sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  const proposals = [];
  const claimed = new Set(); // `${k}|${field}` — first-match-wins

  for (const rule of active) {
    // R1 & các rule placement dựa rank → xử lý ở pass riêng
    if (rule.entity_scope === "placement" && rule.condition && rule.condition.placementOnly) continue;
    const inScope = SCOPE[rule.entity_scope];
    if (!inScope) continue;
    for (const rec of records) {
      if (!inScope(rec.e)) continue;
      if (!passMinData(rec, rule.condition?.min_data)) continue;
      if (!passConditions(rec, rule.condition?.all, ctx)) continue;
      const field = rule.action.field;
      const ck = rowKey(rec) + "|" + field;
      if (claimed.has(ck)) continue;
      const applied = applyAction(rec, rule.action);
      if (!applied || String(applied.val) === String(applied.old)) continue;
      claimed.add(ck);
      proposals.push(mkProposal(rec, field, applied.old, applied.val, rule));
    }
  }

  // ===== Pass RANK (R1): keyword chưa vào ToS → đẩy placementTop của campaign =====
  runRankPass(active, records, ctx, proposals, claimed);
  return proposals;
}

function runRankPass(active, records, ctx, proposals, claimed) {
  const rankRules = active.filter((r) => r.entity_scope === "placement" && r.condition && r.condition.placementOnly);
  if (!rankRules.length) return;

  // cid → asin (parse từ tên campaign vì Keyword/PT không có ASIN Info)
  const cidAsin = {};
  for (const rec of records) {
    if (!rec.cid || cidAsin[rec.cid]) continue;
    const a = asinOfRecord(rec);
    if (a) cidAsin[rec.cid] = a;
  }
  // campaign nào có keyword tracked mà tosPos===0
  const needBump = new Set();
  const trigger = {};
  for (const rec of records) {
    if (rec.e !== "Keyword") continue;
    const asin = cidAsin[rec.cid];
    if (!asin) continue;
    const rk = ctx.rankByAsinKw[`${asin}|${String(rec.kw || "").toLowerCase()}`];
    if (rk && rk.tosPos === 0) { needBump.add(rec.cid); if (!trigger[rec.cid]) trigger[rec.cid] = rec.kw; }
  }
  if (!needBump.size) return;

  for (const rule of rankRules) {
    for (const rec of records) {
      if (rec.e !== "Bidding Adjustment") continue;
      if (!/top/i.test(rec.pl || "")) continue;      // chỉ placement Top
      if (!needBump.has(rec.cid)) continue;
      const ck = rowKey(rec) + "|pct";
      if (claimed.has(ck)) continue;
      const applied = applyAction(rec, rule.action);
      if (!applied || String(applied.val) === String(applied.old)) continue;
      claimed.add(ck);
      proposals.push(mkProposal(rec, "pct", applied.old, applied.val, rule,
        `R1: keyword "${trigger[rec.cid]}" chưa vào ToS → placementTop ${applied.old}→${applied.val}%`));
    }
  }
}
