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
// ko: 극약/태강 etc. are jargon even for saju readers — gloss them in the data so the model never needs the raw term in a sentence (probe 2026-09-19)
const STRENGTH_KO_GLOSS = { extremelyWeak: "매우 약함", veryWeak: "많이 약함", weak: "약함", neutralWeak: "균형·약간 약함", neutral: "균형", neutralStrong: "균형·약간 강함", strong: "강함", veryStrong: "많이 강함", extremelyStrong: "매우 강함" };
const STRENGTH_KO = Object.fromEntries(Object.values(StrengthLevel).map((v) => [v.korean, STRENGTH_KO_GLOSS[v.key] ? `${STRENGTH_KO_GLOSS[v.key]}(${v.korean}, 괄호 인용에만)` : v.korean]));
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
    tenGod: t.tenGod,
    label: ko ? `오늘 일진 ${dp.korean}·${t.tenGod}` : `today ${dp.hanja} · ${tenGodEn}`,
    text: ko
      ? `오늘 일진 ${dp.korean}(${dp.hanja}) — 오늘의 결: ${t.tenGodMeaning} · 명리 용어 ${t.tenGod}(괄호 인용에만)` // meaning first: "관계 겁재: …" made the model lead with 겁재 (probe v3)
      : `today's day pillar ${dp.hanja} — relation to the day master: ${t.tenGodMeaning || tenGodEn}`,
  });
  facts.push({
    key: "day_master",
    label: ko ? `일간 ${dm.korean}(${dmEl})` : `day master ${dm.hanja} (${dm.element})`,
    text: ko
      ? `일간 ${dm.korean}(${dm.hanja}) · 오행 ${dmEl} · 타고난 힘 ${STRENGTH_KO[lens.strength?.level] ?? lens.strength?.level ?? "-"}`
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
const FALLBACK_OBS = {
  ko: {
    비견: "오늘은 나와 같은 기운이 비치는 날이라, 다른 사람에게서 내 습관이 보이기 쉬운 결이에요.",
    겁재: "오늘은 같은 기운이 반대 결로 들어와, 나눔과 겨룸이 가까이 붙어 있는 날이에요.",
    식신: "오늘은 편안하게 내놓는 기운이 흘러, 만들고 즐기는 일이 자연스러운 결이에요.",
    상관: "오늘은 날카롭게 표현하고 싶은 기운이 돌아, 정해진 틀과 부딪히기 쉬운 결이에요.",
    편재: "오늘은 넓게 흘러다니는 재물의 기운이라, 사람과 기회가 빠르게 오가는 결이에요.",
    정재: "오늘은 차곡차곡 쌓는 재물의 기운이라, 손에 잡히는 것을 꼼꼼히 다루는 결이에요.",
    편관: "오늘은 바깥의 압박이 들어오는 날이라, 요구와 도전이 나를 시험하는 결이에요.",
    정관: "오늘은 질서의 기운이 서는 날이라, 규칙과 평판, 정해진 길이 눈에 들어오는 결이에요.",
    편인: "오늘은 남다른 도움의 기운이라, 직관과 공부, 혼자 있는 시간이 가까운 결이에요.",
    정인: "오늘은 돌봄의 기운이 드는 날이라, 배우는 일과 보살핌받는 일이 가까운 결이에요.",
  },
  en: {
    비견: "Today mirrors your own element, the kind of day that shows you your own habits in other people.",
    겁재: "Today carries your own element in its opposite polarity, a day where sharing and competing sit close together.",
    식신: "Today leans toward gentle output: the things you make, enjoy and let flow easily.",
    상관: "Today leans toward sharp output: expression that wants out, even where it rubs against the rules.",
    편재: "Today carries roaming wealth: wide circles, chance openings, things that move quickly.",
    정재: "Today carries steady wealth: careful handling of what is tangible and yours to manage.",
    편관: "Today brings pressure from outside: demands and challenges that test your discipline.",
    정관: "Today brings order: rules, reputation and doing things through the proper channel.",
    편인: "Today leans toward unconventional support: intuition, study and some quiet time alone.",
    정인: "Today leans toward nurturing support: learning, being looked after and taking things in.",
  },
};
const FALLBACK_CLOSING = {
  ko: "오늘의 답을 솔직하게 남겨 주셨어요. 내일 같은 자리에서 다시 이어가요.",
  en: "Thank you for putting today into words. Same place tomorrow.",
};

/** Deterministic turn 1 when the model is unavailable or fails the post-checks. */
export function fallbackTurn({ facts, lang, today }) {
  const L = lang === "ko" ? "ko" : "en";
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  const q = FALLBACK_Q[L][day];
  const f = facts.find((x) => x.key === "day_pillar");
  const line = f && FALLBACK_OBS[L][f.tenGod];
  // hand-written per ten god: the old "Today's chart reads today 丙申 · rival peer." was the line a judge would see on a miss
  const observation = line ? `${line.replace(/\.$/, "")} (${f.label}).`
    : L === "ko" ? `오늘은 ${f ? f.label.replace("오늘 일진 ", "일진 ") : "새 하루"}의 날이에요.` : `Today's chart reads ${f ? f.label : "a new day"}.`;
  return { observation, question: q, generated: false };
}

const LATIN_RUN = /[A-Za-z]{3,}/;
const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/; // en output must not carry Korean (Nemotron copied 로밍재물/극왕 into an English citation, live 2026-09-19)
function sentences(text) {
  return String(text).replace(/\s+/g, " ").trim().split(/(?<=[.?!。？！])\s+/).filter(Boolean);
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF]/g;
// ko: ten-god / strength terms belong in the citation parens only — prompt wording alone left them in the body (probe v2: 5 of 16)
// advice / "should" wording — the prompt forbids it, the check guarantees it (probe v4: "오늘은 꼼꼼히 챙겨야 할 것 같아요")
const ADVICE = { ko: /야\s*(?:할\s*(?:것|거|때|일)|해요|합니다|하는\s*날)|하세요|해\s*보세요|보세요|좋겠어요|어떨까요|좋을까요/, en: /\b(?:you should|you need to|try to|make sure|consider)\b/i };
const KO_JARGON = /비견|겁재|식신|상관|편재|정재|편관|정관|칠살|편인|정인|신강|신약|극왕|극약|태강|태약|중화/;

/**
 * Split + validate the model's turn-1 text. Returns null when it fails the contract.
 * ctx.factsText (en) — every Chinese character must already be in the data: pillars pass, a re-translated
 *   ten-god name (劫财, 比肩) or an invented one fails (probe 2026-09-19: 3 of 8 en turns).
 * ctx.hasHistory — the observation must cite the user's past answers, not only the chart.
 */
export function checkTurn1(text, lang, ctx = {}) {
  if (!text) return { reason: "empty" };
  const s = sentences(text);
  if (s.length < 2 || s.length > 3) return { reason: "sentences" };
  // exactly one question and it is the last sentence (probe: "…가벼워질까요? (citation) …무엇인가요?" passed as observation+question)
  if (s.filter((x) => /[?？]/.test(x)).length !== 1 || !/[?？]\s*$/.test(s[s.length - 1])) return { reason: "question" };
  const question = s[s.length - 1];
  const observation = s.slice(0, -1).join(" ");
  if (lang === "ko" && LATIN_RUN.test(text.replace(/\([^)]*\)/g, ""))) return { reason: "latin" }; // Latin outside the citation parens
  if (lang === "ko" && KO_JARGON.test(text.replace(/\([^)]*\)/g, ""))) return { reason: "jargon" };
  if (ADVICE[lang === "ko" ? "ko" : "en"].test(text)) return { reason: "advice" };
  if (lang !== "ko" && HANGUL.test(text)) return { reason: "hangul" };
  if (lang !== "ko" && ctx.factsText && (text.match(CJK) || []).some((c) => !ctx.factsText.includes(c))) return { reason: "cjk" };
  // en citation words must come from the data (probe v5 invented "stingray day 丙申", "st … dm 丁"; earlier "Bu Wei")
  if (lang !== "ko" && ctx.factsText) {
    const vocab = new Set((ctx.factsText.toLowerCase().match(/[a-z]+/g) || []).concat(["last", "answers", "answer", "today", "day", "master", "and"]));
    const cited = (observation.match(/\(([^)]*)\)/g) || []).join(" ").toLowerCase().match(/[a-z]+/g) || [];
    // inflections of a data word pass ("rivalry" for "rival peer" = 4 of 12 en misses, census 2026-09-19); invented words still fail
    const known = (w) => vocab.has(w) || (w.length >= 4 && [...vocab].some((v) => v.length >= 4 && (w.startsWith(v) || v.startsWith(w))));
    if (cited.some((w) => !known(w))) return { reason: "cite_vocab" };
  }
  if (ctx.hasHistory && !/지난\s*\d+\s*일|last \d+ answers?/i.test(observation)) return { reason: "history" };
  return { turn: { observation, question, generated: true } };
}

