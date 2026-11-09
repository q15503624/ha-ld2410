/**
 * LD2410 調校頁面
 *
 * 由整合自動註冊為側邊欄面板（ld2410-tuning-panel），也可當儀表板卡片使用
 * （custom:ld2410-tuning-card）。進入頁面時從前端的實體清單（hass.entities）
 * 找出所有 ld2410 裝置，用下拉選單切換；所有設定直接寫入目前選擇的雷達。
 */

const PLATFORM = "ld2410";
const STORAGE_KEY = "ld2410-tuning-card:device";
const GATES = [...Array(9).keys()];

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

const ACTIONS = [
  ["auto_sensitivities", "自動校準", "按下後請離開房間，保持空房至少 10 秒。確定開始？"],
  ["save_sensitivities", "儲存靈敏度", "用目前的靈敏度覆蓋上次存檔？"],
  ["load_sensitivities", "載入靈敏度", "用上次存檔覆蓋雷達目前的靈敏度？"],
  ["reboot_device", "重新開機", "確定要重新開機雷達？"],
];

const KINDS = [
  ["motion", "mg", "移動"],
  ["still", "sg", "靜止"],
];

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

  _call(domain, service, key, data = {}) {
    const entityId = this._map[key];
    if (!entityId) return;
    this._hass.callService(domain, service, { entity_id: entityId, ...data }).catch((err) => {
      console.error("ld2410-tuning-card", err);
    });
  }

  _selectDevice(id) {
    this._deviceId = id;
    this._mapKey = undefined;
    if (id) storage.set(id);
    const picker = this.shadowRoot.getElementById("device");
    if (picker && id) picker.value = id;
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
    const hasEnergy = GATES.some((g) => this._map[`sensor.motion_gate_${g}_energy`]);
    body.innerHTML = `
      <section class="status">
        ${chip("binary_sensor.occupancy", "有人", "mdi:home-account")}
        ${chip("binary_sensor.motion", "移動", "mdi:run")}
        ${chip("binary_sensor.static", "靜止", "mdi:human-handsdown")}
        <div class="facts">
          ${fact("sensor.detect_distance", "偵測距離", "cm")}
          ${fact("sensor.moving_distance", "移動目標", "cm")}
          ${fact("sensor.still_distance", "靜止目標", "cm")}
          ${fact("sensor.photo_sensor", "光感", "")}
        </div>
      </section>

      <h3>各距離能量與門檻 <small>拖動滑桿調整門檻，越低越敏感</small></h3>
      ${hasEnergy ? "" : `<p class="hint">能量條需要啟用 Motion／Still gate 0–8 energy 感測器（裝置頁 →「+N 個實體未顯示」）。門檻滑桿不受影響。</p>`}
      <div class="gates">
        <div class="gate head"><span>Gate</span>${KINDS.map(([, , label]) => `<span>${label}</span>`).join("")}</div>
        ${GATES.map(
          (g) => `
          <div class="gate" data-gate="${g}">
            <div class="gname">${g}<small class="dist"></small></div>
            ${KINDS.map(
              ([kind, prefix]) => `
              <div class="cell" data-kind="${kind}">
                <div class="bar"><div class="fill"></div><div class="mark"></div></div>
                <div class="ctrl">
                  <input type="range" min="0" max="100" step="1" data-key="number.${prefix}${g}_sensitivity">
                  <span class="nums"></span>
                </div>
              </div>`,
            ).join("")}
          </div>`,
        ).join("")}
      </div>

      <h3>偵測範圍與時間</h3>
      <div class="settings">
        ${numberBox("number.absence_delay", "無人延遲（秒）", 0, 65535)}
        ${gateSelect("number.max_motion_gate", "最遠移動偵測閘")}
        ${gateSelect("number.max_still_gate", "最遠靜止偵測閘")}
        ${optionSelect("select.distance_resolution", "距離解析度")}
      </div>

      <h3>光感與 OUT 腳位</h3>
      <div class="settings">
        ${optionSelect("select.light_function", "光控功能")}
        <label>光感門檻（0–255）
          <span class="inline"><input type="range" min="0" max="255" step="1" data-key="number.light_sensitivity"><span class="nums" data-num="number.light_sensitivity"></span></span>
        </label>
        ${optionSelect("select.out_level", "OUT 腳位準位")}
      </div>

      <h3>校準與維護</h3>
      <div class="actions">
        ${ACTIONS.map(([key, label]) => `<button data-action="${key}">${label}</button>`).join("")}
      </div>

      <p class="footer">
        韌體 <span data-text="sensor.firmware_version"></span> ·
        藍牙訊號 <span data-text="signal"></span> ·
        已對應 ${Object.keys(this._map).length} 個實體
      </p>`;
    this._bindControls(body);
  }

  _bindControls(body) {
    for (const input of body.querySelectorAll("input[type=range][data-key]")) {
      const key = input.dataset.key;
      const show = () => {
        const label = input.parentElement.querySelector(".nums");
        if (label && key.startsWith("number.light")) label.textContent = input.value;
      };
      input.addEventListener("pointerdown", () => (input.dataset.dragging = "1"));
      input.addEventListener("input", show);
      input.addEventListener("change", () => {
        delete input.dataset.dragging;
        this._call("number", "set_value", key, { value: Number(input.value) });
      });
    }
    for (const input of body.querySelectorAll("input[type=number][data-key]")) {
      input.addEventListener("change", () =>
        this._call("number", "set_value", input.dataset.key, { value: Number(input.value) }),
      );
    }
    for (const select of body.querySelectorAll("select[data-key]")) {
      select.addEventListener("change", () => {
        const key = select.dataset.key;
        if (key.startsWith("number.")) this._call("number", "set_value", key, { value: Number(select.value) });
        else this._call("select", "select_option", key, { option: select.value });
      });
    }
    for (const button of body.querySelectorAll("button[data-action]")) {
      const [key, , question] = ACTIONS.find(([k]) => k === button.dataset.action);
      button.disabled = !this._map[`button.${key}`];
      button.addEventListener("click", () => {
        if (confirm(question)) this._call("button", "press", `button.${key}`);
      });
    }
  }

  _update() {
    const root = this.shadowRoot;
    if (!this._deviceId) return;

    for (const el of root.querySelectorAll(".chip[data-key]")) {
      const state = this._state(el.dataset.key);
      el.classList.toggle("on", state?.state === "on");
      el.classList.toggle("off", !state || state.state !== "on");
      el.querySelector(".state").textContent = !state ? "未啟用" : state.state === "on" ? "是" : state.state === "off" ? "否" : "—";
    }
    for (const el of root.querySelectorAll("[data-fact]")) {
      const value = this._value(el.dataset.fact);
      const enabled = Boolean(this._map[el.dataset.fact]);
      el.textContent = value !== undefined ? `${value} ${el.dataset.unit}`.trim() : enabled ? "—" : "未啟用";
    }

    const step = this._value("select.distance_resolution") === "0.20 m" ? 0.2 : 0.75;
    const maxGate = {
      motion: this._number("number.max_motion_gate") ?? 8,
      still: this._number("number.max_still_gate") ?? 8,
    };
    for (const row of root.querySelectorAll(".gate[data-gate]")) {
      const g = Number(row.dataset.gate);
      row.querySelector(".dist").textContent = `${(g * step).toFixed(2)}–${((g + 1) * step).toFixed(2)} m`;
      for (const [kind, prefix] of KINDS) {
        const cell = row.querySelector(`[data-kind=${kind}]`);
        const energy = this._number(`sensor.${kind}_gate_${g}_energy`);
        const limit = this._number(`number.${prefix}${g}_sensitivity`);
        const input = cell.querySelector("input");
        const off = g > maxGate[kind];
        if (!input.dataset.dragging && limit !== undefined) input.value = limit;
        input.disabled = limit === undefined;
        const shownLimit = input.dataset.dragging ? Number(input.value) : limit;
        cell.classList.toggle("disabled", off);
        cell.classList.toggle("hit", !off && energy !== undefined && shownLimit !== undefined && energy >= shownLimit);
        cell.querySelector(".fill").style.width = `${energy ?? 0}%`;
        cell.querySelector(".mark").style.left = `${shownLimit ?? 100}%`;
        cell.querySelector(".nums").textContent = off
          ? "已關閉"
          : `${energy ?? "–"} / ${shownLimit ?? "–"}`;
      }
    }

    for (const input of root.querySelectorAll(".settings input[data-key]")) {
      const value = this._number(input.dataset.key);
      const active = input.dataset.dragging || input === root.activeElement;
      if (!active && value !== undefined) input.value = value;
      input.disabled = value === undefined;
      const label = root.querySelector(`[data-num="${input.dataset.key}"]`);
      if (label) label.textContent = active ? input.value : value ?? "未啟用";
    }
    for (const select of root.querySelectorAll(".settings select[data-key]")) {
      const key = select.dataset.key;
      const state = this._state(key);
      if (key.startsWith("select.")) {
        const options = state?.attributes?.options || [];
        const html = options.map((o) => `<option value="${esc(o)}">${esc(OPTION_LABELS[o] || o)}</option>`).join("");
        if (select.dataset.options !== html) {
          select.innerHTML = html;
          select.dataset.options = html;
        }
      }
      const value = key.startsWith("number.") ? String(this._number(key) ?? "") : this._value(key);
      if (select !== root.activeElement && value !== undefined) select.value = value;
      select.disabled = !state || state.state === "unavailable";
      select.title = state ? "" : "此實體預設停用：到裝置頁啟用後即可調整";
    }

    root.querySelector('[data-text="sensor.firmware_version"]').textContent = this._value("sensor.firmware_version") ?? "—";
    const rssi = this._value("sensor.signal_strength") ?? this._value("sensor.bluetooth_signal");
    root.querySelector('[data-text="signal"]').textContent = rssi !== undefined ? `${rssi} dBm` : "未啟用";
  }
}

