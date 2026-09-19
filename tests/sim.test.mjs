// Web-simulation agent: fake chat model, real MCP round-trip to the server's own /mcp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.js";
import { openStore } from "../src/store.js";
import { makeLensClient } from "../src/lens.js";
import { makeSimAgent, DEFAULT_SIM_MODEL } from "../src/sim.js";

/** A scripted OpenAI-compatible model: first turn calls a tool, second turn answers in prose. */
function fakeModel(script) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    const step = script[Math.min(seen.length - 1, script.length - 1)](body);
    if (step && step.__http) return new Response(step.body, { status: step.__http, headers: { "Content-Type": "application/json" } });
    return Response.json({ choices: [{ message: step }] });
  };
  return { fetchImpl, seen };
}

async function boot({ env = {}, sim } = {}) {
  const store = openStore(":memory:");
  const app = createApp({ store, lens: makeLensClient({ env: {} }), now: () => new Date("2026-10-10T20:00:00Z"), sim });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base, close: async () => { await new Promise((r) => app.server.close(r)); store.close(); } };
}

test("sim turn: tool call goes through MCP, profile_id/tz pinned, trace + reply returned", async () => {
  delete process.env.DR_ACCESS_TOKEN;
  const { fetchImpl, seen } = fakeModel([
    () => ({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "get_reflection_prompt", arguments: JSON.stringify({ mood: "low", profile_id: "attacker", tz: "Europe/Paris" }) } }] }),
    (body) => {
      const toolMsg = body.messages.find((m) => m.role === "tool");
      const r = JSON.parse(toolMsg.content);
      return { role: "assistant", content: `Today's theme is ${r.theme}. ${r.questions[0]}` };
    },
  ]);
  const sim = makeSimAgent({ env: { OPENROUTER_API_KEY: "test" }, fetchImpl });
  const app = await boot({ sim });
  try {
    const res = await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "Alexa, let's do my daily reflection." }], profile_id: "web-abc", tz: "Asia/Seoul" }) });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.model, DEFAULT_SIM_MODEL);
    assert.equal(out.trace.length, 1);
    assert.equal(out.trace[0].tool, "get_reflection_prompt");
    assert.equal(out.trace[0].args.profile_id, "web-abc", "server pins the browser's profile id over the model's");
    assert.equal(out.trace[0].args.tz, "Asia/Seoul");
    assert.equal(out.trace[0].result.date, "2026-10-11", "KST date, not the LA default");
    assert.match(out.reply, /Today's theme is/);
    // the model saw the MCP tool list as function tools and the server instructions in the system prompt
    assert.deepEqual(seen[0].tools.map((t) => t.function.name).sort(), ["get_daily_lens", "get_reflection_history", "get_reflection_prompt", "save_journal_entry"]);
    assert.match(seen[0].messages[0].content, /not prophecy/);
    assert.equal(seen[1].messages.filter((m) => m.role === "tool").length, 1);
  } finally { await app.close(); }
});

test("sim turn: crisis_referral from save_journal_entry is surfaced at the top level", async () => {
  delete process.env.DR_ACCESS_TOKEN;
  const { fetchImpl } = fakeModel([
    () => ({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "save_journal_entry", arguments: JSON.stringify({ text: "Some days I want to die." }) } }] }),
    () => ({ role: "assistant", content: "I hear you." }),
  ]);
  const sim = makeSimAgent({ env: { OPENROUTER_API_KEY: "test" }, fetchImpl });
  const app = await boot({ sim });
  try {
    const out = await (await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "x" }], profile_id: "p1", tz: "UTC" }) })).json();
    assert.match(out.crisis_referral, /findahelpline/);
    assert.equal(out.trace[0].result.streak, 1);
  } finally { await app.close(); }
});

test("sim turn: crisis wording in the user's own message triggers the referral even if the model saves nothing", async () => {
  delete process.env.DR_ACCESS_TOKEN;
  const { fetchImpl, seen } = fakeModel([() => ({ role: "assistant", content: "I'm here with you." })]);
  const app = await boot({ sim: makeSimAgent({ env: { OPENROUTER_API_KEY: "test" }, fetchImpl }) });
  try {
    const out = await (await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "I want to die." }] }) })).json();
    assert.match(out.crisis_referral, /findahelpline/);
    assert.equal(out.trace.length, 0);
    assert.ok(seen[0].messages.some((m) => m.role === "system" && m.content.includes("findahelpline")));
  } finally { await app.close(); }
});

