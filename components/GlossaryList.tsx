"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { GLOSSARY } from "@/content/glossary";
import { AWS_LESSONS, LESSONS, PROTOCOL_LESSONS } from "@/content/curriculum";

const ALL = [...LESSONS, ...PROTOCOL_LESSONS, ...AWS_LESSONS];

export function GlossaryList() {
  const [q, setQ] = useState("");
  const terms = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term)).filter((t) => !needle || t.term.toLowerCase().includes(needle) || t.def.toLowerCase().includes(needle));
  }, [q]);
  return (
    <>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search terms"
        aria-label="Search terms"
        className="w-full rounded-md border border-line bg-panel px-3 py-2 mb-6"
      />
      <dl className="divide-y divide-line border-y border-line">
        {terms.map((t) => {
          const l = ALL.find((x) => x.slug === t.lesson);
          return (
            <div key={t.term} className="py-3 sm:grid sm:grid-cols-[180px_1fr] gap-4">
              <dt className="font-medium">{t.term}</dt>
              <dd className="text-muted">
                {t.def}
                {l && (
                  <Link href={`/learn/${l.slug}/`} className="block mt-1 text-[13px] text-accent hover:underline">
                    {l.code} {l.title}
                  </Link>
                )}
              </dd>
            </div>
          );
        })}
        {!terms.length && <p className="py-4 text-muted">No terms match.</p>}
      </dl>
    </>
  );
}
