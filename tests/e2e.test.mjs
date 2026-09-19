// Real HTTP round-trip through the SDK client (Streamable HTTP) — what Alexa+ / the inspector will do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../server.js";
import { openStore } from "../src/store.js";
import { makeLensClient } from "../src/lens.js";

test("initialize negotiates 2025-11-25; 4 tools listed; call + delete path", async () => {
  const store = openStore(":memory:");
  const lens = makeLensClient({ env: {} });
  const { server } = createApp({ store, lens, now: () => new Date("2026-10-10T20:00:00Z") });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.protocolVersion, "2025-11-25");

    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    assert.ok(client.getInstructions().includes("not prophecy"));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_daily_lens", "get_reflection_history", "get_reflection_prompt", "save_journal_entry"]);

    const p = await client.callTool({ name: "get_reflection_prompt", arguments: { tz: "America/Los_Angeles", mood: "low" } });
    assert.equal(p.structuredContent.date, "2026-10-10");
    assert.equal(p.structuredContent.questions.length, 3);

    const s = await client.callTool({ name: "save_journal_entry", arguments: { profile_id: "judge", text: "First entry." } });
    assert.equal(s.structuredContent.streak, 1);
    const h = await client.callTool({ name: "get_reflection_history", arguments: { profile_id: "judge" } });
    assert.equal(h.structuredContent.entries.length, 1);

    const bad = await client.callTool({ name: "save_journal_entry", arguments: { text: "" } });
    assert.equal(bad.isError, true);

    const lensOff = await client.callTool({ name: "get_daily_lens", arguments: { birth: { year: 1990, month: 5, day: 15, hour: 10, tz: "Asia/Seoul" } } });
    assert.equal(lensOff.isError, true);
    assert.equal(lensOff.structuredContent.error, "lens_unavailable");

    const del = await (await fetch(`${base}/profiles/judge`, { method: "DELETE" })).json();
    assert.equal(del.entries_deleted, 1);
    const h2 = await client.callTool({ name: "get_reflection_history", arguments: { profile_id: "judge" } });
    assert.equal(h2.structuredContent.entries.length, 0);
    await client.close();
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
  }
});

test("DR_ACCESS_TOKEN guards /mcp and /profiles, not /health", async () => {
  process.env.DR_ACCESS_TOKEN = "s3cret";
  const store = openStore(":memory:");
  const { server } = createApp({ store, lens: makeLensClient({ env: {} }) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/profiles/x`, { method: "DELETE" })).status, 401);
    const noAuth = new Client({ name: "e2e", version: "0" });
    await assert.rejects(noAuth.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))));
    const ok = new Client({ name: "e2e", version: "0" });
    await ok.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { "X-DR-Token": "s3cret" } } }));
    assert.equal((await ok.listTools()).tools.length, 4);
    await ok.close();
  } finally {
    delete process.env.DR_ACCESS_TOKEN;
    await new Promise((r) => server.close(r));
    store.close();
  }
});
