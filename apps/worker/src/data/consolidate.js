// consolidate.js — Module DATA: hợp nhất chỉ số theo ASIN × ngày (Ranking + Ads + Business + Inventory)
//
// Tách từ server.js để trang Data mới và endpoint cũ (/api/asin-daily, /api/history) dùng chung 1 builder.
// Quy ước hiển thị dữ liệu thiếu (knowledge §5): #N/A = không có file; 0 = giá trị thật; - = có file, thiếu dữ liệu.

import * as store from "../db/file-store.js";

const round2 = (n) => Math.round(n * 100) / 100;

/* Chỉ số chính của ASIN theo ngày: Spent, Sales ads, Sale total, ACoS, TACoS
   Quy ước: không có file import ngày đó → null (#N/A); có file, thiếu salesTotal → '-' */
export function buildMetrics(m) {
  if (!m) return null; // #N/A — chưa upload file của ngày này
  const spent = m.spent ?? 0;
  const salesAds = m.salesAds ?? 0;
  const salesTotal = m.salesTotal; // có thể chưa nhập (Business Report)
  return {
    spent,
    salesAds,
    ordersAds: m.ordersAds ?? 0,
    salesTotal: salesTotal ?? null, // null → hiển thị '-'
    acos: salesAds > 0 ? Math.round((spent / salesAds) * 1000) / 10 : null,       // %
    tacos: salesTotal > 0 ? Math.round((spent / salesTotal) * 1000) / 10 : null   // %
  };
}

/* Thống kê rank phụ (dòng nhỏ dưới chỉ số chính) */
export function summarize(run) {
  const rs = run.results || [];
  let p1 = 0, tos = 0, nf = 0;
  for (const x of rs) {
    if (x.error) continue;
    const p = x.primary || {};
    const vOrg = (x.variants || []).find((v) => v.organicRank !== null);
    const page = p.organicPage ?? vOrg?.organicPage ?? null;
    if (page === 1) p1++;
    if ((p.tosPosition || 0) > 0 || (x.variants || []).some((v) => v.tosPosition > 0)) tos++;
    if (x.notFound) nf++;
  }
  return { total: rs.length, p1, tos, nf };
}

/* 1 keyword × 1 lần chạy → 3 tầng: organic / tos / ros */
export function cellOf(x) {
  if (x.error) return { error: true };
  const p = x.primary || {};
  const cell = { organic: null, rank: null, pv: false, variant: null, tos: null, tosPos: 0, ros: null, notFound: !!x.notFound,
    // true = 0 SP tile cả N trang sau retry → ToS/RoS của lần check này không kết luận được
    tosUnknown: x.adsTilesServed === false };

  if (p.organicRank !== null) {
    cell.organic = `Page ${p.organicPage} No ${p.organicPosInPage}`;
    cell.rank = p.organicRank;
    cell.pv = !!p.ownPreviouslyViewed;
  }
  // Badge Amazon trên tile của chính mình (Overall Pick, Amazon's Choice, Best Seller...)
  cell.badges = (p.ownBadges || []).length ? p.ownBadges : null;

  // ToS: CHỈ của ASIN chính (biến thể nằm trong float, không trộn vào ô)
  if ((p.tosTotal || 0) > 0 || (p.tosPosition || 0) > 0) {
    cell.tos = `${p.tosPosition}/${p.tosTotal}`;
    cell.tosPos = p.tosPosition || 0;
  }

  // Chi tiết biến thể — ASIN ĐẦY ĐỦ, hiển thị dạng float khi hover (không chiếm chỗ ô chính)
  cell.variants = (x.variants || [])
    .filter((v) => v.organicRank !== null || (v.tosPosition || 0) > 0 || v.rosPresent)
    .map((v) => ({
      asin: v.asin,
      organic: v.organicRank !== null ? `Page ${v.organicPage} No ${v.organicPosInPage}` : null,
      tos: (v.tosPosition || 0) > 0 ? `${v.tosPosition}/${v.tosTotal}` : null,
      ros: !!v.rosPresent,
      badges: (v.ownBadges || []).length ? v.ownBadges : null
    }));
  cell.hasVariantRank = cell.variants.some((v) => v.organic);

  // RoS (mọi sponsored ngoài ToS page 1, gồm cả ads đầu trang 2/3)
  const rosParts = [];
  if (p.rosPresent) rosParts.push(`✓ p${Object.keys(p.rosDetail || {}).join(",p") || "?"}`);
  if ((x.variants || []).some((v) => v.rosPresent)) rosParts.push("var ✓");
  cell.ros = rosParts.join(" · ") || null;

  return cell;
}

