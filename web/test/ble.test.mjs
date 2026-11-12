import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FrameReader,
  LD2410Radar,
  ackOf,
  buildCommand,
  buildUplink,
  parseUplink,
  passwordBytes,
  CMD,
} from "../ld2410-ble.js";
import { createFakeDevice } from "../fake-radar.js";
import { createHass, savedKey } from "../hass-bridge.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (check()) return;
  assert.fail("timed out");
};
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
};

test("command frames match the protocol document", () => {
  // 協定文件範例：進入設定模式
  assert.deepEqual([...buildCommand(CMD.enableConfig, [0x01, 0x00])], [0xfd, 0xfc, 0xfb, 0xfa, 0x04, 0x00, 0xff, 0x00, 0x01, 0x00, 0x04, 0x03, 0x02, 0x01]);
  assert.deepEqual(ackOf(CMD.enableConfig), [0xff, 0x01]);
  assert.deepEqual(passwordBytes("HiLink"), [0x48, 0x69, 0x4c, 0x69, 0x6e, 0x6b]);
  assert.throws(() => passwordBytes("short"));
  assert.throws(() => passwordBytes("中文密碼長度"));
});

test("frame reader joins split notifications and skips garbage", () => {
  const uplink = [...buildUplink([0x02, 0xaa, 0x01, 0x64, 0x00, 0x30, 0x00, 0x00, 0x00, 0x64, 0x00, 0x55, 0x00])];
  const ack = [...buildCommand([0xfe, 0x01], [0, 0])];
  const reader = new FrameReader();
  const stream = [0x00, 0x13, ...uplink, ...ack];
  const frames = [];
  for (let i = 0; i < stream.length; i += 7) frames.push(...reader.push(stream.slice(i, i + 7)));
  assert.deepEqual(frames.map((f) => f.kind), ["data", "ack"]);
  assert.deepEqual(frames[1].payload, [0xfe, 0x01, 0, 0]);
  // 長度對但結尾錯：丟掉，不會卡住後面的框
  const broken = [...uplink.slice(0, -1), 0x99];
  assert.deepEqual(new FrameReader().push([...broken, ...ack]).map((f) => f.kind), ["ack"]);
});

test("uplink parsing matches the integration", () => {
  const basic = parseUplink([0x02, 0xaa, 0x03, 0x64, 0x00, 0x30, 0x2c, 0x01, 0x40, 0x96, 0x00, 0x55, 0x00]);
  assert.equal(basic.moving, true);
  assert.equal(basic.stationary, true);
  assert.equal(basic.moveDistance, 100);
  assert.equal(basic.stillDistance, 300);
  assert.equal(basic.detectDistance, 150);
  const eng = parseUplink([0x01, 0xaa, 0x02, 0, 0, 0, 0x2c, 0x01, 0x40, 0, 0, 2, 2, 1, 2, 3, 4, 5, 6, 77, 1, 0x55, 0x00]);
  assert.deepEqual(eng.moveGateEnergy, [1, 2, 3]);
  assert.deepEqual(eng.stillGateEnergy, [4, 5, 6]);
  assert.equal(eng.photo, 77);
  assert.equal(eng.outPin, true);
  assert.equal(eng.moving, false);
  assert.equal(parseUplink([0x01, 0x00]), null);
  assert.throws(() => parseUplink([0x01, 0xaa, 0x02, 0, 0x55, 0x00]));
});

test("connect reads settings and streams energies", async () => {
  const device = createFakeDevice({ interval: 20 });
  const radar = new LD2410Radar(device);
  await radar.connect("HiLink");
  assert.equal(radar.connected, true);
  assert.deepEqual(radar.data.moveSensitivity, device.radar.move);
  assert.equal(radar.data.absenceDelay, 5);
  assert.equal(radar.data.resolution, 0);
  assert.equal(radar.data.lightThreshold, 0x80);
  assert.equal(radar.data.firmware, "V2.44.24073110");
  await until(() => radar.data.moveGateEnergy?.length === 9);
  radar.disconnect();
});

