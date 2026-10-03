import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSetting } from "../settings";

/**
 * Runpod network-volume asset store, over Runpod's S3-compatible API. No production code
 * calls this yet; it is how future remote providers (LTX first) will put inputs on the volume
 * their workers mount and bring results back.
 *
 * ── Addressing ───────────────────────────────────────────────────────────────────────
 * Runpod maps `s3://<NETWORK_VOLUME_ID>/a/b.png` to `/runpod-volume/a/b.png` inside a
 * Serverless worker (and `/workspace/a/b.png` on a Pod). So this module deals ONLY in paths
 * RELATIVE to the volume — the exact string a worker receives — and never hands out
 * `s3://…` or `/runpod-volume/…`. Every path must live under `conveyer/`, so nothing here can
 * touch the rest of the volume (e.g. the LTX worker's `.cache/` weight mirror).
 *
 * ── Runpod S3 API facts this relies on (docs.runpod.io/storage/s3-api) ──────────────────
 *  - The S3 key pair is its own credential (S3 API Keys tab), NOT RUNPOD_API_KEY.
 *  - Region = datacenter id (e.g. EU-RO-1); endpoint = that datacenter's s3api URL. The API
 *    exists only in some datacenters, so the volume must be created in one of them, and the
 *    Serverless endpoint must run where it can mount that volume.
 *  - PutObject is limited to < 500 MB; larger files need multipart (not implemented — the
 *    assets here are stills and short clips; a larger file is refused before any request).
 *  - DeleteObjects (batch) and presigned URLs are NOT supported; neither is used.
 *  - ListObjects breaks on directories > 10,000 files or > 10 GB; nothing here lists —
 *    every key is deterministic and addressed directly.
 *  - ETags are delayed for files written outside the S3 API (i.e. by a worker), and differ
 *    for multipart uploads; integrity is OUR SHA-256, never an ETag.
 *  - A network volume has a fixed capacity; nothing here manages space.
 * The docs say nothing about addressing style; path-style is used because the "bucket" is a
 * volume id, not a DNS name. The SDK's newer default request/response checksums are switched
 * to WHEN_REQUIRED, so correctness never depends on a checksum feature the docs do not list.
 *
 * Never logs; errors are rebuilt from scratch with credentials and signatures scrubbed, and
 * the SDK's original error object is never attached.
 */

export const ASSET_ROOT = "conveyer/";
/** Runpod: PutObject supports objects under 500 MB. */
export const MAX_PUT_BYTES = 500 * 1000 * 1000;
const MAX_PATH_CHARS = 512;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SCENE_KEY_RE = /^sj1:([0-9a-f]{64})$/;

export type AssetOp = "config" | "upload" | "download" | "head" | "delete";

export class RunpodAssetError extends Error {
  constructor(
    message: string,
    readonly op: AssetOp,
    readonly code: "config" | "invalid_path" | "local_file" | "too_large" | "not_found" | "integrity" | "http" | "network" | "aborted",
    readonly httpStatus?: number
  ) {
    super(message);
    this.name = "RunpodAssetError";
  }
}

