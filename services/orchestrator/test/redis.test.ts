import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { RespClient } from "../src/redis/resp.ts";
import { parseXReadGroup } from "../src/bridge/redisSource.ts";
import { resolveRedis } from "../src/config.ts";

test("resolveRedis: parses a rediss:// URL (managed Redis with auth + TLS)", () => {
  const r = resolveRedis({ CAVIX_REDIS_URL: "rediss://default:p%40ss@my-redis.cloud.example.com:6380" } as NodeJS.ProcessEnv);
  assert.equal(r.host, "my-redis.cloud.example.com");
  assert.equal(r.port, 6380);
  assert.equal(r.username, "default");
  assert.equal(r.password, "p@ss"); // URL-decoded
  assert.equal(r.tls, true);
});

test("resolveRedis: discrete vars, no TLS by default; localhost fallback", () => {
  assert.deepEqual(resolveRedis({ CAVIX_REDIS_HOST: "10.0.0.5", CAVIX_REDIS_PORT: "6379", CAVIX_REDIS_PASSWORD: "pw" } as NodeJS.ProcessEnv),
    { host: "10.0.0.5", port: 6379, username: undefined, password: "pw", tls: false });
  assert.equal(resolveRedis({} as NodeJS.ProcessEnv).host, "127.0.0.1");
});

// parseXReadGroup is the trickiest decode (nested arrays). Test it directly with
// the structure XREADGROUP returns: [[stream, [[id, [field, value, ...]]]]].
test("parseXReadGroup: extracts the 'job' field from stream entries", () => {
  const reply = [
    ["cavix:reviewjobs", [
      ["1700-0", ["job", '{"repo":"acme/widget"}']],
      ["1700-1", ["job", '{"repo":"acme/other"}', "extra", "ignored"]],
    ]],
  ];
  const entries = parseXReadGroup(reply);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, "1700-0");
  assert.equal(entries[0].job, '{"repo":"acme/widget"}');
  assert.equal(entries[1].id, "1700-1");
});

test("parseXReadGroup: null reply (BLOCK timeout, no data) → empty", () => {
  assert.deepEqual(parseXReadGroup(null), []);
});

// Loopback test of the RESP client: a fake server replies with a bulk string,
// delivered in TWO chunks to prove the client's buffering reassembles a reply
// split across TCP packets. No real Redis required.
test("RespClient: parses a reply split across multiple TCP chunks", async () => {
  const server = net.createServer((sock) => {
    sock.once("data", () => {
      // "$11\r\nhello world\r\n" split mid-payload.
      sock.write("$11\r\nhel");
      setTimeout(() => sock.write("lo world\r\n"), 15);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  const client = await RespClient.connect("127.0.0.1", port);
  const reply = await client.command("PING");
  assert.equal(reply, "hello world");
  client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

// Managed Redis (Redis Cloud/Upstash) requires AUTH: the client must send the
// password immediately after connecting, before any other command.
test("RespClient: sends AUTH before commands when a password is given", async () => {
  let firstCmd = "";
  const server = net.createServer((sock) => {
    sock.once("data", (buf) => {
      firstCmd = buf.toString();
      sock.write("+OK\r\n"); // AUTH ok
      sock.once("data", () => sock.write("+PONG\r\n")); // PING
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  const client = await RespClient.connect("127.0.0.1", port, { username: "default", password: "s3cret" });
  const reply = await client.command("PING");
  assert.equal(reply, "PONG");
  assert.match(firstCmd, /AUTH/);
  assert.match(firstCmd, /default/);
  assert.match(firstCmd, /s3cret/);
  client.close();
  await new Promise<void>((r) => server.close(() => r()));
});

test("RespClient: a failed AUTH rejects connect()", async () => {
  const server = net.createServer((sock) => {
    sock.once("data", () => sock.write("-WRONGPASS invalid username-password pair\r\n"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  await assert.rejects(() => RespClient.connect("127.0.0.1", port, { password: "nope" }), /AUTH failed/);
  await new Promise<void>((r) => server.close(() => r()));
});

test("RespClient: surfaces a RESP error reply as a rejection", async () => {
  const server = net.createServer((sock) => {
    sock.once("data", () => sock.write("-ERR bad command\r\n"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  const client = await RespClient.connect("127.0.0.1", port);
  await assert.rejects(() => client.command("BOGUS"), /bad command/);
  client.close();
  await new Promise<void>((r) => server.close(() => r()));
});
