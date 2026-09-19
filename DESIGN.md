# Daily Reflection — design (phase ①, 2026-09-05 UTC)

> Track state SSoT = ck `sage_daily_reflection_alexa`. Procedure = `Core/Work/Docs/02_Workflow/triggers/daily_reflection_alexa.md`. Idea = [[IB-0004_daily-reflection-alexa]]. Target = [[build-ship-shape-amazon-2026]] (Alexa+ track, deadline 2026-10-23 19:00 UTC).

## 0. What the track actually requires (rules + resources, fetched 2026-09-05)
- Official path = "a working Agent Skill **or** a self-hosted MCP server, implementing MCP spec version (minimum 2025-11-25)" over **Streamable HTTP**. Self-hosted = we run it, publicly reachable.
- **No Alexa-specific registration, manifest, or OAuth requirement exists in the rules or resources.** The two linked resources are the generic MCP Apps/Agent Skills API page and the MCP transports spec; neither lists Alexa+ as a client. ⇒ design freedom: any spec-compliant Streamable HTTP server qualifies.
- "The repository must demonstrate use of your track's required technology at runtime in your code — imported and actually called … not just named in the README."
- Simulation path is allowed in parallel: "a simulated Alexa+ experience … any AI or agentic tool" — the repo must include the simulation's source and the video must clearly show the simulated experience.
- Existing project reuse = allowed if "significantly updated after the start" and the updates are described + demoed separately.
- Deliverables: public repo (OSS license) · text description · video < 3 min English (YouTube/Vimeo) · tool/API feedback · optional friction log (+10 %).

## 1. Architecture (decision 2026-09-05)
```
Alexa+ (host LLM)  ──Streamable HTTP──▶  daily-reflection-mcp (Node, public repo, MIT)
Web sim UI (our agent) ──same server──▶       │ tools: 4 (deterministic, no LLM inside)
                                              │ journal store: SQLite file (per profile_id)
                                              └──HTTPS + X-Service-Key──▶ saju backend  POST /api/reflection/lens
                                                                          (private repo; new endpoint = the "significant update")
```
- **Decision D1 — engine access = HTTP, not import.** `saju_app` is `"private": true`, `core/` is a JS port of the third-party pub.dev package `saju` 0.1.1 (gracefullight.dev, **MIT** — verified 09-05), so publishing the port itself would be legal with attribution. What we keep private is the commercial layer built on it (today/weekly summarizers, English glosses, persona rules, quota logic). One endpoint keeps that boundary clean. The MCP server calls a new service-to-service endpoint instead; the engine stays private and the public repo stays clean.
- **Decision D2 — tools return data, the host speaks.** MCP-native: tools are deterministic and LLM-free (same pattern as ReleaseKeeper tools). Alexa+ renders speech from tool output; the web sim uses our own agent (OpenRouter free model, as measured for A4H) on the same server. Zero LLM cost inside the server, reproducible tests, no prompt leakage in the repo.
- **Decision D3 — identity.** MCP has no user concept. `profile_id` (string, client-chosen, **default = `"default"`** — revised 09-05 build: the transport runs stateless, one transport per request, so there is no session id to fall back on; a host that serves several users passes its own id) keys the journal store and the optional birth profile. No accounts, no PII beyond what the user types; birth data is stored only if `remember: true`.
- **Decision D4 — hosting.** ⚠️ **Open (09-05 build): Cloud Run has no persistent disk** — the SQLite journal (streaks!) would reset on every redeploy/scale-to-zero. Options: (a) Cloud Run + GCS volume mount (`--add-volume type=cloud-storage`, SQLite on FUSE works for a single instance with `max-instances=1`), (b) OCI-1 fallback with a real disk. Decide at deploy time; the store sits behind a 7-method interface (`src/store.js`) so a swap is local. Primary = Cloud Run (HTTPS free, ClickCuts pattern already proven: ck `sage_agentic_cinema_hackathon` §24). Fallback = OCI-1 behind the existing nginx (new port, never :8080/:5300/:8008 — CLAUDE.md §8).
- Runtime = Node ≥ 20, `@modelcontextprotocol/sdk` **1.30.0** (npm, 2026-09-05) — **verified 09-05: `LATEST_PROTOCOL_VERSION = 2025-11-25`, `server/streamableHttp.js` present** (`npm install` done, stub runs) (log the negotiated version in the health endpoint so the video can show it).

