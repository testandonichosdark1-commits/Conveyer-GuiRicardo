import { describe, it, expect, vi, beforeEach } from "vitest";

const settings = vi.hoisted(() => ({ terms: "" }));
vi.mock("../settings", () => ({ getSetting: (k: string) => (k === "AI_CHARACTER_TERMS" ? settings.terms : "") }));
vi.mock("../logger", () => ({ log: () => {} }));
import { beatWantsCharacterReference, characterTermsRegex } from "./visual-source";

beforeEach(() => { settings.terms = ""; });

/**
 * beatWantsCharacterReference() decides whether the housekeeper reference photo is
 * attached to a beat — for BOTH Nano Banana (image) and Veo (video) generation, since
 * Flow's provider-supports-character-ref check covers both media kinds identically.
 *
 * Goal: show her when she participates in the scene, never in an object/detail close-up
 * that happens to share vocabulary with the video's general subject.
 */

function beat(text: string, aiPrompt = "", visualQuery = "") {
  return { aiPrompt, visualQuery, text };
}

function beatWithOverlay(overlay: { type: string; title: string } | undefined, aiPrompt = "", visualQuery = "", text = "") {
  return { aiPrompt, visualQuery, text, overlay: overlay as never };
}

describe("beatWantsCharacterReference — explicit character terms", () => {
  const terms = [
    "woman", "housekeeper", "maid", "room attendant", "professional cleaner",
    "hotel worker", "hotel employee", "cleaning staff member",
  ];
  for (const term of terms) {
    it(`fires on "${term}"`, () => {
      expect(beatWantsCharacterReference(beat(`A ${term} enters the room.`))).toBe(true);
    });
  }

  it("fires on she/her pronouns", () => {
    expect(beatWantsCharacterReference(beat("She walks down the hallway carrying towels."))).toBe(true);
    expect(beatWantsCharacterReference(beat("The manager handed her a new key card."))).toBe(true);
  });

  it("checks aiPrompt and visualQuery too, not just narration text", () => {
    expect(beatWantsCharacterReference(beat("Something happens next.", "a housekeeper folding towels"))).toBe(true);
    expect(beatWantsCharacterReference(beat("Something happens next.", "", "hotel worker at a cart"))).toBe(true);
  });
});

describe("beatWantsCharacterReference — plural forms", () => {
  it("fires on the plural of the subject nouns, not just the singular", () => {
    // Regression: "Hotel housekeepers are trained…" (a real script line) matched nothing,
    // because \bhousekeeper\b has no word boundary before the trailing "s".
    expect(beatWantsCharacterReference(beat("Hotel housekeepers are trained to avoid backtracking."))).toBe(true);
    expect(beatWantsCharacterReference(beat("Something happens next.", "hotel housekeepers folding towels"))).toBe(true);
    for (const plural of ["maids", "room attendants", "cleaning workers", "hotel employees", "staff members", "professional cleaners"]) {
      expect(beatWantsCharacterReference(beat("", `${plural} at work`))).toBe(true);
    }
  });

  it("the sentence that opened this case still routes nothing on its own words when a visual exists and shows an object", () => {
    // visual description present + object-only -> narration is NOT consulted for explicit terms
    expect(beatWantsCharacterReference(beat("Hotel housekeepers are trained to avoid backtracking.", "close-up of a red microfiber cloth on a counter"))).toBe(false);
  });
});

describe("beatWantsCharacterReference — embodied first person", () => {
  const actions = ["saw", "noticed", "entered", "checked", "cleaned", "wiped", "examined", "stepped", "walked"];
  for (const action of actions) {
    it(`fires on "I ${action}"`, () => {
      expect(beatWantsCharacterReference(beat(`I ${action} the strange stain on the carpet.`))).toBe(true);
    });
  }

  it("does NOT fire on generic first-person thought verbs (I think / I know)", () => {
    // Explicitly excluded so the portrait isn't forced into explanatory object shots.
    expect(beatWantsCharacterReference(beat("I think this detergent works best on cotton."))).toBe(false);
    expect(beatWantsCharacterReference(beat("I know the science behind this reaction."))).toBe(false);
  });
});

describe("beatWantsCharacterReference — object/detail shots stay false", () => {
  it("a plain object close-up never fires", () => {
    expect(beatWantsCharacterReference(beat("Close-up of a vacuum cleaner on the floor."))).toBe(false);
    expect(beatWantsCharacterReference(beat("A bottle of cleaning spray sits on the counter."))).toBe(false);
  });

  it("a narration mentioning unrelated third parties (not the housekeeper) stays false", () => {
    expect(beatWantsCharacterReference(beat("Guests checked out early that morning."))).toBe(false);
  });
});


describe("per-channel character words", () => {
  it("empty means the built-in housekeeper list, unchanged", () => {
    expect(beatWantsCharacterReference(beat("", "the housekeeper wipes a mirror"))).toBe(true);
    expect(beatWantsCharacterReference(beat("", "a detective studies a map"))).toBe(false);
  });
  it("a channel's own words replace the list, plurals included", () => {
    settings.terms = "detective, inspector, he";
    expect(beatWantsCharacterReference(beat("", "a detective studies a map"))).toBe(true);
    expect(beatWantsCharacterReference(beat("", "two inspectors at a door"))).toBe(true);
    expect(beatWantsCharacterReference(beat("", "the housekeeper wipes a mirror"))).toBe(false);
  });
  it("a custom channel does not inherit the cleaning-verb first-person rule", () => {
    settings.terms = "detective";
    expect(beatWantsCharacterReference(beat("I cleaned the counter", "a tidy counter"))).toBe(false);
  });
  it("escapes regex characters and matches whole words only", () => {
    expect(characterTermsRegex("dr. who")!.test("Dr. Who arrives")).toBe(true);
    expect(characterTermsRegex("he")!.test("the")).toBe(false);
    expect(characterTermsRegex("  ")).toBeNull();
  });
});

describe("beatWantsCharacterReference — the planner's own 'person' overlay", () => {
  beforeEach(() => { settings.terms = "finn stone, finn, diy guy, handyman, homeowner"; });

  it("catches the exact real-run gap: a person-carded beat whose PROSE never names him", () => {
    // Measured live: this beat rendered "A friendly middle-aged man in a canvas work
    // shirt smiling directly at the camera in a well-organized home workshop" as its
    // visual description — no configured term anywhere in it — while the planner had
    // ALREADY, in its own separate overlay field, said whose beat this was.
    expect(beatWantsCharacterReference(beatWithOverlay(
      { type: "person", title: "Finn Stone" },
      "A friendly middle-aged man in a canvas work shirt smiling directly at the camera in a well-organized home workshop"
    ))).toBe(true);
  });

  it("ignores a person overlay for someone ELSE — the channel's own words still decide", () => {
    expect(beatWantsCharacterReference(beatWithOverlay(
      { type: "person", title: "Dr. Jane Smith" },
      "A woman in a lab coat explaining a chart"
    ))).toBe(false);
  });

  it("does not fire on a non-person overlay even if the title happens to share a word", () => {
    expect(beatWantsCharacterReference(beatWithOverlay(
      { type: "fact", title: "Finn's tip #3" },
      "A close-up of a spray bottle on a shelf"
    ))).toBe(false);
  });

  it("a beat with no overlay at all still falls through to the prose/text checks", () => {
    expect(beatWantsCharacterReference(beatWithOverlay(undefined, "Finn wiring a fuse to a battery"))).toBe(true);
    expect(beatWantsCharacterReference(beatWithOverlay(undefined, "A close-up of a battery terminal"))).toBe(false);
  });
});
