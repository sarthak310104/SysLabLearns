import type { ActivityRow, CardRow } from "@/lib/progress";

/* Pure helpers behind the progress page, kept separate so they're easy to test. */

const DAY = 86400000;

/** YYYY-MM-DD for local midnight `n` days before `day`. */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(y, m - 1, d - n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

const active = (a: ActivityRow | undefined) => Boolean(a && (a.minutes > 0 || a.answers > 0 || a.goals > 0));

/** Days in a row with some learning, ending today (or yesterday, so the streak isn't lost before you've started today). */
export function streak(rows: ActivityRow[], todayStr: string): { current: number; best: number } {
  const by = new Map(rows.map((r) => [r.day, r]));
  let start = todayStr;
  if (!active(by.get(start))) start = shiftDay(todayStr, 1);
  let current = 0;
  while (active(by.get(shiftDay(start, current)))) current++;

  const days = rows.filter(active).map((r) => r.day).sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && shiftDay(days[i], 1) === days[i - 1] ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return { current, best: Math.max(best, current) };
}

export interface StatsInput {
  activity: ActivityRow[];
  cards: CardRow[];
  /** Per track: lessons fully done and in total. */
  tracks: { id: string; title: string; done: number; total: number }[];
  challenges: { passed: number; resilient: number; total: number };
  goalsDone: number;
  today: string;
}

export interface Badge {
  id: string;
  title: string;
  how: string;
  earned: boolean;
}

export function totals(rows: ActivityRow[], todayStr: string) {
  const week = new Set(Array.from({ length: 7 }, (_, i) => shiftDay(todayStr, i)));
  let minutes = 0, answers = 0, correct = 0, weekMinutes = 0;
  for (const r of rows) {
    minutes += r.minutes;
    answers += r.answers;
    correct += r.correct;
    if (week.has(r.day)) weekMinutes += r.minutes;
  }
  return { minutes, answers, correct, weekMinutes, accuracy: answers ? correct / answers : null };
}

export function badges(s: StatsInput): Badge[] {
  const t = totals(s.activity, s.today);
  const st = streak(s.activity, s.today);
  const reviewed = s.cards.reduce((a, c) => a + Math.max(0, c.reviews - 1), 0);
  const deepest = Math.max(0, ...s.cards.map((c) => c.box));
  const track = (id: string) => s.tracks.find((x) => x.id === id);
  const finished = (id: string) => {
    const x = track(id);
    return Boolean(x && x.total > 0 && x.done >= x.total);
  };
  const list: Omit<Badge, "earned">[] = [];
  const earned: boolean[] = [];
  const add = (id: string, title: string, how: string, ok: boolean) => {
    list.push({ id, title, how });
    earned.push(ok);
  };
  add("first-goal", "First light", "Complete any goal in any lesson.", s.goalsDone > 0);
  add("streak-3", "Three in a row", "Learn something three days running.", st.best >= 3);
  add("streak-7", "A full week", "Keep a seven-day streak.", st.best >= 7);
  add("streak-30", "Habit formed", "Keep a thirty-day streak.", st.best >= 30);
  add("answers-50", "Fifty answers", "Answer 50 quiz questions.", t.answers >= 50);
  add("sharp", "Sharp", "Get 90% or more right over at least 40 answers.", t.answers >= 40 && (t.accuracy ?? 0) >= 0.9);
  add("reviewer", "Kept it fresh", "Do 25 spaced reviews.", reviewed >= 25);
  add("long-memory", "Long memory", "Move a question into the five-week box.", deepest >= 5);
  add("hours-5", "Five hours in", "Spend five active hours learning.", t.minutes >= 300);
  add("design", "Systems thinker", "Finish every system design lesson.", finished("system-design"));
  add("protocols", "Protocol builder", "Finish every distributed protocols lab.", finished("protocols"));
  add("aws", "Cloud hands", "Finish every AWS lab.", finished("aws"));
  add("challenge", "Shipped it", "Pass a design challenge.", s.challenges.passed > 0);
  add("unbreakable", "Unbreakable", "Pass the resilience goal on every challenge.", s.challenges.total > 0 && s.challenges.resilient >= s.challenges.total);
  return list.map((b, i) => ({ ...b, earned: earned[i] }));
}

/** Questions you miss most, worst first. */
export function weakest(cards: CardRow[], n = 5): CardRow[] {
  return cards.filter((c) => c.lapses > 0).sort((a, b) => b.lapses - a.lapses || a.box - b.box).slice(0, n);
}

export { DAY };
