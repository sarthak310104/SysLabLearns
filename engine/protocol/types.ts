/**
 * Protocol labs: nodes are message handlers written by the learner (or by the
 * lab itself, for clients and helpers). The engine owns the network, the
 * timers and every source of randomness, so any run can be replayed exactly
 * and every possible ordering of events can be explored.
 */

export type NodeId = string;

export interface TimerEvent {
  name: string;
  data: unknown;
}

/** What a handler can do. Nothing else touches the outside world. */
export interface Ctx {
  /** This node's id. */
  self: NodeId;
  /** Ids of nodes with a role, or every other node if no role is given. */
  nodes(role?: string): NodeId[];
  send(to: NodeId, msg: unknown): void;
  /** Fire `onTimer` after `ms` (simulated time), with `data` attached. */
  setTimer(name: string, ms: number, data?: unknown): void;
  /** A deterministic random number in [0, 1). Use this, never Math.random. */
  random(): number;
  /** A note that shows up in the run view, next to this node. */
  log(text: string): void;
  /** For client roles: finish the current command with this result. */
  reply(value: unknown): void;
}

/** A role's handlers. Return a new state, or change `state` in place and return nothing. */
export interface Handlers {
  init?(ctx: Ctx): unknown;
  onMessage?(state: any, from: NodeId, msg: any, ctx: Ctx): unknown;
  onTimer?(state: any, timer: TimerEvent, ctx: Ctx): unknown;
  /** Clients only: the lab hands over the next command to carry out. */
  onCommand?(state: any, cmd: any, ctx: Ctx): unknown;
}

export interface InFlight {
  seq: number;
  from: NodeId;
  to: NodeId;
  msg: unknown;
  due: number;
}

export interface Timer {
  seq: number;
  node: NodeId;
  name: string;
  data: unknown;
  due: number;
}

export interface NodeRec {
  role: string;
  state: unknown;
  crashed: boolean;
}

export interface HistoryEvent {
  client: NodeId;
  kind: "invoke" | "ok";
  cmd: unknown;
  value?: unknown;
  t: number;
}

export interface Workload {
  pending: unknown[];
  current: unknown | null;
}

export interface LogLine {
  t: number;
  node: NodeId;
  text: string;
}

/**
 * The whole system at one moment. Plain data, so it can be cloned, hashed
 * and compared: that's what makes model checking possible.
 */
export interface World {
  mode: "timed" | "explore";
  nodes: Record<NodeId, NodeRec>;
  msgs: InFlight[];
  timers: Timer[];
  clock: number;
  seq: number;
  rng: number;
  workload: Record<NodeId, Workload>;
  history: HistoryEvent[];
  /** Faults used so far (explore mode budgets them). */
  faults: { drops: number; dups: number; crashes: number };
  /** Set when a handler throws: always a failure. */
  error: string | null;
  /** True once a timed run stops injecting faults, to check that work finishes. */
  healing: boolean;
  /** Recent notes from ctx.log. Not part of the state for checking purposes. */
  logs: LogLine[];
  /** Messages lost on the way in timed mode, for display. */
  lost: number;
}

/** One thing that can happen next. */
export type Step =
  | { type: "deliver"; seq: number }
  | { type: "drop"; seq: number }
  | { type: "duplicate"; seq: number }
  | { type: "timer"; seq: number }
  | { type: "crash"; node: NodeId }
  | { type: "restart"; node: NodeId }
  /** Timed runs only: stop injecting faults, so we can check the work gets finished. */
  | { type: "heal" };

export interface Invariant {
  name: string;
  /** Return a plain-words description of what's wrong, or null if all is well. */
  check(w: World): string | null;
}

export interface NetworkConfig {
  delayMin: number;
  delayMax: number;
  /** Chance each message is lost (timed mode). */
  drop: number;
  /** Chance each message arrives twice (timed mode). */
  duplicate: number;
}

export interface CheckerBudget {
  maxDepth: number;
  maxStates: number;
  /** Crashes the search may inject. Loss and duplication are always possible. */
  crashes: number;
}

export interface ProtocolSpec {
  id: string;
  nodes: { id: NodeId; role: string; label: string }[];
  /** Build each role's handlers from the learner's exports. */
  roles(user: Record<string, unknown>): Record<string, Handlers>;
  /** Commands each client works through, one at a time. */
  workload?: Record<NodeId, unknown[]>;
  /** Smaller workload for the model checker, to keep the search tractable. */
  checkerWorkload?: Record<NodeId, unknown[]>;
  invariants: Invariant[];
  network: NetworkConfig;
  /** Nodes that may crash, and whether they come back with fresh state. */
  crashable?: NodeId[];
  restart?: boolean;
  budget: CheckerBudget;
  /** When the run has done its job. Defaults to: every client finished its workload. */
  done?(w: World): boolean;
}
