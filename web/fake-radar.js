/**
 * 模擬的 LD2410（示範模式與測試用）。
 *
 * 實作網頁版用到的那一小部分 Web Bluetooth 介面，雷達端照協定回覆指令、
 * 每 100 ms 送一個工程模式資料框。通知刻意切成 20 位元組，模擬藍牙分段。
 */
import { NOTIFY_UUID, WRITE_UUID, FrameReader, buildUplink, u16 } from "./ld2410-ble.js";

const reply = (cmd, payload) => {
  const body = [cmd[0], cmd[1] | 0x01, ...payload];
  return [0xfd, 0xfc, 0xfb, 0xfa, ...u16(body.length), ...body, 0x04, 0x03, 0x02, 0x01];
};
const le = (bytes) => bytes.reduce((sum, b, i) => sum + b * 256 ** i, 0);

export function createFakeDevice({ password = "HiLink", name = "HLK-LD2410_DEMO", interval = 100, msPerSecond = 1000 } = {}) {
  const radar = {
    move: [50, 50, 40, 30, 20, 15, 15, 15, 15],
    still: [0, 0, 40, 40, 30, 30, 20, 20, 20],
    maxMove: 8,
    maxStill: 8,
    delay: 5,
    resolution: 0,
    aux: [0, 0x80, 0],
    engineering: false,
    config: false,
    allowed: false,
    autoUntil: 0,
  };
  const scene = { t: 0, holdUntil: 0 };
  const device = new EventTarget();
  const notify = new EventTarget();
  const reader = new FrameReader();
  let timer = null;

  const send = (bytes) => {
    for (let i = 0; i < bytes.length; i += 20) {
      notify.value = new DataView(Uint8Array.from(bytes.slice(i, i + 20)).buffer);
      notify.dispatchEvent(new Event("characteristicvaluechanged"));
    }
  };

  const handle = (cmd, v) => {
    const word = (cmd[0] << 8) | cmd[1];
    const ok = [0, 0];
    if (word === 0xa800) {
      radar.allowed = String.fromCharCode(...v) === password;
      return reply(cmd, radar.allowed ? ok : [1, 0]);
    }
    if (!radar.allowed) return null; // 沒驗證密碼的指令一律不理
    if (word === 0xff00) return (radar.config = true), reply(cmd, [0, 0, 1, 0, 0, 0x40]);
    if (word === 0xfe00) return (radar.config = false), reply(cmd, ok);
    if (!radar.config) return reply(cmd, [1, 0]);
    switch (word) {
      case 0x6200:
        radar.engineering = true;
        return reply(cmd, ok);
      case 0x6100:
        return reply(cmd, [0, 0, 0xaa, 8, radar.maxMove, radar.maxStill, ...radar.move, ...radar.still, ...u16(radar.delay)]);
      case 0x6400: {
        const gate = le(v.slice(2, 6));
        radar.move[gate] = le(v.slice(8, 12));
        radar.still[gate] = le(v.slice(14, 18));
        return reply(cmd, ok);
      }
      case 0x6000:
        radar.maxMove = le(v.slice(2, 6));
        radar.maxStill = le(v.slice(8, 12));
        radar.delay = le(v.slice(14, 18));
        return reply(cmd, ok);
      case 0xa000:
        return reply(cmd, [0, 0, 1, 0, 0x44, 0x02, 0x10, 0x31, 0x07, 0x24]);
      case 0xab00:
        return reply(cmd, [0, 0, ...u16(radar.resolution)]);
      case 0xaa00:
        radar.resolution = le(v.slice(0, 2));
        return reply(cmd, ok);
      case 0xae00:
        return reply(cmd, [0, 0, ...radar.aux, 0]);
      case 0xad00:
        radar.aux = v.slice(0, 3);
        return reply(cmd, ok);
      case 0x0b00:
        radar.autoUntil = Date.now() + le(v) * msPerSecond;
        return reply(cmd, ok);
      case 0x1b00: {
        const done = Date.now() >= radar.autoUntil;
        if (done && radar.autoUntil) {
          radar.move = radar.move.map((_, g) => [45, 40, 35, 30, 25, 20, 20, 20, 20][g]);
          radar.still = radar.still.map((_, g) => [30, 30, 30, 30, 25, 25, 20, 20, 20][g]);
          radar.autoUntil = 0;
        }
        return reply(cmd, [0, 0, ...u16(done ? 2 : 1)]);
      }
      case 0xa300:
        setTimeout(() => server.disconnect(), 50);
        return null;
      default:
        return reply(cmd, [1, 0]);
    }
  };

  /** 一個人在房間裡走動、坐下又離開，空房時偶爾有一格雜訊跳一下。 */
  const frame = () => {
    scene.t += interval / 1000;
    const cycle = scene.t % 60;
    const present = cycle < 35;
    const walking = present && cycle < 15;
    const pos = walking ? 1 + 3 * Math.abs(Math.sin(scene.t / 5)) : 2.4; // 公尺
    const step = radar.resolution ? 0.2 : 0.75;
    const near = (g) => Math.max(0, 1 - Math.abs((g + 0.5) * step - pos) / (step * 1.5));
    const noise = () => Math.random() * 8;
    const move = radar.move.map((_, g) => Math.round(Math.min(100, noise() + 6 + (walking ? 80 * near(g) : present ? 10 * near(g) : 0))));
    const still = radar.still.map((_, g) => Math.round(Math.min(100, noise() + (g < 2 ? 25 : 5) + (present ? 60 * near(g) : 0))));
    if (!present && Math.random() < 0.01) still[3] = 70; // 偶發誤判
    const over = (list, limits, max) => list.some((e, g) => g <= max && e >= limits[g]);
    const moving = over(move, radar.move, radar.maxMove);
    const stillHit = over(still, radar.still, radar.maxStill);
    if (moving || stillHit) scene.holdUntil = scene.t + radar.delay;
    const hold = !moving && !stillHit && scene.t < scene.holdUntil;
    const status = (moving ? 1 : 0) | (stillHit || hold ? 2 : 0);
    const cm = Math.round(pos * 100);
    const content = [
      0x01, 0xaa, status,
      ...u16(moving ? cm : 0), Math.max(...move),
      ...u16(status & 2 ? cm : 0), Math.max(...still),
      ...u16(status ? cm : 0),
      8, 8, ...move, ...still,
      120, status ? 1 : 0,
      0x55, 0x00,
    ];
    send([...buildUplink(content)]);
  };

  const characteristic = (uuid) => {
    if (uuid === NOTIFY_UUID) return notify;
    if (uuid === WRITE_UUID) return write;
    throw new Error("not found");
  };
  const write = {
    async writeValueWithoutResponse(bytes) {
      if (!server.connected) throw new Error("GATT 已斷線");
      for (const f of reader.push([...bytes])) {
        const out = handle(f.payload.slice(0, 2), f.payload.slice(2));
        if (out) setTimeout(() => server.connected && send(out), 5);
      }
    },
  };
  notify.startNotifications = async () => {
    clearInterval(timer);
    timer = setInterval(() => server.connected && radar.engineering && !radar.config && frame(), interval);
  };
  const service = { getCharacteristic: async (uuid) => characteristic(uuid) };
  const server = {
    connected: false,
    async connect() {
      server.connected = true;
      return server;
    },
    getPrimaryServices: async () => [service],
    disconnect() {
      if (!server.connected) return;
      server.connected = false;
      clearInterval(timer);
      Object.assign(radar, { engineering: false, config: false, allowed: false });
      setTimeout(() => device.dispatchEvent(new Event("gattserverdisconnected")), 0);
    },
  };
  Object.assign(device, { id: `demo-${name}`, name, gatt: server, radar });
  return device;
}
