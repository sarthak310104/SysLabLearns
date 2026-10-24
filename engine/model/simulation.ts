import { EventQueue } from "../core/eventQueue";
import { Rng } from "../core/rng";
import { Window } from "../core/window";
import { withDefaults } from "./defaults";
import type {
  AnyConfig,
  CacheConfig,
  ClientConfig,
  ComponentKind,
  DatabaseConfig,
  FaultAction,
  Flight,
  Graph,
  GraphEdge,
  Incident,
  LoadBalancerConfig,
  NodeStats,
  NodeStatus,
  QueueConfig,
  ReplicaConfig,
  ServerConfig,
  Snapshot,
} from "./types";

/* ------------------------------------------------------------------ */
/* Requests and frames                                                 */
/* ------------------------------------------------------------------ */

type Op = "read" | "write";

interface Req {
  id: number;
  key: number;
  op: Op;
}

/**
 * One request's visit to one node. Frames link to their parent (the node that
 * sent the request here), so a response always finds its way back upstream.
 *
 * - `pending` is the child call this frame is waiting on. A response from any
 *   other child (one that already timed out, say) is ignored.
 * - A dead frame belongs to a node that crashed: later events for it are ignored.
 */
interface Frame {
  req: Req;
  node: string;
  arrived: number;
  edgeId: string | null;
  parent: Frame | null;
  dead: boolean;
  pending: Frame | null;
  attempts: number;
}

/** A replicated write travelling between databases, or its acknowledgement. */
interface ReplMsg {
  from: string;
  to: string;
  edgeId: string;
  key: number;
  committedAt: number;
  /** For synchronous replication: the write waiting on this message. */
  syncFor: Frame | null;
}

type Ev =
  | { k: "gen"; node: string; send: boolean }
  | { k: "arrive"; frame: Frame }
  | { k: "done"; frame: Frame }
  | { k: "resp"; frame: Frame; ok: boolean; child: Frame }
  | { k: "timeout"; frame: Frame; child: Frame }
  | { k: "retry"; frame: Frame }
  | { k: "repl"; msg: ReplMsg }
  | { k: "replAck"; msg: ReplMsg }
  | { k: "apply"; node: string }
  | { k: "tick"; node: string }
  | { k: "syncTimeout"; frame: Frame };

const STATUS_RANK: Record<NodeStatus, number> = { idle: 0, ok: 1, warning: 2, critical: 3, down: 4 };
const SYNC_TIMEOUT_MS = 500;
const BREAKER_OPEN_MS = 3000;

/* ------------------------------------------------------------------ */
/* Base runtime                                                        */
/* ------------------------------------------------------------------ */

abstract class Runtime {
  down = false;
  slowFactor = 1;
  window = new Window(1000);
  out: GraphEdge[] = [];
  rr = 0;

  private busyIntegral = 0;
  private lastMark = 0;
  private lastSnapIntegral = 0;
  private lastSnapTime = 0;
  private utilEma = 0;
  private ownIntegral = 0;
  private lastSnapOwn = 0;
  private ownEma = 0;

  reportedStatus: NodeStatus = "idle";
  pendingStatus: NodeStatus = "idle";
  pendingCount = 0;
  wasBottleneck = false;
  /** Named conditions already reported as incidents, so each is reported once per occurrence. */
  flags = new Set<string>();

  constructor(
    public id: string,
    public kind: ComponentKind,
    public label: string,
    public config: AnyConfig,
    protected sim: Simulation,
  ) {}

  abstract arrive(f: Frame): void;
  done(_f: Frame): void {}
  resp(_f: Frame, _ok: boolean): void {}
  /** Frames this node is holding right now (queued, working, or waiting on downstream). */
  activeFrames(): Frame[] {
    return [];
  }
  clearActive(): void {}

  get workers(): number {
    return 0;
  }
  get busyCount(): number {
    return 0;
  }
  get queueLength(): number {
    return 0;
  }
  get queueLimit(): number {
    return 0;
  }
  /** Workers doing their own work, not waiting on a downstream answer. */
  get ownBusyCount(): number {
    return this.busyCount;
  }

  /** Call before busyCount changes, to integrate utilization over time. */
  markBusy(): void {
    const now = this.sim.now;
    const dt = now - this.lastMark;
    this.busyIntegral += this.busyCount * dt;
    this.ownIntegral += this.ownBusyCount * dt;
    this.lastMark = now;
  }

  /**
   * Utilization since the last snapshot, smoothed.
   * `total` counts workers waiting on downstream; `own` counts only real work,
   * which is what tells you whether this node is the root cause of slowness.
   */
  sampleUtilization(): { total: number; own: number } {
    this.markBusy();
    const now = this.sim.now;
    const dt = now - this.lastSnapTime;
    if (dt > 0 && this.workers > 0) {
      const alpha = Math.min(1, dt / 500);
      const u = (this.busyIntegral - this.lastSnapIntegral) / (dt * this.workers);
      const o = (this.ownIntegral - this.lastSnapOwn) / (dt * this.workers);
      this.utilEma += alpha * (u - this.utilEma);
      this.ownEma += alpha * (o - this.ownEma);
    }
    this.lastSnapIntegral = this.busyIntegral;
    this.lastSnapOwn = this.ownIntegral;
    this.lastSnapTime = now;
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    return { total: clamp(this.utilEma), own: clamp(this.ownEma) };
  }

  nextEdge(edges: GraphEdge[] = this.out): GraphEdge | undefined {
    if (!edges.length) return undefined;
    return edges[this.rr++ % edges.length];
  }

  crash(): void {
    if (this.down) return;
    this.markBusy();
    this.down = true;
    for (const f of this.activeFrames()) {
      if (f.dead) continue;
      this.sim.reply(f, false);
      f.dead = true;
    }
    this.clearActive();
  }

  recover(): void {
    this.down = false;
  }

  onConfigChange(): void {}

  /** Extra fields for this node's snapshot. */
  extraStats(_s: NodeStats): void {}
}

