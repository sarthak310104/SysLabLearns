"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lab, type GoalUpdate } from "@/components/lab/Lab";
import { Goals } from "@/components/lesson/Goals";
import { LessonContext } from "@/components/lesson/LessonContext";
import { challengeBySlug } from "@/content/challenges";
import type { Graph, Snapshot } from "@/engine/model/types";
import { fmtDollars, monthlyCost } from "@/lib/cost";
import { loadCompletedGoals, markGoalComplete, resetLessonProgress } from "@/lib/progress";

/** A design challenge: the brief and live requirements on the left, an empty lab on the right. */
export function ChallengeShell({ slug }: { slug: string }) {
  const ch = challengeBySlug(slug)!;
  const [status, setStatus] = useState<Record<string, GoalUpdate>>({});
  const [loaded, setLoaded] = useState(false);
  const [labKey, setLabKey] = useState(0);
  const [hintsShown, setHintsShown] = useState(0);
  const [live, setLive] = useState<{ met: Record<string, boolean>; cost: number; running: boolean }>({ met: {}, cost: monthlyCost(ch.graph).total, running: false });
  const lastUpdate = useRef(0);

  useEffect(() => {
    loadCompletedGoals().then((ids) => {
      const s: Record<string, GoalUpdate> = {};
      for (const g of ch.goals) if (ids.has(`${slug}/${g.id}`)) s[g.id] = { fraction: 1, done: true };
      setStatus(s);
      setLoaded(true);
    });
  }, [slug, ch]);

  const completed = useMemo(
    () => new Set(Object.entries(status).filter(([, v]) => v.done).map(([k]) => k)),
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

  // Live requirement checks, a few times a second rather than on every snapshot.
  const onSnapshot = useCallback(
    (snap: Snapshot, graph: Graph) => {
      if (snap.time - lastUpdate.current < 300 && snap.time >= lastUpdate.current) return;
      lastUpdate.current = snap.time;
      const met = Object.fromEntries(ch.requirements.map((r) => [r.id, r.check(snap, graph)]));
      const running = Object.values(snap.nodes).some((n) => n.kind === "client" && n.okPerSec + n.errorsPerSec > 0);
      setLive({ met, cost: monthlyCost(graph, snap).total, running });
    },
    [ch],
  );
  const onGraphChange = useCallback((g: Graph) => setLive((l) => ({ ...l, cost: monthlyCost(g).total })), []);

  const ctx = useMemo(() => ({ slug, goals: ch.goals, status }), [slug, ch, status]);
  const overBudget = live.cost > ch.budget;

  return (
    <LessonContext.Provider value={ctx}>
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <article className="lg:w-[40%] lg:max-w-[640px] lg:overflow-y-auto lg:h-[calc(100dvh-3rem)] px-6 sm:px-9 py-8 border-b lg:border-b-0 lg:border-r border-line">
          <Link href="/" className="text-[13px] text-muted hover:text-text">
            Back to roadmap
          </Link>
          <header className="mt-6 mb-6 prose-lab">
            <p className="num text-signal text-[13px] mb-1">Design challenge {ch.code}</p>
            <h1 className="text-[1.9rem] leading-tight font-semibold tracking-tight">{ch.title}</h1>
          </header>
          <div className="prose-lab">
            {ch.brief.map((p) => (
              <p key={p}>{p}</p>
            ))}
            <p className="text-muted text-[14px]">You start with only the users. Every component is available; each one has a monthly cost.</p>
          </div>

          <section className="my-6 rounded-lg border border-line bg-panel" aria-label="Requirements">
            <div className="flex items-baseline justify-between px-4 pt-3 pb-2">
              <h2 className="font-semibold">Requirements</h2>
              <span className="text-[12px] text-muted">{live.running ? "Checked live" : "Send traffic to check"}</span>
            </div>
            <ul className="divide-y divide-line border-t border-line">
              {ch.requirements.map((r) => {
                const ok = live.running && live.met[r.id];
                return (
                  <li key={r.id} className="px-4 py-2.5 flex items-center gap-3 text-[14px]">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: !live.running ? "var(--line)" : ok ? "var(--signal)" : "var(--crit)" }}
                      aria-hidden="true"
                    />
                    <span className="flex-1">{r.text}</span>
                    <span className="text-[12px] text-muted">{!live.running ? "Waiting" : ok ? "Met" : "Not met"}</span>
                  </li>
                );
              })}
            </ul>
            <div className="px-4 py-3 border-t border-line flex items-baseline justify-between">
              <span className="text-[13px] text-muted">Your design costs</span>
              <span className="num text-[1.2rem]" style={{ color: overBudget ? "var(--crit)" : "var(--text)" }}>
                {fmtDollars(live.cost)} <span className="text-[13px] text-muted">of {fmtDollars(ch.budget)} a month</span>
              </span>
            </div>
          </section>

          <div className="prose-lab">
            <Goals />
          </div>

          <section className="my-6" aria-label="Hints">
            <h2 className="font-semibold mb-2">Stuck?</h2>
            <ol className="space-y-2 text-[14px]">
              {ch.hints.slice(0, hintsShown).map((h, i) => (
                <li key={h} className="flex gap-2.5">
                  <span className="num text-muted">{i + 1}.</span>
                  <span>{h}</span>
                </li>
              ))}
            </ol>
            {hintsShown < ch.hints.length && (
              <button className="text-[13px] text-accent mt-2" onClick={() => setHintsShown((n) => n + 1)}>
                {hintsShown === 0 ? "Show a hint" : "Show another hint"}
              </button>
            )}
          </section>

          <button
            className="mt-2 text-[12px] text-muted hover:text-crit"
            onClick={async () => {
              await resetLessonProgress(slug);
              setStatus({});
              setLabKey((k) => k + 1);
            }}
          >
            Start this challenge over
          </button>
        </article>
        <section className="flex-1 flex flex-col min-h-[640px] lg:h-[calc(100dvh-3rem)]" aria-label="Lab">
          {loaded && (
            <Lab
              key={labKey}
              graph={ch.graph}
              palette={ch.palette}
              layout="compact"
              goals={ch.goals}
              completedGoals={completed}
              onGoalUpdate={onGoalUpdate}
              onGraphChange={onGraphChange}
              onSnapshot={onSnapshot}
            />
          )}
        </section>
      </div>
    </LessonContext.Provider>
  );
}
