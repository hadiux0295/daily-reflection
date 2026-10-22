# Friction log — Daily Reflection (Alexa+ track)

Every entry happened while building this repo (2026-09-05 → 2026-10-22, UTC). Format per the Official Rules:
task · steps · expected vs actual · severity · workaround · suggestion. Severity: Critical / Important / Nice-to-have.

## 1. Testing a self-hosted MCP server against a real Alexa+ surface
- **Task:** run the reflection on an actual Alexa+ device or the Alexa+ Web Simulator.
- **Steps:** followed the hackathon Resources page to the Alexa+ tooling; looked for an access request path; read the hackathon FAQ.
- **Expected:** a way to register a Streamable HTTP MCP endpoint and talk to it from an Echo / the Web Simulator.
- **Actual:** the Category SDK, MCP Toolkit, CLI and Web Simulator are select-partners-only; the hackathon FAQ confirms there is no way for participants to get access and notes the restriction is missing from some setup-guide pages. No participant can connect a server to Alexa+.
- **Severity:** Critical (for this track).
- **Workaround:** wrote our own MCP host (`src/sim.js`) and a voice + screen web page that behaves like a device.
- **Suggestion:** a public, rate-limited Web Simulator that accepts any HTTPS MCP URL — even text-only — would let builders verify tool descriptions, `instructions` and latency against the real Alexa+ planner.

## 2. MCP Apps with a server-side agent and a browser screen
- **Task:** render the `ui://` card (MCP Apps, spec 2026-01-26) next to a tool result.
- **Steps:** the host agent runs on the server (it holds the model key), but the view must run in a browser iframe.
- **Expected:** a reference web host / bridge for "agent on server, view in browser".
- **Actual:** examples assume the host and the iframe live in the same client. We split the host: the server reads the resource over MCP and returns the HTML with the trace; the page runs the postMessage side (`ui/initialize` → `tool-input` → `tool-result`, plus `ui/message`).
- **Severity:** Important.
- **Workaround:** ~120 lines in `sim/index.html`; `tools/call` from the view is answered "not supported" because the page holds no MCP session.
- **Suggestion:** a small host-bridge package with a "remote host" mode, and a note on how Alexa+ screen devices will treat `ui://` resources (render, ignore, or map to APL).

## 3. Cloud Run in front of an MCP endpoint with a shared-secret header
- **Task:** protect `/mcp` with `Authorization: Bearer <token>`.
- **Expected:** the header reaches the container.
- **Actual:** Cloud Run's front end validates any Bearer token as a Google identity token and answers 401 itself; `GET /healthz` is also intercepted.
- **Severity:** Important.
- **Workaround:** custom header `X-DR-Token`; health on `/health`.
- **Suggestion:** for MCP-on-Cloud-Run guides, document that MCP clients' bearer tokens collide with the platform's own auth.

## 4. SQLite journal on a Cloud Run GCS volume
- **Task:** persist the journal across revisions with a GCS FUSE volume.
- **Actual:** SQLite WAL mode does not work on the FUSE mount; writes failed.
- **Severity:** Important.
- **Workaround:** `DR_SQLITE_JOURNAL=DELETE`, `--max-instances 1`, ≥ 512 MiB.
- **Suggestion:** an "agent state" storage recipe for self-hosted MCP servers (per-user state across sessions is what makes an add-on useful).

## 5. Voice input in a browser simulator
- **Task:** speak to the simulated device.
- **Expected:** the Web Speech API works wherever the page runs.
- **Actual:** only Chrome/Edge ship it, it sends audio to the browser vendor, and it is unavailable in headless/automated browsers, so the demo could not be recorded with real voice.
- **Severity:** Important.
- **Workaround:** `MediaRecorder` push-to-talk with a level-based end-of-speech detector, transcribed server-side (`POST /sim/stt`).
- **Suggestion:** if a public Alexa+ simulator appears (entry 1), give it a voice-in path that works in any browser.

## 6. Host model behaviour that a voice planner must not have
- **Task:** keep the host on the server's script (three questions, in order, from the tool).
- **Actual (measured with Nemotron 3 Super):** (a) with thinking on, Nebius Token Factory spends all `max_tokens` on reasoning and returns empty content; (b) the model invented a date from its training cutoff; (c) on turns 2–3 it invented new questions because the stateless history lacked the earlier tool results; (d) a crisis message was answered with a model-invented hotline number.
- **Severity:** Important.
- **Workaround:** thinking off per provider; the server strips `date`; the browser round-trips each turn's tool trace and the server replays it as tool messages; a deterministic crisis check speaks a fixed referral line first.
- **Suggestion:** Alexa+ guidance on which safety checks the planner guarantees versus which an add-on must enforce itself.

## 7. TTS style prompts and latency
- **Task:** a warm, natural voice for replies.
- **Actual:** prefixing the text with "say warmly and calmly…" slowed the read by 30–90 % and added long pauses (5.8 s → 7.7–11 s for the same sentence); one model rejected `thinkingBudget: 0` with a bare `INVALID_ARGUMENT`.
- **Severity:** Nice-to-have.
- **Workaround:** plain text with a warm prebuilt voice; `thinkingLevel: "minimal"` for transcription.
- **Suggestion:** for Alexa+ add-ons, document how much of the voice (pace, persona) an add-on can influence.

## Feature requests
| Request | Why it matters here | Priority |
|---|---|---|
| Public Alexa+ Web Simulator for any HTTPS MCP URL | the only way to test planner behaviour on the real surface | Critical |
| Documented `ui://` / MCP Apps support on Echo Show | the reflection card is the screen half of the experience | Important |
| Proactive, opt-in reminder from an add-on ("time for your reflection") | a daily ritual lives or dies by the evening nudge | Important |
| Per-household-member identity passed to the MCP server | a shared device must not mix two people's journals | Important |
