// evaluate.js — Module DATA: tín hiệu đánh giá kết quả từ bảng hợp nhất theo ngày.
//
// Đầu vào = days[] từ consolidate.buildAsinDaily. Trả các chip {level, code, message, value}
// để UI tô màu (ok/warn/crit) — giúp user "sắp xếp lại và đánh giá được kết quả".

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => "$" + round2(n).toFixed(2);

/**
 * @param {Array} days - days[] từ buildAsinDaily (đã lọc khoảng ngày nếu cần)
 * @param {object} opts - { targetAcos %, lowStockWarn=14, lowStockCrit=7, trendWindow=7 }
 * @returns {{ signals, period, latest }}
 */
export function evaluateAsin(days, opts = {}) {
  const targetAcos = opts.targetAcos ?? null;         // % (vd 40)
  const lowWarn = opts.lowStockWarn ?? 14;
  const lowCrit = opts.lowStockCrit ?? 7;
  const win = opts.trendWindow ?? 7;
  const signals = [];

  const adsDays = days.filter((d) => d.hasAdsFile);
  const bizDays = days.filter((d) => d.hasBusinessFile);
  const invDays = days.filter((d) => d.hasInventoryFile);

  // ===== Tổng hợp kỳ =====
  const sum = (arr, f) => arr.reduce((n, d) => n + (d[f] || 0), 0);
  const spend = round2(sum(adsDays, "spent"));
  const salesAds = round2(sum(adsDays, "salesAds"));
  const orders = sum(adsDays, "ordersAds");
  const clicks = sum(adsDays, "clicks");
  const imp = sum(adsDays, "impressions");
  const salesTotal = round2(sum(bizDays, "salesTotal"));
  const units = sum(bizDays, "units");

  const acos = salesAds > 0 ? round2((spend / salesAds) * 100) : (spend > 0 ? Infinity : null);
  const tacos = salesTotal > 0 ? round2((spend / salesTotal) * 100) : null;
  const period = {
    days: days.length, spend, salesAds, orders, clicks, impressions: imp,
    ctr: imp > 0 ? round2((clicks / imp) * 100) : null,
    cr: clicks > 0 ? round2((orders / clicks) * 100) : null,
    acos: acos === Infinity ? null : acos, acosInf: acos === Infinity,
    salesTotal, units, tacos
  };
  const latest = days.length ? days[days.length - 1] : null;

  // ===== 1. ACoS vs target =====
  if (acos === Infinity) {
    signals.push({ level: "crit", code: "acos_inf", value: null,
      message: `Đốt tiền: chi ${money(spend)} nhưng 0 sale ads trong kỳ` });
  } else if (targetAcos != null && acos != null) {
    if (acos > targetAcos * 1.5) signals.push({ level: "crit", code: "acos_high", value: acos,
      message: `ACoS kỳ ${acos}% > 1.5× target (${targetAcos}%)` });
    else if (acos > targetAcos) signals.push({ level: "warn", code: "acos_over", value: acos,
      message: `ACoS kỳ ${acos}% > target ${targetAcos}%` });
    else signals.push({ level: "ok", code: "acos_ok", value: acos,
      message: `ACoS kỳ ${acos}% ≤ target ${targetAcos}%` });
  } else if (acos != null) {
    signals.push({ level: "ok", code: "acos", value: acos, message: `ACoS kỳ ${acos}% (chưa đặt target)` });
  }

  // ===== 2. Ngày đốt tiền (spend > 0, 0 sale ads) =====
  const burnDays = adsDays.filter((d) => (d.spent || 0) > 0 && (d.salesAds || 0) === 0);
  if (burnDays.length) {
    const wasted = round2(burnDays.reduce((n, d) => n + d.spent, 0));
    signals.push({ level: burnDays.length >= 3 ? "crit" : "warn", code: "burn_days", value: burnDays.length,
      message: `${burnDays.length} ngày có spend nhưng 0 sale ads (tốn ${money(wasted)})` });
  }

  // ===== 3. Tồn kho (days of supply) =====
  const lastInv = invDays.length ? invDays[invDays.length - 1] : null;
  if (lastInv) {
    let dos = lastInv.daysOfSupply;
    // Không có sẵn → ước từ tốc độ bán (units/ngày trong kỳ)
    if (dos == null && lastInv.unitsAvailable != null && bizDays.length) {
      const avgDaily = units / bizDays.length;
      if (avgDaily > 0) dos = round2(lastInv.unitsAvailable / avgDaily);
    }
    if (dos != null) {
      if (dos < lowCrit) signals.push({ level: "crit", code: "stock_crit", value: dos,
        message: `Sắp hết hàng: còn ~${dos} ngày tồn (tồn ${lastInv.unitsAvailable ?? "?"})` });
      else if (dos < lowWarn) signals.push({ level: "warn", code: "stock_warn", value: dos,
        message: `Tồn thấp: còn ~${dos} ngày (tồn ${lastInv.unitsAvailable ?? "?"})` });
      else signals.push({ level: "ok", code: "stock_ok", value: dos, message: `Tồn kho ~${dos} ngày` });
    }
  }

  // ===== 4. TACoS trend (nửa đầu vs nửa cuối cửa sổ) =====
  const tw = bizDays.filter((d) => (d.salesTotal || 0) > 0);
  if (tw.length >= 4) {
    const recent = tw.slice(-win);
    const half = Math.floor(recent.length / 2);
    const tacosOf = (arr) => {
      const sp = arr.reduce((n, d) => n + (d.spent || 0), 0);
      const st = arr.reduce((n, d) => n + (d.salesTotal || 0), 0);
      return st > 0 ? (sp / st) * 100 : null;
    };
    const a = tacosOf(recent.slice(0, half)), b = tacosOf(recent.slice(half));
    if (a != null && b != null) {
      const delta = round2(b - a);
      if (delta > 2) signals.push({ level: "warn", code: "tacos_up", value: delta,
        message: `TACoS tăng +${delta}đ% (phụ thuộc ads tăng)` });
      else if (delta < -2) signals.push({ level: "ok", code: "tacos_down", value: delta,
        message: `TACoS giảm ${delta}đ% (organic mạnh lên)` });
    }
  }

  // ===== 5. Biến động rank (ToS/p1 đầu vs cuối kỳ) =====
  const rk = days.filter((d) => d.rank);
  if (rk.length >= 2) {
    const first = rk[0].rank, last = rk[rk.length - 1].rank;
    const dTos = (last.tos || 0) - (first.tos || 0);
    if (dTos > 0) signals.push({ level: "ok", code: "rank_up", value: dTos,
      message: `Số keyword vào ToS tăng +${dTos}` });
    else if (dTos < 0) signals.push({ level: "warn", code: "rank_down", value: dTos,
      message: `Số keyword vào ToS giảm ${dTos}` });
  }

  return { signals, period, latest };
}