/* ------------------------------------------------------------------ */
/* Clients: generate traffic, time out and retry                       */
/* ------------------------------------------------------------------ */

class ClientRuntime extends Runtime {
  attemptsWin = new Window(1000);
  startedWin = new Window(1000);
  retriesWin = new Window(1000);

  get cfg(): ClientConfig {
    return this.config as ClientConfig;
  }

  rateAt(t: number): number {
    const { rps, pattern } = this.cfg;
    if (pattern === "spike") {
      const phase = (t % 10000) / 1000;
      return phase >= 6 && phase < 8 ? rps * 4 : rps;
    }
    if (pattern === "ramp") return rps * Math.min(1, t / 30000);
    return rps;
  }

  pickKey(): number {
    const { keySpace, hotShare, topKeyShare } = this.cfg;
    const rng = this.sim.rng;
    if (topKeyShare > 0 && rng.next() < topKeyShare) return 0;
    const space = Math.max(2, Math.floor(keySpace));
    const hot = Math.max(1, Math.floor(space * 0.01));
    if (space - 1 <= hot || rng.next() < hotShare) return 1 + rng.int(hot);
    return 1 + hot + rng.int(space - 1 - hot);
  }

  /**
   * Called on each tick of the client's arrival process. Arrivals are a Poisson
   * process, which is memoryless, so long gaps are re-sampled every 100ms:
   * that way a rate change on the slider takes effect almost immediately.
   */
  gen(send: boolean): void {
    const sim = this.sim;
    if (send && !this.down && this.out.length) {
      const op: Op = sim.rng.next() < this.cfg.writeShare ? "write" : "read";
      const req: Req = { id: sim.nextReqId++, key: this.pickKey(), op };
      const origin: Frame = { req, node: this.id, arrived: sim.now, edgeId: null, parent: null, dead: false, pending: null, attempts: 1 };
      this.startedWin.add(sim.now, 0, true);
      this.attempt(origin);
    }
    const rate = this.rateAt(sim.now);
    const delay = rate > 0 ? sim.rng.exp(1000 / rate) : Infinity;
    if (delay <= 100) sim.schedule(sim.now + delay, { k: "gen", node: this.id, send: true });
    else sim.schedule(sim.now + 100, { k: "gen", node: this.id, send: false });
  }

  attempt(f: Frame): void {
    const edge = this.nextEdge();
    if (!edge) return;
    this.attemptsWin.add(this.sim.now, 0, true);
    this.sim.forward(f, edge, this.cfg.timeoutMs);
  }

  retry(f: Frame): void {
    if (this.down) {
      this.window.add(this.sim.now, this.sim.now - f.arrived, false);
      return;
    }
    this.attempt(f);
  }

  arrive(f: Frame): void {
    this.sim.reply(f, false);
  }

  resp(f: Frame, ok: boolean): void {
    const now = this.sim.now;
    if (ok) {
      this.window.add(now, now - f.arrived, true);
      return;
    }
    if (f.attempts <= Math.floor(this.cfg.retries) && this.withinBudget()) {
      // Exponential backoff with full jitter: wait a random time up to 50ms * 2^n.
      const delay = this.cfg.backoff === "exponential" ? this.sim.rng.next() * 50 * 2 ** (f.attempts - 1) : 0;
      f.attempts++;
      this.retriesWin.add(now, 0, true);
      this.sim.schedule(now + delay, { k: "retry", frame: f });
      return;
    }
    this.window.add(now, now - f.arrived, false);
  }

  /** A retry budget caps retries at a share of new requests, so an outage can't multiply the load. */
  withinBudget(): boolean {
    const budget = this.cfg.retryBudget ?? 0;
    if (!budget) return true;
    const now = this.sim.now;
    const started = this.startedWin.stats(now).okPerSec;
    const retried = this.retriesWin.stats(now).okPerSec;
    return retried < budget * started;
  }

  extraStats(s: NodeStats): void {
    s.sendingRps = this.rateAt(this.sim.now);
    s.attemptsPerSec = this.attemptsWin.stats(this.sim.now).okPerSec;
  }
}

/* ------------------------------------------------------------------ */
/* Worker pools: servers, databases and read replicas                  */
/* ------------------------------------------------------------------ */

interface BreakerState {
  results: boolean[];
  openUntil: number;
  halfOpen: boolean;
}

class PoolRuntime extends Runtime {
  busy = new Set<Frame>();
  queue: Frame[] = [];
  /** Busy workers that are waiting on a downstream answer. */
  waitingDownstream = new Set<Frame>();

  // server
  callEdge = new Map<Frame, string>();
  breakers = new Map<string, BreakerState>();

  // database and replica: key -> time of the latest write this node knows about
  versions = new Map<number, number>();
  // database with peers
  unsynced = new Map<number, number>();
  syncWaiting = new Map<Frame, number>();
  lostUpdates = 0;
  // replica
  primaries: PoolRuntime[] = [];
  applyQueue: { key: number; committedAt: number }[] = [];
  applying = false;
  stale = new Window(1000);

  get ownBusyCount(): number {
    return this.busy.size - this.waitingDownstream.size;
  }
  get cfg(): ServerConfig & DatabaseConfig & ReplicaConfig {
    return this.config as ServerConfig & DatabaseConfig & ReplicaConfig;
  }
  get workers(): number {
    return Math.max(1, Math.floor(this.cfg.workers));
  }
  get busyCount(): number {
    return this.busy.size;
  }
  get queueLength(): number {
    return this.queue.length;
  }
  get queueLimit(): number {
    return Math.max(0, Math.floor(this.cfg.queueLimit));
  }

  arrive(f: Frame): void {
    if (this.down) return this.sim.reply(f, false);
    if (this.kind === "replica" && f.req.op === "write") return this.sim.reply(f, false); // replicas are read-only
    if (this.busy.size < this.workers) this.start(f);
    else if (this.queue.length < this.queueLimit) this.queue.push(f);
    else this.sim.reply(f, false);
  }

