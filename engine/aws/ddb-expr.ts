import type { DdbItem, DdbValue } from "./state";

/**
 * DynamoDB's expression language: conditions (key conditions, filters,
 * condition checks), update expressions and projections. Names (#n) and
 * values (:v) are resolved from the request's maps.
 */

export class ExprError extends Error {}

/** A slice of DynamoDB's reserved words: the ones people actually trip on. */
export const RESERVED = new Set(
  "abort absolute action add all and any as asc at attribute avg between binary blob boolean both by bytes cache call cascade case cast char character check close collection column comment commit condition connection constraint count create cross current cursor data date day dec decimal default delete desc describe double drop dynamic each element else end entry escape except exists exit false fetch first float for from full function get global go group having hour if in index inner input insert int integer interval into is item items join key keys language last left level like limit list local location long lower map match max member merge min minute mode month name names next no none not null number object of offset on only open option or order out outer over owner parameters partition password path percent plan position primary private public range rank raw read real reference region rename replace return right role rows schema second select session set sets size source start status string sum system table tag tags temporary then time timestamp to token total transaction true type types union unique unknown update upper usage user users using value values view when where with within year zone"
    .split(" "),
);

type Path = (string | number)[];

type Operand =
  | { k: "path"; path: Path; raw: string }
  | { k: "val"; name: string }
  | { k: "size"; path: Path };

export type Cond =
  | { k: "cmp"; op: string; l: Operand; r: Operand }
  | { k: "between"; v: Operand; lo: Operand; hi: Operand }
  | { k: "in"; v: Operand; list: Operand[] }
  | { k: "fn"; name: string; args: Operand[] }
  | { k: "and" | "or"; l: Cond; r: Cond }
  | { k: "not"; c: Cond };

interface Ctx {
  names: Record<string, string>;
  values: Record<string, DdbValue>;
  usedNames: Set<string>;
  usedValues: Set<string>;
  what: string;
}

/* ---------------- lexing ---------------- */

type Tok = { t: "name" | "attr" | "val" | "num" | "op" | "kw"; v: string };

function lex(src: string, what: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "#" || c === ":") {
      let v = c;
      i++;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) v += src[i++];
      if (v.length === 1) throw new ExprError(`Invalid ${what}: Syntax error; token: "${c}", near: "${src.slice(Math.max(0, i - 3), i + 3)}"`);
      out.push({ t: c === "#" ? "name" : "val", v });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let v = "";
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) v += src[i++];
      const lower = v.toLowerCase();
      if (["and", "or", "not", "between", "in", "set", "remove", "add", "delete"].includes(lower)) out.push({ t: "kw", v: lower });
      else out.push({ t: "attr", v });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let v = "";
      while (i < src.length && /[0-9]/.test(src[i])) v += src[i++];
      out.push({ t: "num", v });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<>", "<=", ">="].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("=<>(),.[]+-".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new ExprError(`Invalid ${what}: Syntax error; token: "${c}", near: "${src.slice(Math.max(0, i - 3), i + 3)}"`);
  }
  return out;
}

/* ---------------- parsing ---------------- */

class P {
  i = 0;
  constructor(
    public toks: Tok[],
    public ctx: Ctx,
    public src: string,
  ) {}
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  isOp(v: string) {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }
  isKw(v: string) {
    const t = this.peek();
    return t?.t === "kw" && t.v === v;
  }
  eatOp(v: string) {
    if (!this.isOp(v)) this.syntax();
    this.i++;
  }
  syntax(): never {
    const t = this.peek();
    throw new ExprError(`Invalid ${this.ctx.what}: Syntax error; token: "${t ? t.v : "<EOF>"}", near: "${this.src.slice(0, 40)}"`);
  }
  done() {
    return this.i >= this.toks.length;
  }

