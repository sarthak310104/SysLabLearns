import type { ComponentKind, Graph, Snapshot } from "@/engine/model/types";
import { ofKind } from "@/lib/goals";
import type { Scenario } from "@/lib/scenarios";
import { errorsUnder, n, p99Under, underBudget, type Requirement } from "./challenges";

/*
 * Interview mode: a timed design question, run the way a system design
 * interview goes. You ask clarifying questions (the answers carry the
 * numbers), do a quick estimate, build, then the interviewer throws a
 * follow-up at your design while it runs. A scorecard and a suggested
 * design come at the end.
 */

export interface Question {
  id: string;
  q: string;
  a: string;
  /** Questions a strong candidate asks. The rest are fine but don't change the design. */
  key: boolean;
}

export interface Estimate {
  id: string;
  q: string;
  answer: number;
  /** Accept within this fraction of the answer either way. */
  tolerance: number;
  unit: string;
  working: string;
}

export interface InterviewRequirement extends Requirement {
  /** The question whose answer gives this target; it shows as unknown until asked. */
  revealedBy: string;
}

export interface Interview {
  id: string;
  slug: string;
  title: string;
  /** What the interviewer says first: deliberately vague. */
  prompt: string;
  minutes: number;
  graph: Graph;
  palette: ComponentKind[];
  budget: number;
  questions: Question[];
  estimates: Estimate[];
  requirements: InterviewRequirement[];
  followUp: {
    /** What the interviewer asks. */
    say: string;
    scenario: Scenario;
    /** Must hold all through the event (checked a few times a second). */
    holds: { text: string; check: (s: Snapshot, g: Graph) => boolean };
  };
  suggested: {
    /** Nodes and edges added to the starting graph. */
    design: Graph;
    notes: string[];
  };
}

const ALL: ComponentKind[] = ["loadBalancer", "server", "cache", "database", "replica", "queue"];
const ed = (s: string, t: string) => ({ id: `${s}>${t}`, source: s, target: t });
const load = (factor: number, afterMs: number) => ({ afterMs, action: { type: "load" as const, factor } });

/* ------------------------------------------------------------------ */

export const I1: Interview = {
  id: "i1-news-feed",
  slug: "i1-news-feed",
  title: "Design a news feed",
  prompt: "We're building the home feed for a social app. Users open the app and see recent posts from people they follow. Design the backend for loading the feed.",
  minutes: 30,
  graph: { nodes: [n("users", "client", "Users", 0, 160, { rps: 3000, writeShare: 0.02, keySpace: 40000, hotShare: 0.9 })], edges: [] },
  palette: ALL,
  budget: 3400,
  questions: [
    { id: "traffic", q: "How much traffic should it handle?", a: "About 3,000 requests a second at peak.", key: true },
    { id: "mix", q: "How many requests read feeds, and how many post?", a: "Reads dominate: 98% load a feed, 2% publish a post.", key: true },
    { id: "skew", q: "Are some feeds much more popular than others?", a: "Yes. A small share of feeds (popular accounts, active users) get most of the reads.", key: true },
    { id: "latency", q: "How fast does the feed need to load?", a: "The slowest 1% of feed loads should take under 150 ms.", key: true },
    { id: "reliability", q: "How many failures can we tolerate?", a: "Under half a percent of requests may fail.", key: true },
    { id: "budget", q: "Is there a budget?", a: "Yes, $3,400 a month for this service.", key: true },
    { id: "fresh", q: "Does a new post have to appear in every feed instantly?", a: "No. A few seconds, even a minute, of delay is fine.", key: false },
    { id: "language", q: "Which programming language should we use?", a: "Doesn't matter for this conversation.", key: false },
  ],
  estimates: [
    {
      id: "db-reads",
      q: "With no cache, how many reads a second would reach the database?",
      answer: 2940,
      tolerance: 0.1,
      unit: "reads a second",
      working: "3,000 requests a second, 98% of them reads: 3,000 x 0.98 = 2,940.",
    },
    {
      id: "connections",
      q: "Each database query takes 25 ms. How many connections would the database need to serve those reads on its own?",
      answer: 74,
      tolerance: 0.15,
      unit: "connections",
      working: "Each connection does 1000 / 25 = 40 queries a second. 2,940 / 40 = about 74. At $80 each that's about $5,900 a month, over budget: so something else must absorb the reads.",
    },
  ],
  requirements: [
    { id: "errors", revealedBy: "reliability", text: "Under 0.5% of requests fail", check: errorsUnder("users", 0.005) },
    { id: "latency", revealedBy: "latency", text: "p99 under 150 ms", check: p99Under("users", 150) },
    { id: "budget", revealedBy: "budget", text: "Costs at most $3,400 a month", check: underBudget(3400) },
  ],
  followUp: {
    say: "Nice. A celebrity just posted, and feed traffic doubles for the next 20 seconds. What happens to your design?",
    scenario: { id: "double", name: "Traffic doubles", blurb: "2x traffic for 20 seconds.", steps: [load(2, 0), load(1, 20000)], restore: [{ type: "load", factor: 1 }] },
    holds: { text: "Fewer than 2% of requests fail during the surge", check: errorsUnder("users", 0.02) },
  },
  suggested: {
    design: {
      nodes: [
        n("lb", "loadBalancer", "Load balancer", 220, 160, { strategy: "leastConnections", healthChecks: true }),
        n("s1", "server", "Feed server 1", 440, 40, { workers: 26, serviceMs: 5, queueLimit: 200 }),
        n("s2", "server", "Feed server 2", 440, 160, { workers: 26, serviceMs: 5, queueLimit: 200 }),
        n("s3", "server", "Feed server 3", 440, 280, { workers: 26, serviceMs: 5, queueLimit: 200 }),
        n("cache", "cache", "Feed cache", 660, 160, { capacity: 40000, ttlMs: 600000 }),
        n("db", "database", "Posts database", 880, 160, { workers: 20, serviceMs: 25 }),
      ],
      edges: [ed("users", "lb"), ed("lb", "s1"), ed("lb", "s2"), ed("lb", "s3"), ed("s1", "cache"), ed("s2", "cache"), ed("s3", "cache"), ed("cache", "db")],
    },
    notes: [
      "Reads are 98% of traffic and concentrated on popular feeds, so a cache in front of the database takes most of the load. That's what keeps the database (the expensive part) small.",
      "Three servers behind a load balancer with health checks: enough capacity for a surge, and losing one doesn't take the feed down.",
      "Freshness can lag by seconds, so a long cache expiry is fine. That raises the hit ratio for free.",
      "During the 2x surge the cache absorbs most of the extra reads; the servers have headroom because they were sized for well under 50% busy at normal load.",
    ],
  },
};

