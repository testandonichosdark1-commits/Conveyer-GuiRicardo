import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { CodexImageRpc, codexImageEnvironment, codexImageThreadParams, generateCodexImage, recoverCodexImage, saveCodexImage, type CodexImageWire } from "./codex-images";

function fake(handler: (message: any, emit: (message: any) => void) => void, timeout = 100, imageTimeout = timeout) {
  const sent: any[] = [], listeners = new Set<(message: any) => void>();
  const emit = (message: any) => { for (const fn of [...listeners]) fn(message); };
  const wire: CodexImageWire = { send: message => { sent.push(message); handler(message, emit); }, subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  return { rpc: new CodexImageRpc(wire, timeout, imageTimeout), sent, emit };
}
const options = { model: "controller-confirmed-later", emptyWorkspace: "/tmp/empty", prompt: "Paisagem 16:9", approved: true, recordThread: async () => {} };
describe("Codex images: simulated protocol, no subprocess or network", () => {
  it("refuses generation without approval before any message", async () => {
    const f = fake(() => {});
    await expect(generateCodexImage(f.rpc, { ...options, approved: false })).rejects.toThrow("autorização");
    expect(f.sent).toEqual([]);
  });
  it("captures an image notification before turn/start response and ignores other threads", async () => {
    const order: string[] = [];
    const f = fake((m, emit) => {
      order.push(m.method);
      if (m.method === "thread/start") emit({ id: m.id, result: { thread: { id: "ours" } } });
      if (m.method === "turn/start") {
        emit({ method: "item/completed", params: { threadId: "other", item: { type: "imageGeneration", status: "failed" } } });
        emit({ method: "item/completed", params: { threadId: "ours", item: { type: "imageGeneration", status: "completed", savedPath: "/image.png" } } });
        emit({ id: m.id, result: { turn: { id: "turn1" } } });
      }
      if (m.method === "turn/interrupt") emit({ id: m.id, result: {} });
    });
    const result = await generateCodexImage(f.rpc, { ...options, recordThread: async id => { expect(id).toBe("ours"); order.push("persist"); } });
    expect(result.interrupted).toBe(true);
    expect(order).toEqual(["thread/start", "persist", "turn/start", "turn/interrupt"]);
  });
  it("never submits when recording the thread fails", async () => {
    const f = fake((m, emit) => emit({ id: m.id, result: { thread: { id: "ours" } } }));
    await expect(generateCodexImage(f.rpc, { ...options, recordThread: async () => { throw Error("disk"); } })).rejects.toThrow("disk");
    expect(f.sent.map(m => m.method)).toEqual(["thread/start"]);
  });
  it("does not retry a lost turn/start response", async () => {
    const f = fake((m, emit) => { if (m.method === "thread/start") emit({ id: m.id, result: { thread: { id: "ours" } } }); }, 10);
    await expect(generateCodexImage(f.rpc, options)).rejects.toThrow("Não reenviar");
    expect(f.sent.filter(m => m.method === "turn/start")).toHaveLength(1);
  });
  it("refuses concurrent generation before opening a second thread", async () => {
    const f = fake(() => {}, 10);
    const pending = generateCodexImage(f.rpc, options);
    await expect(generateCodexImage(f.rpc, options)).rejects.toThrow("andamento");
    await expect(pending).rejects.toThrow("tempo");
    expect(f.sent).toHaveLength(1);
  });
  it("interrupts a known turn when its image times out, without retrying", async () => {
    const f = fake((m, emit) => {
      if (m.method === "thread/start") emit({ id: m.id, result: { thread: { id: "ours" } } });
      if (m.method === "turn/start") emit({ id: m.id, result: { turn: { id: "t1" } } });
      if (m.method === "turn/interrupt") emit({ id: m.id, result: {} });
    }, 10);
    await expect(generateCodexImage(f.rpc, options)).rejects.toThrow("Recuperar");
    expect(f.sent.map(m => m.method)).toEqual(["thread/start", "turn/start", "turn/interrupt"]);
  });
  it("recovers only the requested turn without generation", async () => {
    const image = { type: "imageGeneration", status: "completed", savedPath: "/recovered.png" };
    const f = fake((m, emit) => emit({ id: m.id, result: { thread: { turns: [{ id: "t1", items: [image] }] } } }));
    expect(await recoverCodexImage(f.rpc, "ours", "t1")).toEqual(image);
    expect(f.sent.map(m => m.method)).toEqual(["thread/read"]);
  });
  it("removes API credential overrides without changing the original environment", () => {
    const original = { NODE_ENV: "test" as const, OPENAI_API_KEY: "fake", CODEX_API_KEY: "fake", CODEX_ACCESS_TOKEN: "fake", ACCESS_TOKEN: "fake", PATH: "/bin" };
    const env = codexImageEnvironment(original, "/dedicated-account");
    expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.CODEX_API_KEY).toBeUndefined(); expect(env.ACCESS_TOKEN).toBeUndefined();
    expect(env.CODEX_HOME).toBe("/dedicated-account"); expect(original.OPENAI_API_KEY).toBe("fake");
  });
  it("enables only image generation and keeps recoverable history", () => {
    const p = codexImageThreadParams(options.model, options.emptyWorkspace);
    expect(p.ephemeral).toBe(false); expect(p.sandbox).toBe("read-only");
    expect(Object.entries(p.config.features).filter(([, value]) => value).map(([key]) => key)).toEqual(["image_generation"]);
  });
  it("validates actual PNG pixels, hashes and atomically saves; rejects wrong ratio and escaped paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-images-test-"));
    try {
      const home = path.join(root, "account"), generated = path.join(home, "generated_images", "thread");
      await fs.mkdir(generated, { recursive: true });
      const source = path.join(generated, "image.png"), out = path.join(root, "output", "scene.png");
      await sharp({ create: { width: 512, height: 288, channels: 3, background: "blue" } }).png().toFile(source);
      const saved = await saveCodexImage(home, { savedPath: source }, out);
      expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/); expect(saved.width).toBe(512);
      expect(await fs.readFile(out)).toEqual(await fs.readFile(source));
      await expect(saveCodexImage(home, { savedPath: out }, out)).rejects.toThrow("fora");
      const link = path.join(generated, "escaped.png"); await fs.symlink(out, link);
      await expect(saveCodexImage(home, { savedPath: link }, out)).rejects.toThrow("fora");
      await sharp({ create: { width: 512, height: 512, channels: 3, background: "red" } }).png().toFile(source);
      await expect(saveCodexImage(home, { savedPath: source }, out)).rejects.toThrow("16:9");
      expect((await fs.readdir(path.dirname(out))).filter(name => name.endsWith(".tmp"))).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

it("allows image generation to exceed the control RPC deadline without resending", async () => {
  const f = fake((m, emit) => {
    if (m.method === "thread/start") emit({ id: m.id, result: { thread: { id: "slow-image" } } });
    if (m.method === "turn/start") {
      emit({ id: m.id, result: { turn: { id: "turn-1" } } });
      setTimeout(() => emit({ method: "item/completed", params: { threadId: "slow-image", item: { type: "imageGeneration", status: "completed", savedPath: "/image.png" } } }), 30);
    }
    if (m.method === "turn/interrupt") emit({ id: m.id, result: {} });
  }, 10, 100);
  const result = await generateCodexImage(f.rpc, options);
  expect(result.threadId).toBe("slow-image");
  expect(f.sent.filter(m => m.method === "turn/start")).toHaveLength(1);
});
