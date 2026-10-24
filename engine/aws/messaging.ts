import { arn, UsageError, type Call, type Service } from "./cli";
import { ACCOUNT_ID, iso, md5, now, REGION, uuid, type AwsState, type SqsMessage, type SqsQueue } from "./state";

/* ------------------------------------------------------------------ */
/* SQS                                                                 */
/* ------------------------------------------------------------------ */

export const queueUrl = (name: string) => `https://sqs.${REGION}.amazonaws.com/${ACCOUNT_ID}/${name}`;

const DEFAULT_ATTRS: Record<string, string> = {
  VisibilityTimeout: "30",
  MaximumMessageSize: "262144",
  MessageRetentionPeriod: "345600",
  DelaySeconds: "0",
  ReceiveMessageWaitTimeSeconds: "0",
  SqsManagedSseEnabled: "true",
};

const SETTABLE = new Set([
  "VisibilityTimeout",
  "MaximumMessageSize",
  "MessageRetentionPeriod",
  "DelaySeconds",
  "ReceiveMessageWaitTimeSeconds",
  "RedrivePolicy",
  "RedriveAllowPolicy",
  "Policy",
  "FifoQueue",
  "ContentBasedDeduplication",
  "SqsManagedSseEnabled",
  "KmsMasterKeyId",
]);

export function queueByUrl(state: AwsState, url: string): SqsQueue | null {
  const name = url.replace(/\/+$/, "").split("/").pop() ?? "";
  const q = state.sqs.queues[name];
  return q && url.includes("://") ? q : null;
}

export function queueByArn(state: AwsState, a: string): SqsQueue | null {
  return Object.values(state.sqs.queues).find((q) => q.arn === a) ?? null;
}

function needQueue(c: Call): SqsQueue {
  const url = c.str("queue-url", true);
  const q = queueByUrl(c.state, url);
  if (!q) {
    if (!url.includes("://")) {
      throw c.error("InvalidAddress", `The address ${url} is not valid for this endpoint. Pass the full queue URL (get it with: aws sqs get-queue-url --queue-name ${url}).`);
    }
    throw c.error("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
  }
  return q;
}

function parseAttrs(c: Call, name: string): Record<string, string> {
  const raw = c.structured(name);
  if (raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new UsageError(`Error parsing parameter '--${name}': expected Key=Value pairs or a JSON object`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) out[k] = typeof v === "string" ? v : JSON.stringify(v);
  return out;
}

function validateAttrs(c: Call, attrs: Record<string, string>): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (!SETTABLE.has(k)) throw c.error("InvalidAttributeName", `Unknown Attribute ${k}.`);
    if (k === "VisibilityTimeout" && !(Number(v) >= 0 && Number(v) <= 43200)) throw c.error("InvalidAttributeValue", "Invalid value for the parameter VisibilityTimeout.");
    if (k === "RedrivePolicy") {
      let rp: { deadLetterTargetArn?: string; maxReceiveCount?: unknown };
      try {
        rp = JSON.parse(v);
      } catch {
        throw c.error("InvalidAttributeValue", "Invalid value for the parameter RedrivePolicy. Reason: Redrive policy is not a valid JSON map.");
      }
      if (!rp.deadLetterTargetArn || !queueByArn(c.state, rp.deadLetterTargetArn)) {
        throw c.error("AWS.SimpleQueueService.NonExistentQueue", "Value for parameter RedrivePolicy is invalid. Reason: Dead-letter target does not exist.");
      }
      if (!(Number(rp.maxReceiveCount) >= 1)) throw c.error("InvalidAttributeValue", "Value for parameter RedrivePolicy is invalid. Reason: Redrive policy maxReceiveCount must be an integer of at least 1.");
    }
  }
}

/** Put a message on a queue: used by send-message, SNS and Lambda. */
export function enqueue(state: AwsState, q: SqsQueue, body: string, opts: { delay?: number; attributes?: Record<string, unknown>; groupId?: string; dedupId?: string } = {}): SqsMessage {
  const delay = opts.delay ?? Number(q.attributes.DelaySeconds ?? "0");
  const t = now(state);
  const m: SqsMessage = { id: uuid(state), body, md5: md5(body), sentAt: t, visibleAt: t + delay * 1000, receiveCount: 0 };
  if (opts.attributes && Object.keys(opts.attributes).length) m.attributes = opts.attributes;
  if (opts.groupId) m.groupId = opts.groupId;
  if (opts.dedupId) m.dedupId = opts.dedupId;
  q.messages.push(m);
  return m;
}

