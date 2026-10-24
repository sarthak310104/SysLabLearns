"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { INTERVIEWS } from "@/content/interviews";
import { loadInterviewResults, type InterviewRow } from "@/lib/progress";

export function InterviewList() {
  const [results, setResults] = useState<InterviewRow[]>([]);
  useEffect(() => {
    loadInterviewResults().then(setResults);
  }, []);
  return (
    <>
      <ul className="grid gap-3 sm:grid-cols-2">
        {INTERVIEWS.map((iv) => {
          const mine = results.filter((r) => r.slug === iv.slug);
          const best = mine.reduce<InterviewRow | null>((a, r) => (!a || r.score > a.score ? r : a), null);
          return (
            <li key={iv.slug}>
              <Link href={`/interview/${iv.slug}/`} className="block h-full rounded-lg border border-line bg-panel hover:bg-panel-2 px-4 py-3">
                <span className="flex items-baseline gap-3">
                  <span className="font-medium flex-1">{iv.title}</span>
                  <span className="num text-[12px] text-muted">{iv.minutes} min</span>
                </span>
                <span className="block text-[13px] text-muted mt-1">{iv.prompt}</span>
                <span className="block text-[12px] mt-2">
                  {best ? (
                    <span>
                      Best: <span className="num">{best.score}</span> ({best.grade}), {mine.length} attempt{mine.length === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <span className="text-muted">Not tried yet</span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {results.length > 0 && (
        <section className="mt-10">
          <h2 className="font-semibold mb-2">Recent attempts</h2>
          <ul className="divide-y divide-line border-y border-line text-[14px]">
            {results.slice(0, 8).map((r) => (
              <li key={r.id} className="py-2 flex gap-3">
                <span className="flex-1">{INTERVIEWS.find((i) => i.slug === r.slug)?.title ?? r.slug}</span>
                <span className="text-muted">{new Date(r.at).toLocaleDateString()}</span>
                <span className="num w-10 text-right">{r.score}</span>
                <span className="w-28 text-right text-muted">{r.grade}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
