import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Runpod network-volume asset store (runpod-asset-store.ts). The AWS SDK is replaced by an
 * in-memory fake — no test touches the network or a real volume.
 */
const ACCESS = "user_ACCESSKEY12345";
const SECRET = "rps_SECRETVALUE6789";
const settings = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock("../settings", () => ({ getSetting: (k: string) => settings.values[k] ?? "" }));

type Cmd = { kind: string; input: Record<string, unknown> };
const sdk = vi.hoisted(() => ({
  configs: [] as Record<string, unknown>[],
  calls: [] as Cmd[],
  objects: new Map<string, Buffer>(),
  // Per-test override: return/throw for a call, or undefined to fall through to the fake store.
  intercept: null as null | ((c: Cmd, n: number) => unknown),
}));
vi.mock("@aws-sdk/client-s3", () => {
  const cmd = (kind: string) =>
    class {
      kind = kind;
      constructor(public input: Record<string, unknown>) {}
    };
  class S3Client {
    constructor(cfg: Record<string, unknown>) {
      sdk.configs.push(cfg);
    }
    async send(c: Cmd) {
      sdk.calls.push({ kind: c.kind, input: c.input });
      const n = sdk.calls.filter((x) => x.kind === c.kind).length;
      if (sdk.intercept) {
        const r = sdk.intercept(c, n);
        if (r instanceof Error) throw r;
        if (r !== undefined) return r;
      }
      const key = String(c.input.Key);
      const notFound = () => Object.assign(new Error("NotFound"), { name: c.kind === "head" ? "NotFound" : "NoSuchKey", $metadata: { httpStatusCode: 404 } });
      switch (c.kind) {
        case "put": {
          const chunks: Buffer[] = [];
          for await (const ch of c.input.Body as Readable) chunks.push(ch as Buffer);
          sdk.objects.set(key, Buffer.concat(chunks));
          return {};
        }
        case "head": {
          const o = sdk.objects.get(key);
          if (!o) throw notFound();
          return { ContentLength: o.length };
        }
        case "get": {
          const o = sdk.objects.get(key);
          if (!o) throw notFound();
          return { ContentLength: o.length, Body: Readable.from([o.subarray(0, 3), o.subarray(3)]) };
        }
        case "delete":
          sdk.objects.delete(key);
          return {};
      }
    }
  }
  return {
    S3Client,
    PutObjectCommand: cmd("put"),
    GetObjectCommand: cmd("get"),
    HeadObjectCommand: cmd("head"),
    DeleteObjectCommand: cmd("delete"),
  };
});

import {
  uploadRunpodAsset,
  downloadRunpodAsset,
  headRunpodAsset,
  deleteRunpodAsset,
  validateRunpodAssetPath,
  buildSceneAssetPrefix,
  sceneAssetPath,
  readRunpodS3Config,
  RunpodAssetError,
  MAX_PUT_BYTES,
  __resetRunpodS3Clients,
} from "./runpod-asset-store";

const KEY_A = `sj1:${"a".repeat(64)}`;
const KEY_B = `sj1:${"b".repeat(64)}`;
const REMOTE = `conveyer/jobs/sj1/${"a".repeat(64)}/input.png`;
const sha = (b: Buffer | string) => crypto.createHash("sha256").update(b).digest("hex");
const sdkError = (name: string, status?: number, message = name) =>
  Object.assign(new Error(message), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });
const netError = (code: string) => Object.assign(new Error(`socket ${code}`), { name: "Error", code });
const FAST = { retryBaseDelayMs: 1 };

let dir: string;
beforeEach(() => {
  settings.values = {
    RUNPOD_NETWORK_VOLUME_ID: "vol0abc123",
    RUNPOD_S3_ENDPOINT: "https://s3api-eu-ro-1.runpod.io",
    RUNPOD_S3_REGION: "EU-RO-1",
    RUNPOD_S3_ACCESS_KEY_ID: ACCESS,
    RUNPOD_S3_SECRET_ACCESS_KEY: SECRET,
  };
  sdk.configs = [];
  sdk.calls = [];
  sdk.objects = new Map();
  sdk.intercept = null;
  __resetRunpodS3Clients();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "asset-store-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function localFile(name: string, content: string | Buffer): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}
async function assetError(p: Promise<unknown>): Promise<RunpodAssetError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RunpodAssetError);
    return e as RunpodAssetError;
  }
  throw new Error("expected a RunpodAssetError");
}

