import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.js";
import { makeLensClient, mapLens } from "../src/lens.js";
import { makeTools, detectCrisis, computeStreak, moodTrend, DISCLOSURE } from "../src/tools.js";

const RAW = { date: "2026-10-10", tz: "America/Los_Angeles", lens: {
  pillars: { year: { hanja: "庚午" }, month: { hanja: "辛巳" }, day: { hanja: "庚辰" }, hour: { hanja: "辛巳" } },
  dayMaster: { hanja: "庚", element: "metal" }, strength: { level: "중화신강", isStrong: true },
  today: { date: "2026-10-10", dayPillar: { hanja: "丁巳" }, tenGod: "정관", solarTerm: "한로", daysSinceTerm: 2, tenGodMeaning: "order/authority" },
  lackingElement: { primary: "fire", secondary: "water" } } };
const BIRTH = { year: 1990, month: 5, day: 15, hour: 10, tz: "Asia/Seoul" };
const NOW = () => new Date("2026-10-10T20:00:00Z"); // 2026-10-10 13:00 in LA

function fakeLens({ configured = true, status = 200 } = {}) {
  const env = configured ? { SAJU_LENS_URL: "http://x/api/reflection/lens", REFLECTION_SERVICE_KEY: "k" } : {};
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: status === 200, status, json: async () => RAW }; };
  return { client: makeLensClient({ env, fetchImpl }), calls };
}

test("mapLens → DESIGN §2 shape, English glossed", () => {
  const m = mapLens(RAW);
  assert.equal(m.day_pillar.english, "Yin Fire Snake");
  assert.equal(m.day_relation.key, "direct_officer");
  assert.equal(m.solar_term.english, "Cold Dew");
  assert.equal(m.element_balance.lacking, "fire");
  assert.deepEqual(m.element_balance.counts, { wood: 0, fire: 3, earth: 1, metal: 4, water: 0 });
  assert.equal(m.day_master.strength, "balanced, leaning strong");
});

test("crisis detection: hit vs near-miss", () => {
  assert.ok(detectCrisis("I keep thinking I want to die."));
  assert.ok(detectCrisis("thoughts of self-harm again"));
  assert.ok(!detectCrisis("This deadline is killing me, but I'll live."));
  assert.ok(!detectCrisis("I died laughing at the meeting."));
  // 2026-09-19 sync with Saju Today: past tense, intent phrasing, idioms that are not crisis
  for (const yes of ["I overdosed last night", "I just want to jump off", "I can't go on with life", "honestly I dont want to be alive anymore"]) assert.ok(detectCrisis(yes), yes);
  for (const no of ["I jumped off the bus early and walked", "I can't go on working this late"]) assert.ok(!detectCrisis(no), no);
});

test("streak: today / yesterday / gap", () => {
  assert.equal(computeStreak(["2026-10-10", "2026-10-09", "2026-10-08"], "2026-10-10"), 3);
  assert.equal(computeStreak(["2026-10-09", "2026-10-08"], "2026-10-10"), 2); // still alive until today ends
  assert.equal(computeStreak(["2026-10-08", "2026-10-07"], "2026-10-10"), 0);
  assert.equal(computeStreak(["2026-10-10", "2026-10-08"], "2026-10-10"), 1);
  assert.equal(computeStreak([], "2026-10-10"), 0);
});

test("mood trend up/flat/down/n/a (entries newest-first)", () => {
  assert.equal(moodTrend([{ mood: "high" }, { mood: "high" }, { mood: "low" }, { mood: "low" }]), "up");
  assert.equal(moodTrend([{ mood: "low" }, { mood: "high" }]), "down");
  assert.equal(moodTrend([{ mood: "neutral" }, { mood: "neutral" }, { mood: "neutral" }]), "flat");
  assert.equal(moodTrend([{ mood: "high" }]), "n/a");
  assert.equal(moodTrend([{ mood: null }, { mood: null }]), "n/a");
});

