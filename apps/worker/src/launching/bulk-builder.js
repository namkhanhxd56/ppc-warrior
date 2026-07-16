// bulk-builder.js — Module LAUNCHING: dựng bulk file Amazon Ads (SP Keyword / Product Targeting / Auto)
//
// Nguồn cấu trúc: SP Keyword Bid.xlsx (khối 7 dòng/campaign) + SP Auto.xlsx (khối 10 dòng,
// ma trận bật/tắt 4 nhóm targeting) — file kiến thức mục 2. KHÔNG hard-code giá trị.
//
// Kiến trúc 2 PHA (16/07/2026 — yêu cầu preview chỉnh được từng campaign):
//   planCampaigns(input)  → danh sách campaign plan [{name, type, bid, budget, portfolio, note...}]
//   buildRowsFromPlans()  → dựng dòng bulk từ plans (đã qua tay user chỉnh sửa ở preview)

/* ===== Header bulk chuẩn 27 cột (khớp SP Auto.xlsx) ===== */
export const BULK_HEADER = [
  "Product", "Entity", "Operation", "Campaign Id", "Ad Group Id", "Portfolio Id",
  "Ad Id (Read only)", "Keyword Id (Read only)", "Product Targeting Id (Read only)",
  "Campaign Name", "Ad Group Name", "Start Date", "End Date", "Targeting Type", "State",
  "Daily Budget", "SKU", "Ad Group Default Bid", "Bid", "Keyword Text",
  "Native Language Keyword", "Native Language Locale", "Match Type", "Bidding Strategy",
  "Placement", "Percentage", "Product Targeting Expression"
];

/* Ma trận bật/tắt 4 nhóm Product Targeting theo ad_type (thứ tự: loose, substitutes, close, complements) */
export const AD_TYPE_MATRIX = {
  "substitutes": ["paused", "enabled", "paused", "paused"],
  "loose-match": ["enabled", "paused", "paused", "paused"],
  "close-match": ["paused", "paused", "enabled", "paused"],
  "complements": ["paused", "paused", "paused", "enabled"],
  "loose+close": ["enabled", "paused", "enabled", "paused"],
  "3type":       ["enabled", "enabled", "enabled", "paused"],
  "all":         ["enabled", "enabled", "enabled", "enabled"]
};
const AUTO_EXPRESSIONS = ["loose-match", "substitutes", "close-match", "complements"];

export const DEFAULTS = {
  dailyBudget: 3.0, autoDailyBudget: 4.0,
  biddingStrategy: "Dynamic bids - down only",
  placementTop: 0, placementProductPage: 0, placementRestOfSearch: 0,
  adGroupDefaultBid: 0.25, autoAdGroupDefaultBid: 0.15,
  // Bid rule — theo yêu cầu 16/07: chọn loại bid H10 (sugg/min/max, mặc định MAX)
  h10Type: "max", defaultBid: 0.67, bidMultiplier: 1.25, maxBidCap: 0.97,
  fixedBid: 1.01, minBid: 0.15,
  ladder: { exact: { step: 0.02, levels: 5 }, phrase: { step: 0.03, levels: 2 },
            broad: { step: 0.03, levels: 3 }, pt: { step: 0.02, levels: 3 } },
  // Phrase/Broad: mode "ratio" (% bid gốc) hoặc "value" (set cứng)
  phrase: { mode: "ratio", ratio: 0.8, value: 0.76 },
  broad:  { mode: "ratio", ratio: 0.6, value: 0.56 },
  wordCountLimit: 3, pbOffsetDays: 3,
  nameKw:   "FBA - {ASIN} - SP - {Keyword} - {MatchType} {Bid} - {StartDate} - {Name} - {Note}",
  namePt:   "FBA - {ASIN} - SP - PRODUCT TG - {TargetAsin} - {Bid} - {StartDate} - {Name} - {Note}",
  nameAuto: "FBA - {ASIN} - SP - {Category} Auto - {AdType} {Bid} - {StartDate} - {Name} - {Note}"
};

/* ===== Helpers ===== */
const r2 = (n) => Math.round(n * 100) / 100;

export function parseBid(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(",", ".").replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : r2(n);
}

export function ladderBids(base, step, levels, min = 0.02) {
  const out = [];
  for (let i = 0; i < Math.max(1, levels); i++) {
    const b = r2(base - step * i);
    if (b < min) break;
    if (!out.includes(b)) out.push(b);
  }
  return out.length ? out : [r2(Math.max(base, min))];
}

export function renderName(template, ctx) {
  let s = String(template || "");
  for (const [k, v] of Object.entries(ctx)) {
    s = s.split(`{${k}}`).join(v === null || v === undefined ? "" : String(v));
  }
  return s.replace(/\s*-\s*(?=-)/g, "").replace(/\s*-\s*$/, "").replace(/\s{2,}/g, " ").trim();
}

