/**
 * LD2410 調校頁面
 *
 * 由整合自動註冊為側邊欄面板（ld2410-tuning-panel），也可當儀表板卡片使用
 * （custom:ld2410-tuning-card）。進入頁面時從前端的實體清單（hass.entities）
 * 找出所有 ld2410 裝置，用下拉選單切換；所有設定直接寫入目前選擇的雷達。
 *
 * 偵測地圖：每一欄是一個距離區段（gate），柱子是即時能量、橫線是門檻，
 * 柱子超過橫線就算偵測到。橫線可以直接在圖上拖動。
 */

const PLATFORM = "ld2410";
const STORAGE_KEY = "ld2410-tuning-card:device";
const GATES = [...Array(9).keys()];
const PEAK_WINDOW_MS = 10_000;
const CONFIRM_TIMEOUT_MS = 8_000;
const STEP_DEBOUNCE_MS = 600;

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
    this._pending = {}; // 已送出、等待雷達回報的寫入 key → {value, label, sent, timer}
    this._history = {}; // 能量歷史 key → [[時間, 值]]，算 10 秒內最高值
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
    }
    this._recordEnergy();
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

  _mapEntities(deviceId) {
    const map = {};
    if (!deviceId) return map;
    for (const entry of Object.values(this._hass.entities)) {
      if (entry.platform !== PLATFORM || entry.device_id !== deviceId) continue;
      const [domain] = entry.entity_id.split(".");
      for (const key of KEYS) {
        const [keyDomain, suffix] = key.split(".");
        if (domain === keyDomain && entry.entity_id.endsWith(`_${suffix}`)) map[key] = entry.entity_id;
      }
    }
    return map;
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

  _selectDevice(id) {
    this._deviceId = id;
    this._mapKey = undefined;
    this._history = {};
    this._drag = null;
    for (const p of Object.values(this._pending)) clearTimeout(p.timer);
    this._pending = {};
    if (id) storage.set(id);
    const picker = this.shadowRoot.getElementById("device");
    if (picker && id) picker.value = id;
  }

  // ── 寫入與回饋 ──────────────────────────────────────

  /** 寫入一個設定，並在雷達回報新值（或失敗、逾時）時告訴使用者。 */
  _write(key, value, label) {
    const entityId = this._map[key];
    if (!entityId) return;
    const domain = key.split(".")[0];
    const [service, data] =
      domain === "select" ? ["select_option", { option: value }] : ["set_value", { value: Number(value) }];

    clearTimeout(this._pending[key]?.timer);
    const pending = (this._pending[key] = { value, label });
    this._setStatus("busy", `寫入中：${label} → ${display(value)}…`);
    this._hass.callService(domain, service, { entity_id: entityId, ...data }).then(
      () => {
        pending.sent = true;
        pending.timer = setTimeout(() => this._settle(key, pending, "warn"), CONFIRM_TIMEOUT_MS);
        this._update();
      },
      (err) => this._settle(key, pending, "error", err?.message),
    );
    this._update();
  }

  _settle(key, pending, result, detail) {
    if (this._pending[key] !== pending) return; // 已被較新的寫入取代
    clearTimeout(pending.timer);
    delete this._pending[key];
    const what = `${pending.label} = ${display(pending.value)}`;
    const message = {
      ok: `已寫入雷達：${what}`,
      warn: `已送出，但雷達還沒回報新值：${what}。請確認藍牙連線。`,
      error: `寫入失敗：${what}${detail ? `（${detail}）` : ""}`,
    }[result];
    this._setStatus(result, message);
    this._toast(message);
    this._update();
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

      <section class="box">
        <div class="box-head">
          <h3>偵測地圖</h3>
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
        ${hasEnergy ? "" : `<p class="hint">看不到能量柱：請到裝置頁「+N 個實體未顯示」啟用 Motion／Still gate 0–8 energy 感測器。門檻一樣可以調整。</p>`}
        <div class="chart">
          ${GATES.map(
            (g) => `
            <div class="col" data-gate="${g}">
              <div class="plot" aria-label="Gate ${g}">
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

    const step = this._step();
    const maxGate = this._maxGate(this._kind);
    const distance = this._value(kind.sensor) === "on" ? this._number(kind.distance) : undefined;
    const targetGate = distance === undefined ? undefined : Math.min(8, Math.floor(distance / 100 / step));

    for (const col of root.querySelectorAll(".col")) {
      const g = Number(col.dataset.gate);
      const key = limitKey(this._kind, g);
      const energy = this._number(energyKey(this._kind, g));
      const peak = this._peak(energyKey(this._kind, g));
      const limit = this._limit(key);
      const off = g > maxGate;
      col.classList.toggle("sel", g === this._gate);
      col.classList.toggle("off", off);
      col.classList.toggle("hit", !off && energy !== undefined && limit !== undefined && energy >= limit);
      col.classList.toggle("pending", Boolean(this._pending[key]) || this._drag?.key === key);
      col.classList.toggle("target-here", !off && g === targetGate);
      col.querySelector(".fill").style.height = `${energy ?? 0}%`;
      col.querySelector(".peak").style.bottom = `${peak ?? 0}%`;
      col.querySelector(".peak").hidden = peak === undefined;
      col.querySelector(".line").style.bottom = `${limit ?? 100}%`;
      col.querySelector(".line").hidden = limit === undefined;
      col.querySelector(".val").textContent = limit ?? "";
      col.querySelector(".dist").textContent = `${meters(g * step)}m`;
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
    root.getElementById("ed-dist").textContent = `${meters(g * step)}–${meters((g + 1) * step)} m`;
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

const STYLE = `
  ha-card { padding: 16px; max-width: 960px; margin: 0 auto; }
  .header { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .title { font-size: 1.3em; font-weight: 500; flex: 1; }
  select, input[type=number] {
    font: inherit; padding: 6px 8px; border-radius: 8px;
    border: 1px solid var(--divider-color); background: var(--card-background-color);
    color: var(--primary-text-color);
  }
  #device { min-width: 200px; font-weight: 500; }
  button { font: inherit; cursor: pointer; }
  button:disabled { opacity: 0.4; cursor: default; }
  h3 { margin: 0 0 8px; font-weight: 500; }
  .empty, .hint, .explain { color: var(--secondary-text-color); }
  .hint { background: var(--secondary-background-color); padding: 8px 12px; border-radius: 8px; }
  .explain { font-size: 0.9em; line-height: 1.6; margin: 4px 0 12px; }

  .status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 16px; }
  .chip { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 999px; background: var(--secondary-background-color); }
  .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .facts { display: flex; flex-wrap: wrap; gap: 16px; margin-left: auto; }
  .fact { display: flex; flex-direction: column; }
  .fact small { color: var(--secondary-text-color); }

  .box { margin-top: 16px; padding: 16px; border: 1px solid var(--divider-color); border-radius: 12px; }
  .box-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .box-head h3 { margin: 0; }
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
  .off .fill, .off .peak { display: none; }
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
  .ghost { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--primary-color); background: none; color: var(--primary-color); }

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
