import { runAws, type Io, type Service } from "./cli";
import { DYNAMODB_SERVICES, marshallItem, unmarshallItem } from "./dynamodb";
import { decide, principalForProfile } from "./iam-eval";
import { IAM_SERVICES } from "./iam";
import { jmes } from "./jmes";
import { apigwService, createRuntime, DDB_CONVERT, httpToApi, isZip, lambdaService, logsService, makeZip, pump, readZip } from "./lambda";
import { MESSAGING_SERVICES } from "./messaging";
import { presign, publicCanRead, S3_SERVICES, signature } from "./s3";
import { ACCOUNT_ID, HOME, md5, now, REGION, type AwsState } from "./state";

DDB_CONVERT.marshallItem = marshallItem as never;
DDB_CONVERT.unmarshallItem = unmarshallItem as never;

export interface Chunk {
  text: string;
  stream: "out" | "err";
}

export interface ExecResult {
  chunks: Chunk[];
  code: number;
  /** The terminal should clear its screen. */
  clear?: boolean;
  /** Open this file in the editor. */
  edit?: string;
}

class ShellError extends Error {}

/* ------------------------------------------------------------------ */
/* Tokenizing                                                          */
/* ------------------------------------------------------------------ */

interface Word {
  text: string;
  /** False when any part was quoted: such words are never split or treated as operators. */
  bare: boolean;
}

/** Split a line on ;, &&, || at the top level (outside quotes and $( )). */
function splitList(line: string): { cmd: string; op: string }[] {
  const out: { cmd: string; op: string }[] = [];
  let cur = "";
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      cur += c + line[++i];
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      depth++;
      cur += "$(";
      i++;
      continue;
    }
    if (c === ")" && depth > 0) {
      depth--;
      cur += c;
      continue;
    }
    if (depth === 0 && (line.startsWith("&&", i) || line.startsWith("||", i))) {
      out.push({ cmd: cur, op: line.slice(i, i + 2) });
      cur = "";
      i++;
      continue;
    }
    if (depth === 0 && c === ";") {
      out.push({ cmd: cur, op: ";" });
      cur = "";
      continue;
    }
    if (depth === 0 && c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break; // comment
    cur += c;
  }
  if (q) throw new ShellError(`bash: unexpected EOF while looking for matching \`${q}'`);
  out.push({ cmd: cur, op: "" });
  return out.filter((x) => x.cmd.trim().length > 0);
}

