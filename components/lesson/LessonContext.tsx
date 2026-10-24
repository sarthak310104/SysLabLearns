"use client";

import { createContext, useContext } from "react";
import type { Goal } from "@/lib/goals";
import type { GoalUpdate } from "@/components/lab/Lab";

export interface LessonState {
  slug: string;
  goals: Pick<Goal, "id" | "text" | "hint">[];
  status: Record<string, GoalUpdate>;
}

export const LessonContext = createContext<LessonState | null>(null);
export const useLesson = () => useContext(LessonContext);
