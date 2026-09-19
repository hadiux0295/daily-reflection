// Web-simulation agent: the "Alexa+ stand-in" for the simulation path (hackathon rules allow a simulated
// Alexa+ experience built with any AI tool, as long as the source is in the repo).
//
// It is a genuine MCP host: each turn it connects to this server's own /mcp endpoint over Streamable HTTP
// with the SDK client, lists the tools, hands them to an OpenAI-compatible chat model (OpenRouter free tier
// by default) as function tools, executes the model's tool calls through MCP, and returns the spoken reply
// plus a trace of every MCP call so the UI can show what happened. No journal logic lives here.
//
// `fetchImpl` (model API) and `connectMcp` (MCP client factory) are injectable for tests.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { detectCrisis, CRISIS_REFERRAL } from "./tools.js";

export const DEFAULT_SIM_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
export const DEFAULT_SIM_API_BASE = "https://openrouter.ai/api/v1";
const MAX_ROUNDS = 6;
const MAX_HISTORY = 30;

/** Model API key: `SIM_API_KEY` (any OpenAI-compatible base, e.g. Nebius Token Factory) or the older `OPENROUTER_API_KEY`. */
export function simApiKey(env = process.env) { return env.SIM_API_KEY || env.OPENROUTER_API_KEY || ""; }
export function simConfigured(env = process.env) { return Boolean(simApiKey(env)); }
export function simApiBase(env = process.env) { return (env.SIM_API_BASE || DEFAULT_SIM_API_BASE).replace(/\/$/, ""); }
function isOpenRouter(base) { return /openrouter\.ai/.test(base); }
export function simModel(env = process.env) { return env.SIM_MODEL || DEFAULT_SIM_MODEL; }

/** Default MCP client factory: real Streamable HTTP round-trip to `mcpUrl`, forwarding the access token. */
export async function connectMcpClient(mcpUrl, token) {
  const client = new Client({ name: "daily-reflection-web-sim", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), token ? { requestInit: { headers: { "X-DR-Token": token } } } : undefined);
  await client.connect(transport);
  return client;
}

function toOpenAiTools(mcpTools) {
  return mcpTools.map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.inputSchema || { type: "object", properties: {} } } }));
}

function systemPrompt({ instructions, profile_id, tz, model, today }) {
  return [
    "You are the voice of Daily Reflection, a two-minute reflection journal, running as a simulated Alexa+ host in a web page.",
    "Speak like a calm voice assistant: short sentences, plain English, one question at a time, no markdown, no lists, no emojis.",
    "Keep every reply under 60 words unless you are reading back history.",
    `Server instructions: ${instructions || "(none)"}`,
    `Today is ${today} in the user's time zone "${tz}"; their profile_id is "${profile_id}". The server pins profile_id and tz on every tool call and always uses today's date, so never ask for them and never pass a date.`,
    "The web page already prints the full disclosure text on screen, so do not read it aloud. At the start of a session say one short sentence that this is for reflection only and not advice.",
    "Never invent reflection questions: the three questions always come from get_reflection_prompt, so a session must begin with that call (after get_daily_lens when birth data was given), and you ask its questions in order, word for word.",
    "Start of a session: call get_reflection_prompt, then say the theme and ask the first question only. After each answer ask the next question. When all three are answered, combine the answers into one journal text and call save_journal_entry (mood if the user said how they feel), then mention the streak.",
    "If the user's message contains birth data (year, month, day, hour, and a time zone or city), call get_daily_lens FIRST with that birth object (remember=true only if they ask you to remember it), then call get_reflection_prompt, and use the lens focus as today's theme in one sentence. Never call get_daily_lens otherwise. Present the lens as an optional reflection theme, never as a prediction.",
    "If a tool result contains crisis_referral, say it word for word before anything else and do not continue the questions.",
    "Never claim to be Alexa or Amazon; if asked, say you are a simulation built for a hackathon and the language model behind you is " + model + ".",
  ].join("\n");
}

/** Prior turns from the browser. An assistant turn may carry the `trace` it was returned with, which is replayed as
 *  tool_calls + tool results so the model still knows e.g. which three questions it is walking the user through
 *  (the server keeps no session state). */
function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  const turns = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY);
  turns.forEach((m, i) => {
    const content = m.content.slice(0, 4000);
    const trace = m.role === "assistant" && Array.isArray(m.trace) ? m.trace.filter((t) => t && typeof t.tool === "string").slice(0, 6) : [];
    if (trace.length) {
      const calls = trace.map((t, j) => ({ id: `hist_${i}_${j}`, type: "function", function: { name: t.tool, arguments: JSON.stringify(t.args || {}) } }));
      out.push({ role: "assistant", content: null, tool_calls: calls });
      trace.forEach((t, j) => out.push({ role: "tool", tool_call_id: calls[j].id, content: JSON.stringify(t.result ?? {}).slice(0, 4000) }));
    }
    out.push({ role: m.role, content });
  });
  return out;
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

