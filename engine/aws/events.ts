import { UsageError, type Call, type Runtime, type Service } from "./cli";
import { wildcard } from "./iam-eval";
import { enqueue, queueByArn } from "./messaging";
import { ACCOUNT_ID, iso, now, REGION, uuid, type AwsState, type EventRule } from "./state";

/*
 * EventBridge rules: on a schedule, or matching events you send with
 * put-events. Targets are Lambda functions (which must allow
 * events.amazonaws.com to invoke them) and SQS queues. Time moves forward
 * with `sleep`, and schedules catch up between commands.
 */

const ruleArn = (name: string) => `arn:aws:events:${REGION}:${ACCOUNT_ID}:rule/${name}`;
const MIN = 60000;

/* ---------------- schedule expressions ---------------- */

const UNIT: Record<string, number> = { minute: MIN, minutes: MIN, hour: 60 * MIN, hours: 60 * MIN, day: 1440 * MIN, days: 1440 * MIN };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export interface Schedule {
  /** Every n ms, starting from when the rule was created. */
  every?: number;
  /** Or a cron matcher on UTC fields. */
  cron?: { minute: Set<number>; hour: Set<number>; dom: Set<number> | null; month: Set<number>; dow: Set<number> | null };
}

function field(src: string, lo: number, hi: number, names: string[] = [], offset = 0): Set<number> {
  const out = new Set<number>();
  const val = (x: string) => {
    const i = names.indexOf(x.toUpperCase());
    const n = i >= 0 ? i + offset : Number(x);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`bad value ${x}`);
    return n;
  };
  for (const part of src.split(",")) {
    let [range, step] = part.split("/") as [string, string | undefined];
    let a = lo;
    let b = hi;
    if (range !== "*") {
      const [x, y] = range.split("-");
      a = val(x);
      b = y !== undefined ? val(y) : step ? hi : a;
    }
    const st = step ? Number(step) : 1;
    if (!(st >= 1)) throw new Error("bad step");
    for (let v = a; v <= b; v += st) out.add(v);
  }
  return out;
}

