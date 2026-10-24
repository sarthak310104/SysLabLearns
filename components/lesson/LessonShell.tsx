"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Lab, type GoalUpdate } from "@/components/lab/Lab";
import { lessonBySlug } from "@/content/curriculum";
import { loadCompletedGoals, markGoalComplete, resetLessonProgress } from "@/lib/progress";
import { LessonContext } from "./LessonContext";

export function LessonShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const found = lessonBySlug(slug)!;
  const { lesson, prev, next } = found;
  const preset = lesson.preset;
  const [status, setStatus] = useState<Record<string, GoalUpdate>>({});
  const [loaded, setLoaded] = useState(false);
  const [labKey, setLabKey] = useState(0);

  useEffect(() => {
    loadCompletedGoals().then((ids) => {
      const s: Record<string, GoalUpdate> = {};
      for (const g of preset.goals) if (ids.has(`${slug}/${g.id}`)) s[g.id] = { fraction: 1, done: true };
      setStatus(s);
      setLoaded(true);
    });
  }, [slug, preset]);

  const completed = useMemo(
    () => new Set(Object.entries(status).filter(([, v]) => v.done).map(([k]) => k)),
    // Only the initial set matters to the lab; later completions are tracked there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, labKey],
  );

  const onGoalUpdate = useCallback(
    (goalId: string, u: GoalUpdate) => {
      setStatus((prev) => (prev[goalId]?.done ? prev : { ...prev, [goalId]: u }));
      if (u.done) markGoalComplete(slug, goalId);
    },
    [slug],
  );

  const ctx = useMemo(() => ({ slug, goals: preset.goals, status }), [slug, preset, status]);

  return (
    <LessonContext.Provider value={ctx}>
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <article className="lg:w-[44%] lg:max-w-[720px] lg:overflow-y-auto lg:h-[calc(100dvh-3rem)] px-6 sm:px-10 py-8 border-b lg:border-b-0 lg:border-r border-line">
          <Link href="/" className="text-[13px] text-muted hover:text-text">
            Back to roadmap
          </Link>
          <header className="mt-6 mb-8 prose-lab">
            <p className="num text-signal text-[13px] mb-1">{lesson.code}</p>
            <h1 className="text-[1.9rem] leading-tight font-semibold tracking-tight">{lesson.title}</h1>
            <p className="text-muted mt-2">{lesson.breaks}</p>
          </header>
          <div className="prose-lab">{children}</div>
          <div className="prose-lab mt-10 pt-6 border-t border-line flex justify-between gap-4 text-[14px]">
            {prev ? (
              <Link href={`/learn/${prev.slug}/`} className="hover:text-accent">
                <span className="block text-muted text-[12px]">Previous</span>
                {prev.code} {prev.title}
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link href={`/learn/${next.slug}/`} className="text-right hover:text-accent">
                <span className="block text-muted text-[12px]">Next</span>
                {next.code} {next.title}
              </Link>
            ) : (
              <Link href="/sandbox/" className="text-right hover:text-accent">
                <span className="block text-muted text-[12px]">Next</span>
                Free play in the sandbox
              </Link>
            )}
          </div>
          <button
            className="mt-6 text-[12px] text-muted hover:text-crit"
            onClick={async () => {
              await resetLessonProgress(slug);
              setStatus({});
              setLabKey((k) => k + 1);
            }}
          >
            Reset my progress on this lesson
          </button>
        </article>
        <section className="flex-1 flex flex-col min-h-[640px] lg:h-[calc(100dvh-3rem)] lg:sticky lg:top-0" aria-label="Lab">
          {loaded && (
            <Lab
              key={labKey}
              graph={preset.graph}
              palette={preset.palette}
              layout="compact"
              goals={preset.goals}
              completedGoals={completed}
              onGoalUpdate={onGoalUpdate}
            />
          )}
        </section>
      </div>
    </LessonContext.Provider>
  );
}
