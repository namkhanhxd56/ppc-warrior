# PPC Warrior v1 — Rà soát kiến trúc & định hướng v2

> Phạm vi: toàn bộ `apps/worker` tại commit `69c8b58` (v0.30.2), 11.293 dòng.
> Tài liệu này **chỉ phân tích, không sửa code**.
> Mục tiêu người dùng đặt ra cho v2: *kiến trúc gọn gàng hơn và hiệu năng cao hơn để giải
> quyết bài toán nhiều ASIN, nhiều keyword.*

## 0. Cách đọc tài liệu

Mọi con số trong tài liệu được gắn nhãn nguồn gốc:

| Nhãn | Nghĩa |
|---|---|
| **[đo]** | Tôi chạy đo trên máy này, trên dữ liệu thật, trong lúc viết tài liệu |
| **[đo trước]** | Đo ở phiên làm việc trước, đã ghi lại trong comment code hoặc commit message |
| **[suy ra]** | Ngoại suy từ số **[đo]** — có kèm phép tính để bạn kiểm lại |
| **[giả định]** | Chưa đo được, nêu rõ để bạn xác nhận hoặc bác bỏ |

Phần **§5 Bất cập** xếp theo mức độ **chặn đường mở rộng**, không theo mức độ "xấu code".
Một số chỗ code xấu nhưng vô hại thì xếp cuối; một số chỗ code sạch nhưng chặn cứng khả năng
mở rộng thì xếp đầu.

---

## 1. Ảnh chụp hệ thống v1

### 1.1 Quy mô

| Thành phần | Dòng | Ghi chú |
|---|---:|---|
| `public/launching.html` | 1.781 | UI tạo campaign |
| `server.js` | 1.446 | Express: ~70 endpoint, auth, scheduler, tất cả module |
| `public/index.html` | 1.414 | UI check ranking + bảng theo dõi |
| `public/adjust.html` | 1.150 | UI chỉnh sửa ads |
| `src/db/file-store.js` | 1.070 | Toàn bộ tầng lưu trữ |
| `src/launching/bulk-builder.js` | 806 | Sinh dòng bulk SP/SD/SB |
| `src/adjust/bulk-etl.js` | 400 | ETL + query + xuất Update |
| `src/jobs/run-batch.js` | 358 | Vòng lặp quét 1 ASIN |
| `public/data.html` | 318 | UI import dữ liệu |
| `src/parser/serp-parser.js` | 303 | Parser SERP + tính rank |
| `agent.js` | 259 | Tiến trình chạy trên máy cá nhân |
| còn lại (16 file) | ~1.400 | auth, parser phụ, data, scraper |

Không có test tự động. Có `test-fixtures/` (23 MB, 12 SERP thật) nhưng không có test runner —
việc kiểm chứng parser hiện làm bằng script ad-hoc.

### 1.2 Sơ đồ triển khai

```
┌──────────────────────────────┐        ┌───────────────────────────────┐
│  RAILWAY  (RUN_MODE=queue)   │        │  AGENT (máy cá nhân từng người)│
│                              │◄──poll─┤                               │
│  • Express + UI tĩnh         │  15s   │  • node agent.js              │
│  • Hàng đợi job (jobs.json)  ├──job──►│  • Chrome thật + stealth      │
│  • Toàn bộ dữ liệu (JSON)    │        │  • IP dân cư                  │
│  • KHÔNG mở Chrome           │◄─lô 5──┤  • file-store CỤC BỘ (dự phòng)│
│  • Volume /app/data          │  kw    │                               │
└──────────────────────────────┘        └───────────────────────────────┘
        ▲                                          
        │ HTTP (cookie phiên / x-agent-token)      
   ┌────┴─────┐                                    
   │ Trình duyệt │  ← VÒNG LẶP ĐIỀU PHỐI NẰM Ở ĐÂY (xem B4)
   └──────────┘                                    
```

Ba đặc điểm định hình mọi thứ còn lại:

1. **Server không bao giờ scrape.** IP Railway là datacenter → Amazon không serve ads bình
   thường. Việc quét bắt buộc chạy trên máy cá nhân.
2. **Một file JSON = một bảng.** Không có database. `file-store.js` là toàn bộ tầng dữ liệu.
3. **Đơn vị công việc = 1 ASIN.** Job mang `{asin, keywords[]}`. Mọi thứ khác (khóa hàng đợi,
   Continue, thu hồi job treo, tách file daily) đều xoay quanh đơn vị này.

### 1.3 Bản đồ dữ liệu trên đĩa

```
data/                              [đo] tổng ~2 GB trên máy local
├── users.json, sessions.json      DÙNG CHUNG (không phân vùng)
├── agent-tokens.json, invite.json DÙNG CHUNG
└── users/<tên>/  ← hoặc gốc data/ nếu là admin đầu tiên (legacyRoot)
    ├── tracking.json              cấu hình bảng: ASIN, keyword, session, config
    ├── daily/<ASIN>.json          chuỗi rank — ĐÃ tách theo ASIN (v0.29)
    ├── results/<ts>.json          bản run đầy đủ + snapshot đối thủ   [đo] 39 file / 1,6 MB
    ├── asin-metrics.json          ads + business theo (asin,date)
    ├── inventory-daily.json       tồn kho theo (asin,date)
    ├── competitor-rank.json       đối thủ theo (asin,dateKey)
    ├── competitor-library.json    thư viện đối thủ theo nhóm
    ├── keyword-bank.json          kho keyword + tag
    ├── jobs.json                  hàng đợi (giữ 200 job gần nhất)
    ├── adjust/<id>.json           dataset bulk đã ETL   [đo] 1,0 GB / 11 file
    ├── adjust/{rules,proposals}.json, audit.jsonl
    ├── exports/<ts>.xlsx          snapshot file đã xuất  [đo] 2,2 MB
    ├── chrome-profile/            [đo] 888 MB (chỉ trên máy agent)
    └── debug/, uploads/           [đo] 48 MB + 37 MB rác
```

