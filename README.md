# Daily Reflection (MCP server for Alexa+)

A two-minute evening reflection you do **out loud**, exposed as a **self-hosted MCP server**
(Streamable HTTP, MCP spec 2025-11-25) so an Alexa+ agent — or the included web simulation of a
voice + screen device — can run it: three questions for today, a journal with streaks that the
assistant remembers across sessions, a weekly mood read-back, and an optional "lens" built from
Four-Pillars (saju) birth data.

Built for the [Build, Ship, Shape — Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/)
(Alexa+ track), 2026. The simulation is **not Amazon Alexa**; it is a stand-in host, as the track rules allow.

## Alexa+ track — what this submission is

```
 voice ──► simulated Alexa+ host (src/sim.js) ──MCP Streamable HTTP──► Daily Reflection MCP server (server.js)
   ▲          · host model: NVIDIA Nemotron 3 Super            · 4 tools: get_reflection_prompt · save_journal_entry
   │            on Nebius Token Factory (tool calls)             get_reflection_history · get_daily_lens
   │          · reads the ui:// view the tool links  ◄─────────  · 1 MCP App view: ui://daily-reflection/card.html
   │                                                             · SQLite journal on a GCS volume (streaks, moods)
 screen ◄── MCP App card in a sandboxed iframe (postMessage JSON-RPC: ui/initialize → tool-input → tool-result)
 speaker ◄─ Gemini TTS (/sim/tts)        mic ──► Gemini transcription (/sim/stt)
```

- **The MCP server is the product.** Any MCP host that speaks Streamable HTTP can run the reflection:
  the server's `instructions` tell the host how to run a session (one question at a time, save, mention the streak,
  say the crisis line verbatim if a result carries one). Tools return data, never prose.
- **MCP Apps (October update).** `get_reflection_prompt`, `save_journal_entry` and `get_reflection_history` link a
  `ui://daily-reflection/card.html` resource (`text/html;profile=mcp-app`, MCP Apps spec 2026-01-26) through
  `_meta.ui.resourceUri`. On a screen-equipped device the host renders it as a card: today's theme and questions with
  the facts they were built from; the streak ring and this week's strip after saving; the week's mood trend and recent
  entries on request, with a "Start today's reflection" button that sends `ui/message` back to the host. The view is
  self-contained (no network), so it runs under the default MCP Apps CSP (`default-src 'none'`). Hosts without the
  extension ignore `_meta.ui` and still get the JSON.
- **State across sessions.** The journal, streak and mood trend live on the server under a profile id, so "how was
  my week?" works on any day, from any host.
- **Voice (October update).** The simulation speaks with a server-side voice (Gemini `gemini-3.8-flash-tts`) and
  listens with push-to-talk plus end-of-speech detection, transcribed server-side (Gemini `gemini-3.5-flash-lite`),
  so it works in any browser with a microphone. Hands-free mode re-opens the mic after each question, like a
  follow-up turn on a voice device.
- **Friction log:** [`docs/FRICTION_LOG.md`](docs/FRICTION_LOG.md) — 7 entries + feature requests.
- **Safety by construction.** Reflection questions come from a deterministic question bank (the model may not invent
  them). A deterministic crisis check runs on the user's own words and on saved text; on a match the referral line
  (findahelpline.com) is spoken first and the questions stop. The model, voice and transcription vendors are named on
  the page; reflection only — not prediction, and not medical, psychological, legal or financial advice.

**Demo video (< 3 min):** https://youtu.be/mBnjk3RvHgg — a live voice session on the deployed server (the user's lines are synthetic
speech played into the microphone input; wait times are shortened).

<p>
<img src="docs/alexa_card_prompt.jpg" alt="Prompt card: today's theme and three questions, with the facts they were built from" width="32%">
<img src="docs/alexa_card_saved.jpg" alt="Saved card: six evenings in a row, this week's strip coloured by mood" width="32%">
<img src="docs/alexa_card_week.jpg" alt="Week card: mood trend lifting, recent entries" width="32%">
</p>

| When (UTC) | What was built (submission period opened 2026-08-31) |
|---|---|
| 2026-09-05 | MCP server, 4 tools, SQLite journal on Cloud Run, token guard, web simulation (MCP host + voice page) |
| 2026-09-19 | Nemotron 3 Super on Nebius Token Factory as the host model; provenance chips; wider crisis patterns |
| 2026-10-22 | MCP Apps card view + host bridge, smart-display simulation, Gemini voice in/out, week strip in results |

## Host model: Nebius Token Factory + NVIDIA Nemotron (2026-09, also the Nebius x NVIDIA Global AI Hackathon)

