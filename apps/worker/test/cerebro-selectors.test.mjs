// Cách agent NHẬN RA các phần tử trên trang Cerebro, chạy trên trang giả lập dựng theo đúng
// báo cáo mà máy agent gửi về (class của H10 là mã sinh tự động nên không được bám vào class).
import path from "path";
import puppeteer from "puppeteer";
import { markAsinInput, markSubmit, toggleByLabel, clickExport, VISIBLE_ROWS } from "../agent.js";

let ok = 0, bad = 0;
const t = (n, c, x = "") => { c ? ok++ : bad++; console.log(`${c ? "✓" : "✗"} ${n}${x ? " — " + x : ""}`); };

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.goto("file://" + path.resolve("test-fixtures/cerebro-mock.html"), { waitUntil: "domcontentloaded" });

const inp = await markAsinInput(page);
t("tìm đúng ô nhập ASIN, bỏ qua ô Search site và input hidden", /product identifiers/.test(String(inp)), String(inp).slice(0, 40));
await page.click('[data-ppcw="input"]', { clickCount: 3 });
await page.type('[data-ppcw="input"]', "B0991NYY1P, B0FLJY181J", { delay: 1 });
t("gõ được vào ô đó", (await page.$eval('[data-ppcw="input"]', (e) => e.value)) === "B0991NYY1P, B0FLJY181J");

const ev = await toggleByLabel(page, "exclude\\s*variation", true);
t("tìm thấy công tắc Exclude Variations qua chữ bên cạnh", ev.found, JSON.stringify(ev));
t("bật lên đúng trạng thái", (await page.$eval("#ev", (e) => e.checked)) === true);
await toggleByLabel(page, "exclude\\s*variation", true);
t("đã bật sẵn thì không bấm lại (bấm nữa là tắt mất)", (await page.$eval("#ev", (e) => e.checked)) === true);
t("không có công tắc thì báo không tìm thấy, không ném lỗi", (await toggleByLabel(page, "khong\\s*he\\s*co", true)).found === false);

t("bảng còn ẩn → đếm 0 dòng, không tưởng nhầm là đã có kết quả", (await page.evaluate(VISIBLE_ROWS)) === 0,
  "trong DOM đã có " + (await page.evaluate(() => document.querySelectorAll("table tbody tr").length)) + " dòng");

t("tìm đúng nút Get Keywords qua data-testid", (await markSubmit(page)) === "Get Keywords");
await page.click('[data-ppcw="go"]');
await page.waitForFunction(VISIBLE_ROWS + " > 3", { timeout: 5000, polling: 200 });
t("chờ đúng tới lúc bảng kết quả HIỆN ra", (await page.evaluate(VISIBLE_ROWS)) === 4);

const exp = await clickExport(page);
t("tìm được nút Export dù nút không có chữ (chỉ aria-label/title)", exp.clicked, JSON.stringify(exp));
t("chọn tiếp định dạng trong menu con", /csv|xlsx/i.test(String(exp.menu)), String(exp.menu));
t("bấm đúng mục menu, không dính đoạn văn có chữ export/excel", (await page.evaluate(() => window.picked)) === "Export as CSV");

await browser.close();
console.log(`${ok}/${ok + bad} đạt`);
process.exit(bad ? 1 : 0);