test("sim turn: empty 200 body and 429 are retried, then a clean model_failed 503 if it never recovers", async () => {
  delete process.env.DR_ACCESS_TOKEN;
  const flaky = fakeModel([
    () => ({ __http: 200, body: JSON.stringify({ error: { message: "Provider returned error", code: 502 } }) }),
    () => ({ __http: 429, body: "{}" }),
    () => ({ role: "assistant", content: "recovered" }),
  ]);
  let app = await boot({ sim: makeSimAgent({ env: { OPENROUTER_API_KEY: "test" }, fetchImpl: flaky.fetchImpl }) });
  try {
    const out = await (await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })).json();
    assert.equal(out.reply, "recovered");
    assert.equal(flaky.seen.length, 3);
  } finally { await app.close(); }

  const dead = fakeModel([() => ({ __http: 500, body: "boom" })]);
  app = await boot({ sim: makeSimAgent({ env: { OPENROUTER_API_KEY: "test" }, fetchImpl: dead.fetchImpl }) });
  try {
    const res = await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(res.status, 503);
    const out = await res.json();
    assert.equal(out.error, "model_failed");
    assert.match(out.message, /model_http_500/);
    assert.equal(dead.seen.length, 3);
  } finally { await app.close(); }
});

test("sim routes: /sim serves html; /sim/chat 503 without key, 401 with token guard; health reports sim", async () => {
  delete process.env.DR_ACCESS_TOKEN;
  let app = await boot({ sim: makeSimAgent({ env: {} }) });
  try {
    const page = await fetch(`${app.base}/sim`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    for (const must of ["not medical, psychological, legal, or financial advice", "ages 13 and up", "findahelpline.com", "Delete my data", "not Amazon Alexa"]) assert.ok(html.includes(must), must);
    const r = await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error, "agent_unconfigured");
    const h = await (await fetch(`${app.base}/health`)).json();
    assert.deepEqual(h.sim, { configured: false, model: DEFAULT_SIM_MODEL, api_base: "https://openrouter.ai/api/v1" });
  } finally { await app.close(); }

  process.env.DR_ACCESS_TOKEN = "s3cret";
  const { fetchImpl } = fakeModel([() => ({ role: "assistant", content: "hello" })]);
  app = await boot({ sim: makeSimAgent({ env: { OPENROUTER_API_KEY: "test" }, fetchImpl }) });
  try {
    assert.equal((await fetch(`${app.base}/sim`)).status, 200, "the page itself stays public");
    const r = await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(r.status, 401);
    const ok = await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-DR-Token": "s3cret" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    assert.equal(ok.status, 200, "the agent forwards the token to its own /mcp");
    assert.equal((await ok.json()).reply, "hello");
  } finally { delete process.env.DR_ACCESS_TOKEN; await app.close(); }
});

test("sim model request: OpenRouter gets reasoning:{enabled:false}; a non-OpenRouter base (Nebius Token Factory) gets chat_template_kwargs and no OpenRouter headers", async () => {
  const seenReq = [];
  const fetchImpl = async (url, init) => {
    seenReq.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const or = makeSimAgent({ env: { OPENROUTER_API_KEY: "k1" }, fetchImpl });
  const tf = makeSimAgent({ env: { SIM_API_KEY: "k2", SIM_API_BASE: "https://api.tokenfactory.nebius.com/v1", SIM_MODEL: "nvidia/nemotron-3-super-120b-a12b" }, fetchImpl });
  assert.equal(or.configured, true); assert.equal(tf.configured, true);
  assert.equal(tf.apiBase, "https://api.tokenfactory.nebius.com/v1");
  const app = await boot({ sim: or });
  try { await (await fetch(`${app.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })).json(); } finally { await app.close(); }
  const app2 = await boot({ sim: tf });
  try { await (await fetch(`${app2.base}/sim/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })).json(); } finally { await app2.close(); }
  const [a, b] = seenReq;
  assert.match(a.url, /openrouter\.ai/); assert.deepEqual(a.body.reasoning, { enabled: false }); assert.equal(a.body.chat_template_kwargs, undefined); assert.equal(a.headers["X-Title"], "Daily Reflection web sim");
  assert.match(b.url, /tokenfactory\.nebius\.com/); assert.deepEqual(b.body.chat_template_kwargs, { enable_thinking: false }); assert.equal(b.body.reasoning, undefined); assert.equal(b.headers["X-Title"], undefined); assert.equal(b.headers.Authorization, "Bearer k2");
  assert.equal(b.body.model, "nvidia/nemotron-3-super-120b-a12b");
});
