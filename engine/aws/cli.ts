import { ACCOUNT_ID, AwsError, REGION, UsageError, type AwsState } from "./state";
export { UsageError };
import { authorize, type Principal } from "./iam-eval";
import { jmes } from "./jmes";

/* ------------------------------------------------------------------ */
/* What a command handler gets                                         */
/* ------------------------------------------------------------------ */

export interface Io {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  /** Absolute path for display or storage. */
  resolve(path: string): string;
}

export interface Runtime {
  /** Runs a Lambda function; supplied by the Lambda service, used by others (SNS, API Gateway, SQS triggers). */
  invokeLambda(state: AwsState, functionArn: string, event: unknown, source: string): Promise<{ ok: boolean; result: unknown; error?: { errorMessage: string; errorType: string } }>;
}

/** Raw text output (the high-level `aws s3` commands print text, not JSON). */
export interface TextOut {
  __text: string;
  /** Printed to stderr with exit code 1 (the s3 commands report failures this way). */
  __err?: boolean;
}
export const text = (t: string, err = false): TextOut => ({ __text: t, ...(err ? { __err: true } : {}) });

export class Call {
  constructor(
    public state: AwsState,
    public principal: Principal,
    public service: string,
    public command: string,
    public flags: Record<string, string[] | true>,
    public positionals: string[],
    public io: Io,
    public rt: Runtime,
  ) {}

  /** The API operation name, e.g. create-bucket -> CreateBucket. */
  get operation(): string {
    return this.command
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");
  }

  has(name: string): boolean {
    return name in this.flags;
  }

  /** A single string flag. */
  str(name: string): string | undefined;
  str(name: string, required: true): string;
  str(name: string, required = false): string | undefined {
    const v = this.flags[name];
    if (v === undefined || v === true) {
      if (required) throw new UsageError(`the following arguments are required: --${name}`);
      return undefined;
    }
    if (v.length === 0) throw new UsageError(`argument --${name}: expected one argument`);
    return this.fileOr(v.join(" "));
  }

  int(name: string, fallback?: number): number | undefined {
    const v = this.str(name);
    if (v === undefined) return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new UsageError(`argument --${name}: invalid int value: '${v}'`);
    return n;
  }

  /** Every value given after a flag (space separated), e.g. --attribute-names A B. */
  list(name: string): string[] {
    const v = this.flags[name];
    if (v === undefined || v === true) return [];
    return v.map((x) => this.fileOr(x));
  }

  bool(name: string): boolean {
    return name in this.flags;
  }

  /** A structured flag: JSON, or the CLI's shorthand syntax (Key=Value,Other=Value). */
  structured(name: string, required: true): unknown;
  structured(name: string, required?: boolean): unknown;
  structured(name: string, required = false): unknown {
    const v = this.flags[name];
    if (v === undefined || v === true) {
      if (required) throw new UsageError(`the following arguments are required: --${name}`);
      return undefined;
    }
    const values = v.map((x) => this.fileOr(x));
    if (values.length === 1) return parseValue(values[0], name);
    return values.map((x) => parseValue(x, name));
  }

  /** A list of structures, each given as its own argument (--key-schema A=.. B=..), or one JSON array. */
  structuredList(name: string, required = false): Record<string, unknown>[] {
    const v = this.structured(name, required);
    if (v === undefined) return [];
    return (Array.isArray(v) ? v : [v]) as Record<string, unknown>[];
  }

  private fileOr(v: string): string {
    if (v.startsWith("file://")) {
      const p = v.slice(7);
      if (!this.io.exists(p)) throw new UsageError(`Error parsing parameter: Unable to load paramfile ${v}: [Errno 2] No such file or directory: '${p}'`);
      return this.io.readFile(p);
    }
    return v;
  }

  /** Raw file contents for fileb:// arguments (zips). */
  binaryFile(name: string, required = false): string | undefined {
    const v = this.flags[name];
    if (v === undefined || v === true) {
      if (required) throw new UsageError(`the following arguments are required: --${name}`);
      return undefined;
    }
    const s = v[0];
    if (!s.startsWith("fileb://")) {
      if (s.startsWith("file://")) throw new UsageError(`Error parsing parameter '--${name}': use fileb:// (with a b) for binary files like zips.`);
      throw new UsageError(`Error parsing parameter '--${name}': expected fileb://path/to/file`);
    }
    const p = s.slice(8);
    if (!this.io.exists(p)) throw new UsageError(`Error parsing parameter '--${name}': Unable to load paramfile ${s}: [Errno 2] No such file or directory: '${p}'`);
    return this.io.readFile(p);
  }