Có sẵn `db/schema.sql` — bản nháp Postgres 20 bảng viết từ đầu dự án. Nó vẫn còn giá trị làm
điểm khởi đầu cho v2, nhưng **đã lệch khá xa** so với thứ code thực sự tiến hóa thành (xem §6.2).

---

## 2. Sáu quy trình làm việc

### QT-1 — Check ranking (bấm ▶ Run)

```
Trình duyệt                Railway                     Agent
    │                         │                          │
    ├─ enabledTargets() ──────┤                          │
    │  (lọc ASIN/keyword bật) │                          │
    │                         │                          │
    ├─ POST /api/check ──────►│ activeSession()?         │
    │  {asin, keywords, runId}│ khác runId → BUSY        │
    │                         │ enqueueJob()             │
    │◄─ JOB_ID:xxx ───────────┤                          │
    │                         │◄─ POST /api/agent/poll ──┤ (15s/lần)
    │                         │  claimNextJob()          │
    │                         │  single-flight           │
    │                         ├─ job ───────────────────►│
    │  pollJob() 3s/lần       │                          ├─ getBrowser()
    │                         │                          ├─ ensureZipLocation()
    │                         │                          ├─ verifySession()
    │                         │                          ├─ runBatch():
    │                         │                          │   mỗi keyword:
    │                         │                          │     × maxPages trang
    │                         │                          │     parse → rank
    │                         │◄─ /api/agent/partial ────┤   mỗi 5 keyword
    │                         │  saveDailyRanks()        │
    │                         │  → {stop:?}              │
    │◄─ /api/tracking 8s/lần ─┤                          │
    │  (TOÀN BỘ lịch sử)      │                          │
    │                         │◄─ /api/agent/result ─────┤ cuối ASIN
    │                         │  importRunResult()       │
    │                         │  completeJob()           │
    ├─ ASIN kế tiếp ─────────►│                          │
```

Điểm cần nhớ: **vòng lặp "ASIN kế tiếp" nằm ở trình duyệt.** Server chỉ biết từng job lẻ.

### QT-2 — Continue / hồi phục

Ba cơ chế hồi phục độc lập, hoạt động ở ba tầng khác nhau:

| Tầng | Cơ chế | Kích hoạt bởi |
|---|---|---|
| Trong 1 ASIN | `DEAD_PAGE_RE` → `renewPage()`, quét lại đúng keyword đó (tối đa 5 lần/ASIN) | Chrome chết giữa chừng |
| Giữa các job | Heartbeat > 5 phút → dựng lại payload = `missingKeywords()` | Agent chết/mất mạng |
| Toàn phiên | ⏩ Continue → `latestIncompleteSession()` + `missingTargets()` | Người dùng bấm |

Cả ba đều quy về một định nghĩa: **ô trống = chưa có bản ghi trong `daily[asin][kw][dateKey]`**.
Đây là một quyết định thiết kế tốt — "ngoài top 150" và ToS `"?"` đều là kết quả THẬT nên có bản
ghi, không bị quét lại.

### QT-3 — Scheduler daily

`setInterval` 30 giây → duyệt **từng user** → `schedTick()` trong context của user đó → so
`HH:MM` với giờ đã đặt → xếp job cho mọi ASIN có cờ ⏰.

Điểm yếu: so khớp **đúng phút**. Nếu server restart hoặc bị chiếm dụng đúng phút đó thì cả ngày
không chạy (không có cơ chế bù). Xem B10.

### QT-4 — Adjust (bulk → sửa → xuất)

```
file bulk Amazon (30-165 MB)
  → etlBulk()            giữ 6 entity, tính lại metrics    [đo trước] 81 MB → 991 MB RSS
  → adjust/<id>.json     ghi nguyên dataset
  → loadDataset()        cache RAM, LRU tối đa 1
  → queryRows()          filter/sort/phân trang server-side
  → user sửa (ledger edits[] ở trình duyệt)
  → buildUpdateRows()    chỉ dòng thay đổi + required headers
  → xlsx + audit.jsonl
```

Nhánh song song: `run-rules` → `evaluate()` → proposals pending → duyệt → `proposals/export`.

Thiết kế 2 lớp ở đây **đúng**: file gốc 300k dòng không bao giờ lên trình duyệt. Vấn đề chỉ ở
vòng đời file (B3) và ở chỗ giữ nguyên dataset trong RAM (B7).

### QT-5 — Launching (tạo campaign)

`parseH10()` → `planCampaigns()` → user sửa bảng preview → `buildRowsFromPlans()` +
`buildSdRows()` + `buildSbRows()` → xlsx 3 sheet + `upsertKeywords()` vào kho.

Module này **thuần hàm, không I/O trong lõi** — đây là phần sạch nhất của codebase và cũng là
phần dễ viết test nhất. Nó không nằm trên đường tới hạn hiệu năng.

### QT-6 — Data (import & đánh giá)

3 nguồn (ads bulk / business / inventory) → `flex-import` tự dò cột → gộp vào
`asin-metrics.json` + `inventory-daily.json` → `buildAsinDaily()` hợp nhất theo ngày →
`evaluateAsin()` sinh tín hiệu.

---

## 3. Phân loại hàm

Tôi phân theo **vai trò kiến trúc**, vì đó là trục quyết định cái gì nên tách ra ở v2.

### N1 — Hàm thuần (pure): vào → ra, không I/O, không trạng thái

Đây là **tài sản quý nhất** của codebase: dễ test, dễ chuyển, không bao giờ là nút cổ chai I/O.

