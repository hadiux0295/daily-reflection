// Daily Reflection — MCP server (Streamable HTTP, MCP spec 2025-11-25). See DESIGN.md.
//   POST/GET/DELETE /mcp        MCP endpoint (stateless: one transport per request → safe on Cloud Run)
//   GET  /health                { ok, protocolVersion, tools, version }
//   DELETE /profiles/:id        erase a profile and all its journal entries (data deletion path)
//   GET  /sim                   web simulation UI (static, single file)
//   POST /sim/chat              one agent turn for the simulation (server-side model call, tools via our own /mcp)
//   POST /sim/tts · /sim/stt    the simulated device's voice: reply text → speech, push-to-talk audio → text (Gemini)
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { openStore } from "./src/store.js";
import { makeLensClient } from "./src/lens.js";
import { makeTools, SCHEMAS, DESCRIPTIONS, DISCLOSURE } from "./src/tools.js";
import { makeSimAgent } from "./src/sim.js";
import { makeSpeech } from "./src/speech.js";

const SIM_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "sim", "index.html");

export const SERVER_INFO = { name: "daily-reflection", version: "0.2.0" };
export const TOOL_NAMES = Object.keys(SCHEMAS);

const INSTRUCTIONS =
  "Daily Reflection: a two-minute reflection journal. Call get_reflection_prompt to start, read the theme and ask the three questions " +
  "one at a time, then save the user's answers with save_journal_entry and mention the streak. get_daily_lens is optional and only " +
  "if the user offers birth data. Always tell the user: " + DISCLOSURE +
  " If a result contains crisis_referral, say it verbatim before anything else.";

// MCP Apps (extension io.modelcontextprotocol/ui, spec 2026-01-26): one HTML view renders the results of three
// tools as a card on a screen-equipped device. Hosts without the extension ignore `_meta.ui` and still get the
// JSON result, so the resource is registered unconditionally (the server is stateless and keeps no per-client state).
export const CARD_URI = "ui://daily-reflection/card.html";
export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const CARD_TOOLS = ["get_reflection_prompt", "save_journal_entry", "get_reflection_history"];
const CARD_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui", "card.html");

/** Build an McpServer bound to the given tool bodies (one per request in stateless mode — cheap). */
export function createMcpServer(tools) {
  const mcp = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const name of TOOL_NAMES) {
    const meta = CARD_TOOLS.includes(name) ? { _meta: { ui: { resourceUri: CARD_URI } } } : {};
    mcp.registerTool(name, { description: DESCRIPTIONS[name], inputSchema: SCHEMAS[name], ...meta }, async (args) => {
      const result = await tools[name](args);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: Boolean(result && result.error) };
    });
  }
  mcp.registerResource("daily-reflection-card", CARD_URI, {
    title: "Daily Reflection card",
    description: "Screen card for today's prompt, a saved entry (streak + week) and the weekly history. Self-contained: no network access.",
    mimeType: MCP_APP_MIME,
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: MCP_APP_MIME, text: readFileSync(CARD_HTML_PATH, "utf8"), _meta: { ui: { prefersBorder: false } } }] }));
  return mcp;
}

/** Optional shared secret: when DR_ACCESS_TOKEN is set, /mcp and /profiles require the token in `X-DR-Token`
 *  (or `Authorization: Bearer` — but Cloud Run's front end validates any Bearer token as a Google identity token
 *  and answers 401 itself, so use the custom header there). */
export function authorized(req, env = process.env) {
  const want = env.DR_ACCESS_TOKEN;
  if (!want) return true;
  const got = String(req.headers["x-dr-token"] || req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PROFILE_RE = /^[A-Za-z0-9_\-.:@]{1,64}$/;

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body_too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch { reject(new Error("bad_json")); } });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

export function createApp({ store, lens, now, sim, speech } = {}) {
  store = store || openStore(process.env.DR_DB_PATH || "./data/reflection.sqlite");
  lens = lens || makeLensClient();
  sim = sim || makeSimAgent();
  speech = speech || makeSpeech();
  const tools = makeTools({ store, lens, now });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if ((url.pathname === "/mcp" || url.pathname.startsWith("/profiles/") || url.pathname.startsWith("/sim/") && url.pathname !== "/sim/") && !authorized(req)) return json(res, 401, { error: "unauthorized" });
      if ((url.pathname === "/sim" || url.pathname === "/sim/") && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(readFileSync(SIM_HTML_PATH));
      }
      if (url.pathname === "/sim/chat" && req.method === "POST") {
        if (!sim.configured) return json(res, 503, { error: "agent_unconfigured", message: "The simulation agent has no model API key on this server." });
        const body = await readJson(req);
        const profile_id = PROFILE_RE.test(String(body.profile_id || "")) ? body.profile_id : "default";
        const tz = typeof body.tz === "string" && body.tz.length <= 64 ? body.tz : "America/Los_Angeles";
        const mcpUrl = `http://127.0.0.1:${server.address().port}/mcp`;
        const out = await sim.chat({ messages: body.messages, profile_id, tz, mcpUrl, token: process.env.DR_ACCESS_TOKEN });
        return json(res, out.error ? 503 : 200, out);
      }
      if (url.pathname === "/sim/tts" && req.method === "POST") {
        if (!speech.configured) return json(res, 503, { error: "speech_unconfigured" });
        const body = await readJson(req);
        const out = await speech.tts(String(body.text || ""));
        if (out.error) return json(res, 502, out);
        res.writeHead(200, { "Content-Type": out.mimeType, "Cache-Control": "no-store" });
        return res.end(out.audio);
      }
      if (url.pathname === "/sim/stt" && req.method === "POST") {
        if (!speech.configured) return json(res, 503, { error: "speech_unconfigured" });
        const body = await readJson(req, 2 * 1024 * 1024);
        const out = await speech.stt(String(body.audio || ""), String(body.mimeType || "audio/webm"));
        return json(res, out.error ? 502 : 200, out);
      }
      if (url.pathname === "/mcp") {
        const mcp = createMcpServer(tools);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); mcp.close(); });
        await mcp.connect(transport);
        return await transport.handleRequest(req, res);
      }
      if (url.pathname === "/health" && req.method === "GET") {
        return json(res, 200, { ok: true, name: SERVER_INFO.name, version: SERVER_INFO.version, protocolVersion: LATEST_PROTOCOL_VERSION, transport: "streamable-http", tools: TOOL_NAMES, lens_configured: lens.configured, auth_required: Boolean(process.env.DR_ACCESS_TOKEN), sim: { configured: sim.configured, model: sim.model, api_base: sim.apiBase }, speech: { configured: speech.configured, tts_model: speech.ttsModel, stt_model: speech.sttModel }, mcp_apps: { resource: CARD_URI, tools: CARD_TOOLS } });
      }
      const m = /^\/profiles\/([A-Za-z0-9_\-.:@]{1,64})$/.exec(url.pathname);
      if (m && req.method === "DELETE") return json(res, 200, { profile_id: m[1], ...store.deleteProfile(m[1]) });
      return json(res, 404, { error: "not_found" });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: "internal_error" });
    }
  });
  return { server, store, tools };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3939);
  const { server } = createApp();
  server.listen(port, () => console.log(`${SERVER_INFO.name} ${SERVER_INFO.version} — MCP ${LATEST_PROTOCOL_VERSION} on :${port}/mcp (health /health)`));
}
