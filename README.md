# StageDeckInteract — 通用型全網頁互動簡報與千人即時互動系統

將「簡報播放（`SLIDE`）」與「六大現場即時互動視覺引擎」整合於單一網頁狀態機中，採用 **Google Sheets 即後台（Zero-Code CMS）** 的設定與程式分離架構。講者只需使用無線簡報筆即可全程推進，觀眾掃描一次 QR Code，手機端自動於「隨身筆記講義（支援收藏與匯出）」與「即時互動遙控器」之間無縫切換。

---

## 一、 核心功能特色

1. **八大內建簡報版型 (`SLIDE`)**：
   - `COVER`：封面與開場版型（右側內建高對比大型 QR Code 卡片）
   - `QUOTE`：金句引言版型（支援 `|` 分隔原文與翻譯）
   - `BULLETS`：漸進式條列版型（按簡報筆逐點淡入展開，全數展開後自動切下一頁）
   - `SPLIT`：雙欄對比版型（`::` 分隔左右兩欄，欄內支援 `|` 條列）
   - `MEDIA`：全幅圖解版型（自動轉換 Google Drive 分享連結為直連圖片並預載）
   - `DIAGRAM`：**Mermaid 即時向量繪圖**（流程圖、心智圖、時序圖，免截圖自動適配深淺色主題）
   - `CHART`：**動態數據圖表引擎**（支援 `bar` 長條圖、`pie`/`donut` 圓餅圖、`line` 折線圖、`radar` 雷達圖）
   - `CARDS`：**結構化資訊圖卡**（自動排版 3~4 步驟流程卡與對比卡片）
2. **六大 60 FPS 即時互動視覺模組**：
   - `BUBBLE`：物理碰撞氣泡圖（彈性碰撞、半徑依票數開根號膨脹、第一名皇冠光環）
   - `SPECTRUM`：理念天平 / 雙向拔河（連續傾向滑桿與即時傾斜天平）
   - `MYTH`：破除迷思限時競賽（`READY` → `VOTING` 保密倒數 → `REVEALED` 正誤圓環與解析）
   - `QUADRANT`：二維心態落點矩陣（千人粒子飛入、熱力聚合與全場平均重心）
   - `TREE`：星空共育願景之樹（流光飛向樹梢綻放為發光葉片）
   - `DANMAKU`：滾動彈幕 × 講者聚焦牆（敏感詞過濾、後台審核與中央聚焦 Spotlight）
3. **手機端輕量化設計（< 25 KB）**：無外部重型字型與圖表庫，支援 `SLIDE` 重點收藏（`localStorage`）與一鍵複製 / 匯出 `.txt` 筆記。
4. **多房間與雙架構儲存**：
   - **本機 / 常駐 Node.js**：開箱即用 `MemoryRoomStore` + SSE 即時推播。
   - **Vercel Serverless + Upstash Redis**：設定 `UPSTASH_REDIS_REST_URL` 與 `UPSTASH_REDIS_REST_TOKEN`（或 Vercel Marketplace 綁定 Upstash），搭配 CDN `s-maxage=1` 緩衝，支援 1,000 ~ 3,000 人高併發零掉票、冪等性 UUID 去重。

---

## 二、 快速啟動（本機開發與測試）

```bash
npm install
npm start
```

啟動後可開啟：
- **大螢幕投影端 (`/`)**：`http://localhost:3000/?room=main`（支援 `?sheet=編碼後的CSV網址`）
- **觀眾手機端 (`/m`)**：`http://<區網IP>:3000/m?room=main`
- **控場與講師提詞端 (`/admin`)**：`http://localhost:3000/admin?room=main`（預設密碼 `2026`）
- **講者手機遙控器 (`/remote`)**：於 `/admin` 掃描專屬 QR Code 免密碼登入

### 執行自動化測試與千人壓力測試
```bash
npm test
# 另開視窗啟動 npm start 並切到互動題目後，可執行 1,500 併發壓測：
npm run load-test
```

---

## 三、 大螢幕端快捷鍵 (`/`)