  path(): Path {
    const out: Path = [];
    const part = () => {
      const t = this.peek();
      if (!t) this.syntax();
      if (t.t === "name") {
        this.i++;
        this.ctx.usedNames.add(t.v);
        const real = this.ctx.names[t.v];
        if (real === undefined) throw new ExprError(`Invalid ${this.ctx.what}: An expression attribute name used in the document path is not defined; attribute name: ${t.v}`);
        out.push(real);
      } else if (t.t === "attr") {
        this.i++;
        if (RESERVED.has(t.v.toLowerCase())) {
          throw new ExprError(`Invalid ${this.ctx.what}: Attribute name is a reserved keyword; reserved keyword: ${t.v}`);
        }
        out.push(t.v);
      } else this.syntax();
    };
    part();
    for (;;) {
      if (this.isOp(".")) {
        this.i++;
        part();
      } else if (this.isOp("[")) {
        this.i++;
        const n = this.peek();
        if (n?.t !== "num") this.syntax();
        this.i++;
        this.eatOp("]");
        out.push(Number(n.v));
      } else break;
    }
    return out;
  }

  operand(): Operand {
    const t = this.peek();
    if (!t) this.syntax();
    if (t.t === "val") {
      this.i++;
      this.ctx.usedValues.add(t.v);
      if (!(t.v in this.ctx.values)) throw new ExprError(`Invalid ${this.ctx.what}: An expression attribute value used in expression is not defined; attribute value: ${t.v}`);
      return { k: "val", name: t.v };
    }
    if (t.t === "attr" && t.v.toLowerCase() === "size" && this.peek(1)?.v === "(") {
      this.i += 2;
      const p = this.path();
      this.eatOp(")");
      return { k: "size", path: p };
    }
    const start = this.i;
    const p = this.path();
    return { k: "path", path: p, raw: this.toks.slice(start, this.i).map((x) => x.v).join("") };
  }

  cond(): Cond {
    let l = this.andC();
    while (this.isKw("or")) {
      this.i++;
      l = { k: "or", l, r: this.andC() };
    }
    return l;
  }
  andC(): Cond {
    let l = this.notC();
    while (this.isKw("and")) {
      this.i++;
      l = { k: "and", l, r: this.notC() };
    }
    return l;
  }
  notC(): Cond {
    if (this.isKw("not")) {
      this.i++;
      return { k: "not", c: this.notC() };
    }
    return this.atom();
  }
  atom(): Cond {
    if (this.isOp("(")) {
      this.i++;
      const c = this.cond();
      this.eatOp(")");
      return c;
    }
    const t = this.peek();
    const fns = ["attribute_exists", "attribute_not_exists", "attribute_type", "begins_with", "contains"];
    if (t?.t === "attr" && fns.includes(t.v) && this.peek(1)?.v === "(") {
      this.i += 2;
      const args: Operand[] = [this.operand()];
      while (this.isOp(",")) {
        this.i++;
        args.push(this.operand());
      }
      this.eatOp(")");
      return { k: "fn", name: t.v, args };
    }
    const l = this.operand();
    if (this.isKw("between")) {
      this.i++;
      const lo = this.operand();
      if (!this.isKw("and")) this.syntax();
      this.i++;
      return { k: "between", v: l, lo, hi: this.operand() };
    }
    if (this.isKw("in")) {
      this.i++;
      this.eatOp("(");
      const list = [this.operand()];
      while (this.isOp(",")) {
        this.i++;
        list.push(this.operand());
      }
      this.eatOp(")");
      return { k: "in", v: l, list };
    }
    const op = this.peek();
    if (op?.t !== "op" || !["=", "<>", "<", "<=", ">", ">="].includes(op.v)) this.syntax();
    this.i++;
    return { k: "cmp", op: op.v, l, r: this.operand() };
  }
}

export function makeCtx(names: Record<string, string> | undefined, values: Record<string, DdbValue> | undefined, what: string): Ctx {
  return { names: names ?? {}, values: values ?? {}, usedNames: new Set(), usedValues: new Set(), what };
}

export function parseCondition(src: string, ctx: Ctx): Cond {
  const p = new P(lex(src, ctx.what), ctx, src);
  const c = p.cond();
  if (!p.done()) p.syntax();
  return c;
}

