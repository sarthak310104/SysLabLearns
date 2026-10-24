/**
 * Small analytic models behind the lesson diagrams. They're approximations,
 * chosen to show the shape of an effect; the lab simulation is the ground truth.
 */

/** Probability an arriving request has to wait, in an M/M/c queue (Erlang C). */
export function erlangC(servers: number, offered: number): number {
  if (offered >= servers) return 1;
  // Erlang B by recursion, then convert to C.
  let b = 1;
  for (let k = 1; k <= servers; k++) b = (offered * b) / (k + offered * b);
  const rho = offered / servers;
  return b / (1 - rho + rho * b);
}

/**
 * Response time percentiles for c workers, each taking `serviceMs` on average,
 * with `rps` arriving. Returns Infinity past capacity.
 */
export function queueLatency(rps: number, workers: number, serviceMs: number) {
  const mu = 1000 / serviceMs; // per worker, per second
  const capacity = workers * mu;
  if (rps >= capacity) return { mean: Infinity, p99: Infinity, utilization: rps / capacity };
  const c = erlangC(workers, rps / mu);
  const drain = capacity - rps; // per second
  const meanWait = (c / drain) * 1000;
  const p99Wait = c > 0.01 ? (Math.log(c / 0.01) / drain) * 1000 : 0;
  // Service time p99 for an exponential distribution is about 4.6 x its mean.
  return { mean: serviceMs + meanWait, p99: serviceMs * Math.log(100) * 0.6 + p99Wait, utilization: rps / capacity };
}

/** Share of requests a cache of `size` answers, when key popularity follows a Zipf law. */
export function zipfHitRatio(cacheSize: number, keys: number, skew: number): number {
  const h = (n: number) => {
    let sum = 0;
    for (let k = 1; k <= n; k++) sum += 1 / k ** skew;
    return sum;
  };
  return h(Math.min(cacheSize, keys)) / h(keys);
}

/** Hit ratio for one key read `perSec` times a second, cached for `ttlSec`. */
export function ttlHitRatio(perSec: number, ttlSec: number): number {
  const x = perSec * ttlSec;
  return x / (1 + x);
}

/** Expected attempts per request with `retries` and an independent failure chance `p`. */
export function retryAmplification(p: number, retries: number, budget = 0): number {
  let total = 0;
  for (let i = 0; i <= retries; i++) total += p ** i;
  return budget > 0 ? Math.min(total, 1 + budget) : total;
}

/** Keys written on both sides of a partition lasting `seconds`: they're the conflicts. */
export function partitionConflicts(seconds: number, writesPerSecPerSide: number, keys: number): number {
  const pTouched = 1 - Math.exp((-writesPerSecPerSide * seconds) / keys);
  return keys * pTouched * pTouched;
}

/* ---------- hashing ---------- */

export function hash32(x: number): number {
  let h = Math.imul(x ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Owner of each key under "hash mod n". */
export const modOwner = (key: number, n: number) => hash32(key) % n;

/** A consistent-hash ring with `vnodes` points per shard; returns a lookup function. */
export function ring(shards: number, vnodes: number) {
  const points: { at: number; shard: number }[] = [];
  for (let s = 0; s < shards; s++) for (let v = 0; v < vnodes; v++) points.push({ at: hash32(s * 7919 + v * 104729 + 1), shard: s });
  points.sort((a, b) => a.at - b.at);
  const owner = (key: number) => {
    const h = hash32(key);
    let lo = 0;
    let hi = points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].at < h) lo = mid + 1;
      else hi = mid;
    }
    return points[lo % points.length].shard;
  };
  return { points, owner };
}

/** Share of keys that land on a different shard when going from n to n + 1 shards. */
export function keysMoved(n: number, scheme: "mod" | "ring", sample = 20000, vnodes = 64): number {
  let moved = 0;
  if (scheme === "mod") {
    for (let k = 0; k < sample; k++) if (modOwner(k, n) !== modOwner(k, n + 1)) moved++;
  } else {
    const a = ring(n, vnodes);
    const b = ring(n + 1, vnodes);
    for (let k = 0; k < sample; k++) if (a.owner(k) !== b.owner(k)) moved++;
  }
  return moved / sample;
}
