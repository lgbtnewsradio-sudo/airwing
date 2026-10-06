export class AdaptiveCastBitrate {
  private current: number;
  private lastChange = -Infinity;
  private goodSince: number | null = null;
  constructor(private readonly ceiling: number, private readonly floor = 750_000) { this.current = ceiling; }
  sample(loss: number, now: number): number | null {
    if (!Number.isFinite(loss) || loss < 0 || loss > 1) return null;
    if (loss >= 0.03) {
      this.goodSince = null;
      if (now - this.lastChange < 5000) return null;
      const next = Math.max(Math.min(this.floor, this.ceiling), Math.round(this.current * 0.8));
      if (next === this.current) return null;
      this.current = next; this.lastChange = now; return next;
    }
    if (loss > 0.005) { this.goodSince = null; return null; }
    this.goodSince ??= now;
    if (now - this.goodSince < 15000 || now - this.lastChange < 5000) return null;
    const next = Math.min(this.ceiling, Math.round(this.current * 1.1));
    if (next === this.current) return null;
    this.current = next; this.lastChange = now; this.goodSince = now; return next;
  }
}