| 快捷鍵 | 功能 |
| :--- | :--- |
| `→` / `PageDown` / `Space` | 統一狀態機前進（漸進條列展開、`MYTH` 階段流轉或切下一頁） |
| `←` / `PageUp` | 返回上一頁 |
| `Q` | 顯示 / 隱藏右上角浮動 QR Code |
| `O` | 開啟 / 關閉全場投影片總覽（Overview Grid） |
| `R` | 熱重載（Hot Reload）重新抓取 Google Sheets CSV |
| `1` ~ `5` | 手動為第 1 ~ 5 選項加 1 票（彩排或離線應急） |
| `B` | 模擬 30 人瞬間湧入測試 |
| `F` | 切換全螢幕 |

---

## 四、 未來如何打造與匯入新的講題（視覺化編排 × PDF × AI 產圖）

### 方式 1：直接匯入 NotebookLM / Canva / PPT 簡報 PDF（最直覺！）
1. 在 NotebookLM（或 Canva / PowerPoint）做好視覺投影片並匯出為 **`.pdf`**（或多張圖片）。
2. 進入 `/admin` 後台，將 PDF 直接拖曳進「**📄 匯入 NotebookLM / Canva PDF 簡報或圖片**」區塊，系統會自動切頁上傳至 **Vercel Blob 雲端圖床**並建立投影片。
3. 在「**📑 視覺化講題編排器**」中點擊任一頁旁的 **「➕題」**，即可直接插入 `BUBBLE`、`MYTH`、`QUADRANT`、`SPECTRUM`、`TREE`、`DANMAKU` 互動題，還能上下調整順序或匯出 `.csv` 備份。

### 方式 2：文字簡報 ＋ Gemini AI 一鍵生插圖（左文右圖混排）
1. 在 `/admin` 的編輯視窗內填寫 `COVER`、`BULLETS` 或 `QUOTE` 頁面（支援貼圖或填寫 `image_prompt`）。
2. 設定 `GEMINI_API_KEY`（於 Vercel 環境變數或後台輸入）後，點擊 **「✨ 一鍵為全部缺圖簡報 AI 生圖」**（使用 `gemini-nano-banana-2.1`），大螢幕 `BULLETS` 與 `QUOTE` 會自動切換為 **左文右圖** 的雜誌級版型。

### 方式 3：Google Sheets 雲端試算表熱重載
1. 下載專案內的 `data/sample-config.csv` 與 `data/sample-deck.csv`（或於 `/admin` 點「💾 匯出目前講題」）匯入 Google 試算表。
2. 於 Google 試算表點選 **「檔案 → 共享 → 發布到網路 → 逗號分隔值 (.csv)」**，將連結貼入 `/admin` 按 **「🔄 熱重載」**，或直接開啟 `https://stagedeckinterac.vercel.app/?room=場次名稱&sheet=編碼後的CSV網址`。

---

## 五、 系統擴充架構指南

若未來要擴充新的簡報版型或互動視覺模組，僅需依循三層模組化介面修改：
1. **資料解析層（`src/sheets.mjs`）**：在 `VALID_MODES` 或 `VALID_LAYOUTS` 註冊新代碼並解析對應欄位。
2. **狀態與計數層（`src/store.mjs`）**：在 `MemoryRoomStore` 與 `UpstashRedisRoomStore` 的 `submitVote` / `_readStats` 加入對應統計邏輯。
3. **雙端渲染層（`public/index.html` & `public/mobile.html`）**：於大螢幕 Canvas / DOM 渲染器與手機端作答卡片補上對應 `mode` / `layout` 渲染分支。

---

## 六、 部署指南（Vercel + Upstash Redis）

1. **建立 Vercel 專案**：登入 [Vercel](https://vercel.com/) → **Add New Project** → 匯入本 GitHub 專案（Framework Preset 選 `Other`）。
2. **綁定 Upstash Redis（千人併發必備）**：在 Vercel 專案頁籤 **Storage → Connect Database → Upstash Redis**，一鍵建立並綁定環境變數（`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` 或 `KV_REST_API_*`）。
3. **設定環境變數（Environment Variables）**：
   - `ADMIN_PASSWORD`：自訂你的控場後台密碼（建議修改預設 `2026`）。
   - `DEFAULT_DECK_CSV_URL`（選填）：預設讀取的公開 Google Sheets Deck CSV 網址。
   - `DEFAULT_CONFIG_CSV_URL`（選填）：預設讀取的公開 Google Sheets Config CSV 網址。
4. **重新部署（Redeploy）**：完成後即可取得公開 HTTPS 網址用於正式演講或研習！