function expire(state: AwsState, q: SqsQueue): void {
  const keep = Number(q.attributes.MessageRetentionPeriod ?? DEFAULT_ATTRS.MessageRetentionPeriod) * 1000;
  const t = now(state);
  q.messages = q.messages.filter((m) => t - m.sentAt < keep);
}

/** Take up to n visible messages, hiding them for the visibility timeout. Moves over-received ones to the dead-letter queue. */
export function receive(state: AwsState, q: SqsQueue, n: number, visibility?: number): SqsMessage[] {
  expire(state, q);
  const t = now(state);
  const vis = (visibility ?? Number(q.attributes.VisibilityTimeout ?? "30")) * 1000;
  let redrive: { deadLetterTargetArn: string; maxReceiveCount: number } | null = null;
  if (q.attributes.RedrivePolicy) {
    try {
      const r = JSON.parse(q.attributes.RedrivePolicy);
      redrive = { deadLetterTargetArn: r.deadLetterTargetArn, maxReceiveCount: Number(r.maxReceiveCount) };
    } catch {}
  }
  const out: SqsMessage[] = [];
  const fifo = q.attributes.FifoQueue === "true";
  const busyGroups = new Set(q.messages.filter((m) => m.visibleAt > t && m.receiveCount > 0 && m.groupId).map((m) => m.groupId));
  for (const m of [...q.messages]) {
    if (out.length >= n) break;
    if (m.visibleAt > t) continue;
    if (fifo && m.groupId && busyGroups.has(m.groupId)) continue;
    if (redrive && m.receiveCount >= redrive.maxReceiveCount) {
      const dlq = queueByArn(state, redrive.deadLetterTargetArn);
      q.messages = q.messages.filter((x) => x !== m);
      if (dlq) {
        dlq.messages.push({ ...m, visibleAt: t, receiptHandle: undefined });
        dlq.stats = { ...dlq.stats, deadLettered: (dlq.stats?.deadLettered ?? 0) + 1 };
      }
      continue;
    }
    m.receiveCount++;
    if (m.receiveCount === 2) q.stats = { ...q.stats, redelivered: (q.stats?.redelivered ?? 0) + 1 };
    m.visibleAt = t + vis;
    m.receiptHandle = btoa(`${m.id}#${m.receiveCount}#${t}`).replace(/=+$/, "") + md5(m.id + t).slice(0, 24);
    m.attributes = { ...(m.attributes ?? {}) };
    if (!m.attributes.__firstReceive) m.attributes.__firstReceive = t;
    out.push(m);
    if (fifo && m.groupId) busyGroups.add(m.groupId);
  }
  return out;
}

export function counts(state: AwsState, q: SqsQueue) {
  expire(state, q);
  const t = now(state);
  let visible = 0,
    inflight = 0,
    delayed = 0;
  for (const m of q.messages) {
    if (m.visibleAt <= t) visible++;
    else if (m.receiveCount > 0) inflight++;
    else delayed++;
  }
  return { visible, inflight, delayed };
}

function allAttributes(state: AwsState, q: SqsQueue): Record<string, string> {
  const n = counts(state, q);
  return {
    QueueArn: q.arn,
    ApproximateNumberOfMessages: String(n.visible),
    ApproximateNumberOfMessagesNotVisible: String(n.inflight),
    ApproximateNumberOfMessagesDelayed: String(n.delayed),
    CreatedTimestamp: String(Math.floor(q.createdAt / 1000)),
    LastModifiedTimestamp: String(Math.floor(q.createdAt / 1000)),
    ...DEFAULT_ATTRS,
    ...q.attributes,
  };
}

const userAttrs = (m: SqsMessage) => Object.fromEntries(Object.entries(m.attributes ?? {}).filter(([k]) => !k.startsWith("__")));