describe("config", () => {
  it("reads a complete config and builds a path-style client with no checksum surprises and no SDK retries", async () => {
    expect(readRunpodS3Config()).toEqual({
      volumeId: "vol0abc123", endpoint: "https://s3api-eu-ro-1.runpod.io", region: "EU-RO-1", accessKeyId: ACCESS, secretAccessKey: SECRET,
    });
    await headRunpodAsset(REMOTE);
    expect(sdk.configs[0]).toMatchObject({
      endpoint: "https://s3api-eu-ro-1.runpod.io",
      region: "EU-RO-1",
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET },
    });
    expect(sdk.calls[0].input.Bucket).toBe("vol0abc123");
  });

  it("names every missing key, never a value, and makes no request", async () => {
    settings.values.RUNPOD_S3_SECRET_ACCESS_KEY = "";
    settings.values.RUNPOD_S3_REGION = "";
    const e = await assetError(headRunpodAsset(REMOTE));
    expect(e.code).toBe("config");
    expect(e.message).toContain("RUNPOD_S3_REGION");
    expect(e.message).toContain("RUNPOD_S3_SECRET_ACCESS_KEY");
    expect(e.message).not.toContain(ACCESS);
    expect(sdk.calls).toHaveLength(0);
  });

  it("is separate from RUNPOD_API_KEY — that key alone configures nothing", () => {
    settings.values = { RUNPOD_API_KEY: "rp_main_api_key" };
    expect(() => readRunpodS3Config()).toThrow(/RUNPOD_S3_ACCESS_KEY_ID/);
  });

  it.each([
    "http://s3api-eu-ro-1.runpod.io",
    `https://${ACCESS}:${SECRET}@s3api-eu-ro-1.runpod.io`,
    "https://s3api-eu-ro-1.runpod.io/?X-Amz-Credential=x",
    "not a url",
  ])("rejects an unsafe endpoint %s without echoing it", (endpoint) => {
    settings.values.RUNPOD_S3_ENDPOINT = endpoint;
    try {
      readRunpodS3Config();
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET);
      expect((e as Error).message).toMatch(/RUNPOD_S3_ENDPOINT/);
    }
  });
});

describe("paths & namespace", () => {
  it("accepts a volume-relative path under conveyer/", () => {
    expect(validateRunpodAssetPath(REMOTE)).toBe(REMOTE);
  });

  it.each([
    ["traversal", "conveyer/jobs/../../etc/passwd"],
    ["dot", "conveyer/./jobs/x.png"],
    ["empty segment", "conveyer//x.png"],
    ["trailing slash", "conveyer/jobs/"],
    ["absolute", "/conveyer/x.png"],
    ["s3 url", "s3://vol0abc123/conveyer/x.png"],
    ["runpod mount", "/runpod-volume/conveyer/x.png"],
    ["home", "~/conveyer/x.png"],
    ["backslash", "conveyer\\x.png"],
    ["NUL", "conveyer/x\u0000.png"],
    ["colon", "conveyer/sj1:abc/x.png"],
    ["space", "conveyer/my video/x.png"],
    ["outside the root", "jobs/x.png"],
    ["worker weight cache", ".cache/endpoint/big/x"],
    ["too long", `conveyer/${"a".repeat(600)}`],
  ])("rejects %s", async (_why, p) => {
    expect(() => validateRunpodAssetPath(p)).toThrow(RunpodAssetError);
    expect((await assetError(headRunpodAsset(p))).code).toBe("invalid_path");
    expect(sdk.calls).toHaveLength(0);
  });

  it("builds the deterministic scene-job prefix from the idempotency key", () => {
    expect(buildSceneAssetPrefix(KEY_A)).toBe(`conveyer/jobs/sj1/${"a".repeat(64)}/`);
    expect(buildSceneAssetPrefix(KEY_A)).toBe(buildSceneAssetPrefix(KEY_A));
    expect(sceneAssetPath(KEY_A, "output.mp4")).toBe(`conveyer/jobs/sj1/${"a".repeat(64)}/output.mp4`);
  });

  it("two scene jobs never share a prefix", () => {
    expect(buildSceneAssetPrefix(KEY_A)).not.toBe(buildSceneAssetPrefix(KEY_B));
  });

  it.each(["sj1:abc", "sj2:" + "a".repeat(64), "sj1:" + "A".repeat(64), "My Video Title", ""])("rejects a non-key %s", (k) => {
    expect(() => buildSceneAssetPrefix(k)).toThrow(RunpodAssetError);
  });

  it.each(["../x", "a/b.png", "", ".", "x y.png"])("asset names are one safe segment (%s rejected)", (name) => {
    expect(() => sceneAssetPath(KEY_A, name)).toThrow(RunpodAssetError);
  });
});