/** Split one command on | (outside quotes). */
function splitPipes(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    if (c === "$" && cmd[i + 1] === "(") depth++;
    if (c === ")" && depth > 0) depth--;
    if (c === "|" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/* ------------------------------------------------------------------ */
/* The lab account                                                     */
/* ------------------------------------------------------------------ */

export class AwsLab {
  services: Record<string, Service>;
  rt: ReturnType<typeof createRuntime>;
  lastCode = 0;

  constructor(public state: AwsState) {
    this.rt = createRuntime(
      () => this.services,
      () => this.io,
    );
    this.services = {
      ...S3_SERVICES,
      ...MESSAGING_SERVICES,
      ...DYNAMODB_SERVICES,
      ...IAM_SERVICES,
      lambda: lambdaService(this.rt),
      logs: logsService,
      apigatewayv2: apigwService,
    };
  }

  /* ---------------- files ---------------- */

  resolve(p: string): string {
    let path = p.startsWith("~") ? HOME + p.slice(1) : p.startsWith("/") ? p : `${this.state.cwd}/${p}`;
    const parts: string[] = [];
    for (const seg of path.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    path = "/" + parts.join("/");
    return path;
  }

  isDir(p: string): boolean {
    const abs = this.resolve(p);
    if (abs === "/" || abs === HOME || abs === "/home") return true;
    const prefix = abs.replace(/\/$/, "") + "/";
    return Object.keys(this.state.files).some((f) => f.startsWith(prefix));
  }

  io: Io = {
    readFile: (p) => {
      const abs = this.resolve(p);
      const f = this.state.files[abs];
      if (f === undefined) throw new ShellError(`${p}: No such file or directory`);
      return f;
    },
    writeFile: (p, content) => {
      const abs = this.resolve(p);
      if (this.isDir(abs) && this.state.files[abs] === undefined) throw new ShellError(`${p}: Is a directory`);
      this.state.files[abs] = content;
    },
    exists: (p) => this.state.files[this.resolve(p)] !== undefined,
    resolve: (p) => this.resolve(p),
  };

  /* ---------------- running ---------------- */

  async exec(line: string): Promise<ExecResult> {
    const result: ExecResult = { chunks: [], code: 0 };
    let list: { cmd: string; op: string }[];
    try {
      list = splitList(line.replace(/\\\n/g, " "));
    } catch (e) {
      return { chunks: [{ text: (e as Error).message + "\n", stream: "err" }], code: 2 };
    }
    let prevOp = "";
    for (const { cmd, op } of list) {
      if (prevOp === "&&" && this.lastCode !== 0) {
        prevOp = op;
        continue;
      }
      if (prevOp === "||" && this.lastCode === 0) {
        prevOp = op;
        continue;
      }
      const r = await this.pipeline(cmd);
      result.chunks.push(...r.chunks);
      if (r.clear) {
        result.clear = true;
        result.chunks = [];
      }
      if (r.edit) result.edit = r.edit;
      this.lastCode = r.code;
      result.code = r.code;
      prevOp = op;
    }
    // Anything triggered by this command (SQS -> Lambda) runs now.
    await pump(this.state, this.rt);
    return result;
  }

  /** Background work between commands: deliver queued messages to functions. */
  async tick(): Promise<boolean> {
    return pump(this.state, this.rt);
  }

  private async pipeline(cmd: string): Promise<ExecResult> {
    const stages = splitPipes(cmd);
    let input: string | null = null;
    let last: ExecResult = { chunks: [], code: 0 };
    const errs: Chunk[] = [];
    for (let i = 0; i < stages.length; i++) {
      const r = await this.simple(stages[i], input);
      const outText = r.chunks.filter((c) => c.stream === "out").map((c) => c.text).join("");
      errs.push(...r.chunks.filter((c) => c.stream === "err"));
      if (i < stages.length - 1) input = outText;
      last = { ...r, chunks: [{ text: outText, stream: "out" }] };
    }
    return { ...last, chunks: [...errs, ...last.chunks].filter((c) => c.text) };
  }

  /** Expand one simple command into words, handling quotes, $VAR, $(...) and ~. */
  private async words(src: string): Promise<{ words: Word[]; redirects: { op: string; target: string }[] }> {
    const words: Word[] = [];
    const redirects: { op: string; target: string }[] = [];
    let i = 0;
    const env = (name: string) => (name === "?" ? String(this.lastCode) : name === "HOME" ? HOME : name === "PWD" ? this.state.cwd : (this.state.env[name] ?? ""));
    const subst = async (j: number): Promise<[string, number]> => {
      // j points after "$(" ; find the matching ")"
      let depth = 1;
      let k = j;
      let q: string | null = null;
      for (; k < src.length; k++) {
        const c = src[k];
        if (q) {
          if (c === q) q = null;
          continue;
        }
        if (c === "'" || c === '"') q = c;
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) break;
      }
      if (k >= src.length) throw new ShellError("bash: unexpected EOF while looking for matching `)'");
      const inner = src.slice(j, k);
      const saved = this.lastCode;
      const r = await this.exec(inner);
      this.lastCode = r.code || saved;
      const errs = r.chunks.filter((c) => c.stream === "err").map((c) => c.text).join("");
      if (errs) this.pendingErr += errs;
      return [r.chunks.filter((c) => c.stream === "out").map((c) => c.text).join("").replace(/\n+$/, ""), k + 1];
    };
    const variable = (j: number): [string, number] => {
      if (src[j] === "{") {
        const end = src.indexOf("}", j);
        if (end < 0) throw new ShellError("bash: bad substitution");
        return [env(src.slice(j + 1, end)), end + 1];
      }
      if (src[j] === "?") return [env("?"), j + 1];
      let k = j;
      while (k < src.length && /[A-Za-z0-9_]/.test(src[k])) k++;
      if (k === j) return ["$", j];
      return [env(src.slice(j, k)), k];
    };

    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) break;
      // Redirections
      const redir = src.slice(i).match(/^(2>&1|2>>|2>|>>|>|<)/);
      if (redir) {
        i += redir[1].length;
        if (redir[1] === "2>&1") {
          redirects.push({ op: "2>&1", target: "" });
          continue;
        }
        while (/\s/.test(src[i] ?? "")) i++;
        let target = "";
        while (i < src.length && !/\s/.test(src[i])) target += src[i++];
        if (!target) throw new ShellError("bash: syntax error near unexpected token `newline'");
        redirects.push({ op: redir[1], target: target.replace(/^~/, HOME).replace(/^["']|["']$/g, "") });
        continue;
      }
      let text = "";
      let bare = true;
      let started = false;
      while (i < src.length && !/\s/.test(src[i])) {
        const c = src[i];
        if (!started && c === "~" && (src[i + 1] === undefined || src[i + 1] === "/" || /\s/.test(src[i + 1]))) {
          text += HOME;
          i++;
          started = true;
          continue;
        }
        started = true;
        if (c === "'") {
          bare = false;
          const end = src.indexOf("'", i + 1);
          if (end < 0) throw new ShellError("bash: unexpected EOF while looking for matching `''");
          text += src.slice(i + 1, end);
          i = end + 1;
        } else if (c === '"') {
          bare = false;
          i++;
          while (i < src.length && src[i] !== '"') {
            if (src[i] === "\\" && '"\\$`'.includes(src[i + 1] ?? "")) {
              text += src[i + 1];
              i += 2;
            } else if (src[i] === "$" && src[i + 1] === "(") {
              const [v, n] = await subst(i + 2);
              text += v;
              i = n;
            } else if (src[i] === "$") {
              const [v, n] = variable(i + 1);
              text += v;
              i = n;
            } else text += src[i++];
          }
          if (src[i] !== '"') throw new ShellError('bash: unexpected EOF while looking for matching `"\'');
          i++;
        } else if (c === "\\") {
          text += src[i + 1] ?? "";
          i += 2;
          bare = false;
        } else if (c === "$" && src[i + 1] === "(") {
          const [v, n] = await subst(i + 2);
          i = n;
          // Unquoted substitution splits on whitespace.
          const parts = v.split(/\s+/).filter(Boolean);
          if (parts.length > 1) {
            text += parts[0];
            words.push({ text, bare });
            for (const p of parts.slice(1, -1)) words.push({ text: p, bare: true });
            text = parts[parts.length - 1];
          } else text += v;
        } else if (c === "$") {
          const [v, n] = variable(i + 1);
          text += v;
          i = n;
        } else if (c === ">" || c === "<") break;
        else text += src[i++];
      }
      words.push({ text, bare });
    }
    return { words, redirects };
  }

  pendingErr = "";

  private async simple(src: string, stdin: string | null): Promise<ExecResult> {
    this.pendingErr = "";
    let parsed: Awaited<ReturnType<AwsLab["words"]>>;
    try {
      parsed = await this.words(src);
    } catch (e) {
      if (e instanceof ShellError) return { chunks: [{ text: e.message + "\n", stream: "err" }], code: 2 };
      throw e;
    }
    const { words, redirects } = parsed;
    const pre: Chunk[] = this.pendingErr ? [{ text: this.pendingErr, stream: "err" }] : [];
    if (!words.length) return { chunks: pre, code: 0 };

    // NAME=value with no command sets a shell variable.
    const assign = words[0].text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (assign && words.length === 1) {
      this.state.env[assign[1]] = assign[2];
      return { chunks: pre, code: 0 };
    }

    let r: ExecResult;
    try {
      r = await this.builtin(words.map((w) => w.text), stdin);
    } catch (e) {
      if (e instanceof ShellError) r = { chunks: [{ text: `${words[0].text}: ${e.message}\n`, stream: "err" }], code: 1 };
      else r = { chunks: [{ text: `${words[0].text}: ${e instanceof Error ? e.message : String(e)}\n`, stream: "err" }], code: 1 };
    }

    // Apply redirections.
    let chunks = r.chunks;
    const mergeErr = redirects.some((x) => x.op === "2>&1");
    for (const rd of redirects) {
      if (rd.op === "2>&1") continue;
      const stream = rd.op.startsWith("2") ? "err" : "out";
      const take = chunks.filter((c) => c.stream === stream || (mergeErr && stream === "out" && c.stream === "err"));
      chunks = chunks.filter((c) => !take.includes(c));
      if (rd.target === "/dev/null") continue;
      const content = take.map((c) => c.text).join("");
      try {
        const prev = rd.op.endsWith(">>") && this.io.exists(rd.target) ? this.io.readFile(rd.target) : "";
        this.io.writeFile(rd.target, prev + content);
      } catch (e) {
        chunks.push({ text: `bash: ${(e as Error).message}\n`, stream: "err" });
      }
    }
    return { ...r, chunks: [...pre, ...chunks] };
  }

  /* ---------------- commands ---------------- */

  private async builtin(argv: string[], stdin: string | null): Promise<ExecResult> {
    const [cmd, ...args] = argv;
    const out = (text: string, code = 0): ExecResult => ({ chunks: text ? [{ text, stream: "out" }] : [], code });
    const err = (text: string, code = 1): ExecResult => ({ chunks: [{ text, stream: "err" }], code });
    const flags = new Set(args.filter((a) => /^-[a-zA-Z]+$/.test(a)).flatMap((a) => a.slice(1).split("")));
    const plain = args.filter((a) => !/^-[a-zA-Z]+$/.test(a));

    switch (cmd) {
      case "aws": {
        const r = await runAws(args, this.state, this.services, this.io, this.rt, principalForProfile);
        return { chunks: [...(r.stdout ? [{ text: r.stdout, stream: "out" as const }] : []), ...(r.stderr ? [{ text: r.stderr, stream: "err" as const }] : [])], code: r.code };
      }
      case "echo": {
        let a = args;
        let newline = true;
        let escapes = false;
        while (a[0] === "-n" || a[0] === "-e") {
          if (a[0] === "-n") newline = false;
          else escapes = true;
          a = a.slice(1);
        }
        let s = a.join(" ");
        if (escapes) s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        return out(s + (newline ? "\n" : ""));
      }
      case "printf": {
        const [fmt = "", ...rest] = args;
        let k = 0;
        return out(fmt.replace(/%s/g, () => rest[k++] ?? "").replace(/\\n/g, "\n").replace(/\\t/g, "\t"));
      }
      case "cat": {
        if (!plain.length) return out(stdin ?? "");
        let s = "";
        for (const f of plain) {
          if (this.isDir(f) && !this.io.exists(f)) return err(`cat: ${f}: Is a directory\n`);
          if (!this.io.exists(f)) return err(`cat: ${f}: No such file or directory\n`);
          const content = this.io.readFile(f);
          s += isZip(content) ? "PK\u0003\u0004\u0014\u0000\u0000\u0000\b\u0000(binary zip data)\n" : content;
        }
        return out(s);
      }
      case "ls": {
        const target = this.resolve(plain[0] ?? ".");
        if (this.state.files[target] !== undefined) return out(plain[0] + "\n");
        if (!this.isDir(target)) return err(`ls: cannot access '${plain[0]}': No such file or directory\n`, 2);
        const prefix = target === "/" ? "/" : target + "/";
        const names = new Map<string, boolean>();
        for (const f of Object.keys(this.state.files)) {
          if (!f.startsWith(prefix)) continue;
          const rest = f.slice(prefix.length);
          if (!rest) continue;
          const slash = rest.indexOf("/");
          if (slash >= 0) names.set(rest.slice(0, slash) + "/", true);
          else names.set(rest, false);
        }
        const list = [...names.keys()].filter((n) => flags.has("a") || !n.startsWith(".")).sort();
        if (flags.has("l")) {
          return out(
            list
              .map((n) => {
                const f = this.state.files[prefix + n];
                const size = f === undefined ? 4096 : new TextEncoder().encode(f).length;
                return `${n.endsWith("/") ? "drwxr-xr-x" : "-rw-r--r--"} 1 you you ${String(size).padStart(6)} ${n.replace(/\/$/, "")}`;
              })
              .join("\n") + (list.length ? "\n" : ""),
          );
        }
        return out(list.length ? list.join("  ") + "\n" : "");
      }
      case "pwd":
        return out(this.state.cwd + "\n");
      case "cd": {
        const target = this.resolve(plain[0] ?? "~");
        if (!this.isDir(target)) return err(`bash: cd: ${plain[0]}: No such file or directory\n`);
        this.state.cwd = target;
        return out("");
      }
      case "mkdir": {
        for (const d of plain) this.state.files[this.resolve(d) + "/.keep"] = "";
        return out("");
      }
      case "touch": {
        for (const f of plain) if (!this.io.exists(f)) this.io.writeFile(f, "");
        return out("");
      }
      case "rm": {
        for (const f of plain) {
          const abs = this.resolve(f);
          if (this.state.files[abs] !== undefined) delete this.state.files[abs];
          else if (this.isDir(abs)) {
            if (!flags.has("r") && !flags.has("R")) return err(`rm: cannot remove '${f}': Is a directory\n`);
            for (const k of Object.keys(this.state.files)) if (k.startsWith(abs + "/")) delete this.state.files[k];
          } else if (!flags.has("f")) return err(`rm: cannot remove '${f}': No such file or directory\n`);
        }
        return out("");
      }
      case "cp":
      case "mv": {
        const [src, dst] = plain;
        if (!src || !dst) return err(`${cmd}: missing file operand\n`);
        if (!this.io.exists(src)) return err(`${cmd}: cannot stat '${src}': No such file or directory\n`);
        const target = this.isDir(dst) && !this.io.exists(dst) ? `${dst}/${src.split("/").pop()}` : dst;
        this.io.writeFile(target, this.io.readFile(src));
        if (cmd === "mv") delete this.state.files[this.resolve(src)];
        return out("");
      }
      case "clear":
      case "cls":
        return { chunks: [], code: 0, clear: true };
      case "sleep": {
        const s = Number(plain[0] ?? "0");
        if (!Number.isFinite(s)) return err("sleep: invalid time interval\n");
        this.state.clockOffset += s * 1000;
        return out("");
      }
      case "date":
        return out(new Date(now(this.state)).toString() + "\n");
      case "whoami":
        return out("you\n");
      case "env":
      case "printenv":
        if (plain[0]) return out((this.state.env[plain[0]] ?? "") + "\n");
        return out(Object.entries(this.state.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
      case "export": {
        for (const a of args) {
          const m = a.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
          if (m) this.state.env[m[1]] = m[2];
        }
        return out("");
      }
      case "unset":
        for (const a of args) delete this.state.env[a];
        return out("");
      case "true":
        return out("");
      case "false":
        return out("", 1);
      case "zip": {
        const [zipName, ...files] = plain;
        if (!zipName || !files.length) return err("zip error: Nothing to do! (usage: zip function.zip index.mjs)\n", 12);
        const name = zipName.endsWith(".zip") ? zipName : zipName + ".zip";
        const entries: Record<string, string> = {};
        const lines: string[] = [];
        const add = (path: string, rel: string) => {
          const content = this.io.readFile(path);
          entries[rel] = content;
          const pct = Math.max(0, Math.min(80, Math.round(100 - (100 * (content.length / 2 + 40)) / Math.max(1, content.length))));
          lines.push(`  adding: ${rel} (deflated ${pct}%)`);
        };
        for (const f of files) {
          if (this.io.exists(f)) add(f, f.replace(/^\.\//, ""));
          else if (this.isDir(f) && flags.has("r")) {
            const root = this.resolve(f);
            for (const k of Object.keys(this.state.files)) if (k.startsWith(root + "/") && !k.endsWith("/.keep")) add(k, k.slice(this.resolve(".").length + 1));
          } else return err(`\tzip warning: name not matched: ${f}\n\nzip error: Nothing to do! (${name})\n`, 12);
        }
        const existing = this.io.exists(name) ? readZip(this.io.readFile(name)) : null;
        this.io.writeFile(name, makeZip({ ...(existing ?? {}), ...entries }));
        return out((existing ? lines.map((l) => l.replace("adding", "updating")) : lines).join("\n") + "\n");
      }
      case "unzip": {
        const f = plain[0];
        if (!f || !this.io.exists(f)) return err(`unzip:  cannot find or open ${f}\n`, 9);
        const z = readZip(this.io.readFile(f));
        if (!z) return err(`  End-of-central-directory signature not found. ${f} is not a zipfile.\n`, 9);
        if (flags.has("l")) return out(Object.entries(z).map(([n, c]) => `${String(c.length).padStart(9)}  ${n}`).join("\n") + "\n");
        for (const [n, c] of Object.entries(z)) this.io.writeFile(n, c);
        return out(`Archive:  ${f}\n` + Object.keys(z).map((n) => `  inflating: ${n}`).join("\n") + "\n");
      }
      case "base64": {
        const input = plain[0] ? this.io.readFile(plain[0]) : (stdin ?? "");
        if (flags.has("d") || args.includes("--decode")) {
          try {
            return out(decodeURIComponent(escape(atob(input.replace(/\s/g, "")))));
          } catch {
            return err("base64: invalid input\n");
          }
        }
        return out(btoa(unescape(encodeURIComponent(input))) + "\n");
      }
      case "grep": {
        const pattern = plain[0] ?? "";
        const input = plain[1] ? this.io.readFile(plain[1]) : (stdin ?? "");
        const re = new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), flags.has("i") ? "i" : "");
        const lines = input.split("\n").filter((l) => (flags.has("v") ? !re.test(l) : re.test(l)) && l !== "");
        return out(lines.length ? lines.join("\n") + "\n" : "", lines.length ? 0 : 1);
      }
      case "head":
      case "tail": {
        const nIdx = args.indexOf("-n");
        const n = nIdx >= 0 ? Number(args[nIdx + 1]) : 10;
        const file = plain.find((p) => !/^\d+$/.test(p));
        const input = file ? this.io.readFile(file) : (stdin ?? "");
        const lines = input.replace(/\n$/, "").split("\n");
        const sel = cmd === "head" ? lines.slice(0, n) : lines.slice(-n);
        return out(sel.join("\n") + "\n");
      }
      case "wc": {
        const input = plain[0] ? this.io.readFile(plain[0]) : (stdin ?? "");
        const lines = input ? input.replace(/\n$/, "").split("\n").length : 0;
        return out(flags.has("l") ? `${lines}\n` : `${lines} ${input.split(/\s+/).filter(Boolean).length} ${input.length}\n`);
      }
      case "jq": {
        const raw = flags.has("r");
        const filter = plain[0] ?? ".";
        const input = plain[1] ? this.io.readFile(plain[1]) : (stdin ?? "");
        let data: unknown;
        try {
          data = JSON.parse(input);
        } catch {
          return err("jq: error (at <stdin>:0): Cannot parse input as JSON\n", 2);
        }
        const q = filter === "." ? "@" : filter.replace(/^\./, "").replace(/\.\[/g, "[").replace(/^\[\]/, "[]");
        let v: unknown;
        try {
          v = q === "@" ? data : jmes(data, q);
        } catch {
          return err(`jq: error: this lab's jq understands paths like .Items[0].name or .Functions[].FunctionName\n`, 3);
        }
        const show = (x: unknown) => (raw && typeof x === "string" ? x : JSON.stringify(x, null, 2));
        if (filter.includes("[]") && Array.isArray(v)) return out(v.map(show).join("\n") + "\n");
        return out(show(v ?? null) + "\n");
      }
      case "edit":
      case "nano":
      case "vim":
      case "vi":
      case "code":
      case "notepad": {
        const f = plain[0];
        if (!f) return err(`usage: ${cmd} <file>\n`);
        if (!this.io.exists(f)) this.io.writeFile(f, "");
        return { chunks: [{ text: `Opened ${f} in the Files tab.\n`, stream: "out" }], code: 0, edit: this.resolve(f) };
      }
      case "curl":
        return this.curl(args);
      case "help":
        return out(HELP);
      case "history":
        return out("");
      case "python":
      case "python3":
      case "node":
      case "npm":
      case "pip":
      case "docker":
      case "sudo":
      case "apt":
      case "git":
        return err(`${cmd}: not available in this lab terminal. It runs the AWS CLI and basic file commands only.\n`, 127);
      default:
        return err(`bash: ${cmd}: command not found\n`, 127);
    }
  }

  /* ---------------- curl ---------------- */

  private async curl(args: string[]): Promise<ExecResult> {
    let method = "";
    const headers: Record<string, string> = { "user-agent": "curl/8.5.0", accept: "*/*" };
    let body = "";
    let include = false;
    let output: string | null = null;
    let url = "";
    let failOnError = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-X" || a === "--request") method = args[++i];
      else if (a === "-H" || a === "--header") {
        const h = args[++i] ?? "";
        const k = h.indexOf(":");
        if (k > 0) headers[h.slice(0, k).trim().toLowerCase()] = h.slice(k + 1).trim();
      } else if (["-d", "--data", "--data-raw", "--data-binary"].includes(a)) {
        const d = args[++i] ?? "";
        body = d.startsWith("@") ? this.io.readFile(d.slice(1)) : d;
      } else if (a === "-i" || a === "--include") include = true;
      else if (a === "-o" || a === "--output") output = args[++i];
      else if (a === "-f" || a === "--fail") failOnError = true;
      else if (a.startsWith("-") && !a.startsWith("--")) {
        if (a.includes("i")) include = true;
        if (a.includes("f")) failOnError = true;
      } else if (!a.startsWith("-")) url = a;
    }
    if (!url) return { chunks: [{ text: "curl: try 'curl --help' for more information\n", stream: "err" }], code: 2 };
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    if (!method) method = body ? "POST" : "GET";
    if (body && !headers["content-type"]) headers["content-type"] = "application/x-www-form-urlencoded";
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { chunks: [{ text: `curl: (3) URL using bad/illegal format or missing URL\n`, stream: "err" }], code: 3 };
    }

    let res: { status: number; headers: Record<string, string>; body: string };
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return {
        chunks: [{ text: `curl: (7) Failed to connect to ${u.hostname} port ${u.port || 80}: Connection refused\n(Floci runs on your own computer, not inside this lab. See "Do it for real" in the lesson.)\n`, stream: "err" }],
        code: 7,
      };
    } else if (u.hostname.endsWith(`.execute-api.${REGION}.amazonaws.com`)) {
      res = await httpToApi(this.state, this.rt, method.toUpperCase(), u, headers, body);
    } else if (/\.?s3[.-]/.test(u.hostname) && u.hostname.endsWith("amazonaws.com")) {
      res = this.s3Http(method.toUpperCase(), u);
    } else {
      return { chunks: [{ text: `curl: (6) Could not resolve host: ${u.hostname}\n(This lab terminal can only reach the emulated AWS endpoints.)\n`, stream: "err" }], code: 6 };
    }
    if (failOnError && res.status >= 400) return { chunks: [{ text: `curl: (22) The requested URL returned error: ${res.status}\n`, stream: "err" }], code: 22 };
    const reason: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error", 503: "Service Unavailable" };
    const head = include ? `HTTP/2 ${res.status} ${reason[res.status] ?? ""}\n${Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n` : "";
    if (output) {
      this.io.writeFile(output, res.body);
      return { chunks: [{ text: head, stream: "out" }], code: 0 };
    }
    return { chunks: [{ text: head + res.body + (res.body.endsWith("\n") ? "" : "\n"), stream: "out" }], code: 0 };
  }

  private s3Http(method: string, u: URL): { status: number; headers: Record<string, string>; body: string } {
    const xml = (status: number, code: string, message: string, extra = "") => ({
      status,
      headers: { "content-type": "application/xml" },
      body: `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message>${extra}<RequestId>${md5(u.href).slice(0, 16).toUpperCase()}</RequestId><HostId>${btoa(md5(u.href))}</HostId></Error>`,
    });
    // Virtual-hosted style (bucket.s3.region.amazonaws.com/key) or path style (s3.region.amazonaws.com/bucket/key).
    let bucket: string;
    let key: string;
    const host = u.hostname;
    const path = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (host.startsWith("s3.") || host.startsWith("s3-")) {
      const i = path.indexOf("/");
      bucket = i < 0 ? path : path.slice(0, i);
      key = i < 0 ? "" : path.slice(i + 1);
    } else {
      bucket = host.split(".s3")[0];
      key = path;
    }
    const b = this.state.s3.buckets[bucket];
    if (!b) return xml(404, "NoSuchBucket", "The specified bucket does not exist", `<BucketName>${bucket}</BucketName>`);
    if (method !== "GET" && method !== "HEAD") return xml(403, "AccessDenied", "Access Denied");

    const sig = u.searchParams.get("X-Amz-Signature");
    if (sig) {
      const date = u.searchParams.get("X-Amz-Date") ?? "";
      const expires = Number(u.searchParams.get("X-Amz-Expires") ?? "0");
      const signer = Object.keys(this.state.iam.users).find((name) => signature(bucket, key, date, expires, name) === sig);
      if (!signer) return xml(403, "SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided. Check your key and signing method.");
      const issued = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15));
      if (now(this.state) > issued + expires * 1000) {
        return xml(403, "AccessDenied", "Request has expired", `<X-Amz-Expires>${expires}</X-Amz-Expires><Expires>${new Date(issued + expires * 1000).toISOString()}</Expires><ServerTime>${new Date(now(this.state)).toISOString()}</ServerTime>`);
      }
      // A presigned URL carries the signer's permissions, checked when it's used.
      if (decide(this.state, { kind: "user", name: signer, arn: `arn:aws:iam::${ACCOUNT_ID}:user/${signer}` }, "s3:GetObject", `arn:aws:s3:::${bucket}/${key}`) !== "allow") {
        return xml(403, "AccessDenied", "Access Denied");
      }
    } else if (!publicCanRead(b, key)) {
      return xml(403, "AccessDenied", "Access Denied");
    }
    const o = b.objects[key];
    if (!o) return xml(404, "NoSuchKey", "The specified key does not exist.", `<Key>${key}</Key>`);
    return {
      status: 200,
      headers: { "content-type": o.contentType, "content-length": String(o.size), etag: o.etag, "last-modified": new Date(o.lastModified).toUTCString(), server: "AmazonS3" },
      body: method === "HEAD" ? "" : o.body,
    };
  }

  /** For tests and labs: a presigned URL as a given user. */
  presign(bucket: string, key: string, expires: number, user = "you"): string {
    return presign(this.state, bucket, key, expires, user);
  }
}

const HELP = `This is a practice terminal with the AWS CLI and a few everyday commands.

  aws <service> <command> ...   talk to the emulated AWS account (try: aws help)
  ls, cd, pwd, cat, echo, mkdir, touch, rm, cp, mv     work with files in your home folder
  edit <file>                   open a file in the editor (Files tab)
  zip out.zip file...           package code for Lambda
  curl <url>                    call an S3 URL or an API Gateway endpoint
  jq, grep, head, tail, wc, base64   reshape output (use with |)
  sleep <seconds>               move the clock forward (instantly)
  clear                         clear the screen

Shell features: NAME=value, $NAME, $(command), &&, ||, ;, |, > and >>.
Up and down arrows bring back earlier commands; Tab completes AWS commands.
`;