const sqs: Service = {
  blurb: "Simple Queue Service: queues that hold messages until a worker takes them",
  commands: {
    "create-queue": (c) => {
      const name = c.str("queue-name", true);
      if (!/^[A-Za-z0-9_-]{1,80}(\.fifo)?$/.test(name)) throw c.error("InvalidParameterValue", "Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length");
      c.authorize("sqs:CreateQueue", arn.sqs(name));
      const attrs = parseAttrs(c, "attributes");
      validateAttrs(c, attrs);
      if (name.endsWith(".fifo") !== (attrs.FifoQueue === "true")) {
        throw c.error("InvalidParameterValue", name.endsWith(".fifo") ? "The queue name ends in .fifo, so set FifoQueue=true." : "A FIFO queue's name must end in .fifo");
      }
      const existing = c.state.sqs.queues[name];
      if (existing) {
        const differs = Object.entries(attrs).some(([k, v]) => (existing.attributes[k] ?? DEFAULT_ATTRS[k]) !== v);
        if (differs) throw c.error("QueueAlreadyExists", "A queue already exists with the same name and a different value for attribute(s)");
        return { QueueUrl: existing.url };
      }
      c.state.sqs.queues[name] = { name, url: queueUrl(name), arn: arn.sqs(name), createdAt: now(c.state), attributes: attrs, messages: [] };
      return { QueueUrl: queueUrl(name) };
    },
    "get-queue-url": (c) => {
      const name = c.str("queue-name", true);
      c.authorize("sqs:GetQueueUrl", arn.sqs(name));
      const q = c.state.sqs.queues[name];
      if (!q) throw c.error("AWS.SimpleQueueService.NonExistentQueue", "The specified queue does not exist.");
      return { QueueUrl: q.url };
    },
    "list-queues": (c) => {
      c.authorize("sqs:ListQueues", "*");
      const prefix = c.str("queue-name-prefix") ?? "";
      const urls = Object.values(c.state.sqs.queues)
        .filter((q) => q.name.startsWith(prefix))
        .map((q) => q.url);
      return urls.length ? { QueueUrls: urls } : undefined;
    },
    "delete-queue": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:DeleteQueue", q.arn);
      delete c.state.sqs.queues[q.name];
    },
    "purge-queue": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:PurgeQueue", q.arn);
      q.messages = [];
    },
    "get-queue-attributes": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:GetQueueAttributes", q.arn);
      const names = c.list("attribute-names");
      const all = allAttributes(c.state, q);
      if (!names.length) return undefined;
      if (names.includes("All")) return { Attributes: all };
      const out: Record<string, string> = {};
      for (const n of names) if (all[n] !== undefined) out[n] = all[n];
      return { Attributes: out };
    },
    "set-queue-attributes": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:SetQueueAttributes", q.arn);
      const attrs = parseAttrs(c, "attributes");
      validateAttrs(c, attrs);
      Object.assign(q.attributes, attrs);
    },
    "send-message": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:SendMessage", q.arn);
      const body = c.str("message-body", true);
      if (!body.length) throw c.error("MissingParameter", "The request must contain the parameter MessageBody.");
      const fifo = q.attributes.FifoQueue === "true";
      const groupId = c.str("message-group-id");
      let dedupId = c.str("message-deduplication-id");
      if (fifo && !groupId) throw c.error("MissingParameter", "The request must contain the parameter MessageGroupId.");
      if (fifo && !dedupId) {
        if (q.attributes.ContentBasedDeduplication !== "true") {
          throw c.error("InvalidParameterValue", "The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly");
        }
        dedupId = md5(body);
      }
      // FIFO queues drop a repeat of the same deduplication id within 5 minutes.
      if (fifo && q.messages.some((m) => m.dedupId === dedupId && now(c.state) - m.sentAt < 300000)) {
        const dup = q.messages.find((m) => m.dedupId === dedupId)!;
        return { MD5OfMessageBody: dup.md5, MessageId: dup.id, SequenceNumber: String(dup.sentAt) };
      }
      const attrs = c.structured("message-attributes") as Record<string, unknown> | undefined;
      const m = enqueue(c.state, q, body, { delay: c.int("delay-seconds"), attributes: attrs, groupId, dedupId });
      return { MD5OfMessageBody: m.md5, MessageId: m.id, ...(fifo ? { SequenceNumber: String(m.sentAt) } : {}) };
    },
    "receive-message": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:ReceiveMessage", q.arn);
      const n = c.int("max-number-of-messages", 1)!;
      if (n < 1 || n > 10) throw c.error("InvalidParameterValue", `Value ${n} for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.`);
      const msgs = receive(c.state, q, n, c.int("visibility-timeout"));
      if (!msgs.length) return undefined;
      const wantAttrs = c.list("attribute-names").length || c.list("message-system-attribute-names").length;
      return {
        Messages: msgs.map((m) => ({
          MessageId: m.id,
          ReceiptHandle: m.receiptHandle,
          MD5OfBody: m.md5,
          Body: m.body,
          ...(wantAttrs
            ? {
                Attributes: {
                  SenderId: "AIDAEXAMPLEUSERID",
                  ApproximateFirstReceiveTimestamp: String(m.attributes?.__firstReceive ?? now(c.state)),
                  ApproximateReceiveCount: String(m.receiveCount),
                  SentTimestamp: String(m.sentAt),
                  ...(m.groupId ? { MessageGroupId: m.groupId } : {}),
                },
              }
            : {}),
          ...(Object.keys(userAttrs(m)).length ? { MessageAttributes: userAttrs(m) } : {}),
        })),
      };
    },
    "delete-message": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:DeleteMessage", q.arn);
      const handle = c.str("receipt-handle", true);
      const before = q.messages.length;
      q.messages = q.messages.filter((m) => m.receiptHandle !== handle);
      if (q.messages.length === before) throw c.error("ReceiptHandleIsInvalid", `The input receipt handle "${handle.slice(0, 20)}..." is not a valid receipt handle.`);
    },
    "change-message-visibility": (c) => {
      const q = needQueue(c);
      c.authorize("sqs:ChangeMessageVisibility", q.arn);
      const handle = c.str("receipt-handle", true);
      const secs = c.int("visibility-timeout", 0)!;
      const m = q.messages.find((x) => x.receiptHandle === handle);
      if (!m) throw c.error("ReceiptHandleIsInvalid", "The input receipt handle is not a valid receipt handle.");
      m.visibleAt = now(c.state) + secs * 1000;
    },
  },
};

