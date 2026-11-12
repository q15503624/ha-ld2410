/**
 * LD2410 調校頁面
 *
 * 由整合自動註冊為側邊欄面板（ld2410-tuning-panel），也可當儀表板卡片使用
 * （custom:ld2410-tuning-card）。進入頁面時從前端的實體清單（hass.entities）
 * 找出所有 ld2410 裝置，用下拉選單切換；所有設定直接寫入目前選擇的雷達。
 *
 * 快速設定：引導使用者錄製空房、干擾源與有人時的各格能量，算出門檻後一次寫入。
 * 偵測地圖：每一欄是一個距離區段（gate），柱子是即時能量、橫線是門檻，
 * 柱子超過橫線就算偵測到。橫線可以直接在圖上拖動。
 */

const PLATFORM = "ld2410";
const STORAGE_KEY = "ld2410-tuning-card:device";
const MODE_KEY = "ld2410-tuning-card:mode"; // "view"（只看數據，預設）或 "edit"
const OPEN_KEY = "ld2410-tuning-card:open:"; // + 區塊代號 → "1" 展開／"0" 收合
const GATES = [...Array(9).keys()];
const PEAK_WINDOW_MS = 10_000;
const CONFIRM_TIMEOUT_MS = 8_000;
const STEP_DEBOUNCE_MS = 600;
const LEAD_SECONDS = { empty: 10, source: 10, person: 5 }; // 開始錄製前讓人離開或就位
const RECORD_SECONDS = { empty: 30, source: 20, person: 20 };
const NOTICEABLE = 5; // 比空房高出這麼多才算「有影響」
const MARGINS = [
  ["穩定", 15, "較不會誤判，但可能偵測不到很輕微的動作"],
  ["標準", 10, "建議"],
  ["靈敏", 5, "反應快，但較容易被干擾誤觸"],
];
const SOURCE_PRESETS = ["電風扇", "冷氣", "窗簾", "寵物", "掃地機器人"];
const DELAYS = [10, 30, 60, 120];
const STEPS = ["準備", "偵測範圍", "空房基準", "干擾源", "有人測試", "完成"];
const WATCH_MINUTES = [10, 30, 60];
const WATCH_LEAD_SECONDS = 30;
const WATCH_MARGIN = 10; // 建議門檻 = 監看期間最高值 + 這個值
const WAVE_SECONDS = 60;
const WAVE_GUTTER = 44; // 波動圖左側標籤寬度（px）
// [代號, 標題, 說明, 預設展開]
const SECTIONS = [
  ["live", "即時雷達", "人在哪裡、每一格的即時波動", true],
  ["map", "偵測地圖", "每一格的能量與門檻，可手動微調", true],
  ["wizard", "快速設定", "第一次使用：照順序做，約 3 分鐘", true],
  ["watch", "無人監看", "人不在時被判定有人？錄一段時間找出原因", true],
  ["settings", "設定與維護", "偵測範圍、無人延遲、光感、校準", false],
];

// "<domain>.<entity_id 結尾>"：整合依實體名稱產生的 entity_id 後綴。
const KEYS = [
  "binary_sensor.occupancy",
  "binary_sensor.motion",
  "binary_sensor.static",
  "sensor.detect_distance",
  "sensor.moving_distance",
  "sensor.still_distance",
  "sensor.photo_sensor",
  "sensor.firmware_version",
  "sensor.signal_strength",
  "sensor.bluetooth_signal",
  ...GATES.flatMap((g) => [
    `sensor.motion_gate_${g}_energy`,
    `sensor.still_gate_${g}_energy`,
    `number.mg${g}_sensitivity`,
    `number.sg${g}_sensitivity`,
  ]),
  "number.absence_delay",
  "number.max_motion_gate",
  "number.max_still_gate",
  "number.light_sensitivity",
  "select.distance_resolution",
  "select.light_function",
  "select.out_level",
  "button.auto_sensitivities",
  "button.save_sensitivities",
  "button.load_sensitivities",
  "button.reboot_device",
];

// 快速設定需要、但整合預設停用的實體。
const NEEDED_KEYS = KEYS.filter((k) => /_energy$|max_(motion|still)_gate$/.test(k));

const KINDS = {
  motion: {
    label: "移動",
    prefix: "mg",
    maxKey: "number.max_motion_gate",
    sensor: "binary_sensor.motion",
    distance: "sensor.moving_distance",
    help: "偵測走動、揮手等明顯動作。",
  },
  still: {
    label: "靜止",
    prefix: "sg",
    maxKey: "number.max_still_gate",
    sensor: "binary_sensor.static",
    distance: "sensor.still_distance",
    help: "偵測坐著、躺著時的呼吸與微動。",
  },
};

// 波動圖的列：上方三列是狀態，下面是移動、靜止各 9 格。
const WAVE_LAYOUT = (() => {
  const rows = [];
  let y = 0;
  for (const [state, label] of [["occupancy", "有人"], ["motion", "移動"], ["static", "靜止"]]) {
    rows.push({ y, h: 10, label, state });
    y += 12;
  }
  for (const kind of Object.keys(KINDS)) {
    y += 6;
    rows.push({ y, h: 12, title: `${KINDS[kind].label}能量` });
    y += 14;
    for (const g of GATES) {
      rows.push({ y, h: 10, label: `G${g}`, kind, g });
      y += 11;
    }
  }
  return { rows, height: y };
})();
const WAVE_HEIGHT = WAVE_LAYOUT.height;

// 俯視扇形圖：雷達在下方中央，每一圈是一格；左半移動、右半靜止。
const SECTOR = { cx: 190, cy: 186, r0: 14, dr: 18, half: 60, gap: 2, personAngle: 31 };
const polar = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [SECTOR.cx + r * Math.sin(a), SECTOR.cy - r * Math.cos(a)].map((v) => +v.toFixed(1));
};
const sectorRadius = (gates) => SECTOR.r0 + clamp(gates, 0, 9) * SECTOR.dr;
const segPath = (g, a1, a2) => {
  const r1 = sectorRadius(g), r2 = r1 + SECTOR.dr;
  return `M${polar(r1, a1)} L${polar(r2, a1)} A${r2} ${r2} 0 0 1 ${polar(r2, a2)} L${polar(r1, a2)} A${r1} ${r1} 0 0 0 ${polar(r1, a1)} Z`;
};
const sectorSvg = () => {
  const wedge = { motion: [-SECTOR.half, -SECTOR.gap], still: [SECTOR.gap, SECTOR.half] };
  const segments = Object.keys(KINDS).flatMap((kind) =>
    GATES.map((g) => `<path class="seg" data-kind="${kind}" data-gate="${g}" d="${segPath(g, ...wedge[kind])}"><title></title></path>`),
  );
  // 圈很密，左邊隔一圈標格數、右邊隔一圈標距離，避免文字擠在一起。
  const labels = GATES.map((g) => {
    if (g % 2 === 0) {
      const [x, y] = polar(sectorRadius(g) + SECTOR.dr / 2, -SECTOR.half - 5);
      return `<text class="ring-label" x="${x}" y="${y}" text-anchor="end" dominant-baseline="middle">G${g}</text>`;
    }
    const [x, y] = polar(sectorRadius(g + 1), SECTOR.half + 5);
    return `<text class="ring-label" data-ring="${g}" x="${x}" y="${y}" dominant-baseline="middle"></text>`;
  });
  const [x8, y8] = polar(sectorRadius(9), SECTOR.half + 5);
  labels.push(`<text class="ring-label" data-ring="8" x="${x8}" y="${y8}" dominant-baseline="middle"></text>`);
  // 移動的距離標在圓點左邊、靜止的標在右邊，兩人靠近時不重疊。
  const persons = Object.keys(KINDS).map((kind) => {
    const [x, anchor] = kind === "motion" ? [-11, "end"] : [11, "start"];
    return `<g class="person" data-kind="${kind}"><circle class="pulse" r="8"></circle><circle r="7"></circle>
      <text x="${x}" text-anchor="${anchor}" dominant-baseline="middle"></text></g>`;
  });
  return `
    <svg class="sector" viewBox="0 0 380 206" role="img" aria-label="雷達俯視圖：左半移動、右半靜止，越外圈越遠">
      ${segments.join("")}${labels.join("")}
      <rect class="radar-dot" x="${SECTOR.cx - 10}" y="${SECTOR.cy - 3}" width="20" height="7" rx="2"></rect>
      <text class="ring-label" x="${SECTOR.cx}" y="${SECTOR.cy + 15}" text-anchor="middle">雷達</text>
      ${persons.join("")}
    </svg>`;
};

const ACTIONS = [
  ["auto_sensitivities", "自動校準", "雷達量測空房的背景雜訊，自動設定全部門檻。", "按下後請離開房間，保持空房至少 10 秒。確定開始？"],
  ["save_sensitivities", "儲存門檻", "把目前 18 個門檻存起來，之後可以還原。", "用目前的門檻覆蓋上次存檔？"],
  ["load_sensitivities", "還原門檻", "把上次儲存的門檻寫回雷達。", "用上次存檔覆蓋雷達目前的門檻？"],
  ["reboot_device", "重新開機", "雷達沒反應或設定沒生效時使用。", "確定要重新開機雷達？"],
];

const OPTION_LABELS = {
  off: "關閉",
  "dimmer than": "暗於門檻時才觸發",
  "brighter than": "亮於門檻時才觸發",
  "default low": "平時低電位（觸發時變高）",
  "default high": "平時高電位（觸發時變低）",
  "0.75 m": "每格 0.75 m（約 6.75 m 內）",
  "0.20 m": "每格 0.20 m（約 1.8 m 內，較精細）",
};

const limitKey = (kind, g) => `number.${KINDS[kind].prefix}${g}_sensitivity`;
const energyKey = (kind, g) => `sensor.${kind}_gate_${g}_energy`;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const same = (a, b) => String(a) === String(b) || (a !== "" && b !== "" && Number(a) === Number(b));
const meters = (v) => `${+v.toFixed(2)}`;
const blankGates = () => ({ motion: GATES.map(() => undefined), still: GATES.map(() => undefined) });
const newWizard = () => ({ step: 0, margin: 10, empty: null, sources: [], person: null, rec: null, sourceName: "" });

const clock = (t) => new Date(t).toLocaleTimeString("zh-TW", { hour12: false });
const stamp = (t) => `${clock(t)}.${Math.floor((t % 1000) / 100)}`;

const storage = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 無法儲存時只是不記住選擇 */
    }
  },
};

class Ld2410TuningCard extends HTMLElement {
  constructor() {
    super();
    this._kind = "motion";
    this._gate = 1;
    this._drag = null; // 正在調整、還沒送出的門檻 {key, value}
    this._pending = {}; // 已送出、等待雷達回報的寫入 key → {value, label, sent, timer, quiet}
    this._history = {}; // 能量歷史 key → [[時間, 值]]，算 10 秒內最高值
    this._wiz = newWizard();
    this._disabledIds = []; // 這台裝置被停用、快速設定需要的實體
    this._watch = null; // 無人監看的錄製與結果
    this._locked = storage.get(MODE_KEY) !== "edit"; // 只看數據：拖動、滑桿不會寫入雷達
    this._wave = []; // 波動圖的取樣 {t, motion[9], still[9], on{occupancy,motion,static}} 或 {t, gap}
    this._wavePausedAt = null;
    this._waveHover = null;
  }

  connectedCallback() {
    this._waveTimer ??= setInterval(() => this._drawWave(), 200);
  }

  disconnectedCallback() {
    clearInterval(this._waveTimer);
    this._waveTimer = undefined;
  }

  setConfig(config) {
    this._config = config || {};
  }

  getCardSize() {
    return 14;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot) this._buildShell();

    const devices = this._findDevices();
    const listKey = devices.map((d) => `${d.id}:${d.name}`).join("|");
    if (listKey !== this._listKey) {
      this._listKey = listKey;
      this._renderPicker(devices);
    }

    const ids = devices.map((d) => d.id);
    if (!ids.includes(this._deviceId)) {
      const saved = storage.get(STORAGE_KEY);
      this._selectDevice(ids.includes(saved) ? saved : ids[0]);
    }

