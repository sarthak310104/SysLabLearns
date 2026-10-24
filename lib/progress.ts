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

class LabDB extends Dexie {
  code!: Table<CodeRow, string>;
  goals!: Table<GoalRow, string>;
  designs!: Table<DesignRow, string>;
  quizzes!: Table<QuizRow, string>;

  constructor() {
    super("syslablearns");
    this.version(1).stores({ goals: "id, lesson", designs: "id, updatedAt" });
    this.version(2).stores({ goals: "id, lesson", designs: "id, updatedAt", quizzes: "lesson" });
    this.version(3).stores({ goals: "id, lesson", designs: "id, updatedAt", quizzes: "lesson", code: "lab" });
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
