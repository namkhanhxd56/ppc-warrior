// Khung giao diện (menu + chip tài khoản) phải CHỈ do public/nav.js dựng.
// Lỗi đã dính thật: gom chip về nav.js nhưng chỉ xoá bản cũ trong index.html, còn
// adjust/data/launching vẫn giữ bản chép riêng → mỗi trang đó hiện HAI chip tài khoản.
// Kiểu lỗi này không trang nào báo gì, phải nhìn tận mắt mới thấy — nên để máy canh.
import fs from "fs";

let ok = 0, bad = 0;
const t = (n, c, x = "") => { c ? ok++ : bad++; console.log(`${c ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`); };

const pages = fs.readdirSync("public").filter((f) => f.endsWith(".html"));
t("tìm thấy các trang", pages.length >= 7, pages.join(", "));

const offenders = { chip: [], navLinks: [], script: [], nhieuScript: [] };
for (const f of pages) {
  const h = fs.readFileSync("public/" + f, "utf8");
  if (/chip\.href\s*=\s*['"]\/user/.test(h)) offenders.chip.push(f);
  // Menu viết tay: thẻ <a> trỏ tới trang khác nằm BÊN TRONG <nav> của header
  const nav = h.match(/<nav[^>]*>([\s\S]*?)<\/nav>/);
  if (nav && /<a\s/i.test(nav[1])) offenders.navLinks.push(f);
  const n = (h.match(/src="\/nav\.js"/g) || []).length;
  if (n === 0) offenders.script.push(f);
  if (n > 1) offenders.nhieuScript.push(f);
}

t("không trang nào tự dựng chip tài khoản", offenders.chip.length === 0, offenders.chip.join(", "));
t("không trang nào viết tay danh sách menu", offenders.navLinks.length === 0, offenders.navLinks.join(", "));
t("mọi trang đều nạp /nav.js", offenders.script.length === 0, offenders.script.join(", "));
t("không trang nào nạp /nav.js hai lần", offenders.nhieuScript.length === 0, offenders.nhieuScript.join(", "));

// nav.js phải dọn chip cũ trước khi gắn — phòng khi còn sót một bản chép ở đâu đó
const nav = fs.readFileSync("public/nav.js", "utf8");
t("nav.js dọn chip cũ trước khi gắn chip mới", /querySelectorAll\(['"]a\[href="\/user"\]['"]\)[\s\S]{0,40}remove/.test(nav));

// Hai file dùng chung phải vào được khi CHƯA đăng nhập: chúng nằm trên chính trang đăng nhập
const srv = fs.readFileSync("server.js", "utf8");
const pub = srv.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/)[1];
for (const f of ["/nav.js", "/agent-panel.js"]) t(`${f} được mở công khai`, pub.includes(`"${f}"`));

console.log(`${ok}/${ok + bad} đạt`);
process.exit(bad ? 1 : 0);
