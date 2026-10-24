"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

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
      className="text-sm text-muted hover:text-text px-2 py-1 rounded-md"
      aria-label={`Switch to ${next} theme`}
    >
      {theme === "dark" ? "Light theme" : "Dark theme"}
    </button>
  );
}

const NAV = [
  { href: "/", label: "Roadmap" },
  { href: "/sandbox/", label: "Sandbox" },
];

export function SiteHeader() {
  const path = usePathname();
  return (
    <header className="h-12 shrink-0 border-b border-line bg-panel flex items-center gap-6 px-4 shadow-[0_1px_0_color-mix(in_srgb,var(--accent)_35%,transparent)]">
      <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
        <Logo />
        SysLabLearns
      </Link>
      <nav className="flex items-center gap-1 text-sm">
        {NAV.map((n) => {
          const active = n.href === "/" ? path === "/" || path.startsWith("/learn") : path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`px-2.5 py-1 rounded-md ${active ? "bg-panel-2 text-text" : "text-muted hover:text-text"}`}
            >
              {n.label}
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