export function makeSimAgent({ env = process.env, fetchImpl = globalThis.fetch, connectMcp = connectMcpClient, timeoutMs = 60000 } = {}) {
  const model = simModel(env);
  const apiBase = simApiBase(env);
  const openRouter = isOpenRouter(apiBase);
  // Thinking off by default: reasoning models otherwise leak chain-of-thought into the spoken reply, and on
  // Nebius Token Factory a thinking run spends the whole max_tokens on reasoning and returns EMPTY content
  // (measured 2026-09-18). OpenRouter takes `reasoning:{enabled:false}`; vLLM-style bases (Token Factory)
  // ignore that field and need `chat_template_kwargs:{enable_thinking:false}` — so send the one the base understands.
  const thinkingOff = env.SIM_REASONING !== "on";
  const thinkingFields = !thinkingOff ? {} : openRouter ? { reasoning: { enabled: false } } : { chat_template_kwargs: { enable_thinking: false } };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${simApiKey(env)}`, ...(openRouter ? { "X-Title": "Daily Reflection web sim", ...(env.SIM_REFERER ? { "HTTP-Referer": env.SIM_REFERER } : {}) } : {}) };

  async function callModel(messages, tools) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${apiBase}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.4, max_tokens: 1200, ...thinkingFields }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* non-JSON body */ }
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      if (res.ok && msg) return msg;
      const detail = (data && data.error && (data.error.message || JSON.stringify(data.error))) || text.slice(0, 200);
      const err = new Error(`model_${res.ok ? "empty" : "http_" + res.status}: ${detail}`);
      err.retryable = !res.ok ? (res.status === 429 || res.status >= 500) : true; // empty 200 bodies come from upstream provider hiccups
      throw err;
    } finally { clearTimeout(timer); }
  }

  async function callModelRetry(messages, tools, attempts = 3) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try { return await callModel(messages, tools); }
      catch (e) { last = e; console.warn(`sim model attempt ${i + 1}/${attempts} failed: ${e.message}`); if (!e.retryable) break; await new Promise((r) => setTimeout(r, 800 * (i + 1))); }
    }
    throw last;
  }

  /** One conversation turn. `messages` = prior user/assistant turns (the browser keeps the history). */
  async function chat({ messages, profile_id, tz, mcpUrl, token }) {
    if (!simConfigured(env)) return { error: "agent_unconfigured", message: "SIM_API_KEY (or OPENROUTER_API_KEY) is not set on the server." };
    const t0 = Date.now();
    const client = await connectMcp(mcpUrl, token);
    const trace = [];
    try {
      const instructions = typeof client.getInstructions === "function" ? client.getInstructions() : "";
      const { tools: mcpTools } = await client.listTools();
      const tools = toOpenAiTools(mcpTools);
      const today = todayIn(tz);
      const convo = [{ role: "system", content: systemPrompt({ instructions, profile_id, tz, model, today }) }, ...sanitizeHistory(messages)];
      let crisis_referral;
      // Deterministic crisis check on the user's latest words — independent of whether the model saves an entry (§5.5 baseline).
      const lastUser = [...convo].reverse().find((m) => m.role === "user");
      if (lastUser && detectCrisis(lastUser.content)) {
        crisis_referral = CRISIS_REFERRAL;
        convo.push({ role: "system", content: "The user's last message matched crisis wording. Say this line word for word first, then respond with care and stop the reflection questions. Do not quote phone numbers or hotlines of your own; the line above is the only referral: " + CRISIS_REFERRAL });
      }
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let msg;
        try { msg = await callModelRetry(convo, tools); }
        catch (e) { return { error: "model_failed", message: "The host model did not answer (" + e.message.slice(0, 160) + "). Please try again.", trace, model, ms: Date.now() - t0 }; }
        const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        if (!calls.length) {
          const reply = stripThinking(msg.content) || "Sorry, I lost my train of thought. Shall we try again?";
          return { reply, trace, model, ms: Date.now() - t0, ...(crisis_referral ? { crisis_referral } : {}) };
        }
        convo.push({ role: "assistant", content: msg.content || null, tool_calls: calls });
        for (const call of calls) {
          const name = call.function && call.function.name;
          const args = { ...parseArgs(call.function && call.function.arguments), profile_id, tz };
          delete args.date; // the sim is always "today"; models like to invent a date from their training cutoff
          const tc0 = Date.now();
          let result;
          try {
            const r = await client.callTool({ name, arguments: args });
            result = r.structuredContent || (r.content && r.content[0] && r.content[0].text ? safeJson(r.content[0].text) : { error: "empty_result" });
            if (r.isError && !result.error) result.error = "tool_error";
          } catch (e) {
            result = { error: "tool_call_failed", message: String(e && e.message || e) };
          }
          if (result && result.crisis_referral) crisis_referral = result.crisis_referral;
          trace.push({ tool: name, args, result, ms: Date.now() - tc0 });
          convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
      }
      return { reply: "I ran out of steps for this turn. Could you say that again?", trace, model, ms: Date.now() - t0, ...(crisis_referral ? { crisis_referral } : {}) };
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  return { model, apiBase, configured: simConfigured(env), chat };
}

function stripThinking(text) { return String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(); }

function todayIn(tz, d = new Date()) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
  catch { return d.toISOString().slice(0, 10); }
}

function safeJson(text) { try { return JSON.parse(text); } catch { return { text }; } }