/* ------------------------------------------------------------------ */

const fresh = (maxMs: number) => (s: Snapshot) => {
  const qs = ofKind(s, "queue");
  return qs.length > 0 && qs.every((q) => (q.oldestAgeMs ?? 0) < maxMs);
};

export const I2: Interview = {
  id: "i2-notifications",
  slug: "i2-notifications",
  title: "Design a notification sender",
  prompt: "Our app sends push notifications: likes, comments, reminders. Other services call us to say 'notify this user'. Design the system that sends them.",
  minutes: 30,
  graph: { nodes: [n("calls", "client", "Other services", 0, 160, { rps: 400, writeShare: 1 })], edges: [] },
  palette: ALL,
  budget: 2800,
  questions: [
    { id: "traffic", q: "How many notification requests come in?", a: "About 400 a second, fairly steady.", key: true },
    { id: "work", q: "How long does sending one notification take?", a: "Calling the push provider takes about 200 ms per notification.", key: true },
    { id: "wait", q: "Do callers need to wait until the notification is delivered?", a: "No. They only need to know we accepted it, and that should take under 80 ms (p99).", key: true },
    { id: "delay", q: "How late can a notification be?", a: "No notification should wait more than 10 seconds to be sent.", key: true },
    { id: "reliability", q: "Can we drop requests under load?", a: "Under 0.1% may fail.", key: true },
    { id: "budget", q: "What's the budget?", a: "$2,800 a month.", key: true },
    { id: "order", q: "Do notifications have to arrive in order?", a: "Not strictly. Roughly in order is fine.", key: false },
    { id: "provider", q: "Which push provider do we use?", a: "Treat it as a black box that takes 200 ms.", key: false },
  ],
  estimates: [
    {
      id: "in-flight",
      q: "To keep up, how many notifications must be in the middle of sending at any moment?",
      answer: 80,
      tolerance: 0.1,
      unit: "at once",
      working: "Little's law: in flight = arrival rate x time each. 400 a second x 0.2 s = 80. So you need at least 80 sending workers in total, plus headroom.",
    },
    {
      id: "backlog",
      q: "If sending stopped completely for 30 seconds, how many notifications would pile up?",
      answer: 12000,
      tolerance: 0.1,
      unit: "notifications",
      working: "400 a second x 30 seconds = 12,000. A queue has to have room for that, and the senders need spare capacity to drain it afterwards.",
    },
  ],
  requirements: [
    { id: "errors", revealedBy: "reliability", text: "Under 0.1% of requests fail", check: errorsUnder("calls", 0.001) },
    { id: "latency", revealedBy: "wait", text: "Requests are accepted with p99 under 80 ms", check: p99Under("calls", 80) },
    { id: "fresh", revealedBy: "delay", text: "No notification waits more than 10 s", check: fresh(10000) },
    { id: "budget", revealedBy: "budget", text: "Costs at most $2,800 a month", check: underBudget(2800) },
  ],
  followUp: {
    say: "Good. Now one of the machines that sends notifications dies, and comes back 30 seconds later. Walk me through it.",
    scenario: {
      id: "sender-down",
      name: "A sender dies",
      blurb: "One sending server is down for 30 seconds.",
      steps: [],
      restore: [],
    },
    holds: { text: "Callers still see under 0.1% failures, and nothing waits over 30 s", check: (s, g) => errorsUnder("calls", 0.001)(s) && fresh(30000)(s) && Boolean(g) },
  },
  suggested: {
    design: {
      nodes: [
        n("api", "server", "Intake API", 220, 160, { workers: 16, serviceMs: 5 }),
        n("q", "queue", "Notification queue", 440, 160, { capacity: 20000 }),
        n("w1", "server", "Sender 1", 660, 40, { workers: 40, serviceMs: 200 }),
        n("w2", "server", "Sender 2", 660, 160, { workers: 40, serviceMs: 200 }),
        n("w3", "server", "Sender 3", 660, 280, { workers: 40, serviceMs: 200 }),
      ],
      edges: [ed("calls", "api"), ed("api", "q"), ed("q", "w1"), ed("q", "w2"), ed("q", "w3")],
    },
    notes: [
      "Callers don't need to wait for delivery, so the API only puts the request on a queue and answers. That's what keeps acceptance under 80 ms even though sending takes 200 ms.",
      "Little's law says 80 notifications are always in flight. Three senders of 40 give 120: enough to keep up, with spare capacity to drain a backlog.",
      "If a sender dies, the other two (80 workers) still keep pace, and the queue holds the rest. Nothing is lost; some notifications are just a little later.",
      "The queue's capacity (20,000) covers more than the 12,000 that would pile up if sending stopped for 30 seconds.",
    ],
  },
};

