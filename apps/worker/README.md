# PPC Warrior — Worker Check Ranking (chạy local)

Tool check ranking phiên bản mới, thay thế check-ranking-amazon-v7. Chạy hoàn toàn trên máy bạn, chưa cần DB online (kết quả lưu file JSON trong `./data/`).

## Cài đặt & chạy

```bash
cd ppc-warrior/apps/worker
npm install
# Copy cookies từ tool cũ (giữ zip code):
cp ../../../check-ranking-amazon-v7/cookies.json ./cookies.json
npm start
# Mở http://localhost:3100
```

## Tính năng

- **Trường nhập tạm** (ASIN + keywords) — sẽ ẩn khi đồng bộ với kho keyword tag "PPC"
- Check **nhóm biến thể** parent/child tự động (cache 7 ngày), lưu toàn bộ ASIN con có rank
- Kết quả đầy đủ: Organic (Page X No Y + rank toàn cục + rank "sạch" loại Previously-viewed), ToS x/y, khối đầu trang 2/3, RoS, Video, SB banner, SP carousel
- **Bảng theo dõi ngày × keyword** màu xanh/đỏ như Google Sheet cũ
- Phiên sạch chống personalization (không userDataDir, lọc cookie đăng nhập)
- Chống bot-check: tự nhận diện + retry; export CSV

## Cấu trúc

```
server.js               # Express + API (port 3100)
public/index.html       # UI
src/
├── parser/serp-parser.js      # Phân loại slot SERP (đã verify 8 fixture thật)
├── parser/rank-aggregator.js  # Gộp đa trang, offset kép, variants
├── scraper/browser.js         # Puppeteer phiên sạch + cookies zip
├── scraper/variant-resolver.js# Trích parent/child từ product page (⚠ cần verify HTML thật)
├── jobs/run-batch.js          # Chạy tuần tự, giải phóng bộ nhớ từng keyword
└── db/file-store.js           # Lưu JSON — sau thay pg-store.js cùng interface
test-fixtures/          # HTML + slots thật để regression test parser
```

## Chống Amazon từ chối serve ads (ToS "?") — cấu hình trong `.env`

| Biến | Tác dụng |
|---|---|
| `CHROME_CHANNEL=chrome` | Dùng Google Chrome THẬT trên máy (fingerprint thật) thay vì Chromium bundled |
| `HEADFUL=1` | Chrome chạy CÓ GIAO DIỆN nhưng cửa sổ ngoài màn hình — "chạy ngầm", giảm mạnh detect (headless là dấu hiệu bot lớn nhất) |
| `WORKER_PROFILE=1` | Profile riêng bền vững (`./data/chrome-profile`) — phiên có tuổi thọ, Amazon tin hơn. Nghi profile bẩn (nhiều ⚠PV) → xóa thư mục này để làm mới |
| `BLOCK_ASSETS=1` | Chặn tải image/media/font (nhanh hơn, tốn ít băng thông) — ⚠️ mặc định TẮT vì không tải ảnh là tín hiệu bot mạnh |

Stealth (từ 16/07/2026): dùng `puppeteer-extra-plugin-stealth` (16 evasion: webdriver, chrome.runtime, WebGL, codec, plugins...); KHÔNG giả UA (UA giả lệch Sec-CH-UA headers = tự tố bot); viewport theo cửa sổ thật.

⚠️ Không dùng profile Chrome cá nhân đang đăng nhập — lịch sử xem sản phẩm gây badge "Previously viewed" làm méo rank (lỗi tool v7 cũ). Ba lớp bảo vệ khi vẫn bị từ chối serve: reload kiểm chứng từng trang → quét bù cuối batch → hiển thị `?` thay vì ghi 0/0 sai.

## Kiến trúc team: Server trung tâm + Agent máy cá nhân (Phương án A)

```
┌──────────────────────┐   xếp job    ┌──────────────────────────────┐
│ SERVER (Railway)     │ ──────────►  │ AGENT (máy mỗi thành viên)   │
│ RUN_MODE=queue       │              │ npm run agent                │
│ UI team + hàng đợi   │ ◄──────────  │ Chrome chạy ngầm, IP dân cư  │
│ + lưu kết quả        │  đẩy kết quả │ + cookies riêng từng người   │
└──────────────────────┘              └──────────────────────────────┘
```

- Team mở UI trên Railway: nhập keyword, bấm Kiểm tra → job vào hàng đợi; đặt lịch daily → scheduler xếp job đúng giờ
- Agent trên máy cá nhân poll 15s/lần, kéo job về chạy ngầm (Chrome cửa sổ ngoài màn hình), đẩy kết quả lên server — cả team xem chung
- Máy tắt → job chờ trên server, mở máy agent tự chạy bù; job mất heartbeat >5 phút tự trả lại
  hàng đợi kèm ĐÚNG phần keyword còn thiếu (không quét trùng). Hàng đợi single-flight: chỉ 1 job
  chạy tại một thời điểm, và mỗi lượt bấm Run giữ hàng đợi tới khi xếp hết (⏹ Dừng để nhả).
- Scrape bằng IP dân cư thật của từng người — chống detect tốt hơn mọi loại server/proxy

