import { EventQueue } from "../core/eventQueue";
import { Rng } from "../core/rng";
import { Window } from "../core/window";
import type {
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
  ServerConfig,
  Snapshot,
  AnyConfig,
} from "./types";

/* ------------------------------------------------------------------ */
/* Requests and frames                                                 */
/* ------------------------------------------------------------------ */

interface Req {
  id: number;
  key: number;
}

/**
 * One request's visit to one node. Frames link to their parent (the node that
 * sent the request here), so a response always finds its way back upstream.
 * A dead frame belongs to a node that crashed: later events for it are ignored.
 */
interface Frame {
  req: Req;
  node: string;
  arrived: number;
  edgeId: string | null;
  parent: Frame | null;
  dead: boolean;
}

type Ev =
  | { k: "gen"; node: string; send: boolean }
  | { k: "arrive"; frame: Frame }
  | { k: "done"; frame: Frame }
  | { k: "resp"; frame: Frame; ok: boolean };

const STATUS_RANK: Record<NodeStatus, number> = { idle: 0, ok: 1, warning: 2, critical: 3, down: 4 };

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
  abstract activeFrames(): Frame[];
  abstract clearActive(): void;

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

  nextEdge(): GraphEdge | undefined {
    if (!this.out.length) return undefined;
    const e = this.out[this.rr % this.out.length];
    this.rr++;
    return e;
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
}

/* ------------------------------------------------------------------ */
/* Clients: generate traffic                                           */
/* ------------------------------------------------------------------ */

class ClientRuntime extends Runtime {
  sent = new Window(1000);

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
    const { keySpace, hotShare } = this.cfg;
    const space = Math.max(1, Math.floor(keySpace));
    const hot = Math.max(1, Math.floor(space * 0.01));
    const rng = this.sim.rng;
    if (space <= hot || rng.next() < hotShare) return rng.int(hot);
    return hot + rng.int(space - hot);
  }

  /**
   * Called on each tick of the client's arrival process. Arrivals are a Poisson
   * process, which is memoryless, so long gaps are re-sampled every 100ms:
   * that way a rate change on the slider takes effect almost immediately.
   */
  gen(send: boolean): void {
    const sim = this.sim;
    if (send && !this.down && this.out.length) {
      const req: Req = { id: sim.nextReqId++, key: this.pickKey() };
      const origin: Frame = { req, node: this.id, arrived: sim.now, edgeId: null, parent: null, dead: false };
      this.sent.add(sim.now, 0, true);
      sim.forward(origin, this.nextEdge()!);
    }
    const rate = this.rateAt(sim.now);
    const delay = rate > 0 ? sim.rng.exp(1000 / rate) : Infinity;
    if (delay <= 100) sim.schedule(sim.now + delay, { k: "gen", node: this.id, send: true });
    else sim.schedule(sim.now + 100, { k: "gen", node: this.id, send: false });
  }

  arrive(f: Frame): void {
    this.sim.reply(f, false);
  }

  resp(f: Frame, ok: boolean): void {
    this.window.add(this.sim.now, this.sim.now - f.arrived, ok);
  }

  activeFrames(): Frame[] {
    return [];
  }
  clearActive(): void {}
}

/* ------------------------------------------------------------------ */
/* Servers and databases: worker pools with a bounded queue            */
/* ------------------------------------------------------------------ */

class PoolRuntime extends Runtime {
  busy = new Set<Frame>();
  queue: Frame[] = [];
  /** Busy workers that are waiting on a downstream answer. */
  waitingDownstream = new Set<Frame>();

  get ownBusyCount(): number {
    return this.busy.size - this.waitingDownstream.size;
  }

  get cfg(): ServerConfig | DatabaseConfig {
    return this.config as ServerConfig;
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
    // A server with a downstream keeps its worker while it waits for the answer.
    const edge = this.kind === "server" ? this.nextEdge() : undefined;
    if (edge) {
      this.markBusy();
      this.waitingDownstream.add(f);
      this.sim.forward(f, edge);
    } else this.finish(f, true);
  }

  resp(f: Frame, ok: boolean): void {
    if (f.dead || !this.busy.has(f)) return;
    this.finish(f, ok);
  }

  finish(f: Frame, ok: boolean): void {
    this.markBusy();
    this.busy.delete(f);
    this.waitingDownstream.delete(f);
    this.sim.reply(f, ok);
    this.pull();
  }

  pull(): void {
    while (!this.down && this.busy.size < this.workers && this.queue.length) {
      const next = this.queue.shift()!;
      if (!next.dead) this.start(next);
    }
  }

  onConfigChange(): void {
    this.pull();
    while (this.queue.length > this.queueLimit) this.sim.reply(this.queue.pop()!, false);
  }

  activeFrames(): Frame[] {
    return [...this.busy, ...this.queue];
  }
  clearActive(): void {
    this.busy.clear();
    this.waitingDownstream.clear();
    this.queue = [];
  }
}

/* ------------------------------------------------------------------ */
/* Load balancer                                                       */
/* ------------------------------------------------------------------ */

class LoadBalancerRuntime extends Runtime {
  waiting = new Map<Frame, string>();
  outstanding = new Map<string, number>();

  get cfg(): LoadBalancerConfig {
    return this.config as LoadBalancerConfig;
  }

  arrive(f: Frame): void {
    if (this.down) return this.sim.reply(f, false);
    this.sim.schedule(this.sim.now + 0.3, { k: "done", frame: f });
  }