const OPTION_LABELS = {
  off: "關閉",
  "dimmer than": "暗於門檻時才觸發",
  "brighter than": "亮於門檻時才觸發",
  "default low": "平時低電位",
  "default high": "平時高電位",
};

const esc = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const chip = (key, label, icon) =>
  `<div class="chip" data-key="${key}"><ha-icon icon="${icon}"></ha-icon><span>${label}</span><b class="state"></b></div>`;

const fact = (key, label, unit) =>
  `<div class="fact"><small>${label}</small><span data-fact="${key}" data-unit="${unit}"></span></div>`;

const numberBox = (key, label, min, max) =>
  `<label>${label}<input type="number" min="${min}" max="${max}" step="1" data-key="${key}"></label>`;

const gateSelect = (key, label) =>
  `<label>${label}<select data-key="${key}">${[2, 3, 4, 5, 6, 7, 8]
    .map((g) => `<option value="${g}">Gate ${g}</option>`)
    .join("")}</select></label>`;

const optionSelect = (key, label) => `<label>${label}<select data-key="${key}"></select></label>`;

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
  h3 { margin: 24px 0 8px; font-weight: 500; }
  h3 small { color: var(--secondary-text-color); font-weight: 400; margin-left: 8px; font-size: 0.75em; }
  .empty, .hint { color: var(--secondary-text-color); }
  .hint { background: var(--secondary-background-color); padding: 8px 12px; border-radius: 8px; }
  .status { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .chip {
    display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 999px;
    background: var(--secondary-background-color);
  }
  .chip.on { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .facts { display: flex; flex-wrap: wrap; gap: 16px; margin-left: auto; }
  .fact { display: flex; flex-direction: column; }
  .fact small { color: var(--secondary-text-color); }
  .gates { display: grid; gap: 6px; }
  .gate { display: grid; grid-template-columns: 90px 1fr 1fr; gap: 12px; align-items: center; }
  .gate.head { color: var(--secondary-text-color); font-size: 0.85em; }
  .gname { font-weight: 500; display: flex; flex-direction: column; }
  .gname small { color: var(--secondary-text-color); font-weight: 400; }
  .bar { position: relative; height: 10px; border-radius: 5px; background: var(--secondary-background-color); overflow: hidden; }
  .fill { position: absolute; inset: 0 auto 0 0; background: var(--primary-color); opacity: 0.6; transition: width 0.2s; }
  .hit .fill { background: var(--error-color); opacity: 0.9; }
  .mark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--primary-text-color); transform: translateX(-1px); }
  .ctrl, .inline { display: flex; align-items: center; gap: 8px; }
  .ctrl input, .inline input { flex: 1; accent-color: var(--primary-color); }
  .nums { min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; color: var(--secondary-text-color); font-size: 0.85em; }
  .hit .nums { color: var(--error-color); font-weight: 500; }
  .disabled { opacity: 0.35; }
  .settings { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
  .settings label { display: flex; flex-direction: column; gap: 4px; font-size: 0.9em; color: var(--secondary-text-color); }
  .settings select:disabled, .settings input:disabled { opacity: 0.5; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions button {
    font: inherit; padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer;
    background: var(--primary-color); color: var(--text-primary-color, #fff);
  }
  .actions button[data-action=reboot_device] { background: var(--secondary-background-color); color: var(--primary-text-color); }
  .actions button:disabled { opacity: 0.4; cursor: default; }
  .footer { margin-top: 20px; color: var(--secondary-text-color); font-size: 0.85em; }
  @media (max-width: 600px) {
    .gate { grid-template-columns: 56px 1fr 1fr; gap: 8px; }
    .gate .ctrl { flex-direction: column; align-items: stretch; gap: 2px; }
    .nums { text-align: left; }
    .facts { margin-left: 0; }
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
