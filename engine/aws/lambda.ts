import { transform } from "sucrase";
import { arn, Call, UsageError, type Io, type Runtime, type Service } from "./cli";
import { decide, principalForRole, trusts, type Principal } from "./iam-eval";
import { counts, queueByArn, receive } from "./messaging";
import { ACCOUNT_ID, AwsError, byteLength, iso, md5, now, REGION, uuid, type AwsState, type LambdaFunction } from "./state";

export const ZIP_MAGIC = "PK\u0003\u0004LABZIP:";
export const isZip = (s: string) => s.startsWith(ZIP_MAGIC);
export function makeZip(files: Record<string, string>): string {
  return ZIP_MAGIC + JSON.stringify(files);
}
export function readZip(s: string): Record<string, string> | null {
  if (!isZip(s)) return null;
  try {
    return JSON.parse(s.slice(ZIP_MAGIC.length));
  } catch {
    return null;
  }
}

const RUNTIMES = ["nodejs18.x", "nodejs20.x", "nodejs22.x"];

function config(state: AwsState, f: LambdaFunction) {
  const pending = now(state) < f.activeAt;
  return {
    FunctionName: f.name,
    FunctionArn: f.arn,
    Runtime: f.runtime,
    Role: f.role,
    Handler: f.handler,
    CodeSize: f.codeSize,
    Description: "",
    Timeout: f.timeout,
    MemorySize: f.memory,
    LastModified: iso(f.lastModified).replace("+00:00", ".000+0000"),
    CodeSha256: btoa(md5(JSON.stringify(f.code))).slice(0, 44),
    Version: "$LATEST",
    ...(Object.keys(f.env).length ? { Environment: { Variables: f.env } } : {}),
    TracingConfig: { Mode: "PassThrough" },
    RevisionId: md5(f.arn + f.lastModified).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5"),
    State: pending ? "Pending" : "Active",
    ...(pending ? { StateReason: "The function is being created.", StateReasonCode: "Creating" } : {}),
    LastUpdateStatus: "Successful",
    PackageType: "Zip",
    Architectures: ["x86_64"],
    EphemeralStorage: { Size: 512 },
    LoggingConfig: { LogFormat: "Text", LogGroup: `/aws/lambda/${f.name}` },
  };
}

function needFunction(c: Call, name: string, action: string): LambdaFunction {
  const fname = name.startsWith("arn:") ? (name.split(":").pop() ?? name) : name;
  c.authorize(action, arn.lambda(fname));
  const f = c.state.lambda.functions[fname];
  if (!f) throw c.error("ResourceNotFoundException", `Function not found: ${arn.lambda(fname)}`);
  return f;
}

function checkRole(c: Call, roleArn: string): void {
  const name = roleArn.split("/").pop() ?? "";
  const role = c.state.iam.roles[name];
  if (!roleArn.startsWith(`arn:aws:iam::${ACCOUNT_ID}:role/`) || !role || role.arn !== roleArn) {
    throw c.error("InvalidParameterValueException", "The role defined for the function cannot be assumed by Lambda.");
  }
  if (!trusts(role.trust, "lambda.amazonaws.com")) throw c.error("InvalidParameterValueException", "The role defined for the function cannot be assumed by Lambda.");
}

function codeFrom(c: Call, required: boolean): Record<string, string> | undefined {
  const raw = c.binaryFile("zip-file", required);
  if (raw === undefined) return undefined;
  const files = readZip(raw);
  if (!files) {
    throw c.error(
      "InvalidParameterValueException",
      "Could not unzip uploaded file. Please check your file, then try to upload again. (Lambda needs a .zip deployment package: try `zip function.zip index.mjs`.)",
    );
  }
  return files;
}

function envFrom(c: Call): Record<string, string> | undefined {
  const raw = c.structured("environment") as { Variables?: Record<string, unknown> } | undefined;
  if (!raw) return undefined;
  return Object.fromEntries(Object.entries(raw.Variables ?? {}).map(([k, v]) => [k, String(v)]));
}

/* ------------------------------------------------------------------ */
/* Running function code                                               */
/* ------------------------------------------------------------------ */

type Mod = { handler: (...a: unknown[]) => unknown };
const moduleCache = new Map<string, Mod>();
/** Functions that have run at least once since the page loaded: later runs skip the cold start. */
const warm = new Set<string>();

class RuntimeError extends Error {
  constructor(
    public errorType: string,
    message: string,
  ) {
    super(message);
  }
}

