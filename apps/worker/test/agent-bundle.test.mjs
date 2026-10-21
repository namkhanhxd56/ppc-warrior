// Gói cài agent (/agent-bundle.tgz) phải chứa ĐỦ mọi file mà agent.js import — kể cả import
// lồng nhau. Thiếu một file thì máy cài agent chạy tới lúc khởi động mới chết với
// ERR_MODULE_NOT_FOUND, mà lỗi ấy chỉ hiện trên máy đó: bên này không hề hay biết.
import fs from "fs";
import path from "path";

let ok = 0, bad = 0;
const t = (n, c, x = "") => { c ? ok++ : bad++; console.log(`${c ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`); };

// Danh sách file server đem đóng gói, đọc thẳng từ lệnh tar trong server.js
const srv = fs.readFileSync("server.js", "utf8");
const m = srv.match(/spawn\("tar",\s*\[([\s\S]*?)\]\)/);
t("đọc được danh sách đóng gói trong server.js", !!m);
const entries = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((x) => !["czf", "-"].includes(x));

// Lần theo import từ agent.js, đi sâu vào từng file
const seen = new Set();
const missing = [];
(function walk(file) {
  if (seen.has(file) || !fs.existsSync(file)) return;
  seen.add(file);
  for (const i of fs.readFileSync(file, "utf8").matchAll(/from\s+"(\.[^"]+)"/g)) {
    const dep = path.normalize(path.join(path.dirname(file), i[1]));
    if (!fs.existsSync(dep)) { missing.push(`${file} → ${i[1]} (không có file)`); continue; }
    if (!entries.some((e) => dep === e || dep.startsWith(e + path.sep))) missing.push(`${dep} (import từ ${file})`);
    walk(dep);
  }
})("agent.js");

t(`mọi file agent.js cần đều nằm trong gói (đã lần ${seen.size} file)`, missing.length === 0, missing.join(" · "));
t("có package.json trong gói (npm install trên máy kia cần nó)", entries.includes("package.json"));

console.log(`${ok}/${ok + bad} đạt`);
process.exit(bad ? 1 : 0);