| Hàm | File | Vai trò |
|---|---|---|
| `parseSerpPage` (qua `serpParserSource`) | serp-parser | DOM SERP → slots |
| `computeRanking` | serp-parser | slots → rank 1 ASIN |
| `computeGroupRanking` | serp-parser | slots → rank nhóm biến thể |
| `mergePageResults`, `checkAcrossPages` | rank-aggregator | gộp nhiều trang |
| `isBotCheckPage` | serp-parser | nhận diện trang chặn |
| `adsMode`, `countSpTiles`, `adsServed`, `needsAdsRetry`, `shouldVerifyReload` | ads-scan | cấu hình + phán đoán ads |
| `planCampaigns`, `buildRowsFromPlans`, `buildSdRows`, `buildSbRows`, `ladderBids`, `renderName`, `parseBid` | bulk-builder | sinh dòng bulk |
| `parseH10` | h10-parser | đọc file Helium10 |
| `etlBulk`, `queryRows`, `groupTerms`, `buildUpdateRows`, `listPortfolios`, `rowKey` | bulk-etl | ETL + truy vấn |
| `evaluate`, `applyAction`, `passConditions`, `asinOfRecord` | rule-engine | rule → proposals |
| `buildMetrics`, `summarize`, `cellOf` | consolidate | định dạng ô hiển thị |
| `evaluateAsin` | evaluate | tín hiệu đánh giá |
| `detectColumns`, `mapRows`, `readTable` | flex-import | tự dò cột |
| `extractVariantsFromProductPage` | variant-resolver | HTML → nhóm biến thể |
| `remapToDatasetHeader`, `buildHarvestCreateRows` | server.js ⚠️ | **nằm nhầm chỗ** — thuần nhưng ở trong server |

**Nhận xét:** ~40% khối lượng logic nghiệp vụ đã là hàm thuần. Đây là lý do v2 có thể tái kiến
trúc mà không phải viết lại phần khó nhất.

### N2 — Hàm I/O lưu trữ (đọc-sửa-ghi cả file)

Toàn bộ nằm ở `file-store.js`. **Mọi hàm ghi đều theo mẫu: đọc cả file → sửa → ghi cả file.**

| Nhóm | Hàm | File chạm |
|---|---|---|
| Rank | `saveDailyRanks`, `getDailySeries`, `readDailyAsin`, `writeDailyAsin`, `readDailyAll`, `dailyAsins`, `migrateDailyIfNeeded` | `daily/<ASIN>.json` |
| Tracking | `getTracking`, `getTrackingTable`, `trackingRegisterRun`, `trackingPatchAsin`, `trackingPatchKeyword`, `trackingApplyVolumes`, `trackingSetConfig`, `trackingSetImage`, `trackingDeleteDate`, `trackingDailyJobs` | `tracking.json` |
| Thiếu sót | `missingKeywords`, `missingTargets`, `latestIncompleteSession` | daily + tracking |
| Hàng đợi | `enqueueJob`, `claimNextJob`, `appendJobLogs`, `requestStopJobs`, `isStopRequested`, `completeJob`, `failJob`, `activeSession`, `getJob`, `listJobs` | `jobs.json` |
| Kết quả | `saveRunResult`, `importRunResult`, `listRunResults`, `getRunResult` | `results/*.json` |
| Đối thủ | `saveCompetitorAgg`, `getCompetitorRank`, `getCompetitorPick`, `getCompetitorPickLib`, `compLibAdd/Patch/SaveScan/UpdateStats`, `getCompetitorLibrary` | 2 file |
| Chỉ số | `saveAsinMetrics`, `getAsinMetrics`, `saveAdsMetrics`, `saveBusinessData`, `saveInventory`, `getInventory`, `listDataAsins` | 2 file |
| Adjust A3 | `listRules`, `createRule`, `updateRule`, `deleteRule`, `seedDefaultRulesIfEmpty`, `resetRules`, `insertProposals`, `listProposals`, `setProposalStatus`, `setProposalStatusByDataset` | 2 file |
| Khác | `getKeywordBank`, `upsertKeywords`, `setKeywordTag`, `saveExportSnapshot`, `listExports`, `getLaunchSettings`, `saveLaunchSettings`, `getProduct`, `upsertProduct`, `getProductsMap`, `listProducts`, `getSchedule`, `saveSchedule`, `getWorkerConfig`, `saveWorkerConfig`, `getAsinSettings`, `saveAsinSettings`, `getProductVariants`, `saveProductVariants`, `recordImport`, `listImports` | mỗi hàm 1 file |

**Nhận xét:** 60+ hàm, chỉ **6 chỗ** dùng `writeJsonAtomic` (daily, tracking, jobs). Số còn lại
dùng `fs.writeFileSync` trực tiếp — mất điện giữa chừng là hỏng JSON, mất trọn file. Xem B8.

### N3 — Hàm điều khiển trình duyệt (chỉ chạy trên agent)

`launchBrowser`, `clearStaleProfileLock`, `newCleanPage`, `loadCookies`, `verifySession`,
`setZipLocation`, `ensureZipLocation`, `getCurrentLocation`, `waitForRender`, `scrapeKeyword`.

### N4 — Hàm điều phối (orchestration)

| Hàm | Ở đâu | Điều phối cái gì |
|---|---|---|
| `runTargets` | **index.html** ⚠️ | vòng lặp qua các ASIN |
| `runBatch` | run-batch.js | vòng lặp qua các keyword của 1 ASIN |
| `runJob`, `runLibScanJob` | agent.js | vòng đời 1 job |
| poll loop | agent.js | vòng đời agent |
| `schedTick` | server.js | lịch daily |
| `executeCheck` | server.js | chế độ local (song song với agent) |

**Nhận xét:** điều phối bị **rải ở 4 tiến trình khác nhau** (trình duyệt, server, agent, run-batch).
Đây là nguồn gốc của phần lớn bug đã gặp: khóa hàng đợi, Stop không ăn, đóng tab là chết phiên.

### N5 — Hàm xác thực / phân vùng

`register`, `verify`, `createSession`, `getSession`, `setActAs`, `getActAs`, `destroySession`,
`parseCookie`, `verifyBasic`, `createAgentToken`, `resolveAgentToken`, `listAgentTokens`,
`revokeAgentToken`, `setRole`, `deleteUser`, `getInviteCode`, `regenInviteCode`
+ `runAsUser`, `currentUser`, `userDataDir`.