function loadModule(f: LambdaFunction, requireFn: (name: string, from: string) => unknown): Mod {
  const [file, fn] = (() => {
    const i = f.handler.lastIndexOf(".");
    return i < 0 ? [f.handler, ""] : [f.handler.slice(0, i), f.handler.slice(i + 1)];
  })();
  const candidates = [`${file}.mjs`, `${file}.js`, `${file}.cjs`];
  const found = candidates.find((n) => n in f.code);
  if (!found) throw new RuntimeError("Runtime.ImportModuleError", `Error: Cannot find module '${file}'\nRequire stack:\n- /var/runtime/index.mjs`);
  const key = md5(JSON.stringify(f.code) + f.handler);
  const cached = moduleCache.get(key);
  if (cached) return cached;

  const cache = new Map<string, Record<string, unknown>>();
  const load = (path: string): Record<string, unknown> => {
    if (cache.has(path)) return cache.get(path)!;
    const src = f.code[path];
    if (path.endsWith(".js") && /^\s*(export|import)\s/m.test(src)) {
      throw new RuntimeError("Runtime.UserCodeSyntaxError", `SyntaxError: ${/^\s*import\s/m.test(src) ? "Cannot use import statement outside a module" : "Unexpected token 'export'"} (name the file ${path.replace(/\.js$/, ".mjs")} to use import/export)`);
    }
    let js: string;
    try {
      js = transform(src, { transforms: ["imports"], production: true }).code;
    } catch (e) {
      throw new RuntimeError("Runtime.UserCodeSyntaxError", `SyntaxError: ${e instanceof Error ? e.message : String(e)}`);
    }
    const exports: Record<string, unknown> = {};
    const module = { exports };
    cache.set(path, exports);
    const req = (name: string) => {
      if (name.startsWith("./") || name.startsWith("../")) {
        const base = name.replace(/^\.\//, "");
        const hit = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`].find((n) => n in f.code);
        if (!hit) throw new RuntimeError("Runtime.ImportModuleError", `Error: Cannot find module '${name}' imported from /var/task/${path}`);
        return load(hit);
      }
      return requireFn(name, path);
    };
    try {
      const noNet = () => {
        throw new Error("This practice Lambda can't reach the internet. Use the AWS SDK to call other services in your account.");
      };
      new Function("exports", "module", "require", "process", "__filename", "__dirname", "fetch", "XMLHttpRequest", "importScripts", "WebSocket", js)(
        exports,
        module,
        req,
        fakeProcess(f),
        `/var/task/${path}`,
        "/var/task",
        noNet,
        undefined,
        noNet,
        undefined,
      );
    } catch (e) {
      if (e instanceof RuntimeError) throw e;
      throw new RuntimeError("Runtime.UserCodeSyntaxError", `${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
    cache.set(path, module.exports as Record<string, unknown>);
    return module.exports as Record<string, unknown>;
  };
  const exp = load(found);
  const handler = (exp[fn] ?? (exp.default as Record<string, unknown> | undefined)?.[fn]) as Mod["handler"] | undefined;
  if (typeof handler !== "function") throw new RuntimeError("Runtime.HandlerNotFound", `${file}.${fn} is undefined or not exported`);
  const mod = { handler };
  moduleCache.set(key, mod);
  return mod;
}

let currentEnv: Record<string, string> = {};
function fakeProcess(f: LambdaFunction) {
  return {
    env: new Proxy({}, { get: (_t, k) => (typeof k === "string" ? currentEnv[k] : undefined), has: (_t, k) => typeof k === "string" && k in currentEnv, ownKeys: () => Object.keys(currentEnv), getOwnPropertyDescriptor: (_t, k) => (typeof k === "string" && k in currentEnv ? { enumerable: true, configurable: true, value: currentEnv[k] } : undefined) }),
    version: "v20.17.0",
    platform: "linux",
    arch: "x64",
    cwd: () => "/var/task",
    exit: () => {
      throw new RuntimeError("Runtime.ExitError", `RequestId: ${f.name} Error: Runtime exited without providing a reason`);
    },
  };
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a, null, 2);
  } catch {
    return String(a);
  }
}

/** Where a function's logs go, if its role is allowed to write them. */
function writeLogs(state: AwsState, f: LambdaFunction, lines: string[], at: number): void {
  const role = principalForRole(f.role, f.name);
  if (decide(state, role, "logs:PutLogEvents", `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/lambda/${f.name}:*`) !== "allow") return;
  const gname = `/aws/lambda/${f.name}`;
  const g = (state.logs.groups[gname] ??= { name: gname, createdAt: at, streams: {} });
  const d = new Date(at);
  const stream = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/[$LATEST]${md5(f.arn + f.lastModified).slice(0, 32)}`;
  const s = (g.streams[stream] ??= []);
  lines.forEach((m, i) => s.push({ t: at + i, message: m }));
  if (s.length > 500) s.splice(0, s.length - 500);
}

export interface InvokeResult {
  ok: boolean;
  result: unknown;
  error?: { errorMessage: string; errorType: string; trace?: string[] };
  logs: string[];
}

export function createRuntime(services: () => Record<string, Service>, io: () => Io): Runtime & { invokeFull: typeof invokeFull } {
  async function invokeFull(state: AwsState, functionArn: string, event: unknown, source: string): Promise<InvokeResult> {
    const name = functionArn.split(":").pop() ?? functionArn;
    const f = state.lambda.functions[name];
    if (!f) return { ok: false, result: null, error: { errorType: "ResourceNotFoundException", errorMessage: `Function not found: ${functionArn}` }, logs: [] };
    const requestId = uuid(state);
    const started = now(state);
    const role = principalForRole(f.role, f.name);
    const lines: string[] = [];
    const stamp = () => new Date(now(state)).toISOString();
    const log = (level: string) => (...args: unknown[]) => lines.push(`${stamp()}\t${requestId}\t${level}\t${args.map(formatArg).join(" ")}`);
    const fakeConsole = { log: log("INFO"), info: log("INFO"), warn: log("WARN"), error: log("ERROR"), debug: log("DEBUG"), trace: log("TRACE") };
    const cold = !warm.has(f.arn + f.lastModified);
    lines.push(`START RequestId: ${requestId} Version: $LATEST`);

    currentEnv = {
      ...f.env,
      AWS_REGION: REGION,
      AWS_DEFAULT_REGION: REGION,
      AWS_LAMBDA_FUNCTION_NAME: f.name,
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(f.memory),
      AWS_LAMBDA_FUNCTION_VERSION: "$LATEST",
      AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${f.name}`,
      AWS_EXECUTION_ENV: `AWS_Lambda_${f.runtime}`,
      LAMBDA_TASK_ROOT: "/var/task",
      TZ: ":UTC",
    };

    const sdk = makeSdk(state, role, services(), runtime);
    const requireFn = (n: string, from: string) => {
      const m = sdk[n.replace(/^node:/, "")];
      if (m) return m;
      throw new RuntimeError("Runtime.ImportModuleError", `Error: Cannot find package '${n}' imported from /var/task/${from}\nOnly the AWS SDK v3 and Node's built-in modules are available unless you add packages to your zip.`);
    };

    let result: unknown = null;
    let error: InvokeResult["error"];
    const realConsole = globalThis.console;
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      (globalThis as { console: unknown }).console = fakeConsole;
      const mod = loadModule(f, requireFn);
      const context = {
        awsRequestId: requestId,
        functionName: f.name,
        functionVersion: "$LATEST",
        invokedFunctionArn: f.arn,
        memoryLimitInMB: String(f.memory),
        logGroupName: `/aws/lambda/${f.name}`,
        logStreamName: "",
        callbackWaitsForEmptyEventLoop: true,
        getRemainingTimeInMillis: () => Math.max(0, f.timeout * 1000 - (performance.now() - t0)),
      };
      const run = new Promise<unknown>((resolve, reject) => {
        try {
          if (mod.handler.length >= 3) {
            mod.handler(event, context, (err: unknown, value: unknown) => (err ? reject(err) : resolve(value)));
          } else resolve(mod.handler(event, context));
        } catch (e) {
          reject(e);
        }
      });
      const timeout = new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new RuntimeError("Sandbox.Timedout", `${stamp()} ${requestId} Task timed out after ${f.timeout.toFixed(2)} seconds`)), f.timeout * 1000);
      });
      timeout.catch(() => {});
      result = await Promise.race([run, timeout]);
      if (result !== undefined) JSON.stringify(result);
    } catch (e) {
      if (e instanceof RuntimeError) error = { errorType: e.errorType, errorMessage: e.message };
      else if (e instanceof Error) error = { errorType: e.name || "Error", errorMessage: e.message, trace: [`${e.name}: ${e.message}`, `    at Runtime.handler (file:///var/task/${f.handler.split(".")[0]}.mjs)`] };
      else error = { errorType: "string", errorMessage: String(e) };
      lines.push(`${stamp()}\t${requestId}\tERROR\tInvoke Error \t${JSON.stringify(error)}`);
    } finally {
      clearTimeout(timer);
      (globalThis as { console: unknown }).console = realConsole;
    }
    const dur = performance.now() - t0 + 1.5;
    warm.add(f.arn + f.lastModified);
    lines.push(`END RequestId: ${requestId}`);
    lines.push(
      `REPORT RequestId: ${requestId}\tDuration: ${dur.toFixed(2)} ms\tBilled Duration: ${Math.ceil(dur)} ms\tMemory Size: ${f.memory} MB\tMax Memory Used: ${Math.min(f.memory, 64 + Math.round(byteLength(JSON.stringify(f.code)) / 1024))} MB${cold ? `\tInit Duration: ${(140 + (byteLength(JSON.stringify(f.code)) % 60)).toFixed(2)} ms` : ""}`,
    );
    writeLogs(state, f, lines, started);
    f.stats ??= { invocations: 0, errors: 0, bySource: {} };
    f.stats.invocations++;
    if (error) f.stats.errors++;
    f.stats.bySource[source] = (f.stats.bySource[source] ?? 0) + 1;
    return { ok: !error, result: error ? error : (result ?? null), error, logs: lines };
  }

  const runtime: Runtime & { invokeFull: typeof invokeFull } = {
    invokeFull,
    async invokeLambda(state, functionArn, event, source) {
      const r = await invokeFull(state, functionArn, event, source);
      return { ok: r.ok, result: r.result, error: r.error };
    },
  };
  void io;
  return runtime;
}

