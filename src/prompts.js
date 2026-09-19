// Deterministic reflection-question bank: weekday × season × mood → theme + 3 questions.
// No LLM. Same (date, tz, mood) always yields the same output (tested).

const WEEKDAY_THEMES = {
  Mon: "starting lines", Tue: "momentum", Wed: "the middle", Thu: "almost there",
  Fri: "small wins", Sat: "unhurried", Sun: "looking back",
};

const SEASON_QUESTIONS = {
  spring: "What is quietly starting to grow in your life right now?",
  summer: "Where did you have the most energy today, and where did it go?",
  autumn: "What are you ready to let fall away?",
  winter: "What did you protect today, and was it worth protecting?",
};

const MOOD_QUESTIONS = {
  low: [
    "What is one thing that went slightly better than yesterday?",
    "Who did you not have to explain yourself to today?",
    "What can wait until tomorrow?",
  ],
  neutral: [
    "What did today ask of you, and what did you give it?",
    "Which moment would you keep if you could keep only one?",
    "What is one thing you understand a little better now?",
  ],
  high: [
    "What made today feel good — and what part of that was your doing?",
    "Who would you like to tell about it?",
    "What do you want to carry into tomorrow?",
  ],
};

const WEEKDAY_QUESTIONS = {
  Mon: "What would make this week feel well spent by Friday?",
  Tue: "What did you pick back up today that you had set down?",
  Wed: "What has already been decided this week, and what is still open?",
  Thu: "What can be finished tomorrow if you stop adding to it?",
  Fri: "What can wait until Monday?",
  Sat: "What did you do today that no one asked you to do?",
  Sun: "What from this week deserves a second look?",
};

/** Weekday short name ("Mon") and month (1–12) of an ISO date as seen in `tz`. */
export function weekdayAndMonth(isoDate, tz) {
  // Interpret the date at noon UTC so the weekday is stable for every zone (±12h).
  const d = new Date(`${isoDate}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "numeric" });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, month: Number(parts.month) };
}

export function seasonOf(month) {
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function todayIn(tz, now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(now); // en-CA → YYYY-MM-DD
}

export function buildPrompt({ date, tz, mood = "neutral" }) {
  const { weekday, month } = weekdayAndMonth(date, tz);
  const season = seasonOf(month);
  const base = MOOD_QUESTIONS[mood] || MOOD_QUESTIONS.neutral;
  // Slot 3 rotates by weekday for low/neutral; slot 2 carries the season for high mood so all three axes show up.
  const questions = mood === "high"
    ? [base[0], SEASON_QUESTIONS[season], WEEKDAY_QUESTIONS[weekday] || base[2]]
    : [base[0], base[1], WEEKDAY_QUESTIONS[weekday] || base[2]];
  return { theme: WEEKDAY_THEMES[weekday] || "today", season, weekday, questions };
}
