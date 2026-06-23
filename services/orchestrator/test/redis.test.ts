import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { RespClient } from "../src/redis/resp.ts";
import { parseXReadGroup } from "../src/bridge/redisSource.ts";

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
