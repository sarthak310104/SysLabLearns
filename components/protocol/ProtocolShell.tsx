"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { GoalUpdate } from "@/components/lab/Lab";
import { LessonContext } from "@/components/lesson/LessonContext";
import { protocolLessonBySlug } from "@/content/curriculum";
import { loadCompletedGoals, markGoalComplete, resetLessonProgress } from "@/lib/progress";
import { Workbench } from "./Workbench";

/** A protocol lesson: prose on the left, the code workbench on the right. Stages are the goals. */
export function ProtocolShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const { lesson, prev, next } = protocolLessonBySlug(slug)!;
  const lab = lesson.lab;
  const [status, setStatus] = useState<Record<string, GoalUpdate>>({});

  useEffect(() => {
    loadCompletedGoals().then((ids) => {
      const s: Record<string, GoalUpdate> = {};
      for (const st of lab.stages) if (ids.has(`${slug}/${st.id}`)) s[st.id] = { fraction: 1, done: true };
      setStatus(s);
    });
  }, [slug, lab]);

  const onStagePassed = useCallback(
    (stage: string) => {
      setStatus((s) => ({ ...s, [stage]: { fraction: 1, done: true } }));
      markGoalComplete(slug, stage);
    },
    [slug],
  );

  const goals = useMemo(() => lab.stages.map((st, i) => ({ id: st.id, text: `Stage ${i + 1}, ${st.title}: ${st.blurb}`, hint: st.hint })), [lab]);
  const ctx = useMemo(() => ({ slug, goals, status }), [slug, goals, status]);
  const passed = useMemo(() => new Set(Object.entries(status).filter(([, v]) => v.done).map(([k]) => k)), [status]);

  return (
    <LessonContext.Provider value={ctx}>
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <article className="lg:w-[42%] lg:max-w-[700px] lg:overflow-y-auto lg:h-[calc(100dvh-3rem)] px-6 sm:px-10 py-8 border-b lg:border-b-0 lg:border-r border-line">
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
              <Link href="/" className="text-right hover:text-accent">
                <span className="block text-muted text-[12px]">Next</span>
                Back to the roadmap
              </Link>
            )}
          </div>
          <button
            className="mt-6 text-[12px] text-muted hover:text-crit"
            onClick={async () => {
              await resetLessonProgress(slug);
              setStatus({});
            }}
          >
            Reset my stage progress on this lesson
          </button>
        </article>
        <section className="flex-1 flex flex-col min-h-[720px] lg:h-[calc(100dvh-3rem)] lg:sticky lg:top-0" aria-label="Workbench">
          <Workbench lab={lab} passed={passed} onStagePassed={onStagePassed} />
        </section>
      </div>
    </LessonContext.Provider>
  );
}
