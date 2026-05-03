/**
 * Tracks live run AbortControllers so the daemon can cancel runs by ID.
 */
export class RunRegistry {
  private map = new Map<string, AbortController>();

  register(runId: string, ac: AbortController): void {
    this.map.set(runId, ac);
  }

  unregister(runId: string): void {
    this.map.delete(runId);
  }

  abort(runId: string): boolean {
    const ac = this.map.get(runId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  abortAll(): void {
    for (const ac of this.map.values()) ac.abort();
    this.map.clear();
  }

  active(): string[] {
    return Array.from(this.map.keys());
  }
}
