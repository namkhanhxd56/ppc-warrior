// run.mjs — chạy toàn bộ kiểm thử: `npm test`
// Không dùng framework ngoài: chỉ cần node. Mỗi file test tự in ✓/✗ và thoát 1 nếu có lỗi.
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const dir = path.dirname(fileURLToPath(import.meta.url)); // KHÔNG dùng .pathname: dấu cách trong đường dẫn thành %20
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs")).sort();
let bad = 0;
for (const f of files) {
  console.log(`\n━━━ ${f} ━━━`);
  // AGENT_NO_RUN: nạp agent.js để lấy hàm mà KHÔNG khởi động vòng poll
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    stdio: "inherit", env: { ...process.env, AGENT_NO_RUN: "1" }, cwd: path.join(dir, "..")
  });
  if (r.status !== 0) bad++;
}
console.log(bad ? `\n🚨 ${bad}/${files.length} file test THẤT BẠI` : `\n✅ ${files.length}/${files.length} file test đạt`);
process.exit(bad ? 1 : 0);
