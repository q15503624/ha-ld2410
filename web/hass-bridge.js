/**
 * 把一台藍牙雷達包裝成 HA 前端的 hass 物件，讓整合的調校面板
 * （ld2410-tuning-card.js）不用修改就能直接使用。
 *
 * 面板依實體 ID 的結尾找實體（例如 *_mg3_sensitivity），讀 hass.states，
 * 寫入時呼叫 hass.callService；這裡把這些呼叫轉成藍牙指令。
 */

const PREFIX = "ld2410";
const GATES = [...Array(9).keys()];
const RESOLUTIONS = ["0.75 m", "0.20 m"];
const LIGHT_FUNCTIONS = ["off", "dimmer than", "brighter than"];
const OUT_LEVELS = ["default low", "default high"];
const BUTTONS = ["auto_sensitivities", "save_sensitivities", "load_sensitivities", "reboot_device"];
const SAVED_KEY = "ld2410-web:saved:";

const onOff = (v) => (v === undefined ? "unknown" : v ? "on" : "off");

/** 雷達資料 → {實體結尾: 狀態}。 */
function entityStates(d) {
  const states = {
    "binary_sensor.occupancy": onOff(d.occupancy),
    "binary_sensor.motion": onOff(d.moving),
    "binary_sensor.static": onOff(d.stationary),
    "sensor.detect_distance": d.detectDistance,
    "sensor.moving_distance": d.moveDistance,
    "sensor.still_distance": d.stillDistance,
    "sensor.photo_sensor": d.photo,
    "sensor.firmware_version": d.firmware,
    "number.absence_delay": d.absenceDelay,
    "number.max_motion_gate": d.maxMoveGate,
    "number.max_still_gate": d.maxStillGate,
    "number.light_sensitivity": d.lightThreshold,
    "select.distance_resolution": RESOLUTIONS[d.resolution],
    "select.light_function": LIGHT_FUNCTIONS[d.lightFunction],
    "select.out_level": OUT_LEVELS[d.outLevel],
  };
  for (const g of GATES) {
    states[`sensor.motion_gate_${g}_energy`] = d.moveGateEnergy?.[g];
    states[`sensor.still_gate_${g}_energy`] = d.stillGateEnergy?.[g];
    states[`number.mg${g}_sensitivity`] = d.moveSensitivity?.[g];
    states[`number.sg${g}_sensitivity`] = d.stillSensitivity?.[g];
  }
  for (const b of BUTTONS) states[`button.${b}`] = "unknown";
  return states;
}

const OPTIONS = {
  "select.distance_resolution": RESOLUTIONS,
  "select.light_function": LIGHT_FUNCTIONS,
  "select.out_level": OUT_LEVELS,
};

const entityId = (key) => {
  const [domain, suffix] = key.split(".");
  return `${domain}.${PREFIX}_${suffix}`;
};
const keyOf = (id) => {
  const [domain, rest] = id.split(".");
  return `${domain}.${rest.slice(PREFIX.length + 1)}`;
};

export const savedKey = (radar) => SAVED_KEY + radar.id;

/**
 * @param radar LD2410Radar
 * @param onChange 每次有新的 hass 物件時呼叫
 */
export function createHass(radar, onChange, { storage = globalThis.localStorage, sleep } = {}) {
  const deviceId = radar.id;
  const keys = Object.keys(entityStates({}));
  const entities = Object.fromEntries(
    keys.map((key) => [entityId(key), { entity_id: entityId(key), platform: PREFIX, device_id: deviceId }]),
  );
  const devices = { [deviceId]: { id: deviceId, name: radar.name } };

  const actions = {
    "button.auto_sensitivities": () => radar.autoThresholds(sleep),
    "button.reboot_device": () => radar.reboot(),
    "button.save_sensitivities": () => {
      const { moveSensitivity: move, stillSensitivity: still } = radar.data;
      if (!move || !still) throw new Error("還沒讀到雷達的門檻");
      storage.setItem(savedKey(radar), JSON.stringify({ move, still, savedAt: Date.now() }));
    },
    "button.load_sensitivities": async () => {
      const saved = JSON.parse(storage.getItem(savedKey(radar)) || "null");
      if (!saved) throw new Error("這台電腦上沒有這顆雷達的存檔");
      for (const g of GATES) await radar.setGateSensitivity(g, { move: saved.move[g], still: saved.still[g] });
    },
  };

  const setNumber = (key, value) => {
    const gate = key.match(/^number\.(mg|sg)(\d)_sensitivity$/);
    if (gate) return radar.setGateSensitivity(Number(gate[2]), { [gate[1] === "mg" ? "move" : "still"]: value });
    const field = {
      "number.absence_delay": "absenceDelay",
      "number.max_motion_gate": "maxMoveGate",
      "number.max_still_gate": "maxStillGate",
    }[key];
    if (field) return radar.setMaxGatesAndDelay({ [field]: value });
    if (key === "number.light_sensitivity") return radar.setLight({ lightThreshold: value });
    throw new Error(`不支援的設定 ${key}`);
  };

  const selectOption = (key, option) => {
    const index = OPTIONS[key]?.indexOf(option);
    if (index === undefined || index < 0) throw new Error(`不支援的選項 ${option}`);
    if (key === "select.distance_resolution") return radar.setResolution(index);
    return radar.setLight(key === "select.light_function" ? { lightFunction: index } : { outLevel: index });
  };

  async function callService(domain, service, data) {
    if (!radar.connected) throw new Error("雷達未連線");
    const key = keyOf(data.entity_id);
    if (domain === "number" && service === "set_value") return setNumber(key, Number(data.value));
    if (domain === "select" && service === "select_option") return selectOption(key, data.option);
    if (domain === "button" && service === "press" && actions[key]) return actions[key]();
    throw new Error(`不支援的操作 ${domain}.${service}`);
  }

  const build = () => {
    const values = entityStates(radar.data);
    const states = {};
    for (const key of keys) {
      const value = values[key];
      const state = !radar.connected ? "unavailable" : value === undefined ? "unknown" : String(value);
      states[entityId(key)] = { entity_id: entityId(key), state, attributes: OPTIONS[key] ? { options: OPTIONS[key] } : {} };
    }
    return { states, entities, devices, callService, user: { is_admin: true }, language: "zh-Hant" };
  };

  const update = () => onChange(build());
  radar.addEventListener("change", update);
  update();
  return () => radar.removeEventListener("change", update);
}