/** After parsing every expression in a request: unused names/values are an error, like the real service. */
export function checkUnused(ctx: Ctx): void {
  const unusedV = Object.keys(ctx.values).filter((v) => !ctx.usedValues.has(v));
  if (unusedV.length) throw new ExprError(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${unusedV.join(", ")}}`);
  const unusedN = Object.keys(ctx.names).filter((n) => !ctx.usedNames.has(n));
  if (unusedN.length) throw new ExprError(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${unusedN.join(", ")}}`);
}

/* ---------------- values ---------------- */

export function getPath(item: DdbItem, path: Path): DdbValue | undefined {
  let cur: DdbValue | undefined = item[path[0] as string];
  for (const p of path.slice(1)) {
    if (!cur) return undefined;
    if (typeof p === "number") cur = (cur.L as DdbValue[] | undefined)?.[p];
    else cur = (cur.M as Record<string, DdbValue> | undefined)?.[p];
  }
  return cur;
}

const typeOf = (v: DdbValue) => Object.keys(v)[0];

function scalar(v: DdbValue): string | number | boolean | null {
  const t = typeOf(v);
  if (t === "N") return Number(v.N);
  if (t === "S" || t === "B") return v[t] as string;
  if (t === "BOOL") return v.BOOL as boolean;
  return null;
}

export function compare(a: DdbValue, b: DdbValue): number | null {
  if (typeOf(a) !== typeOf(b)) return null;
  const x = scalar(a);
  const y = scalar(b);
  if (x === null || y === null) return JSON.stringify(a) === JSON.stringify(b) ? 0 : null;
  return x < y ? -1 : x > y ? 1 : 0;
}

function sizeOf(v: DdbValue): number {
  const t = typeOf(v);
  if (t === "S") return new TextEncoder().encode(v.S as string).length;
  if (t === "L") return (v.L as unknown[]).length;
  if (t === "M") return Object.keys(v.M as object).length;
  if (t === "SS" || t === "NS" || t === "BS") return (v[t] as unknown[]).length;
  if (t === "B") return (v.B as string).length;
  return 0;
}

function resolve(o: Operand, item: DdbItem, ctx: Ctx): DdbValue | undefined {
  if (o.k === "val") return ctx.values[o.name];
  if (o.k === "size") {
    const v = getPath(item, o.path);
    return v ? { N: String(sizeOf(v)) } : undefined;
  }
  return getPath(item, o.path);
}

export function evalCond(c: Cond, item: DdbItem, ctx: Ctx): boolean {
  switch (c.k) {
    case "and":
      return evalCond(c.l, item, ctx) && evalCond(c.r, item, ctx);
    case "or":
      return evalCond(c.l, item, ctx) || evalCond(c.r, item, ctx);
    case "not":
      return !evalCond(c.c, item, ctx);
    case "cmp": {
      const a = resolve(c.l, item, ctx);
      const b = resolve(c.r, item, ctx);
      if (!a || !b) return c.op === "<>" ? Boolean(a) !== Boolean(b) : false;
      const r = compare(a, b);
      if (r === null) return c.op === "<>";
      return { "=": r === 0, "<>": r !== 0, "<": r < 0, "<=": r <= 0, ">": r > 0, ">=": r >= 0 }[c.op]!;
    }
    case "between": {
      const v = resolve(c.v, item, ctx);
      const lo = resolve(c.lo, item, ctx);
      const hi = resolve(c.hi, item, ctx);
      if (!v || !lo || !hi) return false;
      const a = compare(v, lo);
      const b = compare(v, hi);
      return a !== null && b !== null && a >= 0 && b <= 0;
    }
    case "in": {
      const v = resolve(c.v, item, ctx);
      return Boolean(v) && c.list.some((o) => {
        const x = resolve(o, item, ctx);
        return x !== undefined && compare(v!, x) === 0;
      });
    }
    case "fn": {
      const [first, second] = c.args;
      if (c.name === "attribute_exists") return first.k === "path" && getPath(item, first.path) !== undefined;
      if (c.name === "attribute_not_exists") return first.k === "path" && getPath(item, first.path) === undefined;
      const v = resolve(first, item, ctx);
      const arg = second ? resolve(second, item, ctx) : undefined;
      if (c.name === "attribute_type") return Boolean(v && arg && typeOf(v) === arg.S);
      if (!v || !arg) return false;
      if (c.name === "begins_with") return typeof v.S === "string" && typeof arg.S === "string" && v.S.startsWith(arg.S);
      if (c.name === "contains") {
        if (typeof v.S === "string") return typeof arg.S === "string" && v.S.includes(arg.S);
        const t = typeOf(v);
        if (t === "SS" || t === "NS") return (v[t] as string[]).includes((arg.S ?? arg.N) as string);
        if (t === "L") return (v.L as DdbValue[]).some((x) => compare(x, arg) === 0);
      }
      return false;
    }
  }
}