describe("upload", () => {
  it("streams the file, confirms it with HeadObject, and returns path/bytes/sha256", async () => {
    const content = Buffer.from("PNG\x00fake image bytes");
    const res = await uploadRunpodAsset(localFile("in.png", content), REMOTE);
    expect(res).toEqual({ path: REMOTE, bytes: content.length, sha256: sha(content) });
    expect(sdk.objects.get(REMOTE)).toEqual(content);
    expect(sdk.calls.map((c) => c.kind)).toEqual(["put", "head"]);
    expect(sdk.calls[0].input).toMatchObject({ Bucket: "vol0abc123", Key: REMOTE, ContentLength: content.length });
    expect(sdk.calls[0].input).not.toHaveProperty("ContentMD5");
  });

  it("refuses a missing file, a directory or a relative path before any request", async () => {
    expect((await assetError(uploadRunpodAsset(path.join(dir, "nope.png"), REMOTE))).code).toBe("local_file");
    fs.mkdirSync(path.join(dir, "d.png"));
    expect((await assetError(uploadRunpodAsset(path.join(dir, "d.png"), REMOTE))).code).toBe("local_file");
    expect((await assetError(uploadRunpodAsset("relative/in.png", REMOTE))).code).toBe("local_file");
    expect(sdk.calls).toHaveLength(0);
  });

  it("refuses files at Runpod's 500 MB PutObject limit (no multipart) before any request", async () => {
    const p = localFile("big.mp4", "");
    fs.truncateSync(p, MAX_PUT_BYTES);
    expect((await assetError(uploadRunpodAsset(p, REMOTE))).code).toBe("too_large");
    expect(sdk.calls).toHaveLength(0);
  });

  it("retries a 503 / 429 / reset with a FRESH body stream on the same deterministic key", async () => {
    const answers = [sdkError("ServiceUnavailable", 503), sdkError("SlowDown", 429), netError("ECONNRESET")];
    sdk.intercept = (c, n) => (c.kind === "put" && n <= 3 ? answers[n - 1] : undefined);
    await expect(uploadRunpodAsset(localFile("in.png", "abc"), REMOTE, FAST)).rejects.toThrow(); // 3 attempts, all fail
    expect(sdk.calls.filter((c) => c.kind === "put")).toHaveLength(3);

    sdk.calls = [];
    sdk.intercept = (c, n) => (c.kind === "put" && n === 1 ? sdkError("InternalError", 500) : undefined);
    const res = await uploadRunpodAsset(localFile("in2.png", "abcdef"), REMOTE, FAST);
    const puts = sdk.calls.filter((c) => c.kind === "put");
    expect(puts).toHaveLength(2);
    expect(new Set(puts.map((p) => p.input.Key))).toEqual(new Set([REMOTE]));
    expect(puts[0].input.Body).not.toBe(puts[1].input.Body);
    expect(sdk.objects.get(REMOTE)?.toString()).toBe("abcdef");
    expect(res.bytes).toBe(6);
  });

  it("closes every attempt's file stream, even when the request fails before reading it", async () => {
    const bodies: Readable[] = [];
    sdk.intercept = (c) => {
      if (c.kind !== "put") return undefined;
      bodies.push(c.input.Body as Readable);
      return sdkError("InternalError", 500);
    };
    await assetError(uploadRunpodAsset(localFile("in.png", "abc"), REMOTE, FAST));
    expect(bodies).toHaveLength(3);
    expect(bodies.every((b) => b.destroyed)).toBe(true);
  });

  it("does not retry a definitive 403", async () => {
    sdk.intercept = (c) => (c.kind === "put" ? sdkError("AccessDenied", 403) : undefined);
    const e = await assetError(uploadRunpodAsset(localFile("in.png", "x"), REMOTE, FAST));
    expect([e.code, e.httpStatus, sdk.calls.length]).toEqual(["http", 403, 1]);
  });

  it("fails if the object is not visible at the uploaded size", async () => {
    sdk.intercept = (c) => (c.kind === "head" ? { ContentLength: 1 } : undefined);
    expect((await assetError(uploadRunpodAsset(localFile("in.png", "abc"), REMOTE))).code).toBe("integrity");
  });
});

