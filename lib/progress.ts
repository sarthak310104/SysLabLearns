"use client";

import Dexie, { type Table } from "dexie";
import type { Graph } from "@/engine/model/types";

interface GoalRow {
  id: string; // `${lessonSlug}/${goalId}`
  lesson: string;
  goal: string;
  completedAt: number;
}

interface QuizRow {
  lesson: string;
  best: number;
  total: number;
  updatedAt: number;
}

interface DesignRow {
  id: string;
  name: string;
  graph: Graph;
  updatedAt: number;
}

interface CodeRow {
  lab: string;
  code: string;
  updatedAt: number;
}

interface AwsRow {
  id: string;
  state: unknown;
  history: unknown[];
  updatedAt: number;
}

/** One quiz question in the review deck (Leitner boxes). */
export interface CardRow {
  id: string; // `${lesson}#${index}`
  lesson: string;
  index: number;
  /** 0 = just missed; each correct review moves it up a box and further out. */
  box: number;
  due: number;
  reviews: number;
  lapses: number;
  lastReviewed: number;
}

/** What you did on one day, for streaks and time spent. */
export interface ActivityRow {
  day: string; // YYYY-MM-DD, local time
  minutes: number;
  answers: number;
  correct: number;
  goals: number;
}

export interface InterviewRow {
  id: string;
  slug: string;
  at: number;
  score: number;
  grade: string;
  minutes: number;
}

class LabDB extends Dexie {
  interviews!: Table<InterviewRow, string>;
  cards!: Table<CardRow, string>;
  activity!: Table<ActivityRow, string>;
  aws!: Table<AwsRow, string>;
  code!: Table<CodeRow, string>;
  goals!: Table<GoalRow, string>;
  designs!: Table<DesignRow, string>;
  quizzes!: Table<QuizRow, string>;

  constructor() {
    super("syslablearns");
    this.version(1).stores({ goals: "id, lesson", designs: "id, updatedAt" });
    this.version(2).stores({ goals: "id, lesson", designs: "id, updatedAt", quizzes: "lesson" });
    this.version(3).stores({ goals: "id, lesson", designs: "id, updatedAt", quizzes: "lesson", code: "lab" });
    this.version(4).stores({ goals: "id, lesson", designs: "id, updatedAt", quizzes: "lesson", code: "lab", aws: "id" });
    this.version(5).stores({ goals: "id, lesson", designs: "id, updatedAt", quizzes: "lesson", code: "lab", aws: "id", cards: "id, lesson, due", activity: "day" });
    this.version(6).stores({ goals: "id, lesson", designs: "id, updatedAt", quizzes: "lesson", code: "lab", aws: "id", cards: "id, lesson, due", activity: "day", interviews: "id, slug" });
  }
}

let db: LabDB | null = null;
function getDb(): LabDB | null {
  if (typeof indexedDB === "undefined") return null;
  return (db ??= new LabDB());
}

/** Every completed goal, as `${lesson}/${goal}` ids. Empty if storage is unavailable. */
export async function loadCompletedGoals(): Promise<Set<string>> {
  try {
    const rows = (await getDb()?.goals.toArray()) ?? [];
    return new Set(rows.map((r) => r.id));
  } catch {
    return new Set();
  }
}

export async function markGoalComplete(lesson: string, goal: string): Promise<void> {
  try {
    const db = getDb();
    if (db && !(await db.goals.get(`${lesson}/${goal}`))) await bumpActivity({ goals: 1 });
    await getDb()?.goals.put({ id: `${lesson}/${goal}`, lesson, goal, completedAt: Date.now() });
  } catch {
    /* progress is a convenience; the app works without it */
  }
}

export async function resetLessonProgress(lesson: string): Promise<void> {
  try {
    await getDb()?.goals.where("lesson").equals(lesson).delete();
  } catch {}
}

export async function saveDesign(id: string, name: string, graph: Graph): Promise<void> {
  try {
    await getDb()?.designs.put({ id, name, graph, updatedAt: Date.now() });
  } catch {}
}

/** Saved sandbox versions (every design except the live sandbox), newest first. */
export async function listDesigns(): Promise<{ id: string; name: string; graph: Graph; updatedAt: number }[]> {
  try {
    const rows = (await getDb()?.designs.toArray()) ?? [];
    return rows.filter((r) => r.id.startsWith("v-")).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteDesign(id: string): Promise<void> {
  try {
    await getDb()?.designs.delete(id);
  } catch {}
}

export async function loadDesign(id: string): Promise<Graph | null> {
  try {
    return (await getDb()?.designs.get(id))?.graph ?? null;
  } catch {
    return null;
  }
}

/** Best quiz score per lesson. */
export async function loadQuizScores(): Promise<Record<string, { best: number; total: number }>> {
  try {
    const rows = (await getDb()?.quizzes.toArray()) ?? [];
    return Object.fromEntries(rows.map((r) => [r.lesson, { best: r.best, total: r.total }]));
  } catch {
    return {};
  }
}

export async function saveQuizScore(lesson: string, score: number, total: number): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const prev = await db.quizzes.get(lesson);
    if (!prev || score > prev.best) await db.quizzes.put({ lesson, best: score, total, updatedAt: Date.now() });
  } catch {}
}

/** The learner's code for a protocol lab, or null if they haven't started. */
export async function loadLabCode(lab: string): Promise<string | null> {
  try {
    return (await getDb()?.code.get(lab))?.code ?? null;
  } catch {
    return null;
  }
}

