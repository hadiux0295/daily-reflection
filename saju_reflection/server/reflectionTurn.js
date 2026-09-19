// 「오늘의 성찰」 — POST /api/saju-reflection (turn 1) · POST /api/saju-reflection/answer (turn 2).
// Spec = docs/reflection_nemotron_spec.md §1. Hackathon: Nebius x NVIDIA Global AI 2026 (IB-0024).
//
// Shape copied from dailyLine.js: verifyToken → Firestore cache per uid+date → LLM inside the server →
// regen guard. Differences: the model = NVIDIA Nemotron on Nebius Token Factory (nebius.js), and the
// model never sees a free-form request — the server assembles two "lenses" deterministically and hands
// them over as data: ① today's chart facts (reflection.js buildLens) ② the user's own recent answers
// (users/{uid}.saju_reflectionRecent). The provenance chips shown in the UI are exactly that fact list,
// so a citation cannot be invented. Free, no quota, no session (same policy as the daily line).
// Dormant unless REFLECTION_LLM=nebius + NEBIUS_API_KEY (route answers 404 → safe to deploy first).
import { verifyToken } from "./auth.js";
import { getFirestoreDb } from "./db.js";
import { readBody } from "./llm.js";
import { buildLens } from "./reflection.js";
import { isValidBirth } from "./route.js";
import { isValidTimeZone, dateKeyInZone } from "../core/timezone.js";
import { chatNemotron, nebiusConfigured, NEBIUS_MODEL, NEBIUS_MODEL_LABEL } from "./nebius.js";
import { detectCrisis, referralFor } from "./crisis.js";
import { StrengthLevel, SolarTerm } from "../core/enums.js";

export const MAX_REGENS_PER_DAY = 3;
export const MAX_ANSWER_CHARS = 500;
const RECENT_KEEP = 14;      // entries kept on the user doc (no collection query → no composite index)
const HISTORY_DAYS = 7;      // entries the model sees
const MOODS = new Set(["low", "neutral", "high"]);
const MOOD_KO = { low: "가라앉음", neutral: "보통", high: "좋음" };
const MOOD_EN = { low: "low", neutral: "neutral", high: "good" };
// en: core emits Korean names for strength level / solar term — gloss them so an English reader never sees 극왕 or 백로 (found live 2026-09-19)
const camelWords = (k) => String(k).replace(/([A-Z])/g, " $1").toLowerCase().trim();
const STRENGTH_EN = Object.fromEntries(Object.values(StrengthLevel).map((v) => [v.korean, camelWords(v.key)]));
const SOLAR_TERM_EN = Object.fromEntries(Object.values(SolarTerm).map((v) => [v.korean, camelWords(v.key).replace(/\b\w/g, (c) => c.toUpperCase())]));
const ELEMENT_KO = { wood: "나무", fire: "불", earth: "흙", metal: "쇠", water: "물" }; // core emits English element keys; ko chips/data must not carry Latin

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

// ---------- deterministic pieces (exported for tests) ----------

/** Consecutive-day streak ending today or yesterday (Daily Reflection tools.js rule). */
export function computeStreak(datesDesc, today) {
  const set = new Set(datesDesc);
  const back = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  let cursor = set.has(today) ? today : set.has(back(today, 1)) ? back(today, 1) : null;
  let streak = 0;
  while (cursor && set.has(cursor)) { streak += 1; cursor = back(cursor, 1); }
  return streak;
}

const MOOD_SCORE = { low: 0, neutral: 1, high: 2 };
export function moodTrend(entriesDesc) {
  const s = entriesDesc.map((e) => MOOD_SCORE[e.mood]).filter((x) => x !== undefined);
  if (s.length < 2) return "flat";
  const half = Math.floor(s.length / 2);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const diff = avg(s.slice(0, half)) - avg(s.slice(s.length - half));
  return diff > 0.25 ? "up" : diff < -0.25 ? "down" : "flat";
}