export interface RunpodS3Config {
  volumeId: string;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AssetRequestOptions {
  signal?: AbortSignal;
  /** First backoff between retries (default 1 s, doubled per attempt). */
  retryBaseDelayMs?: number;
}

export interface UploadResult {
  path: string;
  bytes: number;
  sha256: string;
}

export interface DownloadResult {
  localPath: string;
  bytes: number;
  sha256: string;
}

export interface HeadResult {
  exists: boolean;
  bytes?: number;
}

// ── config ───────────────────────────────────────────────────────────────────────────

/** Server-side settings → validated config. Throws (op "config") naming the missing key, never a value. */
export function readRunpodS3Config(): RunpodS3Config {
  const get = (k: Parameters<typeof getSetting>[0]) => (getSetting(k) || "").trim();
  const cfg = {
    volumeId: get("RUNPOD_NETWORK_VOLUME_ID"),
    endpoint: get("RUNPOD_S3_ENDPOINT"),
    region: get("RUNPOD_S3_REGION"),
    accessKeyId: get("RUNPOD_S3_ACCESS_KEY_ID"),
    secretAccessKey: get("RUNPOD_S3_SECRET_ACCESS_KEY"),
  };
  const missing = (
    [
      ["RUNPOD_NETWORK_VOLUME_ID", cfg.volumeId],
      ["RUNPOD_S3_ENDPOINT", cfg.endpoint],
      ["RUNPOD_S3_REGION", cfg.region],
      ["RUNPOD_S3_ACCESS_KEY_ID", cfg.accessKeyId],
      ["RUNPOD_S3_SECRET_ACCESS_KEY", cfg.secretAccessKey],
    ] as const
  ).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new RunpodAssetError(`Runpod S3 is not configured: ${missing.join(", ")}`, "config", "config");
  if (!/^[A-Za-z0-9]{4,64}$/.test(cfg.volumeId)) throw new RunpodAssetError("RUNPOD_NETWORK_VOLUME_ID is not a volume id", "config", "config");
  if (!/^[A-Za-z0-9-]{3,32}$/.test(cfg.region)) throw new RunpodAssetError("RUNPOD_S3_REGION is not a datacenter id", "config", "config");
  let url: URL;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    throw new RunpodAssetError("RUNPOD_S3_ENDPOINT is not a URL", "config", "config");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new RunpodAssetError("RUNPOD_S3_ENDPOINT must be a plain https URL without credentials", "config", "config");
  }
  return cfg;
}

// ── paths ────────────────────────────────────────────────────────────────────────────

/**
 * A volume-relative path this store may touch: under `conveyer/`, segments of
 * [A-Za-z0-9._-] only, no empty / "." / ".." segment, ≤ 512 chars. That character set
 * already excludes "/" at the start, "~", "\\", NUL and ":".
 */
export function validateRunpodAssetPath(p: unknown, op: AssetOp = "upload"): string {
  const bad = (why: string): never => {
    throw new RunpodAssetError(`invalid asset path (${why})`, op, "invalid_path");
  };
  if (typeof p !== "string" || !p) return bad("empty");
  if (p.length > MAX_PATH_CHARS) return bad(`longer than ${MAX_PATH_CHARS} characters`);
  if (!p.startsWith(ASSET_ROOT)) return bad(`must start with ${ASSET_ROOT}`);
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return bad("empty, '.' or '..' segment");
    if (!SEGMENT_RE.test(seg)) return bad("characters outside [A-Za-z0-9._-]");
  }
  return p;
}

/**
 * The deterministic folder of one scene job's assets: `conveyer/jobs/sj1/<sha256>/`. Built
 * from the job's idempotency key (never a title or a timestamp), so a Resume of the same
 * logical job finds exactly the same keys. The ":" of the key becomes a path separator.
 */
export function buildSceneAssetPrefix(idempotencyKey: string): string {
  const m = SCENE_KEY_RE.exec(idempotencyKey);
  if (!m) throw new RunpodAssetError("not a scene job idempotency key (sj1:<sha256>)", "upload", "invalid_path");
  return `${ASSET_ROOT}jobs/sj1/${m[1]}/`;
}

/** `buildSceneAssetPrefix(key) + name`, where name is ONE safe segment (e.g. "input.png"). */
export function sceneAssetPath(idempotencyKey: string, name: string): string {
  if (!SEGMENT_RE.test(name) || name === "." || name === "..") {
    throw new RunpodAssetError("asset name must be a single safe path segment", "upload", "invalid_path");
  }
  return validateRunpodAssetPath(buildSceneAssetPrefix(idempotencyKey) + name);
}

// ── client & errors ──────────────────────────────────────────────────────────────────

