# LD2410 for Home Assistant

[English](README.md) | **繁體中文**

讓 Home Assistant 透過藍牙（BLE）直接連接 HiLink **LD2410** 毫米波雷達的整合。

本專案 fork 自 [megarushing/ha-ld2410](https://github.com/megarushing/ha-ld2410)（MIT 授權），另外加入側邊欄調校面板與藍牙密碼的安全強化。

## 功能
- 用 LD2410 雷達即時偵測移動與有人。
- 量測移動目標與靜止目標的距離與能量。
- 每個距離區段（gate）都有能量感測器，可以細分房間的區域。
- 側邊欄「雷達調校」面板：一步步引導完成空房基準、干擾源與有人測試，不用再開手機 App。

## 建議環境

- 用 [ESPHome 藍牙代理](https://esphome.io/components/bluetooth_proxy.html)把 LD2410 連到 Home Assistant。
- LD2410 韌體使用 2.44.24073110 以上版本。
  - 舊韌體可以用 HLKRadarTool App 更新：[Android](https://play.google.com/store/apps/details?id=com.hlk.hlkradartool&hl=en)、[iOS](https://apps.apple.com/us/app/hlkradartool/id1638651152)。
- 雷達同時只接受一個藍牙連線。連 HA 時請關閉手機上的 HLKRadarTool App。
- 遇到問題時，把雷達的電源連續接上、拔掉 5 次，就會恢復出廠設定。

## 安裝

1. 用 HACS 安裝最簡單。點下面的按鈕，依指示操作：
   [![在 Home Assistant 的 HACS 中開啟這個 repository](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=q15503624&repository=ha-ld2410)

   也可以手動加入：
   - a) 打開 HACS，點右上角的 ⋮。
   - b) 選「Custom repositories」。
   - c) 貼上這個 repository 的網址：https://github.com/q15503624/ha-ld2410
   - d) 類型選「Integration」。
   - e) 按「ADD」，然後下載並重新啟動 Home Assistant。

2. 到 **設定 → 裝置與服務**，HA 應該會自動發現 `HLK-LD2410_xxxx`，按「設定」即可。
   沒有自動出現的話，按 **新增整合**，搜尋「LD2410」。藍牙密碼的出廠預設是 `HiLink`。

## 雷達調校面板

安裝並設定好第一台 LD2410 後，管理員帳號的側邊欄會出現 **雷達調校**。想在還沒有裝置時就看到面板，在 `configuration.yaml` 加上這一行，然後重新啟動 Home Assistant：

```yaml
ld2410:
```

有多台雷達時，用頁面上方的下拉選單切換。

### 快速設定（建議第一次使用）

面板最上方是 6 個步驟的引導，照順序做大約 3 分鐘：

| 步驟 | 做什麼 |
|---|---|
| **1. 準備** | 檢查雷達是否已連線、能量感測器有沒有資料；按「一鍵啟用」打開預設停用的能量感測器與最遠偵測閘。 |
| **2. 偵測範圍** | 走到想偵測的最遠位置，頁面會即時顯示你在第幾格；按一下就把範圍設到那裡，避開門外和隔壁房間。 |
| **3. 空房基準** | 離開房間，錄 30 秒的背景雜訊，用色塊表顯示每一格的數值；選擇餘量後，一次套用到全部 18 格的門檻。 |
| **4. 干擾源** | 一次打開一個會動的東西（電風扇、冷氣、窗簾…）錄 20 秒，頁面列出它影響哪一格、能量多少，再把門檻調到干擾之上。 |
| **5. 有人測試** | 坐在平常待的位置，或在房間裡走動，確認每一格偵測得到你；偵測不到的格子會給建議門檻，按一下就能套用。 |
| **6. 完成** | 設定無人延遲，然後儲存門檻，之後可以隨時還原。 |

### 偵測地圖（手動微調）