/** The fact list handed to the model = the provenance chips shown to the user. Same object, one source. */
export function buildFacts({ lens, recent, lang, today }) {
  const ko = lang === "ko";
  const t = lens.today || {};
  const dp = t.dayPillar || {};
  const dm = lens.dayMaster || {};
  const dmEl = ko ? (ELEMENT_KO[dm.element] ?? dm.element) : dm.element;
  const facts = [];
  // en: the ten-god label = head of the English gloss ("roaming wealth (…)" → "roaming wealth") so a US judge never sees a bare 편재
  const tenGodEn = String(t.tenGodMeaning || t.tenGod || "").split("(")[0].trim() || t.tenGod;
  facts.push({
    key: "day_pillar",
    label: ko ? `오늘 일진 ${dp.korean}·${t.tenGod}` : `today ${dp.hanja} · ${tenGodEn}`,
    text: ko
      ? `오늘 일진 ${dp.korean}(${dp.hanja}) — 일간과의 관계 ${t.tenGod}: ${t.tenGodMeaning}`
      : `today's day pillar ${dp.hanja} — relation to the day master: ${t.tenGodMeaning || tenGodEn}`,
  });
  facts.push({
    key: "day_master",
    label: ko ? `일간 ${dm.korean}(${dmEl})` : `day master ${dm.hanja} (${dm.element})`,
    text: ko
      ? `일간 ${dm.korean}(${dm.hanja}) · 오행 ${dmEl} · 신강약 ${lens.strength?.level ?? "-"}`
      : `day master ${dm.hanja} · element ${dm.element} · natal strength ${STRENGTH_EN[lens.strength?.level] ?? lens.strength?.level ?? "-"}`,
  });
  if (t.solarTerm) {
    facts.push({
      key: "solar_term",
      label: ko ? `절기 ${t.solarTerm}` : `solar term ${SOLAR_TERM_EN[t.solarTerm] ?? t.solarTerm}`,
      text: ko ? `절기 ${t.solarTerm} (${t.daysSinceTerm ?? 0}일째)` : `solar term ${SOLAR_TERM_EN[t.solarTerm] ?? t.solarTerm}, day ${t.daysSinceTerm ?? 0}`,
    });
  }
  const hist = recent.filter((e) => e.date < today).slice(0, HISTORY_DAYS);
  if (hist.length) {
    const trend = moodTrend(hist);
    const arrow = trend === "up" ? "↗" : trend === "down" ? "↘" : "→";
    const M = ko ? MOOD_KO : MOOD_EN;
    const lines = hist.map((e) => `${e.date.slice(5)}${e.mood ? `(${M[e.mood]})` : ""} "${e.preview}"`).join(" / ");
    facts.push({
      key: "history",
      label: ko ? `지난 ${hist.length}일 답변 ${arrow}` : `last ${hist.length} answers ${arrow}`,
      text: ko ? `지난 ${hist.length}일의 답변(최근순): ${lines}` : `the user's last ${hist.length} answers (newest first): ${lines}`,
    });
  } else {
    facts.push({
      key: "history",
      label: ko ? "첫 성찰" : "first reflection",
      text: ko ? "지난 답변 없음 — 오늘이 첫 성찰" : "no previous answers — today is the first reflection",
    });
  }
  return facts;
}

const FALLBACK_Q = {
  ko: [
    "오늘 하루를 돌아보면, 지키고 싶었던 것은 무엇이었나요?",
    "오늘 조금이라도 어제보다 나았던 일 하나는 무엇인가요?",
    "오늘 가장 오래 머문 생각은 무엇이었나요?",
    "오늘 내려놓아도 되는 일 하나는 무엇인가요?",
    "오늘 하루 중 다시 꺼내 보고 싶은 순간은 언제였나요?",
    "오늘 누구에게도 설명하지 않아도 됐던 일은 무엇이었나요?",
    "오늘 하루가 당신에게 요구한 것은 무엇이었고, 무엇을 내주었나요?",
  ],
  en: [
    "Looking back at today, what did you want to protect?",
    "What is one thing that went slightly better than yesterday?",
    "Which thought stayed with you longest today?",
    "What can you set down for today?",
    "Which moment of today would you keep if you could keep only one?",
    "Who did you not have to explain yourself to today?",
    "What did today ask of you, and what did you give it?",
  ],
};
const FALLBACK_CLOSING = {
  ko: "오늘의 답을 남겼어요. 내일 같은 자리에서 다시 이어가요.",
  en: "Your answer is saved. Same place tomorrow.",
};