/* ===== Nhận diện nhóm nguồn có mặt trong 1 ô metrics (asin-metrics.json gộp ads + business) ===== */
function hasAds(m) {
  return !!m && (m.spent != null || m.impressions != null || m.clicks != null || m.salesAds != null || m.ordersAds != null);
}
function hasBusiness(m) {
  return !!m && (m.salesTotal != null || m.units != null || m.sessions != null);
}

/* ===== Rank summary theo ngày cho 1 ASIN (lấy lần check CUỐI trong ngày) ===== */
function rankByDateFor(asin) {
  const runs = store.listRunResults().filter((r) => r.asin === asin)
    .sort((a, b) => (a.checkedAt < b.checkedAt ? -1 : 1));
  const out = {};
  for (const meta of runs) {
    const run = store.getRunResult(meta.id);
    if (run) out[String(run.checkedAt || "").slice(0, 10)] = summarize(run);
  }
  return out;
}

/**
 * Bảng hợp nhất theo ngày cho 1 ASIN: 1 dòng = 1 ngày, gom nhóm Ads / Business / Inventory / Ranking.
 * Tôn trọng quy ước #N/A (thiếu file) / 0 (thật) / - (có file, thiếu dữ liệu) qua các cờ hasXxxFile.
 * @returns {{ asin, days: Array }}
 */
export function buildAsinDaily(asin, { from, to } = {}) {
  const A = String(asin).toUpperCase();
  const metricsByDate = store.getAsinMetrics(A);   // { date: {spent, salesAds, salesTotal, units, sessions...} }
  const invByDate = store.getInventory(A);         // { date: {unitsAvailable, inbound, reserved, daysOfSupply} }
  const rankByDate = rankByDateFor(A);

  let dates = [...new Set([...Object.keys(metricsByDate), ...Object.keys(invByDate), ...Object.keys(rankByDate)])].sort();
  if (from) dates = dates.filter((d) => d >= from);
  if (to) dates = dates.filter((d) => d <= to);

  const days = dates.map((d) => {
    const m = metricsByDate[d] || null;
    const inv = invByDate[d] || null;
    const adsFile = hasAds(m);
    const bizFile = hasBusiness(m);

    const imp = adsFile ? (m.impressions ?? 0) : null;
    const clicks = adsFile ? (m.clicks ?? 0) : null;
    const spent = adsFile ? (m.spent ?? 0) : null;
    const salesAds = adsFile ? (m.salesAds ?? 0) : null;
    const orders = adsFile ? (m.ordersAds ?? 0) : null;

    const salesTotal = bizFile ? (m.salesTotal ?? null) : null;
    const units = bizFile ? (m.units ?? null) : null;
    const sessions = bizFile ? (m.sessions ?? null) : null;

    return {
      date: d,
      hasAdsFile: adsFile,
      hasBusinessFile: bizFile,
      hasInventoryFile: !!inv,
      // ===== Ads =====
      impressions: imp,
      clicks,
      ctr: imp > 0 ? round2((clicks / imp) * 100) : (adsFile ? 0 : null),          // %
      cpc: clicks > 0 ? round2(spent / clicks) : (adsFile ? 0 : null),
      spent,
      ordersAds: orders,
      salesAds,
      cr: clicks > 0 ? round2((orders / clicks) * 100) : (adsFile ? 0 : null),     // %
      acos: salesAds > 0 ? round2((spent / salesAds) * 100) : null,                // % (null = ∞ khi spent>0)
      // ===== Business =====
      salesTotal,
      units,
      sessions,
      tacos: salesTotal > 0 ? round2((spent ?? 0) / salesTotal * 100) : null,      // %
      cvr: (sessions > 0 && units != null) ? round2((units / sessions) * 100) : null, // % đơn/lượt truy cập
      // ===== Inventory =====
      unitsAvailable: inv ? (inv.unitsAvailable ?? null) : null,
      inbound: inv ? (inv.inbound ?? null) : null,
      reserved: inv ? (inv.reserved ?? null) : null,
      daysOfSupply: inv ? (inv.daysOfSupply ?? null) : null,
      // ===== Ranking =====
      rank: rankByDate[d] || null
    };
  });

  return { asin: A, days };
}
