import { beforeAll, afterAll, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
const fixture = vi.hoisted(() => ({ dir: `/private/tmp/conveyer-route-batch-${process.pid}-${Math.random().toString(16).slice(2)}`, changed: false, execute: vi.fn(async () => {}) }));
vi.mock("@/lib/data-dir", () => ({ DATA_DIR: fixture.dir }));
vi.mock("@/lib/db", () => ({ default: { prepare: () => ({ get: () => ({ config_json: JSON.stringify({ aiProvider: "ltx" }) }) }) } }));
vi.mock("@/lib/run-paths", () => ({ getRunDir: () => fixture.dir }));
vi.mock("@/lib/services/ltx/pipeline", () => ({
  listLtxScenes: async () => Array.from({ length: 5 }, (_, index) => ({ index, fingerprint: "a".repeat(64), media: index < 3 ? "image" : "video", prompt: `scene ${index}`, ready: false })),
  saveLtxImage: vi.fn(),
}));
vi.mock("@/lib/services/ltx/targets", () => ({ resolveLtxTarget: async (_run: string, index: number) => { if (fixture.changed) throw new Error("Cena mudou"); return { request: { prompt: `scene ${index}` } }; } }));
vi.mock("@/lib/services/codex-image-runtime", () => ({ codexImageConfigured: async () => true, codexImageProfile: () => ({ model: "fixture", accountHome: fixture.dir }), connectImageDriver: vi.fn(() => { throw new Error("Real driver must not run"); }) }));
vi.mock("@/lib/services/codex-image-jobs", async () => ({ ...await vi.importActual<object>("../../../../lib/services/codex-image-jobs"), executeImageJob: fixture.execute }));
vi.mock("@/lib/services/codex-image-batch", async () => await vi.importActual("../../../../lib/services/codex-image-batch"));
import { POST, GET } from "./route";
function request(data: object) { return new Request("http://localhost:3000/api/tools/ltx-image-batch", { method: "POST", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" }, body: JSON.stringify(data) }); }
beforeAll(async () => { await fs.mkdir(fixture.dir, { recursive: true }); });
afterAll(async () => { await fs.rm(fixture.dir, { recursive: true, force: true }); });
it("prepares locally, requires exact consent, queues each job once, and refuses repeats", async () => {
  const prepared = await (await POST(request({ action: "prepare", runId: "run-fixture" }))).json();
  expect(prepared.jobs).toHaveLength(5); expect(prepared.videosPending).toBe(2); expect(fixture.execute).not.toHaveBeenCalled();
  const ids = prepared.jobs.map((j: { id: string }) => j.id);
  expect((await POST(request({ action: "generate", id: prepared.batch.id, approvedIds: ids, confirmed: false }))).status).toBe(409);
  fixture.changed = true;
  expect((await POST(request({ action: "generate", id: prepared.batch.id, approvedIds: ids, confirmed: true }))).status).toBe(409);
  expect(fixture.execute).not.toHaveBeenCalled(); fixture.changed = false;
  const response = await POST(request({ action: "generate", id: prepared.batch.id, approvedIds: ids, confirmed: true }));
  expect(response.status).toBe(202); expect(fixture.execute).toHaveBeenCalledTimes(5);
  expect((await POST(request({ action: "generate", id: prepared.batch.id, approvedIds: ids, confirmed: true }))).status).toBe(409);
  expect(fixture.execute).toHaveBeenCalledTimes(5);
  expect((await GET(new Request(`http://localhost:3000/api/tools/ltx-image-batch?id=${prepared.batch.id}`))).status).toBe(200);
  expect(fixture.execute).toHaveBeenCalledTimes(5);
});
it("rejects foreign-origin requests without invoking generation", async () => {
  const req = new Request("http://localhost:3000/api/tools/ltx-image-batch", { method: "POST", headers: { Origin: "http://foreign.test" }, body: "{}" });
  expect((await POST(req)).status).toBe(403); expect(fixture.execute).toHaveBeenCalledTimes(5);
});