/** Deterministic turn 1 when the model is unavailable or fails the post-checks. */
export function fallbackTurn({ facts, lang, today }) {
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const q = FALLBACK_Q[lang === "ko" ? "ko" : "en"][day];
  const f = facts.find((x) => x.key === "day_pillar");
  const observation = lang === "ko"
    ? `오늘은 ${f ? f.label.replace("오늘 일진 ", "일진 ") : "새 하루"}의 날이에요.`
    : `Today's chart reads ${f ? f.label : "a new day"}.`;
  return { observation, question: q, generated: false };
}

const LATIN_RUN = /[A-Za-z]{3,}/;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/; // en output must not carry Korean (Nemotron copied 로밍재물/극왕 into an English citation, live 2026-09-19)
function sentences(text) {
  return String(text).replace(/\s+/g, " ").trim().split(/(?<=[.?!。？！])\s+/).filter(Boolean);
}

/** Split + validate the model's turn-1 text. Returns null when it fails the contract. */
export function parseTurn1(text, lang) {
  if (!text) return null;
  const s = sentences(text);
  if (s.length < 1 || s.length > 3) return null;
  const qi = s.map((x, i) => (/[?？]\s*$/.test(x) ? i : -1)).filter((i) => i >= 0).pop();
  if (qi === undefined || qi < 0) return null;
  const question = s[qi];
  const observation = s.filter((_, i) => i !== qi).join(" ");
  if (!observation) return null;
  if (lang === "ko" && LATIN_RUN.test(text.replace(/\([^)]*\)/g, ""))) return null; // Latin outside the citation parens
  if (lang !== "ko" && HANGUL.test(text)) return null;
  return { observation, question, generated: true };
}

export function parseClosing(text, lang) {
  if (!text) return null;
  const s = sentences(text);
  if (s.length < 1 || s.length > 2) return null;
  if (/[?？]/.test(text)) return null;
  if (lang === "ko" && LATIN_RUN.test(text)) return null;
  if (lang !== "ko" && HANGUL.test(text)) return null;
  return s.join(" ");
}

export function systemPrompt(lang) {
  return lang === "ko"
    ? [
      "너는 「사주 투데이」 앱의 「오늘의 성찰」 기능의 목소리입니다.",
      "규칙:",
      "① 모든 문장은 반드시 \"~요\" 또는 \"~습니다\"로 끝나는 존댓말입니다. 반말 금지.",
      "② 예언·조언·처방·평가 금지. 성찰만. \"~하세요/~해 보세요\" 같은 권유도 금지.",
      "③ 영어 단어 금지. 한자는 괄호 안에서만.",
      "④ 데이터에 없는 사실(기간, 사건, 감정)을 지어내지 않습니다. 기간은 데이터의 일수를 그대로 씁니다.",
      "⑤ 출력은 정확히 두 문장. 첫 문장 = 오늘의 명식 데이터와 지난 답변 사이의 일치 또는 긴장 하나를 짚고, 문장 끝 괄호 안에 사용한 데이터 이름을 적습니다. 둘째 문장 = 오늘 답할 질문 하나, 물음표로 끝.",
      "예시: \"지난 사흘 피로가 이어졌는데, 오늘은 기운이 밖으로 나가는 날이라 그 둘이 부딪히는 것 같아요 (오늘 일진 갑오·식신, 지난 3일 답변). 오늘 남에게 보이지 않아도 되는 일 하나는 무엇인가요?\"",
      "첫 성찰(지난 답변 없음)이면 첫 문장은 오늘 명식의 결 하나만 짚습니다.",
    ].join("\n")
    : [
      "You are the voice of the Daily Reflection feature inside the Saju Today app.",
      "Rules:",
      "1. Reflection only — never prediction, advice, prescription or judgement. No 'you should'.",
      "2. Never invent facts (durations, events, feelings) that are not in the data; use the data's day counts as given.",
      "3. Output exactly two sentences. Sentence 1 = one agreement or tension between today's chart data and the user's recent answers, ending with the names of the data you used in parentheses. Sentence 2 = one question for today, ending with a question mark.",
      "4. English only. Chinese characters for pillars (e.g. 乙未, 辛) are fine; never write Korean (Hangul) — use the English names given in the data.",
      "Example: \"Three tired days in a row meet a day whose energy moves outward, and the two seem to pull against each other (today 甲午 · 식신, last 3 answers). What is one thing today that no one else needs to see?\"",
      "If there are no previous answers, sentence 1 names one texture of today's chart only.",
      "Plain words, no jargon beyond the data labels, no markdown.",
    ].join("\n");
}