const clients = new Map<string, S3Client>();

function clientFor(cfg: RunpodS3Config): S3Client {
  const key = JSON.stringify([cfg.endpoint, cfg.region, cfg.accessKeyId, crypto.createHash("sha256").update(cfg.secretAccessKey).digest("hex")]);
  let c = clients.get(key);
  if (!c) {
    c = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
      // Retries are ours (below): the SDK cannot replay a streamed upload body.
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 300_000 },
    });
    clients.set(key, c);
  }
  return c;
}

/** Test seam: forget cached clients. */
export function __resetRunpodS3Clients(): void {
  clients.clear();
}

function scrub(text: string, cfg: RunpodS3Config | null): string {
  let t = text
    .replace(/Credential=[^,\s]+/gi, "Credential=[REDACTED]")
    .replace(/Signature=[0-9a-f]+/gi, "Signature=[REDACTED]")
    .replace(/X-Amz-(Credential|Signature|Security-Token)=[^&\s]+/gi, "X-Amz-$1=[REDACTED]");
  if (cfg) {
    for (const s of [cfg.secretAccessKey, cfg.accessKeyId]) if (s) t = t.split(s).join("[REDACTED]");
  }
  return t.slice(0, 300);
}

interface SdkLikeError {
  name?: string;
  message?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
}

function statusOf(e: unknown): number | undefined {
  return (e as SdkLikeError | null)?.$metadata?.httpStatusCode;
}

function isNotFound(e: unknown): boolean {
  const n = (e as SdkLikeError | null)?.name;
  return statusOf(e) === 404 || n === "NotFound" || n === "NoSuchKey";
}

/** 429, 5xx and transport failures are worth one more try; any other answer is final. */
function isRetryable(e: unknown): boolean {
  if (e instanceof RunpodAssetError) return e.code === "network" || (e.code === "http" && (e.httpStatus === 429 || (e.httpStatus ?? 0) >= 500));
  const s = statusOf(e);
  if (s !== undefined) return s === 429 || s >= 500;
  const n = (e as SdkLikeError | null)?.name ?? "";
  return n !== "AbortError";
}

/** A fresh, sanitised error — the SDK error (and its request/response objects) is dropped. */
function toAssetError(e: unknown, op: AssetOp, cfg: RunpodS3Config | null, signal?: AbortSignal): RunpodAssetError {
  if (e instanceof RunpodAssetError) return e;
  if (signal?.aborted || (e as SdkLikeError | null)?.name === "AbortError") {
    return new RunpodAssetError(`Runpod S3 ${op} aborted`, op, "aborted");
  }
  const err = (e ?? {}) as SdkLikeError;
  const status = statusOf(e);
  const detail = scrub(`${err.name ?? "Error"}: ${err.message ?? ""}`, cfg);
  if (isNotFound(e)) return new RunpodAssetError(`Runpod S3 ${op}: object not found`, op, "not_found", 404);
  if (status !== undefined) return new RunpodAssetError(`Runpod S3 ${op} HTTP ${status} — ${detail}`, op, "http", status);
  return new RunpodAssetError(`Runpod S3 ${op} failed in transit — ${detail}`, op, "network");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bounded retry of a whole operation. Every op here is safe to repeat: GET/HEAD read,
 * PUT rewrites the SAME deterministic key with the same bytes (identified by our SHA-256,
 * and the volume has no versioning), DELETE of a key is idempotent.
 */
async function withRetry<T>(op: AssetOp, cfg: RunpodS3Config, attempts: number, opts: AssetRequestOptions, fn: () => Promise<T>): Promise<T> {
  const base = opts.retryBaseDelayMs ?? 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = toAssetError(e, op, cfg, opts.signal);
      if (err.code === "aborted" || attempt >= attempts || !isRetryable(err)) throw err;
    }
    try {
      await sleep(base * 2 ** (attempt - 1), opts.signal);
    } catch {
      throw new RunpodAssetError(`Runpod S3 ${op} aborted`, op, "aborted");
    }
  }
}

