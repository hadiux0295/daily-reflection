// MCP Apps view (ui://) over a real Streamable HTTP round-trip, the week strip it draws, and the speech module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, CARD_URI, MCP_APP_MIME } from "../server.js";
import { openStore } from "../src/store.js";
import { makeLensClient } from "../src/lens.js";
import { makeSpeech, wavHeader } from "../src/speech.js";

const UI_EXT = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } } };

test("MCP Apps: 3 tools link ui://daily-reflection/card.html; the resource is a self-contained mcp-app view", async () => {
  const store = openStore(":memory:");
  const { server } = createApp({ store, lens: makeLensClient({ env: {} }), now: () => new Date("2026-10-22T03:00:00Z"), speech: makeSpeech({ env: {} }) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new Client({ name: "apps", version: "0" }, { capabilities: UI_EXT });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    const linked = tools.filter((t) => t._meta?.ui?.resourceUri === CARD_URI).map((t) => t.name).sort();
    assert.deepEqual(linked, ["get_reflection_history", "get_reflection_prompt", "save_journal_entry"]);
    assert.equal(tools.find((t) => t.name === "get_daily_lens")._meta, undefined);

    const { resources } = await client.listResources();
    assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]), [[CARD_URI, MCP_APP_MIME]]);
    const { contents } = await client.readResource({ uri: CARD_URI });
    assert.equal(contents[0].mimeType, MCP_APP_MIME);
    const html = contents[0].text;
    assert.match(html, /ui\/initialize/);
    assert.match(html, /ui\/notifications\/tool-result/);
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=["']https?:|fetch\(/, "view must not load anything from the network (default CSP is default-src 'none')");

    // week strip: 7 days oldest-first, today last, mood carried
    for (const [date, mood] of [["2026-10-19", "low"], ["2026-10-20", "neutral"], ["2026-10-21", "high"]]) {
      await client.callTool({ name: "save_journal_entry", arguments: { profile_id: "w", text: `entry ${date}`, mood, date, tz: "Asia/Seoul" } });
    }
    const s = await client.callTool({ name: "save_journal_entry", arguments: { profile_id: "w", text: "today", mood: "high", tz: "Asia/Seoul" } });
    assert.equal(s.structuredContent.streak, 4);
    const week = s.structuredContent.week;
    assert.equal(week.length, 7);
    assert.deepEqual(week.map((d) => d.done), [false, false, false, true, true, true, true]);
    assert.equal(week[6].date, "2026-10-22");
    assert.equal(week[3].mood, "low");
    const h = await client.callTool({ name: "get_reflection_history", arguments: { profile_id: "w", tz: "Asia/Seoul" } });
    assert.equal(h.structuredContent.week.length, 7);
    await client.close();

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.mcp_apps.resource, CARD_URI);
    assert.equal(health.speech.configured, false);
    const tts = await fetch(`${base}/sim/tts`, { method: "POST", body: "{}" });
    assert.equal(tts.status, 503);
  } finally { server.close(); }
});

test("speech endpoints are behind the access token like /sim/chat; the page itself stays public", async () => {
  const prev = process.env.DR_ACCESS_TOKEN; process.env.DR_ACCESS_TOKEN = "t0ken";
  const { server } = createApp({ store: openStore(":memory:"), lens: makeLensClient({ env: {} }), speech: makeSpeech({ env: { GEMINI_API_KEY: "x" } }) });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ["/sim/tts", "/sim/stt", "/sim/chat"]) assert.equal((await fetch(base + p, { method: "POST", body: "{}" })).status, 401, p);
    assert.equal((await fetch(base + "/sim")).status, 200);
    assert.equal((await fetch(base + "/sim/")).status, 200);
  } finally { server.close(); if (prev === undefined) delete process.env.DR_ACCESS_TOKEN; else process.env.DR_ACCESS_TOKEN = prev; }
});

test("speech: TTS wraps bare PCM as WAV, passes WAV through; STT returns the transcript; errors are clean", async () => {
  const calls = [];
  const pcm = Buffer.alloc(480);
  const reply = (part) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [part] } }] }) });
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), key: init.headers["x-goog-api-key"] });
    if (url.includes("pcm-tts")) return reply({ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcm.toString("base64") } });
    if (url.includes("tts")) return reply({ inlineData: { mimeType: "audio/wav", data: Buffer.concat([wavHeader(4, 24000), Buffer.alloc(4)]).toString("base64") } });
    return reply({ text: "  I gave it patience.\n" });
  };
  const sp = makeSpeech({ env: { GEMINI_API_KEY: "k" }, fetchImpl });
  const a = await sp.tts("Hello   there.");
  assert.equal(a.mimeType, "audio/wav");
  assert.equal(a.audio.subarray(0, 4).toString(), "RIFF");
  assert.equal(calls[0].body.contents[0].parts[0].text, "Hello there.");
  assert.equal(calls[0].key, "k");

  const sp2 = makeSpeech({ env: { GEMINI_API_KEY: "k", SPEECH_TTS_MODEL: "pcm-tts" }, fetchImpl });
  const b = await sp2.tts("Hi");
  assert.equal(b.audio.length, 44 + pcm.length);
  assert.equal(b.audio.readUInt32LE(24), 24000);

  const t = await sp.stt(Buffer.from("fake").toString("base64"), "audio/webm;codecs=opus");
  assert.deepEqual(t, { text: "I gave it patience." });
  assert.equal(calls.at(-1).body.contents[0].parts[0].inline_data.mime_type, "audio/webm");

  assert.deepEqual(await sp.tts("   "), { error: "empty_text" });
  assert.deepEqual(await sp.stt("", "audio/webm"), { error: "bad_audio" });
  const down = makeSpeech({ env: { GEMINI_API_KEY: "k" }, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  assert.deepEqual(await down.tts("x"), { error: "speech_http_429" });
});
