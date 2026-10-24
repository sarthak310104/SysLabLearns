/**
 * Seeded pseudo-random generator (mulberry32).
 * The same seed always produces the same sequence, so every run can be replayed.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Exponential sample with the given mean. */
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  /**
   * Erlang-2 sample with the given mean: less variable than exponential,
   * closer to how real service times behave.
   */
  erlang2(mean: number): number {
    return (this.exp(mean) + this.exp(mean)) / 2;
  }
}
