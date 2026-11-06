/** A process handles one conversation at a time. No generation retries in this queue. */
export class ImageProcessPool<T extends { close(): Promise<void> }> {
  private cells: { value: T; busy: boolean; conversations: number }[] = [];
  private waiting: (() => void)[] = [];
  private opening = 0;
  private closing = false;
  private idleTimer?: ReturnType<typeof setTimeout>;
  constructor(private connect: () => Promise<T>, private onIdle: () => Promise<void>,
    private limit = 4, private recycleAfter = 50, private idleMs = 30_000) {}
  async acquire(): Promise<{ value: T; release(broken?: boolean, conversation?: boolean): Promise<void> }> {
    if (this.closing) throw new Error("Pool encerrando. Aguarde antes de tentar recuperar.");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (;;) {
      let cell = this.cells.find(c => !c.busy);
      if (cell) cell.busy = true;
      else if (this.cells.length + this.opening < this.limit) {
        this.opening++;
        try { cell = { value: await this.connect(), busy: true, conversations: 0 }; this.cells.push(cell); }
        finally { this.opening--; this.wake(); }
      } else { await new Promise<void>(resolve => this.waiting.push(resolve)); continue; }
      const chosen = cell!; let released = false;
      return { value: chosen.value, release: async (broken = false, conversation = true) => {
        if (released) return; released = true;
        if (conversation) chosen.conversations++;
        if (broken || chosen.conversations >= this.recycleAfter) {
          // Keep the cell busy/counting towards the limit until shutdown finishes.
          try { await chosen.value.close(); }
          finally { this.cells = this.cells.filter(c => c !== chosen); }
        } else chosen.busy = false;
        this.wake();
        if (!this.opening && !this.waiting.length && this.cells.every(c => !c.busy)) {
          this.idleTimer = setTimeout(() => { void this.close().catch(() => {}); }, this.idleMs);
          this.idleTimer.unref?.();
        }
      } };
    }
  }
  private wake() { this.waiting.shift()?.(); }
  async close() {
    if (this.closing || this.opening || this.waiting.length || this.cells.some(c => c.busy)) return;
    this.closing = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try { await Promise.all(this.cells.map(c => c.value.close())); await this.onIdle(); }
    finally { this.cells = []; }
  }
}
