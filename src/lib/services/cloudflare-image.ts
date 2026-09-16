import sharp from "sharp";
import { getSetting } from "../settings";
import { checkCancelled } from "../cancellation";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const CLOUDFLARE_TIMEOUT_MS = 90_000;
const CLOUDFLARE_OUT_OF_CAPACITY_ATTEMPTS = 3;
const CLOUDFLARE_OUT_OF_CAPACITY_BACKOFF_MS = [2_000, 5_000];

export interface CloudflareRetryInfo {
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  status?: number;
  code?: number;
  message: string;
  profileId?: string;
  profileLabel?: string;
}

export interface CloudflareProfileFailoverInfo {
  fromProfileId: string;
  fromProfileLabel: string;
  toProfileId: string;
  toProfileLabel: string;
  status?: number;
  code?: number;
  message: string;
}

export interface CloudflareGenerationHooks {
  onRetry?: (info: CloudflareRetryInfo) => void;
  onProfileFailover?: (info: CloudflareProfileFailoverInfo) => void;
}

export interface CloudflareGenerationResult {
  profileId: string;
  profileLabel: string;
}

export interface CloudflareProfileSummary {
  id: string;
  label: string;
  slot: number;
  accountHint: string;
}

type CloudflareProfile = CloudflareProfileSummary & {
  accountId: string;
  token: string;
};

export class CloudflareImageError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cfCode?: number,
    public readonly cfMessage?: string,
    public readonly profileId?: string,
    public readonly profileLabel?: string
  ) {
    super(message);
    this.name = "CloudflareImageError";
  }
}

const PROFILE_SETTINGS = [
  { slot: 1, id: "primary", label: "Primary", accountKey: "CLOUDFLARE_ACCOUNT_ID", tokenKey: "CLOUDFLARE_API_TOKEN" },
  { slot: 2, id: "backup-1", label: "Backup 1", accountKey: "CLOUDFLARE_ACCOUNT_ID_2", tokenKey: "CLOUDFLARE_API_TOKEN_2" },
  { slot: 3, id: "backup-2", label: "Backup 2", accountKey: "CLOUDFLARE_ACCOUNT_ID_3", tokenKey: "CLOUDFLARE_API_TOKEN_3" },
  { slot: 4, id: "backup-3", label: "Backup 3", accountKey: "CLOUDFLARE_ACCOUNT_ID_4", tokenKey: "CLOUDFLARE_API_TOKEN_4" },
] as const;

// A credential/configuration failure is effectively permanent for the current video run.
// Remember it so later beats do not repeatedly hit the same broken profile. Transient provider
// failures are NOT cached here; the primary is eligible again on a later beat.
const disabledProfilesByRun = new Map<string, Set<string>>();

function accountHint(accountId: string): string {
  const v = accountId.trim();
  if (v.length <= 8) return v ? `…${v.slice(-4)}` : "";
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function configuredProfiles(runId = ""): CloudflareProfile[] {
  const disabled = runId ? disabledProfilesByRun.get(runId) : undefined;
  const out: CloudflareProfile[] = [];
  for (const spec of PROFILE_SETTINGS) {
    const accountId = getSetting(spec.accountKey).trim();
    const token = getSetting(spec.tokenKey).trim();
    if (!accountId || !token || disabled?.has(spec.id)) continue;
    out.push({
      id: spec.id,
      label: spec.label,
      slot: spec.slot,
      accountHint: accountHint(accountId),
      accountId,
      token,
    });
  }
  return out;
}

export function getCloudflareProfileSummaries(): CloudflareProfileSummary[] {
  return configuredProfiles("").map(({ id, label, slot, accountHint }) => ({ id, label, slot, accountHint }));
}

export function cloudflareImageConfigured(): boolean {
  return configuredProfiles("").length > 0;
}

export function isCloudflareDailyQuotaError(error: unknown): boolean {
  if (!(error instanceof CloudflareImageError)) return false;
  const msg = `${error.cfMessage || ""} ${error.message || ""}`.toLowerCase();
  if (error.status !== 429) return false;
  return (
    error.cfCode === 3036 ||
    error.cfCode === 4006 ||
    msg.includes("daily free allocation") ||
    msg.includes("daily allocation exhausted") ||
    msg.includes("used up your daily") ||
    (msg.includes("10,000") && msg.includes("neuron"))
  );
}

function isPermanentProfileProblem(error: CloudflareImageError): boolean {
  if (error.status === 401 || error.status === 403 || error.status === 404) return true;
  if (error.status !== 400) return false;
  const msg = `${error.cfMessage || ""} ${error.message || ""}`.toLowerCase();
  return ["account", "token", "credential", "auth", "permission", "not found"].some((s) => msg.includes(s));
}

function isTransientAvailabilityProblem(error: CloudflareImageError): boolean {
  if (error.status === undefined) return true; // network / timeout / transport
  if (error.status >= 500 && error.status <= 599) return true;
  return error.status === 429 && error.cfCode === 3040; // Cloudflare "Out of capacity"
}

function shouldFailoverProfile(error: CloudflareImageError): boolean {
  // Daily quota/rate-limit exhaustion must NOT rotate through accounts. Production falls back
  // to the next provider (kie.ai) instead. Unknown 429s are also kept on the provider fallback
  // path rather than being used to hop profiles.
  if (isCloudflareDailyQuotaError(error)) return false;
  if (error.status === 429 && error.cfCode !== 3040) return false;
  return isPermanentProfileProblem(error) || isTransientAvailabilityProblem(error);
}

function markProfileDisabledForRun(runId: string, profileId: string) {
  if (!runId) return;
  let set = disabledProfilesByRun.get(runId);
  if (!set) {
    set = new Set<string>();
    disabledProfilesByRun.set(runId, set);
  }
  set.add(profileId);
}

function sizeForAspect(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === "9:16") return { width: 576, height: 1024 };
  return { width: 1024, height: 576 };
}