describe("head", () => {
  it("reports existence and size via HeadObject", async () => {
    sdk.objects.set(REMOTE, Buffer.from("12345"));
    expect(await headRunpodAsset(REMOTE)).toEqual({ exists: true, bytes: 5 });
    expect(sdk.calls.map((c) => c.kind)).toEqual(["head"]);
  });

  it("a 404 is 'does not exist', not an error, and is not retried", async () => {
    expect(await headRunpodAsset(REMOTE, FAST)).toEqual({ exists: false });
    expect(sdk.calls).toHaveLength(1);
  });

  it("retries 429 / 5xx / transport errors, at most 3 times", async () => {
    sdk.objects.set(REMOTE, Buffer.from("x"));
    sdk.intercept = (_c, n) => (n === 1 ? sdkError("SlowDown", 429) : n === 2 ? netError("ETIMEDOUT") : undefined);
    expect(await headRunpodAsset(REMOTE, FAST)).toEqual({ exists: true, bytes: 1 });
    expect(sdk.calls).toHaveLength(3);

    sdk.calls = [];
    sdk.intercept = () => sdkError("InternalError", 500);
    const e = await assetError(headRunpodAsset(REMOTE, FAST));
    expect([e.httpStatus, sdk.calls.length]).toEqual([500, 3]);
  });
});