/* ------------------------------------------------------------------ */
/* A stand-in AWS SDK v3, running calls through the emulator as the     */
/* function's role                                                     */
/* ------------------------------------------------------------------ */

const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

function makeSdk(state: AwsState, role: Principal, services: Record<string, Service>, rt: Runtime): Record<string, unknown> {
  const tmp: Record<string, string> = {};
  const io: Io = {
    readFile: (p) => tmp[p] ?? "",
    writeFile: (p, c) => {
      tmp[p] = c;
    },
    exists: (p) => p in tmp,
    resolve: (p) => p,
  };

  async function call(service: string, command: string, input: Record<string, unknown>, opts: { binary?: string[]; positional?: string[] } = {}): Promise<Record<string, unknown>> {
    const flags: Record<string, string[] | true> = {};
    const positionals = opts.positional ?? [];
    for (const [k, v] of Object.entries(input ?? {})) {
      if (v === undefined) continue;
      const flag = kebab(k);
      if (opts.binary?.includes(k)) {
        const path = `/tmp/${k}-${Object.keys(tmp).length}`;
        tmp[path] = typeof v === "string" ? v : JSON.stringify(v);
        flags[flag] = [path];
      } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) flags[flag] = v as string[];
      else if (typeof v === "boolean") {
        if (v) flags[flag] = true;
        else if (flag === "scan-index-forward") flags["no-scan-index-forward"] = true;
      } else flags[flag] = [typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v)];
    }
    const handler = services[service]?.commands[command];
    if (!handler) throw new Error(`The lab's SDK doesn't support ${service} ${command} yet`);
    const c = new Call(state, role, service, command, flags, positionals, io, rt);
    try {
      const out = (await handler(c)) as Record<string, unknown> | undefined;
      return { ...(out ?? {}), $metadata: { httpStatusCode: 200, requestId: uuid(state), attempts: 1, totalRetryDelay: 0 } };
    } catch (e) {
      if (e instanceof AwsError) {
        const err = new Error(e.message) as Error & { name: string; $metadata: unknown; __type: string };
        err.name = e.code;
        err.__type = e.code;
        err.$metadata = { httpStatusCode: 400, requestId: uuid(state), attempts: 1 };
        throw err;
      }
      if (e instanceof UsageError) throw new Error(e.message);
      throw e;
    }
  }

  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  const cmd = (service: string, command: string, opts: Parameters<typeof call>[3] = {}) =>
    class extends Command {
      static service = service;
      static command = command;
      static opts = opts;
    };
  type CmdClass = { service: string; command: string; opts: Parameters<typeof call>[3] };
  class Client {
    config: unknown;
    constructor(cfg: unknown = {}) {
      this.config = cfg;
    }
    async send(c: Command) {
      const k = c.constructor as unknown as CmdClass;
      if (!k.service) throw new Error("send() needs a command, like new PutItemCommand({...})");
      return call(k.service, k.command, c.input, k.opts);
    }
    destroy() {}
  }

  const ddb = {
    DynamoDBClient: Client,
    PutItemCommand: cmd("dynamodb", "put-item"),
    GetItemCommand: cmd("dynamodb", "get-item"),
    UpdateItemCommand: cmd("dynamodb", "update-item"),
    DeleteItemCommand: cmd("dynamodb", "delete-item"),
    QueryCommand: cmd("dynamodb", "query"),
    ScanCommand: cmd("dynamodb", "scan"),
    DescribeTableCommand: cmd("dynamodb", "describe-table"),
    ListTablesCommand: cmd("dynamodb", "list-tables"),
    BatchWriteItemCommand: cmd("dynamodb", "batch-write-item"),
  };

  // The document client takes and returns plain JavaScript values.
  const { marshallItem, unmarshallItem } = DDB_CONVERT;
  const docCmd = (command: string) =>
    class extends Command {
      static doc = command;
    };
  class DocClient {
    constructor(private inner: Client) {}
    static from(client: Client) {
      return new DocClient(client);
    }
    async send(c: Command) {
      const command = (c.constructor as unknown as { doc?: string }).doc;
      if (!command) return this.inner.send(c);
      const input = { ...c.input };
      for (const k of ["Item", "Key", "ExclusiveStartKey"]) if (input[k]) input[k] = marshallItem(input[k] as Record<string, unknown>);
      if (input.ExpressionAttributeValues) input.ExpressionAttributeValues = marshallItem(input.ExpressionAttributeValues as Record<string, unknown>);
      const out = await call("dynamodb", command, input);
      if (out.Item) out.Item = unmarshallItem(out.Item as never);
      if (out.Attributes) out.Attributes = unmarshallItem(out.Attributes as never);
      if (Array.isArray(out.Items)) out.Items = (out.Items as never[]).map(unmarshallItem);
      if (out.LastEvaluatedKey) out.LastEvaluatedKey = unmarshallItem(out.LastEvaluatedKey as never);
      return out;
    }
    destroy() {}
  }
  const libDdb = {
    DynamoDBDocumentClient: DocClient,
    PutCommand: docCmd("put-item"),
    GetCommand: docCmd("get-item"),
    UpdateCommand: docCmd("update-item"),
    DeleteCommand: docCmd("delete-item"),
    QueryCommand: docCmd("query"),
    ScanCommand: docCmd("scan"),
  };

  class S3Client extends Client {
    async send(c: Command) {
      const k = c.constructor as unknown as CmdClass;
      if (k.command === "get-object") {
        const out = await call("s3api", "get-object", c.input, { positional: ["/tmp/get"] });
        const body = tmp["/tmp/get"] ?? "";
        return { ...out, Body: { transformToString: async () => body, toString: () => body } };
      }
      return super.send(c);
    }
  }
  const s3 = {
    S3Client,
    PutObjectCommand: cmd("s3api", "put-object", { binary: ["Body"] }),
    GetObjectCommand: cmd("s3api", "get-object"),
    ListObjectsV2Command: cmd("s3api", "list-objects-v2"),
    DeleteObjectCommand: cmd("s3api", "delete-object"),
    HeadObjectCommand: cmd("s3api", "head-object"),
  };
  const sqs = {
    SQSClient: Client,
    SendMessageCommand: cmd("sqs", "send-message"),
    ReceiveMessageCommand: cmd("sqs", "receive-message"),
    DeleteMessageCommand: cmd("sqs", "delete-message"),
    GetQueueUrlCommand: cmd("sqs", "get-queue-url"),
  };
  const sns = { SNSClient: Client, PublishCommand: cmd("sns", "publish") };
  const crypto = {
    randomUUID: () => uuid(state),
    createHash: () => {
      let data = "";
      const h = {
        update: (d: string) => ((data += d), h),
        digest: () => md5(data),
      };
      return h;
    },
  };
  return {
    "@aws-sdk/client-dynamodb": ddb,
    "@aws-sdk/lib-dynamodb": libDdb,
    "@aws-sdk/client-s3": s3,
    "@aws-sdk/client-sqs": sqs,
    "@aws-sdk/client-sns": sns,
    crypto,
    util: { inspect: (x: unknown) => JSON.stringify(x, null, 2) },
  };
}

