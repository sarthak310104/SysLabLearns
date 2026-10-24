/**
 * Sliding window of completed requests, used to compute
 * throughput, error rate and latency percentiles over the last N ms.
 */
export class Window {
  private times: number[] = [];
  private lats: number[] = [];
  private oks: boolean[] = [];
  private head = 0;

  constructor(private spanMs = 1000) {}

  add(time: number, latency: number, ok: boolean): void {
    this.times.push(time);
    this.lats.push(latency);
    this.oks.push(ok);
  }

  prune(now: number): void {
    const cutoff = now - this.spanMs;
    while (this.head < this.times.length && this.times[this.head] < cutoff) this.head++;
    if (this.head > 4096 && this.head > this.times.length / 2) {
      this.times = this.times.slice(this.head);
      this.lats = this.lats.slice(this.head);
      this.oks = this.oks.slice(this.head);
      this.head = 0;
    }
  }

  stats(now: number) {
    this.prune(now);
    const okLats: number[] = [];
    let errors = 0;
    for (let i = this.head; i < this.times.length; i++) {
      if (this.oks[i]) okLats.push(this.lats[i]);
      else errors++;
    }
    okLats.sort((a, b) => a - b);
    const pick = (q: number) =>
      okLats.length ? okLats[Math.min(okLats.length - 1, Math.floor(q * okLats.length))] : 0;
    const perSec = 1000 / this.spanMs;
    const total = okLats.length + errors;
    return {
      okPerSec: okLats.length * perSec,
      errorsPerSec: errors * perSec,
      errorRate: total ? errors / total : 0,
      p50: pick(0.5),
      p99: pick(0.99),
    };
  }

  clear(): void {
    this.times = [];
    this.lats = [];
    this.oks = [];
    this.head = 0;
  }
}
