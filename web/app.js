import { LD2410Radar, NAME_PREFIXES, SERVICES } from "./ld2410-ble.js";
import { createFakeDevice } from "./fake-radar.js";
import { createHass } from "./hass-bridge.js";

// 面板用到的 HA 元件：卡片外框與圖示（以 emoji 代替 Material Design 圖示）。
const ICONS = {
  "mdi:radar": "📡",
  "mdi:account": "👤",
  "mdi:home-account": "🏠",
  "mdi:run": "🏃",
  "mdi:human-handsdown": "🧍",
};
customElements.define(
  "ha-card",
  class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      this.attachShadow({ mode: "open" }).innerHTML = `<style>
        :host { display: block; background: var(--card-background-color); border: 1px solid var(--divider-color);
          border-radius: 12px; box-shadow: 0 1px 3px rgb(0 0 0 / 0.08); }
      </style><slot></slot>`;
    }
  },
);
customElements.define(
  "ha-icon",
  class extends HTMLElement {
    static observedAttributes = ["icon"];
    attributeChangedCallback() {
      this.shadowRoot ?? this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `<style>:host { display: inline-flex; align-items: center; justify-content: center;
        font-size: calc(var(--mdc-icon-size, 24px) * 0.85); width: var(--mdc-icon-size, 24px); height: var(--mdc-icon-size, 24px);
        line-height: 1; vertical-align: middle; }</style>${ICONS[this.getAttribute("icon")] ?? "•"}`;
    }
  },
);

const $ = (id) => document.getElementById(id);
const connectView = $("connect");
const tuneView = $("tune");
const card = $("card");
const errorBox = $("error");
let radar = null;
let unbind = null;

card.setConfig({ standalone: true });

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function setBusy(busy) {
  for (const b of document.querySelectorAll("#connect button")) b.disabled = busy || (b.dataset.needsBt && !navigator.bluetooth);
}

function showConnection() {
  const text = radar.connected ? "已連線" : radar.statusText || "未連線";
  $("conn-name").textContent = radar.name;
  $("conn-state").textContent = text;
  $("conn-state").className = radar.connected ? "ok" : "warn";
}

async function start(device, password) {
  showError("");
  setBusy(true);
  const next = new LD2410Radar(device);
  next.addEventListener("status", () => {
    $("progress").textContent = next.statusText;
    if (radar === next) showConnection();
  });
  next.addEventListener("change", () => radar === next && showConnection());
  try {
    await next.connect(password);
  } catch (err) {
    showError(`${err.message || err}。${/密碼/.test(err.message) ? "" : "確認雷達有電、手機 App 與 HA 都已斷開，再試一次。"}`);
    $("progress").textContent = "";
    setBusy(false);
    return;
  }
  radar = next;
  unbind = createHass(radar, (hass) => (card.hass = hass));
  connectView.hidden = true;
  tuneView.hidden = false;
  showConnection();
  setBusy(false);
  $("progress").textContent = "";
}

$("pair").addEventListener("click", async () => {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
      optionalServices: SERVICES,
    });
  } catch (err) {
    if (err.name !== "NotFoundError") showError(err.message); // NotFoundError：使用者按了取消
    return;
  }
  start(device, $("password").value);
});

$("demo").addEventListener("click", () => start(createFakeDevice(), "HiLink"));

$("disconnect").addEventListener("click", () => {
  unbind?.();
  radar?.disconnect();
  radar = null;
  tuneView.hidden = true;
  connectView.hidden = false;
});

$("show-password").addEventListener("change", (ev) => ($("password").type = ev.target.checked ? "text" : "password"));

window.addEventListener("pagehide", () => radar?.disconnect());

if (!navigator.bluetooth) {
  $("unsupported").hidden = false;
  $("unsupported").innerHTML = /iPhone|iPad|iPod/.test(navigator.userAgent)
    ? "iPhone、iPad 的瀏覽器都不支援網頁藍牙。請改用 Android 手機，或電腦上的 Chrome、Edge。下面的示範模式仍然可以試用。"
    : window.isSecureContext
      ? "這個瀏覽器不支援網頁藍牙。請改用 Chrome 或 Edge（電腦或 Android）。下面的示範模式仍然可以試用。"
      : "網頁藍牙只能在 https 網址使用。";
}
setBusy(false);
if (location.hash === "#demo") start(createFakeDevice(), "HiLink");