### N6 — Handler HTTP

~70 endpoint trong `server.js`. Phần lớn là 1-3 dòng gọi thẳng vào `store.*` — mỏng, tốt.
Một số handler **dày** và chứa logic nghiệp vụ (nên tách ở v2):
`/api/check`, `/api/adjust/export-all`, `/api/adjust/run-rules`, `/api/asin-daily/:asin`,
`/api/history/:asin`, `/api/competitor-snapshot/:asin`, `/api/competitor-library/scan`.

### N7 — Hàm trình bày (render) — trong HTML

`renderTable`, `loadTracking`, `kwFieldLine`, `cellHtml`, `bindResizers`, `modal`, `note`… —
tất cả nằm trong `<script>` inline của 5 file HTML, không module, không build step, không test.

---

## 4. Số đo nền

### 4.1 Đo hôm nay

| Phép đo | Kết quả |
|---|---|
| `getTrackingTable()` trên dữ liệu thật | **[đo]** 2 ms · 15 KB JSON · 3 ASIN / 20 keyword / 11 cột / 79 ô |
| → chi phí một ô trong payload API | **[đo]** 193 byte/ô |
| `listRunResults()` | **[đo]** 16 ms cho 39 file (1,6 MB) |
| File run lớn nhất (có snapshot đối thủ) | **[đo]** 380 KB / 1 ASIN / 1 lượt |
| `data/adjust/` | **[đo]** 1,0 GB · 11 file dataset · index chỉ ghi nhận 9 |
| 3 dataset cùng khoảng ngày `20260518-20260717` | **[đo]** 165 MB × 3 = 495 MB trùng lặp |
| `data/chrome-profile/` | **[đo]** 888 MB |
| `data/debug/` + `data/uploads/` | **[đo]** 48 MB + 37 MB (rác, không ai dọn) |
| Trùng keyword giữa các ASIN | **[đo]** 20 cặp → 19 keyword duy nhất = **chỉ 5% trùng** |

### 4.2 Đo ở phiên trước (ghi trong comment/commit)

| Phép đo | Kết quả |
|---|---|
| RTT trình duyệt → Railway | 427 ms trung vị |
| Payload đẩy lô, có snapshot đối thủ | 18,8 KB/keyword |
| Payload đẩy lô, không snapshot | 0,6 KB/keyword |
| Chi phí cố định mỗi ASIN | 6,6 s (Chrome 1,4 + page 0,6 + zip 2,8 + verify session 1,8) |
| Quét ads bật vs tắt | 4,20 s vs 0,30 s mỗi trang |
| Chuỗi rank trên đĩa | 165 byte/ô |
| Dataset bulk 81 MB nạp vào RAM | 991 MB RSS (gấp ~12 lần) |

### 4.3 Kịch bản mục tiêu dùng để tính toán

Để nói chuyện bằng con số, tôi dùng **kịch bản M**: *20 ASIN × 200 keyword × 3 trang, quét
hằng ngày, giữ 1 năm lịch sử.* Nếu con số thật của bạn khác nhiều, mọi kết luận ở §5 cần tính lại
— hãy cho tôi biết ở vòng feedback.

- 4.000 cặp (ASIN, keyword) mỗi phiên
- 12.000 lượt tải trang SERP mỗi phiên
- 1,46 triệu ô rank sau 1 năm

---

## 5. Bất cập — xếp theo mức độ chặn đường mở rộng

### 🔴 B1 — `/api/tracking` trả TOÀN BỘ lịch sử, mỗi 8 giây

`getTrackingTable()` gọi `readDailyAll()` — đọc và gộp **mọi file ASIN, mọi keyword, mọi ngày** —
rồi trả nguyên khối về trình duyệt. Trong lúc chạy, `index.html` gọi lại **8 giây một lần**.

Phép tính với kịch bản M:

```
1.460.000 ô × 193 byte/ô  =  282 MB  mỗi lần gọi          [suy ra]
282 MB / 8 giây × thời gian chạy 6 giờ  =  760 GB truyền  [suy ra]
```

Hôm nay chỉ 15 KB nên không ai thấy gì. Đây là **thứ sẽ vỡ đầu tiên** khi bạn nhồi dữ liệu vào.

Điều khiến nó nghiêm trọng hơn: trình duyệt còn phải **dựng lại toàn bộ bảng HTML** từ khối dữ
liệu đó — không phân trang, không ảo hóa, không giới hạn cột. 1,46 triệu `<td>` là con số không
trình duyệt nào dựng nổi.

### 🔴 B2 — `listRunResults()` đọc và parse mọi file kết quả

```js
return fs.readdirSync(RESULTS_DIR()).filter(...).sort().reverse()
  .map((f) => { const r = readJson(...); return { id, asin, checkedAt, keywordCount }; });
```

Nó parse **toàn bộ** file JSON (kể cả snapshot đối thủ 380 KB) chỉ để lấy 4 trường. Bốn endpoint
gọi nó: `/api/results`, `/api/history/:asin`, `/api/asin-daily/:asin`, `/api/data/consolidated/:asin`.

Tệ hơn: `rankByDateFor()` trong `consolidate.js` gọi `listRunResults()` **rồi lại**
`getRunResult()` cho từng run khớp → đọc file lần thứ hai.

```
[đo]     16 ms cho 1,6 MB
[suy ra] Kịch bản M: 7.300 run × 380 KB ≈ 2,7 GB → ~27 giây mỗi lần gọi
```

Sửa được rẻ: một file `results/index.json` chứa đúng 4 trường đó, cập nhật khi ghi run.

### 🔴 B3 — Dataset Adjust không bao giờ bị xóa

`/api/adjust/import` ghi `adjust/<id>.json` rồi `idx.slice(0, 20)` — **cắt cái index, không cắt
file trên đĩa**.

```
[đo] 11 file trên đĩa, index chỉ ghi nhận 9  →  2 file mồ côi không UI nào với tới
[đo] 3 file CÙNG khoảng ngày 20260518-20260717, mỗi file 165 MB
[đo] Tổng: 1,0 GB
```

