// Deterministic crisis check for free-text emotional input (§5.5 baseline: emotion/crisis input apps need a
// one-line referral). Runs BEFORE any model call; nothing here touches an LLM.
// English list = Daily Reflection tools.js (2026-09-05). Korean list added 2026-09-18 for 「오늘의 성찰」.
// Policy: over-match is acceptable (the entry is still saved, only the model turn is replaced by the referral).
const PATTERNS = [
  // en
  /\bkill(?:ing)? myself\b/i, /\bsuicid(?:e|al)\b/i, /\bend (?:it all|my life)\b/i, /\bwant(?:ed)? to die\b/i,
  /\bself[- ]?harm/i, /\bhurt(?:ing)? myself\b/i, /\bno reason to live\b/i, /\bnot worth living\b/i,
  /\bcut(?:ting)? myself\b/i, /\bbetter off dead\b/i,
  // widened 2026-09-19 (live miss: "I dont want to be alive anymore")
  /\b(?:don'?t|do not|didn'?t|never) want(?:ed)? to (?:be alive|live|exist|be here|wake up)\b/i, /\bwant(?:ed)? to die\b/i, /\bwanna die\b/i,
  /\bwish(?:ed)? I (?:was|were|weren'?t|wasn'?t) (?:dead|alive|born|here)\b/i, /\brather be dead\b/i, /\bending my life\b/i,
  /\btake my (?:own )?life\b/i, /\bno point (?:in|to) (?:living|going on|life)\b/i, /\bcan'?t go on\b/i, /\bdisappear (?:forever|for good)\b/i,
  /\boverdos(?:e|ing)\b/i, /\bjump(?:ing)? off\b/i, /\bhang(?:ing)? myself\b/i, /\bnot (?:want(?:ing)?|going) to be alive\b/i,
  /죽을래/, /죽고싶/, /죽는\s*게\s*낫/, /죽으면\s*편/, /사는\s*게\s*의미\s*없/, /살아서\s*뭐/, /살\s*맛이?\s*없/, /목숨을?\s*끊/,
  /세상을?\s*떠나고\s*싶/, /그만\s*살고\s*싶/, /살고\s*싶지가?\s*않/, /죽어\s*버릴/,
  // ko — stems, so particles/endings do not matter (죽고 싶다/싶어요/싶은데…)
  /죽고\s*싶/, /죽어\s*버리/, /죽었으면/, /자살/, /자해/, /살기\s*싫/, /살고\s*싶지\s*않/,
  /사라지고\s*싶/, /없어지고\s*싶/, /끝내\s*버리고\s*싶/, /(?:다|모두)\s*끝내고\s*싶/, /(?:나|날|저|나를)\s*해치/,
  /손목을?\s*긋/, /뛰어내리고\s*싶/, /살\s*이유가?\s*없/, /살\s*가치가?\s*없/,
];

export function detectCrisis(text) {
  const t = String(text || "");
  return PATTERNS.some((re) => re.test(t));
}

export const REFERRAL = {
  ko: "지금 많이 힘드시다면 혼자 견디지 마세요. 자살예방상담전화 109(24시간, 무료) 또는 findahelpline.com 에서 바로 도움을 받을 수 있어요.",
  en: "If you are in crisis or thinking about harming yourself, please reach out now: findahelpline.com lists free, confidential helplines by country (Korea: 109).",
};

export function referralFor(lang) {
  return REFERRAL[lang === "ko" ? "ko" : "en"];
}