/* ------------------------------------------------------------------ */
/* SNS                                                                 */
/* ------------------------------------------------------------------ */

function needTopic(c: Call, a: string) {
  const t = Object.values(c.state.sns.topics).find((x) => x.arn === a);
  if (!t) throw c.error("NotFound", "Topic does not exist");
  return t;
}

/** Does a message with these attributes pass a subscription's filter policy? */
function passesFilter(policy: string | undefined, attrs: Record<string, { DataType?: string; StringValue?: string }>): boolean {
  if (!policy) return true;
  let p: Record<string, unknown[]>;
  try {
    p = JSON.parse(policy);
  } catch {
    return true;
  }
  for (const [k, allowed] of Object.entries(p)) {
    const v = attrs[k]?.StringValue;
    if (v === undefined) return false;
    const ok = allowed.some((a) => (typeof a === "object" && a && "prefix" in (a as object) ? v.startsWith(String((a as { prefix: string }).prefix)) : String(a) === v));
    if (!ok) return false;
  }
  return true;
}

const sns: Service = {
  blurb: "Simple Notification Service: publish once, deliver to every subscriber",
  commands: {
    "create-topic": (c) => {
      const name = c.str("name", true);
      if (!/^[A-Za-z0-9_-]{1,256}(\.fifo)?$/.test(name)) throw c.error("InvalidParameter", "Invalid parameter: Topic Name");
      c.authorize("sns:CreateTopic", arn.sns(name));
      c.state.sns.topics[name] ??= { name, arn: arn.sns(name), subscriptions: [] };
      return { TopicArn: arn.sns(name) };
    },
    "list-topics": (c) => {
      c.authorize("sns:ListTopics", "*");
      return { Topics: Object.values(c.state.sns.topics).map((t) => ({ TopicArn: t.arn })) };
    },
    "delete-topic": (c) => {
      const t = needTopic(c, c.str("topic-arn", true));
      c.authorize("sns:DeleteTopic", t.arn);
      delete c.state.sns.topics[t.name];
    },
    subscribe: (c) => {
      const t = needTopic(c, c.str("topic-arn", true));
      c.authorize("sns:Subscribe", t.arn);
      const protocol = c.str("protocol", true);
      const endpoint = c.str("notification-endpoint") ?? "";
      if (!["sqs", "lambda", "email", "email-json", "http", "https"].includes(protocol)) throw c.error("InvalidParameter", "Invalid parameter: Amazon SNS does not support this protocol string");
      if (protocol === "sqs" && !queueByArn(c.state, endpoint)) {
        throw c.error("InvalidParameter", `Invalid parameter: SQS endpoint ARN${endpoint.startsWith("https://") ? " (use the queue ARN, not its URL: aws sqs get-queue-attributes --attribute-names QueueArn)" : ""}`);
      }
      if (protocol === "lambda" && !Object.values(c.state.lambda.functions).some((f) => f.arn === endpoint)) throw c.error("InvalidParameter", "Invalid parameter: Lambda endpoint ARN");
      const attrs = parseAttrs(c, "attributes");
      const existing = t.subscriptions.find((s) => s.protocol === protocol && s.endpoint === endpoint);
      if (existing) return { SubscriptionArn: existing.arn };
      const sub = { arn: `${t.arn}:${uuid(c.state)}`, protocol, endpoint, raw: attrs.RawMessageDelivery === "true", filterPolicy: attrs.FilterPolicy };
      t.subscriptions.push(sub);
      if (protocol.startsWith("email") || protocol.startsWith("http")) return { SubscriptionArn: "pending confirmation" };
      return { SubscriptionArn: sub.arn };
    },
    "set-subscription-attributes": (c) => {
      const subArn = c.str("subscription-arn", true);
      const name = c.str("attribute-name", true);
      const value = c.str("attribute-value") ?? "";
      for (const t of Object.values(c.state.sns.topics)) {
        const s = t.subscriptions.find((x) => x.arn === subArn);
        if (!s) continue;
        if (name === "RawMessageDelivery") s.raw = value === "true";
        else if (name === "FilterPolicy") s.filterPolicy = value;
        else throw c.error("InvalidParameter", `Invalid parameter: AttributeName`);
        return;
      }
      throw c.error("NotFound", "Subscription does not exist");
    },
    unsubscribe: (c) => {
      const subArn = c.str("subscription-arn", true);
      for (const t of Object.values(c.state.sns.topics)) t.subscriptions = t.subscriptions.filter((s) => s.arn !== subArn);
    },
    "list-subscriptions": (c) => ({
      Subscriptions: Object.values(c.state.sns.topics).flatMap((t) =>
        t.subscriptions.map((s) => ({ SubscriptionArn: s.arn, Owner: ACCOUNT_ID, Protocol: s.protocol, Endpoint: s.endpoint, TopicArn: t.arn })),
      ),
    }),
    "list-subscriptions-by-topic": (c) => {
      const t = needTopic(c, c.str("topic-arn", true));
      return { Subscriptions: t.subscriptions.map((s) => ({ SubscriptionArn: s.arn, Owner: ACCOUNT_ID, Protocol: s.protocol, Endpoint: s.endpoint, TopicArn: t.arn })) };
    },
    publish: async (c) => {
      const t = needTopic(c, c.str("topic-arn", true));
      c.authorize("sns:Publish", t.arn);
      const message = c.str("message", true);
      const subject = c.str("subject");
      const attrs = (c.structured("message-attributes") ?? {}) as Record<string, { DataType?: string; StringValue?: string }>;
      const id = uuid(c.state);
      const ts = iso(now(c.state)).replace("+00:00", ".000Z");
      for (const s of t.subscriptions) {
        if (!passesFilter(s.filterPolicy, attrs)) continue;
        const envelope = {
          Type: "Notification",
          MessageId: id,
          TopicArn: t.arn,
          ...(subject ? { Subject: subject } : {}),
          Message: message,
          Timestamp: ts,
          SignatureVersion: "1",
          Signature: md5(id + message),
          SigningCertURL: `https://sns.${REGION}.amazonaws.com/SimpleNotificationService-lab.pem`,
          UnsubscribeURL: `https://sns.${REGION}.amazonaws.com/?Action=Unsubscribe&SubscriptionArn=${s.arn}`,
          ...(Object.keys(attrs).length ? { MessageAttributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { Type: v.DataType ?? "String", Value: v.StringValue }])) } : {}),
        };
        if (s.protocol === "sqs") {
          const q = queueByArn(c.state, s.endpoint);
          if (q) {
            enqueue(c.state, q, s.raw ? message : JSON.stringify(envelope, null, 2));
            q.stats = { ...q.stats, fromSns: (q.stats?.fromSns ?? 0) + 1 };
          }
        } else if (s.protocol === "lambda") {
          await c.rt.invokeLambda(c.state, s.endpoint, { Records: [{ EventSource: "aws:sns", EventVersion: "1.0", EventSubscriptionArn: s.arn, Sns: envelope }] }, "sns");
        }
      }
      return { MessageId: id };
    },
  },
};

export const MESSAGING_SERVICES = { sqs, sns };
