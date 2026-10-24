import type { MDXComponents } from "mdx/types";
import { Goals } from "@/components/lesson/Goals";
import { Note } from "@/components/lesson/Note";
import { Quiz } from "@/components/lesson/Quiz";
import { CapacityPlanner, LatencyCurve, LittlesLaw, StrategyRace } from "@/components/explore/widgets-a1-a2";
import { HashRingExplorer, HitRatioCurve, HotShardBars, LagGrowth, StaleReadTimeline, TtlTradeoff } from "@/components/explore/widgets-a3-a5";
import { BacklogSim, ConflictCurve, GoodputSweep, RetryCurves, SyncLatency } from "@/components/explore/widgets-a6-a8";

const explorables = {
  LatencyCurve,
  LittlesLaw,
  CapacityPlanner,
  StrategyRace,
  HitRatioCurve,
  TtlTradeoff,
  StaleReadTimeline,
  LagGrowth,
  HashRingExplorer,
  HotShardBars,
  BacklogSim,
  RetryCurves,
  GoodputSweep,
  ConflictCurve,
  SyncLatency,
};

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return { ...components, Goals, Note, Quiz, ...explorables };
}
