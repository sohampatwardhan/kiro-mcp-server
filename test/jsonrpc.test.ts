import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { JsonRpcPeer, RpcClosedError, RpcError, RpcTimeoutError } from "../src/acp/jsonrpc.js";

/** A peer wired to in-memory streams: `agentIn` feeds the peer, `agentOut` collects what it writes. */
function harness(maxLineBytes = 1024) {
  const agentIn = new PassThrough();
  const agentOut = new PassThrough();
  const written: Record<string, unknown>[] = [];
  let buf = "";
  agentOut.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      written.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      buf = buf.slice(i + 1);
    }
  });
  const peer = new JsonRpcPeer(agentIn, agentOut, { maxLineBytes });
  return { peer, agentIn, written };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("JsonRpcPeer", () => {
  it("matches responses to requests by id, across chunk boundaries", async () => {
    const response = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: "✓ multi-byte" } }) + "\n";
    const bytes = Buffer.from(response, "utf8");
    for (let split = 1; split < bytes.length; split += 7) {
      const { peer, agentIn, written } = harness();
      const pending = peer.request("ping", { a: 1 });
      await tick();
      assert.deepEqual(written[0], { jsonrpc: "2.0", id: 1, method: "ping", params: { a: 1 } });
      agentIn.write(bytes.subarray(0, split));
      agentIn.write(bytes.subarray(split));
      assert.deepEqual(await pending, { ok: "✓ multi-byte" });
      peer.close();
    }
  });

  it("rejects with RpcError carrying code and data", async () => {
    const { peer, agentIn } = harness();
    const pending = peer.request("x", {});
    agentIn.write(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "nope", data: { errorType: "E" } } }) + "\n");
    await assert.rejects(pending, (err: unknown) => err instanceof RpcError && err.code === -32601 && (err.data as { errorType: string }).errorType === "E");
  });

  it("routes notifications and agent-to-client requests", async () => {
    const { peer, agentIn, written } = harness();
    const seen: unknown[] = [];
    peer.onNotification("session/update", (params) => seen.push(params));
    const any: string[] = [];
    peer.onAnyNotification((_params, method) => any.push(method));
    peer.onRequest("session/request_permission", async (params) => ({ echoed: params }));
    agentIn.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { n: 1 } }) + "\n");
    agentIn.write(JSON.stringify({ jsonrpc: "2.0", method: "_kiro/mcp/status", params: {} }) + "\n");
    agentIn.write(JSON.stringify({ jsonrpc: "2.0", id: "a1", method: "session/request_permission", params: { q: 1 } }) + "\n");
    await tick();
    assert.deepEqual(seen, [{ n: 1 }]);
    assert.deepEqual(any, ["session/update", "_kiro/mcp/status"]);
    assert.deepEqual(written.at(-1), { jsonrpc: "2.0", id: "a1", result: { echoed: { q: 1 } } });
  });

  it("answers unhandled agent-to-client requests with -32601 at once", async () => {
    const { peer, agentIn, written } = harness();
    void peer;
    for (const method of ["fs/read_text_file", "terminal/create", "_kiro/auth/getAccessToken", "_kiro/openExternalUrl"]) {
      agentIn.write(JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} }) + "\n");
    }
    await tick();
    assert.equal(written.length, 4);
    for (const reply of written) assert.equal((reply.error as { code: number }).code, -32601);
  });

  it("maps a throwing handler to an error response", async () => {
    const { peer, agentIn, written } = harness();
    peer.onRequest("boom", () => {
      throw new RpcError(-32602, "bad params");
    });
    agentIn.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "boom", params: {} }) + "\n");
    await tick();
    assert.deepEqual(written[0], { jsonrpc: "2.0", id: 9, error: { code: -32602, message: "bad params" } });
  });

  it("drops oversized and invalid lines, counts them, and keeps going", async () => {
    const { peer, agentIn } = harness(64);
    const seen: unknown[] = [];
    peer.onNotification("n", (p) => seen.push(p));
    agentIn.write("x".repeat(40));
    agentIn.write("y".repeat(40) + "\n");
    agentIn.write("not json\n");
    agentIn.write("[1,2]\n");
    agentIn.write(JSON.stringify({ jsonrpc: "2.0", method: "n", params: 1 }) + "\n");
    await tick();
    assert.equal(peer.droppedLines, 3);
    assert.deepEqual(seen, [1]);
  });

  it("times out a request", async () => {
    const { peer } = harness();
    await assert.rejects(peer.request("slow", {}, 20), RpcTimeoutError);
  });

  it("rejects pending requests and refuses new ones after close", async () => {
    const { peer, agentIn } = harness();
    const closed: string[] = [];
    peer.onClose((reason) => closed.push(reason));
    const pending = peer.request("x", {});
    agentIn.end();
    await assert.rejects(pending, RpcClosedError);
    await assert.rejects(peer.request("y", {}), RpcClosedError);
    assert.equal(closed.length, 1);
  });
});