/** Parse rate(...) or cron(...). Throws with a reason when it isn't valid. */
export function parseSchedule(expr: string): Schedule {
  const rate = expr.match(/^rate\((\d+)\s+(minute|minutes|hour|hours|day|days)\)$/);
  if (rate) {
    const n = Number(rate[1]);
    const unit = rate[2];
    if (n < 1) throw new Error("the value must be at least 1");
    if ((n === 1) !== !unit.endsWith("s")) throw new Error(n === 1 ? `use the singular: rate(1 ${unit.replace(/s$/, "")})` : `use the plural: rate(${n} ${unit}${unit.endsWith("s") ? "" : "s"})`);
    return { every: n * UNIT[unit] };
  }
  const cron = expr.match(/^cron\((.+)\)$/);
  if (cron) {
    const f = cron[1].trim().split(/\s+/);
    if (f.length !== 6) throw new Error("cron needs six fields: minutes hours day-of-month month day-of-week year");
    const [mi, ho, dom, mo, dow] = f;
    if ((dom === "?") === (dow === "?")) throw new Error("use ? in exactly one of day-of-month and day-of-week");
    if (/[LW#]/.test(dom + dow)) throw new Error("this lab doesn't support L, W or # in cron expressions");
    return {
      cron: {
        minute: field(mi, 0, 59),
        hour: field(ho, 0, 23),
        dom: dom === "?" ? null : field(dom, 1, 31),
        month: field(mo, 1, 12, MONTHS, 1),
        dow: dow === "?" ? null : field(dow, 1, 7, DAYS, 1),
      },
    };
  }
  throw new Error("use rate(...) or cron(...)");
}

/** The first time strictly after `after` that the schedule fires. */
export function nextFire(s: Schedule, after: number, createdAt: number): number {
  if (s.every) return createdAt + (Math.floor((after - createdAt) / s.every) + 1) * s.every;
  const c = s.cron!;
  let t = Math.floor(after / MIN) * MIN + MIN;
  for (let i = 0; i < 366 * 1440; i++, t += MIN) {
    const d = new Date(t);
    if (!c.minute.has(d.getUTCMinutes()) || !c.hour.has(d.getUTCHours()) || !c.month.has(d.getUTCMonth() + 1)) continue;
    if (c.dom && !c.dom.has(d.getUTCDate())) continue;
    if (c.dow && !c.dow.has(d.getUTCDay() + 1)) continue;
    return t;
  }
  return Infinity;
}

/* ---------------- event patterns ---------------- */

function matchValue(rule: unknown, value: unknown, present: boolean): boolean {
  if (rule && typeof rule === "object" && !Array.isArray(rule)) {
    const r = rule as Record<string, unknown>;
    if ("exists" in r) return Boolean(r.exists) === present;
    if (!present) return false;
    if ("prefix" in r) return typeof value === "string" && value.startsWith(String(r.prefix));
    if ("suffix" in r) return typeof value === "string" && value.endsWith(String(r.suffix));
    if ("anything-but" in r) {
      const ab = r["anything-but"];
      return !(Array.isArray(ab) ? ab : [ab]).includes(value as never);
    }
    if ("numeric" in r && Array.isArray(r.numeric)) {
      const n = Number(value);
      const ops = r.numeric as (string | number)[];
      for (let i = 0; i < ops.length; i += 2) {
        const [op, x] = [ops[i], Number(ops[i + 1])];
        const ok = op === ">" ? n > x : op === ">=" ? n >= x : op === "<" ? n < x : op === "<=" ? n <= x : op === "=" ? n === x : false;
        if (!ok) return false;
      }
      return true;
    }
    return false;
  }
  if (!present) return false;
  const vals = Array.isArray(value) ? value : [value];
  return vals.some((v) => v === rule);
}

/** Does an event match a pattern? Every field in the pattern must match; values are lists of allowed options. */
export function matches(pattern: Record<string, unknown>, event: Record<string, unknown>): boolean {
  for (const [k, rule] of Object.entries(pattern)) {
    const present = event !== null && typeof event === "object" && k in event;
    const v = present ? event[k] : undefined;
    if (Array.isArray(rule)) {
      if (!rule.some((r) => matchValue(r, v, present))) return false;
    } else if (rule && typeof rule === "object") {
      if (!present || typeof v !== "object" || v === null) return false;
      if (!matches(rule as Record<string, unknown>, v as Record<string, unknown>)) return false;
    } else return false;
  }
  return true;
}

/* ---------------- delivery ---------------- */

async function deliver(state: AwsState, rt: Runtime, rule: EventRule, event: Record<string, unknown>): Promise<void> {
  rule.stats.triggered++;
  for (const t of rule.targets) {
    const payload = t.Input ? JSON.parse(t.Input) : event;
    if (t.Arn.startsWith("arn:aws:lambda:")) {
      const name = t.Arn.split(":").pop()!;
      const f = state.lambda.functions[name];
      // EventBridge may only call the function if the function's resource policy allows it.
      const allowed = f?.permissions.some((p) => p.principal === "events.amazonaws.com" && /lambda:(InvokeFunction|\*)/i.test(p.action) && (!p.sourceArn || wildcard(p.sourceArn, rule.arn)));
      if (!f || !allowed || now(state) < f.activeAt) {
        rule.stats.failed++;
        continue;
      }
      rule.stats.invocations++;
      await rt.invokeLambda(state, f.arn, payload, "events");
    } else if (t.Arn.startsWith("arn:aws:sqs:")) {
      const q = queueByArn(state, t.Arn);
      if (!q) {
        rule.stats.failed++;
        continue;
      }
      rule.stats.invocations++;
      enqueue(state, q, JSON.stringify(payload));
    } else rule.stats.failed++;
  }
}

let ticking = false;
/** Fire every schedule that came due since the last command. Returns true if anything ran. */
export async function tickEvents(state: AwsState, rt: Runtime): Promise<boolean> {
  if (ticking || !state.events) return false;
  ticking = true;
  let changed = false;
  try {
    const t = now(state);
    for (const r of Object.values(state.events.rules)) {
      if (!r.schedule || r.state !== "ENABLED") continue;
      const s = parseSchedule(r.schedule);
      r.nextAt ??= nextFire(s, r.createdAt, r.createdAt);
      // Catch up, but don't replay weeks of a busy schedule after a long sleep.
      for (let n = 0; r.nextAt <= t && n < 50; n++) {
        changed = true;
        await deliver(state, rt, r, {
          version: "0",
          id: uuid(state),
          "detail-type": "Scheduled Event",
          source: "aws.events",
          account: ACCOUNT_ID,
          time: iso(r.nextAt).replace("+00:00", "Z"),
          region: REGION,
          resources: [r.arn],
          detail: {},
        });
        r.nextAt = nextFire(s, r.nextAt, r.createdAt);
      }
      if (r.nextAt <= t) r.nextAt = nextFire(s, t, r.createdAt);
    }
  } finally {
    ticking = false;
  }
  return changed;
}

/* ---------------- the CLI ---------------- */

function need(c: Call, name: string | undefined): EventRule {
  if (!name) throw new UsageError("the following arguments are required: --name");
  const r = c.state.events.rules[name];
  if (!r) throw c.error("ResourceNotFoundException", `Rule ${name} does not exist on EventBus default.`);
  return r;
}

function ruleView(r: EventRule) {
  return {
    Name: r.name,
    Arn: r.arn,
    ...(r.pattern ? { EventPattern: r.pattern } : {}),
    ...(r.schedule ? { ScheduleExpression: r.schedule } : {}),
    State: r.state,
    ...(r.description ? { Description: r.description } : {}),
    EventBusName: "default",
  };
}

function parsePattern(c: Call, src: string): Record<string, unknown> {
  let p: unknown;
  try {
    p = JSON.parse(src);
  } catch {
    throw c.error("InvalidEventPatternException", "Event pattern is not valid. Reason: it must be JSON");
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) throw c.error("InvalidEventPatternException", "Event pattern is not valid. Reason: Filter is not an object");
  const check = (o: Record<string, unknown>, path: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v)) continue;
      if (v && typeof v === "object") check(v as Record<string, unknown>, `${path}${k}.`);
      else throw c.error("InvalidEventPatternException", `Event pattern is not valid. Reason: "${path}${k}" must be an object or an array`);
    }
  };
  check(p as Record<string, unknown>, "");
  return p as Record<string, unknown>;
}

