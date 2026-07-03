/**
 * Bounded async work pool. Tasks are submitted as `() => Promise<void>` and
 * scheduled at most `concurrency` at a time. Submission is non-blocking; the
 * returned promise resolves when the underlying task finishes.
 */
export class WorkerPool {
  private active = 0;
  private queue: Array<() => void> = [];
  private inflight = new Set<Promise<void>>();
  private draining = false;

  constructor(public concurrency: number) {}

  /**
   * Submit a task. Resolves when the task finishes (success or failure).
   *
   * `opts.label` (typically a runId) is only used to attribute a thrown error
   * in the logs. Normal task failures self-report inside `executeRun`; this
   * catch is a backstop for a throw *before* a run's own error handling begins
   * (in the submit wrapper itself) — without the log it would vanish silently.
   */
  submit(task: () => Promise<void>, opts?: { label?: string }): Promise<void> {
    if (this.draining) return Promise.reject(new Error("pool is draining"));
    return new Promise<void>((resolve) => {
      const run = async () => {
        this.active++;
        try {
          await task();
        } catch (err) {
          // Task-level failures are surfaced inside the task (executeRun
          // self-reports). Anything reaching here threw before that handling
          // began — log it so it isn't swallowed, but never rethrow: the pool
          // loop must survive and keep draining the queue.
          console.error(
            `[pool] task${opts?.label ? ` ${opts.label}` : ""} threw before its own error handling`,
            err,
          );
        } finally {
          this.active--;
          this.next();
          resolve();
        }
      };
      const wrapped = () => {
        const p = run();
        this.inflight.add(p);
        p.finally(() => this.inflight.delete(p));
      };

      if (this.active < this.concurrency) {
        wrapped();
      } else {
        this.queue.push(wrapped);
      }
    });
  }

  private next() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const fn = this.queue.shift();
      if (fn) fn();
    }
  }

  size(): { active: number; queued: number } {
    return { active: this.active, queued: this.queue.length };
  }

  /** Stop accepting new tasks, await currently in-flight ones. */
  async drain(): Promise<void> {
    this.draining = true;
    this.queue.length = 0;
    await Promise.allSettled([...this.inflight]);
  }
}