  start(f: Frame): void {
    this.markBusy();
    this.busy.add(f);
    const ms = this.sim.rng.erlang2(Math.max(0.1, this.cfg.serviceMs) * this.slowFactor);
    this.sim.schedule(this.sim.now + ms, { k: "done", frame: f });
  }

  done(f: Frame): void {
    if (f.dead || !this.busy.has(f)) return;
    if (this.kind === "server") return this.callDownstream(f);
    if (this.kind === "database" && f.req.op === "write") return this.commit(f);
    if (this.kind === "replica") {
      const primaryV = Math.max(0, ...this.primaries.map((p) => p.versions.get(f.req.key) ?? 0));
      const mine = this.versions.get(f.req.key) ?? 0;
      this.stale.add(this.sim.now, 0, mine >= primaryV);
    }
    this.finish(f, true);
  }

  /* ---------- servers: routing, timeouts, circuit breaker ---------- */

  /** Writes never go to read replicas; reads prefer replicas when there are any. */
  route(op: Op): GraphEdge | undefined {
    let cands = this.out;
    const kindOf = (e: GraphEdge) => this.sim.runtime(e.target)?.kind;
    if (op === "write") cands = cands.filter((e) => kindOf(e) !== "replica");
    else {
      const reps = cands.filter((e) => kindOf(e) === "replica");
      if (reps.length) cands = reps;
    }
    return this.nextEdge(cands);
  }

  callDownstream(f: Frame): void {
    if (!this.out.length) return this.finish(f, true);
    const edge = this.route(f.req.op);
    if (!edge) return this.finish(f, false);
    if (this.cfg.breaker && this.breakerOpen(edge.id)) return this.finish(f, false); // fail fast
    this.markBusy();
    this.waitingDownstream.add(f);
    this.callEdge.set(f, edge.id);
    this.sim.forward(f, edge, this.cfg.timeoutMs);
  }

  breaker(edgeId: string): BreakerState {
    let b = this.breakers.get(edgeId);
    if (!b) this.breakers.set(edgeId, (b = { results: [], openUntil: 0, halfOpen: false }));
    return b;
  }

  breakerOpen(edgeId: string): boolean {
    const b = this.breaker(edgeId);
    if (this.sim.now < b.openUntil) return true;
    if (b.openUntil > 0 && !b.halfOpen) b.halfOpen = true; // let trial calls through
    return false;
  }

  recordCall(edgeId: string, ok: boolean): void {
    if (!this.cfg.breaker) return;
    const b = this.breaker(edgeId);
    if (b.halfOpen) {
      b.halfOpen = false;
      b.results = [];
      b.openUntil = ok ? 0 : this.sim.now + BREAKER_OPEN_MS;
      return;
    }
    b.results.push(ok);
    if (b.results.length > 20) b.results.shift();
    const fails = b.results.filter((r) => !r).length;
    if (b.results.length >= 10 && fails / b.results.length >= 0.5) {
      b.openUntil = this.sim.now + BREAKER_OPEN_MS;
      b.results = [];
    }
  }

  resp(f: Frame, ok: boolean): void {
    if (f.dead || !this.busy.has(f)) return;
    const edgeId = this.callEdge.get(f);
    if (edgeId) {
      this.callEdge.delete(f);
      this.recordCall(edgeId, ok);
    }
    this.finish(f, ok);
  }

  /* ---------- databases: commits and replication ---------- */

  peerEdges(): GraphEdge[] {
    return this.out.filter((e) => this.sim.runtime(e.target)?.kind === "database");
  }
  replicaEdges(): GraphEdge[] {
    return this.out.filter((e) => this.sim.runtime(e.target)?.kind === "replica");
  }

  commit(f: Frame): void {
    const peers = this.peerEdges();
    const now = this.sim.now;
    if (this.cfg.mode === "sync" && peers.length) {
      // Synchronous: the write only counts once every peer has it.
      this.markBusy();
      this.waitingDownstream.add(f);
      this.syncWaiting.set(f, peers.length);
      for (const e of peers) this.sim.replicate({ from: this.id, to: e.target, edgeId: e.id, key: f.req.key, committedAt: now, syncFor: f });
      this.sim.schedule(now + SYNC_TIMEOUT_MS, { k: "syncTimeout", frame: f });
      return;
    }
    this.applyLocal(f.req.key, now, peers.length > 0);
    for (const e of peers) this.sim.replicate({ from: this.id, to: e.target, edgeId: e.id, key: f.req.key, committedAt: now, syncFor: null });
    this.finish(f, true);
  }

  applyLocal(key: number, at: number, trackUnsynced: boolean): void {
    this.versions.set(key, Math.max(this.versions.get(key) ?? 0, at));
    if (trackUnsynced) this.unsynced.set(key, at);
    for (const e of this.replicaEdges()) this.sim.replicate({ from: this.id, to: e.target, edgeId: e.id, key, committedAt: at, syncFor: null });
  }

  /** A replicated write arrives from a primary or peer. */
  onRepl(m: ReplMsg): void {
    if (this.down) return;
    if (this.kind === "replica") {
      this.applyQueue.push({ key: m.key, committedAt: m.committedAt });
      this.startApply();
      return;
    }
    // Peer database. A local write to the same key that the peer hasn't seen yet
    // means two regions changed the same thing: one of them will be lost.
    if (this.unsynced.has(m.key) && this.id > m.from) this.lostUpdates++;
    this.versions.set(m.key, Math.max(this.versions.get(m.key) ?? 0, m.committedAt));
    for (const e of this.replicaEdges()) this.sim.replicate({ from: this.id, to: e.target, edgeId: e.id, key: m.key, committedAt: m.committedAt, syncFor: null });
    this.sim.replicateAck({ ...m, from: this.id, to: m.from });
  }

