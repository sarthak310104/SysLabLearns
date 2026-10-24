"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { moduleGoalIds, TRACKS, type Module } from "@/content/curriculum";
import { loadCompletedGoals } from "@/lib/progress";

/** The main call to action: start from zero, or carry on with the lesson you were last working through. */
export function ContinueButton() {
  const [next, setNext] = useState<Module | null>(null);
  useEffect(() => {
    loadCompletedGoals().then((done) => {
      if (!done.size) return;
      const modules = TRACKS.flatMap((t) => t.modules).filter((m) => m.slug && moduleGoalIds(m).length);
      // The lesson you've started but not finished, otherwise the first untouched one.
      const started = modules.find((m) => {
        const ids = moduleGoalIds(m);
        const n = ids.filter((id) => done.has(`${m.slug}/${id}`)).length;
        return n > 0 && n < ids.length;
      });
      setNext(started ?? modules.find((m) => moduleGoalIds(m).every((id) => !done.has(`${m.slug}/${id}`))) ?? null);
    });
  }, []);
  const cls = "px-4 py-2.5 rounded-md bg-accent text-accent-ink font-medium neon";
  if (!next) {
    return (
      <Link href="/learn/a0-foundations/" className={cls}>
        Start from zero
      </Link>
    );
  }
  return (
    <Link href={`/learn/${next.slug}/`} className={cls}>
      Continue: {next.code} {next.title}
    </Link>
  );
}
