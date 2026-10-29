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

/* ===== SPONSORED DISPLAY — header RIÊNG 22 cột (đúc kết từ 3 file SD của user, 17/07/2026) ===== */
export const SD_HEADER = [
  "Product", "Entity", "Operation", "Campaign ID", "Portfolio ID", "Ad Group ID", "Ad ID",
  "Targeting ID", "Campaign Name", "Ad Group Name", "Start Date", "End Date", "State",
  "Tactic", "Budget Type", "Budget", "SKU", "Ad Group Default Bid", "Bid",
  "Bid Optimization", "Cost Type", "Targeting Expression"
];

/* ===== SPONSORED BRANDS VIDEO — header RIÊNG 32 cột (từ SB Video Store.xlsx / SB Video Product Targeting.xlsx) ===== */
export const SB_HEADER = [
  "Product", "Entity", "Operation", "Campaign ID", "Draft Campaign ID", "Portfolio ID",
  "Ad Group ID", "Keyword ID", "Product Targeting ID", "Campaign Name", "Start Date", "End Date",
  "State", "Budget Type", "Budget", "Bid Optimization", "Bid Multiplier", "Bid",
  "Keyword Text", "Match Type", "Product Targeting Expression", "Ad Format",
  "Landing Page URL", "Landing Page ASINs", "Brand Entity ID", "Brand Name",
  "Brand Logo Asset ID", "Custom Image Asset ID", "Creative Headline", "Creative ASINs",
  "Video Media IDs", "Creative Type"
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
  placementTop: 0, placementProductPage: 0, placementRestOfSearch: 0, placementAmazonBusiness: 0,
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
  // SB Video (theo file mẫu: Ad Format Video, Bid Optimization Auto, Creative Type video)
  sbBudgetKw: 6, sbBudgetPt: 10,
  nameSbKw: "FBA - SB Video - {ASIN} - {Keyword} - {MatchType} {Bid} - {StartDate} - {NameID} - {Note}",
  nameSbPt: "FBA - SB Video - {ASIN} - {Group} - {Bid} - {StartDate} - {NameID} - {Note}",
  // SD (theo file mẫu: Tactic T00030, Daily, vcpm, Optimize for viewable impressions)
  sdBudgetPt: 10, sdBudgetPtG: 8, sdBudgetRem: 8, sdAdGroupBid: 2.0,
  sdCostType: "vcpm", sdBidOpt: "Optimize for viewable impressions",
  sdLookbacks: [{ days: 7, bid: 3.7 }, { days: 14, bid: 3.0 }, { days: 30, bid: 2.5 }, { days: 60, bid: 2.0 }],
  nameSdPt:  "FBA - {ASIN} - SD - PRODUCT TG - {TargetAsin} - {Bid} - {StartDate} - {NameID} - {Note}",
  nameSdPtG: "FBA - {ASIN} - SD - PRODUCT TG - {Group} - {Bid} - {StartDate} - {NameID} - {Note}",
  nameSdRem: "FBA - {ASIN} - SD - Remarketing - {StartDate} - {NameID} - {Note}",
  nameKw:      "FBA - {ASIN} - SP - {Keyword} - {MatchType} {Bid} - {StartDate} - {NameID} - {Note}",
  namePt:      "FBA - {ASIN} - SP - PRODUCT TG - {TargetAsin} - {Bid} - {StartDate} - {NameID} - {Note}",
  namePtGroup: "FBA - {ASIN} - SP - PRODUCT TG - {Group} - {Bid} - {StartDate} - {NameID} - {Note}",
  nameAuto:    "FBA - {ASIN} - SP - {Category} Auto - {AdType} {Bid} - {StartDate} - {NameID} - {Note}"
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

/* KÝ TỰ VÔ HÌNH — Amazon từ chối CẢ FILE với "campaign name has invalid characters".
   Hay dính nhất là U+FFFC (object replacement) khi copy keyword từ web hoặc Helium 10:
   nó hiện thành ô vuông ￼ hoặc không hiện gì, nhìn mắt thường không thấy. Kèm theo:
   zero-width, BOM, soft hyphen, ký tự điều khiển, và nbsp (đổi thành khoảng trắng thường). */
const INVISIBLE_RE = /[\u0000-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u2060\uFEFF\uFFFC]/g;
export const cleanText = (s) =>
  String(s ?? "").replace(INVISIBLE_RE, "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

export function renderName(template, ctx) {
  let s = String(template || "");
  for (const [k, v] of Object.entries(ctx)) {
    s = s.split(`{${k}}`).join(v === null || v === undefined ? "" : String(v));
  }
  s = cleanText(s); // ctx có thể mang keyword/note dính ký tự ẩn → lọc TRƯỚC khi thành tên campaign
  return s.replace(/(\s*-\s*){2,}/g, " - ").replace(/\s*-\s*$/, "").replace(/^\s*-\s*/, "").replace(/\s{2,}/g, " ").trim();
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
 * input.keywords:   [{text, bid|null, bids:{sugg,min,max}|null, offset?:n}]  — offset = +n ngày Start Date
 * input.targetAsins:[string]
 * input.naming:     {kw, pt, auto}
 * input.camp:       {dailyBudget, autoDailyBudget, ...}
 */
export function planCampaigns(input) {
  const d = DEFAULTS;
  const info = input.info || {};
  // Chọn sản phẩm từ Danh mục thì SKU/ASIN nằm trong info.products — không bắt phải điền
  // thêm hai ô cũ nữa. Vẫn chấp nhận cách gọi cũ chỉ có info.sku + info.asin.
  const head = (Array.isArray(info.products) && info.products[0]) || {};
  if (!info.sku && !head.sku) throw new Error("Thiếu SKU");
  if (!/^[A-Z0-9]{10}$/i.test(info.asin || head.asin || "")) throw new Error("ASIN không hợp lệ");
  if (!info.startDate) throw new Error("Thiếu ngày tạo");
  if (info.manager && String(info.manager).length > 5) throw new Error("Mã cá nhân tối đa 5 ký tự");

  const camp = { dailyBudget: d.dailyBudget, autoDailyBudget: d.autoDailyBudget,
    biddingStrategy: d.biddingStrategy, placementTop: d.placementTop,
    placementProductPage: d.placementProductPage, placementRestOfSearch: d.placementRestOfSearch,
    placementAmazonBusiness: d.placementAmazonBusiness,
    ...(input.camp || {}) };
  // Mỗi plan mang theo strategy/placement riêng (chỉnh được từng campaign ở preview)
  const campLevel = {
    biddingStrategy: camp.biddingStrategy,
    placementTop: Number(camp.placementTop) || 0,
    placementProductPage: Number(camp.placementProductPage) || 0,
    placementRestOfSearch: Number(camp.placementRestOfSearch) || 0,
    placementAmazonBusiness: Number(camp.placementAmazonBusiness) || 0
  };
  // Template TRỐNG phải rơi về mặc định — "" đè default sẽ render tên rỗng → campaign biến mất (bug "chưa tạo" 17/07)
  const nm = input.naming || {};
  const naming = { kw: nm.kw || d.nameKw, pt: nm.pt || d.namePt,
    ptGroup: nm.ptGroup || d.namePtGroup, auto: nm.auto || d.nameAuto,
    sdPt: nm.sdPt || d.nameSdPt, sdPtG: nm.sdPtG || d.nameSdPtG, sdRem: nm.sdRem || d.nameSdRem,
    sbKw: nm.sbKw || d.nameSbKw, sbPt: nm.sbPt || d.nameSbPt };
  /* Mẫu tên lưu từ trước ghi cứng "FBA" nên không ăn theo cột Type trong Danh mục.
     Đổi tiền tố đó thành {Type} lúc chạy — khỏi phải sửa tay từng mẫu đã lưu. */
  const withType = (t) => (/\{Type\}/.test(String(t)) ? String(t) : String(t).replace(/^\s*(FBA|FBM)\b/i, "{Type}"));
  /* {Name} là tên biến ĐỜI CŨ của {NameID}. Mẫu lưu từ trước vẫn còn nó, mà renderName chỉ
     biết {NameID} → chuỗi "{Name}" NẰM NGUYÊN trong tên campaign. Nhánh Adjust harvest đã
     quy đổi từ lâu, nhánh Tạo Campaign thì chưa — nên mẫu cũ sinh ra tên campaign hỏng. */
  for (const k of Object.keys(naming)) naming[k] = withType(String(naming[k]).replace(/\{Name\}/g, "{NameID}"));

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
  // PT: 2 MỤC ĐỘC LẬP, dùng đồng thời được (16/07 — từ Targeting 1 ASIN.xlsx / Targeting 10 ASIN.xlsx):
  //  - pt (1 ASIN):       mỗi target ASIN = 1 campaign, tên dùng chính ASIN đó
  //  - ptGroup (ASINs):   chia targetAsins thành TỪNG NHÓM 10 (nhóm cuối = số còn lại <10),
  //                       1 nhóm = 1 campaign chứa N dòng targeting; tên "{Tên} 1", "{Tên} 2"...
  const pt = { on: false, bid: null, step: d.ladder.pt.step, levels: d.ladder.pt.levels, note: "",
    exact: true, expanded: false, ...(input.pt || {}) }; // exact → asin="", expanded → asin-expanded="", cả 2 → 2 targeting cùng ad group
  const ptGroup = { on: false, groupName: "", groupSize: 10, exact: true, expanded: false, // exact → asin="", expanded → asin-expanded="", cả 2 được
    bid: null, step: d.ladder.pt.step, levels: d.ladder.pt.levels, note: "", ...(input.ptGroup || {}) };
  /* TÁCH ĐÔI Exact / Expanded thành HAI CAMPAIGN RIÊNG (chốt với người dùng 12/10/2026).
     Trước đây tick cả hai ra MỘT campaign chứa cả asin= lẫn asin-expanded= trong cùng ad
     group — không đặt bid riêng cho từng loại được, trong khi asin-expanded ăn traffic rộng
     hơn hẳn nên gần như luôn cần bid khác. Tên campaign cũng không phân biệt nổi hai loại.
     Mẫu tên Expanded suy ra từ chính mẫu gốc (chèn " - Expanded" sau {TargetAsin}/{Group}),
     nên người dùng không phải khai thêm mẫu thứ hai. */
  const ptVariants = (cfg) => {
    const out = [];
    if (cfg.exact || (!cfg.exact && !cfg.expanded)) out.push({ expanded: false });
    if (cfg.expanded) out.push({ expanded: true });
    return out;
  };
  const expandedTpl = (tpl, token) => String(tpl).includes(token)
    ? String(tpl).replace(token, `${token} - Expanded`)
    : `${tpl} - Expanded`;

  // helper: expression list theo flag exact/expanded (không tick gì → coi như exact)
  const ptExprs = (cfg, ta) => {
    const out = [];
    if (cfg.exact || (!cfg.exact && !cfg.expanded)) out.push(`asin="${ta}"`);
    if (cfg.expanded) out.push(`asin-expanded="${ta}"`);
    return out;
  };
  const auto = { on: false, adTypes: ["close-match"], bids: [], note: "", ...(input.auto || {}) };

  const asin = String(info.asin || head.asin).toUpperCase();
  const exactDate = toBulkDate(info.startDate);
  // Offset ngày RIÊNG cho Phrase và Broad (16/07: tách khỏi cài đặt chung, fallback pbOffsetDays)
  const phraseOff = Number(phrase.offsetDays ?? pbOffsetDays);
  const broadOff = Number(broad.offsetDays ?? pbOffsetDays);
  const phraseDate = toBulkDate(addDays(info.startDate, phraseOff));
  const broadDate = toBulkDate(addDays(info.startDate, broadOff));
  /* +n NGÀY THEO KEYWORD (Danh mục Keyword, dòng "kw | bid | +n"): group launch sau ngày
     launch chính n ngày → Start Date của MỌI campaign của keyword đó lùi n ngày (cộng dồn với
     offset riêng của Phrase/Broad). Không có +n thì y như cũ. */
  const kwOff = (kw) => Math.max(0, Math.min(365, Math.round(Number(kw.offset) || 0)));
  const dateFor = (base, kw) => (kwOff(kw) ? toBulkDate(addDays(info.startDate, base + kwOff(kw))) : null);

  /* NHIỀU SẢN PHẨM TRONG 1 CAMPAIGN: info.products = [{asin, sku, type}] lấy từ Danh mục,
     phần tử ĐẦU là sản phẩm chính. Mỗi sản phẩm thành 1 dòng Product Ad trong cùng ad group.
     Thiếu products thì quay về 1 sản phẩm như cũ — mọi lệnh gọi cũ vẫn chạy. */
  const prodList = (Array.isArray(info.products) && info.products.length
    ? info.products
    : [{ asin: info.asin, sku: info.sku, type: info.type }])
    .map((x) => ({ asin: cleanText(x.asin).toUpperCase(), sku: cleanText(x.sku), type: String(x.type || "").toUpperCase() === "FBM" ? "FBM" : "FBA" }))
    .filter((x) => /^[A-Z0-9]{10}$/.test(x.asin));
  const prods = prodList.length ? prodList : [{ asin, sku: info.sku, type: "FBA" }];
  const multiAsin = prods.length > 1;
  const pfNames = input.portfolioNames || {};
  const pfLabel = (id) => String(pfNames[String(id || "").trim()] || "").trim();

  const baseCtx = { ASIN: asin, SKU: prods[0].sku || info.sku, NameID: info.manager || "",
    Type: prods[0].type, Category: String(info.category || "").trim(), PortfolioId: "" };

  /* {ASIN} khi campaign gom NHIỀU sản phẩm → "ASINs - <tên portfolio>". Nhãn phụ thuộc
     portfolio của chính mục đó, nên context phải dựng theo từng mục chứ không dùng chung. */
  const ctx = (pfId) => (multiAsin
    ? { ...baseCtx, ASIN: ["ASINs", pfLabel(pfId)].filter(Boolean).join(" - ") }
    : baseCtx);

  const plans = [];
  const seen = new Set();
  const productAds = prods.map((x) => ({ sku: x.sku, asin: x.asin }));
  const push = (p) => {
    if (seen.has(p.name)) return;
    seen.add(p.name);
    // Gắn 1 dòng Product Ad cho MỖI sản phẩm vào mọi ad group chưa tự khai
    for (const ag of p.adGroups || []) if (!ag.productAds) ag.productAds = productAds;
    plans.push(p);
  };

  // Bid Exact gốc: fixed → fixedBid; suggest → (bid nhập tay ?? bid H10 theo loại) × hệ số, trần cap
  const exactBase = (kw) => {
    if (kw.bid != null) return r2(kw.bid); // bid tay "kw | bid" LUÔN ưu tiên (kể cả mode fixed — Adjust harvest bid=CPC)
    if (bidRule.mode === "fixed") return r2(bidRule.fixedBid);
    const raw = kw.bids ? kw.bids[bidRule.h10Type] : null;
    if (raw == null) return r2(bidRule.defaultBid);
    return Math.min(r2(bidRule.maxBidCap), r2(raw * bidRule.bidMultiplier));
  };
  // Phrase/Broad gốc: set value hoặc % bid Exact gốc
  const derived = (cfg, base) => cfg.mode === "value" ? r2(cfg.value) : r2(base * cfg.ratio);

  // Mỗi plan mang asin/sku RIÊNG — cho phép gom campaign của NHIỀU ASIN vào 1 danh sách/1 file bulk
  const productLevel = { asin, sku: info.sku };

  // Cấu trúc phân tầng: mỗi plan có adGroups[] — 1 campaign tạo được NHIỀU ad group,
  // mỗi ad group có targets (kw/pt/auto), negatives (Negative Keyword cấp ad group),
  // negPt (Negative Product Targeting); plan.negatives = Campaign Negative Keyword (cả campaign)
  const kwPlan = (text, matchType, bid, date, template, portfolio, note) => {
    const name = renderName(template, { ...ctx(portfolio), Keyword: text, MatchType: matchType[0].toUpperCase() + matchType.slice(1),
      Bid: bid.toFixed(2), StartDate: date, Note: note });
    return {
      type: `SP_KW_${matchType.toUpperCase()}`, name,
      keyword: text, matchType, bid, budget: Number(camp.dailyBudget),
      portfolioId: portfolio, startDateBulk: date, endDateBulk: "", note, ...campLevel, ...productLevel,
      adGroups: [{ name, defaultBid: Number(camp.adGroupDefaultBid) || d.adGroupDefaultBid,
        targets: [{ kind: "kw", text, mt: matchType, bid }], negatives: [], negPt: [] }]
    };
  };

  // CHẾ ĐỘ CAMPAIGN (19/07): "single" = 1 campaign - 1 ad group (mặc định, như cũ)
  //                          "multi"  = 1 campaign - NHIỀU ad group (mỗi keyword 1 ad group, bid riêng)
  // multi: ladder KHÔNG áp (mỗi keyword dùng bid gốc của nó); tên campaign: {Keyword} = "kw đầu +N"
  const campaignMode = input.campaignMode === "multi" ? "multi" : "single";
  const kwSeen = new Set();
  const kwListClean = (input.keywords || [])
    .map((kw) => ({ ...kw, text: cleanText(kw.text).toLowerCase() }))
    .filter((kw) => kw.text && !kwSeen.has(kw.text) && kwSeen.add(kw.text));

  if (campaignMode === "multi") {
    // bid của 1 keyword theo match type (exact = bid gốc; phrase/broad = suy ra từ bid gốc)
    const bidFor = (matchType, kw) => matchType === "exact"
      ? r2(exactBase(kw))
      : r2(derived(matchType === "phrase" ? phrase : broad, exactBase(kw)));
    const kwLabel = (kws, portfolio) => (kws.length > 1
      ? ["keywords", pfLabel(portfolio)].filter(Boolean).join(" - ")
      : kws[0].text);
    const mkMultiOne = (matchType, kws, date, portfolio, note, suffix) => {
      if (!kws.length) return;
      // Nhiều keyword trong 1 campaign → {Keyword} = "keywords - <tên portfolio>"
      const label = kwLabel(kws, portfolio) + suffix;
      // {Bid} trong tên campaign = bid ĐÚNG match type của keyword đầu (không lấy bid Exact cho campaign Phrase/Broad)
      const headBid = bidFor(matchType, kws[0]);
      const name = renderName(naming.kw, { ...ctx(portfolio), Keyword: label,
        MatchType: matchType[0].toUpperCase() + matchType.slice(1),
        Bid: headBid.toFixed(2), StartDate: date, Note: note });
      push({
        type: `SP_KW_${matchType.toUpperCase()}`, name,
        keyword: label, matchType, bid: headBid, budget: Number(camp.dailyBudget),
        portfolioId: portfolio, startDateBulk: date, endDateBulk: "", note, ...campLevel, ...productLevel,
        adGroups: kws.map((kw) => ({
          name: kw.text, defaultBid: Number(camp.adGroupDefaultBid) || d.adGroupDefaultBid,
          targets: [{ kind: "kw", text: kw.text, mt: matchType, bid: bidFor(matchType, kw) }], negatives: [], negPt: []
        }))
      });
    };
    // 1 campaign chỉ có 1 Start Date → keyword khác +n tách thành campaign riêng theo từng
    // mốc ngày; tên thêm " +n" để không trùng (push() bỏ qua tên trùng — sẽ mất campaign).
    const mkMulti = (matchType, kws, date, portfolio, note) => {
      const base = matchType === "exact" ? 0 : matchType === "phrase" ? phraseOff : broadOff;
      const byOff = new Map();
      for (const kw of kws) { const o = kwOff(kw); if (!byOff.has(o)) byOff.set(o, []); byOff.get(o).push(kw); }
      const many = byOff.size > 1;
      for (const [o, group] of [...byOff].sort((a, b) => a[0] - b[0])) {
        mkMultiOne(matchType, group, o ? toBulkDate(addDays(info.startDate, base + o)) : date, portfolio, note, many && o ? ` +${o}` : "");
      }
    };
    if (exact.on) mkMulti("exact", kwListClean, exactDate, pf("exact"), exact.note || "");
    const phraseLimit = Number(phrase.wordLimit ?? wordCountLimit);
    const broadLimit = Number(broad.wordLimit ?? wordCountLimit);
    if (phrase.on) mkMulti("phrase", kwListClean.filter((k) => k.text.split(/\s+/).length <= phraseLimit), phraseDate, pf("phrase"), phrase.note || "");
    if (broad.on) mkMulti("broad", kwListClean.filter((k) => k.text.split(/\s+/).length <= broadLimit), broadDate, pf("broad"), broad.note || "");
  } else
  for (const kw of kwListClean) {
    const text = kw.text;
    const base = exactBase(kw);
    const words = text.split(/\s+/).length;

    if (exact.on) {
      for (const bid of ladderBids(base, exact.step, exact.levels, bidRule.minBid)) {
        push(kwPlan(text, "exact", bid, dateFor(0, kw) || exactDate, naming.kw, pf("exact"), exact.note || ""));
      }
    }
    // Giới hạn số từ RIÊNG cho Phrase và Broad (16/07: tách khỏi cài đặt chung)
    const phraseLimit = Number(phrase.wordLimit ?? wordCountLimit);
    const broadLimit = Number(broad.wordLimit ?? wordCountLimit);
    if (phrase.on && words <= phraseLimit) {
      for (const bid of ladderBids(derived(phrase, base), phrase.step, phrase.levels, bidRule.minBid)) {
        push(kwPlan(text, "phrase", bid, dateFor(phraseOff, kw) || phraseDate, naming.kw, pf("phrase"), phrase.note || ""));
      }
    }
    if (broad.on && words <= broadLimit) {
      for (const bid of ladderBids(derived(broad, base), broad.step, broad.levels, bidRule.minBid)) {
        push(kwPlan(text, "broad", bid, dateFor(broadOff, kw) || broadDate, naming.kw, pf("broad"), broad.note || ""));
      }
    }
  }

  /* BỎ TRÙNG — bắt buộc. ASIN lặp trong cùng nhóm sinh ra 2 dòng Product Targeting y hệt
     (asin= và asin-expanded=), Amazon báo 'Duplicate "Product Targeting Expression"' và từ
     chối TOÀN BỘ file, không chỉ dòng lỗi. Danh sách đối thủ dán tay hoặc lấy từ nhiều phiên
     quét rất dễ lặp. Cả 5 nhánh PT đều đọc mảng này nên lọc một lần là đủ. */
  const ptTargets = [...new Set(
    (input.targetAsins || [])
      .map((t) => cleanText(t).toUpperCase())
      .filter((t) => /^[A-Z0-9]{10}$/.test(t))
  )];

  // PT (1 ASIN): mỗi target = 1 campaign
  if (pt.on) {
    const ptBase = r2(pt.bid || bidRule.defaultBid);
    for (const target of ptTargets) {
      for (const v of ptVariants(pt)) {
        const tpl = v.expanded ? expandedTpl(naming.pt, "{TargetAsin}") : naming.pt;
        for (const bid of ladderBids(ptBase, pt.step, pt.levels, bidRule.minBid)) {
          const nm1 = renderName(tpl, { ...ctx(pf("pt")), TargetAsin: target, Bid: bid.toFixed(2), StartDate: exactDate, Note: pt.note || "" });
          push({
            type: "SP_PT", name: nm1,
            targetAsin: target, expanded: v.expanded, bid, budget: Number(camp.dailyBudget),
            portfolioId: pf("pt"), startDateBulk: exactDate, endDateBulk: "", note: pt.note || "", ...campLevel, ...productLevel,
            adGroups: [{ name: nm1, defaultBid: Number(camp.adGroupDefaultBid) || d.adGroupDefaultBid,
              targets: [{ kind: "pt", expr: `${v.expanded ? "asin-expanded" : "asin"}="${target}"`, bid }], negatives: [], negPt: [] }]
          });
        }
      }
    }
  }

  // PT (ASINs): nhóm 10/campaign, nhóm cuối là phần dư (<10)
  if (ptGroup.on && ptTargets.length) {
    const gBase = r2(ptGroup.bid || bidRule.defaultBid);
    const size = Math.max(2, Number(ptGroup.groupSize) || 10);
    const groups = [];
    for (let i = 0; i < ptTargets.length; i += size) groups.push(ptTargets.slice(i, i + size));
    const gName = String(ptGroup.groupName || "Target").trim() || "Target";
    groups.forEach((grp, gi) => {
      const label = `${gName} ${gi + 1}`;
      for (const v of ptVariants(ptGroup)) {
        const tpl = v.expanded ? expandedTpl(naming.ptGroup, "{Group}") : naming.ptGroup;
        for (const bid of ladderBids(gBase, ptGroup.step, ptGroup.levels, bidRule.minBid)) {
          const nm2 = renderName(tpl, { ...ctx(pf("ptGroup") || pf("pt")), Group: label, TargetAsin: label, Bid: bid.toFixed(2), StartDate: exactDate, Note: ptGroup.note || "" });
          push({
            type: "SP_PT_GROUP", name: nm2,
            targetAsins: grp, groupLabel: label, expanded: v.expanded, bid, budget: Number(camp.dailyBudget),
            portfolioId: pf("ptGroup") || pf("pt"), startDateBulk: exactDate, endDateBulk: "", note: ptGroup.note || "", ...campLevel, ...productLevel,
            adGroups: [{ name: nm2, defaultBid: Number(camp.adGroupDefaultBid) || d.adGroupDefaultBid,
              targets: grp.map((ta) => ({ kind: "pt", expr: `${v.expanded ? "asin-expanded" : "asin"}="${ta}"`, bid })), negatives: [], negPt: [] }]
          });
        }
      }
    });
  }

  /* ===== SPONSORED DISPLAY (17/07/2026 — từ 3 file SD user gửi) ===== */
  const sd = input.sd || {};
  const sdShared = {
    sdAdGroupBid: parseBid(sd.adGroupBid) ?? d.sdAdGroupBid,
    sdCostType: sd.costType || d.sdCostType,
    sdBidOpt: sd.bidOpt || d.sdBidOpt
  };
  const sdPt = { on: false, bid: null, step: d.ladder.pt.step, levels: d.ladder.pt.levels,
    budget: d.sdBudgetPt, note: "", ...(sd.pt || {}) };
  const sdPtG = { on: false, groupName: "", groupSize: 10, expanded: false, bid: null,
    step: d.ladder.pt.step, levels: d.ladder.pt.levels, budget: d.sdBudgetPtG, note: "", ...(sd.ptGroup || {}) };
  const sdRem = { on: false, budget: d.sdBudgetRem, note: "",
    lookbacks: d.sdLookbacks, ...(sd.remarketing || {}) };

  // SD PT 1 đối thủ: mỗi target ASIN = 1 campaign (khối 4 dòng)
  if (sdPt.on) {
    const base = r2(sdPt.bid || d.sdAdGroupBid);
    for (const target of ptTargets) {
      for (const bid of ladderBids(base, sdPt.step, sdPt.levels, bidRule.minBid)) {
        push({
          type: "SD_PT",
          name: renderName(naming.sdPt, { ...ctx(pf("sdPt") || pf("pt")), TargetAsin: target, Bid: bid.toFixed(2), StartDate: exactDate, Note: sdPt.note || "" }),
          targetAsin: target, bid, budget: Number(sdPt.budget) || d.sdBudgetPt,
          portfolioId: pf("sdPt") || pf("pt"), startDateBulk: exactDate, note: sdPt.note || "",
          ...sdShared, ...productLevel
        });
      }
    }
  }

  // SD PT nhiều đối thủ: nhóm 10 ASIN/campaign (tối đa 10 dòng Audience Targeting theo file mẫu)
  if (sdPtG.on && ptTargets.length) {
    const base = r2(sdPtG.bid || d.sdAdGroupBid);
    const size = Math.max(2, Math.min(10, Number(sdPtG.groupSize) || 10));
    const groups = [];
    for (let i = 0; i < ptTargets.length; i += size) groups.push(ptTargets.slice(i, i + size));
    const gName = String(sdPtG.groupName || "Competitor").trim() || "Competitor";
    groups.forEach((grp, gi) => {
      const label = `${gName} ${gi + 1}`;
      for (const bid of ladderBids(base, sdPtG.step, sdPtG.levels, bidRule.minBid)) {
        push({
          type: "SD_PT_GROUP",
          name: renderName(naming.sdPtG, { ...ctx(pf("sdPtG") || pf("pt")), Group: label, TargetAsin: label, Bid: bid.toFixed(2), StartDate: exactDate, Note: sdPtG.note || "" }),
          targetAsins: grp, groupLabel: label, expanded: !!sdPtG.expanded, bid,
          budget: Number(sdPtG.budget) || d.sdBudgetPtG,
          portfolioId: pf("sdPtG") || pf("pt"), startDateBulk: exactDate, note: sdPtG.note || "",
          ...sdShared, ...productLevel
        });
      }
    });
  }

  // SD Remarketing: 1 campaign / ASIN của mình — 4 ad group theo lookback (bỏ lookback có bid trống)
  if (sdRem.on) {
    const lookbacks = (sdRem.lookbacks || d.sdLookbacks)
      .map((l) => ({ days: Number(l.days), bid: parseBid(l.bid) }))
      .filter((l) => l.days > 0 && l.bid != null);
    if (lookbacks.length) {
      push({
        type: "SD_REMARKETING",
        name: renderName(naming.sdRem, { ...ctx(pf("sdRem") || pf("global")), StartDate: exactDate, Note: sdRem.note || "" }),
        lookbacks, bid: lookbacks[0].bid, budget: Number(sdRem.budget) || d.sdBudgetRem,
        portfolioId: pf("sdRem") || pf("global"), startDateBulk: exactDate, note: sdRem.note || "",
        ...sdShared, ...productLevel
      });
    }
  }

  /* ===== SPONSORED BRANDS VIDEO (17/07 — từ 2 file SB mẫu) =====
     Yêu cầu 2 input từ Amazon: Brand Entity ID (Brand Registry) + Video Media ID (Asset Library).
     Không Ad Group/Product Ad — Keyword/PT gắn thẳng Campaign, creative nằm trên dòng Campaign. */
  const sb = input.sb || {};
  const sbShared = {
    brandEntityId: String(sb.brandEntityId || "").trim(), // mẫu có \n thừa — trim
    mediaId: String(sb.mediaId || "").trim()
  };
  const sbKw = { on: false, bid: 0.75, step: 0.03, levels: 1, budget: d.sbBudgetKw, note: "", ...(sb.kw || {}) };
  const sbPt = { on: false, groupName: "", groupSize: 10, bid: 0.77, step: 0.03, levels: 1,
    budget: d.sbBudgetPt, note: "", ...(sb.pt || {}) };

  if ((sbKw.on || sbPt.on) && (!sbShared.brandEntityId || !sbShared.mediaId)) {
    throw new Error("SB Video cần Brand Entity ID + Video Media ID (mục 3.2)");
  }

  // SB Video Keyword: 1 keyword = 1 campaign (bid tay của keyword ưu tiên, không thì bid box)
  if (sbKw.on) {
    for (const kw of input.keywords || []) {
      const text = String(kw.text || "").trim().toLowerCase();
      if (!text) continue;
      const base = r2(kw.bid ?? sbKw.bid);
      const sbDate = dateFor(0, kw) || exactDate;
      for (const bid of ladderBids(base, sbKw.step, sbKw.levels, bidRule.minBid)) {
        push({
          type: "SB_KW",
          name: renderName(naming.sbKw, { ...ctx(pf("sbKw") || pf("global")), Keyword: text, MatchType: "Exact", Bid: bid.toFixed(2), StartDate: sbDate, Note: sbKw.note || "" }),
          keyword: text, matchType: "exact", bid, budget: Number(sbKw.budget) || d.sbBudgetKw,
          portfolioId: pf("sbKw") || pf("global"), startDateBulk: sbDate, note: sbKw.note || "",
          ...sbShared, ...productLevel
        });
      }
    }
  }

  // SB Video Product Targeting: nhóm ≤10 ASIN / campaign (mẫu "Product Target 1/2...")
  if (sbPt.on && ptTargets.length) {
    const size = Math.max(2, Math.min(10, Number(sbPt.groupSize) || 10));
    const groups = [];
    for (let i = 0; i < ptTargets.length; i += size) groups.push(ptTargets.slice(i, i + size));
    const gName = String(sbPt.groupName || "Product Target").trim() || "Product Target";
    groups.forEach((grp, gi) => {
      const label = `${gName} ${gi + 1}`;
      for (const bid of ladderBids(r2(sbPt.bid), sbPt.step, sbPt.levels, bidRule.minBid)) {
        push({
          type: "SB_PT_GROUP",
          name: renderName(naming.sbPt, { ...ctx(pf("sbPt") || pf("global")), Group: label, TargetAsin: label, Bid: bid.toFixed(2), StartDate: exactDate, Note: sbPt.note || "" }),
          targetAsins: grp, groupLabel: label, bid, budget: Number(sbPt.budget) || d.sbBudgetPt,
          portfolioId: pf("sbPt") || pf("global"), startDateBulk: exactDate, note: sbPt.note || "",
          ...sbShared, ...productLevel
        });
      }
    });
  }

  if (auto.on) {
    const bids = (auto.bids || []).map(parseBid).filter((b) => b != null);
    for (const adType of auto.adTypes || []) {
      if (!AD_TYPE_MATRIX[adType]) continue;
      for (const bid of bids.length ? bids : [bidRule.defaultBid]) {
        const nm3 = renderName(naming.auto, { ...ctx(pf("auto")), AdType: adType, Bid: bid.toFixed(2), StartDate: exactDate, Note: auto.note || "" });
        const states = AD_TYPE_MATRIX[adType];
        push({
          type: "SP_AUTO", name: nm3,
          adType, bid, budget: Number(camp.autoDailyBudget),
          portfolioId: pf("auto"), startDateBulk: exactDate, endDateBulk: "", note: auto.note || "", ...campLevel, ...productLevel,
          adGroups: [{ name: nm3, defaultBid: Number(camp.autoAdGroupDefaultBid) || d.autoAdGroupDefaultBid,
            targets: AUTO_EXPRESSIONS.map((expr, i) => ({ kind: "auto", expr, bid, state: states[i] })),
            negatives: [], negPt: [] }]
        });
      }
    }
  }

  const stats = {};
  for (const p of plans) stats[p.type] = (stats[p.type] || 0) + 1;
  const trackingKeywords = [...new Set((input.keywords || [])
    .map((k) => String(k.text || "").trim().toLowerCase()).filter(Boolean))];

  // Tầng Product Ad: mỗi ad group SP mặc định 1 Product Ad (SKU × ASIN của mình), user thêm được nhiều
  for (const p of plans) {
    for (const ag of p.adGroups || []) {
      if (!ag.productAds || !ag.productAds.length) ag.productAds = [{ sku: p.sku || info.sku || "", asin: p.asin || asin }];
    }
  }
  // Báo cho UI biết đã lọc bớt gì — bỏ trùng âm thầm thì người dùng tưởng tool nuốt mất dòng
  // Placeholder gõ sai (VD {Keywrod}) sẽ nằm nguyên trong tên campaign và Amazon từ chối cả
  // file vì ký tự { }. Soát lại tên đã dựng rồi báo ra thay vì để phát hiện lúc upload.
  const badPlaceholders = [...new Set(plans.flatMap((pl) =>
    (String(pl.name).match(/\{[A-Za-z]+\}/g) || [])))];

  const dropped = {
    dupTargets: (input.targetAsins || []).filter((t) => /^[A-Z0-9]{10}$/.test(cleanText(t).toUpperCase())).length - ptTargets.length,
    dupKeywords: (input.keywords || []).filter((k) => cleanText(k.text)).length - kwListClean.length
  };
  return { plans, stats, trackingKeywords, asin, dropped, badPlaceholders };
}

/* ============================================================
   PHA 2 — buildRowsFromPlans: plans (user đã chỉnh) → dòng bulk
   ============================================================ */
export function buildRowsFromPlans(plans, input) {
  const d = DEFAULTS;
  const info = input.info || {};
  const camp = { biddingStrategy: d.biddingStrategy, placementTop: d.placementTop,
    placementProductPage: d.placementProductPage, placementRestOfSearch: d.placementRestOfSearch,
    placementAmazonBusiness: d.placementAmazonBusiness,
    adGroupDefaultBid: d.adGroupDefaultBid, autoAdGroupDefaultBid: d.autoAdGroupDefaultBid,
    ...(input.camp || {}) };

  const row = () => Object.fromEntries(BULK_HEADER.map((h) => [h, ""]));
  const rows = [];
  const seen = new Set();

  for (const p of plans) {
    if (!p || !p.name || seen.has(p.name)) continue;
    if (String(p.type).startsWith("SD_") || String(p.type).startsWith("SB_")) continue; // SD/SB dựng bằng hàm riêng
    seen.add(p.name);
    const isAuto = p.type === "SP_AUTO";

    // 1. Campaign — strategy/placement ưu tiên giá trị TRÊN PLAN (user chỉnh ở preview)
    const c = row();
    Object.assign(c, {
      Product: "Sponsored Products", Entity: "Campaign", Operation: "Create",
      "Campaign Id": p.name, "Portfolio Id": p.portfolioId || "", "Campaign Name": p.name,
      "Start Date": p.startDateBulk, "End Date": p.endDateBulk || "",
      "Targeting Type": isAuto ? "AUTO" : "MANUAL",
      State: "enabled", "Daily Budget": parseBid(p.budget) ?? (isAuto ? d.autoDailyBudget : d.dailyBudget),
      "Bidding Strategy": p.biddingStrategy || camp.biddingStrategy
    });
    rows.push(c);

    // 2-5. Bidding Adjustment — 4 PLACEMENT (Config: có placementAmazonBusiness)
    for (const [placement, pct] of [
      ["placementTop", p.placementTop ?? camp.placementTop],
      ["placementProductPage", p.placementProductPage ?? camp.placementProductPage],
      ["placementRestOfSearch", p.placementRestOfSearch ?? camp.placementRestOfSearch],
      ["placementAmazonBusiness", p.placementAmazonBusiness ?? camp.placementAmazonBusiness]
    ]) {
      const b = row();
      Object.assign(b, {
        Product: "Sponsored Products", Entity: "Bidding Adjustment", Operation: "Create",
        "Campaign Id": p.name, Placement: placement, Percentage: Number(pct) || 0
      });
      rows.push(b);
    }

    // 6. CAMPAIGN NEGATIVE KEYWORD — cấp campaign, áp mọi ad group (Config: không cần Ad Group Id)
    for (const ng of p.negatives || []) {
      const term = String(ng.term || "").trim().toLowerCase();
      if (!term) continue;
      const n = row();
      Object.assign(n, {
        Product: "Sponsored Products", Entity: "Campaign Negative Keyword", Operation: "Create",
        "Campaign Id": p.name, State: "enabled",
        "Keyword Text": term,
        "Match Type": ng.mt === "negativePhrase" ? "negativePhrase" : "negativeExact"
      });
      rows.push(n);
    }

    // 7+. AD GROUPS — 1 campaign nhiều ad group; fallback cấu trúc cũ nếu plan chưa có adGroups
    const adGroups = (Array.isArray(p.adGroups) && p.adGroups.length) ? p.adGroups : legacyAdGroup(p, camp, d);
    for (const ag of adGroups) {
      const agName = ag.name || p.name;

      const g = row();
      Object.assign(g, {
        Product: "Sponsored Products", Entity: "Ad Group", Operation: "Create",
        "Campaign Id": p.name, "Ad Group Id": agName, "Ad Group Name": agName,
        State: "enabled",
        "Ad Group Default Bid": parseBid(ag.defaultBid) ?? (isAuto ? camp.autoAdGroupDefaultBid : camp.adGroupDefaultBid)
      });
      rows.push(g);

      const pas = (ag.productAds && ag.productAds.length) ? ag.productAds : [{ sku: p.sku || info.sku }];
      for (const pa of pas) {
        const ad = row();
        Object.assign(ad, {
          Product: "Sponsored Products", Entity: "Product Ad", Operation: "Create",
          "Campaign Id": p.name, "Ad Group Id": agName, State: "enabled", SKU: pa.sku || p.sku || info.sku
        });
        rows.push(ad);
      }

      // Targets: kw / pt / auto
      for (const t of ag.targets || []) {
        const bid = parseBid(t.bid);
        if (bid == null) continue;
        if (t.kind === "kw" && !String(t.text || "").trim()) continue;      // keyword rỗng — bỏ
        if (t.kind === "pt" && !/[A-Z0-9]{10}/.test(String(t.expr || ""))) continue; // PT chưa có ASIN — bỏ
        if (t.kind === "kw") {
          const k = row();
          Object.assign(k, {
            Product: "Sponsored Products", Entity: "Keyword", Operation: "Create",
            "Campaign Id": p.name, "Ad Group Id": agName, State: t.state || "enabled",
            Bid: bid, "Keyword Text": t.text, "Match Type": t.mt || "exact"
          });
          rows.push(k);
        } else {
          const pt = row();
          Object.assign(pt, {
            Product: "Sponsored Products", Entity: "Product Targeting", Operation: "Create",
            "Campaign Id": p.name, "Ad Group Id": agName, State: t.state || "enabled",
            Bid: bid, "Product Targeting Expression": t.expr
          });
          rows.push(pt);
        }
      }

      // Negative Keyword cấp AD GROUP
      for (const ng of ag.negatives || []) {
        const term = String(ng.term || "").trim().toLowerCase();
        if (!term) continue;
        const n = row();
        Object.assign(n, {
          Product: "Sponsored Products", Entity: "Negative Keyword", Operation: "Create",
          "Campaign Id": p.name, "Ad Group Id": agName, State: "enabled",
          "Keyword Text": term,
          "Match Type": ng.mt === "negativePhrase" ? "negativePhrase" : "negativeExact"
        });
        rows.push(n);
      }

      // Negative Product Targeting (Config: chỉ có cấp ad group, expression asin="...")
      // p.negPt (nhập ở tầng campaign trên UI) tự rải vào MỌI ad group — hiệu quả tương đương chặn cả campaign
      const negPtAll = [...new Set([...(ag.negPt || []), ...(p.negPt || [])])];
      for (const na of negPtAll) {
        const asin = String(na).trim().toUpperCase();
        if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
        const n = row();
        Object.assign(n, {
          Product: "Sponsored Products", Entity: "Negative Product Targeting", Operation: "Create",
          "Campaign Id": p.name, "Ad Group Id": agName, State: "enabled",
          "Product Targeting Expression": `asin="${asin}"`
        });
        rows.push(n);
      }
    }
  }
  return rows;
}

/** Fallback: plan kiểu cũ (chưa có adGroups) → dựng 1 ad group tương đương. */
function legacyAdGroup(p, camp, d) {
  const isAuto = p.type === "SP_AUTO";
  const targets = [];
  if (p.type.startsWith("SP_KW_")) {
    targets.push({ kind: "kw", text: p.keyword, mt: p.matchType, bid: p.bid });
  } else if (p.type === "SP_PT" || p.type === "SP_PT_GROUP") {
    const list = Array.isArray(p.targetAsins) && p.targetAsins.length ? p.targetAsins : [p.targetAsin];
    const exprType = p.expanded ? "asin-expanded" : "asin";
    for (const ta of list) targets.push({ kind: "pt", expr: `${exprType}="${String(ta).toUpperCase()}"`, bid: p.bid });
  } else if (isAuto) {
    const states = AD_TYPE_MATRIX[p.adType] || ["enabled", "enabled", "enabled", "enabled"];
    AUTO_EXPRESSIONS.forEach((expr, i) => targets.push({ kind: "auto", expr, bid: p.bid, state: states[i] }));
  }
  return [{ name: p.name,
    defaultBid: isAuto ? camp.autoAdGroupDefaultBid : camp.adGroupDefaultBid,
    targets, negatives: p.agNegatives || [], negPt: [] }];
}

/* ============================================================
   PHA 2b — buildSdRows: plans SD → dòng bulk sheet "Sponsored Display Campaigns"
   Khối dòng theo file mẫu: Campaign(T00030, Daily, vcpm) → Ad Group(T00030, Bid Optimization)
   → Product Ad(SKU) → N dòng Audience Targeting
   ============================================================ */
export function buildSdRows(plans, input) {
  const d = DEFAULTS;
  const info = input.info || {};
  const rows = [];
  const seen = new Set();
  const row = () => Object.fromEntries(SD_HEADER.map((h) => [h, ""]));

  const campaignRow = (p) => {
    const c = row();
    Object.assign(c, {
      Product: "Sponsored Display", Entity: "Campaign", Operation: "Create",
      "Campaign ID": p.name, "Portfolio ID": p.portfolioId || "", "Campaign Name": p.name,
      "Start Date": p.startDateBulk, State: "enabled", Tactic: "T00030",
      "Budget Type": "Daily", Budget: parseBid(p.budget) ?? d.sdBudgetPt,
      "Cost Type": p.sdCostType || d.sdCostType
    });
    return c;
  };
  const adGroupRow = (p, agName, agBid) => {
    const g = row();
    Object.assign(g, {
      Product: "Sponsored Display", Entity: "Ad Group", Operation: "Create",
      "Campaign ID": p.name, "Ad Group ID": agName, "Ad Group Name": agName,
      State: "enabled", Tactic: "T00030", "Ad Group Default Bid": agBid,
      "Bid Optimization": p.sdBidOpt || d.sdBidOpt
    });
    return g;
  };
  const productAdRow = (p, agName) => {
    const a = row();
    Object.assign(a, {
      Product: "Sponsored Display", Entity: "Product Ad", Operation: "Create",
      "Campaign ID": p.name, "Ad Group ID": agName, "Ad ID": agName,
      State: "enabled", SKU: p.sku || info.sku
    });
    return a;
  };
  const targetingRow = (p, agName, bid, expression) => {
    const t = row();
    Object.assign(t, {
      Product: "Sponsored Display", Entity: "Audience Targeting", Operation: "Create",
      "Campaign ID": p.name, "Ad Group ID": agName, State: "enabled",
      Bid: bid, "Targeting Expression": expression
    });
    return t;
  };

  for (const p of plans) {
    if (!p || !p.name || !String(p.type).startsWith("SD_") || seen.has(p.name)) continue;
    seen.add(p.name);
    const bid = parseBid(p.bid);

    if (p.type === "SD_REMARKETING") {
      // 1 campaign — NHIỀU ad group (mỗi lookback 1 ad group, chỉnh bid riêng từng cái ở preview);
      // ad group bị bỏ (skip) không xuất; cả campaign bị bỏ nếu không còn ad group nào
      const active = (p.lookbacks || []).filter((l) => !l.skip && parseBid(l.bid) != null);
      if (!active.length) continue;
      rows.push(campaignRow(p));
      for (const l of active) {
        const agName = `${p.name} - ${l.days}days viewer`; // khớp file mẫu "7days viewer"
        const agBid = parseBid(l.bid);
        rows.push(adGroupRow(p, agName, agBid));
        rows.push(productAdRow(p, agName));
        rows.push(targetingRow(p, agName, agBid, `views=(exact-product lookback=${l.days})`));
      }
    } else {
      // SD_PT / SD_PT_GROUP
      rows.push(campaignRow(p));
      rows.push(adGroupRow(p, p.name, parseBid(p.sdAdGroupBid) ?? d.sdAdGroupBid));
      rows.push(productAdRow(p, p.name));
      const targets = Array.isArray(p.targetAsins) && p.targetAsins.length ? p.targetAsins : [p.targetAsin];
      const exprType = p.expanded ? "asin-expanded" : "asin";
      for (const ta of targets) {
        rows.push(targetingRow(p, p.name, bid, `${exprType}="${String(ta).toUpperCase()}"`));
      }
    }
  }
  return rows;
}

/* ============================================================
   PHA 2c — buildSbRows: plans SB Video → sheet "Sponsored Brands Campaigns" (32 cột)
   Khối theo file mẫu: Campaign (creative video trên dòng campaign) + Keyword HOẶC N dòng PT
   ============================================================ */
export function buildSbRows(plans, input) {
  const d = DEFAULTS;
  const rows = [];
  const seen = new Set();
  const row = () => Object.fromEntries(SB_HEADER.map((h) => [h, ""]));

  for (const p of plans) {
    if (!p || !p.name || !String(p.type).startsWith("SB_") || seen.has(p.name)) continue;
    seen.add(p.name);
    const bid = parseBid(p.bid);

    const c = row();
    Object.assign(c, {
      Product: "Sponsored Brands", Entity: "Campaign", Operation: "Create",
      "Campaign ID": p.name, "Portfolio ID": p.portfolioId || "", "Campaign Name": p.name,
      "Start Date": p.startDateBulk, State: "enabled",
      "Budget Type": "Daily", Budget: parseBid(p.budget) ?? d.sbBudgetKw,
      "Bid Optimization": "Auto", "Ad Format": "Video",
      "Brand Entity ID": p.brandEntityId || "",
      "Creative ASINs": p.asin || "", "Video Media IDs": p.mediaId || "",
      "Creative Type": "video"
    });
    rows.push(c);

    if (p.type === "SB_KW") {
      const k = row();
      Object.assign(k, {
        Product: "Sponsored Brands", Entity: "Keyword", Operation: "Create",
        "Campaign ID": p.name, State: "enabled",
        Bid: bid, "Keyword Text": p.keyword,
        "Match Type": p.matchType ? p.matchType[0].toUpperCase() + p.matchType.slice(1) : "Exact"
      });
      rows.push(k);
    } else {
      // SB_PT_GROUP: mẫu đặt [campaign_id] vào cột Ad Group ID trên dòng Product Targeting
      for (const ta of p.targetAsins || []) {
        const t = row();
        Object.assign(t, {
          Product: "Sponsored Brands", Entity: "Product Targeting", Operation: "Create",
          "Campaign ID": p.name, "Ad Group ID": p.name, State: "enabled",
          Bid: bid, "Product Targeting Expression": `asin="${String(ta).toUpperCase()}"`
        });
        rows.push(t);
      }
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