  /** Throw AccessDenied unless the caller's policies allow this. */
  authorize(action: string, resource: string): void {
    authorize(this.state, this.principal, action, resource, this.operation);
  }

  error(code: string, message: string): AwsError {
    return new AwsError(code, message, this.operation);
  }
}

export type Handler = (c: Call) => unknown | Promise<unknown>;

export interface Service {
  /** What it's for, in one line, for `aws help`. */
  blurb: string;
  commands: Record<string, Handler>;
  /** Extra notes for `aws <service> help`. */
  help?: string;
}

/* ------------------------------------------------------------------ */
/* Parsing values                                                      */
/* ------------------------------------------------------------------ */

function parseValue(v: string, name: string): unknown {
  const t = v.trim();
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch (e) {
      // `{...}` could also be shorthand, e.g. Variables={A=1}
      if (/^\{\s*"/.test(t) || t.startsWith("[{") || t.startsWith('"')) {
        throw new UsageError(`Error parsing parameter '--${name}': Invalid JSON: ${e instanceof Error ? e.message : String(e)}\nJSON received: ${t}`);
      }
    }
  }
  if (/^[A-Za-z0-9_.:#-]+=/.test(t) || t.startsWith("{")) return parseShorthand(t, name);
  return t;
}

/** The CLI's shorthand: Key=Value,Key2=Value2, nested {..} and lists [a,b]. */
export function parseShorthand(input: string, name = "value"): unknown {
  let i = 0;
  const s = input;
  const fail = (msg: string) => new UsageError(`Error parsing parameter '--${name}': ${msg}\nreceived: ${input}`);

  function value(stop: string): unknown {
    if (s[i] === "{") {
      i++;
      const obj = pairs("}");
      if (s[i] !== "}") throw fail("expected '}'");
      i++;
      return obj;
    }
    if (s[i] === "[") {
      i++;
      const out: unknown[] = [];
      while (i < s.length && s[i] !== "]") {
        out.push(value(",]"));
        if (s[i] === ",") i++;
      }
      if (s[i] !== "]") throw fail("expected ']'");
      i++;
      return out;
    }
    let out = "";
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      while (i < s.length && s[i] !== q) out += s[i++];
      i++;
      return out;
    }
    while (i < s.length && !stop.includes(s[i])) out += s[i++];
    return out;
  }

  function pairs(end: string): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (i < s.length && s[i] !== end) {
      let key = "";
      while (i < s.length && s[i] !== "=" && s[i] !== ",") key += s[i++];
      if (s[i] !== "=") throw fail(`expected '=' after '${key}'`);
      i++;
      obj[key.trim()] = value("," + end);
      if (s[i] === ",") i++;
    }
    return obj;
  }

  if (s.startsWith("{")) {
    i = 1;
    const o = pairs("}");
    return o;
  }
  return pairs("");
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

function toText(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== "object")) return v.map(toText).join("\t");
    return v.map(toText).join("\n");
  }
  const vals = Object.values(v as Record<string, unknown>);
  if (vals.every((x) => x === null || typeof x !== "object")) return vals.map(toText).join("\t");
  return vals.map(toText).join("\n");
}

export function render(result: unknown, query: string | undefined, output: string): string {
  if (result === undefined) return "";
  if (result && typeof result === "object" && "__text" in (result as TextOut)) return (result as TextOut).__text;
  let v: unknown = result;
  if (query) v = jmes(v, query);
  if (output === "text") return toText(v) + "\n";
  if (output === "yaml") return toYaml(v) + "\n";
  return JSON.stringify(v, null, 4) + "\n";
}

function toYaml(v: unknown, indent = ""): string {
  if (v === null || v === undefined) return "null";
  if (typeof v !== "object") return typeof v === "string" && /[:#\n]/.test(v) ? JSON.stringify(v) : String(v);
  if (Array.isArray(v)) return v.map((x) => `\n${indent}- ${toYaml(x, indent + "  ").trimStart()}`).join("");
  return Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => {
      const inner = toYaml(x, indent + "  ");
      return `\n${indent}${k}:${inner.startsWith("\n") ? inner : " " + inner}`;
    })
    .join("")
    .replace(/^\n/, "");
}

