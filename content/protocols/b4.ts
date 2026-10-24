import type { Handlers, ProtocolSpec, World } from "@/engine/protocol/types";

/*
 * B4: single-decree Paxos.
 *
 * Two proposers each want their own value chosen; three acceptors vote. A
 * proposer calls ctx.reply(value) when it learns which value was chosen.
 * Safety: nobody ever decides two different values, and whatever is decided
 * was actually proposed.
 */

function need(user: Record<string, unknown>, name: string): Handlers {
  const h = user[name];
  if (!h || typeof h !== "object") throw new Error(`Your code needs to export \`${name}\`: an object with the ${name}'s handlers.`);
  return h as Handlers;
}

const decisions = (w: World) => w.history.filter((e) => e.kind === "ok");

/**
 * A value is chosen once a majority of acceptors accept it in the same
 * ballot, whether or not any proposer has heard yet. The lab sees this from
 * the "accepted" messages acceptors send back.
 */
function chosen(w: World): { value: unknown; ballot: unknown; by: string[] }[] {
  const votes = new Map<string, Set<string>>();
  for (const m of w.msgs) {
    const msg = m.msg as { type?: unknown; ballot?: unknown; value?: unknown } | null;
    if (!msg || msg.type !== "accepted") continue;
    const k = JSON.stringify([msg.ballot, msg.value]);
    const set = votes.get(k) ?? new Set<string>();
    set.add(m.from);
    votes.set(k, set);
  }
  const out: { value: unknown; ballot: unknown; by: string[] }[] = [];
  for (const [k, by] of votes) {
    if (by.size >= 2) {
      const [ballot, value] = JSON.parse(k) as [unknown, unknown];
      out.push({ ballot, value, by: [...by].sort() });
    }
  }
  return out;
}

export function oneValueChosen(w: World): string | null {
  const cs = chosen(w);
  for (let i = 1; i < cs.length; i++) {
    if (JSON.stringify(cs[i].value) !== JSON.stringify(cs[0].value)) {
      const say = (c: (typeof cs)[number]) => `${JSON.stringify(c.value)} (accepted by ${c.by.join(" and ")} in ballot ${JSON.stringify(c.ballot)})`;
      return `Two different values were chosen: ${say(cs[0])} and ${say(cs[i])}. Once a majority accepts a value, every later ballot must propose that same value.`;
    }
  }
  return null;
}

export function agreement(w: World): string | null {
  const ds = decisions(w);
  for (let i = 1; i < ds.length; i++) {
    if (JSON.stringify(ds[i].value) !== JSON.stringify(ds[0].value)) {
      return `${ds[0].client} decided ${JSON.stringify(ds[0].value)} but ${ds[i].client} decided ${JSON.stringify(ds[i].value)}. Two different values were chosen.`;
    }
  }
  return null;
}

export function validity(w: World): string | null {
  const proposed = new Set(w.history.filter((e) => e.kind === "invoke").map((e) => JSON.stringify((e.cmd as { value: unknown }).value)));
  for (const d of decisions(w)) {
    if (!proposed.has(JSON.stringify(d.value))) return `${d.client} decided ${JSON.stringify(d.value)}, which nobody proposed.`;
  }
  return null;
}

export const B4: ProtocolSpec = {
  id: "b4-paxos",
  nodes: [
    { id: "p1", role: "proposer", label: "Proposer 1" },
    { id: "p2", role: "proposer", label: "Proposer 2" },
    { id: "a1", role: "acceptor", label: "Acceptor 1" },
    { id: "a2", role: "acceptor", label: "Acceptor 2" },
    { id: "a3", role: "acceptor", label: "Acceptor 3" },
  ],
  roles: (user) => ({ proposer: need(user, "proposer"), acceptor: need(user, "acceptor") }),
  workload: { p1: [{ op: "propose", value: "red" }], p2: [{ op: "propose", value: "blue" }] },
  invariants: [
    { name: "Validity: only proposed values are chosen", check: validity },
    { name: "Agreement: only one value is ever chosen", check: oneValueChosen },
    { name: "Agreement: one value, decided by everyone", check: agreement },
  ],
  network: { delayMin: 1, delayMax: 10, drop: 0.1, duplicate: 0.1 },
  crashable: ["a1", "a2", "a3"],
  restart: false,
  budget: { maxDepth: 30, maxStates: 400000, crashes: 0, timers: false },
};

export const B4_STARTER = `// Single-decree Paxos: get everyone to agree on one value.
//
// Each proposer receives one command, { op: "propose", value: "red" }, and
// must call ctx.reply(value) once it knows which value was chosen. It may not
// be its own. Acceptors only ever answer proposers.
//
// This version looks plausible and often works. The model checker will find
// the ordering of messages where two different values get chosen.

const majority = 2;

export const proposer = {
  init(ctx) {
    return { value: null, round: 0, ballot: 0, promises: [], accepts: 0, decided: false };
  },

  onCommand(state, cmd, ctx) {
    state.value = cmd.value;
    startRound(state, ctx);
  },

  onMessage(state, from, msg, ctx) {
    if (state.decided || msg.ballot !== state.ballot) return;

    if (msg.type === "promise" && !state.promises.includes(from)) {
      state.promises.push(from);
      if (state.promises.length === majority) {
        // TODO: a promise may report a value that acceptor already accepted.
        // Which value should this proposer ask everyone to accept?
        for (const a of ctx.nodes("acceptor")) {
          ctx.send(a, { type: "accept", ballot: state.ballot, value: state.value });
        }
      }
    }

    if (msg.type === "accepted") {
      state.accepts += 1;
      if (state.accepts === majority) {
        state.decided = true;
        ctx.reply(msg.value);
      }
    }
  },

  onTimer(state, timer, ctx) {
    // No decision yet: try again with a higher ballot.
    if (!state.decided && timer.data === state.ballot) startRound(state, ctx);
  },
};

function startRound(state, ctx) {
  state.round += 1;
  // Ballots must be unique across proposers: round * 10 + this proposer's number.
  state.ballot = state.round * 10 + Number(ctx.self.slice(1));
  state.promises = [];
  state.accepts = 0;
  for (const a of ctx.nodes("acceptor")) ctx.send(a, { type: "prepare", ballot: state.ballot });
  ctx.setTimer("retry", 40 + ctx.random() * 40, state.ballot);
}

export const acceptor = {
  init(ctx) {
    return { promised: 0, acceptedBallot: 0, acceptedValue: null };
  },

  onMessage(state, from, msg, ctx) {
    if (msg.type === "prepare" && msg.ballot >= state.promised) {
      state.promised = msg.ballot;
      ctx.send(from, {
        type: "promise",
        ballot: msg.ballot,
        acceptedBallot: state.acceptedBallot,
        acceptedValue: state.acceptedValue,
      });
    }

    if (msg.type === "accept" && msg.ballot >= state.promised) {
      state.promised = msg.ballot;
      state.acceptedBallot = msg.ballot;
      state.acceptedValue = msg.value;
      ctx.send(from, { type: "accepted", ballot: msg.ballot, value: msg.value });
    }
  },
};
`;