export function eventsService(rt: Runtime): Service {
  return {
    blurb: "EventBridge: run things on a schedule, or route events to the services that care",
    commands: {
      "put-rule": (c) => {
        const name = c.str("name", true);
        c.authorize("events:PutRule", ruleArn(name));
        const schedule = c.str("schedule-expression");
        const pattern = c.str("event-pattern");
        if (!schedule && !pattern) throw c.error("ValidationException", "Parameter(s) EventPattern or ScheduleExpression must be specified.");
        if (schedule) {
          try {
            parseSchedule(schedule);
          } catch (e) {
            throw c.error("ValidationException", `Parameter ScheduleExpression is not valid. (${(e as Error).message})`);
          }
        }
        if (pattern) parsePattern(c, pattern);
        const state = (c.str("state") ?? "ENABLED").toUpperCase();
        if (state !== "ENABLED" && state !== "DISABLED") throw c.error("ValidationException", "State must be ENABLED or DISABLED");
        const prev = c.state.events.rules[name];
        const r: EventRule = {
          name,
          arn: ruleArn(name),
          createdAt: prev?.createdAt ?? now(c.state),
          state: state as EventRule["state"],
          description: c.str("description"),
          schedule,
          pattern,
          targets: prev?.targets ?? [],
          stats: prev?.stats ?? { triggered: 0, invocations: 0, failed: 0 },
        };
        if (prev && prev.schedule !== schedule) r.createdAt = now(c.state);
        c.state.events.rules[name] = r;
        return { RuleArn: r.arn };
      },
      "describe-rule": (c) => ruleView(need(c, c.str("name"))),
      "list-rules": (c) => {
        const prefix = c.str("name-prefix") ?? "";
        return { Rules: Object.values(c.state.events.rules).filter((r) => r.name.startsWith(prefix)).map(ruleView) };
      },
      "enable-rule": (c) => {
        const r = need(c, c.str("name"));
        // A re-enabled schedule picks up from now, rather than replaying what it missed.
        if (r.state !== "ENABLED" && r.schedule) r.nextAt = nextFire(parseSchedule(r.schedule), now(c.state), r.createdAt);
        r.state = "ENABLED";
      },
      "disable-rule": (c) => {
        need(c, c.str("name")).state = "DISABLED";
      },
      "delete-rule": (c) => {
        const r = need(c, c.str("name"));
        if (r.targets.length) throw c.error("ValidationException", "Rule can't be deleted since it has targets.");
        delete c.state.events.rules[r.name];
      },
      "put-targets": (c) => {
        const r = need(c, c.str("rule", true));
        c.authorize("events:PutTargets", r.arn);
        const targets = c.structuredList("targets", true) as { Id?: string; Arn?: string; Input?: unknown }[];
        const failed: unknown[] = [];
        for (const t of targets) {
          if (!t.Id || !t.Arn) {
            failed.push({ TargetId: t.Id ?? "", ErrorCode: "ValidationException", ErrorMessage: "Each target needs an Id and an Arn." });
            continue;
          }
          const input = t.Input === undefined ? undefined : typeof t.Input === "string" ? t.Input : JSON.stringify(t.Input);
          if (input !== undefined) {
            try {
              JSON.parse(input);
            } catch {
              throw c.error("ValidationException", "Input must be valid JSON.");
            }
          }
          r.targets = r.targets.filter((x) => x.Id !== t.Id).concat([{ Id: String(t.Id), Arn: String(t.Arn), ...(input !== undefined ? { Input: input } : {}) }]);
        }
        return { FailedEntryCount: failed.length, FailedEntries: failed };
      },
      "list-targets-by-rule": (c) => ({ Targets: need(c, c.str("rule", true)).targets }),
      "remove-targets": (c) => {
        const r = need(c, c.str("rule", true));
        const ids = c.list("ids");
        if (!ids.length) throw new UsageError("the following arguments are required: --ids");
        r.targets = r.targets.filter((t) => !ids.includes(t.Id));
        return { FailedEntryCount: 0, FailedEntries: [] };
      },
      "put-events": async (c) => {
        const entries = c.structuredList("entries", true) as { Source?: string; DetailType?: string; Detail?: unknown; Resources?: string[] }[];
        const results: unknown[] = [];
        let failed = 0;
        for (const e of entries) {
          if (!e.Source || !e.DetailType || e.Detail === undefined) {
            failed++;
            results.push({ ErrorCode: "MalformedDetail", ErrorMessage: "Source, DetailType and Detail are all required." });
            continue;
          }
          let detail: unknown;
          try {
            detail = typeof e.Detail === "string" ? JSON.parse(e.Detail) : e.Detail;
          } catch {
            failed++;
            results.push({ ErrorCode: "MalformedDetail", ErrorMessage: "Detail is malformed." });
            continue;
          }
          const id = uuid(c.state);
          const event = { version: "0", id, "detail-type": e.DetailType, source: e.Source, account: ACCOUNT_ID, time: iso(now(c.state)).replace("+00:00", "Z"), region: REGION, resources: e.Resources ?? [], detail };
          for (const r of Object.values(c.state.events.rules)) {
            if (r.state !== "ENABLED" || !r.pattern) continue;
            if (matches(JSON.parse(r.pattern), event)) await deliver(c.state, rt, r, event);
          }
          results.push({ EventId: id });
        }
        return { FailedEntryCount: failed, Entries: results };
      },
      "test-event-pattern": (c) => {
        const pattern = parsePattern(c, c.str("event-pattern", true));
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(c.str("event", true));
        } catch {
          throw c.error("InvalidEventPatternException", "Event is not valid JSON.");
        }
        for (const k of ["id", "account", "source", "time", "region", "resources", "detail-type"]) {
          if (!(k in event)) throw c.error("InvalidEventPatternException", `Event is not valid. Reason: "${k}" is a required field`);
        }
        return { Result: matches(pattern, event) };
      },
    },
  };
}

