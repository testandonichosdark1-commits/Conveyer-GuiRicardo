/**
 * In-memory cancellation registry.
 *
 * When the user clicks Stop, the API adds the runId here. The pipeline checks
 * this set between stages and throws CancelledError when it sees its id.
 *
 * Lives in the dev server process memory — clears on restart, which is fine
 * for our use case (any cancelled run will already be marked `cancelled` in DB).
 */
const cancelled = new Set<string>();

export function markCancelled(runId: string) {
  cancelled.add(runId);
}

export function isCancelled(runId: string): boolean {
  return cancelled.has(runId);
}

export function clearCancelled(runId: string) {
  cancelled.delete(runId);
}

/** Throws CancelledError if the run has been flagged for cancellation. */
export function checkCancelled(runId: string): void {
  if (cancelled.has(runId)) {
    throw new CancelledError(`Run ${runId} cancelled by user`);
  }
}

export class CancelledError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CancelledError";
  }
}