export async function saveLabCode(lab: string, code: string): Promise<void> {
  try {
    await getDb()?.code.put({ lab, code, updatedAt: Date.now() });
  } catch {}
}

/** The emulated AWS account (shared by every AWS lesson, like a real account). */
export async function loadAwsAccount(): Promise<{ state: unknown; history: unknown[] } | null> {
  try {
    const row = await getDb()?.aws.get("account");
    return row ? { state: row.state, history: row.history } : null;
  } catch {
    return null;
  }
}

export async function saveAwsAccount(state: unknown, history: unknown[]): Promise<void> {
  try {
    await getDb()?.aws.put({ id: "account", state, history: history.slice(-300), updatedAt: Date.now() });
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Backup: every table, so new ones are included without changes here */
/* ------------------------------------------------------------------ */

export interface ProgressBackup {
  app: "syslablearns";
  version: 1;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

export async function exportProgress(): Promise<ProgressBackup> {
  const db = getDb();
  const tables: Record<string, unknown[]> = {};
  if (db) for (const t of db.tables) tables[t.name] = await t.toArray();
  return { app: "syslablearns", version: 1, exportedAt: new Date().toISOString(), tables };
}

/**
 * Merge a backup into this browser. Rows with the same key are replaced by
 * the backup's; nothing else is deleted. Returns how many rows came in.
 */
export async function importProgress(data: unknown): Promise<number> {
  const b = data as Partial<ProgressBackup> | null;
  if (!b || b.app !== "syslablearns" || typeof b.tables !== "object" || !b.tables) {
    throw new Error("That file isn't a SysLabLearns progress backup.");
  }
  const db = getDb();
  if (!db) throw new Error("This browser doesn't allow saving progress (private window?).");
  let n = 0;
  await db.transaction("rw", db.tables, async () => {
    for (const t of db.tables) {
      const rows = b.tables![t.name];
      if (!Array.isArray(rows) || !rows.length) continue;
      await t.bulkPut(rows);
      n += rows.length;
    }
  });
  return n;
}

/* ------------------------------------------------------------------ */
/* Spaced review                                                       */
/* ------------------------------------------------------------------ */

const DAY = 86400000;
/** How long to wait before showing a card again, by box. */
export const INTERVALS = [10 * 60000, DAY, 3 * DAY, 7 * DAY, 16 * DAY, 35 * DAY];

/** Record an answer, from a lesson quiz or the review page, and reschedule the card. */
/**
 * The Leitner rule. A new card starts in box 1 if answered right, box 0 if not.
 * Wrong always goes back to box 0. Right moves up one box, but only when the
 * card was due (or this is a review): retaking a lesson quiz early doesn't skip ahead.
 */
export function nextBox(prev: Pick<CardRow, "box" | "due"> | undefined, correct: boolean, fromReview: boolean, now: number): number {
  if (!prev) return correct ? 1 : 0;
  if (!correct) return 0;
  if (fromReview || prev.due <= now) return Math.min(INTERVALS.length - 1, prev.box + 1);
  return prev.box;
}

/** Cards due now. */
export async function dueCount(): Promise<number> {
  try {
    const db = getDb();
    if (!db) return 0;
    return await db.cards.where("due").belowOrEqual(Date.now()).count();
  } catch {
    return 0;
  }
}

export async function recordAnswer(lesson: string, index: number, correct: boolean, fromReview = false): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const id = `${lesson}#${index}`;
    const now = Date.now();
    const prev = await db.cards.get(id);
    const box = nextBox(prev, correct, fromReview, now);
    await db.cards.put({
      id,
      lesson,
      index,
      box,
      due: now + INTERVALS[box],
      reviews: (prev?.reviews ?? 0) + 1,
      lapses: (prev?.lapses ?? 0) + (correct ? 0 : 1),
      lastReviewed: now,
    });
    await bumpActivity({ answers: 1, correct: correct ? 1 : 0 });
  } catch {}
}

export async function loadCards(): Promise<CardRow[]> {
  try {
    return (await getDb()?.cards.toArray()) ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Activity: streaks and time spent                                    */
/* ------------------------------------------------------------------ */

export const today = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export async function bumpActivity(add: Partial<Omit<ActivityRow, "day">>): Promise<void> {
  try {
    const db = getDb();
    if (!db) return;
    const day = today();
    const row = (await db.activity.get(day)) ?? { day, minutes: 0, answers: 0, correct: 0, goals: 0 };
    await db.activity.put({
      day,
      minutes: row.minutes + (add.minutes ?? 0),
      answers: row.answers + (add.answers ?? 0),
      correct: row.correct + (add.correct ?? 0),
      goals: row.goals + (add.goals ?? 0),
    });
  } catch {}
}

export async function loadActivity(): Promise<ActivityRow[]> {
  try {
    return (await getDb()?.activity.toArray()) ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Interview results                                                   */
/* ------------------------------------------------------------------ */

export async function saveInterviewResult(r: Omit<InterviewRow, "id">): Promise<void> {
  try {
    await getDb()?.interviews.put({ ...r, id: `${r.slug}-${r.at}` });
  } catch {}
}

export async function loadInterviewResults(): Promise<InterviewRow[]> {
  try {
    return ((await getDb()?.interviews.toArray()) ?? []).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}
