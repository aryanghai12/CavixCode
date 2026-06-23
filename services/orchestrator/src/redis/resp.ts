import net from "node:net";

// A minimal RESP (v2) client over node:net — same philosophy as the Go edge:
// no third-party Redis dependency, so the orchestrator stays light and
// air-gapped-friendly. It supports exactly what the stream bridge needs:
// sending a command (array of bulk strings) and parsing one reply, including the
// nested arrays that XREADGROUP returns.

export type RespValue = string | number | null | RespValue[];

export class RespError extends Error {}

export class RespClient {
  private socket: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Array<{ resolve: (v: RespValue) => void; reject: (e: Error) => void }> = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.socket.on("error", (err) => this.failAll(err));
    this.socket.on("close", () => this.failAll(new Error("redis connection closed")));
  }

  static connect(host: string, port: number, timeoutMs = 5000): Promise<RespClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const onError = (err: Error) => {
        socket.destroy();
        reject(err);
      };
      socket.setTimeout(timeoutMs, () => onError(new Error(`redis connect timeout ${host}:${port}`)));
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeListener("error", onError);
        resolve(new RespClient(socket));
      });
    });
  }

  /** Send one command and resolve with the parsed reply (throws on -ERR). */
  command(...args: string[]): Promise<RespValue> {
    const out: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
    for (const a of args) {
      out.push(Buffer.from(`$${Buffer.byteLength(a)}\r\n`));
      out.push(Buffer.from(a));
      out.push(Buffer.from("\r\n"));
    }
    return new Promise<RespValue>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.socket.write(Buffer.concat(out));
    });
  }

  close(): void {
    this.socket.end();
  }

  private failAll(err: Error): void {
    const p = this.pending;
    this.pending = [];
    for (const { reject } of p) reject(err);
  }

  // Try to parse as many complete replies from the buffer as possible.
  private drain(): void {
    while (this.pending.length > 0) {
      const parsed = parseReply(this.buffer, 0);
      if (parsed === null) return; // need more bytes
      this.buffer = this.buffer.subarray(parsed.next);
      const waiter = this.pending.shift()!;
      if (parsed.value instanceof RespErrorBox) {
        waiter.reject(new RespError(parsed.value.message));
      } else {
        waiter.resolve(parsed.value as RespValue);
      }
    }
  }
}

// Internal box so parseReply can carry a RESP error up without throwing mid-parse.
class RespErrorBox {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

interface Parsed {
  value: RespValue | RespErrorBox;
  next: number;
}

function indexOfCRLF(buf: Buffer, from: number): number {
  for (let i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

export function parseReply(buf: Buffer, off: number): Parsed | null {
  if (off >= buf.length) return null;
  const lineEnd = indexOfCRLF(buf, off);
  if (lineEnd === -1) return null;
  const type = buf[off];
  const line = buf.toString("utf8", off + 1, lineEnd);
  const afterLine = lineEnd + 2;

  switch (type) {
    case 0x2b: // '+' simple string
      return { value: line, next: afterLine };
    case 0x2d: // '-' error
      return { value: new RespErrorBox(line), next: afterLine };
    case 0x3a: // ':' integer
      return { value: Number(line), next: afterLine };
    case 0x24: {
      // '$' bulk string
      const len = Number(line);
      if (len < 0) return { value: null, next: afterLine };
      const end = afterLine + len;
      if (buf.length < end + 2) return null;
      return { value: buf.toString("utf8", afterLine, end), next: end + 2 };
    }
    case 0x2a: {
      // '*' array
      const count = Number(line);
      if (count < 0) return { value: null, next: afterLine };
      const arr: RespValue[] = [];
      let cur = afterLine;
      for (let i = 0; i < count; i++) {
        const r = parseReply(buf, cur);
        if (r === null) return null;
        if (r.value instanceof RespErrorBox) {
          // Surface nested errors as a string element rather than aborting.
          arr.push(r.value.message);
        } else {
          arr.push(r.value);
        }
        cur = r.next;
      }
      return { value: arr, next: cur };
    }
    default:
      return { value: new RespErrorBox(`unknown reply type ${String.fromCharCode(type)}`), next: afterLine };
  }
}