export function closingPrompt(lang) {
  return lang === "ko"
    ? "이제 사용자가 답했습니다. 한 문장으로만, 답의 핵심을 되비추는 말을 존댓말로 남깁니다. 질문·조언·평가·권유 금지, 영어 금지, 40자 이내."
    : "The user has answered. Reply with one sentence only that mirrors the heart of the answer. No question, no advice, no judgement, under 25 words.";
}

export function factsBlock(facts, lang) {
  return (lang === "ko" ? "[오늘의 데이터]\n" : "[Today's data]\n") + facts.map((f) => `- ${f.text}`).join("\n");
}

function preview(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 77) + "…" : t;
}

function birthKeyOf(birth) {
  return [birth.year, birth.month, birth.day, birth.hour, birth.minute ?? 0, birth.tz ?? "KST"].join("|");
}

function hash8(uid) { let h = 0; for (const c of String(uid)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(16).padStart(8, "0"); }

// ---------- store helpers ----------
async function loadUserRecent(db, uid) {
  const snap = await db.collection("users").doc(uid).get();
  const u = (snap.exists ? snap.data() : null) || {};
  const recent = Array.isArray(u.saju_reflectionRecent) ? u.saju_reflectionRecent : [];
  return recent.filter((e) => e && typeof e.date === "string").sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ---------- handlers ----------
async function handleOpen(req, res) {
  const user = await verifyToken(req);
  if (!user) return json(res, 401, { error: "login_required" });
  const body = await readBody(req);
  const { birth } = body || {};
  const lang = body?.lang === "ko" ? "ko" : "en";
  if (!isValidBirth(birth)) return json(res, 400, { error: "birth required (year, month, day, hour, tz?)" });
  const tz = body?.tz && isValidTimeZone(body.tz) ? body.tz : "Asia/Seoul";
  const today = dateKeyInZone(tz);
  const birthKey = birthKeyOf(birth);

  const db = await getFirestoreDb();
  if (!db) return json(res, 503, { error: "store_unavailable" });
  const ref = db.collection("saju_reflections").doc(`${user.uid}_${today}`);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : null;
  const recent = await loadUserRecent(db, user.uid);
  const streak = computeStreak(recent.map((e) => e.date), today);

  const respond = (doc, extra = {}) => json(res, 200, {
    date: today, lang: doc.lang, question: doc.question, observation: doc.observation, provenance: doc.provenance,
    generated: doc.generated !== false, model: NEBIUS_MODEL_LABEL,
    answered: Boolean(doc.answeredAt), ...(doc.answeredAt ? { text: doc.text, mood: doc.mood || null, closing: doc.closing || null, crisis_referral: doc.crisis ? referralFor(doc.lang) : undefined } : {}),
    streak, ...extra,
  });

  if (existing) {
    const sameBirth = existing.birthKey === birthKey && existing.lang === lang;
    if (existing.answeredAt || sameBirth) return respond(existing, { cached: true });
    if ((existing.regens ?? 0) >= MAX_REGENS_PER_DAY) return respond(existing, { cached: true });
  }

  const lensOut = buildLens(birth, { tz, date: today, lang });
  const facts = buildFacts({ lens: lensOut.lens, recent, lang, today });
  const provenance = facts.map((f) => ({ key: f.key, label: f.label }));

  let turn = null, usage = null, attempts = 0;
  if (nebiusConfigured()) {
    try {
      const r = await chatNemotron([
        { role: "system", content: systemPrompt(lang) },
        { role: "user", content: factsBlock(facts, lang) },
      ], { maxTokens: 300, temperature: 0.7 });
      usage = r.usage; attempts = r.attempts;
      turn = parseTurn1(r.content, lang);
      if (!turn) { // one more try on a contract miss, then fall back
        const r2 = await chatNemotron([
          { role: "system", content: systemPrompt(lang) },
          { role: "user", content: factsBlock(facts, lang) },
        ], { maxTokens: 300, temperature: 0.4 });
        attempts += r2.attempts; usage = r2.usage;
        turn = parseTurn1(r2.content, lang);
      }
    } catch (e) {
      console.error("[saju-reflection] nebius failed:", String(e?.message || e).slice(0, 120));
    }
  }
  if (!turn) turn = fallbackTurn({ facts, lang, today });
  console.log(`[saju-reflection] uid=${hash8(user.uid)} turn=1 generated=${turn.generated} attempts=${attempts} tokens=${usage?.total_tokens ?? "-"}`);

  const doc = {
    uid: user.uid, date: today, lang, birthKey,
    question: turn.question, observation: turn.observation, provenance, generated: turn.generated,
    model: turn.generated ? NEBIUS_MODEL : null,
    regens: (existing?.regens ?? 0) + (existing ? 1 : 0),
    createdAt: existing?.createdAt || new Date(),
  };
  await ref.set(doc, { merge: false }).catch((e) => console.warn("[saju-reflection] cache write failed:", e?.message));
  return respond(doc, { cached: false });
}

async function handleAnswer(req, res) {
  const user = await verifyToken(req);
  if (!user) return json(res, 401, { error: "login_required" });
  const body = await readBody(req);
  const text = String(body?.text ?? "").trim();
  if (!text) return json(res, 400, { error: "text_required" });
  if (text.length > MAX_ANSWER_CHARS) return json(res, 400, { error: "text_too_long", max: MAX_ANSWER_CHARS });
  const mood = MOODS.has(body?.mood) ? body.mood : null;
  const tz = body?.tz && isValidTimeZone(body.tz) ? body.tz : "Asia/Seoul";
  const today = dateKeyInZone(tz);

  const db = await getFirestoreDb();
  if (!db) return json(res, 503, { error: "store_unavailable" });
  const ref = db.collection("saju_reflections").doc(`${user.uid}_${today}`);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : null;
  if (!existing) return json(res, 409, { error: "open_first" });
  if (existing.answeredAt) return json(res, 409, { error: "already_answered" });
  const lang = existing.lang === "ko" ? "ko" : "en";

  const crisis = detectCrisis(text);
  let closing = null, usage = null;
  if (!crisis && nebiusConfigured()) {
    try {
      const r = await chatNemotron([
        { role: "system", content: systemPrompt(lang) },
        { role: "user", content: (lang === "ko" ? "[오늘의 질문]\n" : "[Today's question]\n") + `${existing.observation} ${existing.question}` },
        { role: "assistant", content: `${existing.observation} ${existing.question}` },
        { role: "user", content: (lang === "ko" ? `[답변${mood ? ` · 기분 ${MOOD_KO[mood]}` : ""}]\n` : `[Answer${mood ? ` · mood ${MOOD_EN[mood]}` : ""}]\n`) + text + "\n\n" + closingPrompt(lang) },
      ], { maxTokens: 120, temperature: 0.5 });
      usage = r.usage;
      closing = parseClosing(r.content, lang);
    } catch (e) {
      console.error("[saju-reflection] nebius closing failed:", String(e?.message || e).slice(0, 120));
    }
  }
  if (!crisis && !closing) closing = FALLBACK_CLOSING[lang];

  const recent = await loadUserRecent(db, user.uid);
  const nextRecent = [{ date: today, mood, preview: preview(text) }, ...recent.filter((e) => e.date !== today)].slice(0, RECENT_KEEP);
  const streak = computeStreak(nextRecent.map((e) => e.date), today);

  await ref.set({ text, mood, closing, crisis, answeredAt: new Date() }, { merge: true });
  await db.collection("users").doc(user.uid).set({ saju_reflectionRecent: nextRecent, saju_reflectionLastDate: today }, { merge: true });
  console.log(`[saju-reflection] uid=${hash8(user.uid)} turn=2 crisis=${crisis} tokens=${usage?.total_tokens ?? "-"}`);

  return json(res, 200, { saved: true, date: today, streak, closing, ...(crisis ? { crisis_referral: referralFor(lang) } : {}) });
}

export default function reflectionTurnRoute(req, res, next) {
  const url = req.url || "";
  if (!url.startsWith("/api/saju-reflection")) return next();
  if (!nebiusConfigured() && process.env.REFLECTION_LLM !== "fallback") return json(res, 404, { error: "not_found" }); // dormant
  if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
  const path = url.split("?")[0];
  const run = (fn) => fn(req, res).catch((e) => {
    const code = e?.statusCode === 413 ? 413 : 500;
    json(res, code, { error: code === 413 ? "payload_too_large" : String(e?.message || e) });
  });
  if (path === "/api/saju-reflection/answer") return run(handleAnswer);
  if (path === "/api/saju-reflection") return run(handleOpen);
  return next();
}
