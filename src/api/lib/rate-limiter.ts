import type { Sleep } from "./timing.js";

// Allows one acquire per interval, shared by every request to this API instance,
// since the upstream limit applies to the API key and not to a single run.
//
// In-memory on purpose: running several instances would need a shared store such as
// Redis, otherwise each one would use up the same upstream budget (see ADR-2).
export class IntervalRateLimiter {
  private nextSlotAt = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
    private readonly sleep: Sleep,
  ) {}

  // Resolves true once the caller may send, or false if aborted while waiting.
  async acquire(signal?: AbortSignal): Promise<boolean> {
    // Rechecks after every wait: another caller may have taken the slot, or defer()
    // may have moved it. Claiming a slot is synchronous, so two callers on the event
    // loop can never claim the same one, and no lock is needed.
    for (;;) {
      if (signal?.aborted) return false;

      const now = this.now();
      if (now >= this.nextSlotAt) {
        this.nextSlotAt = now + this.intervalMs;
        return true;
      }
      if (!(await this.sleep(this.nextSlotAt - now, signal))) return false;
    }
  }

  // Pushes the next slot back, for when the upstream asks for more time (Retry-After).
  // It only ever extends the wait: a short hint must not shorten the configured interval.
  defer(ms: number): void {
    this.nextSlotAt = Math.max(this.nextSlotAt, this.now() + ms);
  }
}