function decodeBase64Image(value: string): Buffer {
  const trimmed = value.trim();
  const payload = trimmed.startsWith("data:") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  const buf = Buffer.from(payload, "base64");
  if (!buf.length) throw new CloudflareImageError("Cloudflare returned an empty image payload");
  return buf;
}

function toFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function parseCloudflareErrorPayload(
  status: number | undefined,
  text: string
): { message: string; code?: number } {
  const fallback = (text || "").trim().slice(0, 220) || `HTTP ${status ?? "error"}`;

  try {
    const parsed = JSON.parse(text) as {
      errors?: Array<{ code?: number | string; message?: string }>;
      result?: { response?: string; error?: string };
      message?: string;
      error?: string;
    };
    const first = Array.isArray(parsed?.errors) ? parsed.errors.find(Boolean) : undefined;
    const code = toFiniteNumber(first?.code);
    const message =
      first?.message?.trim() ||
      parsed?.result?.response?.trim() ||
      parsed?.result?.error?.trim() ||
      parsed?.message?.trim() ||
      parsed?.error?.trim() ||
      fallback;
    return { message, code };
  } catch {
    const code = toFiniteNumber(text.match(/"code"\s*:\s*(\d+)/)?.[1]);
    const message = text.match(/"message"\s*:\s*"([^"]{1,180})"/)?.[1]?.trim() || fallback;
    return { message, code };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestCloudflareImage(
  endpoint: string,
  token: string,
  prompt: string,
  width: number,
  height: number
): Promise<Response> {
  const form = new FormData();
  form.append("prompt", prompt.slice(0, 5000));
  form.append("width", String(width));
  form.append("height", String(height));

  try {
    return await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      // FLUX.2 Klein requires multipart/form-data even for text-only generation.
      // Do NOT set Content-Type manually: fetch adds the required multipart boundary.
      body: form,
      signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new CloudflareImageError(`Cloudflare request failed: ${msg}`);
  }
}

async function saveCloudflareResponseImage(response: Response, outPath: string): Promise<void> {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.startsWith("image/")) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new CloudflareImageError("Cloudflare returned an empty image response");
    await sharp(bytes).png().toFile(outPath);
    return;
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new CloudflareImageError(`Cloudflare returned an unexpected content type: ${contentType || "unknown"}`);
  }

  const obj = json as {
    success?: boolean;
    result?: { image?: string } | string;
    image?: string;
    errors?: Array<{ code?: number | string; message?: string }>;
    message?: string;
  };
  if (obj.success === false) {
    const first = obj.errors?.find(Boolean);
    const code = toFiniteNumber(first?.code);
    const msg = first?.message?.trim() || obj.message?.trim() || "unknown API error";
    throw new CloudflareImageError(`Cloudflare generation failed${code ? ` / ${code}` : ""}: ${msg}`, undefined, code, msg);
  }

  const base64 =
    typeof obj.result === "string"
      ? obj.result
      : typeof obj.result?.image === "string"
        ? obj.result.image
        : typeof obj.image === "string"
          ? obj.image
          : "";

  if (!base64) throw new CloudflareImageError("Cloudflare response contained no image data");
  await sharp(decodeBase64Image(base64)).png().toFile(outPath);
}

