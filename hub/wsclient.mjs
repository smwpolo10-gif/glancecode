// A small WebSocket client (RFC 6455) for talking to Codex's app-server. Node 20 has
// no built-in WebSocket, and this one can also connect over a unix socket, which
// keeps the Codex server off the network entirely.
import { EventEmitter } from "node:events";
import { randomBytes, createHash } from "node:crypto";
import { request } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * @param {string} address ws://host:port[/path] or unix:///absolute/path.sock
 * Events: "open", "message" (string), "close" (code, reason), "error" (err)
 */
export class WsClient extends EventEmitter {
  constructor(address, { headers = {}, timeoutMs = 5000 } = {}) {
    super();
    this.address = address;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;

    const key = randomBytes(16).toString("base64");
    const opts = { method: "GET", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, ...headers }, timeout: timeoutMs };
    if (address.startsWith("unix://")) {
      Object.assign(opts, { socketPath: address.slice("unix://".length), path: "/", host: "localhost" });
    } else {
      const url = new URL(address);
      Object.assign(opts, { host: url.hostname, port: url.port || 80, path: url.pathname + url.search });
      opts.headers.Host = url.host;
    }

    const req = request(opts);
    req.on("upgrade", (res, socket, head) => {
      const expected = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        return this.fail(new Error("bad websocket handshake"));
      }
      socket.setNoDelay(true);
      socket.setTimeout(0);
      this.socket = socket;
      socket.on("data", (chunk) => this.onData(chunk));
      socket.on("close", () => this.finish(1006, "connection lost"));
      socket.on("error", (err) => this.fail(err));
      if (head?.length) this.onData(head);
      this.emit("open");
    });
    req.on("response", (res) => this.fail(new Error(`server refused websocket (${res.statusCode})`)));
    req.on("timeout", () => req.destroy(new Error("websocket connect timed out")));
    req.on("error", (err) => this.fail(err));
    req.end();
  }

  get open() {
    return !!this.socket && !this.closed;
  }

  send(text) {
    if (!this.open) throw new Error("websocket is not open");
    this.socket.write(frame(0x1, Buffer.from(text, "utf8")));
  }

  close(code = 1000) {
    if (this.socket && !this.closed) {
      const body = Buffer.alloc(2);
      body.writeUInt16BE(code);
      this.socket.write(frame(0x8, body));
      this.socket.end();
    }
    this.finish(code, "closed by client");
  }

  fail(err) {
    if (this.closed) return;
    this.emit("error", err);
    this.finish(1006, err.message);
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.emit("close", code, reason);
  }

  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;
      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
      }
      this.buffer = this.buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) return this.finish(payload.length >= 2 ? payload.readUInt16BE(0) : 1005, payload.subarray(2).toString("utf8"));
      if (opcode === 0x9) {
        this.socket?.write(frame(0xa, payload)); // pong
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.fragments.push(Buffer.from(payload));
        if (fin) {
          const message = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.emit("message", message);
        }
      }
    }
  }
}

/** Client frames are always masked. */
function frame(opcode, payload) {
  const len = payload.length;
  const header = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (len < 126) header[1] = 0x80 | len;
  else if (len < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