const HINT = {
  en: { empty: "Your reply was empty.", sentences: "Write one or two observation sentences, then exactly one question.", question: "Use exactly one question mark, only in the last sentence.",
    advice: "No advice or suggestions (no should, try to, make sure, consider).", hangul: "No Korean characters.", cjk: "Use Chinese characters only exactly as they appear in the data.",
    cite_vocab: "Inside the parentheses copy the data labels word for word.", history: "Name the user's past answers and cite them as (last N answers)." },
  ko: { empty: "답이 비어 있었어요.", sentences: "관찰 1~2문장 뒤에 질문 정확히 한 문장으로 쓰세요.", question: "물음표는 마지막 문장에 한 번만 쓰세요.",
    latin: "괄호 밖에는 영어를 쓰지 마세요.", jargon: "명리 용어는 문장 본문에 쓰지 말고 괄호 인용 안에만 쓰세요.", advice: "조언·권유 표현(~하세요, ~해 보세요, ~야 해요)을 쓰지 마세요.",
    history: "지난 답변을 짚고 괄호에 (지난 N일 답변)으로 인용하세요." },
};
/** Second-attempt user message: the rule the first reply broke (census 2026-09-19: blind retries repeated the same miss). */
export function retryHint(reason, lang) {
  const L = lang === "ko" ? "ko" : "en";
  const h = HINT[L][reason] || "";
  return L === "ko" ? `규칙 하나를 어겼어요. ${h} 다른 규칙도 모두 지켜서 다시 써 주세요.` : `That broke one rule. ${h} Write it again, keeping every other rule.`;
}

