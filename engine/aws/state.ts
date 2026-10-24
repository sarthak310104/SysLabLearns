/**
 * The whole emulated AWS account as plain JSON, so it can be saved in the
 * browser, backed up, and shown in the resources panel. Services read and
 * change it through the helpers in their own files.
 */

export const ACCOUNT_ID = "123456789012";
export const REGION = "ap-south-1";
export const HOME = "/home/you";

export interface S3Object {
  body: string;
  size: number;
  contentType: string;
  lastModified: number;
  etag: string;
  versionId?: string;
}

export interface S3Bucket {
  name: string;
  region: string;
  createdAt: number;
  objects: Record<string, S3Object>;
  /** Older versions, newest last, when versioning is on. */
  versions?: Record<string, S3Object[]>;
  versioning?: "Enabled" | "Suspended";
  policy?: string;
  publicAccessBlock: { BlockPublicAcls: boolean; IgnorePublicAcls: boolean; BlockPublicPolicy: boolean; RestrictPublicBuckets: boolean };
  tags?: Record<string, string>;
  /** Static website hosting, when turned on. */
  website?: { index: string; error?: string };
}

export interface SqsMessage {
  id: string;
  body: string;
  md5: string;
  sentAt: number;
  visibleAt: number;
  receiveCount: number;
  receiptHandle?: string;
  attributes?: Record<string, unknown>;
  groupId?: string;
  dedupId?: string;
}

export interface SqsQueue {
  name: string;
  url: string;
  arn: string;
  createdAt: number;
  attributes: Record<string, string>;
  messages: SqsMessage[];
  policy?: string;
  /** Running totals the labs use to see what you've tried. */
  stats?: { redelivered?: number; deadLettered?: number; fromSns?: number };
}

export interface SnsSubscription {
  arn: string;
  protocol: string;
  endpoint: string;
  raw?: boolean;
  filterPolicy?: string;
}

export interface SnsTopic {
  name: string;
  arn: string;
  subscriptions: SnsSubscription[];
}

export type DdbValue = Record<string, unknown>;
export type DdbItem = Record<string, DdbValue>;

export interface DdbKeyElement {
  AttributeName: string;
  KeyType: "HASH" | "RANGE";
}

export interface DdbIndex {
  IndexName: string;
  KeySchema: DdbKeyElement[];
  Projection: { ProjectionType: string; NonKeyAttributes?: string[] };
}

export interface DdbTable {
  name: string;
  arn: string;
  createdAt: number;
  activeAt: number;
  keySchema: DdbKeyElement[];
  attributeDefinitions: { AttributeName: string; AttributeType: "S" | "N" | "B" }[];
  gsis: DdbIndex[];
  billingMode: string;
  items: DdbItem[];
}

export interface LambdaFunction {
  name: string;
  arn: string;
  runtime: string;
  handler: string;
  role: string;
  /** Files in the deployment package. */
  code: Record<string, string>;
  codeSize: number;
  timeout: number;
  memory: number;
  env: Record<string, string>;
  createdAt: number;
  activeAt: number;
  lastModified: number;
  stats?: { invocations: number; errors: number; bySource: Record<string, number> };
  /** Resource policy statements (who may invoke). */
  permissions: { sid: string; principal: string; action: string; sourceArn?: string }[];
}

export interface EventSourceMapping {
  uuid: string;
  functionArn: string;
  sourceArn: string;
  batchSize: number;
  enabled: boolean;
  createdAt: number;
}

export interface LogEvent {
  t: number;
  message: string;
}

export interface LogGroup {
  name: string;
  createdAt: number;
  streams: Record<string, LogEvent[]>;
}

export interface IamPolicyDoc {
  Version?: string;
  Statement: IamStatement[] | IamStatement;
}

export interface IamStatement {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action?: string | string[];
  NotAction?: string | string[];
  Resource?: string | string[];
  Principal?: unknown;
  Condition?: unknown;
}

export interface IamUser {
  name: string;
  arn: string;
  createdAt: number;
  attached: string[];
  inline: Record<string, string>;
  groups: string[];
  /** Access key ids belonging to this user. */
  keys?: string[];
}

export interface IamRole {
  name: string;
  arn: string;
  createdAt: number;
  trust: string;
  attached: string[];
  inline: Record<string, string>;
  description?: string;
}

export interface IamManagedPolicy {
  name: string;
  arn: string;
  document: string;
  createdAt: number;
}

export interface HttpApi {
  id: string;
  name: string;
  endpoint: string;
  createdAt: number;
  /** routeKey ("$default", "GET /items") to integration id. */
  routes: Record<string, string>;
  /** Integration id to Lambda ARN. */
  integrations: Record<string, string>;
}

export interface CfDistribution {
  id: string;
  arn: string;
  domain: string;
  createdAt: number;
  /** Changes take a while to reach every edge location. */
  deployedAt: number;
  etag: string;
  enabled: boolean;
  comment: string;
  callerReference: string;
  defaultRootObject: string;
  origin: { id: string; domain: string; oacId: string };
  /** Seconds a response stays cached by default. */
  defaultTtl: number;
  /** Path to cached copy. */
  cache: Record<string, { body: string; contentType: string; status: number; at: number }>;
  invalidations: { id: string; paths: string[]; at: number }[];
  stats?: { hits: number; misses: number };
}