- 每一欄代表一段距離。柱子是即時能量，橫線是門檻，**柱子超過橫線就算偵測到**。
- 橫線越低越敏感。可以直接在圖上拖動，或點一欄後用 ±1、±5 微調。
- 錄到的雜訊會顯示成橘色的帶子，門檻高過它就不會誤判。
- 每次寫入都會顯示結果：寫入中、雷達已確認、逾時或失敗。
- 每一格都會用白話判斷目前的門檻，例如「門檻 40 低於電風扇的雜訊 52，會誤判」，有問題的格子標 ⚠。
- 不懂門檻的意思？展開「門檻是什麼？為什麼每一格要設不同的數字？」，有圖示說明。

## 實體

> 實體名稱以 HA 上顯示的英文名稱為準。

🏠 **Occupancy（有人）**：綜合移動與靜止判斷的整體狀態。自動化建議用這個，移動和靜止都偵測不到時才會變成「沒人」。

🏃 **Motion（移動）**：偵測到移動就立刻觸發，適合要馬上反應的自動化。

🧍 **Static（靜止）**：偵測到靜止的人（坐著、躺著）。動作停止後，燈或空調仍可以保持開啟。

🔌 **OUT pin（OUT 腳位）**：雷達硬體輸出腳位的目前狀態，方便檢查接線。

📏 **Detect distance（偵測距離）**：偵測到目標的距離（cm），可以用來調整雷達擺放的位置。

🌞 **Photo sensor（光感）**：雷達內建的光感數值（0–255），可以拿來做依環境亮度判斷的自動化。

🎯 **Motion gate 0–8 energy（移動能量）**：每一格的移動能量（0–100%），用來微調移動偵測的區域。

🧊 **Still gate 0–8 energy（靜止能量）**：每一格的靜止能量（0–100%），可以偵測房間裡特定位置有沒有人。

📡 **Moving distance（移動目標距離）**：最近的移動目標距離（cm）。

📍 **Still distance（靜止目標距離）**：最近的靜止目標距離（cm）。

⚡ **Moving energy（移動能量）**：移動目標所在格的最強能量，代表動作的強度。

🔋 **Still energy（靜止能量）**：靜止目標所在格的最強能量。

📈 **Max motion gate（最遠移動閘）**：目前生效的最遠移動偵測格，預設 8，也就是共 9 格。

📊 **Max still gate（最遠靜止閘）**：目前生效的最遠靜止偵測格，預設 8，也就是共 9 格。

🏷️ **Firmware version（韌體版本）**：雷達的韌體版本，回報問題時請附上。

📅 **Firmware build date（韌體建置日期）**：已安裝韌體的建置日期。

🖼️ **Frame type（資料格式）**：雷達送出的是一般（basic）還是工程模式（engineering）資料。整合會盡量自動切到工程模式，每一格的能量要在工程模式下才有。

📶 **Bluetooth signal（藍牙訊號）**：RSSI 強度。訊號弱的話，把雷達移近藍牙代理。

🔑 **變更藍牙密碼**：到 **設定 → 裝置與服務 → LD2410 → 選項**，在「New Bluetooth password」欄位填入新密碼（剛好 6 個可列印的 ASCII 字元），雷達會用新密碼重新開機。這裡用表單而不是實體，是為了不讓密碼被記錄到資料庫。

🤖 **Auto sensitivities（自動校準）**：按鈕。由雷達自動校準每一格的門檻。按下前請先離開房間，校準期間保持空房 10 秒。

💾 **Save sensitivities（儲存門檻）**：按鈕。把目前每一格的門檻存到整合設定，試著調整時不怕調壞。

📥 **Load sensitivities（還原門檻）**：按鈕。把之前儲存的門檻寫回雷達。

♻️ **Reboot device（重新開機）**：按鈕。重新啟動雷達。

🎚️ **MG0–MG8 Sensitivity（移動門檻）**：每一格的移動門檻，數值越低越容易觸發。

🎛️ **SG0–SG8 Sensitivity（靜止門檻）**：每一格的靜止門檻，數值越低越容易觸發。

⏱️ **Absence delay（無人延遲）**：最後一次偵測到人之後，等幾秒才判定沒人，避免人還在時就誤判離開。

