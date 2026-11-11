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

const ACTIONS = [
  ["auto_sensitivities", "自動校準", "雷達量測空房的背景雜訊，自動設定全部門檻。", "按下後請離開房間，保持空房至少 10 秒。確定開始？"],
  ["save_sensitivities", "儲存門檻", "把目前 18 個門檻存到 HA，之後可以還原。", "用目前的門檻覆蓋上次存檔？"],
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

const storage = {
  get: () => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  },
  set: (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, value);
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
      const saved = storage.get();
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
    this._sampleRecording();
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
    this._drag = null;
    for (const p of Object.values(this._pending)) clearTimeout(p.timer);
    this._pending = {};
    clearInterval(this._wiz.rec?.timer);
    this._wiz = newWizard();
    this._disabledIds = [];
    if (id) storage.set(id);
    const picker = this.shadowRoot.getElementById("device");
    if (picker && id) picker.value = id;
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

  /** 拖動或 ± 調整門檻；commit 時才送出。 */
  _adjust(value, commit) {
    const key = limitKey(this._kind, this._gate);
    if (!this._map[key]) return;
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

  // ── 畫面 ────────────────────────────────────────────

  _buildShell() {
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <ha-icon icon="mdi:radar"></ha-icon>
          <span class="title">LD2410 雷達調校</span>
          <select id="device" aria-label="選擇裝置"></select>
        </div>
        <div id="body"></div>
      </ha-card>`;
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
      <section class="status">
        ${chip("binary_sensor.occupancy", "有人", "mdi:home-account")}
        ${chip("binary_sensor.motion", "移動", "mdi:run")}
        ${chip("binary_sensor.static", "靜止", "mdi:human-handsdown")}
        <div class="facts">
          ${fact("sensor.detect_distance", "目標距離", "cm")}
          ${fact("sensor.photo_sensor", "光感", "")}
        </div>
      </section>

      <section class="box wizard">
        <div class="box-head"><h3>快速設定</h3><small class="muted">照順序做，約 3 分鐘完成</small></div>
        <ol class="stepper"></ol>
        <div id="wizard"></div>
      </section>

      <section class="box">
        <div class="box-head">
          <h3>偵測地圖 <small class="muted">即時・可手動微調</small></h3>
          <div class="tabs" role="tablist">
            ${Object.entries(KINDS)
              .map(([kind, k]) => `<button role="tab" data-kind="${kind}">${k.label}偵測</button>`)
              .join("")}
          </div>
        </div>
        <p class="explain">
          <span id="kind-help"></span>
          每一欄是一段距離。<b class="sw fill-sw"></b>柱子是即時能量，<b class="sw line-sw"></b>橫線是門檻：
          <b>柱子超過橫線就算偵測到</b>。橫線越低越敏感。直接在圖上拖動橫線，或點一欄後在下方微調。
        </p>
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
              <div class="axis"><b>${g}</b><small class="dist"></small></div>
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
      </section>

      <section class="box">
        <h3>範圍與時間</h3>
        <div class="settings">
          ${numberBox("number.absence_delay", "無人延遲（秒）", 0, 65535, "最後一次偵測到人之後，等多久才判定沒人。太短的話坐著不動時燈會熄。")}
          ${gateSelect("number.max_motion_gate", "移動偵測最遠到", "超過這格就不偵測移動，用來避開門外或隔壁。")}
          ${gateSelect("number.max_still_gate", "靜止偵測最遠到", "超過這格就不偵測靜止的人。")}
          ${optionSelect("select.distance_resolution", "距離解析度", "每一格代表多長的距離。改了之後各格的距離會跟著變。")}
        </div>
      </section>

      <section class="box">
        <h3>光感與 OUT 腳位</h3>
        <div class="settings">
          ${optionSelect("select.light_function", "光控功能", "只影響雷達實體 OUT 腳位，不影響 HA 的有人判斷。")}
          <label>光感門檻（0–255）
            <span class="inline"><input type="range" min="0" max="255" step="1" data-key="number.light_sensitivity"><span class="nums" data-num="number.light_sensitivity"></span></span>
            <small>目前環境光感：<span data-fact="sensor.photo_sensor" data-unit=""></span></small>
          </label>
          ${optionSelect("select.out_level", "OUT 腳位準位", "接繼電器或其他硬體時才需要調整。")}
        </div>
      </section>

      <section class="box">
        <h3>校準與維護</h3>
        <div class="actions">
          ${ACTIONS.map(
            ([key, label, help]) =>
              `<button data-action="${key}"><b>${label}</b><small>${help}</small></button>`,
          ).join("")}
        </div>
      </section>

      <div id="status" class="statusbar" role="status" aria-live="polite">調整後會在這裡顯示是否已寫入雷達。</div>

      <p class="footer">
        韌體 <span data-text="sensor.firmware_version"></span> ·
        藍牙訊號 <span data-text="signal"></span> ·
        已對應 ${Object.keys(this._map).length} 個實體
      </p>`;
    this._bindControls(body);
    this._renderWizard();
  }

  _bindControls(body) {
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
        if (value === undefined) return this._update();
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
                    .map((k) => `${KINDS[k].label} <b>${r[k]}</b>`)
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
    if (!this._deviceId || !root.getElementById("ed-range")) return;

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

    this._updateChart();
    this._updateEditor();
    this._updateSettings();
    this._updateWizard();

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
    range.disabled = limit === undefined;
    for (const button of root.querySelectorAll(".step")) button.disabled = limit === undefined;
    root.getElementById("ed-val").textContent = limit ?? "未啟用";
    root.getElementById("ed-energy").textContent = energy ?? "—";
    root.getElementById("ed-peak").textContent = peak ?? "—";
    root.getElementById("ed-noise").textContent = this._noise(this._kind, g) ?? "未錄製";

    const suggest = root.getElementById("ed-suggest");
    suggest.textContent = peak === undefined ? "門檻設為最高值 +10" : `門檻設為最高值 +10（= ${clamp(peak + 10, 0, 100)}）`;
    suggest.disabled = peak === undefined || limit === undefined;

    const max = root.getElementById("ed-max");
    const maxGate = Math.max(2, g);
    max.textContent = `${kind.label}偵測只到這裡（Gate ${maxGate}，${meters((maxGate + 1) * step)} m 內）`;
    max.disabled = !this._map[kind.maxKey] || this._maxGate(this._kind) === maxGate;
    max.title = this._map[kind.maxKey] ? "" : "「最遠偵測閘」實體預設停用：到裝置頁啟用後即可使用";
  }

  _updateSettings() {
    const root = this.shadowRoot;
    for (const input of root.querySelectorAll(".settings input[data-key]")) {
      const key = input.dataset.key;
      const value = this._limit(key);
      const active = input.dataset.dragging || input === root.activeElement;
      if (!active && value !== undefined) input.value = value;
      input.disabled = value === undefined;
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
      select.disabled = !state || state.state === "unavailable";
      select.title = state ? "" : "此實體預設停用：到裝置頁啟用後即可調整";
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
  .muted, .empty, .hint, .explain { color: var(--secondary-text-color); }
  small.muted { font-weight: 400; font-size: 0.8em; }
  .hint { background: var(--secondary-background-color); padding: 8px 12px; border-radius: 8px; }
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