Mỗi lần bạn upload lại cùng một file bulk là **+165 MB vĩnh viễn**. Trên Railway, volume đầy là
server chết. Cùng nhóm này: `chrome-profile` 888 MB, `debug/` 48 MB, `uploads/` 37 MB
(multer chỉ `unlinkSync` ở nhánh thành công — ETL ném lỗi là file ở lại mãi).

### 🔴 B4 — Vòng lặp điều phối nằm ở trình duyệt

`runTargets()` trong `index.html` là thứ quyết định "ASIN kế tiếp". Server chỉ nhận từng job lẻ
và không biết chúng thuộc cùng một lượt chạy (ngoài cái `runId` mới thêm để khóa hàng đợi).

Hệ quả trực tiếp:

- Đóng tab / máy ngủ / mất mạng → job đang chạy vẫn xong, nhưng **không ai xếp ASIN tiếp theo**
- Muốn treo máy quét cả ngày thì phải để một tab trình duyệt mở suốt
- Mọi cơ chế khóa/dừng phải làm hai lớp (nút bấm + server) vì không tin được lớp nào

Đây là bất cập **kiến trúc**, không vá được bằng thêm cờ. Xem §6.5.

### 🟠 B5 — Single-flight: chỉ 1 job chạy tại một thời điểm

`claimNextJob()` trả `null` nếu đã có job `running`. Cắm 5 agent thì 4 cái ngồi không.

```
[suy ra] Kịch bản M: 4.000 keyword × ~6 s = 6,7 giờ TUẦN TỰ
         cộng 20 × 6,6 s chi phí mở ASIN = thêm 2,2 phút
```

Lý do đặt single-flight rất chính đáng và được ghi rõ trong comment: *tránh 2 agent cùng
đọc-sửa-ghi `daily-rank.json`*. Nghĩa là **giới hạn này là hệ quả của việc chọn file JSON làm
store**, không phải một yêu cầu nghiệp vụ. Đổi store → mở được song song → thời gian chia cho N.

Đây chính là đòn bẩy lớn nhất cho mục tiêu "nhiều ASIN nhiều keyword".

### 🟠 B6 — Mỗi thao tác nhỏ = đọc + ghi lại cả file

| Thao tác | Tần suất | Ghi lại cả file |
|---|---|---|
| `appendJobLogs` | mỗi 10 dòng log / 5 s | `jobs.json` (tới 200 job × 500 dòng log) |
| `saveDailyRanks` | mỗi lô 5 keyword | `daily/<ASIN>.json` (cả lịch sử ASIN đó) |
| `saveCompetitorAgg` | mỗi lô có snapshot | `competitor-rank.json` (**mọi ASIN, mọi ngày**) |
| `trackingRegisterRun` | mỗi lô | `tracking.json` (cả bảng) |
| `resolveAgentToken` | **mỗi request agent** | đọc 2 file + có thể ghi lại `agent-tokens.json` |
| `getSession` | **mỗi request web** | đọc `sessions.json` + `users.json` |

Việc tách `daily-rank.json` theo ASIN (v0.29) đã xử lý đúng ca tệ nhất. Nhưng
`competitor-rank.json` và `tracking.json` **vẫn là file gộp toàn cục** và vẫn bị ghi lại mỗi lô.

```
[suy ra] Kịch bản M, một lô 5 keyword hiện chạm:
   daily/<ASIN>.json   ~ 140 KB   (200 kw × 365 ngày × 165 B / … cho 1 ASIN)
   competitor-rank.json  toàn cục — tăng tuyến tính theo (ASIN × ngày × đối thủ)
   tracking.json         toàn cục — tăng tuyến tính theo (ASIN × keyword)
   → 800 lô mỗi phiên × 3 file
```

### 🟠 B7 — Cache dataset Adjust bị ép xuống 1, vì lý do đúng

`ADJUST_CACHE_MAX = 1` với ghi chú **[đo trước]**: 81 MB file → 991 MB RSS. Giữ 3 dataset là
4-6 GB → OOM.

Con số gấp 12 lần là do lưu **300.000 object JavaScript**, mỗi object ~35 trường. Đây là cái giá
của việc chọn "nạp nguyên bảng vào RAM" thay vì truy vấn. Với 2 người dùng đồng thời xem 2
dataset khác nhau, cache liên tục đá nhau (thrash) — mỗi lần đổi tab phải nạp lại từ đĩa.

### 🟡 B8 — Chỉ 6/60 chỗ ghi file là nguyên tử

`writeJsonAtomic` (tmp + rename) dùng cho daily, tracking, jobs. Còn lại `fs.writeFileSync`
thẳng: `asin-metrics.json`, `competitor-rank.json`, `competitor-library.json`,
`keyword-bank.json`, `rules.json`, `proposals.json`, `products.json`, `launch-settings.json`,
`schedule.json`, `worker-config.json`, `asin-settings.json`, `variants-cache.json`,
`inventory-daily.json`, `data-imports.json`, `exports/index.json`.

Railway restart container giữa lúc ghi = file JSON cụt = mất trọn bảng đó.

### 🟡 B9 — Đường chạy đôi: local vs agent

`executeCheck()` (server tự scrape) và `agent.js runJob()` làm **cùng một việc** bằng **hai đoạn
code khác nhau**. Tương tự: `/api/competitor-library/scan` trong `server.js` và `runLibScanJob`
trong `agent.js` — khối `page.evaluate` giống hệt nhau từng chữ.

Mọi sửa đổi phải nhớ làm ở cả hai chỗ. Thực tế trong quá trình làm v1 đã có lúc chỉ sửa một bên.

Trùng lặp khác đã xác nhận:
- `/api/import-bulk` và `/api/data/import/ads` — thân hàm giống hệt
- `/api/asin-daily/:asin` (trong server.js) và `buildAsinDaily()` (trong consolidate.js) — hai
  builder gần trùng, cùng tính CTR/CPC/ACoS/TACoS theo hai cách viết khác nhau

