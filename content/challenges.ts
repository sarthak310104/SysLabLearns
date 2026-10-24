import { defaultConfig } from "@/engine/model/defaults";
import type { AnyConfig, ComponentKind, Graph, GraphNode, Region, Snapshot } from "@/engine/model/types";
import { monthlyCost } from "@/lib/cost";
import { ofKind, type Goal, type Preset } from "@/lib/goals";

export interface Requirement {
  id: string;
  text: string;
  check: (snap: Snapshot, graph: Graph) => boolean;
}

export interface Challenge extends Preset {
  code: string;
  slug: string;
  /** One line for the roadmap. */
  summary: string;
  /** The brief, as short paragraphs. */
  brief: string[];
  budget: number;
  requirements: Requirement[];
  /** Hints unlock one at a time. */
  hints: string[];
}

function n(id: string, kind: ComponentKind, label: string, x: number, y: number, config: Partial<AnyConfig> = {}, region?: Region): GraphNode {
  return { id, kind, label, position: { x, y }, config: { ...defaultConfig(kind), ...config } as AnyConfig, ...(region ? { region } : {}) };
}

const ALL: ComponentKind[] = ["loadBalancer", "server", "cache", "database", "replica", "queue"];

const client = (s: Snapshot, id: string) => s.nodes[id];
const errorsUnder = (id: string, max: number) => (s: Snapshot) => {
  const c = client(s, id);
  return Boolean(c) && c.okPerSec + c.errorsPerSec > 0 && c.errorRate < max;
};
const p99Under = (id: string, ms: number) => (s: Snapshot) => {
  const c = client(s, id);
  return Boolean(c) && c.okPerSec > 0 && c.p99 < ms;
};
const p50Under = (id: string, ms: number) => (s: Snapshot) => {
  const c = client(s, id);
  return Boolean(c) && c.okPerSec > 0 && c.p50 < ms;
};
const underBudget = (budget: number) => (s: Snapshot, g: Graph) => monthlyCost(g, s).total <= budget;

/** Everything at once, for long enough that it isn't luck. */
function passGoal(reqs: Requirement[], holdMs = 15000): Goal {
  return {
    id: "pass",
    text: `Meet every requirement at the same time for ${holdMs / 1000} seconds.`,
    holdMs,
    check: (s, g) => reqs.every((r) => r.check(s, g)),
  };
}

/** Lose one component and keep the user-facing targets. */
function resilienceGoal(text: string, targets: ((s: Snapshot, g: Graph) => boolean)[], kinds: ComponentKind[] = ["server"]): Goal {
  return {
    id: "resilient",
    text,
    holdMs: 10000,
    check: (s, g) => {
      const down = Object.values(s.nodes).filter((x) => x.down && kinds.includes(x.kind));
      return down.length >= 1 && targets.every((t) => t(s, g));
    },
  };
}

/* ------------------------------------------------------------------ */
/* C1: URL shortener                                                   */
/* ------------------------------------------------------------------ */

const c1Reqs: Requirement[] = [
  { id: "errors", text: "Under 0.1% of requests fail", check: errorsUnder("users", 0.001) },
  { id: "latency", text: "p99 under 100 ms", check: p99Under("users", 100) },
  { id: "budget", text: "Costs at most $2,600 a month", check: underBudget(2600) },
];

export const C1: Challenge = {
  id: "c1-url-shortener",
  code: "C1",
  slug: "c1-url-shortener",
  title: "A URL shortener",
  summary: "2,000 requests a second, almost all reads, on a budget.",
  brief: [
    "People paste long links and get short ones back; everyone who clicks a short link gets redirected. Redirects are 95% of traffic, and a small share of links get most of the clicks.",
    "Users send 2,000 requests a second. Build something that answers them quickly and reliably, without spending more than you need to.",
  ],
  budget: 2600,
  graph: { nodes: [n("users", "client", "Users", 0, 150, { rps: 2000, writeShare: 0.05, keySpace: 30000, hotShare: 0.8 })], edges: [] },
  palette: ALL,
  requirements: c1Reqs,
  goals: [passGoal(c1Reqs), resilienceGoal("Crash any one server and keep failures under 1% and p99 under 150 ms.", [errorsUnder("users", 0.01), p99Under("users", 150)])],
  hints: [
    "Redirects only read data. Where have you seen a small share of keys getting most of the traffic?",
    "One server is a single point of failure. A load balancer with health checks lets you lose one.",
    "Databases are the expensive part. Every read a cache answers is one the database doesn't have to.",
    "Most links are clicked rarely. If cached entries expire before the next click, the cache never helps with them: think about capacity and time to live together.",
  ],
};

/* ------------------------------------------------------------------ */
/* C2: photo uploads                                                   */
/* ------------------------------------------------------------------ */

const c2Reqs: Requirement[] = [
  { id: "errors", text: "Under 0.1% of uploads fail", check: errorsUnder("users", 0.001) },
  { id: "latency", text: "Uploads are accepted with p99 under 80 ms", check: p99Under("users", 80) },
  {
    id: "fresh",
    text: "No photo waits more than 20 s to be processed",
    check: (s) => {
      const queues = ofKind(s, "queue");
      return queues.length > 0 && queues.every((q) => (q.oldestAgeMs ?? 0) < 20000);
    },
  },
  { id: "budget", text: "Costs at most $3,000 a month", check: underBudget(3000) },
];