The host model behind the web simulation runs on **[Nebius Token Factory](https://tokenfactory.nebius.com)**
with **`nvidia/nemotron-3-super-120b-a12b`** (native `tool_calls` over this server's own MCP endpoint —
set `SIM_API_KEY` + `SIM_API_BASE=https://api.tokenfactory.nebius.com/v1`, see `.env.example`). Changes made in the
submission period (after 2026-08-26), all in this repo:

- **Token Factory backend** (`src/sim.js`): generic `SIM_API_KEY`, and thinking is switched off the way the base
  understands it — `reasoning:{enabled:false}` on OpenRouter, `chat_template_kwargs:{enable_thinking:false}` on
  Token Factory. Measured 2026-09-18: Token Factory ignores the OpenRouter field, and with thinking on Nemotron spends
  the whole `max_tokens` on reasoning and returns empty content. `/health` reports the base and model in use.
- **Provenance** (`src/tools.js`): `get_daily_lens` and `get_reflection_prompt` return a `provenance` list — the
  facts the host is allowed to cite (`{key,label}` chips). The host shows exactly what it was given, so a citation
  cannot be invented. The same contract drives the "based on" chips of **오늘의 성찰 (Today's reflection)** inside
  the author's live product [Saju Today](https://saju.hun-is.com), where Nemotron on Token Factory reads today's
  birth-chart facts *and* the user's own recent answers, names one agreement or tension between them, and asks one
  non-predictive question (Best Apps & Agents track).
- **The 오늘의 성찰 source** — the Token Factory client, crisis check, two-turn route and card UI from Saju Today are
  published read-only in [`saju_reflection/`](saju_reflection/) (the chart engine stays closed).
- **Korean crisis patterns** (`src/tools.js`): the deterministic crisis check now covers Korean wording; the referral
  line is shown before anything reaches the model.

**Live demo**
- **오늘의 성찰 in Saju Today** — [saju.hun-is.com](https://saju.hun-is.com): start as a guest, enter a birth date, and the
  card ("Today's reflection") appears under the daily line. English UI unless the browser is Korean (shown below). Free, no sign-up, demo kept live
  through 2026-12-15. The card below is a real Nemotron turn (synthetic test birth data): observation with the facts
  it used as chips, one question, the user's answer, and a closing line that only reflects what the user wrote.
- **Web simulation of this MCP server** — `GET /sim` on the Cloud Run deployment; `/sim/chat` is token-guarded
  (`DR_ACCESS_TOKEN`), so run it locally (Quick start below) with your own Token Factory key.

<img src="docs/saju_reflection_card.png" alt="Today's reflection card in Saju Today: Nemotron observation, provenance chips, question, answer, closing, AI disclosure naming NVIDIA Nemotron 3 Super on Nebius Token Factory" width="420">

Framing stays the same everywhere: reflection, not prediction; AI-generated, model named on screen; not medical,
psychological, legal or financial advice.

## Status (2026-10-22 — server + 4 tools + MCP App view + voice simulation, 26 tests, live on Cloud Run)

| Tool | State |
|---|---|
| `get_reflection_prompt` — 3 reflection questions for today (rules; lens-aware) | implemented |
| `get_daily_lens` — today's saju data, English-glossed, as an optional lens | implemented |
| `save_journal_entry` — journal + streak, crisis-referral line on risky text | implemented |
| `get_reflection_history` — last N entries, streak, mood trend | implemented |

Design notes: `DESIGN.md`. Layout: `server.js` (HTTP + MCP wiring) · `src/tools.js` (tool bodies, schemas, disclosure, crisis check) · `src/prompts.js` (deterministic question bank) · `src/lens.js` + `src/glossary.js` (saju endpoint client + English glossary) · `src/store.js` (SQLite) · `src/sim.js` + `sim/index.html` (web simulation: server-side agent that is itself an MCP client, and the voice + screen page) · `ui/card.html` (the MCP App view) · `src/speech.js` (Gemini voice in/out).

## Web simulation (`GET /sim`)

The simulated Alexa+ experience for the demo video: a voice + screen device on one page. Tap the mic (or type);
the recording goes to `POST /sim/stt` and the transcript to `POST /sim/chat`. On the server, `src/sim.js` is a real
MCP **host**: per turn it connects to this server's own `/mcp` over Streamable HTTP with the SDK client (advertising
the `io.modelcontextprotocol/ui` extension), passes the listed tools to an OpenAI-compatible chat model (`SIM_MODEL`,
Nemotron 3 Super on Nebius Token Factory in the deployment) as function tools, executes the model's tool calls
through MCP, and — when a called tool links a `ui://` view — reads that resource over MCP too. It returns the reply,
a trace of every MCP call, and the view HTML. The page renders the view in a sandboxed iframe (`allow-scripts` only,
opaque origin: the view cannot reach the page, its storage or the token), answers `ui/initialize`, sends
`ui/notifications/tool-input` and `ui/notifications/tool-result`, and handles `ui/message` and `ui/open-link`. The
reply is spoken through `POST /sim/tts` (browser speech synthesis if the server has no voice key) and captioned on
the screen. The right-hand panel shows the transcript and every MCP call with its arguments and raw result.

The server pins `profile_id` (random per browser, or `?profile=` in the URL) and the browser's time zone on every
tool call and always uses today's date; the browser keeps the conversation (with each turn's tool trace) and sends it
back, so the server stays stateless. `/sim/chat`, `/sim/tts` and `/sim/stt` are behind the same `DR_ACCESS_TOKEN`
guard as `/mcp`; the page asks for the token once and keeps it in `localStorage`. The page names the model and voice
vendors, states the reflection-only framing, a 13+ minimum age and a crisis line, and has a "Delete my data" button
wired to `DELETE /profiles/:id`.

## Quick start

```bash
npm install               # Node ≥ 22.13 (uses the built-in node:sqlite)
npm start                 # Streamable HTTP MCP endpoint on :3939/mcp, health on /health
npm test                  # 26 tests: unit + real HTTP round-trips with the MCP client (incl. the sim agent with a scripted model, the MCP App resource and the speech module with a stubbed API), no LLM needed
```

Endpoints: `POST|GET|DELETE /mcp` (MCP, stateless — one transport per request) ·
`GET /health` (`protocolVersion`, tool list, whether the lens and the sim model are configured) ·
`DELETE /profiles/:id` (erases a profile and every journal entry under it) ·
`GET /sim` + `POST /sim/chat` + `POST /sim/tts` + `POST /sim/stt` (web simulation, see below).
MCP resources: `ui://daily-reflection/card.html` (`text/html;profile=mcp-app`).

Environment (`.env.example`): `PORT`, `DR_DB_PATH` (SQLite file), `SIM_API_KEY` + `SIM_API_BASE` + `SIM_MODEL`
(Nebius Token Factory; `OPENROUTER_API_KEY` still works for the OpenRouter base) and `GEMINI_API_KEY` (voice) for the web simulation only, and — only for the optional saju lens — `SAJU_LENS_URL` +
`REFLECTION_SERVICE_KEY`. Without the lens variables `get_daily_lens` returns `lens_unavailable` and the other
three tools work unchanged; without the model key the MCP server is fully functional and only `/sim/chat` answers 503.

Try it with the MCP Inspector: `npx @modelcontextprotocol/inspector` → Streamable HTTP → `http://localhost:3939/mcp`
(Resources tab shows the card view; any MCP Apps–capable host renders it next to the tool result).

Cloud Run: mount a GCS bucket at `/data` (`--add-volume type=cloud-storage`, `--add-volume-mount mount-path=/data`), set `DR_SQLITE_JOURNAL=DELETE` (WAL does not work on FUSE), `--max-instances 1`, memory ≥ 512Mi.

Container: `docker build -t daily-reflection . && docker run -p 8080:8080 -v $PWD/data:/data daily-reflection`.

## What the tools return

Tools return **data**, never prose — the host model (Alexa+, or the sim UI's
agent) does the talking. Every result carries a `disclosure` field: the
prompts are rule-generated and, with a birth profile, an AI reading of
Four-Pillars data; for reflection only — not prophecy, medical, psychological,
legal, or financial advice. Free-text entries are checked for crisis wording
and, if matched, the result includes a one-line referral (findahelpline.com).

## Data, deletion, and access

- The server stores journal entries (free text, mood, tags, date) and — only when a
  client passes `remember: true` — a birth profile, keyed by `profile_id`, in a local
  SQLite file. No accounts, no analytics, no tracking SDKs. Nothing is sent to the
  saju endpoint except birth date/time, the date, and a time zone; that endpoint stores nothing.
- Simulation only: what the user says or types goes to the host model provider (Nebius Token Factory) to generate
  the reply; reply text goes to Google's Gemini API to be spoken, and microphone recordings go to Google's Gemini API
  to be transcribed. The server does not store audio.
- On a screen, the history card shows short previews of recent entries — only when the user asks for their week.
- Deletion: `DELETE /profiles/:id` removes the profile and every entry under it.
  There is no automatic retention window; entries stay until deleted.
- Access: set `DR_ACCESS_TOKEN` on any public deployment so only your Alexa+ / sim
  client (sending `X-DR-Token: <token>`) can reach `/mcp` and `/profiles`. Without it, anyone with the URL who uses the
  same `profile_id` (default `default`) shares that journal.
- Intended for adults; the simulation UI states a minimum age of 13 and the AI model it uses.

## Reuse disclosure

- The saju calculation engine is **not** in this repository. The server calls
  a small service-to-service endpoint (`/api/reflection/lens`) added to the
  author's existing saju backend for this hackathon; that endpoint is the
  "significant update" to the existing project and is demoed separately.
- Everything else here (MCP server, tools, journal store, simulation UI) is
  new for the hackathon.
- Nebius x NVIDIA Global AI Hackathon (2026-09): this repo is the public module of the
  *Saju Today — 오늘의 성찰* entry. The product's own reflection route lives in the private app
  repo and mirrors the contracts documented here (provenance chips, crisis check, disclosure);
  the model calls go to Nebius Token Factory with Zero Data Retention enabled.

## License

MIT — see `LICENSE`.