### saju backend boundary audit (2026-09-05) → endpoint implemented
Findings on `saju_app/server/server.js`:
- Routing = flat `startsWith` prefix list; **no shared auth middleware** — each route calls `verifyToken` itself. Consequence: a new route inherits nothing, so it cannot accidentally get user auth, but it is also open unless it guards itself. The service route therefore guards itself and **answers 404 while `REFLECTION_SERVICE_KEY` is unset** (safe to deploy dormant).
- Secret comparison precedent = `revenuecat.js` (fixed header, `timingSafeEqual`) → same pattern for `X-Service-Key`.
- No rate-limit infrastructure beyond per-user Firestore quota → in-memory fixed window per key (`REFLECTION_RATE_PER_MIN`, default 60; one Node process, one caller).
- Body cap = `readBody` from `llm.js` (1 MB) reused; validators `isValidBirth` (route.js) · `isValidTimeZone` (core/timezone.js) reused, `date` = strict `YYYY-MM-DD`.
- CORS is native-origin only; irrelevant here (server-to-server), no header added.
- Data that crosses the boundary = the glossed today summary only (pillars · day master · strength · lacking element · today's day pillar + ten-god meaning + solar term). **Never crosses**: persona/system prompts, question text, Firestore reads, user identity. Nothing is stored.
Implementation: `saju_app/server/reflection.js` (+ `tests/test_saju_reflection.mjs`, 4 tests; HTTP e2e 404/401/405/400/200/429 verified; full suite 144/144). Not deployed — deploy = set the env var on the saju host when the MCP server is ready.

### saju backend change (spec, private repo)
`POST /api/reflection/lens` — header `X-Service-Key` (env `REFLECTION_SERVICE_KEY`), body `{ birth, date?, tz? }` → `enrichTodaySummary(summarizeToday(birth, {tz, startDate}), "en")` as JSON. No Firebase login, no user quota (the current `/api/saju` requires both — measured in `server/route.js`), per-key rate limit only. Nothing else in saju changes.

## 2. Tool interface (4 tools)
All tools: English output, ISO dates, `tz` = IANA (default `America/Los_Angeles` for judges; sim UI sends browser tz). Every response carries `disclosure` (see §3).

| # | tool | input (JSON schema, zod) | output |
|---|---|---|---|
| 1 | `get_reflection_prompt` | `{ profile_id?, date?, tz?, mood?: "low"\|"neutral"\|"high" }` | `{ date, questions: [3×string], theme, lens_available: bool, disclosure }` — 3 open reflection questions from a deterministic template bank (weekday × season × mood); if a birth profile is stored, `theme` is taken from the lens (tool 2) instead of the generic bank |
| 2 | `get_daily_lens` | `{ profile_id?, birth?: {year,month,day,hour,minute?,tz}, date?, tz?, remember?: bool }` | `{ date, day_pillar:{hanja,english}, day_relation:{key,english,gloss}, element_balance, solar_term, focus:{theme,one_line}, disclosure }` — English-glossed saju data for today; `birth` required unless previously remembered |
| 3 | `save_journal_entry` | `{ profile_id?, text (≤2000), mood?, tags?: string[], date?, tz? }` | `{ id, date, streak, entry_count, crisis_referral?: string }` — `crisis_referral` is set when a small keyword list matches (self-harm/crisis) → one line pointing to findahelpline.com (§5.5 baseline) |
| 4 | `get_reflection_history` | `{ profile_id?, days?: 1..90 (default 7), tz? }` | `{ entries:[{id,date,mood,text_preview,tags}], streak, mood_trend: "up"\|"flat"\|"down"\|"n/a", disclosure }` |

Example exchange (tool 1, no profile):
```
→ get_reflection_prompt { "tz": "America/Los_Angeles", "mood": "low" }
← { "date": "2026-10-10", "theme": "small wins",
    "questions": ["What is one thing that went slightly better than yesterday?",
                  "Who did you not have to explain yourself to today?",
                  "What can wait until Monday?"],
    "lens_available": false,
    "disclosure": "Reflection prompts are generated by rules and, when a birth profile is given, by an AI reading of Four-Pillars (saju) data. For reflection only — not prophecy, medical, psychological, legal, or financial advice." }
```
Alexa+ turn the judges will see: "Alexa, let's do my daily reflection" → host calls tool 1 (+2 if a profile exists) → speaks the theme and asks the questions → user answers → host calls tool 3 → "Saved. That's four days in a row."

## 3. Framing + §5.5 compliance (baked into the server, not only the UI)
- Primary = **reflection journal**. Saju = optional "lens" (tool 2), never required for tools 1/3/4.
- `disclosure` string on every tool result and in the server `instructions` field: AI-generated when an LLM host renders it (host model is Alexa's; our sim UI states its model name — SajuApp.jsx template), entertainment/reflection framing, "not prophecy/medical/psychological/legal/financial advice" (예언·의학·심리·법률·금융 조언 아님).
- Free-text emotional input (tool 3) ⇒ crisis referral line (findahelpline.com) is a hard requirement, implemented deterministically.
- Data: journal entries stored only under `profile_id`; `delete_profile` is exposed as an HTTP `DELETE /profiles/:id` (deletion path exists before launch). Birth data stored only with `remember: true`.
- `app-legal-review` skill runs at the end of the MCP build (round 1) and before freeze (final) — per trigger doc.

## 4. Demo (video < 3 min, English)
1. 0:00 hook — "Alexa, let's do my daily reflection" in the sim UI (voice in → agent → TTS) 2. 0:30 the same conversation with Alexa+ *or* the MCP inspector calling the live server, health endpoint showing `protocolVersion: 2025-11-25` 3. 1:15 optional lens: give a birth profile, theme changes, show the disclosure 4. 1:50 journal + streak + history tool 5. 2:20 architecture card: MCP server (new) + saju backend endpoint (the "significant update") + what was reused 6. friction log mention.

## 5. Schedule (UTC) — phase ① pulled forward from 09-15 to 09-05 (Hun, 2026-09-05)
| window | work | hand |
|---|---|---|
| **09-05** | this doc + scaffold (package.json, LICENSE, README, stub server listing 4 tools) | Sage ✅ |
| ~09-15 | ~~build gate = after A4H~~ **Hun 09-05: no single priority project — every track proceeds on its own as the situation allows.** Build may start any day A4H/Fire TV leave room; the windows below are targets, not locks. **Hun: Devpost registration** (amazonappdev2026.devpost.com) — moves up with the start | Hun |
| 09-15~21 | saju `/api/reflection/lens` ✅ 09-05 · MCP server tools 1–4 + tests ✅ 09-05 (15/15, HTTP e2e) · app-legal-review round 1 ✅ 09-05 · Cloud Run deploy ✅ 09-05 · D4 persistence (GCS volume) ✅ 09-05 · **pending: `REFLECTION_SERVICE_KEY` on saju prod (Hun go)** | Sage |
| 09-22~10-05 | web sim UI (Web Speech → agent → TTS), disclosure copy, profile delete path — **first cut live 09-05** (`/sim`, §8); remaining = polish after a real-browser pass (Chrome mic/TTS on PC) | Sage |
| 10-06~14 | video · friction log · Devpost text · final legal review | Sage |
| 10-15~21 | freeze · submit (Hun) · 10-22 buffer | Hun |

## 🔗 Related Links
- [[IB-0004_daily-reflection-alexa]] · [[build-ship-shape-amazon-2026]] · [[daily_reflection_alexa]] · ck `sage_saju_today_answer_quality` · `sage_agentic_cinema_hackathon` · `sage_release_keeper_a4h`

## 6. app-legal-review round 1 (2026-09-05, quick scan on the server layer — no user-facing UI yet)
Checked: tool descriptions · `DISCLOSURE` · `CRISIS_REFERRAL` · deletion path · birth storage · analytics grep (none). Findings and what was done:
- 🔴 **Shared-journal leak on a public URL** — stateless transport + default `profile_id = "default"` meant anyone with the URL could read/erase the demo journal via tool 4 / `DELETE`. Fixed: optional `DR_ACCESS_TOKEN` bearer guard on `/mcp` + `/profiles` (timingSafeEqual, e2e-tested); README says to set it on any public deploy. Deploy checklist item.
- 🟡 **Disclosure claimed "AI reading" for deterministic data** — the lens is rule-based; the AI is the host voice. Rewritten: "voiced by an AI assistant … rule-based question bank … rule-based Four-Pillars calculator … reflection and entertainment only … not prophecy/medical/psychological/legal/financial advice … entries stored until you delete them." Model name cannot be stated server-side (host model is Alexa's) → the sim UI (phase ③) must name its model (SajuApp.jsx template).
- 🟡 **No data/retention statement** — added README "Data, deletion, and access" (what is stored, no retention window, deletion path, no SDKs). Devpost text must repeat it.
- 🟡 **Minors** — no age gate possible at the MCP layer; the sim UI states 13+ (phase ③ checklist).
- 🟢 Crisis patterns are English-only (10 regexes) — acceptable for an English-only track; document as a known limit in the friction log.
- ❓ Hun: none blocking now. Final review before freeze must re-run against the sim UI copy + Devpost description.

### Round 2 (2026-09-05, quick scan on the web sim UI `sim/index.html` + `src/sim.js`)
Checked: on-screen disclosure (model name pulled from `/health`, rule-based framing, five "not X advice" items = SajuApp.jsx template wording, 13+, crisis line), delete path, third-party data flow, analytics grep (none in `sim/` or `src/`). Findings and what was done:
- 🟡 **Third-party transmission not stated** — the page said "via OpenRouter" but not that the user's words go to that provider, nor that Chrome's speech recognition may send audio to the browser vendor. Fixed: one sentence added to the disclosure block.
- 🟡 **Model-invented hotline numbers** — before the deterministic check, the free model answered a crisis message with a hotline number of its own (a Korean one, plausibly right, but unverified by us). Fixed: the server now runs `detectCrisis` on the user's message itself (not only on saved entries), returns `crisis_referral` verbatim, and the system note tells the model not to quote numbers of its own. The UI renders the referral before the reply and speaks it first.
- 🟢 "Alexa+ simulation" naming — the page states "This is not Amazon Alexa" and names the model; acceptable for an Amazon-run hackathon entry. Devpost text must repeat the "simulation" wording (rule: the video must clearly show it is simulated).
- ❓ Hun: none blocking. Final review before freeze = sim copy + Devpost text together.

## 8. Web simulation (phase ③, built 2026-09-05)
```
browser (sim/index.html)                 daily-reflection (same Cloud Run service)
  Web Speech STT ─▶ POST /sim/chat ─▶ src/sim.js = MCP host: SDK client ──Streamable HTTP──▶ /mcp (own server)
  speechSynthesis ◀─ {reply, trace} ◀─   OpenRouter chat/completions (tools = MCP tool list) ◀─ tool results
```
- **The sim agent is itself an MCP client** (`connectMcpClient` → initialize → tools/list → tools/call per turn), so the simulation path also exercises the required technology at runtime, not only the Alexa+ path.
- Stateless server: the browser keeps the conversation and sends it back **with each assistant turn's tool trace**; the server replays traces as `tool_calls` + `tool` messages so the model still knows the three questions it is walking through (without this the model invented questions — measured).
- Server pins `profile_id` (random per browser, `localStorage`) and the browser's IANA tz on every call and strips any `date` the model passes (the model invented `2025-08-27` from its training cutoff — measured). Tools 3/4 gained an optional `tz` so the journal date matches the prompt date in the user's zone.
- Model = `SIM_MODEL` (default `nvidia/nemotron-3-super-120b-a12b:free`, native `tool_calls` verified via raw fetch 09-05); `reasoning: {enabled:false}` is sent — with reasoning on, the model's chain-of-thought landed in `content` and would have been spoken aloud (measured). Retries ×3 on 429/5xx/empty-200 (OpenRouter returned a 200 with an `error` body once during the live test); persistent failure → clean 503 `model_failed` shown in the UI.
- `/sim/chat` sits behind `DR_ACCESS_TOKEN` (same as `/mcp`); the page keeps the token in `localStorage`; `/sim` itself is public. `/health` now reports `sim: {configured, model}` and the page uses that to print the exact model name in the disclosure.
- Measured live (Cloud Run, free model): first turn with 1–2 tool calls 5–19 s, follow-up turns 1–3 s. Tests: 20/20 (`tests/sim.test.mjs` = scripted model + real MCP round-trip, crisis on user input, retry/503, routes/token).
- **Friction log candidates** (for §4 step 6): (a) Cloud Run GFE intercepts `Authorization: Bearer` → custom header; can an Alexa+ MCP host send one? (b) MCP has no user identity → `profile_id` convention; (c) Web Speech STT is Chrome/Edge-only, no Firefox/Safari; (d) free-tier reasoning models leak chain-of-thought into `content` unless reasoning is disabled per request; (e) stateless Streamable HTTP + LLM host means the client must round-trip tool traces or the host forgets tool results between turns.

## 7. Deploy log
- **2026-09-05 (kst 09-05)** — Cloud Run `daily-reflection`, project `life-interpreter-2026`, `us-central1` (same as ClickCuts), `--source .`, 256Mi, `max-instances 1`, `allow-unauthenticated` + app-level `DR_ACCESS_TOKEN` (value = S22 `~/.config/daily_reflection/access_token.env`, never in git). URL = `https://daily-reflection-802273971180.us-central1.run.app` — `/health` shows `protocolVersion: 2025-11-25`; live e2e via the SDK client (list 4 tools · prompt · save · history · DELETE · 401 without token) passed. Revision 00002.
- **Two Cloud Run gotchas found live**: ① the Google front end answers `GET /healthz` itself (404 HTML, never reaches the container — ClickCuts shows the same) → health path is `/health`; ② `Authorization: Bearer <non-Google token>` can be 401'd by Cloud Run IAM before the container even with `allow-unauthenticated` (intermittent: initialize + tools/list passed, the next GET/tools/call got 401) → app token travels in `X-DR-Token`.
- **D4 resolved (Hun go 2026-09-05 "영속화 진행")**: GCS bucket `daily-reflection-data-802273971180` (us-central1) mounted at `/data` (`--add-volume type=cloud-storage` + `--add-volume-mount`), `DR_DB_PATH=/data/reflection.sqlite`, `DR_SQLITE_JOURNAL=DELETE` (WAL is unsafe on FUSE), `max-instances 1`. Gen2 execution environment forces **≥512Mi** memory (256Mi rejected). Verified: entry written on revision 00003 → env bump to revision 00004 → history still returns it. Idle cost ≈ 0 (min-instances 0, bucket holds one small file). Lens env (`SAJU_LENS_URL`/`REFLECTION_SERVICE_KEY`) not set yet: needs `REFLECTION_SERVICE_KEY` on the **production saju host** = Hun's go (live-service change).
- **2026-09-05 (kst 09-05) lens ON (Hun go)** — saju prod (OCI-1 pm2 `saju-web` :8095 → saju.hun-is.com) received **only** `server/reflection.js` + `server/server.js` (2-line route wiring) by rsync; `.env` got `REFLECTION_SERVICE_KEY` appended (backups `server/server.js.bak-20260905`, `.env.bak-20260905`); `pm2 restart saju-web --update-env`. ⚠️ The full `deploy/deploy_saju_oci.sh` was deliberately **not** used from S22: prod `dist/` is the 09-04 PC build while S22's local `dist/` is 08-30 — a full deploy would have regressed the web bundle. Core license-header comments (09-05) are not on prod yet (cosmetic; goes with the next regular saju deploy). Verified: public `POST /api/reflection/lens` 401 without key / 200 with key, index 200. Cloud Run got `SAJU_LENS_URL` + `REFLECTION_SERVICE_KEY` (revision 00005); `/health` → `lens_configured: true`; live `get_daily_lens` + lens-aware `get_reflection_prompt` returned glossed data (e.g. 辛巳 "Yin Metal Snake", relation "Rival", term "End of Heat"). Key value = S22 `~/.config/daily_reflection/access_token.env` (with the DR token).
- **2026-09-05 (kst 09-05) web sim live** — revisions 00006→00009 (`--source .`, `--update-env-vars OPENROUTER_API_KEY` once; other env/volume/memory settings inherited). `GET /sim` 200 · `/sim/chat` 401 without token · live turns verified with the token: lens-first (`get_daily_lens` remembered → `get_reflection_prompt` lens_available true, theme "creative output") · 3-answer session → `save_journal_entry` streak 1 · history read-back · crisis message → verbatim findahelpline line. Test profiles deleted via `DELETE /profiles/…`. OpenRouter key = the shared one from S22 `~/.bashrc` (free tier). **Rev 00010** after an advisor pass: relative `fetch()` paths broke under the `/sim/` alias (→ absolute), dead `HTTP-Referer` dropped (`SIM_REFERER` env), crisis line no longer spoken twice, favicon stub. Headless Playwright on S22 (skill `s22-testerscommunity-check` binary) ran `/sim` and `/sim/` in a real DOM: chips populated from `/health`, model name in the disclosure, a typed turn produced the assistant bubble + 1 trace entry, zero page errors. Mic/TTS still need a human in Chrome.