/** Contract check with the model text → turn or null (callers that need the miss reason use checkTurn1). */
export function parseTurn1(text, lang, ctx = {}) { return checkTurn1(text, lang, ctx).turn || null; }

// Closing must not hand a hurt back to the user (probe 2026-09-19: "Nothing I do seems to matter—work feels pointless").
// Only heavy hopelessness words: a closing may name tiredness in a strength frame ("피곤함 속에서도 끝까지 지켜낸"),
// but must not hand back "useless / empty / pointless". Light echoes are caught by the en 3-word check.
const DISTRESS_EN = [/\buseless/i, /\bworthless/i, /\bpointless/i, /\bhopeless/i, /\bmeaningless/i, /\bempt(?:y|iness)\b/i, /\bnumb(?:ness)?\b/i, /\bmiser(?:able|y)\b/i, /\blonel(?:y|iness)\b/i, /\bdepress(?:ed|ion|ing)\b/i, /\bbroken\b/i, /\bfailure\b/i, /\bnothing\b[^.]{0,20}\bmatters?\b/i, /\bno point\b/i, /\bgive up\b|\bgiving up\b/i]; // + staging smoke: "naming the sense that nothing matters"
const DISTRESS_KO = [/쓸모/, /의미\s*(?:가|도)?\s*없/, /무감각/, /텅\s*[빈비]/, /공허/, /우울/, /외로/, /절망/, /비참/, /무의미/, /가치\s*(?:가|도)?\s*없/];
function words(t) { return String(t).toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean); }
/** True when the closing repeats the answer: a shared 3-word run (en) or a shared distress word/stem. */
export function echoesAnswer(closing, answer, lang) {
  if (!answer) return false;
  if (lang === "ko") return DISTRESS_KO.some((re) => re.test(closing) && re.test(answer));
  const a = words(answer), c = words(closing);
  const grams = new Set(a.slice(0, -2).map((_, i) => a.slice(i, i + 3).join(" ")));
  if (c.slice(0, -2).some((_, i) => grams.has(c.slice(i, i + 3).join(" ")))) return true;
  return DISTRESS_EN.some((re) => re.test(closing) && re.test(answer)); // stems: "empty" in the answer, "emptiness" in the closing
}