/* ------------------------------------------------------------------ */
/* Running `aws ...`                                                   */
/* ------------------------------------------------------------------ */

const GLOBAL_WITH_VALUE = new Set(["region", "profile", "output", "query", "endpoint-url", "cli-binary-format", "color", "cli-read-timeout", "cli-connect-timeout"]);
/** Flags that take several space-separated values; every other flag takes one. */
const MULTI = new Set(["attribute-definitions", "key-schema", "attribute-names", "message-attribute-names", "tags", "entries", "global-secondary-indexes", "statement-ids", "policy-names", "action-names", "resource-arns", "message-system-attribute-names"]);
const GLOBAL_BOOL = new Set(["no-cli-pager", "debug", "no-verify-ssl", "no-paginate", "no-sign-request", "cli-auto-prompt", "no-cli-auto-prompt"]);

export interface AwsResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runAws(
  args: string[],
  state: AwsState,
  services: Record<string, Service>,
  io: Io,
  rt: Runtime,
  principalFor: (state: AwsState, profile: string) => Principal,
): Promise<AwsResult> {
  const usage = (msg: string): AwsResult => ({
    stdout: "",
    stderr: `\nusage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\nTo see help text, you can run:\n\n  aws help\n  aws <command> help\n  aws <command> <subcommand> help\n\naws: error: ${msg}\n`,
    code: 252,
  });

  // Split off global options wherever they appear.
  const flags: Record<string, string[] | true> = {};
  const words: string[] = [];
  let current: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && a.length > 2) {
      let name = a.slice(2);
      let inline: string | null = null;
      const eq = name.indexOf("=");
      if (eq > 0) {
        inline = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (GLOBAL_BOOL.has(name)) {
        flags[name] = true;
        current = null;
        continue;
      }
      flags[name] = inline !== null ? [inline] : [];
      current = inline !== null ? null : name;
      continue;
    }
    if (current) {
      (flags[current] as string[]).push(a);
      if (!MULTI.has(current)) current = null;
      continue;
    }
    words.push(a);
  }
  // Flags with no values are booleans.
  for (const [k, v] of Object.entries(flags)) if (Array.isArray(v) && v.length === 0) flags[k] = true;

  const [service, command, ...positionals] = words;
  if (!service || service === "help") return { stdout: topHelp(services), stderr: "", code: 0 };
  if (service === "--version" || flags["version"]) return { stdout: "aws-cli/2.17.0 Python/3.12.6 Browser/lab exe/x86_64 (SysLabLearns emulator)\n", stderr: "", code: 0 };
  if (service === "configure") return configure(command, positionals, state, flags);

  const svc = services[service];
  if (!svc) {
    return usage(`argument command: Invalid choice, valid choices are:\n\n${Object.keys(services).sort().join(" | ")} | configure\n\nThis lab emulates the services above. The real CLI has many more.`);
  }
  if (!command || command === "help") return { stdout: serviceHelp(service, svc), stderr: "", code: 0 };
  if (positionals[0] === "help") return { stdout: `${service} ${command}\n\nSee the lesson for examples of this command, or run: aws ${service} help\n`, stderr: "", code: 0 };
  const handler = svc.commands[command];
  if (!handler) {
    return usage(`argument operation: Invalid choice, valid choices are:\n\n${Object.keys(svc.commands).sort().join(" | ")}`);
  }

  const output = flags["output"] === true ? "json" : (flags["output"]?.[0] ?? state.env.AWS_DEFAULT_OUTPUT ?? "json");
  const query = flags["query"] === true ? undefined : flags["query"]?.[0];
  const region = flags["region"] === true ? undefined : flags["region"]?.[0];
  if (region && region !== REGION) {
    return {
      stdout: "",
      stderr: `\nThis lab account only has ${REGION} (Mumbai). Real AWS has many regions, and each one has its own separate resources.\n`,
      code: 255,
    };
  }
  const profile = flags["profile"] === true ? "default" : (flags["profile"]?.[0] ?? state.env.AWS_PROFILE ?? "default");
  if (!state.profiles[profile]) {
    return { stdout: "", stderr: `\nThe config profile (${profile}) could not be found\n`, code: 255 };
  }
  if (state.profiles[profile].user === "__invalid__" || !state.iam.users[state.profiles[profile].user]) {
    const op = (words[1] ?? "").split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : "")).join("");
    return { stdout: "", stderr: `\nAn error occurred (InvalidClientTokenId) when calling the ${op} operation: The security token included in the request is invalid.\n`, code: 254 };
  }
  for (const g of [...GLOBAL_WITH_VALUE, ...GLOBAL_BOOL]) if (g !== "cli-binary-format") delete flags[g];

  const call = new Call(state, principalFor(state, profile), service, command, flags, positionals, io, rt);
  try {
    const result = await handler(call);
    if (result && typeof result === "object" && (result as TextOut).__err) return { stdout: "", stderr: (result as TextOut).__text, code: 1 };
    return { stdout: render(result, query, output), stderr: "", code: 0 };
  } catch (e) {
    if (e instanceof AwsError) {
      return { stdout: "", stderr: `\nAn error occurred (${e.code}) when calling the ${e.operation || call.operation} operation: ${e.message}\n`, code: 254 };
    }
    if (e instanceof UsageError) {
      if (e.message.startsWith("Error parsing") || e.message.startsWith("Parameter validation") || e.message.startsWith("Invalid base64") || e.message.startsWith("\n")) return { stdout: "", stderr: `\n${e.message}\n`, code: 252 };
      return usage(e.message);
    }
    throw e;
  }
}