const GET_ATTEMPTS = 3;
const PUT_ATTEMPTS = 3;
const DELETE_ATTEMPTS = 2;

// ── local helpers ────────────────────────────────────────────────────────────────────

function hashTap(h: crypto.Hash, counter: { bytes: number }): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      counter.bytes += chunk.length;
      cb(null, chunk);
    },
  });
}

async function sha256OfFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const h = crypto.createHash("sha256");
  const counter = { bytes: 0 };
  await pipeline(fs.createReadStream(file), hashTap(h, counter), async function* (src) {
    for await (const _ of src) {
      // drain
    }
  });
  return { sha256: h.digest("hex"), bytes: counter.bytes };
}

function regularFile(localPath: string, op: AssetOp): fs.Stats {
  if (!path.isAbsolute(localPath)) throw new RunpodAssetError("local path must be absolute", op, "local_file");
  let st: fs.Stats;
  try {
    st = fs.statSync(localPath);
  } catch {
    throw new RunpodAssetError(`local file does not exist: ${path.basename(localPath)}`, op, "local_file");
  }
  if (!st.isFile()) throw new RunpodAssetError(`not a regular file: ${path.basename(localPath)}`, op, "local_file");
  return st;
}

function fsyncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // best effort (not supported on every platform)
  }
}

// ── API ──────────────────────────────────────────────────────────────────────────────

/** Whether an object exists, and its size. HeadObject only — never a listing. */
export async function headRunpodAsset(remotePath: string, opts: AssetRequestOptions = {}): Promise<HeadResult> {
  const key = validateRunpodAssetPath(remotePath, "head");
  const cfg = readRunpodS3Config();
  const s3 = clientFor(cfg);
  try {
    return await withRetry("head", cfg, GET_ATTEMPTS, opts, async () => {
      const r = await s3.send(new HeadObjectCommand({ Bucket: cfg.volumeId, Key: key }), { abortSignal: opts.signal });
      return { exists: true, bytes: typeof r.ContentLength === "number" ? r.ContentLength : undefined };
    });
  } catch (e) {
    if (e instanceof RunpodAssetError && e.code === "not_found") return { exists: false };
    throw e;
  }
}

/**
 * Upload a local file to `remotePath` (PutObject, streamed). Resolves only once a HeadObject
 * shows the object with the uploaded size, i.e. once a worker can read it.
 */
export async function uploadRunpodAsset(localPath: string, remotePath: string, opts: AssetRequestOptions = {}): Promise<UploadResult> {
  const key = validateRunpodAssetPath(remotePath, "upload");
  const before = regularFile(localPath, "upload");
  if (before.size >= MAX_PUT_BYTES) {
    throw new RunpodAssetError("file is 500 MB or larger — Runpod PutObject cannot take it and multipart is not implemented", "upload", "too_large");
  }
  const cfg = readRunpodS3Config();
  const s3 = clientFor(cfg);
  const { sha256, bytes } = await sha256OfFile(localPath);

  await withRetry("upload", cfg, PUT_ATTEMPTS, opts, async () => {
    // A fresh stream per attempt (a stream cannot be replayed), always closed afterwards: a
    // request that fails before consuming it would otherwise leak its file descriptor.
    const body = fs.createReadStream(localPath);
    try {
      await s3.send(
        new PutObjectCommand({ Bucket: cfg.volumeId, Key: key, Body: body, ContentLength: bytes }),
        { abortSignal: opts.signal }
      );
    } finally {
      // destroy() alone can leave the deferred open() in flight; wait until it is closed.
      if (!body.closed) {
        const closed = new Promise<void>((resolve) => body.once("close", () => resolve()));
        body.destroy();
        await closed;
      }
    }
  });

  const after = fs.statSync(localPath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new RunpodAssetError("local file changed during upload", "upload", "integrity");
  }
  const head = await headRunpodAsset(key, opts);
  if (!head.exists || (head.bytes !== undefined && head.bytes !== bytes)) {
    throw new RunpodAssetError(`uploaded object is not visible with the expected size (${bytes} bytes)`, "upload", "integrity");
  }
  return { path: key, bytes, sha256 };
}

