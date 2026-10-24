"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { dueCount } from "@/lib/progress";

function Logo() {
  // Three nodes on a wire: the app in one glyph.
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" style={{ filter: "drop-shadow(0 0 4px var(--accent))" }}>
      <path d="M4 11h14" stroke="var(--line)" strokeWidth="2" />
      <circle cx="4" cy="11" r="3" fill="var(--accent)" />
      <circle cx="11" cy="11" r="3" fill="var(--signal)" />
      <circle cx="18" cy="11" r="3" fill="var(--accent)" opacity="0.55" />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("theme", next);
        } catch {}
        setTheme(next);
      }}
      className="text-sm text-muted hover:text-text px-1.5 sm:px-2 py-1 rounded-md whitespace-nowrap"
      aria-label={`Switch to ${next} theme`}
    >
      {theme === "dark" ? "Light" : "Dark"}
      <span className="hidden sm:inline"> theme</span>
    </button>
  );
}

const NAV: { href: string; label: string; wide?: boolean }[] = [
  { href: "/", label: "Roadmap" },
  { href: "/sandbox/", label: "Sandbox" },
  { href: "/review/", label: "Review" },
  { href: "/glossary/", label: "Glossary", wide: true },
];

export function SiteHeader() {
  const path = usePathname();
  const [due, setDue] = useState(0);
  useEffect(() => {
    dueCount().then(setDue);
    const t = setInterval(() => dueCount().then(setDue), 60000);
    return () => clearInterval(t);
  }, [path]);
  return (
    <header className="h-12 shrink-0 border-b border-line bg-panel flex items-center gap-3 sm:gap-6 px-3 sm:px-4 min-w-0 shadow-[0_1px_0_color-mix(in_srgb,var(--accent)_35%,transparent)]">
      <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
        <Logo />
        <span className="hidden sm:inline">SysLabLearns</span>
      </Link>
      <nav className="flex items-center gap-1 text-sm">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" || path.startsWith("/learn") : path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`${n.wide ? "hidden sm:inline-flex" : "inline-flex"} items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-md ${active ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}
            >
              {n.label}
              {n.href === "/review/" && due > 0 && (
                <span className="num text-[11px] leading-none px-1.5 py-0.5 rounded-full bg-accent text-accent-ink" aria-label={`${due} due`}>
                  {due > 99 ? "99+" : due}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto">
        <ThemeToggle />
      </div>
    </header>
  );
}
