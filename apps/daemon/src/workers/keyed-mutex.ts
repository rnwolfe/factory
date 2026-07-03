/**
 * In-process mutex keyed by an arbitrary string. The daemon is a single
 * process, so a per-key promise chain is enough to serialize a check-then-act
 * sequence — no DB locking needed. Used to close the auto-advance double-submit
 * race in `post-merge.ts`: two runs on the same project finalizing concurrently
 * would both observe "no other active runs" and both submit the same next task.
 *
 * Each key maps to the tail of a promise chain. `run(key, fn)` appends `fn` to
 * that key's chain, so callers with the same key execute one at a time, in
 * arrival order. Different keys never contend. The map entry is cleaned up once
 * a key's chain fully drains, so it doesn't grow without bound.
 */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>();

  /**
   * Run `fn` while holding `key`'s lock. Resolves/rejects with `fn`'s result.
   * A rejection does not poison the chain — the next waiter still runs.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // Chain off the prior tail, swallowing its outcome so one caller's error
    // doesn't reject the next caller's turn.
    const result = prev.then(
      () => fn(),
      () => fn(),
    );
    // The chain tail tracks completion (success or failure) so ordering holds.
    const tail = result.then(
      () => {},
      () => {},
    );
    this.chains.set(key, tail);
    // Once this tail drains, drop the key if nothing newer replaced it.
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return result;
  }
}
