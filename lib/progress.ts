"use client";

import Dexie, { type Table } from "dexie";
import type { Graph } from "@/engine/model/types";

interface GoalRow {
  id: string; // `${lessonSlug}/${goalId}`
  lesson: string;
  goal: string;
  completedAt: number;
}

interface DesignRow {
  id: string;
  name: string;
  graph: Graph;
  updatedAt: number;
}

class LabDB extends Dexie {
  goals!: Table<GoalRow, string>;
  designs!: Table<DesignRow, string>;

  constructor() {
    super("syslablearns");
    this.version(1).stores({ goals: "id, lesson", designs: "id, updatedAt" });
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
