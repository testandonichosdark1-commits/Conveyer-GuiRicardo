import { expect, it, vi } from "vitest";
import { ImageProcessPool } from "./codex-image-pool";
it("allows four simultaneous processes, queues the fifth, reuses released cells and closes the owner last", async () => {
  let opened = 0; const closed: number[] = [];
  const ownerClose = vi.fn(async () => { expect(closed).toHaveLength(4); });
  const pool = new ImageProcessPool(async () => { const id = ++opened; return { id, close: async () => { closed.push(id); } }; }, ownerClose);
  const leases = await Promise.all(Array.from({ length: 4 }, () => pool.acquire()));
  expect(new Set(leases.map(l => l.value.id)).size).toBe(4);
  let fifthStarted = false;
  const fifth = pool.acquire().then(l => { fifthStarted = true; return l; });
  await Promise.resolve(); expect(fifthStarted).toBe(false); expect(opened).toBe(4);
  await leases[1].release(); const next = await fifth;
  expect(next.value.id).toBe(leases[1].value.id); expect(opened).toBe(4);
  await Promise.all(leases.filter((_, i) => i !== 1).map(l => l.release())); await next.release();
  await pool.close(); expect(ownerClose).toHaveBeenCalledOnce();
});
it("recycles after 50 conversations and replaces broken processes without executing any retry", async () => {
  let opened = 0; const closed: number[] = [];
  const pool = new ImageProcessPool(async () => { const id = ++opened; return { id, close: async () => { closed.push(id); } }; }, async () => {});
  for (let i = 0; i < 50; i++) { const lease = await pool.acquire(); expect(lease.value.id).toBe(1); await lease.release(); }
  expect(closed).toEqual([1]);
  const second = await pool.acquire(); expect(second.value.id).toBe(2); await second.release(true);
  expect(closed).toEqual([1, 2]);
  const third = await pool.acquire(); expect(third.value.id).toBe(3); await third.release(); await pool.close();
});
it("counts pending connections towards the concurrency limit", async () => {
  const gates: (() => void)[] = []; let opened = 0;
  const pool = new ImageProcessPool(async () => { opened++; await new Promise<void>(resolve => gates.push(resolve)); return { close: async () => {} }; }, async () => {});
  const pending = Array.from({ length: 5 }, () => pool.acquire());
  expect(opened).toBe(4); gates.forEach(g => g());
  const first = await pending[0]; await first.release();
  const all = await Promise.all(pending); expect(opened).toBe(4);
  await Promise.all(all.map(l => l.release())); await pool.close();
});
it("read-only recovery does not consume the 50-conversation allowance", async () => {
  let opened = 0;
  const pool = new ImageProcessPool(async () => { const id = ++opened; return { id, close: async () => {} }; }, async () => {});
  for (let i = 0; i < 60; i++) { const lease = await pool.acquire(); await lease.release(false, false); }
  expect(opened).toBe(1);
  const generation = await pool.acquire(); expect(generation.value.id).toBe(1); await generation.release(); await pool.close();
});
