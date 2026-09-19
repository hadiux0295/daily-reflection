// The 4 tool bodies as pure functions of ({ store, lens, now }) — no transport, no LLM. server.js wires them.
import { z } from "zod";
import { buildPrompt, todayIn } from "./prompts.js";
import { mapLens } from "./lens.js";

export const DISCLOSURE =
  "This conversation is voiced by an AI assistant. Reflection prompts come from a rule-based question bank and, when a birth " +
  "profile is given, from a rule-based Four-Pillars (saju) calculator. For reflection and entertainment only — not prophecy, " +
  "medical, psychological, legal, or financial advice. Journal entries are stored under your profile id until you delete them.";

export const CRISIS_REFERRAL =
  "If you are in crisis or thinking about harming yourself, please reach out now: findahelpline.com lists free, confidential helplines by country.";

export const DEFAULT_TZ = "America/Los_Angeles";
export const DEFAULT_PROFILE = "default";

// ---- schemas (also exported for the MCP registry) ----
const Tz = z.string().describe("IANA time zone, e.g. America/Los_Angeles");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD in `tz`");
const Mood = z.enum(["low", "neutral", "high"]);
const ProfileId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_\-.:@]+$/).describe("Client-chosen id that keys the journal and the optional birth profile");
export const Birth = z.object({
  year: z.number().int().min(1900).max(2100), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59).optional(),
  tz: Tz,
});

export const SCHEMAS = {
  get_reflection_prompt: { profile_id: ProfileId.optional(), date: IsoDate.optional(), tz: Tz.optional(), mood: Mood.optional() },
  get_daily_lens: { profile_id: ProfileId.optional(), birth: Birth.optional(), date: IsoDate.optional(), tz: Tz.optional(), remember: z.boolean().optional() },
  save_journal_entry: { profile_id: ProfileId.optional(), text: z.string().min(1).max(2000), mood: Mood.optional(), tags: z.array(z.string().max(32)).max(10).optional(), date: IsoDate.optional(), tz: Tz.optional() },
  get_reflection_history: { profile_id: ProfileId.optional(), days: z.number().int().min(1).max(90).optional(), tz: Tz.optional() },
};

export const DESCRIPTIONS = {
  get_reflection_prompt: "Three open reflection questions for today. Uses the stored birth profile as an optional lens if one exists; otherwise a generic theme. Data only — the host phrases the conversation.",
  get_daily_lens: "Today's Four-Pillars (saju) data for a birth profile, glossed in English: day pillar, relation to the day master, element balance, solar term, one focus theme. Optional lens for reflection, not a prediction.",
  save_journal_entry: "Save today's reflection. Returns the entry id, streak and entry count. If the text contains crisis wording the result includes a one-line helpline referral.",
  get_reflection_history: "Recent journal entries with streak and a coarse mood trend.",
};

// ---- helpers ----
const CRISIS_PATTERNS = [
  // Same list as saju_app/server/crisis.js (Saju Today 「오늘의 성찰」) — keep the two surfaces identical (2026-09-19).
  // en
  /\bkill(?:ing)? myself\b/i, /\bsuicid(?:e|al)\b/i, /\bend (?:it all|my life)\b/i, /\bwant(?:ed)? to die\b/i,
  /\bself[- ]?harm/i, /\bhurt(?:ing)? myself\b/i, /\bno reason to live\b/i, /\bnot worth living\b/i,
  /\bcut(?:ting)? myself\b/i, /\bbetter off dead\b/i,
  // widened 2026-09-19 (live miss: "I dont want to be alive anymore")
  /\b(?:don'?t|do not|didn'?t|never) want(?:ed)? to (?:be alive|live|exist|be here|wake up)\b/i, /\bwant(?:ed)? to die\b/i, /\bwanna die\b/i,
  /\bwish(?:ed)? I (?:was|were|weren'?t|wasn'?t) (?:dead|alive|born|here)\b/i, /\brather be dead\b/i, /\bending my life\b/i,
  /\btake my (?:own )?life\b/i, /\bno point (?:in|to) (?:living|going on|life)\b/i, /\bcan'?t go on\b(?!\s+(?:working|reading|writing|watching|studying)\b)/i, /\bdisappear (?:forever|for good)\b/i,
  /\boverdos(?:e|ed|ing)\b/i, /\bjump(?:ing|ed)? off (?:a |the |my )?(?:bridge|building|roof|cliff|balcony|ledge|tower)\b/i, /\b(?:want(?:ed)?|wanna|going|gonna|about|thinking (?:of|about)|tempted|ready|feel like)\s+(?:to\s+)?jump(?:ing)? off\b/i, /\bjump(?:ing)? in front of\b/i, /\bhang(?:ing)? myself\b/i, /\bnot (?:want(?:ing)?|going) to be alive\b/i,
  /죽을래/, /죽고싶/, /죽는\s*게\s*낫/, /죽으면\s*편/, /사는\s*게\s*의미\s*없/, /살아서\s*뭐/, /살\s*맛이?\s*없/, /목숨을?\s*끊/,
  /세상을?\s*떠나고\s*싶/, /그만\s*살고\s*싶/, /살고\s*싶지가?\s*않/, /죽어\s*버릴/,
  // ko — stems, so particles/endings do not matter (죽고 싶다/싶어요/싶은데…)
  /죽고\s*싶/, /죽어\s*버리/, /죽었으면/, /자살/, /자해/, /살기\s*싫/, /살고\s*싶지\s*않/,
  /사라지고\s*싶/, /없어지고\s*싶/, /끝내\s*버리고\s*싶/, /(?:다|모두)\s*끝내고\s*싶/, /(?:나|날|저|나를)\s*해치/,
  /손목을?\s*긋/, /뛰어내리고\s*싶/, /살\s*이유가?\s*없/, /살\s*가치가?\s*없/,
];
export function detectCrisis(text) { return CRISIS_PATTERNS.some((re) => re.test(text)); }

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Consecutive-day streak ending today (or yesterday, so a streak survives until the day is over). */
export function computeStreak(datesDesc, today) {
  const set = new Set(datesDesc);
  let cursor = set.has(today) ? today : set.has(addDays(today, -1)) ? addDays(today, -1) : null;
  let streak = 0;
  while (cursor && set.has(cursor)) { streak += 1; cursor = addDays(cursor, -1); }
  return streak;
}

