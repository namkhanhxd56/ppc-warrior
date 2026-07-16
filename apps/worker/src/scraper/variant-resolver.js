// variant-resolver.js — Phát hiện nhóm parent/child của 1 ASIN
//
// Flow: cache DB trước (biến thể ít thay đổi) → miss thì mở product page 1 lần → trích + lưu DB
// ⚠️ Các marker dưới đây là kiến thức chung về product page Amazon — CẦN XÁC MINH bằng
//    HTML thật (save product page của 1 ASIN có biến thể) trước khi tin dùng, giống cách đã làm với SERP.

const VARIANT_CACHE_TTL_DAYS = 7;

/**
 * Trích parent + child ASINs từ HTML product page.
 * Nguồn dữ liệu trong trang (thứ tự ưu tiên):
 * 1. Script twister: "parentAsin":"B0XXXXXXXX" + dimensionValuesDisplayData = {"B0child1":[...], ...}
 * 2. dataToReturn / twisterController variationValues
 * 3. Không có twister → ASIN đứng một mình (không có biến thể)
 */
export function extractVariantsFromProductPage(html, asin) {
  const result = { asin, parentAsin: null, childAsins: [], hasVariants: false };

  // Marker 1: parentAsin trong script twister
  const pm = html.match(/"parentAsin"\s*:\s*"([A-Z0-9]{10})"/);
  if (pm) result.parentAsin = pm[1];

  // Marker 2: dimensionValuesDisplayData — keys là toàn bộ child ASIN của nhóm
  const dm = html.match(/"dimensionValuesDisplayData"\s*:\s*(\{.*?\})\s*,\s*"/s);
  if (dm) {
    try {
      const obj = JSON.parse(dm[1]);
      result.childAsins = Object.keys(obj).filter((a) => /^[A-Z0-9]{10}$/.test(a));
    } catch {
      // JSON lồng phức tạp → fallback: quét key dạng ASIN trong đoạn match
      result.childAsins = [...new Set((dm[1].match(/"([A-Z0-9]{10})"\s*:/g) || [])
        .map((s) => s.slice(1, 11)))];
    }
  }

  result.hasVariants = result.childAsins.length > 1 || !!result.parentAsin;
  if (result.hasVariants && !result.childAsins.includes(asin)) result.childAsins.push(asin);
  return result;
}

/**
 * Resolve nhóm biến thể (cache-first).
 * @param {object} db   - client DB (bảng products: asin, parent_asin, variants_checked_at)
 * @param {object} page - Puppeteer page (chỉ dùng khi cache miss)
 */
export async function resolveVariants(db, page, asin, projectId) {
  // 1. Cache DB
  const cached = await db.getProductVariants(projectId, asin); // {parentAsin, childAsins, checkedAt}
  if (cached && daysSince(cached.checkedAt) < VARIANT_CACHE_TTL_DAYS) {
    return { ...cached, fromCache: true };
  }

  // 2. Mở product page 1 lần
  await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  const html = await page.content();
  const v = extractVariantsFromProductPage(html, asin);

  // 3. Lưu DB cho các lần sau
  await db.saveProductVariants(projectId, asin, v.parentAsin, v.childAsins);
  return { ...v, fromCache: false };
}

function daysSince(d) {
  return (Date.now() - new Date(d).getTime()) / 86400000;
}