export function parseClosing(text, lang, answer = "") {
  if (!text) return null;
  text = String(text).replace(/\s*[(（][^)）]*[)）]/g, "").trim(); // a chart citation copied from turn 1 does not belong in the closing
  const s = sentences(text);
  if (s.length < 1 || s.length > 2) return null;
  if (/[?？]/.test(text)) return null;
  if (lang === "ko" && LATIN_RUN.test(text)) return null;
  if (lang !== "ko" && HANGUL.test(text)) return null;
  if (lang !== "ko" && /\b(they|their|them|the user)\b/i.test(text)) return null; // speak to the user, not about them (probe v2: "They named…")
  if (echoesAnswer(text, answer, lang)) return null;
  return s.join(" ");
}

export function systemPrompt(lang) {
  return lang === "ko"
    ? [
      "너는 「사주 투데이」 앱의 「오늘의 성찰」 기능의 목소리입니다.",
      "규칙:",
      "① 모든 문장은 반드시 \"~요\" 또는 \"~습니다\"로 끝나는 존댓말입니다. 반말 금지.",
      "② 예언·조언·처방·평가 금지. 성찰만. \"~하세요/~해 보세요/~면 좋겠어요/~하면 어떨까요/~될까요\" 같은 권유도 금지.",
      "③ 영어 단어 금지. 한자는 괄호 안에서만.",
      "④ 데이터에 없는 사실(기간, 사건, 감정)을 지어내지 않습니다. 기간은 데이터의 일수를 그대로 씁니다. 명식이 사용자의 기분을 만들거나 더 나쁘게 한다고 말하지 않습니다.",
      "⑤ 출력은 정확히 두 문장. 첫 문장(70자 안팎) = 오늘의 명식 데이터와 지난 답변 사이의 일치 또는 긴장 하나를 누구나 아는 쉬운 말로 짚고, 문장 끝 괄호 안에 사용한 데이터 이름을 적습니다. 겁재·비견·식신·정재·신강·극약 같은 명리 용어는 본문에 쓰지 않고 괄호 안에만 둡니다. 둘째 문장(40자 이내) = 사용자가 오늘 겪었거나 느꼈거나 한 일을 묻는 짧고 쉬운 질문 하나, 물음표로 끝. 물음표는 둘째 문장에만 씁니다.",
      "⑥ 지난 답변이 있으면 첫 문장은 반드시 그 답변의 내용을 짚고, 괄호에 \"지난 N일 답변\"을 적습니다. 지난 답변이 없으면 첫 문장은 오늘 명식의 결 하나만 짚습니다.",
      "예시: \"지난 사흘 피로가 이어졌는데, 오늘은 기운이 밖으로 나가는 날이라 그 둘이 부딪히는 것 같아요 (오늘 일진 갑오·식신, 지난 3일 답변). 오늘 남에게 보이지 않아도 되는 일 하나는 무엇인가요?\"",
    ].join("\n")
    : [
      "You are the voice of the Daily Reflection feature inside the Saju Today app.",
      "Rules:",
      "1. Reflection only — never prediction, advice, prescription or judgement. No 'you should', 'try', 'what could help' or 'what might'.",
      "2. Never invent facts (durations, events, feelings) that are not in the data; use the data's day counts as given. Never say the chart causes or deepens how the user feels.",
      "3. Output exactly two sentences. Sentence 1 (under 35 words) = one agreement or tension between today's chart data and the user's recent answers, in plain everyday words, ending with the names of the data you used in parentheses. Sentence 2 (under 16 words) = one simple question about what the user noticed, did or felt today, ending with a question mark; do not assume the time of day. Only sentence 2 may contain a question mark.",
      "4. English only. Copy data labels exactly as the data writes them — never translate a label into Chinese or Korean. Chinese characters may appear only where the data already has them (the pillars).",
      "5. If there are previous answers, sentence 1 must speak to them and cite 'last N answers'. If there are none, sentence 1 names one texture of today's chart only.",
      "Example: \"Three tired days in a row meet a day whose energy moves outward, and the two seem to pull against each other (today 甲午 · output, last 3 answers). What is one thing today that no one else needed to see?\"",
      "No markdown.",
    ].join("\n");
}