**Cài agent trên máy thành viên** — 1 lệnh, không cần git, không lưu mật khẩu.
Lấy lệnh sẵn token ở UI: mục **🛰 Agent** → *Tạo token*.
```bash
curl -fsSL https://xxx.up.railway.app/setup-agent.sh | bash -s -- https://xxx.up.railway.app <TOKEN>
cd ~/ppc-warrior-agent && npm run agent   # để cửa sổ Terminal chạy nền
```
Script tự tải bundle từ chính server, `npm install`, và ghi `.env`
(`SERVER_URL` / `AGENT_TOKEN` / `AGENT_NAME` / `HEADFUL=0` / `CHROME_CHANNEL=chrome` / `WORKER_PROFILE=1`).
Token gắn với tài khoản người dùng và thu hồi được ở UI. Cập nhật agent = chạy lại đúng lệnh trên.

## Quên mật khẩu đăng nhập

Mật khẩu lưu bằng scrypt + salt nên không ai đọc lại được, kể cả admin. Khôi phục bằng biến
môi trường — cố ý KHÔNG làm endpoint HTTP để không mở thêm cửa tấn công nào ra internet:

1. Railway → **Variables** → thêm `ADMIN_RESET=ten_dang_nhap:mat_khau_moi`
   (mật khẩu ≥ 6 ký tự, được phép chứa dấu `:` — chỉ tách ở dấu hai chấm ĐẦU TIÊN)
2. Railway tự khởi động lại → xem tab **Deploy Logs**, phải thấy `🔑 ADMIN_RESET: đã đặt lại…`
   (gõ sai tên đăng nhập thì log liệt kê các tên đang có)
3. Đăng nhập bằng mật khẩu mới
4. **XOÁ biến `ADMIN_RESET` đi** — để nguyên thì mỗi lần khởi động lại mật khẩu bị đặt lại về
   giá trị đó

Mọi phiên đăng nhập cũ của tài khoản đó bị huỷ, các tài khoản khác không bị ảnh hưởng.

## Triển khai lên Railway

Đã có sẵn `Dockerfile` (Node 20 + Chrome thật + xvfb headful) — Railway tự nhận và build.

1. Đẩy code lên GitHub → Railway: **New Project → Deploy from GitHub repo**
2. **Settings → Root Directory** = `ppc-warrior/apps/worker` (nếu repo là cả dự án)
3. **BẮT BUỘC — Volume**: right-click service → Attach Volume → mount path **`/app/data`**
   (toàn bộ kết quả, daily-rank, cookies, chrome-profile nằm đây — không gắn là MẤT SẠCH mỗi lần deploy)
4. **Variables**: `RUN_MODE=queue` (server chỉ chạy UI + hàng đợi, KHÔNG mở Chrome — agent trên máy cá nhân quét)
5. **Settings → Region**: chọn **US West/US East**
6. **Settings → Networking → Generate Domain** → mở `https://xxx.up.railway.app`
   → đăng ký tài khoản đầu tiên (tài khoản này là admin, sở hữu dữ liệu gốc), rồi vào UI đặt zip code.
   Người sau vào bằng **mã mời** do admin cấp; mỗi người có phân vùng dữ liệu riêng.
   (`WORKER_PASSWORD` chỉ còn là cơ chế dự phòng cho bản cũ chưa có tài khoản.)

Vận hành: deploy lại = push git; log xem trong tab Deployments. Lịch daily chạy 24/7.
⚠️ Lưu ý thật: IP Railway là IP datacenter (Google Cloud) — tốt hơn hẳn IP Việt Nam về location/ads,
nhưng nếu tỷ lệ ToS "?" vẫn cao thì bước kế tiếp là gắn residential proxy (sẽ làm khi cần).

## Triển khai lên VPS thường (khuyến nghị VPS đặt tại Mỹ)

VPS ở Mỹ = IP Mỹ thật → location chuẩn US sẵn, Amazon serve ads bình thường hơn hẳn máy VN.

```bash
# 1. Copy thư mục ppc-warrior/apps/worker lên VPS (scp/git), rồi:
cd worker
bash setup-vps.sh          # tự cài Node 20 + Chrome + xvfb + pm2, chạy nền luôn

# 2. Đặt mật khẩu UI (bắt buộc nếu mở port ra internet):
echo "WORKER_PASSWORD=matkhau-cua-ban" >> .env && pm2 restart ppc-worker

# 3. Mở UI từ máy của bạn — 1 trong 2 cách:
#    a) http://IP_VPS:3100  (user gõ gì cũng được, password = WORKER_PASSWORD)
#    b) An toàn hơn — SSH tunnel, không cần mở port:
ssh -L 3100:localhost:3100 user@IP_VPS   # rồi mở http://localhost:3100
```

Vận hành: `pm2 logs ppc-worker` (xem log) · `pm2 restart ppc-worker` (sau khi sửa code/.env) · lịch daily chạy 24/7 vì VPS luôn bật — hết cảnh báo "máy phải bật". HEADFUL=1 vẫn hoạt động nhờ màn hình ảo xvfb (`npm run start:vps`). Nhớ vào UI đặt zip code sau lần chạy đầu.

## Khi nào cần cập nhật cookies
Log báo "Session lỗi/captcha" → mở Chrome thật, vào amazon.com đặt đúng zip (10011), export cookies (extension Cookie-Editor), dán vào ô Cookies trên UI.
