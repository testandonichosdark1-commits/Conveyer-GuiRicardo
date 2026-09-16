import sharp from "sharp";
import { getSetting } from "../settings";

const POLLINATIONS_BASE_URL = "https://gen.pollinations.ai";
const POLLINATIONS_TIMEOUT_MS = 90_000;

export class PollinationsImageError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly pollinationsCode?: string | number,
    public readonly pollinationsDetails?: string
  ) {
    super(message);
    this.name = "PollinationsImageError";
  }
}

export function pollinationsImageConfigured(): boolean {
  return !!getSetting("POLLINATIONS_API_KEY").trim();
}

function sizeForAspect(aspectRatio: string): string {
  return aspectRatio === "9:16" ? "576x1024" : "1024x576";
}

function parseError(json: unknown, status: number): PollinationsImageError {
  const obj = (json && typeof json === "object" ? json : {}) as {
    error?: { code?: string | number; message?: string } | string;
    message?: string;
    code?: string | number;
  };
  const nested = typeof obj.error === "object" && obj.error ? obj.error : undefined;
  const code = nested?.code ?? obj.code;
  const details = nested?.message ?? (typeof obj.error === "string" ? obj.error : undefined) ?? obj.message ?? `HTTP ${status}`;
  return new PollinationsImageError(
    `Pollinations HTTP ${status}${code ? ` / ${code}` : ""}: ${String(details)}`.slice(0, 320),
    status,
    code,
    String(details)
  );
}

export async function generatePollinationsImage(
  prompt: string,
  outPath: string,
  aspectRatio = "16:9",
  opts?: { apiKey?: string; model?: string }
): Promise<{ model: string }> {
  const apiKey = (opts?.apiKey ?? getSetting("POLLINATIONS_API_KEY")).trim();
  if (!apiKey) throw new PollinationsImageError("Pollinations API key is not configured");

  // zimage is Pollinations' current default image model and is a strong fit for fast
  // photorealistic B-roll. Keep this setting editable so the model can be swapped later
  // without another code update.
  const model = (opts?.model ?? getSetting("POLLINATIONS_IMAGE_MODEL") ?? "zimage").trim() || "zimage";

  let response: Response;
  try {
    response = await fetch(`${POLLINATIONS_BASE_URL}/v1/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: prompt.slice(0, 12000),
        n: 1,
        size: sizeForAspect(aspectRatio),
        quality: "medium",
        response_format: "b64_json",
        safe: true,
      }),
      signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS),
    });
  } catch (e) {
    throw new PollinationsImageError(`Pollinations request failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const contentType = response.headers.get("content-type") || "";
  let json: any = null;
  let raw = "";
  try {
    if (contentType.includes("application/json")) json = await response.json();
    else raw = await response.text();
  } catch {}

  if (!response.ok) {
    if (json) throw parseError(json, response.status);
    throw new PollinationsImageError(`Pollinations HTTP ${response.status}: ${raw.slice(0, 240)}`, response.status, undefined, raw.slice(0, 240));
  }

  const item = json?.data?.[0] ?? json?.result?.[0] ?? json?.result ?? null;
  const b64 = item?.b64_json ?? item?.base64 ?? json?.b64_json ?? json?.base64;
  if (typeof b64 === "string" && b64.trim()) {
    await sharp(Buffer.from(b64, "base64")).png().toFile(outPath);
    return { model };
  }

  const url = item?.url ?? item?.image_url ?? json?.url ?? json?.image_url;
  if (typeof url === "string" && url.trim()) {
    const imageRes = await fetch(url, { signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS) });
    if (!imageRes.ok) throw new PollinationsImageError(`Pollinations image download failed: HTTP ${imageRes.status}`, imageRes.status);
    const bytes = Buffer.from(await imageRes.arrayBuffer());
    if (!bytes.length) throw new PollinationsImageError("Pollinations returned an empty image response");
    await sharp(bytes).png().toFile(outPath);
    return { model };
  }

  throw new PollinationsImageError("Pollinations response contained no image data");
}