function configure(command: string | undefined, rest: string[], state: AwsState, flags: Record<string, string[] | true>): AwsResult {
  const profile = flags["profile"] === true ? "default" : (flags["profile"]?.[0] ?? "default");
  if (command === "list-profiles") return { stdout: Object.keys(state.profiles).join("\n") + "\n", stderr: "", code: 0 };
  if (command === "list" || !command) {
    const p = state.profiles[profile];
    const lines = [
      "      Name                    Value             Type    Location",
      "      ----                    -----             ----    --------",
      `   profile                ${profile.padEnd(16)}  manual    --profile`,
      `access_key     ****************${p ? "LAB1" : "    "} shared-credentials-file`,
      `secret_key     ****************${p ? "LAB2" : "    "} shared-credentials-file`,
      `    region                ${REGION}      config-file    ~/.aws/config`,
    ];
    return { stdout: lines.join("\n") + "\n", stderr: "", code: 0 };
  }
  if (command === "set") {
    const [key, value] = rest;
    if (key === "aws_access_key_id" && value) {
      const owner = Object.values(state.iam.users).find((u) => u.keys?.includes(value));
      // The real CLI saves whatever you type; a wrong key only fails on the next call.
      state.profiles[profile] = { user: owner ? owner.name : "__invalid__" };
      return { stdout: "", stderr: "", code: 0 };
    }
    if (key === "output" && value) {
      state.env.AWS_DEFAULT_OUTPUT = value;
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  }
  if (command === "get") {
    const key = rest[0];
    if (key === "region") return { stdout: REGION + "\n", stderr: "", code: 0 };
    if (key === "output") return { stdout: (state.env.AWS_DEFAULT_OUTPUT ?? "json") + "\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 1 };
  }
  return {
    stdout:
      "In this lab you're already signed in: the account is ready to use.\n" +
      "On a real machine, `aws configure` asks for an access key, a secret key and a default region,\n" +
      "and saves them in ~/.aws/credentials and ~/.aws/config.\n",
    stderr: "",
    code: 0,
  };
}

function topHelp(services: Record<string, Service>): string {
  const rows = Object.entries(services)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => `  ${name.padEnd(14)} ${s.blurb}`);
  return [
    "AWS CLI (lab emulator)",
    "",
    "Usage: aws <service> <command> [--option value ...]",
    "",
    "Services in this lab:",
    ...rows,
    "",
    "Global options: --output json|text|yaml, --query <expression>, --profile <name>",
    "Try: aws s3 help",
    "",
  ].join("\n");
}

function serviceHelp(name: string, s: Service): string {
  return [`aws ${name}: ${s.blurb}`, "", "Commands:", ...Object.keys(s.commands).sort().map((c) => `  ${c}`), "", s.help ?? "", ""].join("\n");
}

export const arn = {
  sqs: (q: string) => `arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${q}`,
  sns: (t: string) => `arn:aws:sns:${REGION}:${ACCOUNT_ID}:${t}`,
  ddb: (t: string) => `arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${t}`,
  lambda: (f: string) => `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${f}`,
  s3Bucket: (b: string) => `arn:aws:s3:::${b}`,
  s3Object: (b: string, k: string) => `arn:aws:s3:::${b}/${k}`,
  logGroup: (g: string) => `arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${g}`,
};