const MOOD_SCORE = { low: 0, neutral: 1, high: 2 };
/** Newer half vs older half of the moods in the window (entries newest-first). */
export function moodTrend(entriesDesc) {
  const scores = entriesDesc.map((e) => MOOD_SCORE[e.mood]).filter((s) => s !== undefined);
  if (scores.length < 2) return "n/a";
  const half = Math.floor(scores.length / 2);
  const newer = scores.slice(0, half), older = scores.slice(scores.length - half);
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const diff = avg(newer) - avg(older);
  return diff > 0.25 ? "up" : diff < -0.25 ? "down" : "flat";
}

/** Provenance = the facts a host is allowed to cite, as short chips ({key,label}). Same contract as the
 *  "based on" chips in saju today's 오늘의 성찰 screen: the host shows exactly what it was given, so a
 *  citation cannot be invented (2026-09-18, Nebius x NVIDIA hackathon). */
export function lensProvenance(l) {
  const out = [];
  if (l.day_pillar?.hanja) out.push({ key: "day_pillar", label: `today ${l.day_pillar.hanja}${l.day_relation?.english ? ` · ${l.day_relation.english.toLowerCase()}` : ""}` });
  if (l.day_master?.hanja) out.push({ key: "day_master", label: `day master ${l.day_master.hanja}${l.day_master.element ? ` (${l.day_master.element})` : ""}` });
  if (l.solar_term?.english || l.solar_term?.korean) out.push({ key: "solar_term", label: `solar term ${l.solar_term.english || l.solar_term.korean}` });
  if (l.element_balance?.lacking) out.push({ key: "lacking", label: `balancing element ${l.element_balance.lacking}` });
  return out;
}

// ---- tool bodies ----
export function makeTools({ store, lens, now = () => new Date() }) {
  const resolveDate = (date, tz) => date || todayIn(tz, now());

  async function get_daily_lens({ profile_id = DEFAULT_PROFILE, birth, date, tz = DEFAULT_TZ, remember = false }) {
    const stored = store.getBirth(profile_id);
    const b = birth || stored;
    if (!b) return { error: "birth_required", message: "No birth profile stored for this profile_id — pass `birth` (year, month, day, hour, tz).", disclosure: DISCLOSURE };
    const day = resolveDate(date, tz);
    const r = await lens.fetchLens(b, { date: day, tz });
    if (!r.ok) return { error: r.error, message: "The saju lens is not available right now; reflection prompts still work without it.", date: day, disclosure: DISCLOSURE };
    if (birth && remember) store.putBirth(profile_id, birth);
    const lensOut = mapLens(r.raw);
    return { ...lensOut, provenance: lensProvenance(lensOut), remembered: Boolean(remember && birth) || (!birth && Boolean(stored)), disclosure: DISCLOSURE };
  }

  async function get_reflection_prompt({ profile_id = DEFAULT_PROFILE, date, tz = DEFAULT_TZ, mood = "neutral" }) {
    const day = resolveDate(date, tz);
    const p = buildPrompt({ date: day, tz, mood });
    let theme = p.theme, lens_available = false, lens_focus;
    const provenance = [{ key: "weekday", label: `${p.weekday} · ${p.theme}` }, { key: "season", label: p.season }, { key: "mood", label: `mood ${mood}` }];
    if (store.getBirth(profile_id) && lens.configured) {
      const l = await get_daily_lens({ profile_id, date: day, tz });
      if (!l.error) { lens_available = true; theme = l.focus.theme; lens_focus = l.focus.one_line; provenance.push(...l.provenance); }
    }
    return { date: day, weekday: p.weekday, season: p.season, theme, questions: p.questions, lens_available, ...(lens_focus ? { lens_focus } : {}), provenance, disclosure: DISCLOSURE };
  }

  async function save_journal_entry({ profile_id = DEFAULT_PROFILE, text, mood, tags = [], date, tz = DEFAULT_TZ }) {
    const day = resolveDate(date, tz);
    const id = store.addEntry(profile_id, { date: day, text, mood: mood || null, tags });
    const streak = computeStreak(store.entryDates(profile_id), todayIn(tz, now()));
    const out = { id, date: day, streak, entry_count: store.entryCount(profile_id), disclosure: DISCLOSURE };
    if (detectCrisis(text)) out.crisis_referral = CRISIS_REFERRAL;
    return out;
  }

  async function get_reflection_history({ profile_id = DEFAULT_PROFILE, days = 7, tz = DEFAULT_TZ }) {
    const today = todayIn(tz, now());
    const since = addDays(today, -(days - 1));
    const rows = store.listEntries(profile_id, since);
    const entries = rows.map((r) => ({ id: r.id, date: r.date, mood: r.mood || null, text_preview: r.text.length > 120 ? r.text.slice(0, 117) + "…" : r.text, tags: r.tags }));
    return { days, entries, streak: computeStreak(store.entryDates(profile_id), today), mood_trend: moodTrend(rows), disclosure: DISCLOSURE };
  }

  return { get_reflection_prompt, get_daily_lens, save_journal_entry, get_reflection_history };
}