test("wrong password is reported and does not reconnect", async () => {
  const device = createFakeDevice({ password: "abc123" });
  const radar = new LD2410Radar(device);
  await assert.rejects(radar.connect("HiLink"), /密碼錯誤/);
  await wait(50);
  assert.equal(radar.connected, false);
  assert.equal(device.gatt.connected, false);
});

test("the panel's service calls become radar commands", async () => {
  const device = createFakeDevice({ interval: 20, msPerSecond: 0 });
  const radar = new LD2410Radar(device);
  await radar.connect("HiLink");
  let hass;
  const storage = memoryStorage();
  const unbind = createHass(radar, (h) => (hass = h), { storage, sleep: () => wait(1) });
  const call = (domain, service, data) => hass.callService(domain, service, data);

  assert.equal(hass.states["number.ld2410_mg3_sensitivity"].state, "30");
  assert.deepEqual(hass.states["select.ld2410_distance_resolution"].attributes.options, ["0.75 m", "0.20 m"]);
  assert.equal(Object.values(hass.entities).every((e) => e.platform === "ld2410" && e.device_id === device.id), true);

  // 單格門檻：只改移動，靜止沿用雷達的值
  await call("number", "set_value", { entity_id: "number.ld2410_mg3_sensitivity", value: 72 });
  assert.equal(device.radar.move[3], 72);
  assert.equal(device.radar.still[3], 40);
  assert.equal(hass.states["number.ld2410_mg3_sensitivity"].state, "72");

  // 最遠偵測閘與無人延遲共用一個指令
  await call("number", "set_value", { entity_id: "number.ld2410_absence_delay", value: 12 });
  await call("number", "set_value", { entity_id: "number.ld2410_max_still_gate", value: 5 });
  assert.deepEqual([device.radar.maxMove, device.radar.maxStill, device.radar.delay], [8, 5, 12]);

  await call("select", "select_option", { entity_id: "select.ld2410_light_function", option: "dimmer than" });
  await call("number", "set_value", { entity_id: "number.ld2410_light_sensitivity", value: 40 });
  assert.deepEqual([...device.radar.aux], [1, 40, 0]);

  // 存檔 → 改掉 → 還原
  await call("button", "press", { entity_id: "button.ld2410_save_sensitivities" });
  assert.equal(JSON.parse(storage.getItem(savedKey(radar))).move[3], 72);
  await call("number", "set_value", { entity_id: "number.ld2410_sg0_sensitivity", value: 99 });
  await call("button", "press", { entity_id: "button.ld2410_load_sensitivities" });
  assert.equal(device.radar.still[0], 0);

  // 自動校準：等雷達完成後重新讀門檻
  await call("button", "press", { entity_id: "button.ld2410_auto_sensitivities" });
  assert.equal(hass.states["number.ld2410_mg0_sensitivity"].state, "45");

  // 同時送出多個指令會排隊，不會互相打斷
  await Promise.all(
    [0, 1, 2].map((g) => call("number", "set_value", { entity_id: `number.ld2410_sg${g}_sensitivity`, value: 60 + g })),
  );
  assert.deepEqual(device.radar.still.slice(0, 3), [60, 61, 62]);

  await assert.rejects(call("number", "set_value", { entity_id: "number.ld2410_unknown", value: 1 }));
  unbind();
  radar.disconnect();
  await wait(10);
  assert.equal(radar.connected, false);
});

test("reboot reconnects and turns engineering mode back on", async () => {
  const device = createFakeDevice({ interval: 20 });
  const radar = new LD2410Radar(device);
  await radar.connect("HiLink");
  let hass;
  createHass(radar, (h) => (hass = h), { storage: memoryStorage() });
  await hass.callService("select", "select_option", { entity_id: "select.ld2410_distance_resolution", option: "0.20 m" });
  await until(() => !radar.connected);
  assert.equal(hass.states["sensor.ld2410_motion_gate_0_energy"].state, "unavailable");
  await until(() => radar.connected, 3000);
  assert.equal(radar.data.resolution, 1);
  assert.equal(device.radar.engineering, true);
  radar.disconnect();
});