/* ------------------------------------------------------------------ */

export const I3: Interview = {
  id: "i3-autocomplete",
  slug: "i3-autocomplete",
  title: "Design search autocomplete",
  prompt: "As people type in the search box, we show suggestions. Design the service that returns suggestions for what's been typed so far.",
  minutes: 25,
  graph: { nodes: [n("typing", "client", "People typing", 0, 160, { rps: 6000, writeShare: 0, keySpace: 5000, hotShare: 0.9 })], edges: [] },
  palette: ALL,
  budget: 2600,
  questions: [
    { id: "traffic", q: "How many suggestion requests do we get?", a: "Every keystroke is a request: about 6,000 a second.", key: true },
    { id: "latency", q: "How fast must suggestions appear?", a: "Suggestions have to keep up with typing: p99 under 60 ms.", key: true },
    { id: "prefixes", q: "How many different prefixes do people type?", a: "Fewer than you'd think: about 5,000 cover nearly all traffic, and the top ones dominate.", key: true },
    { id: "updates", q: "How often do the suggestions change?", a: "Rarely: they're rebuilt from search logs every hour.", key: true },
    { id: "reliability", q: "What failure rate is acceptable?", a: "Under 0.1%.", key: true },
    { id: "budget", q: "Budget?", a: "$2,600 a month.", key: true },
    { id: "personal", q: "Are suggestions personalised?", a: "Not in this version.", key: false },
  ],
  estimates: [
    {
      id: "server-rate",
      q: "One server has 16 workers and each request takes 3 ms. How many requests a second can it handle?",
      answer: 5333,
      tolerance: 0.1,
      unit: "requests a second",
      working: "Each worker does 1000 / 3 = 333 a second, and 16 of them do about 5,333.",
    },
    {
      id: "cache-size",
      q: "How many entries does a cache need to hold every prefix people type?",
      answer: 5000,
      tolerance: 0.2,
      unit: "entries",
      working: "About 5,000 prefixes cover the traffic, so 5,000 entries is enough. Since suggestions change hourly, entries can live a long time.",
    },
  ],
  requirements: [
    { id: "errors", revealedBy: "reliability", text: "Under 0.1% of requests fail", check: errorsUnder("typing", 0.001) },
    { id: "latency", revealedBy: "latency", text: "p99 under 60 ms", check: p99Under("typing", 60) },
    { id: "budget", revealedBy: "budget", text: "Costs at most $2,600 a month", check: underBudget(2600) },
  ],
  followUp: {
    say: "We deploy a new cache version and every cache restarts empty. What does your design do in the next minute?",
    scenario: { id: "cache-wipe", name: "Cache wiped", blurb: "", steps: [], restore: [] },
    holds: { text: "Fewer than 1% of requests fail while the cache warms up", check: errorsUnder("typing", 0.01) },
  },
  suggested: {
    design: {
      nodes: [
        n("lb", "loadBalancer", "Load balancer", 220, 160, { strategy: "leastConnections", healthChecks: true }),
        n("s1", "server", "Suggest server 1", 440, 40, { workers: 24, serviceMs: 3, queueLimit: 200 }),
        n("s2", "server", "Suggest server 2", 440, 160, { workers: 24, serviceMs: 3, queueLimit: 200 }),
        n("s3", "server", "Suggest server 3", 440, 280, { workers: 24, serviceMs: 3, queueLimit: 200 }),
        n("cache", "cache", "Prefix cache", 660, 160, { capacity: 6000, ttlMs: 900000 }),
        n("db", "database", "Suggestions store", 880, 160, { workers: 12, serviceMs: 20 }),
      ],
      edges: [ed("typing", "lb"), ed("lb", "s1"), ed("lb", "s2"), ed("lb", "s3"), ed("s1", "cache"), ed("s2", "cache"), ed("s3", "cache"), ed("cache", "db")],
    },
    notes: [
      "The whole working set is about 5,000 prefixes, so a cache that holds all of them answers nearly every request from memory.",
      "Suggestions change hourly, so a 15-minute expiry costs nothing in freshness and keeps the hit ratio high.",
      "Two servers handle the traffic with room to spare (about 10,600 a second together), and losing one still leaves enough.",
      "When the cache restarts, each prefix misses once and then it's cached again. With only 5,000 prefixes it refills in seconds, so the database needs enough connections to ride out that burst, not to carry all traffic forever.",
    ],
  },
};

