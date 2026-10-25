// Tracks requests sent to a client and resolves them from the matching
// response (or a timeout). One instance per request channel (permissions,
// local tool execution).

interface Entry<T> {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
}

export class PendingMap<T> {
  private seq = 0;
  private entries = new Map<string, Entry<T>>();

  constructor(private readonly prefix: string) {}

  nextId(): string {
    return `${this.prefix}${++this.seq}`;
  }

  /** Register the request; resolves with `timeoutValue` if no answer arrives. */
  request(id: string, timeoutMs: number, timeoutValue: T): Promise<T> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.entries.delete(id);
        resolve(timeoutValue);
      }, timeoutMs);
      this.entries.set(id, { resolve, timer });
    });
  }

  /** Deliver the client's answer; returns false for unknown/expired requests. */
  settle(id: string, value: T): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(value);
    return true;
  }

  /** Resolve everything still pending (e.g. the session is being disposed). */
  failAll(value: T): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timer);
      entry.resolve(value);
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
