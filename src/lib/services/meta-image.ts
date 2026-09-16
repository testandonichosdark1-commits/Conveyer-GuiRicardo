import fs from "node:fs/promises";
import sharp from "sharp";

export class MetaImageError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly metaCode?: string | number,
    public readonly metaDetails?: string
  ) {
    super(message);
    this.name = "MetaImageError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  return trimmed || "https://api.meta.ai/v1";
}

function buildPayloads(model: string, prompt: string, aspectRatio: "16:9" | "9:16") {
  const aspect = aspectRatio;
  return [
    { model, prompt, response_format: "b64_json", size: aspect },
    { model, prompt, response_format: "b64_json", aspect_ratio: aspect },
    { model, prompt, size: aspect },
    { model, prompt, aspect_ratio: aspect },
    { model, prompt },
  ];
}

async function fetchBinary(url: string, apiKey: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new MetaImageError(`Meta image download failed: HTTP ${res.status}`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new MetaImageError("Meta image download returned an empty body");
  return buf;
}

function parseJsonError(json: any, status?: number): MetaImageError {
  const err = json?.error ?? json?.errors?.[0] ?? json;
  const code = err?.code ?? err?.type;
  const message = err?.message ?? err?.error ?? err?.detail ?? `HTTP ${status ?? "error"}`;
  return new MetaImageError(`Meta API error${status ? ` HTTP ${status}` : ""}${code ? ` / ${code}` : ""}: ${String(message)}`.slice(0, 300), status, code, String(message));
}

async function saveFromJson(json: any, apiKey: string, outPath: string): Promise<void> {
  const item = json?.data?.[0] ?? json?.output?.[0] ?? json?.result?.[0] ?? json?.result ?? json?.image ?? null;
  const b64 = item?.b64_json ?? item?.base64 ?? item?.image_base64 ?? json?.b64_json ?? json?.base64;
  if (typeof b64 === "string" && b64.trim()) {
    await sharp(Buffer.from(b64, "base64")).png().toFile(outPath);
    return;
  }
  const url = item?.url ?? item?.image_url ?? json?.url ?? json?.image_url;
  if (typeof url === "string" && url.trim()) {
    const buf = await fetchBinary(url, apiKey);
    await sharp(buf).png().toFile(outPath);
    return;
  }
  throw new MetaImageError("Meta response contained no image data");
}

export async function generateMetaImage(
  prompt: string,
  outPath: string,
  aspectRatio: "16:9" | "9:16",
  opts: { apiKey: string; baseUrl?: string; model?: string }
): Promise<{ baseUrl: string; model: string }> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new MetaImageError("Meta API key is required");
  const baseUrl = normalizeBaseUrl(opts.baseUrl || "https://api.meta.ai/v1");
  const model = (opts.model || "muse-image-1.0").trim() || "muse-image-1.0";
  const endpoint = `${baseUrl}/images/generations`;

  let lastError: MetaImageError | null = null;
  for (const payload of buildPayloads(model, prompt, aspectRatio)) {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      throw new MetaImageError(`Meta API request failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const contentType = res.headers.get("content-type") || "";
    if (res.ok && contentType.startsWith("image/")) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new MetaImageError("Meta returned an empty image response");
      await sharp(buf).png().toFile(outPath);
      return { baseUrl, model };
    }

    let parsed: any = null;
    let raw = "";
    try {
      if (contentType.includes("application/json")) parsed = await res.json();
      else raw = await res.text();
    } catch {}

    if (res.ok) {
      try {
        await saveFromJson(parsed ?? raw, apiKey, outPath);
        return { baseUrl, model };
      } catch (e) {
        lastError = e instanceof MetaImageError ? e : new MetaImageError(e instanceof Error ? e.message : String(e));
        continue;
      }
    }

    const err = parsed ? parseJsonError(parsed, res.status) : new MetaImageError(`Meta API error HTTP ${res.status}: ${raw.slice(0, 220)}`, res.status);
    // Try the next payload variant only for 400-ish shape/validation problems.
    if (res.status === 400 || res.status === 404 || res.status === 422) {
      lastError = err;
      continue;
    }
    throw err;
  }

  throw lastError ?? new MetaImageError("Meta image generation failed");
}
