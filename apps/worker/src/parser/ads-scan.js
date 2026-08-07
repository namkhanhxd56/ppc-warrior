// ads-scan.js — MODULE QUÉT ADS (ToS/RoS): gom mọi hành vi chỉ-phục-vụ-ads vào một chỗ
//
// Vì sao tách riêng: trước đây logic ads nằm rải trong run-batch (số lượt load, chờ nhãn
// Sponsored, thời gian chờ ads inject, lượt quét bù cuối ASIN). Muốn tắt quét ads để chạy
// nhanh thì phải sửa 4-5 chỗ và rất dễ bỏ sót — thực tế bản trước tắt adsScan vẫn còn chờ
// nhãn Sponsored 3 giây mỗi trang (vô ích vì không dùng số liệu ads).
//
// Bật/tắt bằng cờ adsScan theo TỪNG ASIN (⚙️ trên bảng theo dõi, mặc định BẬT).
//
// KHI TẮT thì bỏ đúng 4 thứ — không đụng gì tới organic rank:
//   1. Không reload kiểm chứng khi trang ra 0 SP tile (2 lượt load → 1)
//   2. Không chờ nhãn Sponsored render (tiết kiệm tới 3s/trang khi trang không có ads)
//   3. Chờ ads inject sau khi cuộn: 1200ms → 300ms
//   4. Không chạy lượt quét bù cuối ASIN
// Organic rank vẫn chính xác vì kết quả organic nằm sẵn trong HTML server trả về.
//
// Đánh đổi khi tắt: cột ToS/RoS sẽ ra "?" ở những keyword mà lượt load duy nhất không thấy
// SP tile — nghĩa là "không kết luận được", KHÔNG phải "không có ads".

const SPONSORED_LABEL_SEL = ".puis-sponsored-label-text";

/** Cấu hình 1 lượt quét theo cờ adsScan. Mọi chỗ khác chỉ đọc object này, không tự suy diễn. */
export function adsMode(adsScan) {
  const on = adsScan !== false; // mặc định BẬT
  return {
    on,
    maxLoads: on ? 2 : 1,        // lượt load tối đa mỗi trang (lượt 2 = reload kiểm chứng)
    labelWaitMs: on ? 3000 : 0,  // chờ nhãn Sponsored xuất hiện
    settleMs: on ? 1200 : 300,   // chờ sau khi cuộn để ads inject xong
    retrySweep: on,              // lượt quét bù keyword bị "?" ở cuối ASIN
    label: on ? "" : " · KHÔNG quét ads"
  };
}

/** Đếm SP tile trong 1 trang đã parse. */
export const countSpTiles = (slots) => (slots || []).filter((s) => s.type === "SP_TILE").length;

/** Cả ASIN/keyword có được Amazon serve ads không (≥1 SP tile trên mọi trang đã quét).
 *  false ⇒ ToS/RoS ghi "?" thay vì 0/0 giả. */
export const adsServed = (pagesSlots) => (pagesSlots || []).some((slots) => countSpTiles(slots) > 0);

/** Keyword cần quét bù: đã quét xong, không lỗi, nhưng không thấy SP tile nào. */
export const needsAdsRetry = (r) => !!r && !r.error && r.adsTilesServed === false;

/** Chờ trang render đủ để đọc được ads + cuộn cho widget lazy-load (video/SB/carousel).
 *  Tắt ads: bỏ hẳn bước chờ nhãn Sponsored, rút ngắn thời gian chờ sau cuộn. */
export async function waitForRender(page, mode) {
  if (mode.labelWaitMs > 0) {
    // Ads inject bất đồng bộ sau domcontentloaded; không thấy sau ngần này = trang thật sự
    // không được serve tile, đi tiếp chứ không chờ thêm.
    try { await page.waitForSelector(SPONSORED_LABEL_SEL, { timeout: mode.labelWaitMs }); } catch {}
  }
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const t = setInterval(() => {
        window.scrollBy(0, 700);
        y += 700;
        if (y >= document.body.scrollHeight) { clearInterval(t); resolve(); }
      }, 120);
    });
    window.scrollTo(0, 0); // về đầu trang — khối ToS render/ổn định lại
  });
  await new Promise((r) => setTimeout(r, mode.settleMs));
}

/** Có nên reload kiểm chứng trang này không (chống ToS 0/0 giả). */
export const shouldVerifyReload = (mode, load, spTiles) => mode.on && load === 1 && spTiles === 0;
