import { UsageError } from "./state";

/**
 * The part of JMESPath people actually use with `aws --query`:
 *   QueueUrl, Messages[0].ReceiptHandle, Buckets[].Name, Functions[*].FunctionName,
 *   Items[?status.S=='paid'], Functions[].{Name:FunctionName,Runtime:Runtime},
 *   [Count, ScannedCount], length(Items)
 */

type Tok =
  | { t: "id"; v: string }
  | { t: "num"; v: number }
  | { t: "lit"; v: unknown }
  | { t: "op"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let v = "";
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) v += src[i++];
      out.push({ t: "id", v });
      continue;
    }
    if (/[0-9-]/.test(c) && (c !== "-" || /[0-9]/.test(src[i + 1] ?? ""))) {
      let v = c;
      i++;
      while (i < src.length && /[0-9]/.test(src[i])) v += src[i++];
      out.push({ t: "num", v: Number(v) });
      continue;
    }
    if (c === '"') {
      let v = "";
      i++;
      while (i < src.length && src[i] !== '"') v += src[i++];
      i++;
      out.push({ t: "id", v });
      continue;
    }
    if (c === "'") {
      let v = "";
      i++;
      while (i < src.length && src[i] !== "'") v += src[i++];
      i++;
      out.push({ t: "lit", v });
      continue;
    }
    if (c === "`") {
      let v = "";
      i++;
      while (i < src.length && src[i] !== "`") v += src[i++];
      i++;
      let val: unknown = v;
      try {
        val = JSON.parse(v);
      } catch {}
      out.push({ t: "lit", v: val });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||", "[?", "[]"].includes(two)) {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("[].{}:,*()<>!@|".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new UsageError(`Bad value for --query ${src}: unexpected character '${c}'`);
  }
  return out;
}

type Node =
  | { k: "current" }
  | { k: "field"; name: string }
  | { k: "sub"; l: Node; r: Node }
  | { k: "index"; l: Node; i: number }
  | { k: "project"; l: Node; r: Node; flatten: boolean }
  | { k: "filter"; l: Node; cond: Node; r: Node }
  | { k: "hash"; items: [string, Node][] }
  | { k: "list"; items: Node[] }
  | { k: "lit"; v: unknown }
  | { k: "cmp"; op: string; l: Node; r: Node }
  | { k: "and" | "or"; l: Node; r: Node }
  | { k: "not"; e: Node }
  | { k: "fn"; name: string; args: Node[] };

class Parser {
  i = 0;
  constructor(
    private toks: Tok[],
    private src: string,
  ) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isOp(v: string): boolean {
    const t = this.peek();
    return t?.t === "op" && t.v === v;
  }
  eat(v: string): void {
    if (!this.isOp(v)) throw new UsageError(`Bad value for --query ${this.src}: expected '${v}'`);
    this.i++;
  }

