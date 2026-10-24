export const fmtRate = (n: number) => `${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 0 : 1)}/s`;
export const fmtMs = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
export const fmtPct = (n: number) => `${n >= 0.995 || n === 0 ? Math.round(n * 100) : (n * 100).toFixed(1)}%`;
export const fmtTime = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
