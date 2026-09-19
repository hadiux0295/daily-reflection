// Client for the saju backend's service endpoint (POST /api/reflection/lens) + mapping to the tool-2 shape.
// The engine stays private; this file only knows the wire format. `fetch` is injectable for tests.
import { glossPillar, glossTenGod, glossSolarTerm, glossStrength, ELEMENTS } from "./glossary.js";

export function lensConfigured(env = process.env) {
  return Boolean(env.SAJU_LENS_URL && env.REFLECTION_SERVICE_KEY);
}

export function makeLensClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  return {
    configured: lensConfigured(env),
    async fetchLens(birth, { date, tz }) {
      if (!lensConfigured(env)) return { ok: false, error: "lens_unavailable", detail: "SAJU_LENS_URL / REFLECTION_SERVICE_KEY not set" };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetchImpl(env.SAJU_LENS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Service-Key": env.REFLECTION_SERVICE_KEY },
          body: JSON.stringify({ birth, date, tz }),
          signal: ctrl.signal,
        });
        if (!res.ok) return { ok: false, error: "lens_upstream_error", status: res.status };
        return { ok: true, raw: await res.json() };
      } catch (e) {
        return { ok: false, error: "lens_unreachable", detail: String(e && e.message || e) };
      } finally { clearTimeout(timer); }
    },
  };
}

/** Map the endpoint's raw JSON to DESIGN §2 tool-2 output (English-glossed data only). */
export function mapLens(raw) {
  const L = raw.lens || {};
  const today = L.today || {};
  const day = glossPillar(today.dayPillar && today.dayPillar.hanja);
  const relation = glossTenGod(today.tenGod, today.tenGodMeaning);
  const dm = L.dayMaster || {};
  const lacking = L.lackingElement || {};
  const pillars = L.pillars || {};
  const counts = Object.fromEntries(ELEMENTS.map((e) => [e, 0]));
  for (const p of Object.values(pillars)) {
    const g = glossPillar(p && p.hanja);
    if (g.stem_element) counts[g.stem_element] += 1;
    if (g.branch_element) counts[g.branch_element] += 1;
  }
  return {
    date: raw.date,
    day_pillar: { hanja: day.hanja, english: day.english, element: day.stem_element },
    day_relation: { key: relation.key, english: relation.english, gloss: relation.gloss },
    day_master: { hanja: dm.hanja || "", element: dm.element || null, strength: glossStrength(L.strength && L.strength.level) },
    element_balance: { counts, lacking: lacking.primary || null, lacking_secondary: lacking.secondary || null },
    solar_term: { korean: today.solarTerm || "", english: glossSolarTerm(today.solarTerm), days_since: today.daysSinceTerm ?? null },
    focus: {
      theme: relation.english.toLowerCase(),
      one_line: relation.gloss,
    },
  };
}
