"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { QUIZZES } from "@/content/quizzes";
import { CHALLENGES } from "@/content/challenges";
import { TRACKS, moduleGoalIds } from "@/content/curriculum";
import { loadActivity, loadCards, loadCompletedGoals, today, type ActivityRow, type CardRow } from "@/lib/progress";
import { badges, shiftDay, streak, totals, weakest } from "@/lib/stats";

const hours = (m: number) => (m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`);

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="num text-[1.6rem] leading-tight">{value}</div>
      <div className="text-[13px]">{label}</div>
      {sub && <div className="text-[12px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

/** The last 12 weeks, one square per day, darker for more active minutes. */
function Calendar({ rows, todayStr }: { rows: ActivityRow[]; todayStr: string }) {
  const by = new Map(rows.map((r) => [r.day, r]));
  const [y, m, d] = todayStr.split("-").map(Number);
  const dow = (new Date(y, m - 1, d).getDay() + 6) % 7; // Monday = 0
  const cells = Array.from({ length: 12 * 7 }, (_, i) => shiftDay(todayStr, 11 * 7 + dow - i));
  const level = (r?: ActivityRow) => {
    if (!r) return 0;
    const v = r.minutes + r.answers + r.goals * 3;
    return v === 0 ? 0 : v < 10 ? 1 : v < 30 ? 2 : v < 60 ? 3 : 4;
  };
  const shade = ["var(--line)", "20%", "45%", "70%", "100%"];
  return (
    <div>
      <div className="grid grid-flow-col grid-rows-7 gap-[3px] w-fit" role="img" aria-label="Activity over the last 12 weeks">
        {cells.map((day) => {
          const future = day > todayStr;
          const l = level(by.get(day));
          const r = by.get(day);
          return (
            <span
              key={day}
              title={future ? "" : `${day}: ${r ? `${r.minutes} min, ${r.answers} answers, ${r.goals} goals` : "nothing"}`}
              className="block h-[14px] w-[14px] sm:h-[15px] sm:w-[15px] rounded-[3px]"
              style={{
                background: future ? "transparent" : l === 0 ? shade[0] : `color-mix(in srgb, var(--accent) ${shade[l]}, var(--panel-2))`,
                outline: day === todayStr ? "1px solid var(--text)" : undefined,
              }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted mt-2">
        Less
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className="h-[10px] w-[10px] rounded-[2px]" style={{ background: l === 0 ? shade[0] : `color-mix(in srgb, var(--accent) ${shade[l]}, var(--panel-2))` }} />
        ))}
        More
      </div>
    </div>
  );
}

export function ProgressView() {
  const [data, setData] = useState<{ activity: ActivityRow[]; cards: CardRow[]; goals: Set<string> } | null>(null);
  useEffect(() => {
    Promise.all([loadActivity(), loadCards(), loadCompletedGoals()]).then(([activity, cards, goals]) => setData({ activity, cards, goals }));
  }, []);
  if (!data) return <p className="text-muted">Loading...</p>;

  const todayStr = today();
  const { activity, cards, goals } = data;
  const tracks = TRACKS.map((t) => {
    const mods = t.modules.filter((m) => m.slug && !m.comingIn);
    const per = mods.map((m) => {
      const ids = moduleGoalIds(m);
      const done = ids.filter((id) => goals.has(`${m.slug}/${id}`)).length;
      return { m, done, total: ids.length };
    });
    return {
      id: t.id,
      title: t.title,
      per,
      done: per.filter((p) => p.total > 0 && p.done >= p.total).length,
      total: per.length,
      next: per.find((p) => p.done < p.total)?.m,
    };
  });
  const challenges = {
    passed: CHALLENGES.filter((c) => goals.has(`${c.slug}/pass`)).length,
    resilient: CHALLENGES.filter((c) => goals.has(`${c.slug}/resilient`)).length,
    total: CHALLENGES.length,
  };
  const t = totals(activity, todayStr);
  const st = streak(activity, todayStr);
  const bs = badges({ activity, cards, tracks, challenges, goalsDone: goals.size, today: todayStr });
  const weak = weakest(cards).filter((c) => QUIZZES[c.lesson]?.[c.index]);
  const allLessons = TRACKS.flatMap((x) => x.modules);
  const activeToday = activity.some((a) => a.day === todayStr && (a.minutes || a.answers || a.goals));

  return (
    <div className="space-y-9">
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3" aria-label="Summary">
        <Stat value={`${st.current}`} label="day streak" sub={st.current && !activeToday ? "Do something today to keep it" : `Best: ${st.best}`} />
        <Stat value={hours(t.minutes)} label="active time" sub={`${hours(t.weekMinutes)} this week`} />
        <Stat value={t.accuracy === null ? "-" : `${Math.round(t.accuracy * 100)}%`} label="quiz accuracy" sub={`${t.answers} answer${t.answers === 1 ? "" : "s"}`} />
        <Stat value={`${goals.size}`} label="goals done" sub={`${challenges.passed} of ${challenges.total} challenges passed`} />
      </section>

      <section aria-label="Activity">
        <h2 className="font-semibold mb-3">Last 12 weeks</h2>
        <Calendar rows={activity} todayStr={todayStr} />
        <p className="text-[12px] text-muted mt-2">Time counts only while you're clicking, typing or scrolling here, so an open tab doesn't add up.</p>
      </section>

      <section aria-label="Tracks">
        <h2 className="font-semibold mb-3">Tracks</h2>
        <ul className="space-y-4">
          {tracks.map((tr) => (
            <li key={tr.id} className="rounded-lg border border-line bg-panel px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{tr.title}</span>
                <span className="num text-[13px] text-muted">
                  {tr.done} of {tr.total} lessons
                </span>
              </div>
              <div className="flex gap-[3px] mt-2.5" aria-hidden="true">
                {tr.per.map((p) => (
                  <span
                    key={p.m.code}
                    title={`${p.m.code} ${p.m.title}: ${p.done} of ${p.total}`}
                    className="h-2 flex-1 rounded-full"
                    style={{ background: p.done >= p.total && p.total ? "var(--signal)" : p.done ? "color-mix(in srgb, var(--signal) 40%, var(--line))" : "var(--line)" }}
                  />
                ))}
              </div>
              {tr.next ? (
                <Link href={`/learn/${tr.next.slug}/`} className="inline-block text-[13px] text-accent mt-2.5 hover:underline">
                  Next: {tr.next.code} {tr.next.title}
                </Link>
              ) : (
                <p className="text-[13px] mt-2.5" style={{ color: "var(--signal)" }}>
                  Track complete.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {weak.length > 0 && (
        <section aria-label="Questions you miss most">
          <h2 className="font-semibold mb-1">Questions you miss most</h2>
          <p className="text-[13px] text-muted mb-3">
            These come back in <Link href="/review/" className="text-accent hover:underline">Review</Link> until they stick.
          </p>
          <ul className="divide-y divide-line border-y border-line text-[14px]">
            {weak.map((c) => {
              const l = allLessons.find((m) => m.slug === c.lesson);
              return (
                <li key={c.id} className="py-2.5 flex gap-3">
                  <span className="num text-signal text-[13px] w-8 shrink-0">{l?.code}</span>
                  <span className="flex-1">{QUIZZES[c.lesson][c.index].q}</span>
                  <span className="num text-[12px] text-muted shrink-0">missed {c.lapses}x</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-label="Badges">
        <h2 className="font-semibold mb-3">
          Badges <span className="num text-[13px] text-muted font-normal">{bs.filter((b) => b.earned).length} of {bs.length}</span>
        </h2>
        <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {bs.map((b) => (
            <li
              key={b.id}
              className={`rounded-lg border px-3 py-2.5 ${b.earned ? "border-accent bg-panel neon" : "border-line bg-panel opacity-60"}`}
            >
              <div className="text-[14px] font-medium flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: b.earned ? "var(--accent)" : "var(--line)" }} />
                {b.title}
                <span className="sr-only">{b.earned ? "(earned)" : "(not yet)"}</span>
              </div>
              <div className="text-[12px] text-muted mt-0.5">{b.how}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