async function generateWithProfile(
  runId: string,
  profile: CloudflareProfile,
  model: string,
  prompt: string,
  outPath: string,
  width: number,
  height: number,
  hooks: CloudflareGenerationHooks
): Promise<void> {
  const endpoint = `${CLOUDFLARE_API_BASE}/accounts/${encodeURIComponent(profile.accountId)}/ai/run/${model}`;
  let lastErr: CloudflareImageError | null = null;

  for (let attempt = 0; attempt < CLOUDFLARE_OUT_OF_CAPACITY_ATTEMPTS; attempt++) {
    if (runId) checkCancelled(runId);
    try {
      const response = await requestCloudflareImage(endpoint, profile.token, prompt, width, height);
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const parsed = parseCloudflareErrorPayload(response.status, text);
        throw new CloudflareImageError(
          `Cloudflare HTTP ${response.status}${parsed.code ? ` / ${parsed.code}` : ""}: ${parsed.message}`,
          response.status,
          parsed.code,
          parsed.message,
          profile.id,
          profile.label
        );
      }
      if (runId) checkCancelled(runId);
      await saveCloudflareResponseImage(response, outPath);
      return;
    } catch (e) {
      const base = e instanceof CloudflareImageError
        ? e
        : new CloudflareImageError(e instanceof Error ? e.message : String(e));
      const err = base.profileId
        ? base
        : new CloudflareImageError(base.message, base.status, base.cfCode, base.cfMessage, profile.id, profile.label);
      lastErr = err;

      const shouldRetry = err.status === 429 && err.cfCode === 3040 && attempt < CLOUDFLARE_OUT_OF_CAPACITY_ATTEMPTS - 1;
      if (shouldRetry) {
        const delayMs = CLOUDFLARE_OUT_OF_CAPACITY_BACKOFF_MS[attempt] ?? 5_000;
        hooks.onRetry?.({
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          delayMs,
          status: err.status,
          code: err.cfCode,
          message: err.cfMessage || err.message,
          profileId: profile.id,
          profileLabel: profile.label,
        });
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }

  throw lastErr ?? new CloudflareImageError("Cloudflare generation failed for an unknown reason", undefined, undefined, undefined, profile.id, profile.label);
}

/**
 * Generate ONE text-to-image first-pass through Cloudflare Workers AI and save it locally.
 * Profiles are tried in deterministic order: Primary, Backup 1, Backup 2, Backup 3.
 * Backup profiles are ONLY operational redundancy. Daily allocation exhaustion (3036/4006
 * or the matching error text) never hops accounts; it returns immediately so production can
 * move to kie.ai. Unknown/rate-limit 429s likewise do not rotate profiles.
 */
export async function generateCloudflareImage(
  runId: string,
  prompt: string,
  outPath: string,
  aspectRatio = "16:9",
  hooks: CloudflareGenerationHooks = {}
): Promise<CloudflareGenerationResult> {
  if (runId) checkCancelled(runId);

  const profiles = configuredProfiles(runId);
  const model = (getSetting("CLOUDFLARE_IMAGE_MODEL") || "@cf/black-forest-labs/flux-2-klein-4b").trim();
  if (!profiles.length) throw new CloudflareImageError("Cloudflare Workers AI has no complete configured profile");

  const { width, height } = sizeForAspect(aspectRatio);
  let lastErr: CloudflareImageError | null = null;

  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    try {
      await generateWithProfile(runId, profile, model, prompt, outPath, width, height, hooks);
      return { profileId: profile.id, profileLabel: profile.label };
    } catch (e) {
      const err = e instanceof CloudflareImageError
        ? e
        : new CloudflareImageError(e instanceof Error ? e.message : String(e), undefined, undefined, undefined, profile.id, profile.label);
      lastErr = err;

      if (isCloudflareDailyQuotaError(err)) throw err;
      if (isPermanentProfileProblem(err)) markProfileDisabledForRun(runId, profile.id);

      const next = profiles[i + 1];
      if (!next || !shouldFailoverProfile(err)) throw err;

      hooks.onProfileFailover?.({
        fromProfileId: profile.id,
        fromProfileLabel: profile.label,
        toProfileId: next.id,
        toProfileLabel: next.label,
        status: err.status,
        code: err.cfCode,
        message: err.cfMessage || err.message,
      });
    }
  }

  throw lastErr ?? new CloudflareImageError("Cloudflare generation failed for an unknown reason");
}
