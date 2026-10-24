import type { Handlers, ProtocolSpec, World } from "@/engine/protocol/types";

/*
 * B0: a warm-up. Two clients (written by the lab) send words to a server
 * (written by you). Stage 1: reply with the word in capitals. Stage 2: also
 * number each client's requests, which needs the server to remember things.
 */

interface Cmd {
  op: "shout";
  text: string;
}

const client: Handlers = {
  init: () => ({ seq: 0 }),
  onCommand(s: { seq: number }, cmd: Cmd, ctx) {
    s.seq++;
    ctx.send("server", { type: "request", seq: s.seq, text: cmd.text });
  },
  onMessage(s: { seq: number }, _from, msg, ctx) {
    if (msg?.type === "reply" && msg.seq === s.seq) ctx.reply(msg.result);
  },
};

function need(user: Record<string, unknown>): Handlers {
  const h = user.server;
  if (!h || typeof h !== "object") throw new Error("Your code needs to export `server`: an object with the server's handlers.");
  return h as Handlers;
}

const ok = (w: World) => w.history.filter((e) => e.kind === "ok");

export function capitals(w: World): string | null {
  for (const e of ok(w)) {
    const want = (e.cmd as Cmd).text.toUpperCase();
    if (typeof e.value !== "string" || !e.value.endsWith(want)) {
      return `${e.client} sent "${(e.cmd as Cmd).text}" and got back ${JSON.stringify(e.value)}. The reply should contain "${want}".`;
    }
  }
  return null;
}

export function numbered(w: World): string | null {
  const counts: Record<string, number> = {};
  for (const e of ok(w)) {
    counts[e.client] = (counts[e.client] ?? 0) + 1;
    const want = `${counts[e.client]}: ${(e.cmd as Cmd).text.toUpperCase()}`;
    if (e.value !== want) {
      return `${e.client}'s request number ${counts[e.client]} got back ${JSON.stringify(e.value)}, but it should be "${want}". Count each client separately.`;
    }
  }
  return null;
}

const shout = (words: string[]) => words.map((text) => ({ op: "shout", text }));

export const B0: ProtocolSpec = {
  id: "b0-warmup",
  nodes: [
    { id: "c1", role: "client", label: "Client 1" },
    { id: "c2", role: "client", label: "Client 2" },
    { id: "server", role: "server", label: "Server" },
  ],
  roles: (user) => ({ client, server: need(user) }),
  workload: { c1: shout(["hello", "world", "again"]), c2: shout(["ping", "pong"]) },
  checkerWorkload: { c1: shout(["hi", "yo"]), c2: shout(["ok"]) },
  invariants: [
    { name: "Replies are in capitals", check: capitals },
    { name: "Each client's replies are numbered 1, 2, 3...", check: numbered },
  ],
  network: { delayMin: 1, delayMax: 10, drop: 0, duplicate: 0 },
  budget: { maxDepth: 14, maxStates: 50000, crashes: 0, timers: false },
};

export const B0_STARTER = `// Your first protocol: a server that answers messages.
//
// Two clients send the server messages like this:
//   { type: "request", seq: 1, text: "hello" }
// The server must answer each one by sending back:
//   { type: "reply", seq: <the same seq>, result: <your answer> }
//
// A node is an object with handler functions. The lab calls them:
//   init(ctx)                         when the node starts: return its first state
//   onMessage(state, from, msg, ctx)  when a message arrives
//
// \`state\` is this node's memory: change it and it stays changed.
// \`from\` is who sent the message ("c1" or "c2").
// \`ctx.send(to, message)\` sends a message to another node.

export const server = {
  init(ctx) {
    return {};
  },

  onMessage(state, from, msg, ctx) {
    if (msg.type === "request") {
      ctx.log("got " + msg.text + " from " + from);
      // TODO: reply to \`from\` with the text in capitals.
      // Hint: "abc".toUpperCase() is "ABC".
    }
  },
};
`;