/* ---------------- CloudWatch metrics, just enough to debug rules ---------------- */

export const cloudwatchService: Service = {
  blurb: "CloudWatch metrics: counts of what your resources did",
  help: "aws cloudwatch get-metric-statistics --namespace AWS/Events --metric-name FailedInvocations --dimensions Name=RuleName,Value=NAME --statistics Sum --period 3600 --start-time 2026-01-01T00:00:00Z --end-time 2030-01-01T00:00:00Z",
  commands: {
    "get-metric-statistics": (c) => {
      const ns = c.str("namespace", true);
      const metric = c.str("metric-name", true);
      const dims = c.structuredList("dimensions") as { Name?: string; Value?: string }[];
      for (const req of ["statistics", "period", "start-time", "end-time"]) if (!c.has(req)) throw new UsageError(`the following arguments are required: --${req}`);
      const point = (sum: number) => ({ Label: metric, Datapoints: sum ? [{ Timestamp: iso(now(c.state)), Sum: sum, Unit: "Count" }] : [] });
      if (ns === "AWS/Events") {
        const name = dims.find((d) => d.Name === "RuleName")?.Value;
        const r = name ? c.state.events.rules[name] : undefined;
        if (!r) return point(0);
        const m: Record<string, number> = { Invocations: r.stats.invocations, FailedInvocations: r.stats.failed, TriggeredRules: r.stats.triggered, MatchedEvents: r.stats.triggered };
        return point(m[metric] ?? 0);
      }
      if (ns === "AWS/Lambda") {
        const name = dims.find((d) => d.Name === "FunctionName")?.Value;
        const f = name ? c.state.lambda.functions[name] : undefined;
        if (!f) return point(0);
        const m: Record<string, number> = { Invocations: f.stats?.invocations ?? 0, Errors: f.stats?.errors ?? 0 };
        return point(m[metric] ?? 0);
      }
      return point(0);
    },
  },
};
