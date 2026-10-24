import { Call, UsageError, type Io, type Runtime, type Service } from "./cli";
import { decide, principalForRole, trusts, type Principal } from "./iam-eval";
import { ACCOUNT_ID, AwsError, iso, now, REGION, uuid, type AwsState, type SfnExecution, type SfnHistoryEvent, type SfnMachine } from "./state";

/*
 * Step Functions: a state machine written in Amazon States Language runs one
 * step at a time, calling Lambda (and a few services directly) as its role.
 * Retries, catches and choices behave like the real service; Wait states
 * move the execution's clock, so it reports RUNNING until that time passes.
 */

const machineArn = (name: string) => `arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:${name}`;
const MAX_TRANSITIONS = 500;

type Json = unknown;
type State = Record<string, unknown> & { Type: string; Next?: string; End?: boolean };
interface Definition {
  StartAt: string;
  States: Record<string, State>;
}

class StatesError extends Error {
  constructor(
    public error: string,
    public cause: string,
  ) {
    super(error);
  }
}

/* ---------------- validating a definition ---------------- */

const TYPES = new Set(["Task", "Pass", "Choice", "Wait", "Succeed", "Fail", "Map", "Parallel"]);

export function validateDefinition(src: string): Definition {
  let d: Definition;
  try {
    d = JSON.parse(src);
  } catch (e) {
    throw new Error(`INVALID_JSON_DESCRIPTION: ${(e as Error).message}`);
  }
  const check = (def: Definition, at: string) => {
    if (!def || typeof def !== "object" || !def.States || typeof def.States !== "object") throw new Error(`SCHEMA_VALIDATION_FAILED: The field "States" is required at ${at || "/"}`);
    if (!def.StartAt) throw new Error(`SCHEMA_VALIDATION_FAILED: The field "StartAt" is required at ${at || "/"}`);
    if (!def.States[def.StartAt]) throw new Error(`MISSING_TRANSITION_TARGET: Missing 'Next' target: ${def.StartAt} at ${at}/StartAt`);
    for (const [name, st] of Object.entries(def.States)) {
      const here = `${at}/States/${name}`;
      if (!TYPES.has(st.Type)) throw new Error(`SCHEMA_VALIDATION_FAILED: ${st.Type === undefined ? 'The field "Type" is required' : `"${st.Type}" is not a valid state type`} at ${here}`);
      if (st.Type === "Parallel") throw new Error(`UNSUPPORTED: Parallel states aren't in this lab yet at ${here}`);
      const terminal = st.Type === "Succeed" || st.Type === "Fail" || st.Type === "Choice";
      if (!terminal && !st.Next && !st.End) throw new Error(`SCHEMA_VALIDATION_FAILED: The field "Next" or "End" is required at ${here}`);
      if (st.Next && !def.States[st.Next]) throw new Error(`MISSING_TRANSITION_TARGET: Missing 'Next' target: ${st.Next} at ${here}/Next`);
      if (st.Type === "Task" && typeof st.Resource !== "string") throw new Error(`SCHEMA_VALIDATION_FAILED: The field "Resource" is required at ${here}`);
      if (st.Type === "Choice") {
        const choices = st.Choices as { Next?: string }[] | undefined;
        if (!Array.isArray(choices) || !choices.length) throw new Error(`SCHEMA_VALIDATION_FAILED: The field "Choices" should be a non-empty array at ${here}`);
        choices.forEach((ch, i) => {
          if (!ch.Next || !def.States[ch.Next]) throw new Error(`MISSING_TRANSITION_TARGET: Missing 'Next' target: ${ch.Next ?? "(none)"} at ${here}/Choices[${i}]/Next`);
        });
        if (st.Default && !def.States[st.Default as string]) throw new Error(`MISSING_TRANSITION_TARGET: Missing 'Next' target: ${st.Default} at ${here}/Default`);
      }
      for (const c of (st.Catch as { Next?: string }[] | undefined) ?? []) {
        if (!c.Next || !def.States[c.Next]) throw new Error(`MISSING_TRANSITION_TARGET: Missing 'Next' target: ${c.Next ?? "(none)"} at ${here}/Catch`);
      }
      if (st.Type === "Map") {
        const inner = (st.ItemProcessor ?? st.Iterator) as Definition | undefined;
        if (!inner) throw new Error(`SCHEMA_VALIDATION_FAILED: The field "ItemProcessor" is required at ${here}`);
        check(inner, `${here}/ItemProcessor`);
      }
    }
  };
  check(d, "");
  return d;
}