  expr(): Node {
    let l = this.or();
    // A pipe ends any projection: what follows applies to the whole result.
    while (this.isOp("|")) {
      this.i++;
      l = { k: "sub", l, r: this.or() };
    }
    return l;
  }
  or(): Node {
    let l = this.and();
    while (this.isOp("||")) {
      this.i++;
      l = { k: "or", l, r: this.and() };
    }
    return l;
  }
  and(): Node {
    let l = this.cmp();
    while (this.isOp("&&")) {
      this.i++;
      l = { k: "and", l, r: this.cmp() };
    }
    return l;
  }
  cmp(): Node {
    const l = this.unary();
    const t = this.peek();
    if (t?.t === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(t.v)) {
      this.i++;
      return { k: "cmp", op: t.v, l, r: this.unary() };
    }
    return l;
  }
  unary(): Node {
    if (this.isOp("!")) {
      this.i++;
      return { k: "not", e: this.unary() };
    }
    return this.chain(this.primary());
  }
  primary(): Node {
    const t = this.peek();
    if (!t) return { k: "current" };
    if (t.t === "lit") {
      this.i++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "num") {
      this.i++;
      return { k: "lit", v: t.v };
    }
    if (t.t === "id") {
      this.i++;
      if (this.isOp("(")) {
        this.i++;
        const args: Node[] = [];
        while (!this.isOp(")")) {
          args.push(this.expr());
          if (this.isOp(",")) this.i++;
        }
        this.eat(")");
        return { k: "fn", name: t.v, args };
      }
      return { k: "field", name: t.v };
    }
    if (t.t === "op") {
      if (t.v === "@") {
        this.i++;
        return { k: "current" };
      }
      if (t.v === "(") {
        this.i++;
        const e = this.expr();
        this.eat(")");
        return e;
      }
      if (t.v === "{") return this.hash();
      if (t.v === "[") {
        // [a, b] multiselect list at the start of an expression, or an index on @.
        const next = this.toks[this.i + 1];
        if (next && (next.t === "num" || (next.t === "op" && next.v === "*"))) return { k: "current" };
        this.i++;
        const items: Node[] = [];
        while (!this.isOp("]")) {
          items.push(this.expr());
          if (this.isOp(",")) this.i++;
        }
        this.eat("]");
        return { k: "list", items };
      }
      if (t.v === "[]" || t.v === "[?") return { k: "current" };
    }
    throw new UsageError(`Bad value for --query ${this.src}`);
  }
  hash(): Node {
    this.eat("{");
    const items: [string, Node][] = [];
    while (!this.isOp("}")) {
      const key = this.peek();
      if (key?.t !== "id") throw new UsageError(`Bad value for --query ${this.src}: expected a key name`);
      this.i++;
      this.eat(":");
      items.push([key.v, this.expr()]);
      if (this.isOp(",")) this.i++;
    }
    this.eat("}");
    return { k: "hash", items };
  }
  /** Postfix: .field, [n], [], [*], [?cond], .{...}, then projections apply the rest to each element. */
  chain(l: Node): Node {
    for (;;) {
      if (this.isOp(".")) {
        this.i++;
        if (this.isOp("{")) l = { k: "sub", l, r: this.hash() };
        else {
          const t = this.peek();
          if (t?.t !== "id") throw new UsageError(`Bad value for --query ${this.src}`);
          this.i++;
          l = { k: "sub", l, r: { k: "field", name: t.v } };
        }
        continue;
      }
      if (this.isOp("[]")) {
        this.i++;
        return { k: "project", l, r: this.chain({ k: "current" }), flatten: true };
      }
      if (this.isOp("[?")) {
        this.i++;
        const cond = this.expr();
        this.eat("]");
        return { k: "filter", l, cond, r: this.chain({ k: "current" }) };
      }
      if (this.isOp("[")) {
        const next = this.toks[this.i + 1];
        if (next?.t === "op" && next.v === "*") {
          this.i += 2;
          this.eat("]");
          return { k: "project", l, r: this.chain({ k: "current" }), flatten: false };
        }
        if (next?.t === "num") {
          this.i += 2;
          this.eat("]");
          l = { k: "index", l, i: next.v };
          continue;
        }
        return l;
      }
      return l;
    }
  }
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

function evaluate(n: Node, v: unknown): unknown {
  switch (n.k) {
    case "current":
      return v;
    case "field":
      return v && typeof v === "object" && !Array.isArray(v) ? ((v as Record<string, unknown>)[n.name] ?? null) : null;
    case "sub": {
      const l = evaluate(n.l, v);
      return l === null ? null : evaluate(n.r, l);
    }
    case "index": {
      const l = evaluate(n.l, v);
      if (!Array.isArray(l)) return null;
      return l[n.i < 0 ? l.length + n.i : n.i] ?? null;
    }
    case "project": {
      let l = evaluate(n.l, v);
      if (n.flatten && Array.isArray(l)) l = l.flatMap((x) => (Array.isArray(x) ? x : [x]));
      if (!n.flatten && l && typeof l === "object" && !Array.isArray(l)) l = Object.values(l as object);
      if (!Array.isArray(l)) return null;
      return l.map((x) => evaluate(n.r, x)).filter((x) => x !== null);
    }
    case "filter": {
      const l = evaluate(n.l, v);
      if (!Array.isArray(l)) return null;
      return l.filter((x) => truthy(evaluate(n.cond, x))).map((x) => evaluate(n.r, x)).filter((x) => x !== null);
    }
    case "hash":
      return v === null ? null : Object.fromEntries(n.items.map(([k, e]) => [k, evaluate(e, v)]));
    case "list":
      return v === null ? null : n.items.map((e) => evaluate(e, v));
    case "lit":
      return n.v;
    case "cmp": {
      const a = evaluate(n.l, v);
      const b = evaluate(n.r, v);
      switch (n.op) {
        case "==":
          return JSON.stringify(a) === JSON.stringify(b);
        case "!=":
          return JSON.stringify(a) !== JSON.stringify(b);
        case "<":
          return (a as number) < (b as number);
        case "<=":
          return (a as number) <= (b as number);
        case ">":
          return (a as number) > (b as number);
        default:
          return (a as number) >= (b as number);
      }
    }
    case "and":
      return truthy(evaluate(n.l, v)) ? evaluate(n.r, v) : evaluate(n.l, v);
    case "or":
      return truthy(evaluate(n.l, v)) ? evaluate(n.l, v) : evaluate(n.r, v);
    case "not":
      return !truthy(evaluate(n.e, v));
    case "fn": {
      const args = n.args.map((a) => evaluate(a, v));
      switch (n.name) {
        case "length":
          return Array.isArray(args[0]) || typeof args[0] === "string" ? (args[0] as string).length : args[0] && typeof args[0] === "object" ? Object.keys(args[0] as object).length : null;
        case "contains":
          return Array.isArray(args[0]) ? args[0].some((x) => JSON.stringify(x) === JSON.stringify(args[1])) : typeof args[0] === "string" && args[0].includes(String(args[1]));
        case "starts_with":
          return typeof args[0] === "string" && args[0].startsWith(String(args[1]));
        case "keys":
          return args[0] && typeof args[0] === "object" ? Object.keys(args[0] as object) : null;
        case "sort":
          return Array.isArray(args[0]) ? [...args[0]].sort() : null;
        case "to_string":
          return typeof args[0] === "string" ? args[0] : JSON.stringify(args[0]);
        default:
          throw new UsageError(`Bad value for --query: unknown function ${n.name}()`);
      }
    }
  }
}

export function jmes(data: unknown, query: string): unknown {
  const p = new Parser(lex(query), query);
  const node = p.expr();
  if (p.i < (p as unknown as { toks: Tok[] }).toks.length) throw new UsageError(`Bad value for --query ${query}`);
  return evaluate(node, data);
}