### 🟡 B10 — Scheduler khớp đúng phút, không có cơ chế bù

`if (hhmm !== s.time || s.lastRunDate === today) return;`

Restart Railway đúng phút đó (hoặc `running === true` do việc khác) → **cả ngày không chạy**.
Không có log cảnh báo, người dùng chỉ phát hiện khi thấy cột trống hôm sau.

### 🟡 B11 — Phí cố định lặp lại trên mỗi job

`newReadyPage()` gọi `ensureZipLocation()` cho **mỗi page mới**, tức mỗi ASIN — dù cùng một
browser, cùng một profile đã nhớ zip. Trong khi `verifySession()` thì đã được gác bằng
`hold.verified` và chỉ chạy một lần.

```
[đo trước] ensureZipLocation ≈ 2,8 s (tải amazon.com + đọc nav)
[suy ra]   20 ASIN → 56 giây lãng phí mỗi phiên, tăng tuyến tính theo số ASIN
```

### 🟡 B12 — `computeGroupRanking` dựng snapshot rồi vứt đi

```js
for (const a of siblingAsins || []) {
  const r = computeRanking(slots, a, ...);       // dựng competitorSnapshot ĐẦY ĐỦ
  if (hasPresence(r)) {
    const { competitorSnapshot, ...light } = r;  // rồi vứt
```

`computeRanking` luôn `push` một object vào `competitorSnapshot` cho **mọi slot**, kể cả khi gọi
cho biến thể (nơi snapshot bị bỏ ngay).

```
[suy ra] ASIN có 20 biến thể, 48 slot/trang, 3 trang:
   20 × 144 = 2.880 object dựng-rồi-vứt mỗi keyword
   × 200 keyword = 576.000 object rác mỗi ASIN
```

Sửa bằng một cờ `opts.snapshot = false` — thay đổi 3 dòng.

### ⚪ B13 — Nhóm lặt vặt (không chặn mở rộng)

- `noteLoginFail`: `loginFails.set(f.n === 1 ? key : key, f)` — hai nhánh của toán tử ba ngôi
  giống hệt nhau, viết thừa
- `verify()`: `crypto.timingSafeEqual` **ném lỗi** nếu hai buffer khác độ dài → users.json hỏng
  một byte là 500 thay vì "sai mật khẩu"
- `scryptSync` chặn event loop (~100 ms/lần đăng nhập) — chấp nhận được ở quy mô này
- `/agent-bundle.tgz?token=` truyền token qua **query string** → nằm trong log của proxy Railway
- `apps/web/` và `packages/shared/` chỉ có README rỗng — scaffold chết từ đầu dự án
- `src/scraper/dump-serp.js` không ai import (là công cụ chạy tay, cố ý giữ)
- `docs/` rỗng cho tới tài liệu này

---

## 6. Kiến trúc đề xuất cho v2

### 6.1 Nguyên tắc dẫn đường

> **Cái gì tăng theo lịch sử thì không được nằm trên đường đi của một lượt chạy.**

Gần như mọi bất cập 🔴 ở trên đều là vi phạm nguyên tắc này: bảng theo dõi tải cả năm dữ liệu để
hiển thị một cột; `listRunResults` đọc cả năm file để lấy 4 trường; `competitor-rank.json` ghi lại
cả năm mỗi lô 5 keyword.

### 6.2 Tầng lưu trữ: nên chọn gì

Đây là quyết định gốc, mọi thứ khác phụ thuộc vào nó.

| Phương án | Được | Mất |
|---|---|---|
| **A. Giữ file JSON, vá thêm** | Không phải học gì mới; zero downtime | Không mở được song song (B5); mọi bất cập 🔴 chỉ giảm nhẹ chứ không hết |
| **B. SQLite (file đơn, WAL)** | Truy vấn thật, index, transaction, ghi đồng thời an toàn; **vẫn là 1 file** nên Railway volume dùng nguyên như cũ; migration từ JSON viết được trong ~200 dòng | Cần học SQL; Railway volume I/O chậm hơn đĩa local |
| **C. Postgres** | Đúng thứ `db/schema.sql` đã vẽ; nhiều replica; RLS cho phân vùng user | Thêm dịch vụ, thêm tiền, thêm độ trễ mạng; migration nặng nhất |

**Khuyến nghị: B (SQLite), không phải C.**

Lý do: bài toán của bạn không phải "nhiều người dùng đồng thời" mà là "**nhiều dữ liệu, một vài
người**". SQLite giải quyết đúng 5 bất cập nặng nhất (B1, B2, B5, B6, B8) mà không thêm một dịch
vụ nào phải vận hành. Nếu sau này thật sự cần nhiều replica thì SQLite → Postgres là bước
chuyển dễ, vì lúc đó code đã nói SQL rồi.

`db/schema.sql` vẫn dùng lại được ~70%, nhưng cần bổ sung những khái niệm đã sinh ra trong v1 mà
schema cũ chưa có:

- **`sessions` (phiên quét)** — `dateKey` chính là cột trên bảng theo dõi; schema cũ chỉ có
  `checked_at` nên không diễn tả được "Continue vào đúng cột dở dang"
- **3 trạng thái ads** — `"_"` / `"?"` / `x/y` không map được vào `tos_position INT`
- **`runs` và `run_id`** — khóa hàng đợi theo lượt bấm Run
- **`agent_tokens`** — schema cũ chưa có
- **`serp_snapshots`** — schema cũ định lưu **mỗi slot một dòng**. Kịch bản M: 12.000 trang ×
  48 slot = **576.000 dòng mỗi ngày**, 210 triệu dòng mỗi năm. Cần đổi sang lưu nén theo
  (rank_check) hoặc bỏ hẳn snapshot chi tiết, chỉ giữ phần đã tổng hợp.

### 6.3 API phải phân trang theo cột

Thay `/api/tracking` (trả tất cả) bằng:

```
GET /api/tracking/config                 → ASIN, keyword, cấu hình  (không có series)
GET /api/tracking/cells?sessions=a,b,c   → chỉ các cột được yêu cầu
GET /api/tracking/sessions?limit=30      → danh sách cột, mới nhất trước
```

Trình duyệt mặc định tải **10 cột gần nhất**, cuộn sang trái thì nạp thêm. Trong lúc chạy chỉ
poll **đúng cột đang chạy**:

```
[suy ra] 4.000 ô × 193 B = 772 KB thay vì 282 MB — giảm 365 lần
```

Kèm theo: bảng phải **ảo hóa dòng** (chỉ dựng DOM cho dòng đang nhìn thấy). Không có bước này thì
dù API nhẹ đi, trình duyệt vẫn chết ở 4.000 dòng × 30 cột.

### 6.4 Mở song song một cách an toàn

Khi store đã chịu được ghi đồng thời, bỏ single-flight và đổi đơn vị công việc:

```
Job hiện tại:  { asin, keywords[200] }        ← 1 job = 1 ASIN, chạy 20 phút
Job v2:        { asin, keywords[20], chunk }  ← 1 job = 1 lô, chạy 2 phút
```

Lô nhỏ đem lại ba thứ cùng lúc:
- **Song song thật**: 5 agent × 5 lô = 5 lần nhanh hơn
- **Mất mát nhỏ khi đứt**: tối đa 2 phút công việc, không phải 20 phút
- **Cân tải tự nhiên**: máy nhanh nhận nhiều lô hơn, không cần thuật toán chia việc

Cái phải thêm: **claim có khóa thật** (`UPDATE ... WHERE status='pending' RETURNING` trong một
transaction). SQLite/Postgres cho sẵn; đây chính là thứ file JSON không làm được.

### 6.5 Đưa điều phối về server

```
Hiện tại:  Trình duyệt lặp qua ASIN → gọi /api/check từng cái
v2:        POST /api/runs { targets[] } → server tạo run + xếp TOÀN BỘ lô
           Trình duyệt chỉ còn GET /api/runs/:id để xem tiến độ
```

Đóng tab không ảnh hưởng gì. Khóa hàng đợi trở nên tự nhiên (một run đang chạy = không nhận run
mới) thay vì phải bịa ra `runId` và mượn `runId` cho scheduler như hiện nay.

### 6.6 Vòng đời dữ liệu — phải có, không phải tùy chọn

| Dữ liệu | Chính sách đề xuất |
|---|---|
| `adjust/<id>.json` | Giữ N dataset gần nhất, **xóa file khi rơi khỏi index**; chặn upload trùng (cùng khoảng ngày + cùng kích thước) |
| `results/*.json` | Tách snapshot đối thủ ra file riêng, nén gzip, xóa sau 90 ngày; giữ phần rank vĩnh viễn (nó nhỏ) |
| `uploads/` | `unlinkSync` trong `finally`, không phải trong `try` |
| `debug/` | Chỉ ghi khi `DEBUG=1`, tự xóa file cũ hơn 7 ngày |
| `chrome-profile/` | Xóa cache định kỳ trên agent (giữ cookie, bỏ cache) |
| `jobs.json` | Đã cắt 200 job — sang store mới thì cắt theo tuổi |

### 6.7 Về ý tưởng "quét theo keyword thay vì theo ASIN"

Ý tưởng: nếu 5 ASIN cùng theo dõi keyword `"gift for women"`, hiện hệ thống tải SERP đó **5 lần**.
Đảo trục — tải 1 lần rồi tính rank cho cả 5 ASIN — sẽ tiết kiệm 80%.

**Tôi đã đo và ý tưởng này hiện KHÔNG đáng làm:**

```
[đo] 20 cặp (ASIN, keyword) → 19 keyword duy nhất → chỉ 5% trùng
     Keyword duy nhất được chia sẻ: "positive pickle jar" (2 ASIN)
```

Nó chỉ trở nên đáng giá nếu danh mục sản phẩm của bạn tập trung vào **cùng một ngách** (nhiều ASIN
biến thể của cùng loại sản phẩm, dùng chung bộ keyword). Với danh mục trải rộng như hiện tại thì
không.

Tôi nêu ra ở đây vì nó là tối ưu **kiến trúc** duy nhất có thể cắt giảm hàng-chục-phần-trăm thời
gian quét, và vì nó là thứ **phải quyết định trước khi thiết kế schema** (job theo ASIN hay theo
keyword là hai bảng khác nhau). **Cần feedback của bạn ở §9.**

---

## 7. Tối ưu sâu từng hàm

Sắp theo tỉ lệ (lợi ích ÷ công sức). Nhóm A làm được ngay trên kiến trúc v1.

### Nhóm A — Sửa trong v1, không đụng kiến trúc

| # | Hàm | Vấn đề | Cách sửa | Lợi ích |
|---|---|---|---|---|
| A1 | `listRunResults` | parse mọi file để lấy 4 trường | duy trì `results/index.json` | **[suy ra]** 27 s → ~1 ms ở kịch bản M |
| A2 | `newReadyPage` | `ensureZipLocation` mỗi ASIN | gác bằng `hold.zipOk` như `hold.verified` | **[suy ra]** −2,8 s/ASIN |
| A3 | `computeRanking` | dựng snapshot cho biến thể rồi vứt | thêm `opts.snapshot=false` | **[suy ra]** −576k object/ASIN |
| A4 | `/api/adjust/import` | file mồ côi khi rơi khỏi index | xóa file kèm theo | **[đo]** thu hồi 1,0 GB |
| A5 | upload multer | không dọn khi lỗi | `unlinkSync` trong `finally` | **[đo]** thu hồi 37 MB |
| A6 | `waitForRender` | cuộn 700 px mỗi 120 ms tới hết trang | cuộn 3 nhịp lớn rồi settle | **[giả định]** −1÷2 s/trang, **phải đo lại vì có thể làm hụt ads lazy-load** |
| A7 | `saveCompetitorAgg` | ghi lại file toàn cục mỗi lô | tách theo ASIN như `daily/` | tuyến tính → hằng số |
| A8 | 15 hàm ghi file | không nguyên tử | dùng `writeJsonAtomic` sẵn có | chống mất dữ liệu |
| A9 | `schedTick` | khớp đúng phút | đổi sang "quá giờ & chưa chạy hôm nay" | không mất ngày |
| A10 | `resolveAgentToken` | đọc 2 file mỗi request | cache RAM 60 s | −2 lần đọc × 4 poll/phút × N agent |

