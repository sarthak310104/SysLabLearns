"use client";

import { useState } from "react";
import { useLesson } from "./LessonContext";

/** The lesson's goals, ticking off live as the lab meets them. */
export function Goals() {
  const lesson = useLesson();
  const [openHint, setOpenHint] = useState<string | null>(null);
  const [level, setLevel] = useState<Record<string, number>>({});
  if (!lesson) return null;
  const doneCount = lesson.goals.filter((g) => lesson.status[g.id]?.done).length;

  return (
    <section className="my-6 rounded-lg border border-line bg-panel" aria-label="Goals">
      <div className="flex items-baseline justify-between px-4 pt-3 pb-2">
        <h2 className="font-semibold">Try it in the lab</h2>
        <span className="num text-[13px] text-muted">
          {doneCount} of {lesson.goals.length} done
        </span>
      </div>
      <ol className="divide-y divide-line border-t border-line">
        {lesson.goals.map((g) => {
          const st = lesson.status[g.id];
          const done = st?.done;
          const holding = !done && (st?.fraction ?? 0) > 0;
          return (
            <li key={g.id} className="px-4 py-3 flex gap-3">
              <span
                className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 grid place-items-center"
                style={{ borderColor: done ? "var(--signal)" : holding ? "var(--accent)" : "var(--line)", background: done ? "var(--signal)" : undefined }}
                aria-label={done ? "Done" : holding ? "In progress" : "Not done"}
              >
                {done && (
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M2.5 6.5 5 9l4.5-6" stroke="var(--bg)" strokeWidth="2" fill="none" strokeLinecap="round" />
                  </svg>
                )}
              </span>
              <div className="flex-1 min-w-0">
                <p className={done ? "text-muted" : ""}>{g.text}</p>
                {holding && (
                  <div className="mt-2 h-1 rounded-full bg-panel-2 overflow-hidden">
                    <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round((st?.fraction ?? 0) * 100)}%` }} />
                  </div>
                )}
                {holding && <p className="text-[12px] text-muted mt-1">Holding steady. Keep it there.</p>}
                {g.hints && g.hints.length > 0 && !done && <HintLadder hints={g.hints} shown={level[g.id] ?? 0} onMore={() => setLevel((l) => ({ ...l, [g.id]: (l[g.id] ?? 0) + 1 }))} />}
                {g.hint && !g.hints && !done && (
                  <>
                    <button
                      className="text-[13px] text-accent mt-1"
                      aria-expanded={openHint === g.id}
                      onClick={() => setOpenHint(openHint === g.id ? null : g.id)}
                    >
                      {openHint === g.id ? "Hide hint" : "Show a hint"}
                    </button>
                    {openHint === g.id && <p className="text-[13px] text-muted mt-1">{g.hint}</p>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const RUNG = ["Nudge", "Direction", "Nearly the answer"];

/** Hints one rung at a time, so you take only as much help as you need. */
function HintLadder({ hints, shown, onMore }: { hints: string[]; shown: number; onMore: () => void }) {
  const next = shown === 0 ? "Show a hint" : shown === hints.length - 1 ? "Show nearly the answer" : "A more direct hint";
  return (
    <div className="mt-1">
      {shown > 0 && (
        <ol className="mt-1 space-y-2">
          {hints.slice(0, shown).map((h, i) => (
            <li key={i} className="text-[13px]">
              <span className="text-[11px] uppercase tracking-wide text-muted">{RUNG[i] ?? `Hint ${i + 1}`}</span>
              {h.includes("\n") || (i === hints.length - 1 && /[;{]/.test(h)) ? (
                <pre className={`mt-1 rounded-md border border-line bg-bg px-3 py-2 text-[12px] font-mono overflow-x-auto ${h.includes("\n") ? "whitespace-pre" : "whitespace-pre-wrap"}`}>{h}</pre>
              ) : (
                <p className="text-muted mt-0.5">{h}</p>
              )}
            </li>
          ))}
        </ol>
      )}
      {shown < hints.length && (
        <button className="text-[13px] text-accent mt-1" onClick={onMore}>
          {next}
          {shown > 0 && <span className="text-muted"> ({shown + 1} of {hints.length})</span>}
        </button>
      )}
    </div>
  );
}