export const C2: Challenge = {
  id: "c2-photo-uploads",
  code: "C2",
  slug: "c2-photo-uploads",
  title: "Photo uploads",
  summary: "Spiky uploads that each need 300 ms of processing.",
  brief: [
    "Every uploaded photo needs resizing into thumbnails, which takes 300 ms of work. Users only need to know their upload was received; thumbnails can appear a little later.",
    "Uploads arrive at 200 a second, and every 10 seconds there's a 2-second burst at four times that. Keep uploads fast, get every photo processed reasonably soon, and stay on budget.",
  ],
  budget: 3000,
  graph: { nodes: [n("users", "client", "Users", 0, 150, { rps: 200, pattern: "spike", writeShare: 1 })], edges: [] },
  palette: ALL,
  requirements: c2Reqs,
  goals: [passGoal(c2Reqs, 20000), resilienceGoal("Crash one of your processing servers and keep uploads under 0.1% failures.", [errorsUnder("users", 0.001)])],
  hints: [
    "Does the user need to wait for the thumbnails?",
    "Workers only need to keep up with the average rate, not the burst. Work out the average first.",
    "Split processing across more than one server, so losing one doesn't stop all processing.",
  ],
};

/* ------------------------------------------------------------------ */
/* C3: flash sale                                                      */
/* ------------------------------------------------------------------ */

const c3Reqs: Requirement[] = [
  { id: "errors", text: "Under 1% of shoppers' requests fail", check: errorsUnder("users", 0.01) },
  { id: "latency", text: "Shoppers' p99 under 300 ms", check: p99Under("users", 300) },
  { id: "budget", text: "Costs at most $1,800 a month", check: underBudget(1800) },
];

export const C3: Challenge = {
  id: "c3-flash-sale",
  code: "C3",
  slug: "c3-flash-sale",
  title: "A flash sale",
  summary: "Spiky shoppers plus a ticket bot hammering the API.",
  brief: [
    "A sale opens and shoppers arrive in waves: 200 requests a second, quadrupling for 2 seconds every 10. At the same time a reseller's bot sends 1,500 requests a second, trying to grab everything.",
    "Keep the sale working for real shoppers. The bot doesn't need to succeed.",
  ],
  budget: 1800,
  graph: {
    nodes: [
      n("users", "client", "Shoppers", 0, 60, { rps: 200, pattern: "spike" }),
      n("bot", "client", "Ticket bot", 0, 260, { rps: 1500 }),
    ],
    edges: [],
  },
  palette: ALL,
  requirements: c3Reqs,
  goals: [passGoal(c3Reqs, 20000), resilienceGoal("Crash any one server and keep shoppers' failures under 1%.", [errorsUnder("users", 0.01)])],
  hints: [
    "Serving the bot costs as much as serving a shopper. Do you have to serve it at all?",
    "A limit for everyone together would turn shoppers away too. Look at the rate limit's scope.",
    "Shoppers peak at 800 requests a second during a burst. The bot sends 1,500 all the time.",
  ],
};

/* ------------------------------------------------------------------ */
/* C4: global profiles                                                 */
/* ------------------------------------------------------------------ */

const c4Reqs: Requirement[] = [
  { id: "mumbai", text: "Typical (p50) request in Mumbai under 30 ms", check: p50Under("mumbaiUsers", 30) },
  { id: "virginia", text: "Typical (p50) request in Virginia under 30 ms", check: p50Under("virginiaUsers", 30) },
  { id: "errors", text: "Under 0.5% of requests fail in both regions", check: (s) => errorsUnder("mumbaiUsers", 0.005)(s) && errorsUnder("virginiaUsers", 0.005)(s) },
  { id: "budget", text: "Costs at most $1,800 a month", check: underBudget(1800) },
];

export const C4: Challenge = {
  id: "c4-global-profiles",
  code: "C4",
  slug: "c4-global-profiles",
  title: "Profiles for a global app",
  summary: "Users in Mumbai and Virginia, both expecting fast pages.",
  brief: [
    "Your app shows user profiles. Half your users are in Mumbai and half in Virginia, 300 requests a second each. Profiles are read far more than they change: 5% of requests are edits.",
    "Both regions should feel fast. Edits don't have to show up everywhere instantly.",
  ],
  budget: 1800,
  graph: {
    nodes: [
      n("mumbaiUsers", "client", "Users in Mumbai", 0, 0, { rps: 300, writeShare: 0.05, keySpace: 20000, hotShare: 0.8 }, "mumbai"),
      n("virginiaUsers", "client", "Users in Virginia", 0, 300, { rps: 300, writeShare: 0.05, keySpace: 20000, hotShare: 0.8 }, "virginia"),
    ],
    edges: [],
  },
  palette: ALL,
  requirements: c4Reqs,
  goals: [passGoal(c4Reqs), resilienceGoal("Crash any one server and keep both regions under 0.5% failures.", [(s) => errorsUnder("mumbaiUsers", 0.005)(s) && errorsUnder("virginiaUsers", 0.005)(s)])],
  hints: [
    "Set a region on every component you add. Where you put things matters as much as what you put.",
    "One copy of the data is fine; what has to be close to Mumbai users is something that can answer reads.",
    "The typical request is what counts here. A few slow edits crossing the ocean won't hurt p50.",
  ],
};

export const CHALLENGES: Challenge[] = [C1, C2, C3, C4];
export const challengeBySlug = (slug: string) => CHALLENGES.find((c) => c.slug === slug) ?? null;
