"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { QUIZZES } from "@/content/quizzes";
import { AWS_LESSONS, LESSONS, PROTOCOL_LESSONS } from "@/content/curriculum";
import { INTERVALS, loadCards, recordAnswer, type CardRow } from "@/lib/progress";

const ALL = [...LESSONS, ...PROTOCOL_LESSONS, ...AWS_LESSONS];
const lessonOf = (slug: string) => ALL.find((l) => l.slug === slug);

function when(t: number): string {
  const d = t - Date.now();
  if (d <= 0) return "now";
  if (d < 3600000) return `in ${Math.ceil(d / 60000)} min`;
  if (d < 86400000) return `in ${Math.ceil(d / 3600000)} h`;
  return `in ${Math.ceil(d / 86400000)} days`;
}

/** Order for today's session: the ones you keep missing first, then the oldest due. */
function order(cards: CardRow[]): CardRow[] {
  return [...cards].sort((a, b) => a.box - b.box || b.lapses - a.lapses || a.due - b.due);
}

export function ReviewSession() {
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [queue, setQueue] = useState<CardRow[]>([]);
  const [i, setI] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [right, setRight] = useState(0);
  const [started, setStarted] = useState(false);

  const load = () =>
    loadCards().then((cs) => {
      const valid = cs.filter((c) => QUIZZES[c.lesson]?.[c.index]);
      setCards(valid);
      return valid;
    });
  useEffect(() => {
    load();
  }, []);

  if (!cards) return <p className="text-muted">Loading your deck...</p>;
  const due = order(cards.filter((c) => c.due <= Date.now()));

  if (!started) {
    const boxes = INTERVALS.map((_, b) => cards.filter((c) => c.box === b).length);
    const next = cards.filter((c) => c.due > Date.now()).sort((a, b) => a.due - b.due)[0];
    const quizzed = new Set(cards.map((c) => c.lesson));
    const untried = ALL.filter((l) => QUIZZES[l.slug] && !quizzed.has(l.slug)).slice(0, 4);
    return (
      <div className="space-y-6">
        <section className="rounded-lg border border-line bg-panel px-5 py-5">
          {cards.length === 0 ? (
            <>
              <h2 className="text-lg font-semibold">Your deck is empty</h2>
              <p className="text-muted mt-1">Every quiz question you answer at the end of a lesson goes into this deck. Answer a few, and they'll come back here on a schedule: missed ones soon, ones you know at longer and longer gaps.</p>
            </>
          ) : due.length ? (
            <>
              <h2 className="text-lg font-semibold">
                {due.length} question{due.length === 1 ? "" : "s"} to review
              </h2>
              <p className="text-muted mt-1">A few minutes now keeps what you learned from fading. Questions you've missed come first.</p>
              <button
                className="mt-4 px-4 py-2 rounded-md bg-accent text-accent-ink font-medium neon"
                onClick={() => {
                  setQueue(due.slice(0, 20));
                  setStarted(true);
                }}
              >
                Start reviewing
              </button>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">All caught up</h2>
              <p className="text-muted mt-1">Nothing is due. The next question comes back {next ? when(next.due) : "later"}.</p>
              <button
                className="mt-4 px-4 py-2 rounded-md border border-line hover:bg-panel-2"
                onClick={() => {
                  setQueue(order(cards).slice(0, 10));
                  setStarted(true);
                }}
              >
                Practise anyway
              </button>
            </>
          )}
        </section>
        {cards.length > 0 && (
          <section>
            <h3 className="font-medium mb-2">Your deck</h3>
            <div className="grid grid-cols-6 gap-2 text-center text-[12px]">
              {["Missed", "1 day", "3 days", "1 week", "2 weeks", "5 weeks"].map((label, b) => (
                <div key={label} className="rounded-md border border-line bg-panel py-2">
                  <div className="num text-[18px]">{boxes[b]}</div>
                  <div className="text-muted">{label}</div>
                </div>
              ))}
            </div>
            <p className="text-[12px] text-muted mt-2">Each right answer moves a question one box to the right, so it comes back later. A wrong answer sends it back to the start.</p>
          </section>
        )}
        {untried.length > 0 && (
          <section>
            <h3 className="font-medium mb-2">Add more questions</h3>
            <ul className="text-[14px] space-y-1">
              {untried.map((l) => (
                <li key={l.slug}>
                  <Link href={`/learn/${l.slug}/`} className="hover:text-accent">
                    <span className="num text-signal mr-2">{l.code}</span>
                    {l.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    );
  }

  if (i >= queue.length) {
    return (
      <section className="rounded-lg border border-line bg-panel px-5 py-6">
        <h2 className="text-lg font-semibold">Done for now</h2>
        <p className="num text-[1.6rem] mt-2">
          {right} of {queue.length}
        </p>
        <p className="text-muted mt-1">Missed questions come back in about ten minutes; the rest at longer gaps.</p>
        <button
          className="mt-4 px-3.5 py-1.5 rounded-md border border-line hover:bg-panel-2"
          onClick={async () => {
            await load();
            setStarted(false);
            setI(0);
            setRight(0);
            setPicked(null);
          }}
        >
          Back to the deck
        </button>
      </section>
    );
  }

  const card = queue[i];
  const q = QUIZZES[card.lesson][card.index];
  const l = lessonOf(card.lesson);
  const answered = picked !== null;
  return (
    <section className="rounded-lg border border-line bg-panel" aria-label="Review question">
      <div className="flex items-baseline justify-between px-5 pt-4 text-[13px]">
        <span className="text-muted">
          {l ? (
            <>
              <span className="num text-signal mr-1.5">{l.code}</span>
              {l.title}
            </>
          ) : (
            card.lesson
          )}
        </span>
        <span className="num text-muted">
          {i + 1} of {queue.length}
        </span>
      </div>
      <div className="px-5 pt-3 pb-5">
        <p className="font-medium">{q.q}</p>
        <div className="mt-3 flex flex-col gap-2">
          {q.options.map((opt, k) => {
            let border = "var(--line)";
            if (answered && k === q.answer) border = "var(--h-good)";
            else if (answered && k === picked) border = "var(--h-failing)";
            return (
              <button
                key={k}
                disabled={answered}
                onClick={() => {
                  setPicked(k);
                  if (k === q.answer) setRight((r) => r + 1);
                  recordAnswer(card.lesson, card.index, k === q.answer, true);
                }}
                className="text-left rounded-md border px-3.5 py-2.5 text-[14px] hover:bg-panel-2 disabled:hover:bg-transparent disabled:cursor-default"
                style={{ borderColor: border, opacity: answered && k !== q.answer && k !== picked ? 0.6 : 1 }}
              >
                {opt}
              </button>
            );
          })}
        </div>
        {answered && (
          <div className="mt-4" aria-live="polite">
            <p className="font-medium" style={{ color: picked === q.answer ? "var(--h-good)" : "var(--h-failing)" }}>
              {picked === q.answer ? `Right. Next time: ${when(Date.now() + INTERVALS[Math.min(INTERVALS.length - 1, card.box + 1)])}.` : "Not this time. It'll come back in about ten minutes."}
            </p>
            <p className="text-muted text-[14px] mt-1">{q.explain}</p>
            <div className="flex items-center gap-4 mt-4">
              <button
                className="px-3.5 py-1.5 rounded-md bg-accent text-accent-ink font-medium text-[14px]"
                onClick={() => {
                  setI(i + 1);
                  setPicked(null);
                }}
              >
                {i === queue.length - 1 ? "Finish" : "Next question"}
              </button>
              {l && picked !== q.answer && (
                <Link href={`/learn/${l.slug}/`} className="text-[13px] text-accent hover:underline">
                  Revisit the lesson
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