// Set by dynamodb.ts at startup to avoid a circular import.
export const DDB_CONVERT: {
  marshallItem: (o: Record<string, unknown>) => Record<string, Record<string, unknown>>;
  unmarshallItem: (i: Record<string, Record<string, unknown>>) => Record<string, unknown>;
} = { marshallItem: (o) => o as never, unmarshallItem: (i) => i as never };

/* ------------------------------------------------------------------ */
/* SQS triggers                                                        */
/* ------------------------------------------------------------------ */

let pumping = false;
/** Deliver waiting SQS messages to functions with an event source mapping. Returns true if anything happened. */
export async function pump(state: AwsState, rt: Runtime): Promise<boolean> {
  if (pumping) return false;
  pumping = true;
  let changed = false;
  try {
    for (const m of state.lambda.mappings) {
      if (!m.enabled) continue;
      const f = Object.values(state.lambda.functions).find((x) => x.arn === m.functionArn);
      const q = queueByArn(state, m.sourceArn);
      if (!f || !q || now(state) < f.activeAt) continue;
      for (let round = 0; round < 5; round++) {
        if (!counts(state, q).visible) break;
        const batch = receive(state, q, m.batchSize);
        if (!batch.length) break;
        changed = true;
        const event = {
          Records: batch.map((msg) => ({
            messageId: msg.id,
            receiptHandle: msg.receiptHandle,
            body: msg.body,
            attributes: { ApproximateReceiveCount: String(msg.receiveCount), SentTimestamp: String(msg.sentAt), SenderId: "AIDAEXAMPLE", ApproximateFirstReceiveTimestamp: String(now(state)) },
            messageAttributes: {},
            md5OfBody: msg.md5,
            eventSource: "aws:sqs",
            eventSourceARN: q.arn,
            awsRegion: REGION,
          })),
        };
        const r = await rt.invokeLambda(state, f.arn, event, "sqs");
        if (r.ok) {
          const handles = new Set(batch.map((b) => b.receiptHandle));
          q.messages = q.messages.filter((x) => !handles.has(x.receiptHandle));
        }
        // On failure the batch stays hidden until its visibility timeout ends, then is retried.
      }
    }
  } finally {
    pumping = false;
  }
  return changed;
}