describe("download", () => {
  const content = Buffer.from("fake mp4 bytes 0123456789");
  beforeEach(() => sdk.objects.set(REMOTE, content));

  it("streams to a temp file, verifies and renames atomically, returning bytes + sha256", async () => {
    const dest = path.join(dir, "beats", "beat_0003.mp4");
    const res = await downloadRunpodAsset(REMOTE, dest, { expectedBytes: content.length, expectedSha256: sha(content) });
    expect(res).toEqual({ localPath: dest, bytes: content.length, sha256: sha(content) });
    expect(fs.readFileSync(dest)).toEqual(content);
    expect(fs.readdirSync(path.dirname(dest))).toEqual(["beat_0003.mp4"]); // no partial left
    expect(sdk.calls.map((c) => c.kind)).toEqual(["get"]);
  });

  it.each([
    ["expectedSha256", { expectedSha256: "0".repeat(64) }, /sha256 mismatch/],
    ["expectedBytes", { expectedBytes: 3 }, /size mismatch/],
  ])("a %s mismatch fails, removes the partial and keeps the old file", async (_n, expected, msg) => {
    const dest = localFile("beat.mp4", "previous clip");
    const e = await assetError(downloadRunpodAsset(REMOTE, dest, { ...FAST, ...expected }));
    expect([e.code, e.message]).toEqual(["integrity", expect.stringMatching(msg)]);
    expect(fs.readFileSync(dest, "utf8")).toBe("previous clip");
    expect(fs.readdirSync(dir)).toEqual(["beat.mp4"]);
    expect(sdk.calls).toHaveLength(1); // integrity failures are not retried
  });

  it("a truncated body is retried, and the partial of the failed attempt is removed", async () => {
    sdk.intercept = (c, n) =>
      c.kind === "get" && n === 1 ? { ContentLength: content.length, Body: Readable.from([content.subarray(0, 5)]) } : undefined;
    const dest = path.join(dir, "beat.mp4");
    const res = await downloadRunpodAsset(REMOTE, dest, FAST);
    expect(res.bytes).toBe(content.length);
    expect(sdk.calls).toHaveLength(2);
    expect(fs.readdirSync(dir)).toEqual(["beat.mp4"]);
  });

  it("a stream that dies mid-way leaves no partial and the old file intact", async () => {
    const dying = () =>
      new Readable({
        read() {
          this.push(Buffer.from("half"));
          this.destroy(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        },
      });
    sdk.intercept = (c) => (c.kind === "get" ? { ContentLength: 99, Body: dying() } : undefined);
    const dest = localFile("beat.mp4", "previous clip");
    await assetError(downloadRunpodAsset(REMOTE, dest, FAST));
    expect(fs.readFileSync(dest, "utf8")).toBe("previous clip");
    expect(fs.readdirSync(dir)).toEqual(["beat.mp4"]);
    expect(sdk.calls).toHaveLength(3);
  });

  it("a missing object is not_found and not retried", async () => {
    sdk.objects.clear();
    const e = await assetError(downloadRunpodAsset(REMOTE, path.join(dir, "x.mp4"), FAST));
    expect([e.code, sdk.calls.length]).toEqual(["not_found", 1]);
  });

  it("validates its options and the destination before any request", async () => {
    expect((await assetError(downloadRunpodAsset(REMOTE, "rel/x.mp4"))).code).toBe("local_file");
    expect((await assetError(downloadRunpodAsset(REMOTE, path.join(dir, "x"), { expectedSha256: "ABC" }))).code).toBe("integrity");
    expect((await assetError(downloadRunpodAsset(REMOTE, path.join(dir, "x"), { expectedBytes: -1 }))).code).toBe("integrity");
    expect(sdk.calls).toHaveLength(0);
  });

  it("a caller abort stops without retrying", async () => {
    const ctrl = new AbortController();
    sdk.intercept = () => {
      ctrl.abort();
      return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    };
    const e = await assetError(downloadRunpodAsset(REMOTE, path.join(dir, "x.mp4"), { ...FAST, signal: ctrl.signal }));
    expect([e.code, sdk.calls.length]).toEqual(["aborted", 1]);
  });
});

describe("delete", () => {
  it("uses DeleteObject on exactly that key; deleting a missing key succeeds", async () => {
    sdk.objects.set(REMOTE, Buffer.from("x"));
    await deleteRunpodAsset(REMOTE);
    await deleteRunpodAsset(REMOTE);
    expect(sdk.calls.map((c) => [c.kind, c.input.Key])).toEqual([["delete", REMOTE], ["delete", REMOTE]]);
    expect(sdk.objects.has(REMOTE)).toBe(false);
  });

  it("retries conservatively: at most 2 attempts", async () => {
    sdk.intercept = () => sdkError("InternalError", 500);
    await assetError(deleteRunpodAsset(REMOTE, FAST));
    expect(sdk.calls).toHaveLength(2);
  });
});

describe("credentials & SDK errors are sanitised", () => {
  it("neither key, a SigV4 credential nor a signature reaches an error message", async () => {
    const leaky = `Credential=${ACCESS}/20261002/EU-RO-1/s3/aws4_request, Signature=deadbeef01 secret=${SECRET}`;
    for (const err of [sdkError("SignatureDoesNotMatch", 403, leaky), sdkError("InternalError", 500, leaky), Object.assign(new Error(leaky), { code: "ECONNRESET" })]) {
      sdk.calls = [];
      sdk.intercept = () => err;
      const e = await assetError(headRunpodAsset(REMOTE, FAST));
      expect(e.message).not.toContain(ACCESS);
      expect(e.message).not.toContain(SECRET);
      expect(e.message).not.toContain("deadbeef01");
      expect(e.message).toContain("[REDACTED]");
      // The SDK error (with its request/response objects) is not carried along.
      expect((e as Error & { cause?: unknown }).cause).toBeUndefined();
      expect(Object.keys(e)).not.toContain("$response");
    }
  });

  it("the endpoint URL handed to the SDK carries no credentials", async () => {
    await headRunpodAsset(REMOTE);
    const ep = String(sdk.configs[0].endpoint);
    expect(ep).not.toContain(ACCESS);
    expect(ep).not.toContain(SECRET);
  });

  it("the module never logs, lists, presigns or batch-deletes", () => {
    const src = fs.readFileSync(path.join(__dirname, "runpod-asset-store.ts"), "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/console\.|from "\.\.\/logger"/);
    expect(code).not.toMatch(/ListObjects|DeleteObjects|getSignedUrl|presign|s3-request-presigner|lib-storage/);
  });
});

describe("concurrency", () => {
  it("parallel uploads and downloads share one client and need no global lock", async () => {
    const paths = Array.from({ length: 5 }, (_, i) => `conveyer/jobs/sj1/${"c".repeat(64)}/f${i}.bin`);
    await Promise.all(paths.map((p, i) => uploadRunpodAsset(localFile(`f${i}`, `payload-${i}`), p)));
    const got = await Promise.all(paths.map((p, i) => downloadRunpodAsset(p, path.join(dir, "out", `f${i}`))));
    expect(got.map((g) => fs.readFileSync(g.localPath, "utf8"))).toEqual(paths.map((_, i) => `payload-${i}`));
    expect(sdk.configs).toHaveLength(1);
  });
});