  onReplAck(m: ReplMsg): void {
    if (m.syncFor) {
      const f = m.syncFor;
      const left = this.syncWaiting.get(f);
      if (left === undefined || f.dead) return;
      if (left > 1) {
        this.syncWaiting.set(f, left - 1);
        return;
      }
      this.syncWaiting.delete(f);
      this.applyLocal(f.req.key, m.committedAt, false);
      this.finish(f, true);
      return;
    }
    const t = this.unsynced.get(m.key);
    if (t !== undefined && t <= m.committedAt) this.unsynced.delete(m.key);
  }

  onSyncTimeout(f: Frame): void {
    if (!this.syncWaiting.has(f) || f.dead) return;
    this.syncWaiting.delete(f);
    this.finish(f, false);
  }

  /* ---------- replicas: a single applier that slows down under read load ---------- */

  startApply(): void {
    if (this.applying || this.down || !this.applyQueue.length) return;
    this.applying = true;
    const load = this.busy.size / this.workers;
    const ms = this.sim.rng.erlang2(Math.max(0.1, this.cfg.applyMs) * this.slowFactor * (1 + 2 * load));
    this.sim.schedule(this.sim.now + ms, { k: "apply", node: this.id });
  }

  onApply(): void {
    this.applying = false;
    if (this.down) return;
    const item = this.applyQueue.shift();
    if (item) this.versions.set(item.key, Math.max(this.versions.get(item.key) ?? 0, item.committedAt));
    this.startApply();
  }

  lagMs(): number {
    return this.applyQueue.length ? this.sim.now - this.applyQueue[0].committedAt : 0;
  }

  /* ---------- common ---------- */

  finish(f: Frame, ok: boolean): void {
    this.markBusy();
    this.busy.delete(f);
    this.waitingDownstream.delete(f);
    this.callEdge.delete(f);
    this.syncWaiting.delete(f);
    this.sim.reply(f, ok);
    this.pull();
  }

  pull(): void {
    while (!this.down && this.busy.size < this.workers && this.queue.length) {
      const next = this.queue.shift()!;
      if (!next.dead) this.start(next);
    }
  }

  recover(): void {
    super.recover();
    this.startApply();
  }

  onConfigChange(): void {
    this.pull();
    while (this.queue.length > this.queueLimit) this.sim.reply(this.queue.pop()!, false);
    // A new timeout also applies to calls that are already waiting, so stuck workers can recover.
    const t = this.kind === "server" ? this.cfg.timeoutMs : 0;
    if (t > 0) for (const f of this.waitingDownstream) if (f.pending) this.sim.schedule(this.sim.now + t, { k: "timeout", frame: f, child: f.pending });
  }

  activeFrames(): Frame[] {
    return [...this.busy, ...this.queue];
  }
  clearActive(): void {
    this.busy.clear();
    this.waitingDownstream.clear();
    this.callEdge.clear();
    this.syncWaiting.clear();
    this.queue = [];
  }