/* ------------------------------------------------------------------ */
/* `aws lambda`                                                        */
/* ------------------------------------------------------------------ */

function decodePayload(c: Call): unknown {
  const raw = c.str("payload");
  if (raw === undefined) return {};
  const fmt = c.flags["cli-binary-format"];
  const rawIn = Array.isArray(fmt) && fmt[0] === "raw-in-base64-out";
  let text = raw;
  if (!rawIn) {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) {
      throw new UsageError(`Invalid base64: "${raw}"\n\nThe CLI expects --payload in base64. Add --cli-binary-format raw-in-base64-out to send plain JSON.`);
    }
    try {
      text = atob(raw.replace(/\s/g, ""));
    } catch {
      throw new UsageError(`Invalid base64: "${raw}"`);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw c.error("InvalidRequestContentException", "Could not parse request body into json: Could not parse payload into json: Unexpected character");
  }
}

export function lambdaService(rt: Runtime & { invokeFull: (s: AwsState, a: string, e: unknown, src: string) => Promise<InvokeResult> }): Service {
  return {
    blurb: "Lambda: run code without managing servers, triggered by events",
    commands: {
      "create-function": (c) => {
        const name = c.str("function-name", true);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw c.error("ValidationException", "1 validation error detected: Value at 'functionName' failed to satisfy constraint");
        c.authorize("lambda:CreateFunction", arn.lambda(name));
        if (c.state.lambda.functions[name]) throw c.error("ResourceConflictException", `Function already exist: ${name}`);
        const runtime = c.str("runtime", true);
        if (!RUNTIMES.includes(runtime)) {
          throw c.error(
            "InvalidParameterValueException",
            runtime.startsWith("python") || runtime.startsWith("java")
              ? `The runtime parameter of ${runtime} is valid on AWS, but this lab only runs Node.js. Use nodejs20.x.`
              : `The runtime parameter of ${runtime} is no longer supported for creating or updating AWS Lambda functions. We recommend you use a supported runtime: nodejs20.x, nodejs22.x`,
          );
        }
        const role = c.str("role", true);
        checkRole(c, role);
        const handler = c.str("handler", true);
        const code = codeFrom(c, true)!;
        const t = now(c.state);
        const f: LambdaFunction = {
          name,
          arn: arn.lambda(name),
          runtime,
          handler,
          role,
          code,
          codeSize: byteLength(JSON.stringify(code)),
          timeout: c.int("timeout", 3)!,
          memory: c.int("memory-size", 128)!,
          env: envFrom(c) ?? {},
          createdAt: t,
          activeAt: t + 1500,
          lastModified: t,
          permissions: [],
        };
        c.state.lambda.functions[name] = f;
        return config(c.state, f);
      },
      "get-function": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:GetFunction");
        return { Configuration: config(c.state, f), Code: { RepositoryType: "S3", Location: `https://awslambda-${REGION}-tasks.s3.${REGION}.amazonaws.com/snapshots/${ACCOUNT_ID}/${f.name}-${md5(f.arn).slice(0, 12)}` } };
      },
      "get-function-configuration": (c) => config(c.state, needFunction(c, c.str("function-name", true), "lambda:GetFunctionConfiguration")),
      "list-functions": (c) => {
        c.authorize("lambda:ListFunctions", "*");
        return { Functions: Object.values(c.state.lambda.functions).map((f) => config(c.state, f)) };
      },
      "delete-function": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:DeleteFunction");
        delete c.state.lambda.functions[f.name];
        c.state.lambda.mappings = c.state.lambda.mappings.filter((m) => m.functionArn !== f.arn);
      },
      "update-function-code": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:UpdateFunctionCode");
        f.code = codeFrom(c, true)!;
        f.codeSize = byteLength(JSON.stringify(f.code));
        f.lastModified = now(c.state);
        return { ...config(c.state, f), LastUpdateStatus: "InProgress", LastUpdateStatusReason: "The function is being created.", LastUpdateStatusReasonCode: "Creating" };
      },
      "update-function-configuration": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:UpdateFunctionConfiguration");
        const env = envFrom(c);
        if (env) f.env = env;
        const role = c.str("role");
        if (role) {
          checkRole(c, role);
          f.role = role;
        }
        f.handler = c.str("handler") ?? f.handler;
        f.timeout = c.int("timeout", f.timeout)!;
        f.memory = c.int("memory-size", f.memory)!;
        f.lastModified = now(c.state);
        return config(c.state, f);
      },
      wait: (c) => {
        const name = c.str("function-name", true);
        const f = needFunction(c, name, "lambda:GetFunction");
        const wait = f.activeAt - now(c.state);
        if (wait > 0) c.state.clockOffset += wait;
        return undefined;
      },
      invoke: async (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:InvokeFunction");
        const out = c.positionals[0];
        if (!out) throw new UsageError("the following arguments are required: outfile");
        const event = decodePayload(c);
        if (now(c.state) < f.activeAt) {
          throw c.error("ResourceConflictException", "The operation cannot be performed at this time. The function is currently in the following state: Pending");
        }
        const type = c.str("invocation-type") ?? "RequestResponse";
        if (type === "DryRun") return { StatusCode: 204 };
        if (type === "Event") {
          await rt.invokeFull(c.state, f.arn, event, "cli-async");
          c.io.writeFile(out, "");
          return { StatusCode: 202 };
        }
        const r = await rt.invokeFull(c.state, f.arn, event, "cli");
        c.io.writeFile(out, JSON.stringify(r.ok ? r.result : r.error));
        const tail = c.str("log-type") === "Tail" ? { LogResult: btoa(unescape(encodeURIComponent(r.logs.join("\n").slice(-4096)))) } : {};
        return { StatusCode: 200, ...(r.ok ? {} : { FunctionError: "Unhandled" }), ...tail, ExecutedVersion: "$LATEST" };
      },
      "add-permission": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:AddPermission");
        const sid = c.str("statement-id", true);
        if (f.permissions.some((p) => p.sid === sid)) throw c.error("ResourceConflictException", `The statement id (${sid}) provided already exists. Please provide a new statement id, or remove the existing statement.`);
        const p = { sid, principal: c.str("principal", true), action: c.str("action", true), sourceArn: c.str("source-arn") };
        f.permissions.push(p);
        const st = {
          Sid: sid,
          Effect: "Allow",
          Principal: { Service: p.principal },
          Action: p.action,
          Resource: f.arn,
          ...(p.sourceArn ? { Condition: { ArnLike: { "AWS:SourceArn": p.sourceArn } } } : {}),
        };
        return { Statement: JSON.stringify(st) };
      },
      "remove-permission": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:RemovePermission");
        const sid = c.str("statement-id", true);
        if (!f.permissions.some((p) => p.sid === sid)) throw c.error("ResourceNotFoundException", `Statement ${sid} is not found in resource policy.`);
        f.permissions = f.permissions.filter((p) => p.sid !== sid);
      },
      "get-policy": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:GetPolicy");
        if (!f.permissions.length) throw c.error("ResourceNotFoundException", "The resource you requested does not exist.");
        return {
          Policy: JSON.stringify({
            Version: "2012-10-17",
            Id: "default",
            Statement: f.permissions.map((p) => ({ Sid: p.sid, Effect: "Allow", Principal: { Service: p.principal }, Action: p.action, Resource: f.arn, ...(p.sourceArn ? { Condition: { ArnLike: { "AWS:SourceArn": p.sourceArn } } } : {}) })),
          }),
          RevisionId: md5(f.arn).slice(0, 36),
        };
      },
      "create-event-source-mapping": (c) => {
        const f = needFunction(c, c.str("function-name", true), "lambda:CreateEventSourceMapping");
        const src = c.str("event-source-arn", true);
        const q = queueByArn(c.state, src);
        if (!q) throw c.error("InvalidParameterValueException", "Error occurred while ReceiveMessage. SQS Error Code: AWS.SimpleQueueService.NonExistentQueue. SQS Error Message: The specified queue does not exist.");
        const role = principalForRole(f.role, f.name);
        for (const action of ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]) {
          if (decide(c.state, role, action, q.arn) !== "allow") {
            throw c.error("InvalidParameterValueException", `The provided execution role does not have permissions to call ${action.split(":")[1]} on SQS`);
          }
        }
        const batch = c.int("batch-size", 10)!;
        const visibility = Number(q.attributes.VisibilityTimeout ?? "30");
        if (visibility < f.timeout) {
          throw c.error("InvalidParameterValueException", `Queue visibility timeout: ${visibility} seconds is less than Function timeout: ${f.timeout} seconds`);
        }
        const m = { uuid: uuid(c.state), functionArn: f.arn, sourceArn: q.arn, batchSize: batch, enabled: true, createdAt: now(c.state) };
        c.state.lambda.mappings.push(m);
        return { UUID: m.uuid, BatchSize: batch, MaximumBatchingWindowInSeconds: 0, EventSourceArn: q.arn, FunctionArn: f.arn, LastModified: iso(m.createdAt), State: "Creating", StateTransitionReason: "USER_INITIATED", FunctionResponseTypes: [], EventSourceMappingArn: `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:event-source-mapping:${m.uuid}` };
      },
      "list-event-source-mappings": (c) => {
        const fn = c.str("function-name");
        const f = fn ? needFunction(c, fn, "lambda:ListEventSourceMappings") : null;
        return {
          EventSourceMappings: c.state.lambda.mappings
            .filter((m) => !f || m.functionArn === f.arn)
            .map((m) => ({ UUID: m.uuid, BatchSize: m.batchSize, EventSourceArn: m.sourceArn, FunctionArn: m.functionArn, LastModified: iso(m.createdAt), State: m.enabled ? "Enabled" : "Disabled", StateTransitionReason: "USER_INITIATED" })),
        };
      },
      "delete-event-source-mapping": (c) => {
        const id = c.str("uuid", true);
        const m = c.state.lambda.mappings.find((x) => x.uuid === id);
        if (!m) throw c.error("ResourceNotFoundException", "The resource you requested does not exist.");
        c.state.lambda.mappings = c.state.lambda.mappings.filter((x) => x !== m);
        return { UUID: m.uuid, State: "Deleting", EventSourceArn: m.sourceArn, FunctionArn: m.functionArn };
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* CloudWatch Logs                                                     */
/* ------------------------------------------------------------------ */

function parseSince(s: string | undefined, nowT: number): number {
  if (!s) return nowT - 10 * 60000;
  const m = s.match(/^(\d+)([smhdw])$/);
  if (!m) return nowT - 10 * 60000;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[m[2] as "s"];
  return nowT - Number(m[1]) * mult;
}

export const logsService: Service = {
  blurb: "CloudWatch Logs: where functions and services write what happened",
  commands: {
    "describe-log-groups": (c) => {
      c.authorize("logs:DescribeLogGroups", "*");
      const prefix = c.str("log-group-name-prefix") ?? "";
      return {
        logGroups: Object.values(c.state.logs.groups)
          .filter((g) => g.name.startsWith(prefix))
          .map((g) => ({ logGroupName: g.name, creationTime: g.createdAt, metricFilterCount: 0, arn: `${arn.logGroup(g.name)}:*`, storedBytes: 0, logGroupClass: "STANDARD", logGroupArn: arn.logGroup(g.name) })),
      };
    },
    "create-log-group": (c) => {
      const name = c.str("log-group-name", true);
      c.authorize("logs:CreateLogGroup", arn.logGroup(name));
      if (c.state.logs.groups[name]) throw c.error("ResourceAlreadyExistsException", "The specified log group already exists");
      c.state.logs.groups[name] = { name, createdAt: now(c.state), streams: {} };
    },
    "delete-log-group": (c) => {
      const name = c.str("log-group-name", true);
      c.authorize("logs:DeleteLogGroup", arn.logGroup(name));
      if (!c.state.logs.groups[name]) throw c.error("ResourceNotFoundException", "The specified log group does not exist.");
      delete c.state.logs.groups[name];
    },
    "describe-log-streams": (c) => {
      const name = c.str("log-group-name", true);
      c.authorize("logs:DescribeLogStreams", arn.logGroup(name));
      const g = c.state.logs.groups[name];
      if (!g) throw c.error("ResourceNotFoundException", "The specified log group does not exist.");
      let streams = Object.entries(g.streams).map(([s, ev]) => ({
        logStreamName: s,
        creationTime: ev[0]?.t ?? g.createdAt,
        firstEventTimestamp: ev[0]?.t,
        lastEventTimestamp: ev[ev.length - 1]?.t,
        lastIngestionTime: ev[ev.length - 1]?.t,
        uploadSequenceToken: "1",
        arn: `${arn.logGroup(name)}:log-stream:${s}`,
        storedBytes: 0,
      }));
      if (c.str("order-by") === "LastEventTime") streams.sort((a, b) => (a.lastEventTimestamp ?? 0) - (b.lastEventTimestamp ?? 0));
      if (c.bool("descending")) streams = streams.reverse();
      const max = c.int("max-items") ?? c.int("limit");
      return { logStreams: max ? streams.slice(0, max) : streams };
    },
    "get-log-events": (c) => {
      const name = c.str("log-group-name", true);
      c.authorize("logs:GetLogEvents", arn.logGroup(name));
      const g = c.state.logs.groups[name];
      if (!g) throw c.error("ResourceNotFoundException", "The specified log group does not exist.");
      const s = g.streams[c.str("log-stream-name", true)];
      if (!s) throw c.error("ResourceNotFoundException", "The specified log stream does not exist.");
      const limit = c.int("limit");
      const ev = limit ? s.slice(-limit) : s;
      return { events: ev.map((e) => ({ timestamp: e.t, message: e.message, ingestionTime: e.t + 40 })), nextForwardToken: `f/${md5(String(s.length))}`, nextBackwardToken: "b/0" };
    },
    "filter-log-events": (c) => {
      const name = c.str("log-group-name", true);
      c.authorize("logs:FilterLogEvents", arn.logGroup(name));
      const g = c.state.logs.groups[name];
      if (!g) throw c.error("ResourceNotFoundException", "The specified log group does not exist.");
      const pattern = (c.str("filter-pattern") ?? "").replace(/^"|"$/g, "");
      const events = Object.entries(g.streams)
        .flatMap(([s, ev]) => ev.map((e) => ({ logStreamName: s, timestamp: e.t, message: e.message, ingestionTime: e.t + 40, eventId: md5(s + e.t + e.message) })))
        .filter((e) => !pattern || pattern.split(/\s+/).every((w) => e.message.includes(w)))
        .sort((a, b) => a.timestamp - b.timestamp);
      return { events, searchedLogStreams: [] };
    },
    tail: (c) => {
      const name = c.positionals[0];
      if (!name) throw new UsageError("the following arguments are required: group_name");
      c.authorize("logs:FilterLogEvents", arn.logGroup(name));
      const g = c.state.logs.groups[name];
      if (!g) throw c.error("ResourceNotFoundException", "The specified log group does not exist.");
      const since = parseSince(c.str("since"), now(c.state));
      const short = c.str("format") === "short";
      const lines = Object.entries(g.streams)
        .flatMap(([s, ev]) => ev.map((e) => ({ s, ...e })))
        .filter((e) => e.t >= since)
        .sort((a, b) => a.t - b.t)
        .map((e) => {
          const ts = new Date(e.t).toISOString().replace("Z", "000+00:00");
          return short ? `${ts.slice(0, 19)} ${e.message}` : `${ts} ${e.s} ${e.message}`;
        });
      const note = c.bool("follow") ? "\n(--follow keeps watching on a real terminal; in this lab, run the command again to see new lines)" : "";
      return { __text: (lines.length ? lines.join("\n") : "") + note + (lines.length || note ? "\n" : "") };
    },
  },
};

/* ------------------------------------------------------------------ */
/* API Gateway (HTTP APIs)                                             */
/* ------------------------------------------------------------------ */

function needApi(c: Call) {
  const id = c.str("api-id", true);
  const a = c.state.apigw.apis[id];
  if (!a) throw c.error("NotFoundException", `Invalid API identifier specified ${ACCOUNT_ID}:${id}`);
  return a;
}

function apiView(a: AwsState["apigw"]["apis"][string]) {
  return {
    ApiEndpoint: a.endpoint,
    ApiId: a.id,
    ApiKeySelectionExpression: "$request.header.x-api-key",
    CreatedDate: iso(a.createdAt).replace("+00:00", "Z"),
    DisableExecuteApiEndpoint: false,
    Name: a.name,
    ProtocolType: "HTTP",
    RouteSelectionExpression: "$request.method $request.path",
  };
}

export const apigwService: Service = {
  blurb: "API Gateway (HTTP APIs): give your functions a public URL",
  commands: {
    "create-api": (c) => {
      const name = c.str("name", true);
      c.authorize("apigateway:POST", `arn:aws:apigateway:${REGION}::/apis`);
      const proto = c.str("protocol-type", true);
      if (proto !== "HTTP") throw c.error("BadRequestException", proto === "WEBSOCKET" ? "This lab supports HTTP APIs only." : `Invalid protocol type: ${proto}`);
      const id = md5(name + now(c.state) + c.state.seq++).slice(0, 10);
      const api = { id, name, endpoint: `https://${id}.execute-api.${REGION}.amazonaws.com`, createdAt: now(c.state), routes: {} as Record<string, string>, integrations: {} as Record<string, string> };
      const target = c.str("target");
      if (target) {
        const intId = md5(id + "default").slice(0, 7);
        api.integrations[intId] = target;
        api.routes["$default"] = intId;
      }
      c.state.apigw.apis[id] = api;
      return apiView(api);
    },
    "get-apis": (c) => ({ Items: Object.values(c.state.apigw.apis).map(apiView) }),
    "get-api": (c) => apiView(needApi(c)),
    "delete-api": (c) => {
      const a = needApi(c);
      delete c.state.apigw.apis[a.id];
    },
    "create-integration": (c) => {
      const a = needApi(c);
      const type = c.str("integration-type", true);
      if (type !== "AWS_PROXY") throw c.error("BadRequestException", "This lab supports AWS_PROXY integrations with Lambda.");
      const uri = c.str("integration-uri", true);
      const id = md5(a.id + uri + c.state.seq++).slice(0, 7);
      a.integrations[id] = uri;
      return { ConnectionType: "INTERNET", IntegrationId: id, IntegrationMethod: "POST", IntegrationType: "AWS_PROXY", IntegrationUri: uri, PayloadFormatVersion: c.str("payload-format-version") ?? "2.0", TimeoutInMillis: 30000 };
    },
    "get-integrations": (c) => {
      const a = needApi(c);
      return { Items: Object.entries(a.integrations).map(([id, uri]) => ({ IntegrationId: id, IntegrationType: "AWS_PROXY", IntegrationUri: uri, PayloadFormatVersion: "2.0" })) };
    },
    "create-route": (c) => {
      const a = needApi(c);
      const key = c.str("route-key", true);
      if (key !== "$default" && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY) \/\S*$/.test(key)) throw c.error("BadRequestException", `Invalid route key: ${key}. Use e.g. "GET /items" or "$default".`);
      if (a.routes[key]) throw c.error("ConflictException", `Route with key ${key} already exists for this API`);
      const target = c.str("target") ?? "";
      const m = target.match(/^integrations\/(\w+)$/);
      if (target && (!m || !a.integrations[m[1]])) throw c.error("BadRequestException", "Invalid target: use integrations/<IntegrationId>");
      a.routes[key] = m ? m[1] : "";
      return { ApiKeyRequired: false, AuthorizationType: "NONE", RouteId: md5(a.id + key).slice(0, 7), RouteKey: key, ...(target ? { Target: target } : {}) };
    },
    "get-routes": (c) => {
      const a = needApi(c);
      return { Items: Object.entries(a.routes).map(([k, t]) => ({ RouteKey: k, RouteId: md5(a.id + k).slice(0, 7), Target: t ? `integrations/${t}` : undefined, AuthorizationType: "NONE" })) };
    },
  },
};