export const INTERVIEWS: Interview[] = [I1, I2, I3];
export const interviewBySlug = (slug: string) => INTERVIEWS.find((i) => i.slug === slug);

/** Follow-up events need ids from the design you built, so they're made when the event starts. */
export function followUpScenario(iv: Interview, graph: Graph): Scenario {
  const sc = iv.followUp.scenario;
  if (sc.id === "sender-down") {
    // The server that reads from a queue, or any server if there isn't one.
    const fromQueue = new Set(graph.edges.filter((e) => graph.nodes.find((x) => x.id === e.source)?.kind === "queue").map((e) => e.target));
    const victim = graph.nodes.find((x) => x.kind === "server" && fromQueue.has(x.id)) ?? graph.nodes.find((x) => x.kind === "server");
    if (!victim) return { ...sc, steps: [] };
    return {
      ...sc,
      name: `${victim.label} dies`,
      steps: [{ afterMs: 0, action: { type: "crash", nodeId: victim.id } }, { afterMs: 30000, action: { type: "recover", nodeId: victim.id } }],
      restore: [{ type: "recover", nodeId: victim.id }],
    };
  }
  if (sc.id === "cache-wipe") {
    const caches = graph.nodes.filter((x) => x.kind === "cache");
    return {
      ...sc,
      steps: [...caches.map((c) => ({ afterMs: 0, action: { type: "crash" as const, nodeId: c.id } })), ...caches.map((c) => ({ afterMs: 500, action: { type: "recover" as const, nodeId: c.id } })), { afterMs: 30000, action: { type: "load" as const, factor: 1 } }],
      restore: caches.map((c) => ({ type: "recover" as const, nodeId: c.id })),
    };
  }
  return sc;
}

/** The share of checks during the follow-up that must hold to count as surviving it. */
export const FOLLOW_UP_PASS = 0.9;

/** How long a follow-up runs, so the scorecard knows when it's over. */
export const followUpMs = (sc: Scenario) => Math.max(20000, ...sc.steps.map((s) => s.afterMs)) + 5000;
