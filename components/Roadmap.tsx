"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TRACKS, type Module } from "@/content/curriculum";
import { loadCompletedGoals, loadQuizScores } from "@/lib/progress";

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <span className="flex items-center gap-1" aria-label={`${done} of ${total} goals done`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="h-1.5 w-4 rounded-full" style={{ background: i < done ? "var(--signal)" : "var(--line)" }} />
      ))}
    </span>
  );
}

type Scores = Record<string, { best: number; total: number }>;

function ModuleRow({ m, completed, isNext, scores }: { m: Module; completed: Set<string>; isNext: boolean; scores: Scores }) {
  const quiz = m.slug ? scores[m.slug] : undefined;
  const body = (
    <>
      <span className={`num text-[13px] w-7 shrink-0 pt-0.5 ${m.slug ? "text-signal" : "text-muted"}`}>{m.code}</span>
      <span className="flex-1 min-w-0">
        <span className={`block font-medium ${m.slug ? "" : "text-muted"}`}>{m.title}</span>
        <span className="block text-[13px] text-muted mt-0.5">{m.breaks}</span>
      </span>
      <span className="shrink-0 pt-1 text-[12px] text-muted">
        {m.preset && m.slug ? (
          <span className="flex flex-col items-end gap-1">
            <Progress done={m.preset.goals.filter((g) => completed.has(`${m.slug}/${g.id}`)).length} total={m.preset.goals.length} />
            {quiz && (
              <span className="num">
                Quiz {quiz.best}/{quiz.total}
              </span>
            )}
          </span>
        ) : (
          m.comingIn
        )}
      </span>
    </>
  );
  if (!m.slug) return <li className="flex gap-3 px-4 py-3">{body}</li>;
  return (
    <li>
      <Link
        href={`/learn/${m.slug}/`}
        className={`flex gap-3 px-4 py-3 hover:bg-panel-2 ${isNext ? "bg-panel-2/70 shadow-[inset_3px_0_0_var(--accent)]" : ""}`}
      >
        {body}
      </Link>
    </li>
  );
}

export function Roadmap() {
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [scores, setScores] = useState<Scores>({});
  useEffect(() => {
    loadCompletedGoals().then(setCompleted);
    loadQuizScores().then(setScores);
  }, []);

  const firstUnfinished = TRACKS.flatMap((t) => t.modules).find(
    (m) => m.slug && m.preset && m.preset.goals.some((g) => !completed.has(`${m.slug}/${g.id}`)),
  );

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      {TRACKS.map((t) => (
        <section key={t.id} aria-labelledby={`track-${t.id}`}>
          <h2 id={`track-${t.id}`} className="text-xl font-semibold tracking-tight">
            {t.title}
          </h2>
          <p className="text-muted mt-1 mb-4 max-w-[60ch]">{t.blurb}</p>
          <ol className="rounded-lg border border-line bg-panel divide-y divide-line overflow-hidden">
            {t.modules.map((m) => (
              <ModuleRow key={m.code} m={m} completed={completed} scores={scores} isNext={m === firstUnfinished} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
