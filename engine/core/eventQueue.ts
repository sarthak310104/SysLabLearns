/**
 * Min-heap of timestamped events. Ties break by insertion order,
 * which keeps runs deterministic.
 */
export interface Scheduled<E> {
  time: number;
  seq: number;
  event: E;
}

export class EventQueue<E> {
  private heap: Scheduled<E>[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, event: E): void {
    const item = { time, seq: this.seq++, event };
    this.heap.push(item);
    this.up(this.heap.length - 1);
  }

  peekTime(): number {
    return this.heap.length ? this.heap[0].time : Infinity;
  }

  pop(): Scheduled<E> | undefined {
    const heap = this.heap;
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      this.down(0);
    }
    return top;
  }

  private less(a: Scheduled<E>, b: Scheduled<E>): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private up(i: number): void {
    const heap = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  }

  private down(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(heap[l], heap[m])) m = l;
      if (r < n && this.less(heap[r], heap[m])) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m], heap[i]];
      i = m;
    }
  }
}