test("tools: prompt without profile, lens with birth, remember flag, journal + history, disclosure everywhere", async () => {
  const store = openStore(":memory:");
  const { client, calls } = fakeLens();
  const t = makeTools({ store, lens: client, now: NOW });

  const p0 = await t.get_reflection_prompt({ mood: "low" });
  assert.equal(p0.date, "2026-10-10"); assert.equal(p0.lens_available, false); assert.equal(p0.theme, "unhurried"); // 2026-10-10 = Saturday
  assert.equal(p0.questions[2], "What did you do today that no one asked you to do?");

  const noBirth = await t.get_daily_lens({});
  assert.equal(noBirth.error, "birth_required");

  const l1 = await t.get_daily_lens({ birth: BIRTH, remember: false });
  assert.equal(l1.day_pillar.english, "Yin Fire Snake"); assert.equal(l1.remembered, false);
  assert.equal(store.getBirth("default"), null, "remember:false must not store birth");
  assert.equal(JSON.parse(calls[0].opts.body).tz, "America/Los_Angeles");
  assert.equal(calls[0].opts.headers["X-Service-Key"], "k");

  const l2 = await t.get_daily_lens({ birth: BIRTH, remember: true });
  assert.equal(l2.remembered, true); assert.deepEqual(store.getBirth("default"), BIRTH);

  const p1 = await t.get_reflection_prompt({ mood: "low" });
  assert.equal(p1.lens_available, true); assert.equal(p1.theme, "order"); assert.ok(p1.lens_focus);
  // provenance = the facts a host may cite (same chip contract as saju today's 오늘의 성찰): prompt facts + lens facts
  assert.deepEqual(p1.provenance.slice(0, 3).map((x) => x.key), ["weekday", "season", "mood"]);
  assert.ok(p1.provenance.some((x) => x.key === "day_pillar" && /^today /.test(x.label)));
  assert.ok(l2.provenance.some((x) => x.key === "day_master"));

  const s1 = await t.save_journal_entry({ text: "Kept my word on the small thing.", mood: "neutral", tags: ["work"] });
  assert.equal(s1.streak, 1); assert.equal(s1.entry_count, 1); assert.equal(s1.crisis_referral, undefined);
  const s2 = await t.save_journal_entry({ text: "Honestly I want to die some days.", mood: "low", date: "2026-10-09" });
  assert.ok(s2.crisis_referral && s2.crisis_referral.includes("findahelpline.com"));
  assert.equal(s2.streak, 2);

  const h = await t.get_reflection_history({ days: 7 });
  assert.equal(h.entries.length, 2); assert.equal(h.entries[0].date, "2026-10-10"); assert.equal(h.streak, 2);
  assert.equal(h.mood_trend, "up"); assert.deepEqual(h.entries[0].tags, ["work"]);
  const h1 = await t.get_reflection_history({ days: 1 });
  assert.equal(h1.entries.length, 1);

  for (const r of [p0, noBirth, l1, l2, p1, s1, s2, h]) assert.equal(r.disclosure, DISCLOSURE);

  const del = store.deleteProfile("default");
  assert.equal(del.entries_deleted, 2); assert.equal(del.profile_deleted, true);
  assert.equal((await t.get_reflection_history({})).entries.length, 0);
  store.close();
});

test("lens unavailable (env unset / upstream error) degrades, never throws", async () => {
  const store = openStore(":memory:");
  const off = makeTools({ store, lens: fakeLens({ configured: false }).client, now: NOW });
  const r = await off.get_daily_lens({ birth: BIRTH });
  assert.equal(r.error, "lens_unavailable");
  store.putBirth("default", BIRTH);
  const p = await off.get_reflection_prompt({});
  assert.equal(p.lens_available, false); assert.equal(p.questions.length, 3);
  const bad = makeTools({ store, lens: fakeLens({ status: 401 }).client, now: NOW });
  assert.equal((await bad.get_daily_lens({})).error, "lens_upstream_error");
  const p2 = await bad.get_reflection_prompt({});
  assert.equal(p2.lens_available, false);
  store.close();
});

test("profiles are isolated", async () => {
  const store = openStore(":memory:");
  const t = makeTools({ store, lens: fakeLens({ configured: false }).client, now: NOW });
  await t.save_journal_entry({ profile_id: "a", text: "x" });
  assert.equal((await t.get_reflection_history({ profile_id: "b" })).entries.length, 0);
  store.close();
});

test("store: DELETE journal mode works on a real file (FUSE-safe path)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dr-"));
  const s1 = openStore(join(dir, "j.sqlite"), { journal: "DELETE" });
  s1.addEntry("p", { date: "2026-10-10", text: "persist me" }); s1.close();
  const s2 = openStore(join(dir, "j.sqlite"), { journal: "DELETE" });
  assert.equal(s2.entryCount("p"), 1); s2.close();
  assert.throws(() => openStore(":memory:", { journal: "EVIL; DROP" }));
});
