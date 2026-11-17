/**
 * Beats whose visual failed are absorbed by an ADJACENT beat, never filled with a copy of
 * another beat's clip.
 *
 * The old fill gave such a beat the nearest neighbour's file, so the same shot played twice
 * (restarting from its first frame). That reads as a glitch, and the operator asked that an
 * asset is never shown twice. Here the gap's time is handed to the previous beat (its clip
 * simply keeps running), or to the next one when there is no usable previous beat. The
 * timeline stays contiguous (startMs/endMs telescope), so the voiceover sync is unchanged.
 *
 * A full "avatar" beat is never a host: its clip is lip-synced to its own slice of audio, and
 * stretching it would freeze the face. A split beat that lost its b-roll still has its
 * avatar clip, which renderBeat shows full-screen, so it needs no fill at all.
 */
import type { RenderBeat } from "./studio-assemble";

export interface GapFillResult {
  beats: RenderBeat[];
  /** Beat indexes whose time was given to a neighbour. */
  absorbed: number[];
  /** Beats that still have no visual (no possible host): the caller renders a placeholder. */
  orphans: RenderBeat[];
}

function needsVisual(b: RenderBeat): boolean {
  if (b.visualPath) return false;
  if (b.layout === "avatar") return false;
  if (b.avatarClipPath) return false; // split without b-roll → full-screen avatar
  return true;
}

function canHost(b: RenderBeat): boolean {
  return !!b.visualPath && b.layout !== "avatar";
}

export function absorbFailedBeats(input: RenderBeat[]): GapFillResult {
  const out: RenderBeat[] = [];
  const absorbed: number[] = [];
  // Gaps waiting for the next host (no usable previous beat).
  let pending: RenderBeat[] = [];

  const giveOverlay = (host: RenderBeat, from: RenderBeat) => {
    if (!host.overlay && from.overlay) host.overlay = from.overlay;
  };

  for (const src of input) {
    const b: RenderBeat = { ...src };
    if (needsVisual(b)) {
      const prev = out[out.length - 1];
      if (prev && canHost(prev) && pending.length === 0) {
        prev.endMs = b.endMs;
        if (b.text) prev.text = `${prev.text} ${b.text}`.trim();
        giveOverlay(prev, b);
        absorbed.push(b.index);
      } else {
        pending.push(b);
      }
      continue;
    }
    if (pending.length > 0) {
      if (canHost(b)) {
        b.startMs = pending[0].startMs;
        b.text = `${pending.map((p) => p.text).join(" ")} ${b.text}`.trim();
        for (const p of pending) {
          giveOverlay(b, p);
          absorbed.push(p.index);
        }
      } else {
        // Not a host (avatar): the gaps keep their own slot and stay orphaned.
        out.push(...pending);
      }
      pending = [];
    }
    out.push(b);
  }
  out.push(...pending);
  const orphans = out.filter(needsVisual);
  return { beats: out, absorbed, orphans };
}
