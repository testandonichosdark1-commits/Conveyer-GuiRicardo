import { kenBurns } from "./ken-burns";

/**
 * The ONE seam between "this beat has a still image" and "this beat has an mp4".
 *
 * Every still → beat-clip conversion in visual-source.ts (real stills, every AI image
 * provider, the Flow/Vids/chain fallbacks, manual generation) calls `animateStill`
 * instead of an animator directly, so the mechanism that animates a still can change
 * here without touching any of those call sites again.
 *
 * Today Ken Burns is the only animator, and `animateStill` is a pure pass-through to
 * the existing `kenBurns()` — same arguments, same ffmpeg command, same errors. There is
 * deliberately no setting: an animator option that cannot actually animate would be a
 * dead control. A future animator is added to `ANIMATORS` and chosen in
 * `resolveStillAnimator`, whose answer must stay "kenburns" when nothing is configured.
 *
 * It is async although Ken Burns is synchronous, because any non-local animator will
 * not be. Callers `await` it inside the same try/catch as before, so a Ken Burns
 * failure still surfaces at the same point with the same message.
 */

export interface AnimateStillInput {
  /** The still to animate. Never modified or deleted here — cleanup stays with the caller. */
  imagePath: string;
  /** The beat clip to write. */
  outPath: string;
  durationSec: number;
  /** Ken Burns direction (callers pass `beat.index % 2 === 1`, alternating per beat). */
  zoomOut: boolean;
  /** "WxH" output size; undefined falls back to VIDEO_RESOLUTION exactly as kenBurns does. */
  resolution?: string;
}

export type StillAnimatorId = "kenburns";

type StillAnimator = (input: AnimateStillInput) => Promise<void>;

const ANIMATORS: Record<StillAnimatorId, StillAnimator> = {
  kenburns: async ({ imagePath, outPath, durationSec, zoomOut, resolution }) => {
    kenBurns(imagePath, outPath, durationSec, zoomOut, resolution);
  },
};

/** Which animator handles a still. No configuration exists yet, so always Ken Burns. */
export function resolveStillAnimator(): StillAnimatorId {
  return "kenburns";
}

export async function animateStill(input: AnimateStillInput): Promise<void> {
  await ANIMATORS[resolveStillAnimator()](input);
}
