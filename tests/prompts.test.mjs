import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, weekdayAndMonth, seasonOf, todayIn } from "../src/prompts.js";

test("same (date,tz,mood) → identical output; weekday computed in tz", () => {
  const a = buildPrompt({ date: "2026-10-10", tz: "America/Los_Angeles", mood: "low" });
  const b = buildPrompt({ date: "2026-10-10", tz: "America/Los_Angeles", mood: "low" });
  assert.deepEqual(a, b);
  assert.equal(a.weekday, "Sat"); assert.equal(a.season, "autumn"); assert.equal(a.questions.length, 3);
  assert.equal(weekdayAndMonth("2026-10-10", "Asia/Seoul").weekday, "Sat");
});

test("mood changes the questions; every mood yields 3 non-empty questions", () => {
  const themes = new Set();
  for (const mood of ["low", "neutral", "high"]) {
    const p = buildPrompt({ date: "2026-10-09", tz: "UTC", mood });
    assert.equal(p.questions.length, 3);
    p.questions.forEach((q) => assert.ok(q.length > 10));
    themes.add(p.questions[0]);
  }
  assert.equal(themes.size, 3);
});

test("season boundaries + todayIn respects tz", () => {
  assert.equal(seasonOf(12), "winter"); assert.equal(seasonOf(3), "spring"); assert.equal(seasonOf(9), "autumn");
  const t = new Date("2026-10-10T02:00:00Z"); // 09th evening in LA, 10th morning in Seoul
  assert.equal(todayIn("America/Los_Angeles", t), "2026-10-09");
  assert.equal(todayIn("Asia/Seoul", t), "2026-10-10");
});
