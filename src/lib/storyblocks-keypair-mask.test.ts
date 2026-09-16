import { describe, it, expect } from "vitest";

/**
 * The mask round-trip for STORYBLOCKS_API_KEYS — the riskiest part of the two-field UI.
 *
 * A pair is stored as "public:private" on one line, and the settings page splits that
 * colon into two boxes. So the mask MUST keep the colon and hide each half separately;
 * masking the line as one blob would swallow the colon and leave the pair unsplittable.
 * And the save path must turn the masked form back into the real pair, or an operator
 * who opens Settings, adds a second pair and clicks Save would DESTROY the first one.
 *
 * The two pure halves of that contract are reimplemented here because the originals sit
 * inside DB and route code that cannot be imported into a unit test. Each mirrors the
 * shipped logic line for line, is exercised on realistic key shapes, and every positive
 * case is paired with a control that must NOT resolve — a matcher that returned the
 * first stored pair regardless would pass the first half and fail the second.
 */

const short = (x: string) => `${x.slice(0, 4)}…${x.slice(-4)}`;

/** Mirror of maskEntry() in settings.ts, STORYBLOCKS_API_KEYS branch. */
function maskPair(entry: string): string {
  const i = entry.indexOf(":");
  return i > 0 ? `${short(entry.slice(0, i))}:${short(entry.slice(i + 1))}` : short(entry);
}

/** Mirror of the STORYBLOCKS_API_KEYS re-hydration branch in app/api/settings/route.ts. */
function rehydrate(masked: string, existing: string[]): string | null {
  const c = masked.indexOf(":");
  if (c <= 0) return null;
  const pm = masked.slice(0, c).match(/^(.{1,4})…(.{1,4})$/);
  const sm = masked.slice(c + 1).match(/^(.{1,4})…(.{1,4})$/);
  return (
    existing.find((x) => {
      const j = x.indexOf(":");
      if (j <= 0) return false;
      const pub = x.slice(0, j);
      const priv = x.slice(j + 1);
      const pubOk = pm ? pub.startsWith(pm[1]) && pub.endsWith(pm[2]) : pub === masked.slice(0, c);
      const privOk = sm ? priv.startsWith(sm[1]) && priv.endsWith(sm[2]) : priv === masked.slice(c + 1);
      return pubOk && privOk;
    }) ?? null
  );
}

const PAIR_A = "test_8e00563433c04fd9a1c762389410c766363711c42468777ed264a240254:9f3a1c77b2e84d05a6c19e4477bb2d31";
const PAIR_B = "test_11223344556677889900aabbccddeeff00112233445566778899aabbcc:deadbeefcafef00d1234567890abcdef";

describe("Storyblocks key-pair mask round-trip", () => {
  it("keeps the colon so the UI can still split the pair into two boxes", () => {
    const m = maskPair(PAIR_A);
    expect(m.split(":")).toHaveLength(2);
    expect(m.split(":")[0]).toContain("…");
    expect(m.split(":")[1]).toContain("…");
  });

  it("hides BOTH halves — neither key is shown in full", () => {
    const m = maskPair(PAIR_A);
    const [pub, priv] = PAIR_A.split(":");
    expect(m).not.toContain(pub);
    expect(m).not.toContain(priv);
  });

  it("re-hydrates the exact original pair", () => {
    expect(rehydrate(maskPair(PAIR_A), [PAIR_A, PAIR_B])).toBe(PAIR_A);
    expect(rehydrate(maskPair(PAIR_B), [PAIR_A, PAIR_B])).toBe(PAIR_B);
  });

  it("THE REAL SCENARIO: adding a second pair does not destroy the first", () => {
    // Settings shows pair A masked; the operator types pair B into a new row and saves.
    const posted = [maskPair(PAIR_A), PAIR_B];
    const saved = posted.map((e) => (e.includes("…") ? rehydrate(e, [PAIR_A]) : e)).filter(Boolean);
    expect(saved).toEqual([PAIR_A, PAIR_B]);
  });

  it("CONTROL: a mask matching nothing stored resolves to null, not to a wrong pair", () => {
    expect(rehydrate(maskPair(PAIR_B), [PAIR_A])).toBeNull();
  });

  it("CONTROL: a public half that matches but a private half that does not is refused", () => {
    const [pubA] = PAIR_A.split(":");
    const impostor = `${short(pubA)}:${short("0000000000000000000000000000ffff")}`;
    expect(rehydrate(impostor, [PAIR_A])).toBeNull();
  });
});
