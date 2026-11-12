/**
 * LD2410 藍牙協定（Web Bluetooth 版）。
 *
 * 移植自整合的 api/devices/ld2410.py，協定說明見 api/const/__init__.py。
 * 指令與回覆格式：FDFCFBFA + 長度(2) + 指令字(2) + 值 + 04030201；
 * 雷達主動送的資料框：F4F3F2F1 + 長度(2) + 內容 + F8F7F6F5。
 */

export const SERVICES = [0xfff0, 0xaf30];
export const NOTIFY_UUID = "0000fff1-0000-1000-8000-00805f9b34fb";
export const WRITE_UUID = "0000fff2-0000-1000-8000-00805f9b34fb";
export const NAME_PREFIXES = ["HLK-LD2410", "HLK-LD2401"];

const TX_HEADER = [0xfd, 0xfc, 0xfb, 0xfa];
const TX_FOOTER = [0x04, 0x03, 0x02, 0x01];
const RX_HEADER = [0xf4, 0xf3, 0xf2, 0xf1];
const RX_FOOTER = [0xf8, 0xf7, 0xf6, 0xf5];
const MAX_FRAME = 256;
const COMMAND_TIMEOUT_MS = 5_000;
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000];
const AUTO_THRESH_SECONDS = 10;

// 指令字，依線上傳送的位元組順序（"FF00" → FF 00）。
export const CMD = {
  enableConfig: [0xff, 0x00],
  endConfig: [0xfe, 0x00],
  setMaxGatesAndNobody: [0x60, 0x00],
  readParams: [0x61, 0x00],
  enableEngineering: [0x62, 0x00],
  setSensitivity: [0x64, 0x00],
  readFirmware: [0xa0, 0x00],
  reboot: [0xa3, 0x00],
  permission: [0xa8, 0x00],
  setResolution: [0xaa, 0x00],
  getResolution: [0xab, 0x00],
  setAux: [0xad, 0x00],
  getAux: [0xae, 0x00],
  startAutoThresh: [0x0b, 0x00],
  queryAutoThresh: [0x1b, 0x00],
};

const OK = [0x00, 0x00];

export const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
export const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const le = (bytes) => bytes.reduce((sum, b, i) => sum + b * 256 ** i, 0);
const startsWith = (bytes, prefix, at = 0) => prefix.every((b, i) => bytes[at + i] === b);
const hex = (b) => b.toString(16).padStart(2, "0");

/** 回覆的指令字：送出指令字的最低位元設為 1（FF00 → FF01）。 */
export const ackOf = (cmd) => [cmd[0], cmd[1] ^ 0x01];

export function buildCommand(cmd, value = []) {
  const body = [...cmd, ...value];
  return Uint8Array.from([...TX_HEADER, ...u16(body.length), ...body, ...TX_FOOTER]);
}

export function buildUplink(content) {
  return Uint8Array.from([...RX_HEADER, ...u16(content.length), ...content, ...RX_FOOTER]);
}

/** 密碼：6 個 ASCII 字元，原樣送出（"HiLink" → 48 69 4C 69 6E 6B）。 */
export function passwordBytes(password) {
  const bytes = [...password].map((c) => c.charCodeAt(0));
  if (bytes.length !== 6 || bytes.some((b) => b < 0x20 || b > 0x7e)) {
    throw new Error("藍牙密碼必須是 6 個英數字元");
  }
  return bytes;
}

/**
 * 把藍牙通知接成完整的資料框。通知可能一次帶半個框或好幾個框，
 * 所以先緩衝，再依標頭與長度切開；對不上的位元組丟掉。
 */
export class FrameReader {
  constructor() {
    this._buf = [];
  }

  push(bytes) {
    this._buf.push(...bytes);
    const frames = [];
    for (;;) {
      const start = this._buf.findIndex((_, i) => startsWith(this._buf, TX_HEADER, i) || startsWith(this._buf, RX_HEADER, i));
      if (start < 0) {
        this._buf = this._buf.slice(-3); // 可能是下一個標頭的開頭
        break;
      }
      this._buf = this._buf.slice(start);
      if (this._buf.length < 6) break;
      const length = le(this._buf.slice(4, 6));
      const total = 10 + length;
      const command = startsWith(this._buf, TX_HEADER);
      if (length > MAX_FRAME) {
        this._buf.shift();
        continue;
      }
      if (this._buf.length < total) break;
      if (!startsWith(this._buf, command ? TX_FOOTER : RX_FOOTER, total - 4)) {
        this._buf.shift();
        continue;
      }
      frames.push({ kind: command ? "ack" : "data", payload: this._buf.slice(6, 6 + length) });
      this._buf = this._buf.slice(total);
    }
    return frames;
  }
}