📏 **Max motion gate / Max still gate（最遠偵測閘）**：可設定的最遠偵測格（2–8），用來避免偵測到牆外或門外。預設停用，可以在裝置的實體列表中啟用，或在調校面板「準備」步驟一鍵啟用。

🕯️ **Light function（光控功能）**：啟用後，OUT 腳位只在光感「暗於」或「亮於」*光感門檻* 時才會觸發。只影響 OUT 腳位，不影響 HA 裡的有人判斷。

🌗 **Light sensitivity（光感門檻）**：光控功能使用的光感門檻（0–255）。

📐 **Distance resolution（距離解析度）**：每一格代表的距離。0.75 m 時共約 6.75 m；0.20 m 時共約 1.8 m，範圍較近但比較精細。

📤 **OUT level（OUT 腳位準位）**：OUT 腳位的預設電位。可選平時低電位、觸發時變高，或平時高電位、觸發時變低。

## 資料庫（recorder）注意事項

有些感測器每秒會更新好幾次，所以**預設是停用的**。如果啟用了它們，請把它們排除在 recorder 之外，否則資料庫會被塞滿。真實案例：6 台裝置啟用了 `Last frame`，7 天就寫了 370 萬筆，佔整個資料庫的 38%。

把下面這段貼到 `configuration.yaml`，然後重新啟動 Home Assistant。只要裝置還是預設名稱（`HLK-LD2410_XXXX`）都適用：

```yaml
recorder:
  exclude:
    entity_globs:
      - sensor.*_gate_?_energy        # 18 個每格能量感測器
      - sensor.*_last_frame           # 每收到一筆資料就更新
      - sensor.*hlk_ld2410_*_distance
      - sensor.*hlk_ld2410_*_energy
      - sensor.*hlk_ld2410_*_photo_sensor
      - sensor.*hlk_ld2410_*_frame_type
```

**改過裝置名稱和 entity id 嗎？** 那上面含 `hlk_ld2410` 的規則就比對不到了。每一台改過名稱的裝置，都要加上下面幾行，並把 `<device>` 換成新的 entity id 前綴（例如 `sensor.bathroom_sensor_still_energy` 的前綴是 `bathroom_sensor`）：

```yaml
      - sensor.<device>_*_distance
      - sensor.<device>_*_energy
      - sensor.<device>_photo_sensor
      - sensor.<device>_frame_type
```

如果想讓整台裝置都不記錄（含所有感測器與二元感測器）：

```yaml
recorder:
  exclude:
    entity_globs:
      - "*.*hlk_ld2410_*"     # 所有使用預設名稱的裝置
      - "*.<device>_*"        # 每台改過名稱的裝置各一行
```

注意：
- `exclude: domains: [ld2410]` **沒有用**。recorder 的 domain 指的是 `sensor`、`binary_sensor` 這類實體類型，不是整合名稱。
- 排除實體不會刪除已經寫入的資料。要刪除的話，呼叫 `recorder.purge` 並設定 `apply_filter: true`。
- 修改 recorder 設定後，需要重新啟動 Home Assistant。

## 參與開發

歡迎貢獻！建立開發環境的步驟：

1. 建立並啟用虛擬環境：

   ```bash
   python -m venv .venv
   source .venv/bin/activate
   ```

2. 安裝開發用套件：

   ```bash
   pip install -r requirements.dev.txt
   ```

3. 送出 Pull Request 前，執行 linter 和測試：

   ```bash
   ruff check . --fix
   ruff format .
   pytest
   ```

## 已知問題
- 部分 LD2410 因為韌體差異，可能無法正常運作。遇到問題時，請在 GitHub 開 issue，並附上裝置型號與韌體版本。

### 開啟除錯紀錄
回報問題前，請先開啟除錯紀錄，並把紀錄貼在 issue 中，方便找出原因。
在 `configuration.yaml` 加入以下內容，然後重新啟動 Home Assistant：

```yaml
logger:
  default: warn
  logs:
    custom_components.ld2410: debug
```

# 法律聲明
本整合並非由 HiLink 開發、維護或提供，也與 HiLink 沒有任何關係。
