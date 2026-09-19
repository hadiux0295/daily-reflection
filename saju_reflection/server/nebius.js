// Nebius Token Factory client (OpenAI-compatible) — used only by 「오늘의 성찰」 (reflectionTurn.js).
// Hackathon: Nebius x NVIDIA Global AI 2026 (spec = docs/reflection_nemotron_spec.md §1).
//
// Measured 2026-09-18 on api.tokenfactory.nebius.com (lex-0709):
//   - OpenRouter-style `reasoning:{enabled:false}` and a `/no_think` system line are IGNORED.
//   - With thinking on, Nemotron 3 Super spends the whole max_tokens on reasoning → content null, finish=length.
//   - `chat_template_kwargs:{enable_thinking:false}` is what turns it off (258 tokens, 0 reasoning).
// The Gemini path (llm.js) is untouched; this module is the only place that knows the Nebius base.
export const NEBIUS_BASE = process.env.NEBIUS_API_BASE || "https://api.tokenfactory.nebius.com/v1";
export const NEBIUS_MODEL = process.env.NEBIUS_MODEL || "nvidia/nemotron-3-super-120b-a12b";
export const NEBIUS_MODEL_LABEL = process.env.NEBIUS_MODEL_LABEL || "NVIDIA Nemotron 3 Super";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

export function nebiusConfigured(env = process.env) {
  return env.REFLECTION_LLM === "nebius" && Boolean(env.NEBIUS_API_KEY);
}

/**
 * One non-streaming chat completion. Returns { content, usage, attempts } or throws after MAX_ATTEMPTS.
 * Retries on 429 / 5xx / network / empty content (a thinking leak shows up as empty content — retry once
 * is cheap, and the caller has a deterministic fallback anyway).
 */
export async function chatNemotron(messages, { maxTokens = 300, temperature = 0.7, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const key = env.NEBIUS_API_KEY;
  if (!key) throw new Error("nebius_unconfigured");
  const body = JSON.stringify({
    model: NEBIUS_MODEL,
    max_tokens: maxTokens,
    temperature,
    chat_template_kwargs: { enable_thinking: false },
    messages,
  });
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${NEBIUS_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`nebius_http_${res.status}`); continue; }
      if (!res.ok) throw new Error(`nebius_http_${res.status}`); // 4xx other than 429 = our bug, do not retry
      const data = await res.json();
      const content = String(data?.choices?.[0]?.message?.content || "").trim();
      if (!content) { lastErr = new Error("nebius_empty_content"); continue; }
      return { content, usage: data.usage || null, attempts: attempt };
    } catch (e) {
      if (String(e?.message || "").startsWith("nebius_http_4")) throw e;
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("nebius_failed");
}