export function toBulkDate(d) {
  const dt = d instanceof Date ? d : new Date(String(d));
  if (isNaN(dt)) throw new Error(`Ngày không hợp lệ: ${d}`);
  return `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`;
}
export function addDays(d, days) {
  const dt = new Date(String(d));
  dt.setDate(dt.getDate() + Number(days || 0));
  return dt;
}

/* ============================================================
   PHA 1 — planCampaigns: input UI → danh sách campaign plan
   ============================================================ */
/**
 * input.info:       {sku, asin, category (tên phân loại), startDate, manager (≤5)}
 * input.portfolios: {global, exact, phrase, broad, pt, auto} — mục trống dùng global
 * input.bidRule:    {mode: suggest|fixed, h10Type: sugg|min|max, bidMultiplier, maxBidCap,
 *                    defaultBid, fixedBid, minBid}
 * input.matches:    {exact:{on,step,levels,note}, phrase:{on,mode,ratio,value,step,levels,note},
 *                    broad:{...}, wordCountLimit, pbOffsetDays}
 * input.pt:         {on, bid, step, levels, note}
 * input.auto:       {on, adTypes[], bids[], note}
 * input.keywords:   [{text, bid|null, bids:{sugg,min,max}|null}]
 * input.targetAsins:[string]
 * input.naming:     {kw, pt, auto}
 * input.camp:       {dailyBudget, autoDailyBudget, ...}
 */
