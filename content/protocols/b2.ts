import type { Handlers, ProtocolSpec, World } from "@/engine/protocol/types";

/*
 * B2: exactly-once RPC over an unreliable network.
 *
 * Clients append strings to their own key on one server. Because each client
 * owns its key, the correct answer to its i-th append is simply the first i
 * values joined together: anything else means a request was lost, applied
 * twice, or answered with someone else's result.
 */

interface AppendCmd {
  op: "append";
  key: string;
  value: string;
}

const appends = (client: string, values: string[]): AppendCmd[] => values.map((value) => ({ op: "append", key: client, value }));

function need(user: Record<string, unknown>, name: string): Handlers {
  const h = user[name];
  if (!h || typeof h !== "object") throw new Error(`Your code needs to export \`${name}\`: an object with your ${name}'s handlers.`);
  return h as Handlers;
}

export function appliedOnce(w: World): string | null {
  const done = new Map<string, string[]>();
  for (const e of w.history) {
    if (e.kind !== "ok") continue;
    const cmd = e.cmd as AppendCmd;
    const vals = done.get(e.client) ?? [];
    vals.push(cmd.value);
    done.set(e.client, vals);
    const expected = vals.join("");
    if (e.value !== expected) {
      const got = JSON.stringify(e.value);
      const hint =
        typeof e.value === "string" && e.value.length > expected.length
          ? " Something was applied more than once."
          : typeof e.value === "string" && e.value.length < expected.length
            ? " An earlier append is missing."
            : "";
      return `${e.client} appended "${cmd.value}" and got back ${got}, but it should be "${expected}".${hint}`;
    }
  }
  return null;
}

export const B2: ProtocolSpec = {
  id: "b2-rpc",
  nodes: [
    { id: "client1", role: "client", label: "Client 1" },
    { id: "client2", role: "client", label: "Client 2" },
    { id: "server", role: "server", label: "Server" },
  ],
  roles: (user) => ({ client: need(user, "client"), server: need(user, "server") }),
  workload: { client1: appends("client1", ["a", "b", "c", "d"]), client2: appends("client2", ["x", "y", "z"]) },
  checkerWorkload: { client1: appends("client1", ["a", "b"]), client2: appends("client2", ["x"]) },
  invariants: [{ name: "Every append happens exactly once", check: appliedOnce }],
  network: { delayMin: 1, delayMax: 10, drop: 0.2, duplicate: 0.2 },
  budget: { maxDepth: 20, maxStates: 400000, crashes: 0 },
};

export const B2_STARTER = `// Exactly-once appends over a network that loses and repeats messages.
//
// Each client gets commands like { op: "append", key: "client1", value: "a" }
// through onCommand, sends them to the server, and must call ctx.reply(result)
// exactly once with the server's answer: the key's whole value after appending.
//
// This version works on a perfect network. Run it, then turn on losses and
// duplicates and see what breaks.

export const client = {
  init(ctx) {
    return { waiting: false };
  },

  onCommand(state, cmd, ctx) {
    const server = ctx.nodes("server")[0];
    ctx.send(server, { type: "request", cmd });
    state.waiting = true;
  },

  onMessage(state, from, msg, ctx) {
    if (msg.type === "reply" && state.waiting) {
      state.waiting = false;
      ctx.reply(msg.result);
    }
  },

  onTimer(state, timer, ctx) {},
};

export const server = {
  init(ctx) {
    return { data: {} };
  },

  onMessage(state, from, msg, ctx) {
    if (msg.type !== "request") return;
    const { key, value } = msg.cmd;
    state.data[key] = (state.data[key] ?? "") + value;
    ctx.send(from, { type: "reply", result: state.data[key] });
  },
};
`;
