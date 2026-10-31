/* nav.js — THANH ĐIỀU HƯỚNG + CHIP TÀI KHOẢN DÙNG CHUNG cho mọi trang.
   Trước đây mỗi trang tự chép lại danh sách menu nên chúng trôi dạt mỗi nơi một kiểu:
   trang Tài khoản thiếu hẳn Danh mục / Phân tích Keyword / Data, còn chip tài khoản ở góc
   phải thì chỉ trang Check Ranking mới có. Thêm trang mới giờ chỉ sửa mảng PAGES dưới đây. */
(function () {
  const PAGES = [
    ["/", "📊 Check Ranking"],
    ["/catalog.html", "📋 Danh mục Tài sản"],
    ["/kwlists.html", "🗂 Danh mục Target"],
    ["/keywords.html", "🔑 Phân tích Keyword"],
    ["/launching.html", "🚀 Tạo Campaign"],
    ["/bulk.html", "📦 Bulk Create"],
    ["/adjust.html", "⚙️ Điều chỉnh Campaign"],
    ["/data.html", "📈 Data"]
  ];
  const header = document.querySelector("header");
  if (!header) return;
  const here = location.pathname === "/index.html" ? "/" : location.pathname;

  function renderNav() {
    let nav = header.querySelector("nav");
    if (!nav) { nav = document.createElement("nav"); header.insertBefore(nav, header.children[1] || null); }
    nav.removeAttribute("hidden"); // trang Tài khoản để sẵn hidden cho tới khi biết đã đăng nhập
    nav.style.cssText = "display:flex;gap:4px;margin-left:10px;flex-wrap:wrap";
    /* Style nội tuyến chứ KHÔNG dựa vào CSS của từng trang: mỗi trang một bộ class riêng,
       bám vào đó thì menu lại mỗi nơi một kiểu — đúng lỗi vừa phải sửa. */
    nav.innerHTML = PAGES.map(([href, label]) => {
      const on = href === here;
      return `<a href="${href}" data-on="${on}" style="text-decoration:none;font-size:13px;padding:6px 14px;`
        + `border-radius:8px;white-space:nowrap;${on ? "color:#fff;background:#2455e6;font-weight:600" : "color:#9fb0c8"}">${label}</a>`;
    }).join("");
    nav.querySelectorAll('a[data-on="false"]').forEach((a) => {
      a.onmouseenter = () => { a.style.background = "#1d2739"; };
      a.onmouseleave = () => { a.style.background = ""; };
    });
  }

  function addChip(me) {
    /* Chip luôn nằm CUỐI header, trên mọi trang. Trang Check Ranking có sẵn #status mang
       margin-left:auto nên chip chỉ cần cách ra; trang khác thì chip tự đẩy sang phải. */
    const st = document.getElementById("status");
    // Dọn sạch chip cũ trước khi gắn: trang nào còn sót đoạn tự dựng chip thì cũng chỉ còn
    // lại MỘT cái. (Đã dính thật: adjust/data/launching giữ bản chép riêng → hiện 2 chip.)
    header.querySelectorAll('a[href="/user"]').forEach((e) => e.remove());
    const chip = document.createElement("a");
    chip.href = "/user";
    chip.title = "Tài khoản · agent · đăng xuất";
    chip.style.cssText = (st ? "margin-left:12px" : "margin-left:auto")
      + ";font-size:12px;text-decoration:none;color:#fff;font-weight:700;border-radius:9px;padding:3px 12px;background:"
      + (me.user.role === "admin" ? "#e5a400" : "#2455e6");
    chip.textContent = "👤 " + me.user.name + (me.actAs && me.actAs !== me.user.name ? " → 📁" + me.actAs : "");
    header.appendChild(chip);
  }

  // Hỏi trước rồi mới vẽ: vẽ ngay thì màn hình đăng nhập loé lên cả thanh menu rồi mới mất
  fetch("/api/auth/me").then((r) => r.json()).catch(() => ({}))
    .then((me) => {
      if (me.user || !me.hasUsers) renderNav();   // chưa đăng nhập mà hệ thống có user: giấu menu
      if (me.user) addChip(me);                   // chế độ local 1 người: không có chip
    });
})();