/* ---------------- key conditions ---------------- */

/** Split a key condition into the partition-key equality and an optional sort-key condition. */
export function keyParts(c: Cond): Cond[] {
  if (c.k === "and") return [...keyParts(c.l), ...keyParts(c.r)];
  if (c.k === "or" || c.k === "not") throw new ExprError("Invalid operator used in KeyConditionExpression: " + c.k.toUpperCase());
  return [c];
}

export function condAttr(c: Cond): string | null {
  const o = c.k === "cmp" ? c.l : c.k === "between" ? c.v : c.k === "fn" ? c.args[0] : null;
  return o && o.k === "path" ? String(o.path[0]) : null;
}

/* ---------------- updates ---------------- */

export interface UpdateAction {
  kind: "set" | "remove" | "add" | "delete";
  path: Path;
  value?: SetValue;
}

type SetValue =
  | { k: "op"; o: Operand }
  | { k: "plus" | "minus"; a: SetValue; b: SetValue }
  | { k: "fn"; name: "if_not_exists" | "list_append"; args: SetValue[] };

export function parseUpdate(src: string, ctx: Ctx): UpdateAction[] {
  const p = new P(lex(src, ctx.what), ctx, src);
  const out: UpdateAction[] = [];
  const seen = new Set<string>();
  const value = (): SetValue => {
    const t = p.peek();
    let v: SetValue;
    if (t?.t === "attr" && (t.v === "if_not_exists" || t.v === "list_append") && p.peek(1)?.v === "(") {
      p.i += 2;
      const args = [value()];
      while (p.isOp(",")) {
        p.i++;
        args.push(value());
      }
      p.eatOp(")");
      v = { k: "fn", name: t.v, args };
    } else v = { k: "op", o: p.operand() };
    if (p.isOp("+") || p.isOp("-")) {
      const op = p.peek()!.v === "+" ? "plus" : "minus";
      p.i++;
      return { k: op, a: v, b: value() };
    }
    return v;
  };
  while (!p.done()) {
    const kw = p.peek();
    if (kw?.t !== "kw" || !["set", "remove", "add", "delete"].includes(kw.v)) p.syntax();
    if (seen.has(kw.v)) throw new ExprError(`Invalid UpdateExpression: The "${kw.v.toUpperCase()}" section can only be used once in an update expression;`);
    seen.add(kw.v);
    p.i++;
    for (;;) {
      const path = p.path();
      if (kw.v === "set") {
        p.eatOp("=");
        out.push({ kind: "set", path, value: value() });
      } else if (kw.v === "remove") out.push({ kind: "remove", path });
      else out.push({ kind: kw.v as "add" | "delete", path, value: { k: "op", o: p.operand() } });
      if (p.isOp(",")) {
        p.i++;
        continue;
      }
      break;
    }
  }
  return out;
}

