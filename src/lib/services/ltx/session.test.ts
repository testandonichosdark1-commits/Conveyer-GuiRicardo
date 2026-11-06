import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { root } = vi.hoisted(() => ({ root: `/tmp/conveyer-ltx-session-test-${process.pid}` }));
vi.mock("../../data-dir", () => ({ DATA_DIR: root }));
vi.mock("../../settings", () => ({ getSetting: () => "test-only-not-a-real-key" }));
vi.mock("../../ffmpeg-bin", () => ({ resolveFfmpeg: () => "ffmpeg" }));
import { guardianVerifiedStop, ltxTransport, readLtxSession, requestLtxStop, LTX_SESSION_DIR } from "./session";
import type { LtxSession } from "./scene";

let session: LtxSession;
beforeEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(LTX_SESSION_DIR, { recursive: true });
  const now = Date.now();
  session = { approvalId: "approval-test-02", podId: "testpod123456", podName: "conveyer-ltx-approved",
    comfyUrl: "http://127.0.0.1:18188/", startedAt: now, deadline: now + 60_000, budgetUsd: 2, guardianPid: process.pid };
  await fs.writeFile(path.join(LTX_SESSION_DIR, "session.json"), JSON.stringify(session));
  await fs.writeFile(path.join(LTX_SESSION_DIR, "armed.json"), JSON.stringify({ approvalId: session.approvalId,
    podId: session.podId, pid: process.pid, deadline: session.deadline, observedAt: now, state: "armed" }));
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });

it("loads only a live, fresh independent guardian lease without any network", async () => {
  const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  expect(await readLtxSession()).toEqual(session);
  await fs.rm(path.join(LTX_SESSION_DIR, "armed.json"));
  expect(await readLtxSession()).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
it("blocks a stale guardian heartbeat", async () => {
  const armedPath = path.join(LTX_SESSION_DIR, "armed.json");
  const armed = JSON.parse(await fs.readFile(armedPath, "utf8")); armed.observedAt = Date.now() - 31_000;
  await fs.writeFile(armedPath, JSON.stringify(armed));
  expect(await readLtxSession()).toBeNull();
});
it("manual stop affects only the active approved session", async () => {
  expect(await requestLtxStop("foreign-approval")).toBe(false);
  expect(await requestLtxStop(session.approvalId)).toBe(true);
  expect(await readLtxSession()).toBeNull();
});
it("does not stop an unrelated Pod even if API identity is wrong", async () => {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ name: "production", status: "RUNNING", cost: 0.72 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(ltxTransport(session).stopAndVerify(session)).rejects.toThrow("não pertence");
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe(`https://api.runpod.io/v2/pods/${session.podId}`);
});
it("requires observed EXITED and uses Bearer stop without credentials in URLs", async () => {
  let stopped = false;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).not.toContain("test-only-not-a-real-key");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-only-not-a-real-key");
    if (url === `https://rest.runpod.io/v1/pods/${session.podId}/stop`) { stopped = true; return Response.json({}); }
    return Response.json({ name: session.podName, status: stopped ? "EXITED" : "RUNNING", cost: 0.72 });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await ltxTransport(session).stopAndVerify(session)).toBe(true);
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});
it("refuses price above the quote before any Comfy generation", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ name: session.podName, status: "RUNNING", cost: 0.73 })));
  await expect(ltxTransport(session).assertGuardian(session)).rejects.toThrow("preço acima");
});
it("stop confirmation from the guardian matches approval and Pod identity", async () => {
  const armedPath = path.join(LTX_SESSION_DIR, "armed.json");
  const armed = JSON.parse(await fs.readFile(armedPath, "utf8")); armed.state = "stopped";
  await fs.writeFile(armedPath, JSON.stringify(armed));
  expect(await guardianVerifiedStop(session.approvalId)).toBe(true);
  expect(await guardianVerifiedStop("foreign-approval")).toBe(false);
});

it("accepts explicitly approved 5090 quote and retains a hard ceiling", async () => {
  session.approvedGpuRate = 0.99;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ name: session.podName, status: "RUNNING", cost: 0.99 })));
  await expect(ltxTransport(session).assertGuardian(session)).resolves.toBeUndefined();
  session.approvedGpuRate = 5;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ name: session.podName, status: "RUNNING", cost: 1 })));
  await expect(ltxTransport(session).assertGuardian(session)).rejects.toThrow("preço acima");
});