    // 使用者剛啟用/停用實體時重新對應。
    const map = this._mapEntities(this._deviceId);
    const mapKey = Object.values(map).sort().join("|");
    if (mapKey !== this._mapKey) {
      this._map = map;
      this._mapKey = mapKey;
      this._renderBody();
      this._loadDisabled();
    }
    this._recordEnergy();
    this._recordWave();
    this._sampleRecording();
    this._sampleWatch();
    this._update();
  }

  // ── 資料 ────────────────────────────────────────────

  _findDevices() {
    const ids = new Set();
    for (const entry of Object.values(this._hass.entities || {})) {
      if (entry.platform === PLATFORM && entry.device_id) ids.add(entry.device_id);
    }
    return [...ids]
      .map((id) => {
        const device = this._hass.devices?.[id];
        return { id, name: device?.name_by_user || device?.name || id };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  _mapEntities(deviceId, entries = Object.values(this._hass.entities)) {
    const map = {};
    if (!deviceId) return map;
    for (const entry of entries) {
      if (entry.platform !== PLATFORM || entry.device_id !== deviceId) continue;
      const [domain] = entry.entity_id.split(".");
      for (const key of KEYS) {
        const [keyDomain, suffix] = key.split(".");
        if (domain === keyDomain && entry.entity_id.endsWith(`_${suffix}`)) map[key] = entry.entity_id;
      }
    }
    return map;
  }

  /** 從實體註冊表找出被停用的能量／最遠閘實體（面板限管理員，可讀註冊表）。 */
  async _loadDisabled() {
    const deviceId = this._deviceId;
    if (!deviceId || !this._hass.callWS) return;
    try {
      const entries = await this._hass.callWS({ type: "config/entity_registry/list" });
      const disabled = entries.filter((e) => e.disabled_by);
      const map = this._mapEntities(deviceId, disabled);
      if (deviceId !== this._deviceId) return;
      this._disabledIds = NEEDED_KEYS.map((k) => map[k]).filter(Boolean);
    } catch {
      this._disabledIds = [];
    }
    this._update();
  }

  async _enableNeeded() {
    const ids = this._disabledIds;
    this._setStatus("busy", `啟用 ${ids.length} 個實體中…`);
    try {
      for (const entity_id of ids) {
        await this._hass.callWS({ type: "config/entity_registry/update", entity_id, disabled_by: null });
      }
      this._disabledIds = [];
      const message = `已啟用 ${ids.length} 個實體。HA 約 30 秒後會重新載入裝置，完成後這裡會自動打勾。`;
      this._setStatus("ok", message);
      this._toast(message);
    } catch (err) {
      this._setStatus("error", `啟用失敗${err?.message ? `（${err.message}）` : ""}`);
    }
    this._update();
  }

  _state(key) {
    const entityId = this._map[key];
    return entityId ? this._hass.states[entityId] : undefined;
  }

  _value(key) {
    const state = this._state(key);
    if (!state || ["unknown", "unavailable"].includes(state.state)) return undefined;
    return state.state;
  }

  _number(key) {
    const value = Number(this._value(key));
    return Number.isFinite(value) ? value : undefined;
  }

  /** 畫面上該顯示的門檻：調整中的值 > 送出中的值 > 雷達回報的值。 */
  _limit(key) {
    if (this._drag?.key === key) return this._drag.value;
    if (this._pending[key]) return Number(this._pending[key].value);
    return this._number(key);
  }

  _step() {
    return this._value("select.distance_resolution") === "0.20 m" ? 0.2 : 0.75;
  }

  _maxGate(kind) {
    return this._limit(KINDS[kind].maxKey) ?? 8;
  }

  _distanceText(g) {
    const step = this._step();
    return `${meters(g * step)}–${meters((g + 1) * step)} m`;
  }

  /** 目前偵測到的目標在哪一格。 */
  _targetGate(kind) {
    const sensor = kind ? KINDS[kind].sensor : "binary_sensor.occupancy";
    const distance = kind ? KINDS[kind].distance : "sensor.detect_distance";
    if (this._value(sensor) !== "on") return undefined;
    const cm = this._number(distance);
    return cm === undefined ? undefined : Math.min(8, Math.floor(cm / 100 / this._step()));
  }

  _energyReady() {
    return GATES.every((g) => this._number(energyKey("motion", g)) !== undefined && this._number(energyKey("still", g)) !== undefined);
  }

  _recordEnergy() {
    if (!this._deviceId) return;
    const now = Date.now();
    for (const kind of Object.keys(KINDS)) {
      for (const g of GATES) {
        const key = energyKey(kind, g);
        const value = this._number(key);
        const list = (this._history[key] ||= []);
        if (value !== undefined) list.push([now, value]);
        while (list.length && now - list[0][0] > PEAK_WINDOW_MS) list.shift();
      }
    }
  }

  _peak(key) {
    const list = this._history[key];
    return list?.length ? Math.max(...list.map(([, v]) => v)) : undefined;
  }

  /** 空房加上所有干擾源錄到的最高能量。 */
  _noise(kind, g) {
    const values = [this._wiz.empty, ...this._wiz.sources.map((s) => s.max)]
      .map((max) => max?.[kind][g])
      .filter((v) => v !== undefined);
    return values.length ? Math.max(...values) : undefined;
  }

  _selectDevice(id) {
    this._deviceId = id;
    this._mapKey = undefined;
    this._history = {};
    this._wave = [];
    this._wavePausedAt = null;
    this._drag = null;
    for (const p of Object.values(this._pending)) clearTimeout(p.timer);
    this._pending = {};
    clearInterval(this._wiz.rec?.timer);
    this._wiz = newWizard();
    clearInterval(this._watch?.timer);
    this._watch = null;
    this._disabledIds = [];
    if (id) storage.set(STORAGE_KEY, id);
    const picker = this.shadowRoot.getElementById("device");
    if (picker && id) picker.value = id;
  }

  // ── 即時雷達 ────────────────────────────────────────

  /** 能量或狀態有變化時記一筆，保留最近 WAVE_SECONDS 秒；暫停時凍結。 */
  _recordWave() {
    if (!this._deviceId || this._wavePausedAt) return;
    const now = Date.now();
    const sample = {
      t: now,
      motion: GATES.map((g) => this._number(energyKey("motion", g))),
      still: GATES.map((g) => this._number(energyKey("still", g))),
      on: Object.fromEntries(["occupancy", "motion", "static"].map((k) => [k, this._value(`binary_sensor.${k}`) === "on"])),
    };
    const last = this._wave.at(-1);
    const key = (x) => JSON.stringify([x.motion, x.still, x.on]);
    if (last && !last.gap && key(last) === key(sample)) return;
    this._wave.push(sample);
    while (this._wave.length > 1 && now - this._wave[1].t > WAVE_SECONDS * 1000) this._wave.shift();
  }

  _toggleWavePause() {
    if (this._wavePausedAt) {
      this._wave.push({ t: Date.now(), gap: true }); // 暫停期間沒有資料
      this._wavePausedAt = null;
    } else {
      this._wavePausedAt = Date.now();
    }
    this._update();
    this._drawWave();
  }

  _drawWave() {
    const canvas = this.shadowRoot?.getElementById("wave");
    const width = canvas?.clientWidth;
    if (!width || !canvas.closest("details")?.open) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(WAVE_HEIGHT * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);

    const css = getComputedStyle(this);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const c = {
      text: color("--secondary-text-color", "#727272"),
      grid: color("--divider-color", "rgba(0,0,0,0.12)"),
      base: color("--primary-color", "#03a9f4"),
      hit: color("--error-color", "#db4437"),
      off: color("--disabled-text-color", "#bdbdbd"),
      occupancy: color("--primary-color", "#03a9f4"),
      motion: color("--warning-color", "#ffa000"),
      static: color("--success-color", "#43a047"),
    };
    const span = WAVE_SECONDS * 1000;
    const now = this._wavePausedAt ?? Date.now();
    const plot = width - WAVE_GUTTER;
    const x = (t) => WAVE_GUTTER + ((t - (now - span)) / span) * plot;
    const fill = (style, alpha, x1, row, w) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = style;
      ctx.fillRect(x1, row.y, w, row.h);
    };

    ctx.font = "10px sans-serif";
    ctx.textBaseline = "middle";
    for (const row of WAVE_LAYOUT.rows) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = c.text;
      ctx.fillText(row.title ?? row.label, row.title ? 0 : 8, row.y + row.h / 2);
      if (!row.title) fill(c.text, 0.06, WAVE_GUTTER, row, plot);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c.grid;
    for (let sec = 10; sec < WAVE_SECONDS; sec += 10) {
      ctx.beginPath();
      ctx.moveTo(x(now - sec * 1000), 0);
      ctx.lineTo(x(now - sec * 1000), WAVE_HEIGHT);
      ctx.stroke();
    }

    const limit = {}, maxGate = {};
    for (const kind of Object.keys(KINDS)) {
      limit[kind] = GATES.map((g) => this._number(limitKey(kind, g)));
      maxGate[kind] = this._maxGate(kind);
    }
    this._wave.forEach((sample, i) => {
      if (sample.gap) return;
      const x1 = Math.max(WAVE_GUTTER, x(sample.t));
      const x2 = Math.min(width, x(this._wave[i + 1]?.t ?? now));
      if (x2 <= x1) return;
      for (const row of WAVE_LAYOUT.rows) {
        if (row.title) continue;
        if (row.state) {
          if (sample.on[row.state]) fill(c[row.state], 0.9, x1, row, Math.max(1, x2 - x1));
          continue;
        }
        const v = sample[row.kind][row.g];
        if (v === undefined) continue;
        const lim = limit[row.kind][row.g];
        if (row.g > maxGate[row.kind]) fill(c.off, 0.15, x1, row, x2 - x1);
        // 超過門檻至少畫 3px 寬，0.1 秒的瞬間誤判也看得到。
        else if (lim !== undefined && v >= lim) fill(c.hit, 0.45 + (0.55 * v) / 100, x1, row, Math.max(3, x2 - x1));
        else fill(c.base, 0.05 + (0.75 * v) / 100, x1, row, x2 - x1);
      }
    });

    if (this._waveHover?.x > WAVE_GUTTER) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c.text;
      ctx.beginPath();
      ctx.moveTo(this._waveHover.x, 0);
      ctx.lineTo(this._waveHover.x, WAVE_HEIGHT);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** 游標所在那一刻、那一列的數值。 */
  _readWave() {
    const out = this.shadowRoot.getElementById("wave-read");
    if (!out) return;
    const hover = this._waveHover;
    const row = hover && WAVE_LAYOUT.rows.find((r) => !r.title && hover.y >= r.y && hover.y <= r.y + r.h);
    const width = this.shadowRoot.getElementById("wave").clientWidth;
    if (!row || hover.x < WAVE_GUTTER || !width) {
      out.textContent = this._wavePausedAt
        ? "已暫停：把游標移到色塊上，看那一刻是哪一格、能量多少。"
        : "把游標移到色塊上看那一刻的數值。看到紅色時先按「暫停」再細看。";
      return;
    }
    const now = this._wavePausedAt ?? Date.now();
    const t = now - WAVE_SECONDS * 1000 + ((hover.x - WAVE_GUTTER) / (width - WAVE_GUTTER)) * WAVE_SECONDS * 1000;
    const sample = this._wave.findLast((x) => x.t <= t);
    if (!sample || sample.gap) {
      out.textContent = `${stamp(t)}：沒有資料`;
    } else if (row.state) {
      out.textContent = `${stamp(t)} · ${row.label}：${sample.on[row.state] ? "是" : "否"}`;
    } else {
      const v = sample[row.kind][row.g];
      const limit = this._number(limitKey(row.kind, row.g));
      const over = v !== undefined && limit !== undefined && v >= limit;
      out.textContent =
        `${stamp(t)} · ${KINDS[row.kind].label} Gate ${row.g}（${this._distanceText(row.g)}）：` +
        `能量 ${v ?? "—"}，門檻 ${limit ?? "—"}${over ? " → 超過，判定有人" : ""}`;
    }
  }

  _updateLive() {
    const root = this.shadowRoot;
    const head = root.getElementById("live-state");
    if (!head) return;
    const occupancy = this._state("binary_sensor.occupancy");
    const kinds = Object.values(KINDS).filter((k) => this._value(k.sensor) === "on").map((k) => k.label);
    let [state, big, sub] = ["off", "沒有人", "雷達正常運作中"];
    if (!occupancy || occupancy.state === "unavailable") {
      [state, big, sub] = ["offline", "雷達離線", "確認電源、藍牙代理，並關閉手機 App"];
    } else if (occupancy.state === "on") {
      const cm = this._number("sensor.detect_distance");
      const gate = this._targetGate();
      state = "on";
      big = "有人";
      sub = [kinds.join("＋") || "偵測中", cm === undefined ? "" : `約 ${meters(cm / 100)} m`].filter(Boolean).join(" · ");
      if (gate !== undefined) sub += `（Gate ${gate}）`;
    }
    head.className = `live-state ${state}`;
    head.querySelector(".big").textContent = big;
    head.querySelector("small").textContent = sub;

    const step = this._step();
    for (const seg of root.querySelectorAll(".seg")) {
      const kind = seg.dataset.kind;
      const g = Number(seg.dataset.gate);
      const energy = this._number(energyKey(kind, g));
      const limit = this._limit(limitKey(kind, g));
      const off = g > this._maxGate(kind);
      seg.classList.toggle("off", off);
      seg.classList.toggle("hit", !off && energy !== undefined && limit !== undefined && energy >= limit);
      seg.classList.toggle("sel", kind === this._kind && g === this._gate);
      seg.style.fillOpacity = off ? "" : String(+(0.08 + ((energy ?? 0) / 100) * 0.82).toFixed(3));
      seg.querySelector("title").textContent =
        `${KINDS[kind].label} Gate ${g}（${this._distanceText(g)}）：能量 ${energy ?? "—"}，門檻 ${limit ?? "—"}` +
        (off ? "，超出偵測範圍" : "");
    }
    for (const label of root.querySelectorAll("[data-ring]")) {
      label.textContent = `${meters((Number(label.dataset.ring) + 1) * step)}m`;
    }
    for (const [kind, k] of Object.entries(KINDS)) {
      const person = root.querySelector(`.person[data-kind="${kind}"]`);
      const cm = this._number(k.distance);
      const show = this._value(k.sensor) === "on" && cm !== undefined;
      person.classList.toggle("show", show);
      if (!show) continue;
      const [px, py] = polar(sectorRadius(cm / 100 / step), kind === "motion" ? -SECTOR.personAngle : SECTOR.personAngle);
      person.style.transform = `translate(${px}px, ${py}px)`;
      person.querySelector("text").textContent = `${meters(cm / 100)} m`;
    }

    const pause = root.getElementById("wave-pause");
    if (pause) pause.textContent = this._wavePausedAt ? "▶ 繼續" : "⏸ 暫停";
    if (pause) pause.classList.toggle("on", Boolean(this._wavePausedAt));
    this._readWave();
  }

  _section(sec, inner, cls = "") {
    const [, title, sub, open] = SECTIONS.find(([s]) => s === sec);
    const saved = storage.get(`${OPEN_KEY}${sec}`);
    return `
      <details class="box ${cls}" data-sec="${sec}" ${(saved ? saved === "1" : open) ? "open" : ""}>
        <summary><h3>${title}</h3><small class="muted">${sub}</small></summary>
        <div class="box-body">${inner}</div>
      </details>`;
  }

  _jump(sec) {
    const details = this.shadowRoot.querySelector(`details[data-sec="${sec}"]`);
    details.open = true;
    details.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  // ── 寫入與回饋 ──────────────────────────────────────

  /**
   * 寫入一個設定，並在雷達回報新值（或失敗、逾時）時告訴使用者。
   * 回傳的 Promise 在服務呼叫完成時給出成功與否；quiet 時由呼叫端統一回報。
   */
  _write(key, value, label, quiet = false) {
    const entityId = this._map[key];
    if (!entityId) return Promise.resolve(false);
    const domain = key.split(".")[0];
    const [service, data] =
      domain === "select" ? ["select_option", { option: value }] : ["set_value", { value: Number(value) }];

    clearTimeout(this._pending[key]?.timer);
    const pending = (this._pending[key] = { value, label, quiet });
    if (!quiet) this._setStatus("busy", `寫入中：${label} → ${display(value)}…`);
    const done = this._hass.callService(domain, service, { entity_id: entityId, ...data }).then(
      () => {
        pending.sent = true;
        pending.timer = setTimeout(() => this._settle(key, pending, "warn"), CONFIRM_TIMEOUT_MS);
        this._update();
        return true;
      },
      (err) => {
        this._settle(key, pending, "error", err?.message);
        return false;
      },
    );
    this._update();
    return done;
  }

  _settle(key, pending, result, detail) {
    if (this._pending[key] !== pending) return; // 已被較新的寫入取代
    clearTimeout(pending.timer);
    delete this._pending[key];
    if (!pending.quiet) {
      const what = `${pending.label} = ${display(pending.value)}`;
      const message = {
        ok: `已寫入雷達：${what}`,
        warn: `已送出，但雷達還沒回報新值：${what}。請確認藍牙連線。`,
        error: `寫入失敗：${what}${detail ? `（${detail}）` : ""}`,
      }[result];
      this._setStatus(result, message);
      this._toast(message);
    }
    this._update();
  }

  /** 依序寫入多個設定（藍牙一次只能處理一個指令），最後統一回報。 */
  async _applyAll(targets, title) {
    const todo = targets.filter(([key, value]) => this._map[key] && !same(value, this._number(key)));
    if (!todo.length) {
      this._setStatus("ok", `${title}：目前的設定已經是建議值，不用修改。`);
      return;
    }
    this._applying = true;
    this._renderWizard();
    this._renderWatch();
    let failed = 0;
    for (const [i, [key, value, label]] of todo.entries()) {
      this._setStatus("busy", `${title}：寫入 ${i + 1}/${todo.length}（${label} → ${value}）…`);
      if (!(await this._write(key, value, label, true))) failed++;
    }
    this._applying = false;
    const message = failed
      ? `${title}：${todo.length - failed} 項成功，${failed} 項失敗。請確認藍牙連線後再按一次。`
      : `${title}：已寫入 ${todo.length} 項設定。`;
    this._setStatus(failed ? "error" : "ok", message);
    this._toast(message);
    this._renderWizard();
    this._renderWatch();
  }

  _press(key, label) {
    this._setStatus("busy", `執行中：${label}…`);
    this._hass.callService("button", "press", { entity_id: this._map[`button.${key}`] }).then(
      () => this._setStatus("ok", `已送出：${label}`),
      (err) => {
        const message = `${label}失敗${err?.message ? `（${err.message}）` : ""}`;
        this._setStatus("error", message);
        this._toast(message);
      },
    );
  }

  _setStatus(type, message) {
    const el = this.shadowRoot.getElementById("status");
    if (!el) return;
    el.className = `statusbar ${type}`;
    el.textContent = message;
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  _toggleMode() {
    this._commit();
    this._locked = !this._locked;
    storage.set(MODE_KEY, this._locked ? "view" : "edit");
    this._update();
  }

  /** 拖動或 ± 調整門檻；commit 時才送出。 */
  _adjust(value, commit) {
    const key = limitKey(this._kind, this._gate);
    if (this._locked || !this._map[key]) return;
    this._drag = { key, value: clamp(Math.round(value), 0, 100) };
    if (commit) this._commit();
    else this._update();
  }

  _commit() {
    clearTimeout(this._stepTimer);
    const drag = this._drag;
    this._drag = null;
    if (!drag) return;
    if (same(drag.value, this._number(drag.key))) return this._update();
    this._write(drag.key, drag.value, this._gateLabel(this._kind, this._gate));
  }

  _gateLabel(kind, g) {
    return `Gate ${g} ${KINDS[kind].label}門檻`;
  }

  // ── 快速設定：錄製 ──────────────────────────────────

  _startRecording(purpose, extra = {}) {
    this._cancelRecording();
    const rec = { purpose, ...extra, max: blankGates(), samples: 0, phase: "lead" };
    rec.end = Date.now() + LEAD_SECONDS[purpose] * 1000;
    rec.timer = setInterval(() => this._tickRecording(), 250);
    this._wiz.rec = rec;
    this._renderWizard();
  }

  _cancelRecording() {
    clearInterval(this._wiz.rec?.timer);
    this._wiz.rec = null;
  }

  _tickRecording() {
    const rec = this._wiz.rec;
    if (!rec) return;
    const now = Date.now();
    if (rec.phase === "lead" && now >= rec.end) {
      rec.phase = "rec";
      rec.end = now + RECORD_SECONDS[rec.purpose] * 1000;
    }
    this._sampleRecording();
    if (rec.phase === "rec" && now >= rec.end) this._finishRecording();
    else this._updateWizard();
  }

  _sampleRecording() {
    const rec = this._wiz.rec;
    if (rec?.phase !== "rec") return;
    for (const kind of Object.keys(KINDS)) {
      for (const g of GATES) {
        const value = this._number(energyKey(kind, g));
        if (value === undefined) continue;
        rec.max[kind][g] = Math.max(rec.max[kind][g] ?? 0, value);
        rec.samples++;
      }
    }
  }

  _finishRecording() {
    const rec = this._wiz.rec;
    this._cancelRecording();
    if (!rec.samples) {
      this._setStatus("error", "錄製期間沒有收到能量資料：請先完成「準備」步驟，啟用能量感測器。");
    } else {
      if (rec.purpose === "empty") this._wiz.empty = rec.max;
      if (rec.purpose === "source") this._wiz.sources.push({ name: rec.name, max: rec.max });
      if (rec.purpose === "person") this._wiz.person = { kind: rec.kind, max: rec.max };
      this._setStatus("ok", "錄製完成，請看結果。");
      this._toast("LD2410 錄製完成");
    }
    this._renderWizard();
    this._update();
  }

  // ── 無人監看：抓偶發誤判 ────────────────────────────

  _startWatch(minutes) {
    clearInterval(this._watch?.timer);
    this._watch = {
      minutes,
      phase: "lead",
      end: Date.now() + WATCH_LEAD_SECONDS * 1000,
      max: blankGates(),
      hits: blankGates(), // 超過門檻的次數（從低於到超過算一次）
      first: blankGates(), // 第一次超過的時間
      above: blankGates(),
      events: [], // 「有人」從否變成是的時間
      samples: 0,
      timer: setInterval(() => this._tickWatch(), 1000),
    };
    this._renderWatch();
  }

  _tickWatch() {
    const watch = this._watch;
    if (!watch || watch.phase === "done") return;
    const now = Date.now();
    if (watch.phase === "lead" && now >= watch.end) {
      Object.assign(watch, { phase: "rec", start: now, end: now + watch.minutes * 60_000 });
      watch.occupied = this._value("binary_sensor.occupancy") === "on";
      this._renderWatch();
    }
    this._sampleWatch();
    if (watch.phase === "rec" && now >= watch.end) this._finishWatch();
    else this._updateWatch();
  }

  _sampleWatch() {
    const watch = this._watch;
    const now = Date.now();
    if (watch?.phase !== "rec" || now > watch.end) return;
    for (const kind of Object.keys(KINDS)) {
      for (const g of GATES) {
        const value = this._number(energyKey(kind, g));
        if (value === undefined) continue;
        watch.samples++;
        watch.max[kind][g] = Math.max(watch.max[kind][g] ?? 0, value);
        const limit = this._number(limitKey(kind, g));
        const above = limit !== undefined && g <= this._maxGate(kind) && value >= limit;
        if (above && !watch.above[kind][g]) {
          watch.hits[kind][g] = (watch.hits[kind][g] ?? 0) + 1;
          watch.first[kind][g] ??= now;
        }
        watch.above[kind][g] = above;
      }
    }
    const occupied = this._value("binary_sensor.occupancy") === "on";
    if (occupied && !watch.occupied) {
      const kinds = Object.values(KINDS).filter((k) => this._value(k.sensor) === "on").map((k) => k.label);
      watch.events.push({ t: now, kinds });
    }
    watch.occupied = occupied;
  }

  _finishWatch() {
    const watch = this._watch;
    clearInterval(watch.timer);
    if (watch.phase === "lead") {
      this._watch = null;
    } else {
      Object.assign(watch, { phase: "done", end: Date.now() });
      // 當成一個干擾源，偵測地圖的雜訊帶與診斷也會用到。
      if (watch.samples) this._wiz.sources.push({ name: `無人監看 ${clock(watch.start)}–${clock(watch.end)}`, max: watch.max });
      this._toast("LD2410 無人監看完成");
    }
    this._renderWatch();
    this._renderWizard();
    this._update();
  }

  /** 監看期間超過或接近門檻的格子，超過的排前面。 */
  _watchRows() {
    const watch = this._watch;
    const rows = [];
    for (const kind of Object.keys(KINDS)) {
      for (const g of GATES) {
        const max = watch.max[kind][g];
        const limit = this._limit(limitKey(kind, g));
        if (max === undefined || limit === undefined || g > this._maxGate(kind)) continue;
        const hits = watch.hits[kind][g] ?? 0;
        if (!hits && max < limit - NOTICEABLE) continue;
        rows.push({ kind, g, max, limit, hits, first: watch.first[kind][g], suggest: clamp(max + WATCH_MARGIN, 0, 100) });
      }
    }
    return rows.sort((a, b) => b.hits - a.hits || b.max - b.limit - (a.max - a.limit));
  }

  /** 只調高被觸發過、目前門檻還擋不住的格子。 */
  _watchTargets() {
    return this._watchRows()
      .filter((r) => r.hits && r.suggest > r.limit && r.suggest < 100)
      .map((r) => [limitKey(r.kind, r.g), r.suggest, this._gateLabel(r.kind, r.g)]);
  }

  // ── 快速設定：分析 ──────────────────────────────────

  _noiseTargets() {
    const targets = [];
    for (const kind of Object.keys(KINDS)) {
      for (const g of GATES) {
        const noise = this._noise(kind, g);
        if (noise !== undefined) {
          targets.push([limitKey(kind, g), clamp(noise + this._wiz.margin, 0, 100), this._gateLabel(kind, g)]);
        }
      }
    }
    return targets;
  }

  /** 干擾源比空房高出明顯的格子：[{g, motion, still}] */
  _impact(source) {
    return GATES.map((g) => {
      const row = { g };
      for (const kind of Object.keys(KINDS)) {
        const value = source.max[kind][g];
        if (value !== undefined && value >= (this._wiz.empty?.[kind][g] ?? 0) + NOTICEABLE) row[kind] = value;
      }
      return row;
    }).filter((row) => row.motion !== undefined || row.still !== undefined);
  }

  /** 有人時能量明顯高於雜訊的格子，以及要不要降低門檻。 */
  _personRows() {
    const person = this._wiz.person;
    if (!person) return [];
    const { kind, max } = person;
    return GATES.map((g) => {
      const energy = max[kind][g];
      const noise = this._noise(kind, g) ?? 0;
      if (energy === undefined || energy < noise + NOTICEABLE) return undefined;
      const limit = this._number(limitKey(kind, g));
      const suggest = Math.max(noise + 3, Math.round((energy + noise) / 2));
      return { g, energy, noise, limit, off: g > this._maxGate(kind), ok: limit !== undefined && energy >= limit, suggest };
    }).filter(Boolean);
  }

  /** 這一格的雜訊主要來自哪個干擾源（沒有明顯來源時回傳 undefined）。 */
  _noiseSource(kind, g) {
    let best;
    for (const source of this._wiz.sources) {
      const value = source.max[kind][g];
      const base = this._wiz.empty?.[kind][g] ?? 0;
      if (value !== undefined && value >= base + NOTICEABLE && (!best || value > best.value)) best = { name: source.name, value };
    }
    return best?.name;
  }

  /**
   * 用白話判斷這一格的門檻設得好不好。
   * level：bad（會誤判或漏判）、warn（邊緣）、ok、info（無法判斷或提醒）。
   */
  _diagnose(kind, g) {
    const limit = this._limit(limitKey(kind, g));
    if (limit === undefined) return { level: "info", text: "" };
    if (g > this._maxGate(kind)) return { level: "info", text: "這格超出偵測範圍，不論門檻多少都不會偵測。" };
    if (limit >= 100) return { level: "warn", text: "門檻 100：能量不可能超過，這格等於關閉。" };

    const noise = this._noise(kind, g);
    const from = this._noiseSource(kind, g);
    const source = from ? `「${from}」造成的` : "空房的";
    const person = this._wiz.person?.kind === kind ? this._wiz.person.max[kind][g] : undefined;
    const sawPerson = person !== undefined && person >= (noise ?? 0) + NOTICEABLE;

    if (noise !== undefined && limit <= noise) {
      return { level: "bad", text: `門檻 ${limit} 低於${source}雜訊 ${noise}：沒人時也會判定有人（誤判）。建議至少 ${clamp(noise + 10, 0, 100)}。` };
    }
    if (sawPerson && person < limit) {
      return { level: "bad", text: `有人測試時你的能量只有 ${person}，碰不到門檻 ${limit}：坐在這個距離可能偵測不到（漏判）。` };
    }
    if (noise === undefined) {
      if (limit <= 10) return { level: "warn", text: `門檻 ${limit} 很低：一點點雜訊就會觸發。先做「空房基準」才知道是否會誤判。` };
      return { level: "info", text: "還沒錄製雜訊：先做快速設定的「空房基準」，這裡就能判斷這個門檻合不合理。" };
    }
    const gap = limit - noise;
    if (gap < 5) return { level: "warn", text: `門檻只比${source}雜訊（${noise}）高 ${gap}：偶爾可能誤判，可再調高一點。` };
    if (gap > 40 && !sawPerson) {
      return { level: "warn", text: `門檻比雜訊高 ${gap}：不會誤判，但輕微動作或坐著不動可能偵測不到。做「有人測試」確認。` };
    }
    return { level: "ok", text: `門檻比雜訊（${noise}）高 ${gap}${sawPerson ? `，有人時能量 ${person} 也碰得到` : ""}：設定合理。` };
  }

  // ── 畫面 ────────────────────────────────────────────

  _buildShell() {
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <ha-icon icon="mdi:radar"></ha-icon>
          <span class="title">LD2410 雷達調校</span>
          <button id="mode" class="chip-btn"></button>
          <select id="device" aria-label="選擇裝置"></select>
        </div>
        <div id="body"></div>
      </ha-card>`;
    this.shadowRoot.getElementById("mode").addEventListener("click", () => this._toggleMode());
    this.shadowRoot.getElementById("device").addEventListener("change", (ev) => {
      this._selectDevice(ev.target.value);
      this.hass = this._hass;
    });
  }

  _renderPicker(devices) {
    const picker = this.shadowRoot.getElementById("device");
    picker.innerHTML = devices.length
      ? devices.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join("")
      : `<option value="">找不到 LD2410 裝置</option>`;
    picker.disabled = devices.length < 2;
    if (this._deviceId) picker.value = this._deviceId;
  }

  _renderBody() {
    const body = this.shadowRoot.getElementById("body");
    if (!this._deviceId) {
      body.innerHTML = `
        <div class="empty">
          <p>還沒有設定任何 LD2410 裝置。</p>
          <ol>
            <li>雷達接上電源，並關閉手機上的 HLKRadarTool App（雷達同時只接受一個藍牙連線）。</li>
            <li>到「設定 → 裝置與服務」，等 HA 自動發現 <b>HLK-LD2410_xxxx</b> 後按「設定」；或按「新增整合」搜尋 LD2410。</li>
            <li>輸入藍牙密碼（出廠預設 HiLink），完成後這裡會自動出現裝置。</li>
          </ol>
        </div>`;
      return;
    }
    const hasEnergy = GATES.some((g) => this._map[energyKey("motion", g)]);
    body.innerHTML = `
      <nav class="jump">
        ${SECTIONS.map(([sec, title]) => `<button data-jump="${sec}">${title}</button>`).join("")}
      </nav>

      ${this._section("live", `
        <div class="live-head">
          <div id="live-state" class="live-state"><span class="big"></span><small></small></div>
          <div class="status">
            ${chip("binary_sensor.occupancy", "有人", "mdi:home-account")}
            ${chip("binary_sensor.motion", "移動", "mdi:run")}
            ${chip("binary_sensor.static", "靜止", "mdi:human-handsdown")}
          </div>
          <div class="facts">
            ${fact("sensor.detect_distance", "目標距離", "cm")}
            ${fact("sensor.photo_sensor", "光感", "")}
          </div>
        </div>
        <div class="live-grid">
          <figure class="sector-box">
            ${sectorSvg()}
            <figcaption><span>◀ 左半：移動</span><span>雷達在下方，越外圈越遠</span><span>右半：靜止 ▶</span></figcaption>
          </figure>
          <div class="wave-box">
            ${
              hasEnergy
                ? `<div class="wave-tools">
                    <b>最近 ${WAVE_SECONDS} 秒的波動</b>
                    <button id="wave-pause" class="chip-btn"></button>
                  </div>
                  <canvas id="wave" height="${WAVE_HEIGHT}"></canvas>
                  <div class="wave-axis"><span>${WAVE_SECONDS} 秒前</span><span>${WAVE_SECONDS / 2} 秒前</span><span>現在</span></div>
                  <p id="wave-read" class="wave-read"></p>`
                : `<p class="hint">看不到波動：請先完成「快速設定 → 準備」，啟用能量感測器。</p>`
            }
          </div>
        </div>
        <p class="explain">顏色越深代表那一格的能量越強，<b class="sw hit-sw"></b>紅色代表超過門檻（雷達會判定有人）。
          瞬間的誤判在波動圖上是一個短短的紅點：看到時按「暫停」，把游標移上去就知道是哪一格、多少能量。點扇形圖的任一格可以到偵測地圖調整。</p>`)}

      ${this._section("map", `
        <div class="tabs" role="tablist">
          ${Object.entries(KINDS)
            .map(([kind, k]) => `<button role="tab" data-kind="${kind}">${k.label}偵測</button>`)
            .join("")}
        </div>
        <p class="explain">
          <span id="kind-help"></span>
          每一欄是一段距離。<b class="sw fill-sw"></b>柱子是即時能量，<b class="sw line-sw"></b>橫線是門檻：
          <b>柱子超過橫線就算偵測到</b>。橫線越低越敏感。直接在圖上拖動橫線，或點一欄後在下方微調。
        </p>
        ${LEARN}
        <div id="diag-summary" class="diag-summary"></div>
        ${hasEnergy ? "" : `<p class="hint">看不到能量柱：請先完成「快速設定 → 準備」，啟用能量感測器。門檻一樣可以調整。</p>`}
        <div class="chart">
          ${GATES.map(
            (g) => `
            <div class="col" data-gate="${g}">
              <div class="plot" aria-label="Gate ${g}">
                <div class="noise" title="空房與干擾源錄到的最高能量"></div>
                <div class="fill"></div>
                <div class="peak" title="10 秒內最高能量"></div>
                <div class="line"><span class="val"></span></div>
                <ha-icon class="target" icon="mdi:account"></ha-icon>
                <span class="offtext">不偵測</span>
              </div>
              <div class="axis"><b>${g}<span class="flag"></span></b><small class="dist"></small></div>
            </div>`,
          ).join("")}
        </div>
        <div class="legend">
          <span><b class="sw fill-sw"></b>能量</span><span><b class="sw hit-sw"></b>超過門檻</span>
          <span><b class="sw line-sw"></b>門檻</span><span><b class="sw peak-sw"></b>10 秒內最高</span>
          <span><b class="sw noise-sw"></b>錄到的雜訊</span>
          <span><ha-icon icon="mdi:account"></ha-icon>目前目標</span>
        </div>

        <div class="editor">
          <div class="ed-title"><b id="ed-name"></b><span id="ed-dist"></span><span id="ed-state" class="badge"></span></div>
          <div class="ed-row">
            <button class="step" data-step="-5" aria-label="門檻 -5">−5</button>
            <button class="step" data-step="-1" aria-label="門檻 -1">−1</button>
            <input type="range" id="ed-range" min="0" max="100" step="1" aria-label="門檻">
            <button class="step" data-step="1" aria-label="門檻 +1">+1</button>
            <button class="step" data-step="5" aria-label="門檻 +5">+5</button>
            <output id="ed-val"></output>
          </div>
          <div class="scale"><span>0 最敏感：什麼都會觸發</span><span>100 等於關閉</span></div>
          <p id="ed-lock" class="note">目前是<b>只看數據</b>：點欄位只會查看，不會改到門檻。要調整請按右上角的「🔒 只看數據」切換。</p>
          <p id="ed-diag" class="diag"></p>
          <div class="ed-facts">
            <span>現在能量 <b id="ed-energy"></b></span>
            <span>10 秒內最高 <b id="ed-peak"></b></span>
            <span>錄到的雜訊 <b id="ed-noise"></b></span>
          </div>
          <div class="ed-actions">
            <button id="ed-suggest" class="ghost" title="房間沒人時使用：門檻設在雜訊之上，避免誤判"></button>
            <button id="ed-max" class="ghost"></button>
          </div>
        </div>
      `)}

      ${this._section("wizard", `
        <ol class="stepper"></ol>
        <div id="wizard"></div>`, "wizard")}

      ${this._section("watch", `<div id="watch"></div>`)}

      ${this._section("settings", `
        <h4>範圍與時間</h4>
        <div class="settings">
          ${numberBox("number.absence_delay", "無人延遲（秒）", 0, 65535, "最後一次偵測到人之後，等多久才判定沒人。太短的話坐著不動時燈會熄。")}
          ${gateSelect("number.max_motion_gate", "移動偵測最遠到", "超過這格就不偵測移動，用來避開門外或隔壁。")}
          ${gateSelect("number.max_still_gate", "靜止偵測最遠到", "超過這格就不偵測靜止的人。")}
          ${optionSelect("select.distance_resolution", "距離解析度", "每一格代表多長的距離。改了之後各格的距離會跟著變。")}
        </div>

        <h4>光感與 OUT 腳位</h4>
        <div class="settings">
          ${optionSelect("select.light_function", "光控功能", "只影響雷達實體 OUT 腳位，不影響 HA 的有人判斷。")}
          <label>光感門檻（0–255）
            <span class="inline"><input type="range" min="0" max="255" step="1" data-key="number.light_sensitivity"><span class="nums" data-num="number.light_sensitivity"></span></span>
            <small>目前環境光感：<span data-fact="sensor.photo_sensor" data-unit=""></span></small>
          </label>
          ${optionSelect("select.out_level", "OUT 腳位準位", "接繼電器或其他硬體時才需要調整。")}
        </div>

        <h4>校準與維護</h4>
        <div class="actions">
          ${ACTIONS.map(
            ([key, label, help]) =>
              `<button data-action="${key}"><b>${label}</b><small>${help}</small></button>`,
          ).join("")}
        </div>`)}

      <div id="status" class="statusbar" role="status" aria-live="polite">調整後會在這裡顯示是否已寫入雷達。</div>

      <p class="footer">
        韌體 <span data-text="sensor.firmware_version"></span> ·
        藍牙訊號 <span data-text="signal"></span> ·
        已對應 ${Object.keys(this._map).length} 個實體
      </p>`;
    this._bindControls(body);
    this._renderWizard();
    this._renderWatch();
  }

  _bindControls(body) {
    for (const details of body.querySelectorAll("details[data-sec]")) {
      details.addEventListener("toggle", () => storage.set(`${OPEN_KEY}${details.dataset.sec}`, details.open ? "1" : "0"));
    }
    for (const button of body.querySelectorAll("[data-jump]")) {
      button.addEventListener("click", () => this._jump(button.dataset.jump));
    }
    body.querySelector(".sector").addEventListener("click", (ev) => {
      const seg = ev.target.closest(".seg");
      if (!seg) return;
      this._commit();
      this._kind = seg.dataset.kind;
      this._gate = Number(seg.dataset.gate);
      this._update();
      this._jump("map");
    });
    const wave = body.querySelector("#wave");
    if (wave) {
      body.querySelector("#wave-pause").addEventListener("click", () => this._toggleWavePause());
      wave.addEventListener("pointermove", (ev) => {
        const rect = wave.getBoundingClientRect();
        this._waveHover = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        this._readWave();
        this._drawWave();
      });
      wave.addEventListener("pointerleave", () => {
        this._waveHover = null;
        this._readWave();
      });
    }

    for (const tab of body.querySelectorAll(".tabs button")) {
      tab.addEventListener("click", () => {
        this._commit();
        this._kind = tab.dataset.kind;
        this._update();
      });
    }

    for (const col of body.querySelectorAll(".col")) {
      const g = Number(col.dataset.gate);
      const plot = col.querySelector(".plot");
      const valueAt = (ev) => {
        const rect = plot.getBoundingClientRect();
        return rect.height ? 100 * (1 - (ev.clientY - rect.top) / rect.height) : undefined;
      };
      plot.addEventListener("pointerdown", (ev) => {
        if (this._gate !== g) this._commit();
        this._gate = g;
        const value = valueAt(ev);
        if (value === undefined || this._locked) return this._update();
        plot.setPointerCapture?.(ev.pointerId);
        this._adjust(value);
      });
      plot.addEventListener("pointermove", (ev) => {
        if (this._drag && this._gate === g && plot.hasPointerCapture?.(ev.pointerId)) this._adjust(valueAt(ev));
      });
      plot.addEventListener("pointerup", () => this._commit());
      plot.addEventListener("pointercancel", () => this._commit());
      col.querySelector(".axis").addEventListener("click", () => {
        this._commit();
        this._gate = g;
        this._update();
      });
    }

    const range = body.querySelector("#ed-range");
    range.addEventListener("input", () => this._adjust(Number(range.value)));
    range.addEventListener("change", () => this._adjust(Number(range.value), true));
    for (const button of body.querySelectorAll(".step")) {
      button.addEventListener("click", () => {
        const current = this._limit(limitKey(this._kind, this._gate)) ?? 0;
        this._adjust(current + Number(button.dataset.step));
        clearTimeout(this._stepTimer);
        this._stepTimer = setTimeout(() => this._commit(), STEP_DEBOUNCE_MS);
      });
    }
    body.querySelector("#ed-suggest").addEventListener("click", () => {
      const peak = this._peak(energyKey(this._kind, this._gate));
      if (peak !== undefined) this._adjust(peak + 10, true);
    });
    body.querySelector("#ed-max").addEventListener("click", () => {
      const { maxKey, label } = KINDS[this._kind];
      this._write(maxKey, Math.max(2, this._gate), `${label}偵測最遠 Gate`);
    });

    for (const input of body.querySelectorAll(".settings input[data-key]")) {
      const key = input.dataset.key;
      const label = input.closest("label").firstChild.textContent.trim();
      if (input.type === "range") {
        input.addEventListener("pointerdown", () => (input.dataset.dragging = "1"));
        input.addEventListener("input", () => this._update());
      }
      input.addEventListener("change", () => {
        delete input.dataset.dragging;
        this._write(key, Number(input.value), label);
      });
    }
    for (const select of body.querySelectorAll(".settings select[data-key]")) {
      const label = select.closest("label").firstChild.textContent.trim();
      select.addEventListener("change", () => this._write(select.dataset.key, select.value, label));
    }
    for (const button of body.querySelectorAll("button[data-action]")) {
      const [key, label, , question] = ACTIONS.find(([k]) => k === button.dataset.action);
      button.disabled = !this._map[`button.${key}`];
      button.addEventListener("click", () => {
        if (confirm(question)) this._press(key, label);
      });
    }

    const wizard = body.querySelector(".wizard");
    wizard.addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-act]");
      if (el && !el.disabled) this._wizardAction(el.dataset.act, el.dataset);
    });
    body.querySelector("#watch").addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-watch]");
      if (!el || el.disabled) return;
      const action = el.dataset.watch;
      if (action === "start") this._startWatch(Number(el.dataset.min));
      if (action === "stop") this._finishWatch();
      if (action === "clear") {
        clearInterval(this._watch?.timer);
        this._watch = null;
        this._renderWatch();
      }
      if (action === "apply") this._applyAll(this._watchTargets(), "只調高被觸發的格子");
    });
    wizard.addEventListener("input", (ev) => {
      if (ev.target.id === "source-name") this._wiz.sourceName = ev.target.value;
      this._updateWizard();
    });
  }

  _wizardAction(act, data) {
    const wiz = this._wiz;
    const actions = {
      goto: () => {
        this._cancelRecording();
        wiz.step = Number(data.step);
      },
      enable: () => this._enableNeeded(),
      range: () => {
        const gate = Math.max(2, this._targetGate() ?? 8);
        return this._applyAll(
          Object.values(KINDS).map((k) => [k.maxKey, gate, `${k.label}偵測最遠 Gate`]),
          "設定偵測範圍",
        );
      },
      "range-all": () =>
        this._applyAll(Object.values(KINDS).map((k) => [k.maxKey, 8, `${k.label}偵測最遠 Gate`]), "偵測全部 9 格"),
      "rec-empty": () => this._startRecording("empty"),
      "rec-source": () => this._startRecording("source", { name: wiz.sourceName.trim() || `干擾源 ${wiz.sources.length + 1}` }),
      "rec-person": () => this._startRecording("person", { kind: data.kind }),
      cancel: () => {
        this._cancelRecording();
        this._setStatus("", "已取消錄製。");
      },
      preset: () => (wiz.sourceName = data.name),
      "remove-source": () => wiz.sources.splice(Number(data.index), 1),
      margin: () => (wiz.margin = Number(data.margin)),
      "apply-noise": () => this._applyAll(this._noiseTargets(), "套用雜訊門檻"),
      "apply-person": () =>
        this._applyAll(
          this._personRows()
            .filter((r) => !r.ok && !r.off)
            .map((r) => [limitKey(wiz.person.kind, r.g), r.suggest, this._gateLabel(wiz.person.kind, r.g)]),
          "降低門檻",
        ),
      delay: () => this._write("number.absence_delay", Number(data.value), "無人延遲（秒）"),
      save: () => this._press("save_sensitivities", "儲存門檻"),
      restart: () => {
        this._cancelRecording();
        this._wiz = newWizard();
      },
    };
    const result = actions[act]?.();
    if (!(result instanceof Promise)) {
      this._renderWizard();
      this._update();
    }
  }

  /** 依目前步驟重畫快速設定（只在步驟或結果改變時；即時數值由 _updateWizard 更新）。 */
  _renderWizard() {
    const root = this.shadowRoot;
    const container = root.getElementById("wizard");
    if (!container) return;
    const wiz = this._wiz;
    const done = [this._energyReady(), false, Boolean(wiz.empty), wiz.sources.length > 0, Boolean(wiz.person), false];
    root.querySelector(".stepper").innerHTML = STEPS.map(
      (name, i) =>
        `<li><button data-act="goto" data-step="${i}" class="${i === wiz.step ? "current" : ""} ${done[i] ? "done" : ""}">
          <span class="num">${done[i] ? "✓" : i + 1}</span><span class="name">${name}</span></button></li>`,
    ).join("");

    const rec = wiz.rec;
    const recording = rec
      ? `<div class="recording">
          <div class="rec-big" data-live="rec-title"></div>
          <div class="progress"><div data-live="rec-bar"></div></div>
          <p class="muted" data-live="rec-hint"></p>
          <button class="ghost" data-act="cancel">取消</button>
        </div>`
      : "";
    const nav = (back = true, next = true, nextLabel = "下一步") => `
      <div class="nav">
        ${back ? `<button class="ghost" data-act="goto" data-step="${wiz.step - 1}">上一步</button>` : "<span></span>"}
        ${next ? `<button class="primary" data-act="goto" data-step="${wiz.step + 1}">${nextLabel}</button>` : ""}
      </div>`;
    const busy = this._applying ? "disabled" : "";

    const pages = [
      // 0 準備
      () => `
        <p class="lead">先確認雷達送得出每一格的能量，後面的步驟都要用到。</p>
        <ul class="checklist">
          <li data-live="chk-online"></li>
          <li data-live="chk-energy"></li>
          <li data-live="chk-max"></li>
        </ul>
        <button class="primary" data-act="enable" data-live="enable-btn"></button>
        <details class="tip"><summary>這些感測器會讓資料庫變大嗎？</summary>
          能量感測器每秒更新好幾次。調校完可以到裝置頁再停用它們，或依 README 的「Note on recorder」把它們排除在記錄之外。
        </details>
        ${nav(false)}`,
      // 1 偵測範圍
      () => `
        <p class="lead">拿著手機，走到你<b>想偵測的最遠位置</b>（例如房間最裡面的牆邊），站著揮揮手。</p>
        <div class="live-target" data-live="target"></div>
        <p class="muted" data-live="range-now"></p>
        <div class="row">
          <button class="primary" data-act="range" data-live="range-btn" ${busy}></button>
          <button class="ghost" data-act="range-all" ${busy}>偵測全部 9 格</button>
        </div>
        <p class="muted">設好後，比這更遠的地方（門外、走廊、隔壁房間）都不會觸發。</p>
        ${nav()}`,
      // 2 空房基準
      () =>
        recording ||
        `
        <p class="lead">錄下<b>沒有人時</b>每一格的雜訊。按下開始後有 ${LEAD_SECONDS.empty} 秒讓你離開房間，接著錄 ${RECORD_SECONDS.empty} 秒。</p>
        <p class="muted">冷氣、電風扇等平常會開著的東西，保持平常的狀態。</p>
        <button class="primary big" data-act="rec-empty">${wiz.empty ? "重新錄製空房" : "開始錄製空房"}</button>
        ${wiz.empty ? this._noiseReport() + this._marginPicker(busy) : ""}
        ${nav(true, true, wiz.empty ? "下一步" : "略過")}`,
      // 3 干擾源
      () =>
        recording ||
        `
        <p class="lead">家裡還有<b>其他會動的東西</b>嗎？一次測一個，就能看出它影響哪一格、強度多少。</p>
        <div class="row">
          ${SOURCE_PRESETS.map((name) => `<button class="chip-btn" data-act="preset" data-name="${name}">${name}</button>`).join("")}
        </div>
        <div class="row">
          <input id="source-name" maxlength="20" placeholder="干擾源名稱，例如：電風扇" value="${esc(wiz.sourceName)}">
          <button class="primary" data-act="rec-source">打開它，開始錄製</button>
        </div>
        <p class="muted">按下後有 ${LEAD_SECONDS.source} 秒離開房間，錄 ${RECORD_SECONDS.source} 秒。人不要留在房間。</p>
        ${this._sourceReport()}
        ${wiz.sources.length ? this._marginPicker(busy) : ""}
        ${nav(true, true, wiz.sources.length ? "下一步" : "沒有其他干擾，略過")}`,
      // 4 有人測試
      () =>
        recording ||
        `
        <p class="lead">回到你<b>平常會待的位置</b>（沙發、書桌、床），測試雷達看不看得到你。</p>
        <div class="row">
          <button class="primary" data-act="rec-person" data-kind="still">坐著不動測試（${RECORD_SECONDS.person} 秒）</button>
          <button class="ghost" data-act="rec-person" data-kind="motion">走動測試（${RECORD_SECONDS.person} 秒）</button>
        </div>
        <p class="muted">坐著不動最重要：決定你看書、看電視時燈會不會熄。不同位置可以各測一次。</p>
        ${this._personReport(busy)}
        ${nav()}`,
      // 5 完成
      () => `
        <p class="lead">最後設定「多久沒偵測到人才算離開」，然後把門檻存起來。</p>
        <div class="row" data-live="delays">
          ${DELAYS.map((s) => `<button class="chip-btn" data-act="delay" data-value="${s}">${s < 60 ? `${s} 秒` : `${s / 60} 分鐘`}</button>`).join("")}
        </div>
        <p class="muted">建議 30 秒。燈常在你還在時熄掉就加長；離開後太久才關就縮短。</p>
        <button class="primary" data-act="save" ${this._map["button.save_sensitivities"] ? "" : "disabled"}>儲存門檻（之後可隨時還原）</button>
        <p class="muted">驗證：離開房間，上方「有人」應在無人延遲後變成「否」；回來時馬上變成「是」。</p>
        <div class="nav"><button class="ghost" data-act="goto" data-step="4">上一步</button>
          <button class="ghost" data-act="restart">重新開始</button></div>`,
    ];
    container.innerHTML = pages[wiz.step]();
    this._updateWizard();
  }

  _marginPicker(busy) {
    return `
      <div class="margin">
        <span>門檻 = 錄到的最高值 +</span>
        ${MARGINS.map(
          ([name, value, help]) =>
            `<button class="chip-btn ${this._wiz.margin === value ? "on" : ""}" data-act="margin" data-margin="${value}" title="${help}">${name} +${value}</button>`,
        ).join("")}
        <button class="primary" data-act="apply-noise" ${busy}>套用到全部 18 格</button>
      </div>`;
  }

  _noiseReport() {
    const empty = this._wiz.empty;
    const hot = Object.keys(KINDS)
      .flatMap((kind) => GATES.map((g) => ({ kind, g, v: empty[kind][g] ?? 0 })))
      .filter((x) => x.v >= 30)
      .sort((a, b) => b.v - a.v)
      .slice(0, 3)
      .map((x) => `Gate ${x.g}（${this._distanceText(x.g)}）${KINDS[x.kind].label} ${x.v}`);
    return `
      <div class="result">
        <b>空房雜訊</b>
        ${heatTable(empty, (g) => this._distanceText(g))}
        <p>${hot.length ? `雜訊較高：${hot.join("、")}。可能是那個距離有會動的東西，下一步可以找出來。` : "雜訊都很低，環境很乾淨 👍"}</p>
      </div>`;
  }

  _sourceReport() {
    return this._wiz.sources
      .map((source, i) => {
        const rows = this._impact(source);
        const text = rows.length
          ? rows
              .map(
                (r) =>
                  `<li>Gate ${r.g}（${this._distanceText(r.g)}）：${Object.keys(KINDS)
                    .filter((k) => r[k] !== undefined)
                    .map((k) => `${KINDS[k].label} <b>${r[k]}</b><span class="src-check" data-check="${k}:${r.g}:${r[k]}"></span>`)
                    .join("、")}</li>`,
              )
              .join("")
          : "<li>沒有明顯影響 👍</li>";
        return `
          <div class="result">
            <div class="result-head"><b>${esc(source.name)}</b>
              <button class="link" data-act="remove-source" data-index="${i}">刪除</button></div>
            <ul>${text}</ul>
          </div>`;
      })
      .join("");
  }

  _personReport(busy) {
    const person = this._wiz.person;
    if (!person) return "";
    const kind = KINDS[person.kind];
    const rows = this._personRows();
    if (!rows.length) {
      return `<div class="result warn"><b>${kind.label}測試</b>
        <p>沒有任何一格的能量明顯高於雜訊。可能你在偵測範圍外，或這個位置的干擾太強；試著靠近雷達或調整雷達的方向。</p></div>`;
    }
    const needFix = rows.filter((r) => !r.ok && !r.off);
    return `
      <div class="result ${needFix.length ? "warn" : "good"}">
        <b>${kind.label}測試：雷達在這些格子看到你</b>
        <ul>${rows
          .map(
            (r) => `<li>Gate ${r.g}（${this._distanceText(r.g)}）：你的能量 <b>${r.energy}</b>、雜訊 ${r.noise}、門檻 ${r.limit ?? "—"}
              → ${r.off ? "⚠ 在偵測範圍外" : r.ok ? "✓ 偵測得到" : `✗ 偵測不到，建議門檻改成 <b>${r.suggest}</b>`}</li>`,
          )
          .join("")}</ul>
        ${
          needFix.length
            ? `<button class="primary" data-act="apply-person" ${busy}>套用建議（調整 ${needFix.length} 格）</button>
               <p class="muted">建議值取你和雜訊的中間，兼顧偵測得到與不誤判。</p>`
            : "<p>全部偵測得到，可以進下一步 👍</p>"
        }
      </div>`;
  }

  _renderWatch() {
    const container = this.shadowRoot.getElementById("watch");
    if (!container) return;
    const watch = this._watch;
    const starts = (label) => `
      <div class="row">
        ${WATCH_MINUTES.map((m) => `<button class="${label ? "ghost" : "primary"}" data-watch="start" data-min="${m}">${label}${m} 分鐘</button>`).join("")}
      </div>`;

    if (!watch) {
      container.innerHTML = `
        <p class="lead">房間沒人時錄一段時間，記下每一格的最高能量、<b>哪一格什麼時候超過門檻</b>，再只把那幾格調高。</p>
        ${starts("")}
        <p class="muted">按下後有 ${WATCH_LEAD_SECONDS} 秒離開房間，期間不要讓人或寵物進房間。想抓的干擾（冷氣、電扇、窗簾）保持平常的狀態；
          常在某個時段誤判，就在那個時段錄。</p>
        <p class="note">錄製靠這個頁面接收資料：請放在電腦或平板上，<b>分頁保持在前景、螢幕不要休眠</b>。
          ${this._config?.standalone ? "藍牙連線由這個分頁維持，關掉分頁或電腦休眠就會中斷。" : "HA 預設在分頁切到背景 5 分鐘後會斷線，要長時間監看可以到「個人設定」關閉「自動關閉連線」。"}</p>`;
      return;
    }
    if (watch.phase !== "done") {
      container.innerHTML = `
        <div class="recording">
          <div class="rec-big" data-live="watch-title"></div>
          <div class="progress"><div data-live="watch-bar"></div></div>
          <p class="muted" data-live="watch-hint"></p>
          <div class="row center">
            ${watch.phase === "rec" ? `<button class="primary" data-watch="stop">提早結束，看結果</button>` : ""}
            <button class="ghost" data-watch="clear">取消</button>
          </div>
        </div>`;
      this._updateWatch();
      return;
    }

    const minutes = Math.max(1, Math.round((watch.end - watch.start) / 60_000));
    const events = watch.events.length
      ? `<p>期間「有人」被觸發 <b>${watch.events.length}</b> 次：${watch.events
          .slice(0, 10)
          .map((e) => `${clock(e.t)}${e.kinds.length ? `（${e.kinds.join("、")}）` : ""}`)
          .join("、")}${watch.events.length > 10 ? "…" : ""}</p>`
      : "<p>期間「有人」沒有被觸發。</p>";
    const rows = this._watchRows();
    const list = rows.length
      ? `<ul>${rows
          .map((r) => {
            const head = `${KINDS[r.kind].label} Gate ${r.g}（${this._distanceText(r.g)}）：最高 <b>${r.max}</b>`;
            const status = `<span class="src-check" data-wcheck="${r.kind}:${r.g}:${r.max}"></span>`;
            if (!r.hits) return `<li>${head}，接近門檻${status}：偶爾可能誤判，先觀察。</li>`;
            const advice =
              r.suggest >= 100
                ? "能量太強，調門檻也擋不住：把「最遠偵測」設在這格之前，或移開、轉向干擾源。"
                : `建議門檻 <b>${r.suggest}</b>。`;
            return `<li>${head}${status}，超過 ${r.hits} 次，第一次在 ${clock(r.first)} → ${advice}</li>`;
          })
          .join("")}</ul>`
      : "";
    const verdict = rows.some((r) => r.hits)
      ? "這些格子在沒人時超過了門檻，就是誤判的來源："
      : watch.events.length
        ? "各格能量都沒有超過門檻，但「有人」仍被觸發：可能是有人或寵物進出、門外有人經過，或觸發時間太短沒收到。可以再錄一次，或在偵測地圖上觀察。"
        : "這段時間每一格都在門檻之下，沒有抓到誤判 👍 常在某個時段誤判的話，就在那個時段再錄一次。";
    container.innerHTML = `
      <div class="result ${rows.some((r) => r.hits) ? "warn" : "good"}">
        <div class="result-head"><b>監看結果：${clock(watch.start)}–${clock(watch.end)}（約 ${minutes} 分鐘）</b>
          <button class="link" data-watch="clear">清除</button></div>
        ${events}
        <p>${verdict}</p>
        ${list}
        ${heatTable(watch.max, (g) => this._distanceText(g))}
        <button class="primary" data-watch="apply" data-live="watch-apply"></button>
        <p class="muted">建議值 = 監看期間的最高值 +${WATCH_MARGIN}。只會調高被觸發的格子，其他格子不動，不會讓任何一格變得更敏感。
          調完後再監看一次確認；坐著不動時燈會熄的話，到快速設定做「有人測試」。</p>
      </div>
      ${starts("再監看 ")}`;
    this._updateWatch();
  }

  _updateWatch() {
    const root = this.shadowRoot;
    const watch = this._watch;
    const live = (name) => root.querySelector(`[data-live="${name}"]`);
    if (!watch) return;
    if (watch.phase !== "done") {
      const left = Math.max(0, Math.ceil((watch.end - Date.now()) / 1000));
      const title = live("watch-title");
      if (title) {
        title.textContent =
          watch.phase === "lead"
            ? `請離開房間… ${left} 秒後開始監看`
            : `監看中… 剩 ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      }
      const bar = live("watch-bar");
      if (bar) bar.style.width = `${watch.phase === "lead" ? 0 : 100 - (left / (watch.minutes * 60)) * 100}%`;
      const hint = live("watch-hint");
      if (hint) {
        const gates = Object.keys(KINDS).flatMap((k) => GATES.filter((g) => watch.hits[k][g]));
        hint.textContent =
          watch.phase === "lead"
            ? "離開後關上門。頁面保持開著。"
            : `目前「有人」被觸發 ${watch.events.length} 次，${gates.length} 格曾超過門檻。不要讓人進房間。`;
      }
      return;
    }
    for (const el of root.querySelectorAll("[data-wcheck]")) {
      const [kind, g, max] = el.dataset.wcheck.split(":");
      const limit = this._limit(limitKey(kind, Number(g)));
      const blocked = limit > Number(max);
      el.className = `src-check ${blocked ? "ok" : "bad"}`;
      el.textContent = limit === undefined ? "" : blocked ? `（門檻 ${limit}，已擋住 ✓）` : `（門檻 ${limit}，擋不住 ✗）`;
    }
    const apply = live("watch-apply");
    if (apply) {
      const count = this._watchTargets().length;
      apply.textContent = count ? `只調高這 ${count} 格` : "被觸發的格子都已經擋住了";
      apply.disabled = !count || this._applying;
    }
  }

  /** 快速設定中需要即時更新的文字（每次 hass 更新與錄製倒數都會呼叫）。 */
  _updateWizard() {
    const root = this.shadowRoot;
    const live = (name) => root.querySelector(`[data-live="${name}"]`);
    const set = (name, html, cls) => {
      const el = live(name);
      if (!el) return;
      el.innerHTML = html;
      if (cls !== undefined) el.className = cls;
    };
    const check = (ok, text) => `<span class="mark">${ok ? "✓" : "✗"}</span>${text}`;

    const online = this._state("binary_sensor.occupancy");
    const isOnline = online && online.state !== "unavailable";
    set("chk-online", check(isOnline, isOnline ? "雷達已連線" : "雷達未連線：確認電源、藍牙代理，並關閉手機 App"), isOnline ? "ok" : "bad");
    const energyCount = GATES.filter((g) => this._map[energyKey("motion", g)] && this._map[energyKey("still", g)]).length;
    const energyReady = this._energyReady();
    set(
      "chk-energy",
      check(
        energyReady,
        energyReady
          ? "18 個能量感測器都有資料"
          : energyCount === 9
            ? "能量感測器已啟用，等待雷達送資料…（一直沒有的話，按下方「重新開機」）"
            : `能量感測器：已啟用 ${energyCount * 2}／18`,
      ),
      energyReady ? "ok" : "bad",
    );
    const hasMax = Object.values(KINDS).every((k) => this._map[k.maxKey]);
    set("chk-max", check(hasMax, hasMax ? "「最遠偵測閘」可以設定" : "「最遠偵測閘」未啟用（步驟 1 需要）"), hasMax ? "ok" : "bad");
    const enable = live("enable-btn");
    if (enable) {
      enable.textContent = this._disabledIds.length ? `一鍵啟用 ${this._disabledIds.length} 個需要的實體` : "需要的實體都已啟用";
      enable.disabled = !this._disabledIds.length;
    }

    const target = this._targetGate();
    set(
      "target",
      target === undefined
        ? "還沒看到你：在雷達前方走動或揮手"
        : `雷達看到你在 <b>Gate ${target}</b>（${this._distanceText(target)}）`,
      `live-target ${target === undefined ? "" : "found"}`,
    );
    set(
      "range-now",
      `目前範圍：移動到 Gate ${this._maxGate("motion")}、靜止到 Gate ${this._maxGate("still")}` +
        `（約 ${meters((Math.max(this._maxGate("motion"), this._maxGate("still")) + 1) * this._step())} m 內）`,
    );
    const rangeBtn = live("range-btn");
    if (rangeBtn) {
      const gate = Math.max(2, target ?? 8);
      rangeBtn.textContent = hasMax ? `範圍設到這裡（Gate ${gate}，${meters((gate + 1) * this._step())} m 內）` : "需要先在步驟 1「準備」啟用最遠偵測閘";
      rangeBtn.disabled = !hasMax || target === undefined || this._applying;
    }

    // 干擾源結果：目前門檻擋不擋得住
    for (const el of root.querySelectorAll("[data-check]")) {
      const [kind, g, value] = el.dataset.check.split(":");
      const limit = this._limit(limitKey(kind, Number(g)));
      const outOfRange = Number(g) > this._maxGate(kind);
      el.className = `src-check ${outOfRange || limit > Number(value) ? "ok" : "bad"}`;
      el.textContent = outOfRange
        ? "（超出範圍，不影響）"
        : limit === undefined
          ? ""
          : limit > Number(value)
            ? `（門檻 ${limit}，已擋住 ✓）`
            : `（門檻 ${limit}，會誤判 ✗）`;
    }

    for (const button of root.querySelectorAll('[data-act="delay"]')) {
      button.classList.toggle("on", same(button.dataset.value, this._limit("number.absence_delay")));
    }

    const rec = this._wiz.rec;
    if (rec) {
      const left = Math.max(0, Math.ceil((rec.end - Date.now()) / 1000));
      const total = (rec.phase === "lead" ? LEAD_SECONDS : RECORD_SECONDS)[rec.purpose];
      const leave = rec.purpose === "person" ? "請就位" : "請離開房間";
      set("rec-title", rec.phase === "lead" ? `${leave}… ${left} 秒後開始錄製` : `錄製中… 剩 ${left} 秒`);
      const bar = live("rec-bar");
      if (bar) bar.style.width = `${rec.phase === "lead" ? 0 : 100 - (left / total) * 100}%`;
      set(
        "rec-hint",
        rec.purpose === "empty"
          ? "保持房間沒有人。"
          : rec.purpose === "source"
            ? `讓「${esc(rec.name)}」正常運作，人不要在房間。`
            : rec.kind === "still"
              ? "坐好、不要動，正常呼吸。"
              : "在平常活動的範圍走動。",
      );
    }
  }

  _update() {
    const root = this.shadowRoot;
    const mode = root.getElementById("mode");
    mode.textContent = this._locked ? "🔒 只看數據" : "✏️ 可調整";
    mode.classList.toggle("on", !this._locked);
    mode.title = this._locked
      ? "現在拖動地圖或滑桿都不會寫入雷達。按一下切換成可調整。"
      : "現在拖動地圖、滑桿會直接寫入雷達。按一下切換成只看數據。";
    if (!this._deviceId || !root.getElementById("ed-range")) return;
    root.getElementById("body").classList.toggle("locked", this._locked);

    // 雷達回報的值和送出的值一致 → 寫入成功。
    for (const [key, pending] of Object.entries(this._pending)) {
      if (pending.sent && same(this._value(key), pending.value)) this._settle(key, pending, "ok");
    }

    for (const el of root.querySelectorAll(".chip[data-key]")) {
      const state = this._state(el.dataset.key);
      el.classList.toggle("on", state?.state === "on");
      el.querySelector(".state").textContent = !state ? "未啟用" : state.state === "on" ? "是" : state.state === "off" ? "否" : "—";
    }
    for (const el of root.querySelectorAll("[data-fact]")) {
      const value = this._value(el.dataset.fact);
      const enabled = Boolean(this._map[el.dataset.fact]);
      el.textContent = value !== undefined ? `${value} ${el.dataset.unit}`.trim() : enabled ? "—" : "未啟用";
    }

    this._updateLive();
    this._updateChart();
    this._updateEditor();
    this._updateSettings();
    this._updateWizard();
    this._updateWatch();

    root.querySelector('[data-text="sensor.firmware_version"]').textContent = this._value("sensor.firmware_version") ?? "—";
    const rssi = this._value("sensor.signal_strength") ?? this._value("sensor.bluetooth_signal");
    root.querySelector('[data-text="signal"]').textContent = rssi !== undefined ? `${rssi} dBm` : "未啟用";
  }

  _updateChart() {
    const root = this.shadowRoot;
    const kind = KINDS[this._kind];
    for (const tab of root.querySelectorAll(".tabs button")) {
      tab.setAttribute("aria-selected", String(tab.dataset.kind === this._kind));
    }
    root.getElementById("kind-help").textContent = kind.help;

    const maxGate = this._maxGate(this._kind);
    const targetGate = this._targetGate(this._kind);

    for (const col of root.querySelectorAll(".col")) {
      const g = Number(col.dataset.gate);
      const key = limitKey(this._kind, g);
      const energy = this._number(energyKey(this._kind, g));
      const peak = this._peak(energyKey(this._kind, g));
      const noise = this._noise(this._kind, g);
      const limit = this._limit(key);
      const off = g > maxGate;
      col.classList.toggle("sel", g === this._gate);
      col.classList.toggle("off", off);
      col.classList.toggle("hit", !off && energy !== undefined && limit !== undefined && energy >= limit);
      col.classList.toggle("pending", Boolean(this._pending[key]) || this._drag?.key === key);
      col.classList.toggle("target-here", !off && g === targetGate);
      col.querySelector(".fill").style.height = `${energy ?? 0}%`;
      col.querySelector(".noise").style.height = `${noise ?? 0}%`;
      col.querySelector(".peak").style.bottom = `${peak ?? 0}%`;
      col.querySelector(".peak").hidden = peak === undefined;
      col.querySelector(".line").style.bottom = `${limit ?? 100}%`;
      col.querySelector(".line").hidden = limit === undefined;
      col.querySelector(".val").textContent = limit ?? "";
      col.querySelector(".dist").textContent = `${meters(g * this._step())}m`;
      const { level } = this._diagnose(this._kind, g);
      col.dataset.diag = level;
      col.querySelector(".flag").textContent = level === "bad" ? "⚠" : "";
    }

    const problems = GATES.map((g) => [g, this._diagnose(this._kind, g)]).filter(([, d]) => d.level === "bad");
    const summary = root.getElementById("diag-summary");
    if (!this._wiz.empty && !this._wiz.sources.length) {
      summary.className = "diag-summary info";
      summary.textContent = "完成「快速設定 → 空房基準」後，這裡會指出哪幾格的門檻可能誤判或漏判。";
    } else if (problems.length) {
      summary.className = "diag-summary bad";
      summary.textContent = `${kind.label}偵測有 ${problems.length} 格需要注意（⚠）：${problems.map(([g]) => `Gate ${g}`).join("、")}。點該格看原因。`;
    } else {
      summary.className = "diag-summary ok";
      summary.textContent = `${kind.label}偵測：每一格的門檻都在雜訊之上 👍`;
    }
  }

  _updateEditor() {
    const root = this.shadowRoot;
    const g = this._gate;
    const kind = KINDS[this._kind];
    const key = limitKey(this._kind, g);
    const step = this._step();
    const energy = this._number(energyKey(this._kind, g));
    const peak = this._peak(energyKey(this._kind, g));
    const limit = this._limit(key);
    const off = g > this._maxGate(this._kind);

    root.getElementById("ed-name").textContent = this._gateLabel(this._kind, g);
    root.getElementById("ed-dist").textContent = this._distanceText(g);
    const badge = root.getElementById("ed-state");
    badge.textContent = off ? "不偵測" : energy === undefined || limit === undefined ? "" : energy >= limit ? "偵測到" : "未觸發";
    badge.className = `badge ${off ? "" : energy >= limit ? "hit" : "idle"}`;

    const range = root.getElementById("ed-range");
    if (this._drag?.key !== key && limit !== undefined) range.value = limit;
    const frozen = limit === undefined || this._locked;
    range.disabled = frozen;
    for (const button of root.querySelectorAll(".step")) button.disabled = frozen;
    root.getElementById("ed-lock").hidden = !this._locked;
    root.getElementById("ed-val").textContent = limit ?? "未啟用";
    root.getElementById("ed-energy").textContent = energy ?? "—";
    root.getElementById("ed-peak").textContent = peak ?? "—";
    root.getElementById("ed-noise").textContent = this._noise(this._kind, g) ?? "未錄製";
    const diag = this._diagnose(this._kind, g);
    const diagEl = root.getElementById("ed-diag");
    diagEl.className = `diag ${diag.level}`;
    diagEl.textContent = diag.text;

    const suggest = root.getElementById("ed-suggest");
    suggest.textContent = peak === undefined ? "門檻設為最高值 +10" : `門檻設為最高值 +10（= ${clamp(peak + 10, 0, 100)}）`;
    suggest.disabled = peak === undefined || frozen;

    const max = root.getElementById("ed-max");
    const maxGate = Math.max(2, g);
    max.textContent = `${kind.label}偵測只到這裡（Gate ${maxGate}，${meters((maxGate + 1) * step)} m 內）`;
    max.disabled = this._locked || !this._map[kind.maxKey] || this._maxGate(this._kind) === maxGate;
    max.title = this._map[kind.maxKey] ? "" : "「最遠偵測閘」實體預設停用：到裝置頁啟用後即可使用";
  }

  _updateSettings() {
    const root = this.shadowRoot;
    for (const input of root.querySelectorAll(".settings input[data-key]")) {
      const key = input.dataset.key;
      const value = this._limit(key);
      const active = input.dataset.dragging || input === root.activeElement;
      if (!active && value !== undefined) input.value = value;
      input.disabled = value === undefined || this._locked;
      const label = root.querySelector(`[data-num="${key}"]`);
      if (label) label.textContent = active ? input.value : value ?? "未啟用";
      input.closest("label").classList.toggle("pending", Boolean(this._pending[key]));
    }
    for (const select of root.querySelectorAll(".settings select[data-key]")) {
      const key = select.dataset.key;
      const state = this._state(key);
      if (key.startsWith("select.")) {
        const options = state?.attributes?.options || [];
        const html = options.map((o) => `<option value="${esc(o)}">${esc(display(o))}</option>`).join("");
        if (select.dataset.options !== html) {
          select.innerHTML = html;
          select.dataset.options = html;
        }
      }
      const value = this._pending[key]?.value ?? (key.startsWith("number.") ? String(this._number(key) ?? "") : this._value(key));
      if (select !== root.activeElement && value !== undefined) select.value = value;
      select.disabled = !state || state.state === "unavailable" || this._locked;
      select.title = !state ? "此實體預設停用：到裝置頁啟用後即可調整" : this._locked ? "只看數據模式：按右上角切換成可調整" : "";
      select.closest("label").classList.toggle("pending", Boolean(this._pending[key]));
    }
  }
}

const display = (value) => OPTION_LABELS[value] || String(value);

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const chip = (key, label, icon) =>
  `<div class="chip" data-key="${key}"><ha-icon icon="${icon}"></ha-icon><span>${label}</span><b class="state"></b></div>`;

const fact = (key, label, unit) =>
  `<div class="fact"><small>${label}</small><span data-fact="${key}" data-unit="${unit}"></span></div>`;

const numberBox = (key, label, min, max, help) =>
  `<label>${label}<input type="number" min="${min}" max="${max}" step="1" data-key="${key}"><small>${help}</small></label>`;

const gateSelect = (key, label, help) =>
  `<label>${label}<select data-key="${key}">${[2, 3, 4, 5, 6, 7, 8]
    .map((g) => `<option value="${g}">Gate ${g}</option>`)
    .join("")}</select><small>${help}</small></label>`;

const optionSelect = (key, label, help) =>
  `<label>${label}<select data-key="${key}"></select><small>${help}</small></label>`;

/** 示意用的小柱狀圖：雜訊帶、能量柱、門檻線。 */
const example = (title, noise, limit, energy, text, level) => `
  <figure class="example ${level}">
    <div class="plot mini">
      <div class="noise" style="height:${noise}%"></div>
      ${energy === undefined ? "" : `<div class="fill" style="height:${energy}%"></div>`}
      <div class="line" style="bottom:${limit}%"><span class="val">${limit}</span></div>
    </div>
    <figcaption><b>${title}</b>${text}</figcaption>
  </figure>`;

const LEARN = `
  <details class="learn">
    <summary>門檻是什麼？為什麼每一格要設不同的數字？</summary>
    <ol>
      <li><b>雷達把前方切成 9 格距離</b>（Gate 0 最近）。解析度 0.75 m 時，Gate 0 是 0–0.75 m，Gate 1 是 0.75–1.5 m，依此類推。</li>
      <li><b>每一格會一直回報「能量」0–100</b>：那個距離的東西動得越明顯、反射越強，數字越高。沒人時也不會是 0，因為牆壁、家電都會產生一點雜訊。</li>
      <li><b>門檻＝那一格的「觸發線」</b>：能量 ≥ 門檻就判定有人。
        <b>0</b> 代表任何雜訊都會觸發（一直有人），<b>100</b> 代表永遠不會觸發（等於關閉），一般落在 20–60 之間。</li>
      <li><b>移動和靜止各有一組門檻</b>：移動看走路、揮手；靜止看坐著、躺著時的呼吸。靜止的能量通常比較小，門檻也常比較低。</li>
    </ol>
    <p><b>為什麼每一格不一樣？</b></p>
    <ul>
      <li>離雷達近的格子（Gate 0–1）反射強、背景雜訊高 → 門檻要<b>高</b>，不然會一直誤判。</li>
      <li>遠的格子訊號弱 → 門檻要<b>低</b>，不然人在那裡偵測不到。</li>
      <li>電風扇、冷氣出風口、窗簾、魚缸只會影響<b>它們所在的距離</b> → 只要把那幾格的門檻拉高，其他格不必動。</li>
    </ul>
    <p><b>怎麼判斷設得好不好</b>：橘色帶子是錄到的雜訊，門檻線要在帶子<b>上方</b>，同時要在「有人時能量」的<b>下方</b>。</p>
    <div class="examples">
      ${example("太低：誤判", 45, 30, undefined, "沒人時雜訊就超過線，一直判定有人、燈不會關。", "bad")}
      ${example("剛好", 30, 45, 70, "雜訊在線下、人在線上，判斷正確。", "ok")}
      ${example("太高：漏判", 20, 85, 60, "人的能量碰不到線，坐著不動時燈會熄。", "bad")}
    </div>
  </details>`;

/** 每格能量的色塊表：顏色越深能量越高。 */
const heatTable = (max, distance) => `
  <div class="heat" role="table">
    <span class="hh"></span>${GATES.map((g) => `<span class="hh" title="${distance(g)}">${g}</span>`).join("")}
    ${Object.entries(KINDS)
      .map(
        ([kind, k]) =>
          `<span class="hh">${k.label}</span>${GATES.map((g) => {
            const v = max[kind][g];
            return `<span class="hc" style="--v:${v ?? 0}">${v ?? "—"}</span>`;
          }).join("")}`,
      )
      .join("")}
  </div>`;

const STYLE = `
  :host { display: block; }
  ha-card { padding: 16px; max-width: 960px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .title { font-size: 1.3em; font-weight: 500; flex: 1; }
  select, input[type=number], input:not([type]) {
    font: inherit; padding: 6px 8px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--card-background-color);
    color: var(--primary-text-color);
  }
  #device { min-width: 200px; font-weight: 500; }
  button { font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  h3 { margin: 0 0 8px; font-weight: 500; }
  .muted, .empty, .hint, .note, .explain { color: var(--secondary-text-color); }
  small.muted { font-weight: 400; font-size: 0.8em; }
  .hint, .note { background: var(--secondary-background-color); padding: 8px 12px; border-radius: 8px; }
  .explain { font-size: 0.9em; line-height: 1.6; margin: 4px 0 12px; }
  .primary { padding: 8px 16px; border-radius: 8px; border: none; background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .primary.big { padding: 12px 24px; font-size: 1.1em; }
  .ghost { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--primary-color); background: none; color: var(--primary-color); }
  .link { border: none; background: none; color: var(--primary-color); padding: 0; }
  .chip-btn { padding: 6px 12px; border-radius: 999px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
  .chip-btn.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0; }
  .row input { flex: 1; min-width: 160px; }

  .status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
  .chip { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 999px; background: var(--secondary-background-color); }
  .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .facts { display: flex; flex-wrap: wrap; gap: 16px; margin-left: auto; }
  .fact { display: flex; flex-direction: column; }
  .fact small { color: var(--secondary-text-color); }

  .box { margin-top: 16px; padding: 16px; border: 1px solid var(--divider-color); border-radius: 12px; }
  .box-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .box-head h3 { margin: 0; }

  h4 { margin: 20px 0 8px; font-weight: 500; }
  h4:first-child { margin-top: 0; }
  .jump {
    position: sticky; top: 0; z-index: 2; display: flex; gap: 6px; overflow-x: auto; padding: 8px 0; margin-top: 8px;
    background: var(--ha-card-background, var(--card-background-color, #fff));
  }
  .jump button {
    flex: none; padding: 6px 14px; border-radius: 999px; border: 1px solid var(--divider-color);
    background: none; color: var(--primary-text-color);
  }
  .jump button:hover { border-color: var(--primary-color); color: var(--primary-color); }
  details.box > summary { list-style: none; cursor: pointer; display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
  details.box > summary::-webkit-details-marker { display: none; }
  details.box > summary::before { content: "▸"; color: var(--secondary-text-color); transition: transform 0.2s; }
  details.box[open] > summary::before { transform: rotate(90deg); }
  details.box > summary h3 { margin: 0; }
  .box-body { margin-top: 12px; }
  .box-body > .tabs { margin-bottom: 8px; }

  .live-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; }
  .live-state { display: flex; flex-direction: column; min-width: 150px; }
  .live-state .big { font-size: 2.2em; font-weight: 600; line-height: 1.15; }
  .live-state small { color: var(--secondary-text-color); font-size: 0.95em; }
  .live-state.on .big { color: var(--primary-color); }
  .live-state.offline .big { color: var(--error-color); }
  .live-head .status { margin-top: 0; }
  .live-head .facts { margin-left: auto; }
  .live-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 16px; margin-top: 12px; align-items: start; }
  .sector-box { margin: 0; }
  .sector { display: block; width: 100%; height: auto; }
  .sector-box figcaption { display: flex; justify-content: space-between; gap: 8px; font-size: 0.8em; color: var(--secondary-text-color); }
  .seg { fill: var(--primary-color); fill-opacity: 0.08; stroke: var(--card-background-color, #fff); stroke-width: 1.5; cursor: pointer; transition: fill-opacity 0.2s; }
  .seg:hover { stroke: var(--primary-color); }
  .seg.hit { fill: var(--error-color); }
  .seg.off { fill: var(--disabled-text-color, #bdbdbd); fill-opacity: 0.15; }
  .seg.sel { stroke: var(--primary-text-color); stroke-width: 2; }
  .ring-label { font-size: 9px; fill: var(--secondary-text-color); }
  .radar-dot { fill: var(--primary-text-color); }
  .person { display: none; transition: transform 0.4s ease; pointer-events: none; }
  .person.show { display: inline; }
  .person circle { stroke: var(--card-background-color, #fff); stroke-width: 2; }
  .person[data-kind=motion] circle { fill: var(--warning-color, #ffa000); }
  .person[data-kind=still] circle { fill: var(--success-color, #43a047); }
  .person .pulse { fill: none !important; stroke-width: 2; animation: pulse 1.6s ease-out infinite; }
  .person[data-kind=motion] .pulse { stroke: var(--warning-color, #ffa000); }
  .person[data-kind=still] .pulse { stroke: var(--success-color, #43a047); }
  .person text { font-size: 10px; font-weight: 600; fill: var(--primary-text-color); }
  @keyframes pulse { from { r: 7; opacity: 0.9; } to { r: 20; opacity: 0; } }
  .wave-tools { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
  #wave { display: block; width: 100%; height: ${WAVE_HEIGHT}px; touch-action: none; cursor: crosshair; }
  .wave-axis { display: flex; justify-content: space-between; margin-left: ${WAVE_GUTTER}px; font-size: 0.75em; color: var(--secondary-text-color); }
  .wave-read { min-height: 1.4em; margin: 6px 0 0; font-size: 0.85em; font-variant-numeric: tabular-nums; }
  .target-here .axis b { color: var(--primary-color); }
  .target-here .axis small::after { content: " · 人"; color: var(--primary-color); font-weight: 600; }

  .wizard { border-color: var(--primary-color); }
  .stepper { display: flex; gap: 4px; list-style: none; padding: 0; margin: 12px 0; overflow-x: auto; }
  .stepper li { flex: 1; min-width: 0; }
  .stepper button {
    width: 100%; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 6px 2px;
    border: none; border-bottom: 3px solid var(--divider-color); background: none; color: var(--secondary-text-color);
  }
  .stepper .num {
    width: 24px; height: 24px; line-height: 24px; border-radius: 50%; font-size: 0.8em;
    background: var(--secondary-background-color); color: var(--primary-text-color);
  }
  .stepper .name { font-size: 0.8em; white-space: nowrap; }
  .stepper .done { border-bottom-color: var(--success-color, #43a047); }
  .stepper .done .num { background: var(--success-color, #43a047); color: #fff; }
  .stepper .current { border-bottom-color: var(--primary-color); color: var(--primary-text-color); font-weight: 500; }
  .stepper .current .num { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .lead { font-size: 1.05em; line-height: 1.6; margin: 8px 0; }
  .nav { display: flex; justify-content: space-between; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--divider-color); }
  .checklist { list-style: none; padding: 0; display: grid; gap: 6px; }
  .checklist li { display: flex; gap: 8px; align-items: baseline; }
  .checklist .mark { font-weight: 700; width: 1em; }
  .checklist .ok .mark { color: var(--success-color, #43a047); }
  .checklist .bad .mark { color: var(--error-color); }
  .tip { margin-top: 12px; color: var(--secondary-text-color); font-size: 0.9em; }
  .live-target { font-size: 1.3em; padding: 16px; border-radius: 10px; text-align: center; background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .live-target.found { color: var(--primary-text-color); }
  .recording { text-align: center; padding: 24px 8px; }
  .rec-big { font-size: 1.5em; font-weight: 500; margin-bottom: 12px; }
  .progress { height: 8px; border-radius: 4px; background: var(--secondary-background-color); overflow: hidden; margin: 0 auto; max-width: 400px; }
  .progress div { height: 100%; width: 0; background: var(--primary-color); transition: width 0.25s linear; }
  .result { margin-top: 12px; padding: 12px; border-radius: 10px; background: var(--secondary-background-color); }
  .result.warn { border-left: 4px solid var(--warning-color, #ffa000); }
  .result.good { border-left: 4px solid var(--success-color, #43a047); }
  .result ul { margin: 6px 0; padding-left: 20px; line-height: 1.7; }
  .result-head { display: flex; justify-content: space-between; }
  .heat { display: grid; grid-template-columns: auto repeat(9, minmax(0, 1fr)); gap: 2px; margin: 8px 0; font-size: 0.85em; text-align: center; }
  .hh { color: var(--secondary-text-color); padding: 2px 4px; }
  .hc {
    padding: 4px 0; border-radius: 4px; font-variant-numeric: tabular-nums;
    background: color-mix(in srgb, var(--error-color) calc(var(--v) * 1%), var(--card-background-color));
  }
  .row.center { justify-content: center; margin-top: 12px; }
  #body.locked .plot { cursor: pointer; }
  .margin { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }

  .tabs { display: inline-flex; border-radius: 999px; background: var(--secondary-background-color); padding: 3px; }
  .tabs button { border: none; background: none; color: var(--primary-text-color); padding: 6px 16px; border-radius: 999px; }
  .tabs button[aria-selected=true] { background: var(--primary-color); color: var(--text-primary-color, #fff); }

  .chart { display: grid; grid-template-columns: repeat(9, minmax(0, 1fr)); gap: 6px; }
  .col { display: flex; flex-direction: column; gap: 4px; }
  .plot {
    position: relative; height: 200px; border-radius: 8px; cursor: ns-resize; touch-action: none;
    background: var(--secondary-background-color); outline-offset: 2px;
  }
  .sel .plot { outline: 2px solid var(--primary-color); }
  .noise {
    position: absolute; left: 0; right: 0; bottom: 0; border-radius: 0 0 8px 8px;
    background: color-mix(in srgb, var(--warning-color, #ffa000) 22%, transparent);
    border-top: 1px dashed var(--warning-color, #ffa000);
  }
  .noise[style*="height: 0%"] { border-top: none; }
  .fill { position: absolute; left: 18%; right: 18%; bottom: 0; border-radius: 4px 4px 0 0; background: var(--primary-color); opacity: 0.55; transition: height 0.2s; }
  .hit .fill { background: var(--error-color); opacity: 0.85; }
  .peak { position: absolute; left: 10%; right: 10%; border-top: 2px dotted var(--secondary-text-color); }
  .line { position: absolute; left: 0; right: 0; border-top: 3px solid var(--primary-text-color); }
  .val {
    position: absolute; right: 2px; bottom: 3px; padding: 0 4px; border-radius: 4px; font-size: 0.75em;
    font-variant-numeric: tabular-nums; background: var(--card-background-color); color: var(--primary-text-color);
  }
  .pending .line { border-top-style: dashed; border-top-color: var(--primary-color); }
  .target { position: absolute; top: 4px; left: 50%; transform: translateX(-50%); color: var(--primary-color); display: none; --mdc-icon-size: 20px; }
  .target-here .target { display: block; }
  .offtext { display: none; position: absolute; inset: auto 0 45% 0; text-align: center; font-size: 0.75em; color: var(--secondary-text-color); }
  .off .plot { background: repeating-linear-gradient(135deg, var(--secondary-background-color) 0 6px, transparent 6px 12px); }
  .off .fill, .off .peak, .off .noise { display: none; }
  .off .line { opacity: 0.3; }
  .off .offtext { display: block; }
  .axis { display: flex; flex-direction: column; align-items: center; cursor: pointer; line-height: 1.2; }
  .axis small { color: var(--secondary-text-color); font-size: 0.75em; }
  .sel .axis b { color: var(--primary-color); }

  .flag { color: var(--error-color); margin-left: 2px; }
  .col[data-diag=bad] .plot { box-shadow: inset 0 0 0 2px var(--error-color); }
  .diag-summary { margin: 0 0 10px; padding: 8px 12px; border-radius: 8px; font-size: 0.9em; }
  .diag-summary.info { background: var(--secondary-background-color); color: var(--secondary-text-color); }
  .diag-summary.ok { background: color-mix(in srgb, var(--success-color, #43a047) 15%, transparent); }
  .diag-summary.bad { background: color-mix(in srgb, var(--error-color) 15%, transparent); }
  .diag { margin: 0; padding: 8px 10px; border-radius: 8px; font-size: 0.9em; line-height: 1.5; border-left: 4px solid var(--divider-color); background: var(--card-background-color); }
  .diag:empty { display: none; }
  .diag.ok { border-left-color: var(--success-color, #43a047); }
  .diag.warn { border-left-color: var(--warning-color, #ffa000); }
  .diag.bad { border-left-color: var(--error-color); }
  .scale { display: flex; justify-content: space-between; font-size: 0.75em; color: var(--secondary-text-color); margin-top: -6px; }
  .src-check { margin-left: 4px; font-size: 0.9em; }
  .src-check.ok { color: var(--success-color, #43a047); }
  .src-check.bad { color: var(--error-color); }
  .learn { margin: 0 0 12px; padding: 8px 12px; border-radius: 8px; background: var(--secondary-background-color); font-size: 0.9em; line-height: 1.6; }
  .learn summary { cursor: pointer; font-weight: 500; color: var(--primary-color); }
  .learn ol, .learn ul { padding-left: 20px; }
  .examples { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .example { margin: 0; display: flex; gap: 10px; align-items: flex-end; }
  .example figcaption { display: flex; flex-direction: column; font-size: 0.9em; }
  .example.bad b { color: var(--error-color); }
  .example.ok b { color: var(--success-color, #43a047); }
  .plot.mini { width: 44px; height: 90px; flex: none; cursor: default; background: var(--card-background-color); }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 8px; font-size: 0.8em; color: var(--secondary-text-color); }
  .legend span { display: inline-flex; align-items: center; gap: 4px; }
  .legend ha-icon { --mdc-icon-size: 16px; color: var(--primary-color); }
  .sw { display: inline-block; width: 12px; height: 12px; border-radius: 2px; vertical-align: middle; margin: 0 2px; }
  .fill-sw { background: var(--primary-color); opacity: 0.55; }
  .hit-sw { background: var(--error-color); }
  .noise-sw { background: color-mix(in srgb, var(--warning-color, #ffa000) 40%, transparent); }
  .line-sw { height: 0; border-top: 3px solid var(--primary-text-color); border-radius: 0; }
  .peak-sw { height: 0; border-top: 2px dotted var(--secondary-text-color); border-radius: 0; }

  .editor { margin-top: 16px; padding: 12px; border-radius: 10px; background: var(--secondary-background-color); display: grid; gap: 10px; }
  .ed-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ed-title span:not(.badge) { color: var(--secondary-text-color); }
  .badge { padding: 2px 10px; border-radius: 999px; font-size: 0.8em; background: var(--divider-color); }
  .badge:empty { display: none; }
  .badge.hit { background: var(--error-color); color: #fff; }
  .badge.idle { background: var(--success-color, #43a047); color: #fff; }
  .ed-row { display: flex; align-items: center; gap: 6px; }
  .ed-row input { flex: 1; min-width: 80px; accent-color: var(--primary-color); }
  .step { min-width: 40px; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--divider-color); background: var(--card-background-color); color: var(--primary-text-color); }
  #ed-val { min-width: 48px; text-align: right; font-size: 1.4em; font-weight: 500; font-variant-numeric: tabular-nums; }
  .ed-facts { display: flex; gap: 16px; flex-wrap: wrap; color: var(--secondary-text-color); font-size: 0.9em; }
  .ed-facts b { color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
  .ed-actions { display: flex; flex-wrap: wrap; gap: 8px; }

  .settings { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .settings label { display: flex; flex-direction: column; gap: 4px; font-size: 0.9em; color: var(--primary-text-color); }
  .settings label small { color: var(--secondary-text-color); line-height: 1.4; }
  .settings label.pending select, .settings label.pending input { border-color: var(--primary-color); border-style: dashed; }
  .settings select:disabled, .settings input:disabled { opacity: 0.5; }
  .inline { display: flex; align-items: center; gap: 8px; }
  .inline input { flex: 1; accent-color: var(--primary-color); }
  .nums { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }

  .actions { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
  .actions button {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
    padding: 10px 14px; border-radius: 10px; border: 1px solid var(--divider-color);
    background: var(--card-background-color); color: var(--primary-text-color);
  }
  .actions button small { color: var(--secondary-text-color); }
  .actions button[data-action=auto_sensitivities] { border-color: var(--primary-color); }

  .statusbar {
    position: sticky; bottom: 8px; margin-top: 16px; padding: 10px 14px; border-radius: 10px; font-size: 0.9em;
    background: var(--secondary-background-color); color: var(--secondary-text-color); box-shadow: 0 2px 6px rgba(0,0,0,0.15);
  }
  .statusbar.busy { color: var(--primary-text-color); }
  .statusbar.busy::before { content: "⏳ "; }
  .statusbar.ok { background: var(--success-color, #43a047); color: #fff; }
  .statusbar.ok::before { content: "✓ "; }
  .statusbar.warn { background: var(--warning-color, #ffa000); color: #000; }
  .statusbar.error { background: var(--error-color); color: #fff; }
  .statusbar.error::before { content: "✗ "; }
  .footer { margin-top: 12px; color: var(--secondary-text-color); font-size: 0.85em; }

  @media (max-width: 760px) {
    .live-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 600px) {
    ha-card { padding: 12px; }
    .box { padding: 12px; }
    .chart { gap: 3px; }
    .plot { height: 160px; }
    .val { font-size: 0.65em; right: 0; padding: 0 2px; }
    .facts { margin-left: 0; }
    .ed-row { flex-wrap: wrap; }
    .ed-row input { order: -1; flex-basis: 100%; }
    .stepper .name { display: none; }
    .stepper .current .name { display: block; }
    .heat { font-size: 0.7em; }
  }
`;

/** 側邊欄面板：頂部工具列（手機上可展開側邊欄）＋整頁卡片。 */
class Ld2410TuningPanel extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; min-height: 100vh; background: var(--primary-background-color); }
        .toolbar {
          display: flex; align-items: center; height: var(--header-height, 56px); padding: 0 12px;
          background: var(--app-header-background-color, var(--primary-color));
          color: var(--app-header-text-color, var(--text-primary-color, #fff));
          font-size: 20px;
        }
        .content { padding: 16px; }
        @media (max-width: 600px) { .content { padding: 8px; } }
      </style>
      <div class="toolbar"><ha-menu-button></ha-menu-button><span>雷達調校</span></div>
      <div class="content"><ld2410-tuning-card></ld2410-tuning-card></div>`;
    this._card = this.shadowRoot.querySelector("ld2410-tuning-card");
    this._card.setConfig({});
    this._menu = this.shadowRoot.querySelector("ha-menu-button");
    this._sync();
  }

  set hass(hass) {
    this._hass = hass;
    this._sync();
  }

  set narrow(narrow) {
    this._narrow = narrow;
    this._sync();
  }

  _sync() {
    if (!this._card || !this._hass) return;
    this._card.hass = this._hass;
    this._menu.hass = this._hass;
    this._menu.narrow = this._narrow;
  }
}

customElements.define("ld2410-tuning-card", Ld2410TuningCard);
customElements.define("ld2410-tuning-panel", Ld2410TuningPanel);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "ld2410-tuning-card",
  name: "LD2410 調校卡片",
  description: "自動抓取 LD2410 裝置，下拉切換並直接調整參數。",
});
