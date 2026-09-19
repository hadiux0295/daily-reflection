// 「오늘의 성찰」 카드 — 오늘 카드 아래, 하루 한 번 2분. 서버 = server/reflectionTurn.js (Nemotron on Nebius Token Factory).
// 상태 3단: 접힘(카드 + CTA) → 열림(관찰 + 근거 칩 + 질문 + 답 입력) → 답함(저장된 문답 + 마무리 한 줄 + 스트릭).
// 화면의 골드는 오늘 카드 하나뿐이라 여기는 .gl-g 계열의 조용한 면 위에 앉는다. 시그니처 = 근거 칩 한 줄:
// 모델이 실제로 받은 사실 목록(서버 provenance)이라 "지어낸 근거"가 화면에 나올 수 없다.
import { useEffect, useRef, useState } from "react";

const MOODS = ["low", "neutral", "high"];

// api = { fetchReflection, postReflectionAnswer } — 주입(SajuApp 이 api.js 를 넘긴다) → 카드는 Firebase 를 모른다(프리뷰·테스트 격리).
export default function ReflectionCard({ t, lang, birth, tz, todayKey, onAnswered, logEvent, api }) {
  const c = t.reflection;
  const [open, setOpen] = useState(false);
  const [turn, setTurn] = useState(null);   // server payload for today
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [text, setText] = useState("");
  const [mood, setMood] = useState(null);
  const [sending, setSending] = useState(false);
  const [hidden, setHidden] = useState(false); // 서버가 404(플래그 off)/실패 → 카드 자체를 그리지 않는다. 오류 문구를 첫 화면에 남기지 않는다.
  const areaRef = useRef(null);

  // 마운트·날짜 변경·birth 변경 시 미리 불러온다(서버는 uid+날짜 캐시라 재호출 비용 없음) — 열 때 기다리지 않는다.
  useEffect(() => {
    let alive = true;
    setTurn(null); setOpen(false); setHidden(false); setError(false); setLoading(true);
    api.fetchReflection(birth, lang, tz).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (!r?.question) { setHidden(true); return; }
      setTurn(r);
      if (r.answered) { setText(r.text || ""); setMood(r.mood || null); }
    });
    return () => { alive = false; };
  }, [todayKey, lang, birth?.year, birth?.month, birth?.day, birth?.hour, birth?.minute]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) { logEvent?.("reflection_open"); setTimeout(() => areaRef.current?.focus?.(), 250); }
  }

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const r = await api.postReflectionAnswer(body, mood, tz);
    setSending(false);
    if (!r?.saved) { setError(true); return; }
    setTurn((prev) => ({ ...prev, answered: true, text: body, mood, closing: r.closing, streak: r.streak, crisis_referral: r.crisis_referral }));
    logEvent?.("reflection_answer", { mood: mood || "none" });
    onAnswered?.(r.streak);
  }

  const streak = turn?.streak ?? 0;
  const streakLabel = streak > 0 ? c.streak.replace("{n}", String(streak)) : c.first;
  const answered = Boolean(turn?.answered);
  if (hidden || (loading && !turn)) return null;

  return (
    <section className={`gl-refl${open ? " open" : ""}${answered ? " done" : ""}`} aria-label={c.card}>
      <button className="gl-refl-head gl-tap" onClick={toggle} aria-expanded={open}>
        <span className="gl-eyebrow"><span>{c.card}</span></span>
        <span className="gl-refl-meta">
          {answered ? c.doneBadge : streakLabel}
          <span className={`gl-refl-chev${open ? " up" : ""}`} aria-hidden="true">⌄</span>
        </span>
      </button>
      {!open && !answered && <p className="gl-refl-hint">{c.hint}</p>}

      {open && (
        <div className="gl-refl-body">
          {turn && (
            <>
              <p className="gl-refl-obs">{turn.observation}</p>
              <ul className="gl-refl-chips" aria-label={c.chipsLabel}>
                <li className="lbl">{c.chipsLabel}</li>
                {(turn.provenance || []).map((p) => <li key={p.key}>{p.label}</li>)}
              </ul>
              <p className="gl-refl-q">{turn.question}</p>

              {!answered ? (
                <>
                  <textarea
                    ref={areaRef}
                    className="gl-refl-area"
                    rows={3}
                    maxLength={500}
                    placeholder={c.placeholder}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    disabled={sending}
                  />
                  <div className="gl-refl-row">
                    <div className="gl-refl-moods" role="radiogroup" aria-label={c.moodLabel}>
                      {MOODS.map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={mood === m}
                          className={`gl-refl-mood${mood === m ? " on" : ""}`}
                          onClick={() => setMood(mood === m ? null : m)}>{c.moods[m]}</button>
                      ))}
                    </div>
                    <button type="button" className="gl-refl-send gl-tap" onClick={send} disabled={!text.trim() || sending}>
                      {sending ? c.sending : c.send}
                    </button>
                  </div>
                  {error && <p className="gl-refl-wait">{c.error}</p>}
                  <p className="gl-refl-help">{c.helpline}</p>
                </>
              ) : (
                <div className="gl-refl-saved">
                  <p className="gl-refl-mine">{turn.text}{turn.mood ? <small> · {c.moods[turn.mood]}</small> : null}</p>
                  {turn.crisis_referral
                    ? <p className="gl-refl-crisis">{turn.crisis_referral}</p>
                    : turn.closing ? <p className="gl-refl-close">{turn.closing}</p> : null}
                  <p className="gl-refl-streak">{c.saved} · {streak > 0 ? c.streak.replace("{n}", String(streak)) : ""}</p>
                </div>
              )}
            </>
          )}
          <p className="gl-ai gl-refl-ai">{c.disclosure.replace("{model}", turn?.model || "NVIDIA Nemotron")}</p>
        </div>
      )}
    </section>
  );
}