function evalSet(v: SetValue, item: DdbItem, ctx: Ctx): DdbValue {
  if (v.k === "op") {
    const r = resolve(v.o, item, ctx);
    if (!r) throw new ExprError("The provided expression refers to an attribute that does not exist in the item");
    return r;
  }
  if (v.k === "plus" || v.k === "minus") {
    const a = evalSet(v.a, item, ctx);
    const b = evalSet(v.b, item, ctx);
    if (a.N === undefined || b.N === undefined) throw new ExprError("An operand in the update expression has an incorrect data type");
    return { N: String(v.k === "plus" ? Number(a.N) + Number(b.N) : Number(a.N) - Number(b.N)) };
  }
  if (v.k !== "fn") throw new ExprError("Invalid UpdateExpression");
  if (v.name === "if_not_exists") {
    const first = v.args[0];
    if (first.k === "op" && first.o.k === "path") {
      const existing = getPath(item, first.o.path);
      if (existing) return existing;
    }
    return evalSet(v.args[1], item, ctx);
  }
  const a = evalSet(v.args[0], item, ctx);
  const b = evalSet(v.args[1], item, ctx);
  if (!a.L || !b.L) throw new ExprError("An operand in the update expression has an incorrect data type");
  return { L: [...(a.L as DdbValue[]), ...(b.L as DdbValue[])] };
}

function setPath(item: DdbItem, path: Path, value: DdbValue | undefined): void {
  if (path.length === 1) {
    if (value === undefined) delete item[path[0] as string];
    else item[path[0] as string] = value;
    return;
  }
  const parent = getPath(item, path.slice(0, -1));
  if (!parent) throw new ExprError("The document path provided in the update expression is invalid for update");
  const last = path[path.length - 1];
  if (typeof last === "number") {
    const l = parent.L as DdbValue[];
    if (!l) throw new ExprError("The document path provided in the update expression is invalid for update");
    if (value === undefined) l.splice(last, 1);
    else l[Math.min(last, l.length)] = value;
  } else {
    const m = parent.M as Record<string, DdbValue>;
    if (!m) throw new ExprError("The document path provided in the update expression is invalid for update");
    if (value === undefined) delete m[last];
    else m[last] = value;
  }
}

export function applyUpdate(item: DdbItem, actions: UpdateAction[], ctx: Ctx): void {
  // Every right-hand side is computed from the item before the update, then applied.
  const computed = actions.map((a) => (a.kind === "set" || a.kind === "add" || a.kind === "delete" ? evalSet(a.value!, item, ctx) : undefined));
  actions.forEach((a, i) => {
    const v = computed[i];
    if (a.kind === "set") setPath(item, a.path, v);
    else if (a.kind === "remove") setPath(item, a.path, undefined);
    else if (a.kind === "add") {
      const cur = getPath(item, a.path);
      if (v!.N !== undefined) setPath(item, a.path, { N: String(Number(cur?.N ?? 0) + Number(v!.N)) });
      else {
        const t = typeOf(v!);
        if (!["SS", "NS", "BS"].includes(t)) throw new ExprError("Invalid UpdateExpression: Incorrect operand type for operator or function; operator: ADD, operand type: " + t);
        setPath(item, a.path, { [t]: [...new Set([...((cur?.[t] as string[]) ?? []), ...(v![t] as string[])])] });
      }
    } else {
      const cur = getPath(item, a.path);
      const t = typeOf(v!);
      if (cur) {
        const left = (cur[t] as string[]).filter((x) => !(v![t] as string[]).includes(x));
        setPath(item, a.path, left.length ? { [t]: left } : undefined);
      }
    }
  });
}

export function parseProjection(src: string, ctx: Ctx): Path[] {
  const p = new P(lex(src, ctx.what), ctx, src);
  const out = [p.path()];
  while (p.isOp(",")) {
    p.i++;
    out.push(p.path());
  }
  if (!p.done()) p.syntax();
  return out;
}

export function project(item: DdbItem, paths: Path[]): DdbItem {
  const out: DdbItem = {};
  for (const path of paths) {
    const v = getPath(item, path);
    if (v !== undefined) out[path[0] as string] = path.length === 1 ? v : item[path[0] as string];
  }
  return out;
}