export function planCampaigns(input) {
  const d = DEFAULTS;
  const info = input.info || {};
  if (!info.sku) throw new Error("Thiếu SKU");
  if (!/^[A-Z0-9]{10}$/i.test(info.asin || "")) throw new Error("ASIN không hợp lệ");
  if (!info.startDate) throw new Error("Thiếu ngày tạo");
  if (info.manager && String(info.manager).length > 5) throw new Error("Mã cá nhân tối đa 5 ký tự");

  const camp = { dailyBudget: d.dailyBudget, autoDailyBudget: d.autoDailyBudget,
    biddingStrategy: d.biddingStrategy, placementTop: d.placementTop,
    placementProductPage: d.placementProductPage, placementRestOfSearch: d.placementRestOfSearch,
    ...(input.camp || {}) };
  // Mỗi plan mang theo strategy/placement riêng (chỉnh được từng campaign ở preview)
  const campLevel = {
    biddingStrategy: camp.biddingStrategy,
    placementTop: Number(camp.placementTop) || 0,
    placementProductPage: Number(camp.placementProductPage) || 0,
    placementRestOfSearch: Number(camp.placementRestOfSearch) || 0
  };
  const naming = { kw: d.nameKw, pt: d.namePt, auto: d.nameAuto, ...(input.naming || {}) };
  const portfolios = { global: "", ...(input.portfolios || {}) };
  const pf = (sec) => String(portfolios[sec] || portfolios.global || "").trim();

  const bidRule = { mode: "suggest", h10Type: d.h10Type, defaultBid: d.defaultBid,
    bidMultiplier: d.bidMultiplier, maxBidCap: d.maxBidCap, fixedBid: d.fixedBid,
    minBid: d.minBid, ...(input.bidRule || {}) };
  const m = input.matches || {};
  const exact  = { on: true,  step: d.ladder.exact.step, levels: d.ladder.exact.levels, note: "", ...(m.exact || {}) };
  const phrase = { on: false, ...d.phrase, step: d.ladder.phrase.step, levels: d.ladder.phrase.levels, note: "", ...(m.phrase || {}) };
  const broad  = { on: false, ...d.broad,  step: d.ladder.broad.step,  levels: d.ladder.broad.levels,  note: "", ...(m.broad || {}) };
  const wordCountLimit = Number(m.wordCountLimit ?? d.wordCountLimit);
  const pbOffsetDays = Number(m.pbOffsetDays ?? d.pbOffsetDays);
  const pt = { on: false, bid: null, step: d.ladder.pt.step, levels: d.ladder.pt.levels, note: "", ...(input.pt || {}) };
  const auto = { on: false, adTypes: ["close-match"], bids: [], note: "", ...(input.auto || {}) };

  const asin = String(info.asin).toUpperCase();
  const exactDate = toBulkDate(info.startDate);
  // Offset ngày RIÊNG cho Phrase và Broad (16/07: tách khỏi cài đặt chung, fallback pbOffsetDays)
  const phraseDate = toBulkDate(addDays(info.startDate, Number(phrase.offsetDays ?? pbOffsetDays)));
  const broadDate = toBulkDate(addDays(info.startDate, Number(broad.offsetDays ?? pbOffsetDays)));

  const baseCtx = { ASIN: asin, SKU: info.sku, Name: info.manager || "",
    Category: String(info.category || "").trim(), PortfolioId: "" };

  const plans = [];
  const seen = new Set();
  const push = (p) => {
    if (seen.has(p.name)) return;
    seen.add(p.name);
    plans.push(p);
  };

  // Bid Exact gốc: fixed → fixedBid; suggest → (bid nhập tay ?? bid H10 theo loại) × hệ số, trần cap
  const exactBase = (kw) => {
    if (bidRule.mode === "fixed") return r2(bidRule.fixedBid);
    const raw = kw.bid ?? (kw.bids ? kw.bids[bidRule.h10Type] : null);
    if (raw == null) return r2(bidRule.defaultBid);
    return Math.min(r2(bidRule.maxBidCap), r2(raw * bidRule.bidMultiplier));
  };
  // Phrase/Broad gốc: set value hoặc % bid Exact gốc
  const derived = (cfg, base) => cfg.mode === "value" ? r2(cfg.value) : r2(base * cfg.ratio);

  const kwPlan = (text, matchType, bid, date, template, portfolio, note) => ({
    type: `SP_KW_${matchType.toUpperCase()}`,
    name: renderName(template, { ...baseCtx, Keyword: text, MatchType: matchType[0].toUpperCase() + matchType.slice(1),
      Bid: bid.toFixed(2), StartDate: date, Note: note }),
    keyword: text, matchType, bid, budget: Number(camp.dailyBudget),
    portfolioId: portfolio, startDateBulk: date, note, ...campLevel
  });

  for (const kw of input.keywords || []) {
    const text = String(kw.text || "").trim().toLowerCase();
    if (!text) continue;
    const base = exactBase(kw);
    const words = text.split(/\s+/).length;

    if (exact.on) {
      for (const bid of ladderBids(base, exact.step, exact.levels, bidRule.minBid)) {
        push(kwPlan(text, "exact", bid, exactDate, naming.kw, pf("exact"), exact.note || ""));
      }
    }
    // Giới hạn số từ RIÊNG cho Phrase và Broad (16/07: tách khỏi cài đặt chung)
    const phraseLimit = Number(phrase.wordLimit ?? wordCountLimit);
    const broadLimit = Number(broad.wordLimit ?? wordCountLimit);
    if (phrase.on && words <= phraseLimit) {
      for (const bid of ladderBids(derived(phrase, base), phrase.step, phrase.levels, bidRule.minBid)) {
        push(kwPlan(text, "phrase", bid, phraseDate, naming.kw, pf("phrase"), phrase.note || ""));
      }
    }
    if (broad.on && words <= broadLimit) {
      for (const bid of ladderBids(derived(broad, base), broad.step, broad.levels, bidRule.minBid)) {
        push(kwPlan(text, "broad", bid, broadDate, naming.kw, pf("broad"), broad.note || ""));
      }
    }
  }

  if (pt.on) {
    const ptBase = r2(pt.bid || bidRule.defaultBid);
    for (const ta of input.targetAsins || []) {
      const target = String(ta).trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(target)) continue;
      for (const bid of ladderBids(ptBase, pt.step, pt.levels, bidRule.minBid)) {
        push({
          type: "SP_PT",
          name: renderName(naming.pt, { ...baseCtx, TargetAsin: target, Bid: bid.toFixed(2), StartDate: exactDate, Note: pt.note || "" }),
          targetAsin: target, bid, budget: Number(camp.dailyBudget),
          portfolioId: pf("pt"), startDateBulk: exactDate, note: pt.note || "", ...campLevel
        });
      }
    }
  }

  if (auto.on) {
    const bids = (auto.bids || []).map(parseBid).filter((b) => b != null);
    for (const adType of auto.adTypes || []) {
      if (!AD_TYPE_MATRIX[adType]) continue;
      for (const bid of bids.length ? bids : [bidRule.defaultBid]) {
        push({
          type: "SP_AUTO",
          name: renderName(naming.auto, { ...baseCtx, AdType: adType, Bid: bid.toFixed(2), StartDate: exactDate, Note: auto.note || "" }),
          adType, bid, budget: Number(camp.autoDailyBudget),
          portfolioId: pf("auto"), startDateBulk: exactDate, note: auto.note || "", ...campLevel
        });
      }
    }
  }

  const stats = {};
  for (const p of plans) stats[p.type] = (stats[p.type] || 0) + 1;
  const trackingKeywords = [...new Set((input.keywords || [])
    .map((k) => String(k.text || "").trim().toLowerCase()).filter(Boolean))];

  return { plans, stats, trackingKeywords, asin };
}

/* ============================================================
   PHA 2 — buildRowsFromPlans: plans (user đã chỉnh) → dòng bulk
   ============================================================ */