  done(f: Frame): void {
    if (f.dead || this.down) return;
    let candidates = this.out;
    if (this.cfg.healthChecks) candidates = candidates.filter((e) => !this.sim.runtime(e.target)?.down);
    if (!candidates.length) return this.sim.reply(f, false);

    let edge: GraphEdge;
    if (this.cfg.strategy === "random") {
      edge = candidates[this.sim.rng.int(candidates.length)];
    } else if (this.cfg.strategy === "leastConnections") {
      edge = candidates[0];
      let best = Infinity;
      const start = this.rr++ % candidates.length;
      for (let i = 0; i < candidates.length; i++) {
        const e = candidates[(start + i) % candidates.length];
        const n = this.outstanding.get(e.id) ?? 0;
        if (n < best) {
          best = n;
          edge = e;
        }
      }
    } else {
      edge = candidates[this.rr++ % candidates.length];
    }
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
    if (ok) {
      this.entries.set(f.req.key, this.sim.now + Math.max(1, this.cfg.ttlMs));
      const cap = Math.max(1, Math.floor(this.cfg.capacity));
      while (this.entries.size > cap) this.entries.delete(this.entries.keys().next().value!);
    }
    this.sim.reply(f, ok);
  }

  crash(): void {
    super.crash();
    this.entries.clear(); // a restarted cache comes back cold
  }

  onConfigChange(): void {
    const cap = Math.max(1, Math.floor(this.cfg.capacity));
    while (this.entries.size > cap) this.entries.delete(this.entries.keys().next().value!);
  }

  activeFrames(): Frame[] {
    return [...this.waiting];
  }
  clearActive(): void {
    this.waiting.clear();
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
  private flights: Flight[] = [];
  private flightCounts = new Map<string, number>();
  private incidents: Incident[] = [];
  private incidentId = 1;

  constructor(graph: Graph, seed = 42) {
    this.rng = new Rng(seed);
    for (const n of graph.nodes) {
      const args = [n.id, n.kind, n.label, { ...n.config }, this] as const;
      const rt =
        n.kind === "client"
          ? new ClientRuntime(...args)
          : n.kind === "loadBalancer"
            ? new LoadBalancerRuntime(...args)
            : n.kind === "cache"
              ? new CacheRuntime(...args)
              : new PoolRuntime(...args);
      this.runtimes.set(n.id, rt);
    }
    for (const e of graph.edges) {
      const from = this.runtimes.get(e.source);
      if (from && this.runtimes.has(e.target)) from.out.push(e);
    }
    for (const rt of this.runtimes.values()) {
      if (rt instanceof ClientRuntime) this.queue.push(this.rng.next() * 5, { k: "gen", node: rt.id, send: false });
    }
  }

  runtime(id: string): Runtime | undefined {
    return this.runtimes.get(id);
  }

  schedule(time: number, ev: Ev): void {
    this.queue.push(time, ev);
  }

  private hop(): number {
    return 1 + this.rng.next();
  }

  private recordFlight(edgeId: string, dir: "fwd" | "back", ok: boolean): void {
    const key = edgeId + dir + (ok ? "" : "x");
    const n = this.flightCounts.get(key) ?? 0;
    if (n >= FLIGHT_CAP_PER_EDGE) return;
    this.flightCounts.set(key, n + 1);
    this.flights.push({ edgeId, dir, ok });
  }

  /** Send a request from a node to the next node along an edge. */
  forward(from: Frame, edge: GraphEdge): void {
    const child: Frame = {
      req: from.req,
      node: edge.target,
      arrived: 0,
      edgeId: edge.id,
      parent: from,
      dead: false,
    };
    const at = this.now + this.hop();
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
    this.recordFlight(f.edgeId, "back", ok);
    this.queue.push(this.now + this.hop(), { k: "resp", frame: parent, ok });
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
    if (ev.k === "gen") {
      const rt = this.runtimes.get(ev.node);
      if (rt instanceof ClientRuntime) rt.gen(ev.send);
      return;
    }
    const rt = this.runtimes.get(ev.frame.node);
    if (!rt) return;
    if (ev.k === "arrive") rt.arrive(ev.frame);
    else if (ev.k === "done") rt.done(ev.frame);
    else rt.resp(ev.frame, ev.ok);
  }

  updateConfig(nodeId: string, config: AnyConfig): void {
    const rt = this.runtimes.get(nodeId);
    if (!rt) return;
    rt.markBusy();
    rt.config = { ...config };
    rt.onConfigChange();
  }

  applyFault(action: FaultAction): void {
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
      if (rt instanceof CacheRuntime) {
        const l = rt.lookups.stats(this.now);
        const total = l.okPerSec + l.errorsPerSec;
        stats.hitRatio = total ? l.okPerSec / total : 0;
      }
      if (rt instanceof ClientRuntime) {
        stats.sendingRps = rt.rateAt(this.now);
        rt.sent.prune(this.now);
      }
      stats.status = this.statusOf(stats, queueFrac);

      // The bottleneck is the node saturated by its own work. A server stuck
      // waiting on a slow database is a victim, not the cause.
      if ((rt.kind === "server" || rt.kind === "database") && !rt.down) {
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
    };
    this.flights = [];
    this.flightCounts.clear();
    this.incidents = [];
    return snap;
  }

  private statusOf(s: NodeStats, queueFrac: number): NodeStatus {
    if (s.down) return "down";
    const active = s.okPerSec + s.errorsPerSec > 0 || s.busy > 0;
    if (s.kind === "server" || s.kind === "database") {
      if (s.errorRate > 0.05 || queueFrac > 0.8) return "critical";
      if (s.utilization > 0.85 || queueFrac > 0.2 || s.errorRate > 0.005) return "warning";
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
    }
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
      if (s.workers) return { severity: "warning", text: `${rt.label} is running hot: ${pct(s.utilization)} busy.` };
      return { severity: "warning", text: `${rt.label} is returning some errors.` };
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
