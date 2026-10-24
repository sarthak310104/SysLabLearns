"use client";

import { useEffect, useState } from "react";
import { counts } from "@/engine/aws/messaging";
import { now, type AwsState, type DdbItem, type DdbValue } from "@/engine/aws/state";

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const ago = (s: AwsState, t: number) => {
  const d = Math.max(0, Math.round((now(s) - t) / 1000));
  return d < 60 ? `${d}s ago` : d < 3600 ? `${Math.round(d / 60)}m ago` : `${Math.round(d / 3600)}h ago`;
};

function show(v: DdbValue | undefined): string {
  if (!v) return "";
  const [t, x] = Object.entries(v)[0];
  if (t === "S" || t === "N") return String(x);
  if (t === "BOOL") return String(x);
  if (t === "NULL") return "null";
  return JSON.stringify(x);
}

function Section({ title, count, children, empty }: { title: string; count: number; children: React.ReactNode; empty: string }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-line">
      <button className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-panel-2" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="text-muted text-[11px] w-3">{open ? "▾" : "▸"}</span>
        <span className="font-medium text-[13px]">{title}</span>
        <span className="num text-[12px] text-muted ml-auto">{count}</span>
      </button>
      {open && <div className="px-3 pb-3 text-[12px]">{count === 0 ? <p className="text-muted">{empty}</p> : children}</div>}
    </section>
  );
}

