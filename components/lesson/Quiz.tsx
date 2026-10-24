"use client";

import { useState } from "react";
import { QUIZZES } from "@/content/quizzes";
import { saveQuizScore } from "@/lib/progress";
import { useLesson } from "./LessonContext";

/** End-of-lesson check: one question at a time, with the reasoning shown after each answer. */
export function Quiz() {
  const lesson = useLesson();
  const questions = lesson ? QUIZZES[lesson.slug] ?? [] : [];
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [finished, setFinished] = useState(false);
  if (!lesson || !questions.length) return null;

  const restart = () => {
    setIndex(0);
    setPicked(null);
    setScore(0);
    setFinished(false);
  };

  if (finished) {
    const all = score === questions.length;
    return (
      <section className="my-8 rounded-lg border border-line bg-panel px-5 py-5" aria-label="Quiz result">
        <h2 className="font-semibold text-[1.05rem] !mt-0">Check your understanding</h2>
        <p className="num text-[1.6rem] mt-2">
          {score} of {questions.length}
        </p>
        <p className="text-muted mt-1">
          {all ? "All correct. You've got this one." : "Go back over the explanations you missed, or try a different setup in the lab, then have another go."}
        </p>
        <button onClick={restart} className="mt-4 px-3.5 py-1.5 rounded-md border border-line hover:bg-panel-2 text-[14px]">
          Take the quiz again
        </button>
      </section>
    );
  }

  const q = questions[index];
  const answered = picked !== null;
  const correct = picked === q.answer;
  const last = index === questions.length - 1;

  return (
    <section className="my-8 rounded-lg border border-line bg-panel" aria-label="Quiz">
      <div className="flex items-baseline justify-between px-5 pt-4">
        <h2 className="font-semibold text-[1.05rem] !mt-0 !mb-0">Check your understanding</h2>
        <span className="num text-[13px] text-muted">
          {index + 1} of {questions.length}
        </span>
      </div>
      <div className="px-5 pt-3 pb-5">
        <p className="font-medium">{q.q}</p>
        <div className="mt-3 flex flex-col gap-2" role="group" aria-label="Answers">
          {q.options.map((opt, i) => {
            const isAnswer = i === q.answer;
            const isPicked = i === picked;
            let border = "var(--line)";
            if (answered && isAnswer) border = "var(--signal)";
            else if (answered && isPicked) border = "var(--crit)";
            return (
              <button
                key={i}
                disabled={answered}
                aria-pressed={isPicked}
                onClick={() => {
                  setPicked(i);
                  if (i === q.answer) setScore((s) => s + 1);
                }}
                className="text-left rounded-md border px-3.5 py-2.5 text-[14px] hover:bg-panel-2 disabled:hover:bg-transparent disabled:cursor-default"
                style={{ borderColor: border, opacity: answered && !isAnswer && !isPicked ? 0.6 : 1 }}
              >
                {opt}
              </button>
            );
          })}
        </div>
        <div aria-live="polite">
          {answered && (
            <div className="mt-4">
              <p className="font-medium" style={{ color: correct ? "var(--signal)" : "var(--crit)" }}>
                {correct ? "Correct." : "Not quite."}
              </p>
              <p className="text-muted text-[14px] mt-1">{q.explain}</p>
              <button
                onClick={() => {
                  if (last) {
                    setFinished(true);
                    saveQuizScore(lesson.slug, score, questions.length);
                  } else {
                    setIndex(index + 1);
                    setPicked(null);
                  }
                }}
                className="mt-4 px-3.5 py-1.5 rounded-md bg-accent text-accent-ink font-medium text-[14px]"
              >
                {last ? "See my score" : "Next question"}
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
