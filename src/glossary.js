// English glossary for the Korean/hanja labels the saju lens endpoint emits.
// Complete tables (10 stems · 12 branches · 10 ten-gods · 24 solar terms · 9 strength levels) —
// `gloss*` helpers never return undefined: unknown input falls back to the raw label so nothing is silently dropped.

export const STEMS = {
  "甲": { english: "Yang Wood", element: "wood" }, "乙": { english: "Yin Wood", element: "wood" },
  "丙": { english: "Yang Fire", element: "fire" }, "丁": { english: "Yin Fire", element: "fire" },
  "戊": { english: "Yang Earth", element: "earth" }, "己": { english: "Yin Earth", element: "earth" },
  "庚": { english: "Yang Metal", element: "metal" }, "辛": { english: "Yin Metal", element: "metal" },
  "壬": { english: "Yang Water", element: "water" }, "癸": { english: "Yin Water", element: "water" },
};

export const BRANCHES = {
  "子": { english: "Rat", element: "water" }, "丑": { english: "Ox", element: "earth" },
  "寅": { english: "Tiger", element: "wood" }, "卯": { english: "Rabbit", element: "wood" },
  "辰": { english: "Dragon", element: "earth" }, "巳": { english: "Snake", element: "fire" },
  "午": { english: "Horse", element: "fire" }, "未": { english: "Goat", element: "earth" },
  "申": { english: "Monkey", element: "metal" }, "酉": { english: "Rooster", element: "metal" },
  "戌": { english: "Dog", element: "earth" }, "亥": { english: "Pig", element: "water" },
};

// Ten gods (십신): Korean label → { key, english, gloss }. `gloss` = what the day's relation invites for reflection.
export const TEN_GODS = {
  "비견": { key: "companion", english: "Companion", gloss: "peers and self-reliance — where do you stand on your own today?" },
  "겁재": { key: "rob_wealth", english: "Rival", gloss: "competition and sharing — what are you holding too tightly?" },
  "식신": { key: "eating_god", english: "Creative Output", gloss: "ease and expression — what would you make if nobody graded it?" },
  "상관": { key: "hurting_officer", english: "Sharp Output", gloss: "candor and friction — what needs saying, and how?" },
  "편재": { key: "indirect_wealth", english: "Roaming Wealth", gloss: "opportunity and social flow — what came to you unplanned?" },
  "정재": { key: "direct_wealth", english: "Steady Wealth", gloss: "careful tending — what small thing deserves maintenance?" },
  "편관": { key: "seven_killings", english: "Pressure", gloss: "demand and discipline — what pushed on you, and what held?" },
  "정관": { key: "direct_officer", english: "Order", gloss: "rules and reputation — where did you keep your word?" },
  "편인": { key: "indirect_seal", english: "Unconventional Support", gloss: "intuition and withdrawal — what did you learn sideways?" },
  "정인": { key: "direct_seal", english: "Nurturing Support", gloss: "being cared for — who or what supported you today?" },
};

export const SOLAR_TERMS = {
  "소한": "Minor Cold", "대한": "Major Cold", "입춘": "Beginning of Spring", "우수": "Rain Water",
  "경칩": "Awakening of Insects", "춘분": "Spring Equinox", "청명": "Pure Brightness", "곡우": "Grain Rain",
  "입하": "Beginning of Summer", "소만": "Grain Buds", "망종": "Grain in Ear", "하지": "Summer Solstice",
  "소서": "Minor Heat", "대서": "Major Heat", "입추": "Beginning of Autumn", "처서": "End of Heat",
  "백로": "White Dew", "추분": "Autumn Equinox", "한로": "Cold Dew", "상강": "Frost Descent",
  "입동": "Beginning of Winter", "소설": "Minor Snow", "대설": "Major Snow", "동지": "Winter Solstice",
};

export const STRENGTH_LEVELS = {
  "극약": "extremely weak", "태약": "very weak", "신약": "weak", "중화신약": "balanced, leaning weak",
  "중화": "balanced", "중화신강": "balanced, leaning strong", "신강": "strong", "태강": "very strong", "극왕": "extremely strong",
};

export const ELEMENTS = ["wood", "fire", "earth", "metal", "water"];

/** "丁巳" → { hanja, english: "Yin Fire Snake", stem_element, branch_element } */
export function glossPillar(hanja) {
  const h = String(hanja || "");
  const s = STEMS[h[0]], b = BRANCHES[h[1]];
  return {
    hanja: h,
    english: s && b ? `${s.english} ${b.english}` : h,
    stem_element: s ? s.element : null,
    branch_element: b ? b.element : null,
  };
}

export function glossTenGod(korean, meaningFromEngine) {
  const g = TEN_GODS[korean];
  if (!g) return { key: "unknown", english: String(korean || ""), gloss: meaningFromEngine || "" };
  return { ...g, engine_meaning: meaningFromEngine || undefined };
}

export const glossSolarTerm = (korean) => SOLAR_TERMS[korean] || String(korean || "");
export const glossStrength = (korean) => STRENGTH_LEVELS[korean] || String(korean || "");