export function closingPrompt(lang) {
  return lang === "ko"
    ? "이제 사용자가 답했습니다. 한 문장으로만, 사용자가 오늘 해낸 것·알아차린 것·붙잡은 것을 존댓말로 짚어 줍니다. 답의 표현을 되풀이하지 않고 힘든 감정을 다시 말하지 않습니다 — 힘든 답이면 그것을 솔직히 적어 준 일 자체를 짚습니다. 명식·일진·오늘의 기운·괄호는 쓰지 않습니다. 질문·조언·평가·권유 금지, 영어 금지, 40자 이내."
    : "The user has answered. Speak to them directly as 'you'. Reply with one sentence only that names what they did, noticed or held on to today. Do not start with 'You named'. Do not repeat the answer's words and never restate a hurt — if the answer is painful, acknowledge that they put it into words honestly. No chart terms, no parentheses, no question, no advice, no judgement, under 25 words.";
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
  const ctx = { factsText: factsBlock(facts, lang), hasHistory: facts.some((f) => f.key === "history" && !/첫 성찰|first reflection/.test(f.label)) };

  let turn = null, usage = null, attempts = 0, miss = "";
  if (nebiusConfigured()) {
    try {
      const r = await chatNemotron([
        { role: "system", content: systemPrompt(lang) },
        { role: "user", content: factsBlock(facts, lang) },
      ], { maxTokens: 300, temperature: 0.7 });
      usage = r.usage; attempts = r.attempts;
      const c1 = checkTurn1(r.content, lang, ctx);
      turn = c1.turn || null; miss = c1.reason || "";
      if (!turn) { // one more try on a contract miss — told which rule it broke — then fall back
        const r2 = await chatNemotron([
          { role: "system", content: systemPrompt(lang) },
          { role: "user", content: factsBlock(facts, lang) },
          ...(r.content ? [{ role: "assistant", content: r.content }, { role: "user", content: retryHint(c1.reason, lang) }] : []),
        ], { maxTokens: 300, temperature: 0.4 });
        attempts += r2.attempts; usage = r2.usage;
        const c2 = checkTurn1(r2.content, lang, ctx);
        turn = c2.turn || null; miss += `,${c2.reason || "ok"}`;
      }
    } catch (e) {
      console.error("[saju-reflection] nebius failed:", String(e?.message || e).slice(0, 120));
    }
  }
  if (!turn) turn = fallbackTurn({ facts, lang, today });
  console.log(`[saju-reflection] uid=${hash8(user.uid)} turn=1 generated=${turn.generated} attempts=${attempts}${miss ? ` miss=${miss}` : ""} tokens=${usage?.total_tokens ?? "-"}`);

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
  let closing = null, usage = null, closingAttempts = 0;
  if (!crisis && nebiusConfigured()) {
    try {
      const msgs = [
        { role: "system", content: systemPrompt(lang) },
        { role: "user", content: (lang === "ko" ? "[오늘의 질문]\n" : "[Today's question]\n") + `${existing.observation} ${existing.question}` },
        { role: "assistant", content: `${existing.observation} ${existing.question}` },
        { role: "user", content: (lang === "ko" ? `[답변${mood ? ` · 기분 ${MOOD_KO[mood]}` : ""}]\n` : `[Answer${mood ? ` · mood ${MOOD_EN[mood]}` : ""}]\n`) + text + "\n\n" + closingPrompt(lang) },
      ];
      for (const temperature of [0.5, 0.3]) { // one retry on a contract miss (echo, question, Latin/Hangul), then the fixed line
        const r = await chatNemotron(msgs, { maxTokens: 120, temperature });
        usage = r.usage; closingAttempts++;
        closing = parseClosing(r.content, lang, text);
        if (closing) break;
      }
    } catch (e) {
      console.error("[saju-reflection] nebius closing failed:", String(e?.message || e).slice(0, 120));
    }
  }
  const closingSource = crisis ? "none" : closing ? "generated" : "fallback";
  if (!crisis && !closing) closing = FALLBACK_CLOSING[lang];

  const recent = await loadUserRecent(db, user.uid);
  const nextRecent = [{ date: today, mood, preview: preview(text) }, ...recent.filter((e) => e.date !== today)].slice(0, RECENT_KEEP);
  const streak = computeStreak(nextRecent.map((e) => e.date), today);

  await ref.set({ text, mood, closing, crisis, answeredAt: new Date() }, { merge: true });
  await db.collection("users").doc(user.uid).set({ saju_reflectionRecent: nextRecent, saju_reflectionLastDate: today }, { merge: true });
  console.log(`[saju-reflection] uid=${hash8(user.uid)} turn=2 crisis=${crisis} closing=${closingSource} attempts=${closingAttempts} tokens=${usage?.total_tokens ?? "-"}`);

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