export function buildRowsFromPlans(plans, input) {
  const d = DEFAULTS;
  const info = input.info || {};
  const camp = { biddingStrategy: d.biddingStrategy, placementTop: d.placementTop,
    placementProductPage: d.placementProductPage, placementRestOfSearch: d.placementRestOfSearch,
    adGroupDefaultBid: d.adGroupDefaultBid, autoAdGroupDefaultBid: d.autoAdGroupDefaultBid,
    ...(input.camp || {}) };

  const row = () => Object.fromEntries(BULK_HEADER.map((h) => [h, ""]));
  const rows = [];
  const seen = new Set();

  for (const p of plans) {
    if (!p || !p.name || seen.has(p.name)) continue;
    seen.add(p.name);
    const isAuto = p.type === "SP_AUTO";
    const bid = parseBid(p.bid);
    if (bid == null) throw new Error(`Bid không hợp lệ ở campaign: ${p.name}`);

    // 1. Campaign — strategy/placement ưu tiên giá trị TRÊN PLAN (user chỉnh ở preview),
    // thiếu mới rơi về cài đặt chung
    const c = row();
    Object.assign(c, {
      Product: "Sponsored Products", Entity: "Campaign", Operation: "Create",
      "Campaign Id": p.name, "Portfolio Id": p.portfolioId || "", "Campaign Name": p.name,
      "Start Date": p.startDateBulk, "Targeting Type": isAuto ? "AUTO" : "MANUAL",
      State: "enabled", "Daily Budget": parseBid(p.budget) ?? (isAuto ? d.autoDailyBudget : d.dailyBudget),
      "Bidding Strategy": p.biddingStrategy || camp.biddingStrategy
    });
    rows.push(c);

    // 2-4. Bidding Adjustment
    for (const [placement, pct] of [
      ["placementTop", p.placementTop ?? camp.placementTop],
      ["placementProductPage", p.placementProductPage ?? camp.placementProductPage],
      ["placementRestOfSearch", p.placementRestOfSearch ?? camp.placementRestOfSearch]
    ]) {
      const b = row();
      Object.assign(b, {
        Product: "Sponsored Products", Entity: "Bidding Adjustment", Operation: "Create",
        "Campaign Id": p.name, Placement: placement, Percentage: Number(pct) || 0
      });
      rows.push(b);
    }

    // 5. Ad Group
    const g = row();
    Object.assign(g, {
      Product: "Sponsored Products", Entity: "Ad Group", Operation: "Create",
      "Campaign Id": p.name, "Ad Group Id": p.name, "Ad Group Name": p.name,
      State: "enabled", "Ad Group Default Bid": isAuto ? camp.autoAdGroupDefaultBid : camp.adGroupDefaultBid
    });
    rows.push(g);

    // 6. Product Ad
    const ad = row();
    Object.assign(ad, {
      Product: "Sponsored Products", Entity: "Product Ad", Operation: "Create",
      "Campaign Id": p.name, "Ad Group Id": p.name, State: "enabled", SKU: info.sku
    });
    rows.push(ad);

    // 7+. Target
    if (p.type.startsWith("SP_KW_")) {
      const k = row();
      Object.assign(k, {
        Product: "Sponsored Products", Entity: "Keyword", Operation: "Create",
        "Campaign Id": p.name, "Ad Group Id": p.name, State: "enabled",
        Bid: bid, "Keyword Text": p.keyword, "Match Type": p.matchType
      });
      rows.push(k);
    } else if (p.type === "SP_PT") {
      const t = row();
      Object.assign(t, {
        Product: "Sponsored Products", Entity: "Product Targeting", Operation: "Create",
        "Campaign Id": p.name, "Ad Group Id": p.name, State: "enabled",
        Bid: bid, "Product Targeting Expression": `asin="${String(p.targetAsin).toUpperCase()}"`
      });
      rows.push(t);
    } else if (isAuto) {
      const states = AD_TYPE_MATRIX[p.adType];
      if (!states) throw new Error(`ad_type không hợp lệ: ${p.adType}`);
      AUTO_EXPRESSIONS.forEach((expr, i) => {
        const t = row();
        Object.assign(t, {
          Product: "Sponsored Products", Entity: "Product Targeting", Operation: "Create",
          "Campaign Id": p.name, "Ad Group Id": p.name, State: states[i],
          Bid: bid, "Product Targeting Expression": expr
        });
        rows.push(t);
      });
    }
  }
  return rows;
}

/** Tiện ích 1 phát: plan + build (dùng khi export không qua preview chỉnh sửa). */
export function buildAll(input) {
  const { plans, stats, trackingKeywords, asin } = planCampaigns(input);
  const rows = buildRowsFromPlans(input.plans || plans, input);
  return { rows, plans, campaigns: plans, stats, trackingKeywords, asin };
}
