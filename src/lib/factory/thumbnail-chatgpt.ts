/**
 * The finished thumbnail — scene, both questions and the red arrow — drawn in ONE image by
 * ChatGPT, through the operator's own ChatGPT/Codex account (the same connection the LTX stills
 * use, services/codex-image-runtime.ts). No API key and no per-image bill: it spends the plan's
 * image quota. Measured on the SEAL/SBS package: ~48 s, 1672×941 PNG, text spelled correctly.
 *
 * The prompt is the skill's own "all-in-one" prompt (text + arrow included), so there is no
 * local text/arrow compositing any more.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { codexImageConfigured, codexImageProfile, connectImageDriver } from "../services/codex-image-runtime";

export class ChatGptThumbnailError extends Error {}

const specSchema = z.object({
  fullPrompt: z.string().min(80, "fullPrompt is missing or too short"),
  yellow: z.string().optional(),
  white: z.string().optional(),
});
export type ChatGptThumbnailSpec = z.infer<typeof specSchema>;

export function readChatGptThumbnailSpec(file: string): ChatGptThumbnailSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new ChatGptThumbnailError("thumbnail.json is not valid JSON");
  }
  const r = specSchema.safeParse(raw);
  if (!r.success) throw new ChatGptThumbnailError(`thumbnail.json: ${r.error.issues.map((i) => i.message).join("; ")}`);
  return r.data;
}

/** The skill's prompt plus the one thing the image tool must not get wrong. */
export function chatGptThumbnailPrompt(spec: ChatGptThumbnailSpec): string {
  const lines = [spec.fullPrompt.trim()];
  if (spec.yellow && spec.white) {
    lines.push(`The only words in the image are exactly "${spec.yellow}" and "${spec.white}", spelled exactly like that. No other text, logos or watermarks.`);
  }
  lines.push("Wide horizontal 16:9 image.");
  return lines.join("\n\n");
}

/** Generates the thumbnail and writes a 1280×720 JPEG (YouTube's size) to `outJpg`. */
export async function generateThumbnailWithChatGpt(spec: ChatGptThumbnailSpec, outJpg: string): Promise<{ sourcePng: string }> {
  if (!(await codexImageConfigured())) {
    throw new ChatGptThumbnailError("ChatGPT image account is not set up on this Mac (Codex image profile missing)");
  }
  const profile = codexImageProfile();
  const driver = await connectImageDriver(profile.model);
  let saved: string | null | undefined;
  try {
    const r = await driver.generate(chatGptThumbnailPrompt(spec), async () => {});
    saved = r.image.savedPath;
  } finally {
    await driver.close();
  }
  if (!saved || !path.isAbsolute(saved)) throw new ChatGptThumbnailError("ChatGPT returned no image");
  // Only accept a file inside the account's generated_images tree.
  const root = fs.realpathSync(path.join(profile.accountHome, "generated_images"));
  const real = fs.realpathSync(saved);
  if (path.relative(root, real).startsWith("..")) throw new ChatGptThumbnailError("image outside the ChatGPT images folder");
  const dir = path.dirname(outJpg);
  const sourcePng = path.join(dir, "thumbnail-chatgpt.png");
  fs.copyFileSync(real, sourcePng);
  await sharp(sourcePng).resize(1280, 720, { fit: "cover", position: "centre" }).jpeg({ quality: 90 }).toFile(outJpg);
  return { sourcePng };
}
