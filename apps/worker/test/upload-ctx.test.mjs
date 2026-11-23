// multer + AsyncLocalStorage: file upload lớn làm handler chạy NGOÀI phân vùng user → đọc nhầm dữ liệu
// gốc (lỗi thật 23/11/2026 ở Lọc Bulk). keepUserCtx phải giữ được user dù file 8MB.
import express from "express";
import multer from "multer";
import fs from "fs";
import os from "os";
import path from "path";
import { runAsUser, currentUser } from "../src/db/user-context.js";
import { keepUserCtx } from "../src/upload-ctx.js";

let ok = 0, bad = 0;
const t = (n, c, x = "") => { c ? ok++ : bad++; console.log(`${c ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upctx-"));
const app = express();
app.use((req, res, next) => runAsUser({ name: "khanh" }, next));
const raw = multer({ dest: dir }), kept = keepUserCtx(multer({ dest: dir }));
const who = (req, res) => { if (req.file) fs.rmSync(req.file.path, { force: true }); res.json({ user: currentUser()?.name || null, body: req.body?.f || "" }); };
app.post("/raw", raw.single("file"), who);
app.post("/kept", kept.single("file"), who);
const srv = app.listen(0);
const url = `http://127.0.0.1:${srv.address().port}`;

const send = async (route, size) => {
  const fd = new FormData();
  fd.append("f", "Shinavie");
  fd.append("file", new Blob([Buffer.alloc(size, 65)]), "b.xlsx");
  return (await fetch(url + route, { method: "POST", body: fd })).json();
};
try {
  const big = await send("/raw", 8 * 1024 * 1024);
  console.log(`  (multer gốc, file 8MB: user = ${big.user})`); // tái hiện lỗi — chỉ để ghi nhận, tuỳ phiên bản node
  for (const size of [1000, 8 * 1024 * 1024]) {
    const r = await send("/kept", size);
    t(`keepUserCtx giữ user với file ${size > 1e6 ? "8MB" : "1KB"}`, r.user === "khanh", JSON.stringify(r));
    t(`field form vẫn đọc được (${size > 1e6 ? "8MB" : "1KB"})`, r.body === "Shinavie");
  }
} finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }

console.log(`${ok}/${ok + bad} đạt`);
process.exit(bad ? 1 : 0);
