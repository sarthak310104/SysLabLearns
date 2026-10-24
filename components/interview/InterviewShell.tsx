"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Lab, type LabControl } from "@/components/lab/Lab";
import { followUpMs, followUpScenario, interviewBySlug, type Interview } from "@/content/interviews";
import type { Graph, Snapshot } from "@/engine/model/types";
import { fmtDollars, monthlyCost } from "@/lib/cost";
import { buildPicture } from "@/lib/exportDesign";
import { estimateOk, HOLD_MS, scoreInterview } from "@/lib/interviewScore";
import { saveDesign, saveInterviewResult } from "@/lib/progress";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Questions in a fixed but mixed order, so the important ones aren't simply listed first. */
function mixed<T extends { id: string }>(xs: T[]): T[] {
  const h = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return [...xs].sort((a, b) => h(a.id) - h(b.id));
}

function Step({ n, title, children, done }: { n: number; title: string; children: React.ReactNode; done?: boolean }) {
  return (
    <section className="my-6" aria-label={title}>
      <h2 className="font-semibold flex items-center gap-2.5 mb-2">
        <span className="num text-[12px] h-6 w-6 rounded-full grid place-items-center border" style={{ borderColor: done ? "var(--signal)" : "var(--line)", color: done ? "var(--signal)" : "var(--muted)" }}>
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function InterviewShell({ slug }: { slug: string }) {
  const [attempt, setAttempt] = useState(0);
  return <Session key={attempt} iv={interviewBySlug(slug)!} onRetry={() => setAttempt((a) => a + 1)} />;
}

function Session({ iv, onRetry }: { iv: Interview; onRetry: () => void }) {
  const router = useRouter();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [asked, setAsked] = useState<string[]>([]);
  const [est, setEst] = useState<Record<string, string>>({});
  const [estChecked, setEstChecked] = useState(false);
  const [live, setLive] = useState<{ met: Record<string, boolean>; cost: number; running: boolean; holdMs: number }>({ met: {}, cost: 0, running: false, holdMs: 0 });
  const [follow, setFollow] = useState<{ state: "idle" | "running" | "done"; progress: number; checks: number; held: number; problem?: string }>({ state: "idle", progress: 0, checks: 0, held: 0 });
  const [result, setResult] = useState<(ReturnType<typeof scoreInterview> & { graph: Graph; elapsed: number }) | null>(null);

  const control = useRef<LabControl | null>(null);
  const hold = useRef({ since: null as number | null, best: 0, last: 0 });
  const fu = useRef({ state: "idle" as "idle" | "running" | "done", startAt: null as number | null, length: 0, checks: 0, held: 0 });
  const latest = useRef<Graph>(iv.graph);
  const lastUpdate = useRef(0);

  useEffect(() => {
    if (!startedAt || result) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt, result]);
  const elapsed = startedAt ? now - startedAt : 0;
  const remaining = iv.minutes * 60000 - elapsed;

  const onSnapshot = useCallback(
    (snap: Snapshot, graph: Graph) => {
      latest.current = graph;
      const h = hold.current;
      if (snap.time < h.last) h.since = null; // the lab was reset
      h.last = snap.time;
      const met = Object.fromEntries(iv.requirements.map((r) => [r.id, r.check(snap, graph)]));
      const running = Object.values(snap.nodes).some((n) => n.kind === "client" && ((n.sendingRps ?? 0) > 0 || n.okPerSec + n.errorsPerSec > 0));
      const all = running && Object.values(met).every(Boolean);
      if (all) {
        h.since ??= snap.time;
        h.best = Math.max(h.best, snap.time - h.since);
      } else h.since = null;

      const f = fu.current;
      if (f.state === "running") {
        f.startAt ??= snap.time;
        if (snap.time - lastUpdate.current >= 300 || snap.time < lastUpdate.current) {
          f.checks++;
          if (iv.followUp.holds.check(snap, graph)) f.held++;
        }
        if (snap.time - f.startAt >= f.length) f.state = "done";
      }

      if (snap.time - lastUpdate.current < 300 && snap.time >= lastUpdate.current) return;
      lastUpdate.current = snap.time;
      setLive({ met, cost: monthlyCost(graph, snap).total, running, holdMs: h.since !== null ? snap.time - h.since : 0 });
      if (f.state !== "idle") setFollow((x) => ({ ...x, state: f.state, progress: f.startAt === null ? 0 : Math.min(1, (snap.time - f.startAt) / f.length), checks: f.checks, held: f.held }));
    },
    [iv],
  );
  const onGraphChange = useCallback((g: Graph) => {
    latest.current = g;
    setLive((l) => ({ ...l, cost: monthlyCost(g).total }));
  }, []);

  const startFollowUp = () => {
    const c = control.current;
    if (!c) return;
    const sc = followUpScenario(iv, c.graph);
    if (!sc.steps.length) {
      setFollow((x) => ({ ...x, problem: iv.followUp.scenario.id === "cache-wipe" ? "Your design has no cache to wipe. That's an answer too: press the button again once you've decided, or finish now." : "Your design has nothing this event can act on yet." }));
      return;
    }
    if (!c.playing) c.play();
    fu.current = { state: "running", startAt: null, length: followUpMs(sc), checks: 0, held: 0 };
    c.runScenario(sc);
    setFollow({ state: "running", progress: 0, checks: 0, held: 0 });
  };

  const finish = async () => {
    const f = fu.current;
    const estimates = Object.fromEntries(iv.estimates.map((e) => [e.id, est[e.id]?.trim() ? Number(est[e.id].replace(/,/g, "")) : null]));
    const score = scoreInterview(iv, {
      asked,
      estimates,
      bestHoldMs: hold.current.best,
      metAtEnd: live.running ? live.met : {},
      followUp: { ran: f.state !== "idle", checks: f.checks, held: f.held },
      elapsedMs: elapsed,
    });
    control.current?.pause();
    setResult({ ...score, graph: latest.current, elapsed });
    await saveInterviewResult({ slug: iv.slug, at: Date.now(), score: score.total, grade: score.grade, minutes: Math.round(elapsed / 60000) });
  };

  const compare = async () => {
    if (!result) return;
    const yours = `v-int-${iv.slug}-yours`;
    const theirs = `v-int-${iv.slug}-suggested`;
    await saveDesign(yours, `${iv.title} (yours)`, result.graph);
    await saveDesign(theirs, `${iv.title} (suggested)`, { nodes: [...iv.graph.nodes, ...iv.suggested.design.nodes], edges: iv.suggested.design.edges });
    router.push(`/compare/?a=${yours}&b=${theirs}`);
  };

  const questions = useMemo(() => mixed(iv.questions), [iv]);
  const suggestedPic = useMemo(() => {
    if (!result) return null;
    const pic = buildPicture({ name: `Suggested: ${iv.title}`, graph: { nodes: [...iv.graph.nodes, ...iv.suggested.design.nodes], edges: iv.suggested.design.edges }, snapshot: null });
    return URL.createObjectURL(new Blob([pic.animated], { type: "image/svg+xml" }));
  }, [result, iv]);
  useEffect(() => () => void (suggestedPic && URL.revokeObjectURL(suggestedPic)), [suggestedPic]);

  const intro = (
    <>
      <Link href="/interview/" className="text-[13px] text-muted hover:text-text">
        All interview questions
      </Link>
      <header className="mt-6 mb-4">
        <p className="num text-signal text-[13px] mb-1">Interview practice, {iv.minutes} minutes</p>
        <h1 className="text-[1.9rem] leading-tight font-semibold tracking-tight">{iv.title}</h1>
      </header>
      <blockquote className="border-l-2 border-accent pl-4 py-1 text-[15px]">
        <p className="text-[12px] text-muted mb-1">The interviewer says:</p>
        {iv.prompt}
      </blockquote>
    </>
  );

  let left: React.ReactNode;
  if (!startedAt) {
    left = (
      <>
        {intro}
        <div className="prose-lab mt-6 text-[15px]">
          <p>The prompt is vague on purpose. A real interview goes like this, and so does this one:</p>
          <ol>
            <li><strong>Clarify.</strong> Ask questions. The answers carry the numbers you have to design for, and the targets stay hidden until you ask.</li>
            <li><strong>Estimate.</strong> A couple of quick sums that tell you what size the design needs to be.</li>
            <li><strong>Build</strong> it in the lab and send traffic. Every target has to hold at once for {HOLD_MS / 1000} seconds.</li>
            <li><strong>Follow-up.</strong> The interviewer throws something at your running design.</li>
          </ol>
          <p>You get a scorecard and a suggested design at the end. The clock is a guide: going over costs a little, it doesn't stop you.</p>
        </div>
        <button className="mt-4 px-4 py-2 rounded-md bg-accent text-accent-ink font-medium neon" onClick={() => setStartedAt(Date.now())}>
          Start the clock
        </button>
      </>
    );
  } else if (result) {
    left = (
      <>
        {intro}
        <section className="my-6 rounded-lg border border-line bg-panel px-5 py-4" aria-label="Scorecard">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">{result.grade}</h2>
            <span className="num text-[1.6rem]">{result.total}<span className="text-[14px] text-muted"> / 100</span></span>
          </div>
          <p className="text-muted text-[14px] mt-1">{result.verdict}</p>
          <ul className="mt-4 divide-y divide-line border-t border-line">
            {result.lines.map((l) => (
              <li key={l.id} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-[14px]">{l.title}</span>
                  <span className="num text-[13px]" style={{ color: l.points === l.max ? "var(--signal)" : l.points === 0 ? "var(--crit)" : "var(--text)" }}>
                    {l.points} / {l.max}
                  </span>
                </div>
                <ul className="mt-1 space-y-1">
                  {l.notes.map((n) => (
                    <li key={n} className="text-[13px] text-muted">{n}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
        <section className="my-6" aria-label="Suggested design">
          <h2 className="font-semibold mb-2">One good answer</h2>
          {suggestedPic && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={suggestedPic} alt="The suggested design" className="w-full h-auto rounded-md border border-line" />
          )}
          <ul className="mt-3 space-y-2 text-[14px] list-disc pl-5">
            {iv.suggested.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="text-[13px] text-muted mt-2">It costs {fmtDollars(monthlyCost({ nodes: [...iv.graph.nodes, ...iv.suggested.design.nodes], edges: iv.suggested.design.edges }).total)} a month. Yours cost {fmtDollars(monthlyCost(result.graph).total)}.</p>
          <div className="flex flex-wrap gap-3 mt-4">
            <button className="px-3.5 py-1.5 rounded-md bg-accent text-accent-ink font-medium text-[14px]" onClick={compare}>
              Run yours against it
            </button>
            <button className="px-3.5 py-1.5 rounded-md border border-line hover:bg-panel-2 text-[14px]" onClick={onRetry}>
              Try again
            </button>
          </div>
        </section>
      </>
    );
  } else {
    const keyLeft = iv.questions.filter((q) => q.key && !asked.includes(q.id)).length;
    left = (
      <>
        {intro}
        <div className="sticky top-0 z-10 -mx-6 sm:-mx-9 px-6 sm:px-9 py-2 mt-4 bg-bg/90 backdrop-blur border-y border-line flex items-center gap-3 text-[13px]">
          <span className="num text-[1.1rem]" style={{ color: remaining < 0 ? "var(--crit)" : remaining < 5 * 60000 ? "var(--h-strained)" : "var(--text)" }}>
            {remaining < 0 ? `+${clock(-remaining)}` : clock(remaining)}
          </span>
          <span className="text-muted">{remaining < 0 ? "over time" : "left"}</span>
          <span className="flex-1" />
          <button className="px-3 py-1 rounded-md border border-line hover:bg-panel-2" onClick={finish}>
            End the interview
          </button>
        </div>

        <Step n={1} title="Ask clarifying questions" done={keyLeft === 0}>
          <ul className="space-y-1.5">
            {questions.map((q) => {
              const isAsked = asked.includes(q.id);
              return (
                <li key={q.id} className="text-[14px]">
                  {isAsked ? (
                    <div className="rounded-md border border-line bg-panel px-3 py-2">
                      <p className="text-muted text-[13px]">You: {q.q}</p>
                      <p className="mt-0.5">{q.a}</p>
                    </div>
                  ) : (
                    <button className="text-left w-full rounded-md border border-dashed border-line px-3 py-2 hover:bg-panel-2" onClick={() => setAsked((a) => [...a, q.id])}>
                      Ask: {q.q}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </Step>

        <Step n={2} title="Estimate" done={estChecked}>
          <ul className="space-y-3">
            {iv.estimates.map((e) => {
              const v = est[e.id] ?? "";
              const ok = estimateOk(e.answer, e.tolerance, v.trim() ? Number(v.replace(/,/g, "")) : null);
              return (
                <li key={e.id} className="text-[14px]">
                  <label htmlFor={`est-${e.id}`}>{e.q}</label>
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      id={`est-${e.id}`}
                      inputMode="decimal"
                      value={v}
                      disabled={estChecked}
                      onChange={(ev) => setEst((s) => ({ ...s, [e.id]: ev.target.value }))}
                      className="w-32 rounded-md border border-line bg-panel-2 px-2 py-1 num"
                    />
                    <span className="text-muted text-[13px]">{e.unit}</span>
                    {estChecked && (
                      <span className="text-[13px]" style={{ color: ok ? "var(--signal)" : "var(--crit)" }}>
                        {ok ? "Close enough" : `About ${e.answer.toLocaleString("en-US")}`}
                      </span>
                    )}
                  </div>
                  {estChecked && <p className="text-[13px] text-muted mt-1">{e.working}</p>}
                </li>
              );
            })}
          </ul>
          {!estChecked && (
            <button className="mt-3 text-[13px] text-accent" onClick={() => setEstChecked(true)}>
              Check my estimates
            </button>
          )}
        </Step>

        <Step n={3} title="Build it and send traffic" done={hold.current.best >= HOLD_MS}>
          <ul className="divide-y divide-line border border-line rounded-lg bg-panel text-[14px]">
            {iv.requirements.map((r) => {
              const known = asked.includes(r.revealedBy);
              const ok = live.running && live.met[r.id];
              return (
                <li key={r.id} className="px-3 py-2 flex items-center gap-3">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: !known || !live.running ? "var(--line)" : ok ? "var(--signal)" : "var(--crit)" }} aria-hidden="true" />
                  <span className={`flex-1 ${known ? "" : "text-muted italic"}`}>{known ? r.text : "A target you haven't asked about yet"}</span>
                  {known && <span className="text-[12px] text-muted">{!live.running ? "Waiting" : ok ? "Met" : "Not met"}</span>}
                </li>
              );
            })}
            <li className="px-3 py-2 flex items-baseline justify-between text-[13px]">
              <span className="text-muted">All at once</span>
              <span className="num">
                {Math.min(HOLD_MS, live.holdMs) / 1000 >= HOLD_MS / 1000 || hold.current.best >= HOLD_MS ? "Held" : `${Math.floor(live.holdMs / 1000)} of ${HOLD_MS / 1000} s`}
              </span>
            </li>
            <li className="px-3 py-2 flex items-baseline justify-between text-[13px]">
              <span className="text-muted">Your design costs</span>
              <span className="num">{fmtDollars(live.cost)} a month</span>
            </li>
          </ul>
        </Step>

        <Step n={4} title="The follow-up" done={follow.state === "done"}>
          {follow.state === "idle" ? (
            <>
              <p className="text-[14px] text-muted">When your design is running and you're happy with it, ask for the follow-up. The interviewer will do something to it while it runs.</p>
              <button className="mt-2 px-3.5 py-1.5 rounded-md border border-line hover:bg-panel-2 text-[14px] disabled:opacity-50" disabled={!live.running} onClick={startFollowUp}>
                {live.running ? "I'm ready for the follow-up" : "Press Send traffic in the lab first"}
              </button>
              {follow.problem && <p className="text-[13px] text-warn mt-2">{follow.problem}</p>}
            </>
          ) : (
            <>
              <blockquote className="border-l-2 border-accent pl-4 py-1 text-[15px]">{iv.followUp.say}</blockquote>
              <p className="text-[13px] text-muted mt-2">Watching: {iv.followUp.holds.text.charAt(0).toLowerCase() + iv.followUp.holds.text.slice(1)}.</p>
              <div className="mt-2 h-1.5 rounded-full bg-panel-2 overflow-hidden">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(follow.progress * 100)}%` }} />
              </div>
              <p className="text-[13px] mt-1">
                {follow.state === "done" ? "Over. " : ""}
                {follow.checks ? `Held ${Math.round((100 * follow.held) / follow.checks)}% of the time so far.` : "Starting..."}
              </p>
            </>
          )}
        </Step>

        <button className="mt-2 px-4 py-2 rounded-md bg-accent text-accent-ink font-medium" onClick={finish}>
          End the interview and see the scorecard
        </button>
      </>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0">
      <article className="lg:w-[40%] lg:max-w-[640px] lg:overflow-y-auto lg:h-[calc(100dvh-3rem)] px-6 sm:px-9 py-8 border-b lg:border-b-0 lg:border-r border-line">{left}</article>
      <section className="flex-1 flex flex-col min-h-[640px] lg:h-[calc(100dvh-3rem)]" aria-label="Lab">
        <Lab
          control={control}
          shareName={`My interview answer: ${iv.title}`}
          graph={iv.graph}
          palette={iv.palette}
          layout="compact"
          onGraphChange={onGraphChange}
          onSnapshot={onSnapshot}
        />
      </section>
    </div>
  );
}
