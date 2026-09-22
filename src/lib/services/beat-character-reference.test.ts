import { describe, it, expect } from "vitest";
import { beatWantsCharacterReference } from "./visual-source";

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