/** Handle an HTTP request to an API Gateway endpoint (used by `curl`). */
export async function httpToApi(state: AwsState, rt: Runtime, method: string, url: URL, headers: Record<string, string>, body: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const id = url.hostname.split(".")[0];
  const api = state.apigw.apis[id];
  const json = (status: number, message: string) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
  if (!api) return json(404, "Not Found");
  const path = url.pathname || "/";
  const routeKey =
    Object.keys(api.routes).find((k) => k === `${method} ${path}` || k === `ANY ${path}`) ??
    Object.keys(api.routes).find((k) => {
      const [m, p] = k.split(" ");
      if (!p || (m !== method && m !== "ANY")) return false;
      if (p.endsWith("/{proxy+}")) return path.startsWith(p.replace("/{proxy+}", ""));
      const re = new RegExp("^" + p.replace(/\{[^/]+\}/g, "[^/]+") + "$");
      return re.test(path);
    }) ??
    (api.routes["$default"] !== undefined ? "$default" : undefined);
  if (!routeKey) return json(404, "Not Found");
  const fnArn = api.integrations[api.routes[routeKey]];
  if (!fnArn) return json(500, "Internal Server Error");
  const fname = fnArn.split(":").pop() ?? "";
  const f = state.lambda.functions[fname];
  if (!f) return json(500, "Internal Server Error");
  // API Gateway may only call the function if the function's resource policy allows it.
  const allowed = f.permissions.some(
    (p) => p.principal === "apigateway.amazonaws.com" && /lambda:(InvokeFunction|\*)/i.test(p.action) && (!p.sourceArn || new RegExp("^" + p.sourceArn.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(`arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${api.id}/$default/${method}${path}`)),
  );
  if (!allowed) return json(500, "Internal Server Error");
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (params[k] = v));
  const t = now(state);
  const event = {
    version: "2.0",
    routeKey,
    rawPath: path,
    rawQueryString: url.search.replace(/^\?/, ""),
    headers: { ...headers, host: url.host },
    ...(Object.keys(params).length ? { queryStringParameters: params } : {}),
    requestContext: {
      accountId: ACCOUNT_ID,
      apiId: api.id,
      domainName: url.host,
      domainPrefix: api.id,
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "203.0.113.10", userAgent: headers["user-agent"] ?? "curl/8.5.0" },
      requestId: md5(String(t)).slice(0, 16) + "=",
      routeKey,
      stage: "$default",
      time: new Date(t).toUTCString(),
      timeEpoch: t,
    },
    ...(body ? { body } : {}),
    isBase64Encoded: false,
  };
  if (now(state) < f.activeAt) return json(503, "Service Unavailable");
  const r = await rt.invokeLambda(state, fnArn, event, "apigateway");
  if (!r.ok) return json(500, "Internal Server Error");
  const out = r.result as { statusCode?: number; body?: unknown; headers?: Record<string, string> } | string | null;
  if (out && typeof out === "object" && typeof out.statusCode === "number") {
    return { status: out.statusCode, headers: { "content-type": "application/json", ...(out.headers ?? {}) }, body: typeof out.body === "string" ? out.body : out.body === undefined ? "" : JSON.stringify(out.body) };
  }
  return { status: 200, headers: { "content-type": "application/json" }, body: typeof out === "string" ? out : JSON.stringify(out) };
}