/* ---------------- paths and parameters ---------------- */

function getPath(data: Json, path: string, ctx: Json): Json {
  let root = data;
  let p = path;
  if (p.startsWith("$$")) {
    root = ctx;
    p = p.slice(1);
  }
  if (p === "$") return root;
  if (!p.startsWith("$")) throw new StatesError("States.Runtime", `Invalid path '${path}': paths start with $`);
  let cur: Json = root;
  const re = /\.([A-Za-z0-9_-]+)|\[(\d+)\]|\['([^']+)'\]/g;
  let m;
  let pos = 1;
  while ((m = re.exec(p))) {
    if (m.index !== pos) break;
    pos = re.lastIndex;
    const k = m[1] ?? m[3] ?? Number(m[2]);
    if (cur === null || typeof cur !== "object" || !(k in (cur as Record<string, unknown>))) {
      throw new StatesError("States.Runtime", `The JSONPath '${path}' could not be found in the input '${JSON.stringify(data)}'`);
    }
    cur = (cur as Record<string | number, Json>)[k];
  }
  if (pos !== p.length) throw new StatesError("States.Runtime", `Invalid path '${path}'`);
  return cur;
}

function setPath(data: Json, path: string, value: Json): Json {
  if (path === "$") return value;
  const keys = path.replace(/^\$\.?/, "").split(".");
  const root = data && typeof data === "object" && !Array.isArray(data) ? structuredClone(data as Record<string, Json>) : {};
  let cur = root as Record<string, Json>;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else {
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k] as Record<string, Json>;
    }
  });
  return root;
}

function intrinsic(expr: string, data: Json, ctx: Json, state: AwsState): Json {
  const m = expr.match(/^States\.(\w+)\((.*)\)$/s);
  if (!m) return getPath(data, expr, ctx);
  const [, fn, rawArgs] = m;
  const args: Json[] = [];
  let i = 0;
  while (i < rawArgs.length) {
    while (rawArgs[i] === " " || rawArgs[i] === ",") i++;
    if (i >= rawArgs.length) break;
    if (rawArgs[i] === "'") {
      let s = "";
      i++;
      while (i < rawArgs.length && rawArgs[i] !== "'") {
        if (rawArgs[i] === "\\" && i + 1 < rawArgs.length) i++;
        s += rawArgs[i++];
      }
      i++;
      args.push(s);
    } else {
      let depth = 0;
      let s = "";
      while (i < rawArgs.length && (depth > 0 || rawArgs[i] !== ",")) {
        if (rawArgs[i] === "(") depth++;
        if (rawArgs[i] === ")") depth--;
        s += rawArgs[i++];
      }
      s = s.trim();
      args.push(s.startsWith("$") || s.startsWith("States.") ? intrinsic(s, data, ctx, state) : JSON.parse(s));
    }
  }
  switch (fn) {
    case "Format": {
      let k = 1;
      return String(args[0]).replace(/\{\}/g, () => {
        const v = args[k++];
        return typeof v === "string" ? v : JSON.stringify(v);
      });
    }
    case "StringToJson":
      return JSON.parse(String(args[0]));
    case "JsonToString":
      return JSON.stringify(args[0]);
    case "Array":
      return args;
    case "ArrayLength":
      return (args[0] as Json[]).length;
    case "MathAdd":
      return Number(args[0]) + Number(args[1]);
    case "UUID":
      return uuid(state);
    default:
      throw new StatesError("States.Runtime", `States.${fn} isn't supported in this lab. Try Format, StringToJson, JsonToString, Array, ArrayLength, MathAdd or UUID.`);
  }
}