  extraStats(s: NodeStats): void {
    if (this.kind === "replica") {
      s.lagMs = this.lagMs();
      s.staleRate = this.stale.stats(this.sim.now).errorRate;
    }
    if (this.kind === "database" && this.peerEdges().length) {
      s.unreplicated = this.unsynced.size;
      s.lostUpdates = this.lostUpdates;
    }
    if (this.kind === "server" && this.cfg.breaker) {
      s.breakerOpen = [...this.breakers.values()].some((b) => this.sim.now < b.openUntil);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Load balancer                                                       */
/* ------------------------------------------------------------------ */

/** Spreads keys evenly across shards: the same key always lands on the same one. */
function hashKey(key: number): number {
  let h = Math.imul(key ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

class LoadBalancerRuntime extends Runtime {
  waiting = new Map<Frame, string>();
  outstanding = new Map<string, number>();
  tokens = 0;
  lastRefill = 0;
  limited = new Window(1000);

  get cfg(): LoadBalancerConfig {
    return this.config as LoadBalancerConfig;
  }

  /** Token bucket: refills at the limit per second, with a small burst allowance. */
  allow(): boolean {
    const limit = this.cfg.rateLimit;
    if (!limit) return true;
    const now = this.sim.now;
    const burst = Math.max(1, limit / 10);
    this.tokens = Math.min(burst, this.tokens + ((now - this.lastRefill) / 1000) * limit);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  arrive(f: Frame): void {
    if (this.down) return this.sim.reply(f, false);
    if (!this.allow()) {
      this.limited.add(this.sim.now, 0, true);
      return this.sim.reply(f, false);
    }
    this.sim.schedule(this.sim.now + 0.3, { k: "done", frame: f });
  }

  done(f: Frame): void {
    if (f.dead || this.down) return;
    let edge: GraphEdge | undefined;
    if (this.cfg.strategy === "keyHash") {
      // Sharding: the key decides the target, healthy or not. Moving a key would mean moving its data.
      edge = this.out.length ? this.out[hashKey(f.req.key) % this.out.length] : undefined;
      if (edge && this.cfg.healthChecks && this.sim.runtime(edge.target)?.down) edge = undefined;
    } else {
      let cands = this.out;
      if (this.cfg.healthChecks) cands = cands.filter((e) => !this.sim.runtime(e.target)?.down);
      if (cands.length) {
        if (this.cfg.strategy === "random") edge = cands[this.sim.rng.int(cands.length)];
        else if (this.cfg.strategy === "leastConnections") {
          let best = Infinity;
          const start = this.rr++ % cands.length;
          for (let i = 0; i < cands.length; i++) {
            const e = cands[(start + i) % cands.length];
            const n = this.outstanding.get(e.id) ?? 0;
            if (n < best) {
              best = n;
              edge = e;
            }
          }
        } else edge = cands[this.rr++ % cands.length];
      }
    }
    if (!edge) return this.sim.reply(f, false);
    this.outstanding.set(edge.id, (this.outstanding.get(edge.id) ?? 0) + 1);
    this.waiting.set(f, edge.id);
    this.sim.forward(f, edge);
  }

  resp(f: Frame, ok: boolean): void {
    if (f.dead) return;
    const edgeId = this.waiting.get(f);
    if (edgeId === undefined) return;
    this.waiting.delete(f);
    this.outstanding.set(edgeId, Math.max(0, (this.outstanding.get(edgeId) ?? 1) - 1));
    this.sim.reply(f, ok);
  }

  activeFrames(): Frame[] {
    return [...this.waiting.keys()];
  }
  clearActive(): void {
    this.waiting.clear();
    this.outstanding.clear();
  }

  extraStats(s: NodeStats): void {
    if (this.cfg.rateLimit) s.limitedPerSec = this.limited.stats(this.sim.now).okPerSec;
  }
}

/* ------------------------------------------------------------------ */
/* Cache: LRU with TTL in front of a downstream                        */
/* ------------------------------------------------------------------ */

class CacheRuntime extends Runtime {
  entries = new Map<number, number>(); // key -> expiresAt, Map order = LRU order
  waiting = new Set<Frame>();
  lookups = new Window(1000);

  get cfg(): CacheConfig {
    return this.config as CacheConfig;
  }

  arrive(f: Frame): void {
    if (this.down) return this.sim.reply(f, false);
    const now = this.sim.now;
    const key = f.req.key;
    if (f.req.op === "write") {
      // Writes go through to storage and invalidate the cached copy.
      this.entries.delete(key);
    } else {
      const exp = this.entries.get(key);
      if (exp !== undefined && exp > now) {
        this.entries.delete(key);
        this.entries.set(key, exp);
        this.lookups.add(now, 0, true);
        this.sim.schedule(now + 1, { k: "done", frame: f });
        return;
      }
      if (exp !== undefined) this.entries.delete(key);
      this.lookups.add(now, 0, false);
    }
    const edge = this.nextEdge();
    if (!edge) return this.sim.reply(f, false);
    this.waiting.add(f);
    this.sim.forward(f, edge);
  }

  done(f: Frame): void {
    if (f.dead || this.down) return;
    this.sim.reply(f, true);
  }

  resp(f: Frame, ok: boolean): void {
    if (f.dead || !this.waiting.has(f)) return;
    this.waiting.delete(f);
    if (ok && f.req.op === "read") {
      this.entries.set(f.req.key, this.sim.now + Math.max(1, this.cfg.ttlMs));
      this.trim();
    }
    this.sim.reply(f, ok);
  }

  trim(): void {
    const cap = Math.max(1, Math.floor(this.cfg.capacity));
    while (this.entries.size > cap) this.entries.delete(this.entries.keys().next().value!);
  }

  crash(): void {
    super.crash();
    this.entries.clear(); // a restarted cache comes back cold
  }

  onConfigChange(): void {
    this.trim();
  }

  activeFrames(): Frame[] {
    return [...this.waiting];
  }
  clearActive(): void {
    this.waiting.clear();
  }

  extraStats(s: NodeStats): void {
    const l = this.lookups.stats(this.sim.now);
    const total = l.okPerSec + l.errorsPerSec;
    s.hitRatio = total ? l.okPerSec / total : 0;
  }
}

/* ------------------------------------------------------------------ */
/* Queue: accept now, deliver to consumers as they have room           */
/* ------------------------------------------------------------------ */

interface Message {
  req: Req;
  enqueuedAt: number;
  deliveries: number;
}

class QueueRuntime extends Runtime {
  backlog: Message[] = [];
  inflight = new Map<Frame, { msg: Message; edgeId: string }>();
  inflightPerEdge = new Map<string, number>();
  processed = new Window(1000);
  deadLetters = 0;
  tickScheduled = false;

  get cfg(): QueueConfig {
    return this.config as QueueConfig;
  }
  get queueLength(): number {
    return this.backlog.length;
  }
  get queueLimit(): number {
    return Math.max(1, Math.floor(this.cfg.capacity));
  }

  arrive(f: Frame): void {
    if (this.down || this.backlog.length >= this.queueLimit) return this.sim.reply(f, false);
    this.backlog.push({ req: f.req, enqueuedAt: this.sim.now, deliveries: 0 });
    // The producer gets its answer straight away: "accepted", not "done".
    this.sim.schedule(this.sim.now + 0.5, { k: "done", frame: f });
    this.dispatch();
  }

  done(f: Frame): void {
    if (f.dead) return;
    this.sim.reply(f, true);
  }

  dispatch(): void {
    if (this.down) return;
    let progress = true;
    while (this.backlog.length && progress) {
      progress = false;
      for (let i = 0; i < this.out.length && this.backlog.length; i++) {
        const edge = this.out[this.rr++ % this.out.length];
        const consumer = this.sim.runtime(edge.target);
        if (!consumer || consumer.down) continue;
        const inflight = this.inflightPerEdge.get(edge.id) ?? 0;
        if (inflight >= consumer.workers) continue;
        const msg = this.backlog.shift()!;
        msg.deliveries++;
        const mf: Frame = { req: msg.req, node: this.id, arrived: this.sim.now, edgeId: null, parent: null, dead: false, pending: null, attempts: 0 };
        this.inflight.set(mf, { msg, edgeId: edge.id });
        this.inflightPerEdge.set(edge.id, inflight + 1);
        this.sim.forward(mf, edge);
        progress = true;
      }
    }
    if (this.backlog.length && !this.tickScheduled) {
      this.tickScheduled = true;
      this.sim.schedule(this.sim.now + 20, { k: "tick", node: this.id });
    }
  }

  tick(): void {
    this.tickScheduled = false;
    this.dispatch();
  }

  resp(mf: Frame, ok: boolean): void {
    const entry = this.inflight.get(mf);
    if (!entry) return;
    this.inflight.delete(mf);
    this.inflightPerEdge.set(entry.edgeId, Math.max(0, (this.inflightPerEdge.get(entry.edgeId) ?? 1) - 1));
    const { msg } = entry;
    if (ok) this.processed.add(this.sim.now, this.sim.now - msg.enqueuedAt, true);
    else if (msg.deliveries >= Math.max(1, this.cfg.maxRetries)) {
      this.deadLetters++;
      this.processed.add(this.sim.now, this.sim.now - msg.enqueuedAt, false);
    } else this.backlog.push(msg); // try again later
    this.dispatch();
  }

  crash(): void {
    if (this.down) return;
    this.down = true;
    // Messages are durable: anything out for delivery goes back on the queue.
    for (const [mf, { msg }] of this.inflight) {
      mf.dead = true;
      this.backlog.unshift(msg);
    }
    this.inflight.clear();
    this.inflightPerEdge.clear();
  }

  recover(): void {
    super.recover();
    this.dispatch();
  }

  onConfigChange(): void {
    this.dispatch();
  }

  extraStats(s: NodeStats): void {
    const p = this.processed.stats(this.sim.now);
    s.processedPerSec = p.okPerSec;
    s.oldestAgeMs = this.backlog.length ? this.sim.now - Math.min(...this.backlog.slice(0, 50).map((m) => m.enqueuedAt)) : 0;
    s.deadLetters = this.deadLetters;
  }
}

/* ------------------------------------------------------------------ */
/* Simulation                                                          */
/* ------------------------------------------------------------------ */

const FLIGHT_CAP_PER_EDGE = 3;

export class Simulation {
  now = 0;
  rng: Rng;
  nextReqId = 1;

  private queue = new EventQueue<Ev>();
  private runtimes = new Map<string, Runtime>();
  private edges = new Map<string, GraphEdge>();
  private cut = new Set<string>();
  private buffered = new Map<string, Ev[]>();
  private flights: Flight[] = [];
  private flightCounts = new Map<string, number>();
  private incidents: Incident[] = [];
  private incidentId = 1;

  constructor(graph: Graph, seed = 42) {
    this.rng = new Rng(seed);
    for (const n of graph.nodes) this.addRuntime(n);
    this.wire(graph.edges);
  }

  private addRuntime(n: Graph["nodes"][number]): void {
    const args = [n.id, n.kind, n.label, withDefaults(n.kind, n.config), this] as const;
    const rt =
      n.kind === "client"
        ? new ClientRuntime(...args)
        : n.kind === "loadBalancer"
          ? new LoadBalancerRuntime(...args)
          : n.kind === "cache"
            ? new CacheRuntime(...args)
            : n.kind === "queue"
              ? new QueueRuntime(...args)
              : new PoolRuntime(...args);
    this.runtimes.set(n.id, rt);
    if (rt instanceof ClientRuntime) this.queue.push(this.now + this.rng.next() * 5, { k: "gen", node: rt.id, send: false });
  }

  /** (Re)build every node's outgoing links and each replica's list of primaries. */
  private wire(edges: GraphEdge[]): void {
    this.edges.clear();
    for (const rt of this.runtimes.values()) {
      rt.out = [];
      if (rt instanceof PoolRuntime) rt.primaries = [];
    }
    for (const e of edges) {
      const from = this.runtimes.get(e.source);
      const to = this.runtimes.get(e.target);
      if (!from || !to) continue;
      this.edges.set(e.id, e);
      from.out.push(e);
      if (to instanceof PoolRuntime && to.kind === "replica" && from instanceof PoolRuntime && from.kind === "database") {
        to.primaries.push(from);
      }
    }
    for (const id of [...this.cut]) if (!this.edges.has(id)) this.cut.delete(id);
    for (const id of [...this.buffered.keys()]) if (!this.edges.has(id)) this.buffered.delete(id);
  }

  /**
   * Apply an edited graph to the running system without restarting it:
   * new components start empty, removed ones fail whatever they were holding,
   * and everything else keeps its state, queues and caches.
   */
  applyGraph(graph: Graph): void {
    const next = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const [id, rt] of [...this.runtimes]) {
      const n = next.get(id);
      if (!n || n.kind !== rt.kind) {
        rt.crash();
        this.runtimes.delete(id);
      }
    }
    for (const n of graph.nodes) {
      const rt = this.runtimes.get(n.id);
      if (!rt) this.addRuntime(n);
      else {
        rt.label = n.label;
        const cfg = withDefaults(n.kind, n.config);
        if (JSON.stringify(cfg) !== JSON.stringify(rt.config)) this.updateConfig(n.id, cfg);
      }
    }
    this.wire(graph.edges);
    for (const rt of this.runtimes.values()) if (rt instanceof QueueRuntime) rt.dispatch();
  }

  runtime(id: string): Runtime | undefined {
    return this.runtimes.get(id);
  }

  schedule(time: number, ev: Ev): void {
    this.queue.push(time, ev);
  }

  /** Network delay for one hop. Links between two databases are cross-region. */
  private hop(edgeId: string): number {
    const e = this.edges.get(edgeId);
    const crossRegion = e && this.runtimes.get(e.source)?.kind === "database" && this.runtimes.get(e.target)?.kind === "database";
    return crossRegion ? 40 + this.rng.next() * 4 : 1 + this.rng.next();
  }

  private recordFlight(edgeId: string, dir: "fwd" | "back", ok: boolean): void {
    const key = edgeId + dir + (ok ? "" : "x");
    const n = this.flightCounts.get(key) ?? 0;
    if (n >= FLIGHT_CAP_PER_EDGE) return;
    this.flightCounts.set(key, n + 1);
    this.flights.push({ edgeId, dir, ok });
  }

  /** Send a request along an edge. Over a cut link it is simply lost. */
  forward(from: Frame, edge: GraphEdge, timeoutMs = 0): void {
    const child: Frame = { req: from.req, node: edge.target, arrived: 0, edgeId: edge.id, parent: from, dead: false, pending: null, attempts: 0 };
    from.pending = child;
    if (timeoutMs > 0) this.queue.push(this.now + timeoutMs, { k: "timeout", frame: from, child });
    if (this.cut.has(edge.id)) {
      this.recordFlight(edge.id, "fwd", false);
      return;
    }
    const at = this.now + this.hop(edge.id);
    child.arrived = at;
    this.recordFlight(edge.id, "fwd", true);
    this.queue.push(at, { k: "arrive", frame: child });
  }

  /** A node finished with a request: record it and send the response upstream. */
  reply(f: Frame, ok: boolean): void {
    const rt = this.runtimes.get(f.node);
    if (rt && f.parent) rt.window.add(this.now, this.now - f.arrived, ok);
    const parent = f.parent;
    if (!parent || parent.dead || !f.edgeId) return;
    if (this.cut.has(f.edgeId)) {
      this.recordFlight(f.edgeId, "back", false);
      return;
    }
    this.recordFlight(f.edgeId, "back", ok);
    this.queue.push(this.now + this.hop(f.edgeId), { k: "resp", frame: parent, ok, child: f });
  }

  /**
   * Send replication traffic. Over a cut link, asynchronous replication waits
   * in a buffer and catches up when the link heals; synchronous messages are lost.
   */
  replicate(msg: ReplMsg): void {
    this.sendRepl({ k: "repl", msg });
  }
  replicateAck(msg: ReplMsg): void {
    this.sendRepl({ k: "replAck", msg });
  }
  private sendRepl(ev: { k: "repl" | "replAck"; msg: ReplMsg }): void {
    const { edgeId } = ev.msg;
    if (this.cut.has(edgeId)) {
      if (!ev.msg.syncFor) {
        let buf = this.buffered.get(edgeId);
        if (!buf) this.buffered.set(edgeId, (buf = []));
        buf.push(ev);
      }
      return;
    }
    if (ev.k === "repl") this.recordFlight(edgeId, "fwd", true);
    this.queue.push(this.now + this.hop(edgeId), ev);
  }

  runUntil(t: number): void {
    while (this.queue.peekTime() <= t) {
      const item = this.queue.pop()!;
      this.now = item.time;
      this.dispatch(item.event);
    }
    this.now = Math.max(this.now, t);
  }

  private dispatch(ev: Ev): void {
    switch (ev.k) {
      case "gen": {
        const rt = this.runtimes.get(ev.node);
        if (rt instanceof ClientRuntime) rt.gen(ev.send);
        return;
      }
      case "retry": {
        const rt = this.runtimes.get(ev.frame.node);
        if (rt instanceof ClientRuntime) rt.retry(ev.frame);
        return;
      }
      case "resp":
      case "timeout": {
        const fr = ev.frame;
        if (fr.pending !== ev.child) return; // a late answer to a call we already gave up on
        fr.pending = null;
        this.runtimes.get(fr.node)?.resp(fr, ev.k === "resp" ? ev.ok : false);
        return;
      }
      case "repl":
      case "replAck": {
        const rt = this.runtimes.get(ev.msg.to);
        if (!(rt instanceof PoolRuntime)) return;
        if (ev.k === "repl") rt.onRepl(ev.msg);
        else rt.onReplAck(ev.msg);
        return;
      }
      case "apply": {
        const rt = this.runtimes.get(ev.node);
        if (rt instanceof PoolRuntime) rt.onApply();
        return;
      }
      case "tick": {
        const rt = this.runtimes.get(ev.node);
        if (rt instanceof QueueRuntime) rt.tick();
        return;
      }
      case "syncTimeout": {
        const rt = this.runtimes.get(ev.frame.node);
        if (rt instanceof PoolRuntime) rt.onSyncTimeout(ev.frame);
        return;
      }
      case "arrive":
      case "done": {
        const rt = this.runtimes.get(ev.frame.node);
        if (!rt) {
          // The component was removed while this request was on its way: it fails.
          if (ev.k === "arrive") this.reply(ev.frame, false);
          return;
        }
        if (ev.k === "arrive") rt.arrive(ev.frame);
        else rt.done(ev.frame);
        return;
      }
    }
  }

  updateConfig(nodeId: string, config: AnyConfig): void {
    const rt = this.runtimes.get(nodeId);
    if (!rt) return;
    rt.markBusy();
    rt.config = withDefaults(rt.kind, config);
    rt.onConfigChange();
  }

  applyFault(action: FaultAction): void {
    if (action.type === "cut" || action.type === "heal") {
      for (const id of action.edgeIds) {
        const e = this.edges.get(id);
        if (!e) continue;
        if (action.type === "cut") this.cut.add(id);
        else if (this.cut.delete(id)) {
          for (const ev of this.buffered.get(id) ?? []) this.queue.push(this.now + this.hop(id), ev);
          this.buffered.delete(id);
        }
      }
      const e = this.edges.get(action.edgeIds[0]);
      if (e) {
        const a = this.runtimes.get(e.source)?.label ?? e.source;
        const b = this.runtimes.get(e.target)?.label ?? e.target;
        if (action.type === "cut") this.pushIncident(e.source, "critical", `The network between ${a} and ${b} is cut.`);
        else this.pushIncident(e.source, "info", `The network between ${a} and ${b} is back.`);
      }
      return;
    }
    const rt = this.runtimes.get(action.nodeId);
    if (!rt) return;
    if (action.type === "crash") rt.crash();
    else if (action.type === "recover") rt.recover();
    else rt.slowFactor = Math.max(1, action.factor);
  }

  /** Current metrics for every node, plus animation samples and new incidents since the last snapshot. */
  snapshot(): Snapshot {
    const nodes: Record<string, NodeStats> = {};
    let bottleneck: string | null = null;
    let bottleneckScore = 0;

    for (const rt of this.runtimes.values()) {
      const w = rt.window.stats(this.now);
      const { total: utilization, own: workUtilization } = rt.sampleUtilization();
      const queue = rt.queueLength;
      const queueLimit = rt.queueLimit;
      const queueFrac = queueLimit ? queue / queueLimit : 0;
      const stats: NodeStats = {
        id: rt.id,
        kind: rt.kind,
        status: "idle",
        down: rt.down,
        slowFactor: rt.slowFactor,
        okPerSec: w.okPerSec,
        errorsPerSec: w.errorsPerSec,
        errorRate: w.errorRate,
        p50: w.p50,
        p99: w.p99,
        queue,
        queueLimit,
        busy: rt.busyCount,
        workers: rt.workers,
        utilization,
        workUtilization,
        bottleneck: false,
      };
      rt.extraStats(stats);
      stats.status = this.statusOf(stats, queueFrac);

      // The bottleneck is the node saturated by its own work. A server stuck
      // waiting on a slow database is a victim, not the cause.
      if ((rt.kind === "server" || rt.kind === "database" || rt.kind === "replica") && !rt.down) {
        const score = workUtilization + (workUtilization > 0.8 ? queueFrac : 0);
        if (workUtilization > 0.9 && score > bottleneckScore) {
          bottleneckScore = score;
          bottleneck = rt.id;
        }
      }
      nodes[rt.id] = stats;
    }
    if (bottleneck) nodes[bottleneck].bottleneck = true;

    this.detectIncidents(nodes);

    const snap: Snapshot = {
      time: this.now,
      nodes,
      flights: this.flights,
      incidents: this.incidents,
      cutEdges: [...this.cut],
    };
    this.flights = [];
    this.flightCounts.clear();
    this.incidents = [];
    return snap;
  }

  private statusOf(s: NodeStats, queueFrac: number): NodeStatus {
    if (s.down) return "down";
    const active = s.okPerSec + s.errorsPerSec > 0 || s.busy > 0;
    if (s.kind === "queue") {
      if (queueFrac > 0.8 || s.errorRate > 0.05) return "critical";
      if (queueFrac > 0.2 || (s.oldestAgeMs ?? 0) > 5000 || (s.deadLetters ?? 0) > 0) return "warning";
      return active || s.queue > 0 ? "ok" : "idle";
    }
    if (s.kind === "server" || s.kind === "database" || s.kind === "replica") {
      if (s.errorRate > 0.05 || queueFrac > 0.8) return "critical";
      if (s.utilization > 0.85 || queueFrac > 0.2 || s.errorRate > 0.005 || (s.lagMs ?? 0) > 1000 || s.breakerOpen) return "warning";
      return active ? "ok" : "idle";
    }
    if (s.errorRate > 0.05) return "critical";
    if (s.errorRate > 0.005) return "warning";
    return active ? "ok" : "idle";
  }

  private detectIncidents(nodes: Record<string, NodeStats>): void {
    for (const rt of this.runtimes.values()) {
      const s = nodes[rt.id];
      // Hysteresis: a status must hold for 3 snapshots before it is reported.
      if (s.status === rt.pendingStatus) rt.pendingCount++;
      else {
        rt.pendingStatus = s.status;
        rt.pendingCount = 1;
      }
      const stable = s.status === "down" || rt.pendingCount >= 3;
      if (stable && s.status !== rt.reportedStatus) {
        const before = rt.reportedStatus;
        rt.reportedStatus = s.status;
        const text = this.describe(rt, s, before);
        if (text) this.pushIncident(rt.id, text.severity, text.text);
      }
      if (s.bottleneck && !rt.wasBottleneck) {
        this.pushIncident(rt.id, "warning", `${rt.label} is the bottleneck: it saturates before anything else.`);
      }
      rt.wasBottleneck = s.bottleneck;

      this.flagIncident(rt, "lag", (s.lagMs ?? 0) > 1000, "warning", () => `${rt.label} is falling behind: its reads are ${(s.lagMs! / 1000).toFixed(1)} s out of date.`);
      this.flagIncident(rt, "breaker", Boolean(s.breakerOpen), "warning", () => `${rt.label}'s circuit breaker opened: it now fails fast instead of waiting on a broken dependency.`);
      this.flagIncident(rt, "backlog", (s.oldestAgeMs ?? 0) > 5000, "warning", () => `${rt.label} is backing up: the oldest message has waited ${((s.oldestAgeMs ?? 0) / 1000).toFixed(0)} s.`);
      const lost = s.lostUpdates ?? 0;
      const prevLost = (rt as unknown as { reportedLost?: number }).reportedLost ?? 0;
      if (lost > prevLost && s.unreplicated === 0) {
        this.pushIncident(rt.id, "critical", `${lost - prevLost} writes on ${rt.label} conflicted with the other region and one side was overwritten.`);
        (rt as unknown as { reportedLost?: number }).reportedLost = lost;
      }
    }
  }

  private flagIncident(rt: Runtime, flag: string, active: boolean, severity: Incident["severity"], text: () => string): void {
    if (active && !rt.flags.has(flag)) {
      rt.flags.add(flag);
      this.pushIncident(rt.id, severity, text());
    } else if (!active) rt.flags.delete(flag);
  }

  private describe(
    rt: Runtime,
    s: NodeStats,
    before: NodeStatus,
  ): { severity: Incident["severity"]; text: string } | null {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    if (s.status === "down") return { severity: "critical", text: `${rt.label} is down.` };
    if (s.status === "critical") {
      if (s.queueLimit && s.queue >= s.queueLimit * 0.8)
        return { severity: "critical", text: `${rt.label}'s queue is almost full: new requests get rejected.` };
      return { severity: "critical", text: `${rt.label} is failing ${pct(s.errorRate)} of requests.` };
    }
    if (s.status === "warning" && STATUS_RANK[before] < STATUS_RANK.warning) {
      if (s.workers && s.utilization > 0.85) return { severity: "warning", text: `${rt.label} is running hot: ${pct(s.utilization)} busy.` };
      if (s.errorRate > 0.005) return { severity: "warning", text: `${rt.label} is returning some errors.` };
      return null;
    }
    if ((s.status === "ok" || s.status === "idle") && STATUS_RANK[before] >= STATUS_RANK.critical) {
      return { severity: "info", text: `${rt.label} recovered.` };
    }
    return null;
  }

  private pushIncident(nodeId: string, severity: Incident["severity"], text: string): void {
    this.incidents.push({ id: this.incidentId++, time: this.now, nodeId, severity, text });
  }
}
