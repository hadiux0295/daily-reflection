import { test } from "node:test";
import assert from "node:assert/strict";
import { STEMS, BRANCHES, TEN_GODS, SOLAR_TERMS, STRENGTH_LEVELS, glossPillar, glossTenGod, glossSolarTerm } from "../src/glossary.js";

// Vocab the saju engine can emit (mirrors saju core/enums.js) — every value must map (lex-0410: no silent gaps).
const ENGINE_STEMS = "甲乙丙丁戊己庚辛壬癸";
const ENGINE_BRANCHES = "子丑寅卯辰巳午未申酉戌亥";
const ENGINE_TEN_GODS = ["비견","겁재","식신","상관","편재","정재","편관","정관","편인","정인"];
const ENGINE_TERMS = ["소한","대한","입춘","우수","경칩","춘분","청명","곡우","입하","소만","망종","하지","소서","대서","입추","처서","백로","추분","한로","상강","입동","소설","대설","동지"];
const ENGINE_STRENGTH = ["극약","태약","신약","중화신약","중화","중화신강","신강","태강","극왕"];

test("glossary covers the full engine vocabulary", () => {
  for (const s of ENGINE_STEMS) assert.ok(STEMS[s], s);
  for (const b of ENGINE_BRANCHES) assert.ok(BRANCHES[b], b);
  for (const g of ENGINE_TEN_GODS) assert.ok(TEN_GODS[g], g);
  for (const t of ENGINE_TERMS) assert.ok(SOLAR_TERMS[t], t);
  for (const l of ENGINE_STRENGTH) assert.ok(STRENGTH_LEVELS[l], l);
  assert.equal(Object.keys(SOLAR_TERMS).length, 24);
});

test("gloss helpers never return undefined", () => {
  assert.equal(glossPillar("丁巳").english, "Yin Fire Snake");
  assert.equal(glossPillar("??").english, "??");
  assert.equal(glossTenGod("정관").english, "Order");
  assert.equal(glossTenGod("zzz").english, "zzz");
  assert.equal(glossSolarTerm("한로"), "Cold Dew");
  assert.equal(glossSolarTerm(undefined), "");
});