/** Parameters / ResultSelector: keys ending in .$ take their value from a path or intrinsic function. */
function fill(template: Json, data: Json, ctx: Json, state: AwsState): Json {
  if (Array.isArray(template)) return template.map((x) => fill(x, data, ctx, state));
  if (!template || typeof template !== "object") return template;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(template as Record<string, Json>)) {
    if (k.endsWith(".$")) out[k.slice(0, -2)] = intrinsic(String(v), data, ctx, state);
    else out[k] = fill(v, data, ctx, state);
  }
  return out;
}

/* ---------------- choice rules ---------------- */

function rule(r: Record<string, Json>, data: Json, ctx: Json): boolean {
  if (Array.isArray(r.And)) return (r.And as Record<string, Json>[]).every((x) => rule(x, data, ctx));
  if (Array.isArray(r.Or)) return (r.Or as Record<string, Json>[]).some((x) => rule(x, data, ctx));
  if (r.Not) return !rule(r.Not as Record<string, Json>, data, ctx);
  const variable = String(r.Variable);
  let v: Json;
  let present = true;
  try {
    v = getPath(data, variable, ctx);
  } catch {
    present = false;
  }
  if ("IsPresent" in r) return present === r.IsPresent;
  if (!present) throw new StatesError("States.Runtime", `Invalid path '${variable}': The choice state's condition path references an invalid value.`);
  for (const [op, raw] of Object.entries(r)) {
    if (op === "Variable" || op === "Next") continue;
    const want = op.endsWith("Path") ? getPath(data, String(raw), ctx) : raw;
    const base = op.replace(/Path$/, "");
    switch (base) {
      case "StringEquals":
        return v === want;
      case "StringMatches":
        return typeof v === "string" && new RegExp("^" + String(want).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(v);
      case "NumericEquals":
        return typeof v === "number" && v === Number(want);
      case "NumericLessThan":
        return typeof v === "number" && v < Number(want);
      case "NumericGreaterThan":
        return typeof v === "number" && v > Number(want);
      case "NumericLessThanEquals":
        return typeof v === "number" && v <= Number(want);
      case "NumericGreaterThanEquals":
        return typeof v === "number" && v >= Number(want);
      case "BooleanEquals":
        return v === want;
      case "IsNull":
        return (v === null) === want;
      case "IsNumeric":
        return (typeof v === "number") === want;
      case "IsString":
        return (typeof v === "string") === want;
      case "IsBoolean":
        return (typeof v === "boolean") === want;
    }
  }
  throw new StatesError("States.Runtime", `A choice rule on ${variable} has no comparison this lab understands.`);
}

/* ---------------- running ---------------- */

const errorMatches = (list: string[], error: string) => list.some((e) => e === "States.ALL" || e === error || (e === "States.TaskFailed" && error !== "States.Timeout" && error !== "States.Runtime"));

interface Run {
  state: AwsState;
  rt: Runtime;
  services: Record<string, Service>;
  role: Principal;
  history: SfnHistoryEvent[];
  clock: number;
  transitions: number;
  ctx: Record<string, Json>;
}

function emit(run: Run, type: string, details?: Record<string, unknown>): void {
  const prev = run.history.length;
  run.history.push({ id: prev + 1, previousEventId: prev, timestamp: run.clock, type, ...(details ? { details } : {}) });
}

async function callService(run: Run, service: string, command: string, flags: Record<string, string[] | true>): Promise<Record<string, unknown>> {
  const io: Io = { readFile: () => "", writeFile: () => {}, exists: () => false, resolve: (p) => p };
  const c = new Call(run.state, run.role, service, command, flags, [], io, run.rt);
  const handler = run.services[service]?.commands[command];
  if (!handler) throw new StatesError("States.Runtime", `${service} ${command} isn't available`);
  try {
    return ((await handler(c)) as Record<string, unknown>) ?? {};
  } catch (e) {
    if (e instanceof AwsError) {
      const svc = service === "dynamodb" ? "DynamoDB" : service === "sqs" ? "SQS" : "SNS";
      throw new StatesError(`${svc}.${e.code}`, `${e.message} (Service: ${svc}, Status Code: 400, Error Code: ${e.code})`);
    }
    throw e;
  }
}

async function invoke(run: Run, fnRef: string, payload: Json): Promise<Json> {
  const name = fnRef.split(":function:").pop()!.split(":")[0];
  const f = run.state.lambda.functions[name];
  const fnArn = `arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${name}`;
  if (decide(run.state, run.role, "lambda:InvokeFunction", fnArn) !== "allow") {
    throw new StatesError(
      "Lambda.AWSLambdaException",
      `User: ${run.role.arn} is not authorized to perform: lambda:InvokeFunction on resource: ${fnArn} because no identity-based policy allows the lambda:InvokeFunction action (Service: Lambda, Status Code: 403, Error Code: AccessDeniedException)`,
    );
  }
  if (!f) throw new StatesError("Lambda.ResourceNotFoundException", `Function not found: ${fnArn} (Service: Lambda, Status Code: 404, Error Code: ResourceNotFoundException)`);
  const r = await run.rt.invokeLambda(run.state, f.arn, payload, "stepfunctions");
  if (!r.ok) throw new StatesError(r.error!.errorType, JSON.stringify({ errorType: r.error!.errorType, errorMessage: r.error!.errorMessage }));
  return r.result;
}

async function task(run: Run, st: State, input: Json): Promise<Json> {
  const res = String(st.Resource);
  const params = st.Parameters !== undefined ? fill(st.Parameters, input, run.ctx, run.state) : input;
  if (res.startsWith("arn:aws:lambda:")) {
    emit(run, "LambdaFunctionScheduled", { lambdaFunctionScheduledEventDetails: { resource: res, input: JSON.stringify(params) } });
    emit(run, "LambdaFunctionStarted");
    try {
      const out = await invoke(run, res, params);
      emit(run, "LambdaFunctionSucceeded", { lambdaFunctionSucceededEventDetails: { output: JSON.stringify(out) } });
      return out;
    } catch (e) {
      if (e instanceof StatesError) emit(run, "LambdaFunctionFailed", { lambdaFunctionFailedEventDetails: { error: e.error, cause: e.cause } });
      throw e;
    }
  }
  const m = res.match(/^arn:aws:states:::(\w+):(\w+)(\.sync|\.waitForTaskToken)?$/);
  if (!m) throw new StatesError("States.Runtime", `The resource ${res} isn't supported in this lab. Use a Lambda function ARN, or arn:aws:states:::lambda:invoke, dynamodb:putItem, dynamodb:getItem, sqs:sendMessage or sns:publish.`);
  const [, svc, action] = m;
  const p = (params ?? {}) as Record<string, Json>;
  emit(run, "TaskScheduled", { taskScheduledEventDetails: { resourceType: svc, resource: action, region: REGION, parameters: JSON.stringify(p) } });
  emit(run, "TaskStarted", { taskStartedEventDetails: { resourceType: svc, resource: action } });
  try {
    let out: Json;
    if (svc === "lambda" && action === "invoke") {
      if (!p.FunctionName) throw new StatesError("States.Runtime", "lambda:invoke needs Parameters.FunctionName");
      const payload = await invoke(run, String(p.FunctionName), p.Payload ?? {});
      out = { ExecutedVersion: "$LATEST", Payload: payload, SdkHttpMetadata: { HttpStatusCode: 200 }, StatusCode: 200 };
    } else if (svc === "dynamodb" && (action === "putItem" || action === "getItem" || action === "deleteItem")) {
      const cmd = { putItem: "put-item", getItem: "get-item", deleteItem: "delete-item" }[action];
      const flags: Record<string, string[] | true> = { "table-name": [String(p.TableName)] };
      if (p.Item) flags.item = [JSON.stringify(p.Item)];
      if (p.Key) flags.key = [JSON.stringify(p.Key)];
      if (p.ConditionExpression) flags["condition-expression"] = [String(p.ConditionExpression)];
      out = await callService(run, "dynamodb", cmd, flags);
    } else if (svc === "sqs" && action === "sendMessage") {
      const body = typeof p.MessageBody === "string" ? p.MessageBody : JSON.stringify(p.MessageBody);
      out = await callService(run, "sqs", "send-message", { "queue-url": [String(p.QueueUrl)], "message-body": [body] });
    } else if (svc === "sns" && action === "publish") {
      const msg = typeof p.Message === "string" ? p.Message : JSON.stringify(p.Message);
      out = await callService(run, "sns", "publish", { "topic-arn": [String(p.TopicArn)], message: [msg] });
    } else throw new StatesError("States.Runtime", `arn:aws:states:::${svc}:${action} isn't supported in this lab.`);
    emit(run, "TaskSucceeded", { taskSucceededEventDetails: { resourceType: svc, resource: action, output: JSON.stringify(out) } });
    return out;
  } catch (e) {
    if (e instanceof StatesError) emit(run, "TaskFailed", { taskFailedEventDetails: { resourceType: svc, resource: action, error: e.error, cause: e.cause } });
    throw e;
  }
}

/** Run a (sub-)machine from StartAt to a terminal state. Returns the output, or throws StatesError. */
async function runMachine(run: Run, def: Definition, input: Json): Promise<Json> {
  let name = def.StartAt;
  let data = input;
  for (;;) {
    if (++run.transitions > MAX_TRANSITIONS) throw new StatesError("States.Runtime", `The execution exceeded ${MAX_TRANSITIONS} state transitions. Is there a loop with no way out?`);
    const st = def.States[name];
    run.ctx.State = { Name: name, EnteredTime: iso(run.clock) };
    emit(run, `${st.Type}StateEntered`, { stateEnteredEventDetails: { name, input: JSON.stringify(data) } });
    let next: string | undefined = st.Next;
    let output: Json;
    try {
      const effective = st.InputPath === null ? {} : st.InputPath !== undefined ? getPath(data, String(st.InputPath), run.ctx) : data;
      switch (st.Type) {
        case "Pass": {
          const res = st.Result !== undefined ? st.Result : st.Parameters !== undefined ? fill(st.Parameters, effective, run.ctx, run.state) : effective;
          output = applyResult(st, data, res);
          break;
        }
        case "Task": {
          const retries = (st.Retry as { ErrorEquals: string[]; IntervalSeconds?: number; MaxAttempts?: number; BackoffRate?: number }[] | undefined) ?? [];
          const attempts = new Map<number, number>();
          let res: Json;
          for (;;) {
            try {
              res = await task(run, st, effective);
              break;
            } catch (e) {
              if (!(e instanceof StatesError)) throw e;
              const i = retries.findIndex((r) => errorMatches(r.ErrorEquals, e.error));
              if (i < 0) throw e;
              const r = retries[i];
              const n = attempts.get(i) ?? 0;
              if (n >= (r.MaxAttempts ?? 3)) throw e;
              attempts.set(i, n + 1);
              run.clock += (r.IntervalSeconds ?? 1) * 1000 * Math.pow(r.BackoffRate ?? 2, n);
            }
          }
          if (st.ResultSelector) res = fill(st.ResultSelector, res, run.ctx, run.state);
          output = applyResult(st, data, res);
          break;
        }
        case "Choice": {
          const choices = st.Choices as (Record<string, Json> & { Next: string })[];
          const hit = choices.find((ch) => rule(ch, effective, run.ctx));
          next = hit?.Next ?? (st.Default as string | undefined);
          if (!next) throw new StatesError("States.NoChoiceMatched", `No Matches! (none of the Choices in ${name} matched the input, and there's no Default)`);
          output = effective;
          break;
        }
        case "Wait": {
          const secs = st.Seconds !== undefined ? Number(st.Seconds) : st.SecondsPath ? Number(getPath(effective, String(st.SecondsPath), run.ctx)) : 0;
          run.clock += Math.max(0, secs) * 1000;
          output = effective;
          break;
        }
        case "Map": {
          const items = st.ItemsPath ? getPath(data, String(st.ItemsPath), run.ctx) : effective;
          if (!Array.isArray(items)) throw new StatesError("States.Runtime", `The Map state's items (${st.ItemsPath ?? "$"}) must be a list.`);
          const inner = (st.ItemProcessor ?? st.Iterator) as Definition;
          const results: Json[] = [];
          for (let i = 0; i < items.length; i++) {
            run.ctx.Map = { Item: { Index: i, Value: items[i] } };
            const itemInput = st.ItemSelector ?? st.Parameters ? fill(st.ItemSelector ?? st.Parameters, effective, run.ctx, run.state) : items[i];
            emit(run, "MapIterationStarted", { mapIterationStartedEventDetails: { name, index: i } });
            results.push(await runMachine(run, inner, itemInput));
            emit(run, "MapIterationSucceeded", { mapIterationSucceededEventDetails: { name, index: i } });
          }
          delete run.ctx.Map;
          output = applyResult(st, data, results);
          break;
        }
        case "Succeed":
          output = effective;
          break;
        case "Fail":
          throw new StatesError(String(st.Error ?? "States.Fail"), String(st.Cause ?? ""));
        default:
          throw new StatesError("States.Runtime", `Unsupported state type ${st.Type}`);
      }
      if (st.OutputPath !== undefined) output = st.OutputPath === null ? {} : getPath(output, String(st.OutputPath), run.ctx);
    } catch (e) {
      if (!(e instanceof StatesError)) throw e;
      const catches = (st.Catch as { ErrorEquals: string[]; Next: string; ResultPath?: string | null }[] | undefined) ?? [];
      const c = st.Type === "Fail" ? undefined : catches.find((x) => errorMatches(x.ErrorEquals, e.error));
      if (!c) {
        throw e;
      }
      const errOut = { Error: e.error, Cause: e.cause };
      output = c.ResultPath === null ? data : setPath(data, c.ResultPath ?? "$", errOut);
      next = c.Next;
    }
    emit(run, `${st.Type}StateExited`, { stateExitedEventDetails: { name, output: JSON.stringify(output) } });
    if (st.Type === "Succeed" || (!next && (st.End || st.Type !== "Choice"))) return output;
    data = output;
    name = next!;
  }
}

function applyResult(st: State, data: Json, res: Json): Json {
  if (st.ResultPath === null) return data;
  return setPath(data, st.ResultPath === undefined ? "$" : String(st.ResultPath), res);
}

export async function execute(state: AwsState, rt: Runtime, services: Record<string, Service>, m: SfnMachine, name: string, input: Json): Promise<SfnExecution> {
  const startedAt = now(state);
  const arnExec = `arn:aws:states:${REGION}:${ACCOUNT_ID}:${m.type === "EXPRESS" ? "express" : "execution"}:${m.name}:${name}`;
  const run: Run = {
    state,
    rt,
    services,
    role: principalForRole(m.roleArn, name),
    history: [],
    clock: startedAt,
    transitions: 0,
    ctx: { Execution: { Id: arnExec, Input: input, Name: name, StartTime: iso(startedAt), RoleArn: m.roleArn }, StateMachine: { Id: m.arn, Name: m.name } },
  };
  emit(run, "ExecutionStarted", { executionStartedEventDetails: { input: JSON.stringify(input), roleArn: m.roleArn } });
  const exec: SfnExecution = { arn: arnExec, name, machineArn: m.arn, startedAt, stopAt: startedAt, input: JSON.stringify(input), status: "SUCCEEDED", history: run.history };
  try {
    const out = await runMachine(run, JSON.parse(m.definition), input);
    exec.output = JSON.stringify(out);
    emit(run, "ExecutionSucceeded", { executionSucceededEventDetails: { output: exec.output } });
  } catch (e) {
    if (!(e instanceof StatesError)) throw e;
    exec.status = "FAILED";
    exec.error = e.error;
    exec.cause = e.cause;
    emit(run, "ExecutionFailed", { executionFailedEventDetails: { error: e.error, cause: e.cause } });
  }
  exec.stopAt = run.clock;
  return exec;
}

/* ---------------- the CLI ---------------- */

function needMachine(c: Call, a: string | undefined): SfnMachine {
  if (!a) throw new UsageError("the following arguments are required: --state-machine-arn");
  const m = Object.values(c.state.sfn.machines).find((x) => x.arn === a);
  if (!m) throw c.error("StateMachineDoesNotExist", `State Machine Does Not Exist: '${a}'`);
  return m;
}

function needExec(c: Call): SfnExecution {
  const a = c.str("execution-arn", true);
  const e = c.state.sfn.executions.find((x) => x.arn === a);
  if (!e) throw c.error("ExecutionDoesNotExist", `Execution Does Not Exist: '${a}'`);
  return e;
}

const statusOf = (s: AwsState, e: SfnExecution) => (now(s) < e.stopAt ? "RUNNING" : e.status);

function checkRole(c: Call, roleArn: string): void {
  const r = c.state.iam.roles[roleArn.split("/").pop() ?? ""];
  if (!r || r.arn !== roleArn) throw c.error("InvalidArn", `Invalid Arn: 'Role does not exist: ${roleArn}'`);
  if (!trusts(r.trust, "states.amazonaws.com")) throw c.error("AccessDeniedException", "Neither the global service principal states.amazonaws.com, nor the regional one is authorized to assume the provided role.");
}

export function stepFunctionsService(rt: Runtime, services: () => Record<string, Service>): Service {
  return {
    blurb: "Step Functions: run a workflow of steps, with retries and branches, as a state machine",
    commands: {
      "create-state-machine": (c) => {
        const name = c.str("name", true);
        c.authorize("states:CreateStateMachine", machineArn(name));
        const def = c.str("definition", true);
        try {
          validateDefinition(def);
        } catch (e) {
          throw c.error("InvalidDefinition", `Invalid State Machine Definition: '${(e as Error).message}'`);
        }
        const roleArn = c.str("role-arn", true);
        checkRole(c, roleArn);
        if (c.state.sfn.machines[name]) throw c.error("StateMachineAlreadyExists", `State Machine Already Exists: '${machineArn(name)}'`);
        const type = (c.str("type") ?? "STANDARD").toUpperCase();
        if (type !== "STANDARD" && type !== "EXPRESS") throw c.error("ValidationException", "type must be STANDARD or EXPRESS");
        const m: SfnMachine = { name, arn: machineArn(name), definition: def, roleArn, type: type as SfnMachine["type"], createdAt: now(c.state) };
        c.state.sfn.machines[name] = m;
        return { stateMachineArn: m.arn, creationDate: iso(m.createdAt) };
      },
      "update-state-machine": (c) => {
        const m = needMachine(c, c.str("state-machine-arn"));
        const def = c.str("definition");
        if (def) {
          try {
            validateDefinition(def);
          } catch (e) {
            throw c.error("InvalidDefinition", `Invalid State Machine Definition: '${(e as Error).message}'`);
          }
          m.definition = def;
        }
        const role = c.str("role-arn");
        if (role) {
          checkRole(c, role);
          m.roleArn = role;
        }
        return { updateDate: iso(now(c.state)) };
      },
      "describe-state-machine": (c) => {
        const m = needMachine(c, c.str("state-machine-arn"));
        return { stateMachineArn: m.arn, name: m.name, status: "ACTIVE", definition: m.definition, roleArn: m.roleArn, type: m.type, creationDate: iso(m.createdAt) };
      },
      "list-state-machines": (c) => ({
        stateMachines: Object.values(c.state.sfn.machines).map((m) => ({ stateMachineArn: m.arn, name: m.name, type: m.type, creationDate: iso(m.createdAt) })),
      }),
      "delete-state-machine": (c) => {
        const m = needMachine(c, c.str("state-machine-arn"));
        delete c.state.sfn.machines[m.name];
      },
      "start-execution": async (c) => {
        const m = needMachine(c, c.str("state-machine-arn"));
        c.authorize("states:StartExecution", m.arn);
        let input: Json = {};
        const raw = c.str("input");
        if (raw !== undefined) {
          try {
            input = JSON.parse(raw);
          } catch {
            throw c.error("InvalidExecutionInput", "Invalid State Machine Execution Input: 'Make sure the input is a valid JSON text.'");
          }
        }
        const name = c.str("name") ?? uuid(c.state);
        if (c.state.sfn.executions.some((e) => e.machineArn === m.arn && e.name === name)) throw c.error("ExecutionAlreadyExists", `Execution Already Exists: '${name}'`);
        const e = await execute(c.state, rt, services(), m, name, input);
        c.state.sfn.executions.push(e);
        if (c.state.sfn.executions.length > 200) c.state.sfn.executions.splice(0, c.state.sfn.executions.length - 200);
        return { executionArn: e.arn, startDate: iso(e.startedAt) };
      },
      "start-sync-execution": async (c) => {
        const m = needMachine(c, c.str("state-machine-arn"));
        if (m.type !== "EXPRESS") throw c.error("StateMachineTypeNotSupported", "This operation is only supported by EXPRESS state machines");
        const raw = c.str("input");
        const e = await execute(c.state, rt, services(), m, c.str("name") ?? uuid(c.state), raw ? JSON.parse(raw) : {});
        return { executionArn: e.arn, stateMachineArn: m.arn, name: e.name, startDate: iso(e.startedAt), stopDate: iso(e.stopAt), status: e.status, input: e.input, ...(e.output ? { output: e.output } : {}), ...(e.error ? { error: e.error, cause: e.cause } : {}) };
      },
      "describe-execution": (c) => {
        const e = needExec(c);
        const status = statusOf(c.state, e);
        return {
          executionArn: e.arn,
          stateMachineArn: e.machineArn,
          name: e.name,
          status,
          startDate: iso(e.startedAt),
          ...(status !== "RUNNING" ? { stopDate: iso(e.stopAt) } : {}),
          input: e.input,
          ...(status === "SUCCEEDED" ? { output: e.output } : {}),
          ...(status === "FAILED" ? { error: e.error, cause: e.cause } : {}),
        };
      },
      "list-executions": (c) => {
        const m = needMachine(c, c.str("state-machine-arn"));
        const filter = c.str("status-filter");
        const list = c.state.sfn.executions
          .filter((e) => e.machineArn === m.arn)
          .map((e) => ({ executionArn: e.arn, stateMachineArn: e.machineArn, name: e.name, status: statusOf(c.state, e), startDate: iso(e.startedAt) }))
          .filter((e) => !filter || e.status === filter)
          .reverse();
        return { executions: list };
      },
      "get-execution-history": (c) => {
        const e = needExec(c);
        const t = now(c.state);
        // While it's still "running", only the events up to now have happened.
        const events = e.history
          .filter((h) => h.timestamp <= t)
          .map((h) => ({ timestamp: iso(h.timestamp), type: h.type, id: h.id, previousEventId: h.previousEventId, ...(h.details ?? {}) }));
        return { events: c.bool("reverse-order") ? events.reverse() : events };
      },
    },
  };
}
