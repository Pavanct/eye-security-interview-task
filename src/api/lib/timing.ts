import { setTimeout as delay } from "node:timers/promises";

// Resolves false if aborted instead of throwing, so that a client disconnect is a
// normal outcome for callers and not an exception to catch at every wait.
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<boolean>;

export const sleep: Sleep = async (ms, signal) => {
  try {
    await delay(ms, undefined, signal ? { signal } : {});
    return true;
  } catch {
    return false;
  }
};