export interface CfOac {
  id: string;
  name: string;
  etag: string;
  signingBehavior: string;
  originType: string;
}

export interface EventRule {
  name: string;
  arn: string;
  createdAt: number;
  state: "ENABLED" | "DISABLED";
  description?: string;
  schedule?: string;
  pattern?: string;
  targets: { Id: string; Arn: string; Input?: string }[];
  /** When the schedule fires next (simulated clock). */
  nextAt?: number;
  stats: { triggered: number; invocations: number; failed: number };
}

export interface SfnMachine {
  name: string;
  arn: string;
  definition: string;
  roleArn: string;
  type: "STANDARD" | "EXPRESS";
  createdAt: number;
}

export interface SfnHistoryEvent {
  id: number;
  previousEventId: number;
  timestamp: number;
  type: string;
  details?: Record<string, unknown>;
}

export interface SfnExecution {
  arn: string;
  name: string;
  machineArn: string;
  startedAt: number;
  /** Wait states push this later: until then it reports RUNNING. */
  stopAt: number;
  input: string;
  status: "SUCCEEDED" | "FAILED";
  output?: string;
  error?: string;
  cause?: string;
  history: SfnHistoryEvent[];
}

export interface AwsState {
  version: 1;
  /** Added to the real clock: `sleep` moves time forward without waiting. */
  clockOffset: number;
  seq: number;
  cwd: string;
  files: Record<string, string>;
  env: Record<string, string>;
  profiles: Record<string, { user: string }>;
  s3: { buckets: Record<string, S3Bucket> };
  sqs: { queues: Record<string, SqsQueue> };
  sns: { topics: Record<string, SnsTopic> };
  dynamodb: { tables: Record<string, DdbTable> };
  lambda: { functions: Record<string, LambdaFunction>; mappings: EventSourceMapping[] };
  logs: { groups: Record<string, LogGroup> };
  iam: { users: Record<string, IamUser>; roles: Record<string, IamRole>; policies: Record<string, IamManagedPolicy> };
  apigw: { apis: Record<string, HttpApi> };
  cloudfront: { distributions: Record<string, CfDistribution>; oacs: Record<string, CfOac> };
  events: { rules: Record<string, EventRule> };
  sfn: { machines: Record<string, SfnMachine>; executions: SfnExecution[] };
}

export function freshState(): AwsState {
  return {
    version: 1,
    clockOffset: 0,
    seq: 1,
    cwd: HOME,
    files: {
      [`${HOME}/hello.txt`]: "Hello from my laptop!\n",
    },
    env: { AWS_REGION: REGION, AWS_DEFAULT_REGION: REGION },
    profiles: { default: { user: "you" } },
    s3: { buckets: {} },
    sqs: { queues: {} },
    sns: { topics: {} },
    dynamodb: { tables: {} },
    lambda: { functions: {}, mappings: [] },
    logs: { groups: {} },
    iam: {
      users: {
        you: {
          name: "you",
          arn: `arn:aws:iam::${ACCOUNT_ID}:user/you`,
          createdAt: Date.now(),
          attached: ["arn:aws:iam::aws:policy/AdministratorAccess"],
          inline: {},
          groups: [],
        },
      },
      roles: {},
      policies: {},
    },
    apigw: { apis: {} },
    cloudfront: { distributions: {}, oacs: {} },
    events: { rules: {} },
    sfn: { machines: {}, executions: [] },
  };
}

/** Accounts saved before newer services existed get empty ones. */
export function upgradeState(s: AwsState): AwsState {
  s.cloudfront ??= { distributions: {}, oacs: {} };
  s.events ??= { rules: {} };
  s.sfn ??= { machines: {}, executions: [] };
  return s;
}

/* ------------------------------------------------------------------ */
/* Small helpers shared by every service                               */
/* ------------------------------------------------------------------ */

export function now(s: AwsState): number {
  return Date.now() + s.clockOffset;
}

/** Deterministic-looking ids: hex built from a counter, so tests are stable. */
export function nextId(s: AwsState, len = 8): string {
  const n = s.seq++;
  let h = (Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0).toString(16) + (Math.imul(n + 17, 0xc2b2ae35) >>> 0).toString(16);
  while (h.length < len) h += h;
  return h.slice(0, len);
}

export function uuid(s: AwsState): string {
  const h = nextId(s, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function iso(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** An AWS service error, printed the way the real CLI prints them. */
export class AwsError extends Error {
  constructor(
    public code: string,
    message: string,
    public operation = "",
  ) {
    super(message);
  }
}

/** A problem with how the command was typed (the CLI's own usage errors). */
export class UsageError extends Error {}

/** MD5, needed for SQS message checksums and S3 ETags. */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = bytes.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const bits = len * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let A = a0,
      B = b0,
      C = c0,
      D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) (F = (B & C) | (~B & D)), (g = i);
      else if (i < 32) (F = (D & B) | (~D & C)), (g = (5 * i + 1) % 16);
      else if (i < 48) (F = B ^ C ^ D), (g = (3 * i + 5) % 16);
      else (F = C ^ (B | ~D)), (g = (7 * i) % 16);
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const hex = (n: number) => [0, 8, 16, 24].map((s) => ((n >>> s) & 0xff).toString(16).padStart(2, "0")).join("");
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

export const byteLength = (s: string) => new TextEncoder().encode(s).length;
