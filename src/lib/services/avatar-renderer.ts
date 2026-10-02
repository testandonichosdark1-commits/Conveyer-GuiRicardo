import {
  generateAvatarClip as generateHeygenAvatarClip,
  type AvatarHandle as HeygenAvatarHandle,
} from "./heygen-video";

/**
 * The avatar renderer seam: the pipeline asks for "a talking-head clip of this avatar
 * speaking this audio slice" and this module decides WHICH service renders it.
 *
 * Today HeyGen is the only renderer, and `generateAvatarClip` is a pure pass-through
 * to heygen-video.ts — same arguments, same requests, same polling, retries, engines
 * and billing. There is no setting and no UI: the renderer is snapshotted onto
 * `runs.avatar_renderer` when a run is created, and NULL (every run made before the
 * column existed) means "heygen".
 *
 * Adding a renderer later means: a new id in `AvatarRendererId`, a new member of the
 * `AvatarHandle` union carrying ITS fields, and a new `case` below. Pipeline callers do
 * not change — they pass the handle they read from the run snapshot.
 */

export type AvatarRendererId = "heygen";

/** The renderer a NEW run records, and what a NULL snapshot means. */
export const DEFAULT_AVATAR_RENDERER: AvatarRendererId = "heygen";

/**
 * What the pipeline holds for a run's avatar: the renderer discriminant plus that
 * renderer's own handle. A union of one member today.
 */
export type AvatarHandle = HeygenAvatarHandle & { renderer: "heygen" };

/**
 * Decode the snapshotted renderer. NULL / empty = heygen, which is exactly what every
 * pre-column run rendered with. Any other unknown value THROWS rather than falling
 * back: a run must replay the renderer it was created with, never a substitute —
 * same rule as decodeEngine / decodeApiEngine in studio-pipeline.ts.
 */
export function decodeAvatarRenderer(raw: string | null | undefined): AvatarRendererId {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_AVATAR_RENDERER;
  if (raw === "heygen") return "heygen";
  throw new Error(`Unknown avatar renderer "${raw}" on this run — refusing to guess which service renders it.`);
}

/**
 * Render one avatar clip for `audioPath` into `outPath`; resolves to the written path.
 * The renderer's own handle is passed on WITHOUT the `renderer` discriminant, so the
 * implementation receives exactly the object it received before this seam existed.
 */
export async function generateAvatarClip(
  runId: string,
  avatar: AvatarHandle,
  audioPath: string,
  outPath: string,
  opts: Parameters<typeof generateHeygenAvatarClip>[4] = {}
): Promise<string> {
  const { renderer, ...handle } = avatar;
  switch (renderer) {
    case "heygen":
      return generateHeygenAvatarClip(runId, handle, audioPath, outPath, opts);
    default: {
      const unreachable: never = renderer;
      throw new Error(`Unknown avatar renderer "${String(unreachable)}"`);
    }
  }
}