/**
 * Download `remotePath` to `localPath` atomically: streamed into a temporary file in the
 * destination's directory while hashing, size/hash verified, fsynced, then renamed. On any
 * failure the temporary file is removed and an existing `localPath` is left untouched.
 */
export async function downloadRunpodAsset(
  remotePath: string,
  localPath: string,
  opts: AssetRequestOptions & { expectedBytes?: number; expectedSha256?: string } = {}
): Promise<DownloadResult> {
  const key = validateRunpodAssetPath(remotePath, "download");
  if (!path.isAbsolute(localPath)) throw new RunpodAssetError("local path must be absolute", "download", "local_file");
  if (opts.expectedSha256 !== undefined && !SHA256_RE.test(opts.expectedSha256)) {
    throw new RunpodAssetError("expectedSha256 must be 64 lowercase hex characters", "download", "integrity");
  }
  if (opts.expectedBytes !== undefined && !(Number.isInteger(opts.expectedBytes) && opts.expectedBytes >= 0)) {
    throw new RunpodAssetError("expectedBytes must be a non-negative integer", "download", "integrity");
  }
  const cfg = readRunpodS3Config();
  const s3 = clientFor(cfg);
  const dir = path.dirname(localPath);
  fs.mkdirSync(dir, { recursive: true });

  return withRetry("download", cfg, GET_ATTEMPTS, opts, async () => {
    const tmp = path.join(dir, `.${path.basename(localPath)}.partial-${crypto.randomUUID()}`);
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: cfg.volumeId, Key: key }), { abortSignal: opts.signal });
      const body = r.Body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== "function") {
        throw new RunpodAssetError("GetObject returned no readable body", "download", "network");
      }
      const h = crypto.createHash("sha256");
      const counter = { bytes: 0 };
      await pipeline(body, hashTap(h, counter), fs.createWriteStream(tmp, { flags: "wx" }));
      const sha256 = h.digest("hex");
      const bytes = counter.bytes;
      if (typeof r.ContentLength === "number" && r.ContentLength !== bytes) {
        throw new RunpodAssetError(`download truncated: ${bytes} of ${r.ContentLength} bytes`, "download", "network");
      }
      if (opts.expectedBytes !== undefined && bytes !== opts.expectedBytes) {
        throw new RunpodAssetError(`size mismatch: got ${bytes} bytes, expected ${opts.expectedBytes}`, "download", "integrity");
      }
      if (opts.expectedSha256 !== undefined && sha256 !== opts.expectedSha256) {
        throw new RunpodAssetError("sha256 mismatch", "download", "integrity");
      }
      const fd = fs.openSync(tmp, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, localPath);
      fsyncDir(dir);
      return { localPath, bytes, sha256 };
    } finally {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean
      }
    }
  });
}

/** Delete one object (DeleteObject). Deleting a missing key succeeds. */
export async function deleteRunpodAsset(remotePath: string, opts: AssetRequestOptions = {}): Promise<void> {
  const key = validateRunpodAssetPath(remotePath, "delete");
  const cfg = readRunpodS3Config();
  const s3 = clientFor(cfg);
  try {
    await withRetry("delete", cfg, DELETE_ATTEMPTS, opts, async () => {
      await s3.send(new DeleteObjectCommand({ Bucket: cfg.volumeId, Key: key }), { abortSignal: opts.signal });
    });
  } catch (e) {
    if (e instanceof RunpodAssetError && e.code === "not_found") return;
    throw e;
  }
}