### Nhóm B — Cần kiến trúc v2

| # | Việc | Phụ thuộc |
|---|---|---|
| B1 | Phân trang `/api/tracking` theo cột | §6.3 |
| B2 | Ảo hóa dòng ở bảng theo dõi | §6.3 |
| B3 | Bỏ single-flight, job theo lô | §6.2 + §6.4 |
| B4 | Điều phối về server | §6.5 |
| B5 | Gộp `executeCheck` và `runJob` thành một đường chạy | §6.5 |
| B6 | Adjust: truy vấn thay vì nạp cả dataset vào RAM | §6.2 |

### Nhóm C — Dọn dẹp

Gộp `/api/import-bulk` với `/api/data/import/ads`; gộp `/api/asin-daily/:asin` với
`buildAsinDaily`; đưa `buildHarvestCreateRows` + `remapToDatasetHeader` ra khỏi `server.js`;
tách 5 file HTML thành module + build step; xóa `apps/web/` và `packages/shared/`; sửa B13.

---

## 8. Lộ trình đề xuất

Ba giai đoạn, mỗi giai đoạn **tự nó đã có ích** — không có giai đoạn nào là "làm xong mới thấy tác dụng".

**GĐ-1 · Chặn máu (làm trên v1, ~1-2 ngày)** — nhóm A1-A5, A8. Thu hồi ~1 GB đĩa, bỏ điểm nghẽn
`listRunResults`, chống hỏng file. Không đụng kiến trúc, rủi ro thấp.

**GĐ-2 · Đổi store (~3-5 ngày)** — SQLite + lớp `store` giữ **nguyên chữ ký hàm hiện tại**.
Đây là mấu chốt: `file-store.js` đã được viết như một interface (`saveDailyRanks`,
`missingTargets`, `claimNextJob`…), nên có thể thay ruột mà không đụng `server.js` hay `agent.js`.
Sau bước này mới mở được song song và phân trang.

**GĐ-3 · Đổi hình dạng công việc (~3-5 ngày)** — job theo lô, điều phối về server, API phân
trang, ảo hóa bảng.

Xen giữa GĐ-1 và GĐ-2: **viết test cho nhóm hàm thuần N1**. Đã có sẵn 12 SERP fixture; chỉ thiếu
runner. Đây là điều kiện để dám đổi store mà không sợ vỡ parser.

---

## 9. Những chỗ tôi chưa chắc — cần feedback của bạn

Sáu câu hỏi này thay đổi kết luận ở trên, không phải hỏi cho có:

1. **Quy mô thật của bạn là bao nhiêu?** Tôi giả định 20 ASIN × 200 keyword × 1 năm. Nếu thật ra
   là 100 ASIN hoặc chỉ giữ 90 ngày lịch sử, các con số ở §5 đổi rất nhiều.

2. **Các ASIN có dùng chung bộ keyword không?** Hôm nay đo được **5% trùng**. Nếu sắp tới bạn
   nhồi nhiều ASIN cùng ngách, con số này có thể lên 50-70% và ý tưởng ở §6.7 sẽ đổi hẳn thiết
   kế job. Đây là câu hỏi **quan trọng nhất** trong sáu câu.

3. **Bao nhiêu máy agent sẽ chạy cùng lúc?** Nếu chỉ có một máy của bạn thì bỏ single-flight
   không đem lại gì, và GĐ-2 nên ưu tiên phân trang thay vì song song hóa.

4. **Snapshot đối thủ có còn cần lưu đầy đủ không?** Nó chiếm gần như toàn bộ dung lượng
   `results/` (**[đo trước]** 18,8 KB/keyword so với 0,6 KB khi tắt). Nếu chỉ cần bảng tổng hợp
   thì bỏ được rất nhiều.

5. **Giữ lịch sử bao lâu?** Không có câu trả lời thì không đặt được chính sách vòng đời ở §6.6.

6. **Ai sẽ dùng ngoài bạn?** Hệ thống user/phân vùng/mã mời đã dựng đủ, nhưng nếu thực tế chỉ một
   người dùng thì nó là độ phức tạp thừa và v2 nên cân nhắc bỏ bớt.

---

## Phụ lục — Những chỗ v1 làm đúng, đừng phá khi viết lại

Không phải mọi thứ đều cần đổi. Bốn quyết định sau đã được kiểm chứng bằng lỗi thật và nên giữ
nguyên tinh thần:

1. **Tách agent khỏi server.** IP dân cư là lý do tool này hoạt động được. Mọi kiến trúc v2 phải
   giữ nguyên ranh giới này.
2. **Ba trạng thái ads `_` / `?` / `x/y`.** Không bao giờ ghi `0/0` giả. Đây là sự khác biệt giữa
   "không có ads" và "không đo được" — mất phân biệt này là mất niềm tin vào toàn bộ cột ToS.
3. **Ô trống = chưa có bản ghi.** Định nghĩa này làm cho ba cơ chế hồi phục (page chết, agent
   chết, Continue) dùng chung một phép tính duy nhất.
4. **`file-store.js` là một interface, không phải một đống hàm rời.** Chính vì được viết như vậy
   mà GĐ-2 khả thi trong 3-5 ngày thay vì phải viết lại cả ứng dụng.

---

*Tài liệu lập ngày 2026-08-07 trên commit `69c8b58` (v0.30.2).
Số liệu **[đo]** lấy từ dữ liệu thật trên máy local; **[đo trước]** trích từ comment code và
commit message của các phiên trước.*
