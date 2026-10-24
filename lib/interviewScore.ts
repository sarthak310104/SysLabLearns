import type { Interview } from "@/content/interviews";
import { FOLLOW_UP_PASS } from "@/content/interviews";

/* The scorecard: 100 points across the parts an interviewer listens for. */

export interface InterviewRun {
  asked: string[];
  estimates: Record<string, number | null>;
  /** Longest stretch, in simulated ms, with every requirement met at once. */
  bestHoldMs: number;
  /** Requirements met at the moment you finished. */
  metAtEnd: Record<string, boolean>;
  followUp: { ran: boolean; checks: number; held: number };
  elapsedMs: number;
}

export interface ScoreLine {
  id: "clarify" | "estimate" | "requirements" | "followup" | "time";
  title: string;
  points: number;
  max: number;
  notes: string[];
}

export const HOLD_MS = 10000;

export function estimateOk(answer: number, tolerance: number, got: number | null | undefined): boolean {
  return got !== null && got !== undefined && Number.isFinite(got) && Math.abs(got - answer) <= answer * tolerance;
}

export function scoreInterview(iv: Interview, run: InterviewRun): { lines: ScoreLine[]; total: number; grade: string; verdict: string } {
  const lines: ScoreLine[] = [];

  const key = iv.questions.filter((q) => q.key);
  const askedKey = key.filter((q) => run.asked.includes(q.id));
  const missed = key.filter((q) => !run.asked.includes(q.id));
  lines.push({
    id: "clarify",
    title: "Clarifying the problem",
    max: 20,
    points: Math.round((20 * askedKey.length) / Math.max(1, key.length)),
    notes: missed.length ? [`You didn't ask: ${missed.map((q) => `"${q.q}"`).join(", ")}. Each of those answers sets a number your design has to meet.`] : ["You asked every question that changes the design."],
  });

  const est = iv.estimates.map((e) => ({ e, ok: estimateOk(e.answer, e.tolerance, run.estimates[e.id]) }));
  lines.push({
    id: "estimate",
    title: "Back-of-the-envelope estimates",
    max: 20,
    points: Math.round((20 * est.filter((x) => x.ok).length) / Math.max(1, est.length)),
    notes: est.map(({ e, ok }) => (ok ? `Right on "${e.q}"` : run.estimates[e.id] == null ? `Skipped "${e.q}" (about ${e.answer.toLocaleString("en-US")} ${e.unit}).` : `"${e.q}": about ${e.answer.toLocaleString("en-US")} ${e.unit}. ${e.working}`)),
  });

  const metNow = iv.requirements.filter((r) => run.metAtEnd[r.id]).length;
  const held = run.bestHoldMs >= HOLD_MS;
  lines.push({
    id: "requirements",
    title: "Meeting the requirements",
    max: 30,
    points: held ? 30 : Math.round((15 * metNow) / Math.max(1, iv.requirements.length)),
    notes: held
      ? [`Every requirement held together for ${Math.floor(run.bestHoldMs / 1000)} seconds.`]
      : [
          `Every requirement has to hold at the same time for ${HOLD_MS / 1000} seconds; your best was ${Math.floor(run.bestHoldMs / 1000)}.`,
          ...iv.requirements.filter((r) => !run.metAtEnd[r.id]).map((r) => `Not met when you finished: ${r.text}.`),
        ],
  });

  const share = run.followUp.checks ? run.followUp.held / run.followUp.checks : 0;
  const survived = run.followUp.ran && share >= FOLLOW_UP_PASS;
  lines.push({
    id: "followup",
    title: "The follow-up",
    max: 20,
    points: !run.followUp.ran ? 0 : survived ? 20 : Math.round(20 * share * 0.6),
    notes: !run.followUp.ran
      ? ["You finished before the follow-up. In a real interview it always comes."]
      : survived
        ? [`${iv.followUp.holds.text}: held ${Math.round(share * 100)}% of the time.`]
        : [`${iv.followUp.holds.text}: held only ${Math.round(share * 100)}% of the time (${Math.round(FOLLOW_UP_PASS * 100)}% needed).`],
  });

  const over = Math.max(0, run.elapsedMs - iv.minutes * 60000);
  const overMin = Math.ceil(over / 60000);
  lines.push({
    id: "time",
    title: "Time",
    max: 10,
    points: Math.max(0, 10 - 2 * overMin),
    notes: [over > 0 ? `${overMin} minute${overMin === 1 ? "" : "s"} over the ${iv.minutes} you had.` : `Done in ${Math.max(1, Math.round(run.elapsedMs / 60000))} of ${iv.minutes} minutes.`],
  });

  const total = lines.reduce((a, l) => a + l.points, 0);
  const [grade, verdict] =
    total >= 85
      ? ["Strong hire", "Clear requirements, sound numbers, and a design that held up under pressure."]
      : total >= 70
        ? ["Hire", "A solid design. Tighten the weaker parts below."]
        : total >= 50
          ? ["Lean no hire", "Parts of this were good, but an interviewer would want more."]
          : ["No hire", "Not yet. Work through the notes below and try again."];
  return { lines, total, grade, verdict };
}
