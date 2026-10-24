"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { GoalUpdate } from "@/components/lab/Lab";
import { LessonContext } from "@/components/lesson/LessonContext";
import { awsLessonBySlug } from "@/content/curriculum";
import { loadCompletedGoals, markGoalComplete, resetLessonProgress } from "@/lib/progress";
import { useAwsLab } from "@/lib/useAwsLab";
import { AwsWorkbench } from "./AwsWorkbench";

/** An AWS lesson: reading on the left, a terminal on a practice account on the right. Steps tick off from what's really in the account. */
export function AwsShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const { lesson, prev, next } = awsLessonBySlug(slug)!;
  const def = lesson.awsLab;
  const lab = useAwsLab();
  const [status, setStatus] = useState<Record<string, GoalUpdate>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadCompletedGoals().then((ids) => {
      const s: Record<string, GoalUpdate> = {};
      for (const st of def.steps) if (ids.has(`${slug}/${st.id}`)) s[st.id] = { fraction: 1, done: true };
      setStatus(s);
      setLoaded(true);
    });
  }, [slug, def]);

  // After every command (and background event), see which steps are now done.
  useEffect(() => {
    if (!loaded || !lab.state) return;
    const newly: string[] = [];
    for (const st of def.steps) {
      if (status[st.id]?.done) continue;
      try {
        if (st.done(lab.state, lab.history)) newly.push(st.id);
      } catch {}
    }
    if (!newly.length) return;
    setStatus((s) => ({ ...s, ...Object.fromEntries(newly.map((id) => [id, { fraction: 1, done: true }])) }));
    for (const id of newly) markGoalComplete(slug, id);
  }, [lab.state, lab.history, loaded, def, slug, status]);

  const goals = useMemo(() => def.steps.map((st) => ({ id: st.id, text: st.text, hint: st.hint, hints: st.hints })), [def]);
  const ctx = useMemo(() => ({ slug, goals, status }), [slug, goals, status]);

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
            Reset my step progress on this lesson
          </button>
        </article>
        <section className="flex-1 flex flex-col min-h-[760px] lg:min-h-0 lg:h-[calc(100dvh-3rem)] lg:sticky lg:top-0" aria-label="Practice AWS account">
          <AwsWorkbench lab={lab} />
        </section>
      </div>
    </LessonContext.Provider>
  );
}