/** 解析雷達主動送出的資料框內容（去掉標頭、長度與結尾後）。 */
export function parseUplink(data) {
  if (data.length < 2 || data[1] !== 0xaa) return null;
  const engineering = data[0] === 0x01;
  if (!engineering && data[0] !== 0x02) throw new Error(`未知的資料框類型 ${hex(data[0])}`);
  if (data.at(-2) !== 0x55 || data.at(-1) !== 0x00) throw new Error("資料框結尾錯誤");
  const c = data.slice(2, -2);
  if (c.length < 9) throw new Error("資料框太短");
  const status = c[0];
  const moving = status === 0x01 || status === 0x03;
  const stationary = status === 0x02 || status === 0x03;
  const result = {
    engineering,
    moving,
    stationary,
    occupancy: moving || stationary,
    moveDistance: le(c.slice(1, 3)),
    moveEnergy: c[3],
    stillDistance: le(c.slice(4, 6)),
    stillEnergy: c[6],
    detectDistance: le(c.slice(7, 9)),
  };
  if (!engineering) return result;
  const moveLen = c[9] + 1;
  const stillLen = c[10] + 1;
  let i = 11;
  if (c.length < i + moveLen + stillLen + 2) throw new Error("工程模式資料不完整");
  result.moveGateEnergy = c.slice(i, (i += moveLen));
  result.stillGateEnergy = c.slice(i, (i += stillLen));
  result.photo = c[i];
  result.outPin = Boolean(c[i + 1]);
  return result;
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * 一台已選擇的雷達。事件：
 *  - "change"：data 或連線狀態改變
 *  - "status"：{detail: 文字} 給使用者看的連線進度
 */
export class LD2410Radar extends EventTarget {
  constructor(device) {
    super();
    this.device = device;
    this.data = {};
    this.connected = false;
    this._reader = new FrameReader();
    this._waiter = null;
    this._chain = Promise.resolve();
    this._closing = false;
    this._onDisconnect = () => this._handleDisconnect();
    device.addEventListener("gattserverdisconnected", this._onDisconnect);
  }

  get id() {
    return this.device.id;
  }

  get name() {
    return this.device.name || "LD2410";
  }

  /** 連線、送出密碼、開啟工程模式並讀取全部設定。密碼錯誤時丟出錯誤且不會自動重連。 */
  async connect(password) {
    this._password = password;
    this._closing = false;
    this._status("連線中…");
    const server = await this.device.gatt.connect();
    const [notify, write] = await findCharacteristics(server);
    this._write = write;
    this._reader = new FrameReader();
    this._onValue ??= (ev) => {
      const v = ev.target.value;
      this._receive(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    };
    // 重新連線時瀏覽器可能給同一個物件：先移除，避免每個框收到兩次。
    notify.removeEventListener("characteristicvaluechanged", this._onValue);
    notify.addEventListener("characteristicvaluechanged", this._onValue);
    await notify.startNotifications();
    try {
      if (password) {
        this._status("驗證藍牙密碼…");
        const reply = await this._exclusive(() => this._send(CMD.permission, passwordBytes(password)));
        if (!sameBytes(reply, OK)) throw new Error("藍牙密碼錯誤");
      }
      this._status("讀取設定…");
      await this._session(() => this._expectOk(CMD.enableEngineering, [], "無法開啟工程模式"));
      await this.readParams();
      await this.readResolution();
      await this.readLight();
      await this.readFirmware().catch(() => undefined); // 部分韌體不回覆，不影響使用
    } catch (err) {
      this._closing = true;
      this.device.gatt.disconnect();
      throw err;
    }
    this.connected = true;
    this._retry = 0;
    this._status("已連線");
    this._emit();
  }

  disconnect() {
    this._closing = true;
    clearTimeout(this._reconnectTimer);
    if (this.device.gatt.connected) this.device.gatt.disconnect();
    else this._handleDisconnect();
  }

  _handleDisconnect() {
    const was = this.connected;
    this.connected = false;
    this._waiter?.reject(new Error("藍牙已斷線"));
    this._waiter = null;
    this._emit();
    if (this._closing) {
      this._status("已斷線");
      return;
    }
    if (was || this._retry) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    const delay = RECONNECT_MS[Math.min(this._retry || 0, RECONNECT_MS.length - 1)];
    this._retry = (this._retry || 0) + 1;
    this._status(`連線中斷，${delay / 1000} 秒後重新連線（第 ${this._retry} 次）…`);
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(this._password);
      } catch (err) {
        if (/密碼/.test(err.message)) return this._status(err.message);
        this._closing = false;
        this._scheduleReconnect();
      }
    }, delay);
  }

  _status(text) {
    this.statusText = text;
    this.dispatchEvent(new CustomEvent("status", { detail: text }));
  }

  _emit() {
    this.dispatchEvent(new Event("change"));
  }

  _receive(bytes) {
    for (const frame of this._reader.push(bytes)) {
      if (frame.kind === "ack") {
        const w = this._waiter;
        if (w && sameBytes(frame.payload.slice(0, 2), w.ack)) {
          this._waiter = null;
          w.resolve(frame.payload.slice(2));
        }
        continue;
      }
      let parsed;
      try {
        parsed = parseUplink(frame.payload);
      } catch {
        continue;
      }
      if (!parsed) continue;
      this.data.lastFrame = Date.now();
      Object.assign(this.data, parsed);
      this._emit();
    }
  }

  /** 送出一個指令並等待回覆（不加鎖，呼叫端負責排隊）。 */
  async _send(cmd, value = [], wait = true) {
    const bytes = buildCommand(cmd, value);
    const reply = wait
      ? new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (this._waiter?.timer === timer) this._waiter = null;
            reject(new Error("雷達沒有回應"));
          }, COMMAND_TIMEOUT_MS);
          this._waiter = {
            ack: ackOf(cmd),
            timer,
            resolve: (v) => (clearTimeout(timer), resolve(v)),
            reject: (e) => (clearTimeout(timer), reject(e)),
          };
        })
      : null;
    if (this._write.writeValueWithoutResponse) await this._write.writeValueWithoutResponse(bytes);
    else await this._write.writeValue(bytes);
    return reply;
  }

  async _expectOk(cmd, value, message) {
    const reply = await this._send(cmd, value);
    if (!sameBytes(reply.slice(0, 2), OK)) throw new Error(message);
    return reply;
  }

  /** 藍牙一次只能處理一個指令：所有操作排成一列。 */
  _exclusive(fn) {
    const run = this._chain.then(fn, fn);
    this._chain = run.catch(() => undefined);
    return run;
  }

  /** 在一次「進入設定模式 … 結束設定模式」裡執行；出錯也會結束，否則雷達停止送資料。 */
  _session(fn, end = true) {
    return this._exclusive(async () => {
      await this._expectOk(CMD.enableConfig, [0x01, 0x00], "無法進入設定模式");
      try {
        return await fn();
      } finally {
        if (end) await this._send(CMD.endConfig).catch(() => undefined);
      }
    });
  }

  _set(values) {
    Object.assign(this.data, values);
    this._emit();
  }

  async readParams() {
    const r = await this._session(() => this._send(CMD.readParams));
    if (r.length < 10 || !sameBytes(r.slice(0, 2), OK) || r[2] !== 0xaa) throw new Error("無法讀取門檻設定");
    const p = r.slice(3);
    const n = p[0] + 1;
    if (p.length < 3 + n * 2 + 2) throw new Error("無法讀取門檻設定");
    this._set({
      maxMoveGate: p[1],
      maxStillGate: p[2],
      moveSensitivity: p.slice(3, 3 + n),
      stillSensitivity: p.slice(3 + n, 3 + 2 * n),
      absenceDelay: le(p.slice(3 + 2 * n, 5 + 2 * n)),
    });
  }

  async readResolution() {
    const r = await this._session(() => this._send(CMD.getResolution));
    if (r.length < 4 || !sameBytes(r.slice(0, 2), OK)) throw new Error("無法讀取距離解析度");
    this._set({ resolution: le(r.slice(2, 4)) });
  }

  async readLight() {
    const r = await this._session(() => this._send(CMD.getAux));
    if (r.length < 6 || !sameBytes(r.slice(0, 2), OK)) throw new Error("無法讀取光控設定");
    this._set({ lightFunction: r[2], lightThreshold: r[3], outLevel: r[4] });
  }

  /** 韌體版本，格式同 HLKRadarTool：V2.44.24073110。 */
  async readFirmware() {
    const r = await this._session(() => this._send(CMD.readFirmware));
    if (r.length < 10 || !sameBytes(r.slice(0, 2), OK)) throw new Error("無法讀取韌體版本");
    const minor = r.slice(6, 10).reverse().map(hex).join("");
    this._set({ firmware: `V${r[5].toString(16)}.${hex(r[4])}.${minor}` });
  }

  /** 設定一格的移動／靜止門檻；沒給的那個沿用雷達目前的值。 */
  setGateSensitivity(gate, { move, still }) {
    return this._session(async () => {
      move ??= this.data.moveSensitivity?.[gate];
      still ??= this.data.stillSensitivity?.[gate];
      if (move === undefined || still === undefined) throw new Error("還沒讀到雷達的門檻");
      await this._expectOk(CMD.setSensitivity, [...u16(0), ...u32(gate), ...u16(1), ...u32(move), ...u16(2), ...u32(still)], "門檻寫入失敗");
      const moveList = [...this.data.moveSensitivity];
      const stillList = [...this.data.stillSensitivity];
      moveList[gate] = move;
      stillList[gate] = still;
      this._set({ moveSensitivity: moveList, stillSensitivity: stillList });
    });
  }

  /** 最遠偵測閘與無人延遲共用一個指令；沒改的值沿用雷達目前的值。 */
  setMaxGatesAndDelay(changes) {
    return this._session(async () => {
      const v = {
        maxMoveGate: changes.maxMoveGate ?? this.data.maxMoveGate,
        maxStillGate: changes.maxStillGate ?? this.data.maxStillGate,
        absenceDelay: changes.absenceDelay ?? this.data.absenceDelay,
      };
      if (Object.values(v).includes(undefined)) throw new Error("還沒讀到雷達的設定");
      await this._expectOk(
        CMD.setMaxGatesAndNobody,
        [...u16(0), ...u32(v.maxMoveGate), ...u16(1), ...u32(v.maxStillGate), ...u16(2), ...u32(v.absenceDelay)],
        "設定寫入失敗",
      );
      this._set(v);
    });
  }

  setLight(changes) {
    return this._session(async () => {
      const v = {
        lightFunction: changes.lightFunction ?? this.data.lightFunction ?? 0,
        lightThreshold: changes.lightThreshold ?? this.data.lightThreshold ?? 0x80,
        outLevel: changes.outLevel ?? this.data.outLevel ?? 0,
      };
      await this._expectOk(CMD.setAux, [v.lightFunction, v.lightThreshold, v.outLevel, 0], "光控設定寫入失敗");
      this._set(v);
    });
  }

  /** 改距離解析度要重新開機才生效；重開後會自動重新連線。 */
  async setResolution(index) {
    await this._session(() => this._expectOk(CMD.setResolution, u16(index), "距離解析度寫入失敗"));
    this._set({ resolution: index });
    await this.reboot();
  }

  reboot() {
    // 不送「結束設定」：雷達重開後自己會離開設定模式。
    return this._session(() => this._send(CMD.reboot, [], false), false);
  }

  /** 雷達自動量測空房雜訊並設定全部門檻，完成後重新讀取門檻。 */
  async autoThresholds(sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    await this._session(() => this._expectOk(CMD.startAutoThresh, u16(AUTO_THRESH_SECONDS), "無法開始自動校準"));
    await sleep(AUTO_THRESH_SECONDS * 1000);
    for (let i = 0; i < 30; i++) {
      const r = await this._session(() => this._send(CMD.queryAutoThresh));
      if (le(r.slice(2, 4)) !== 1) return this.readParams(); // 0 閒置、1 進行中、2 完成
      await sleep(1000);
    }
    throw new Error("自動校準逾時");
  }
}

async function findCharacteristics(server) {
  for (const service of await server.getPrimaryServices()) {
    try {
      return [await service.getCharacteristic(NOTIFY_UUID), await service.getCharacteristic(WRITE_UUID)];
    } catch {
      /* 不是這個服務 */
    }
  }
  throw new Error("找不到 LD2410 的藍牙通道，確認選到的是 HLK-LD2410 雷達");
}
