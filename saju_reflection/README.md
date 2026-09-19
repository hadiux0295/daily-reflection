# 오늘의 성찰 (Today's reflection) — the Saju Today integration

These files are copied verbatim from the author's production app [Saju Today](https://saju.hun-is.com), where the
feature is live. They are published for review and are not runnable on their own: the saju chart engine, auth and
database layers stay closed.

| File | What it does |
|---|---|
| `server/nebius.js` | Nebius Token Factory client (OpenAI-compatible). Thinking off via `chat_template_kwargs:{enable_thinking:false}`, 3 attempts, 30 s timeout |
| `server/crisis.js` | Deterministic crisis check (English + Korean patterns). Runs before any text reaches the model; the referral line is shown by the app, not generated |
| `server/reflectionTurn.js` | `POST /api/saju-reflection` (turn 1: observation + one question + provenance) and `…/answer` (turn 2: closing line + streak). The server assembles two lenses as data — today's chart facts and the user's own recent answers — so the model never sees a free-form request. Output post-checks → one retry → deterministic fallback |
| `src/ReflectionCard.jsx` | The card UI: closed / open / done / crisis states, provenance chips ("based on"), AI disclosure naming the model |

Closed imports (not included): `server/auth.js` (`verifyToken`), `server/db.js` (Firestore), `server/llm.js`
(`readBody`), `server/reflection.js` (`buildLens` — the chart facts), `server/route.js` (`isValidBirth`),
`core/timezone.js`, `core/enums.js`.

The provenance contract is shared with this repo's MCP server (`src/tools.js`): the chips a user sees are exactly the
facts the model was given, so a citation cannot be invented. Framing: reflection, not prediction; not medical,
psychological, legal or financial advice.