function Item({ name, meta, children }: { name: string; meta?: React.ReactNode; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 rounded border border-line bg-panel">
      <button className="w-full flex items-baseline gap-2 px-2 py-1.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!children}>
        <span className="font-mono text-text truncate">{name}</span>
        <span className="ml-auto text-muted shrink-0">{meta}</span>
      </button>
      {open && children && <div className="px-2 pb-2 border-t border-line pt-1.5 space-y-1">{children}</div>}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex gap-2">
    <span className="text-muted shrink-0 w-28">{k}</span>
    <span className="font-mono break-all">{v}</span>
  </div>
);

function ItemsTable({ items }: { items: DdbItem[] }) {
  const cols = [...new Set(items.flatMap((i) => Object.keys(i)))].slice(0, 6);
  return (
    <div className="overflow-x-auto">
      <table className="text-[11.5px] font-mono">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} className="text-left text-muted font-normal pr-3 pb-1">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 25).map((it, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} className="pr-3 align-top max-w-[160px] truncate">
                  {show(it[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {items.length > 25 && <p className="text-muted mt-1">and {items.length - 25} more</p>}
    </div>
  );
}

/** Everything in the account, like a tiny AWS console. Read-only: you change things with commands. */
export function ResourcesPanel({ state, onReset }: { state: AwsState | null; onReset: () => void }) {
  // Message visibility depends on the clock, so refresh every second.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!state) return <p className="p-3 text-muted text-[13px]">Loading your account...</p>;
  const s = state;
  const buckets = Object.values(s.s3.buckets);
  const queues = Object.values(s.sqs.queues);
  const topics = Object.values(s.sns.topics);
  const tables = Object.values(s.dynamodb.tables);
  const fns = Object.values(s.lambda.functions);
  const groups = Object.values(s.logs.groups);
  const users = Object.values(s.iam.users);
  const roles = Object.values(s.iam.roles);
  const apis = Object.values(s.apigw.apis);
  const dists = Object.values(s.cloudfront?.distributions ?? {});
  const rules = Object.values(s.events?.rules ?? {});
  const machines = Object.values(s.sfn?.machines ?? {});

  return (
    <div className="h-full overflow-y-auto">
      <Section title="S3 buckets" count={buckets.length} empty="No buckets yet. Try: aws s3 mb s3://yourname-notes">
        {buckets.map((b) => {
          const keys = Object.keys(b.objects).sort();
          const pub = !b.publicAccessBlock.BlockPublicPolicy;
          return (
            <Item key={b.name} name={b.name} meta={`${keys.length} object${keys.length === 1 ? "" : "s"}`}>
              <Row k="Versioning" v={b.versioning ?? "Off"} />
              {b.website && <Row k="Website" v={`On (index ${b.website.index}${b.website.error ? `, errors ${b.website.error}` : ""})`} />}
              <Row k="Public access" v={pub ? (b.policy ? "Public policy set" : "Block off, no policy") : "Blocked"} />
              {keys.map((k) => (
                <Row key={k} k={fmtSize(b.objects[k].size)} v={`${k}${b.versions?.[k]?.length ? ` (+${b.versions[k].length} older)` : ""}`} />
              ))}
            </Item>
          );
        })}
      </Section>

      <Section title="SQS queues" count={queues.length} empty="No queues yet.">
        {queues.map((q) => {
          const c = counts(s, q);
          let dlq = "";
          try {
            if (q.attributes.RedrivePolicy) dlq = JSON.parse(q.attributes.RedrivePolicy).deadLetterTargetArn.split(":").pop();
          } catch {}
          return (
            <Item key={q.name} name={q.name} meta={`${c.visible} waiting · ${c.inflight} in flight`}>
              <Row k="Visibility" v={`${q.attributes.VisibilityTimeout ?? "30"} s`} />
              {dlq && <Row k="Dead letters to" v={dlq} />}
              {c.delayed > 0 && <Row k="Delayed" v={c.delayed} />}
              {q.messages.slice(0, 8).map((m) => (
                <Row key={m.id} k={m.visibleAt > now(s) ? (m.receiveCount ? "in flight" : "delayed") : "waiting"} v={`${m.body.slice(0, 60)}${m.body.length > 60 ? "..." : ""}  (received ${m.receiveCount}x)`} />
              ))}
            </Item>
          );
        })}
      </Section>

      <Section title="SNS topics" count={topics.length} empty="No topics yet.">
        {topics.map((t) => (
          <Item key={t.name} name={t.name} meta={`${t.subscriptions.length} subscriber${t.subscriptions.length === 1 ? "" : "s"}`}>
            {t.subscriptions.map((x) => (
              <Row key={x.arn} k={x.protocol} v={`${x.endpoint.split(":").pop()}${x.filterPolicy ? `  filter ${x.filterPolicy}` : ""}${x.raw ? "  raw" : ""}`} />
            ))}
          </Item>
        ))}
      </Section>

      <Section title="DynamoDB tables" count={tables.length} empty="No tables yet.">
        {tables.map((t) => (
          <Item key={t.name} name={t.name} meta={`${now(s) < t.activeAt ? "CREATING" : `${t.items.length} items`}`}>
            <Row k="Key" v={t.keySchema.map((k) => `${k.AttributeName} (${k.KeyType === "HASH" ? "partition" : "sort"})`).join(", ")} />
            {t.gsis.map((g) => (
              <Row key={g.IndexName} k="Index" v={`${g.IndexName}: ${g.KeySchema.map((k) => k.AttributeName).join(", ")}`} />
            ))}
            {t.items.length > 0 && <ItemsTable items={t.items} />}
          </Item>
        ))}
      </Section>

      <Section title="Lambda functions" count={fns.length} empty="No functions yet.">
        {fns.map((f) => {
          const maps = s.lambda.mappings.filter((m) => m.functionArn === f.arn);
          return (
            <Item key={f.name} name={f.name} meta={`${now(s) < f.activeAt ? "Pending" : "Active"} · ${f.stats?.invocations ?? 0} runs${f.stats?.errors ? `, ${f.stats.errors} failed` : ""}`}>
              <Row k="Runtime" v={`${f.runtime}, ${f.handler}, ${f.timeout}s`} />
              <Row k="Role" v={f.role.split("/").pop()} />
              {Object.keys(f.env).length > 0 && <Row k="Environment" v={Object.entries(f.env).map(([k, v]) => `${k}=${v}`).join(" ")} />}
              {maps.map((m) => (
                <Row key={m.uuid} k="Trigger" v={`SQS ${m.sourceArn.split(":").pop()} (batch ${m.batchSize})${m.enabled ? "" : ", disabled"}`} />
              ))}
              {f.permissions.map((p) => (
                <Row key={p.sid} k="Invocable by" v={p.principal} />
              ))}
              <Row k="Files" v={Object.keys(f.code).join(", ")} />
            </Item>
          );
        })}
      </Section>

      <Section title="CloudWatch log groups" count={groups.length} empty="No logs yet. Functions write here once their role allows it.">
        {groups.map((g) => {
          const events = Object.values(g.streams).flat().sort((a, b) => a.t - b.t);
          return (
            <Item key={g.name} name={g.name} meta={events.length ? ago(s, events[events.length - 1].t) : ""}>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted max-h-48 overflow-y-auto">{events.slice(-20).map((e) => e.message).join("\n")}</pre>
            </Item>
          );
        })}
      </Section>

      <Section title="CloudFront distributions" count={dists.length} empty="No distributions yet.">
        {dists.map((d) => (
          <Item key={d.id} name={d.domain} meta={now(s) < d.deployedAt ? "Deploying" : "Deployed"}>
            <Row k="Id" v={d.id} />
            <Row k="Origin" v={d.origin.domain} />
            <Row k="Access" v={d.origin.oacId ? `Origin access control ${d.origin.oacId}` : "Public origin (no OAC)"} />
            <Row k="Cached paths" v={Object.keys(d.cache).join(", ") || "none"} />
            {d.stats && <Row k="Hits / misses" v={`${d.stats.hits} / ${d.stats.misses}`} />}
          </Item>
        ))}
      </Section>

      <Section title="EventBridge rules" count={rules.length} empty="No rules yet.">
        {rules.map((r) => (
          <Item key={r.name} name={r.name} meta={`${r.state === "ENABLED" ? "On" : "Off"} · ${r.stats.invocations} ran${r.stats.failed ? `, ${r.stats.failed} failed` : ""}`}>
            {r.schedule && <Row k="Schedule" v={r.schedule} />}
            {r.pattern && <Row k="Pattern" v={r.pattern} />}
            {r.targets.map((t) => (
              <Row key={t.Id} k="Target" v={t.Arn.split(":").slice(-1)[0]} />
            ))}
            {r.schedule && r.state === "ENABLED" && r.nextAt && <Row k="Next run" v={new Date(r.nextAt).toISOString().replace(".000Z", "Z")} />}
          </Item>
        ))}
      </Section>

      <Section title="Step Functions" count={machines.length} empty="No state machines yet.">
        {machines.map((m) => {
          const runs = s.sfn.executions.filter((e) => e.machineArn === m.arn);
          return (
            <Item key={m.name} name={m.name} meta={`${runs.length} run${runs.length === 1 ? "" : "s"}`}>
              <Row k="Role" v={m.roleArn.split("/").pop()} />
              {runs.slice(-6).reverse().map((e) => (
                <Row key={e.arn} k={now(s) < e.stopAt ? "RUNNING" : e.status} v={`${e.name.slice(0, 18)}${e.error ? `  ${e.error}` : ""}`} />
              ))}
            </Item>
          );
        })}
      </Section>

      <Section title="API Gateway" count={apis.length} empty="No APIs yet.">
        {apis.map((a) => (
          <Item key={a.id} name={a.name} meta={a.id}>
            <Row k="URL" v={a.endpoint} />
            {Object.entries(a.routes).map(([k, i]) => (
              <Row key={k} k={k} v={(a.integrations[i] ?? "no target").split(":").pop()} />
            ))}
          </Item>
        ))}
      </Section>

      <Section title="IAM" count={users.length + roles.length} empty="">
        {users.map((u) => {
          const profiles = Object.entries(s.profiles).filter(([, v]) => v.user === u.name).map(([p]) => p);
          return (
            <Item key={u.name} name={`user/${u.name}`} meta={profiles.length ? `profile ${profiles.join(", ")}` : ""}>
              {u.attached.map((a) => (
                <Row key={a} k="Attached" v={a.split("/").pop()} />
              ))}
              {Object.entries(u.inline).map(([n, d]) => (
                <Row key={n} k={`Inline: ${n}`} v={d.length > 200 ? d.slice(0, 200) + "..." : d} />
              ))}
              {!u.attached.length && !Object.keys(u.inline).length && <p className="text-muted">No policies: this user can't do anything yet.</p>}
            </Item>
          );
        })}
        {roles.map((r) => {
          let who = "";
          try {
            const d = JSON.parse(r.trust);
            const st = Array.isArray(d.Statement) ? d.Statement[0] : d.Statement;
            who = [].concat(st?.Principal?.Service ?? st?.Principal?.AWS ?? []).join(", ");
          } catch {}
          return (
            <Item key={r.name} name={`role/${r.name}`} meta={who ? `used by ${who}` : ""}>
              {r.attached.map((a) => (
                <Row key={a} k="Attached" v={a.split("/").pop()} />
              ))}
              {Object.entries(r.inline).map(([n, d]) => (
                <Row key={n} k={`Inline: ${n}`} v={d.length > 200 ? d.slice(0, 200) + "..." : d} />
              ))}
            </Item>
          );
        })}
      </Section>

      <div className="p-3">
        <button
          className="text-[12px] text-muted hover:text-crit"
          onClick={() => {
            if (window.confirm("Delete everything in your practice account and start fresh? Your lesson progress is kept.")) onReset();
          }}
        >
          Reset the practice account
        </button>
      </div>
    </div>
  );
}
