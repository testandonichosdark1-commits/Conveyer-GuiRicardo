import { describe, it, expect, afterEach } from "vitest";
import { getSetting, setChannelSettingOverrides, clearChannelSettingOverrides } from "./settings";

/**
 * The AsyncLocalStorage-based channel-override seam in settings.ts. This is what lets a
 * channel's own API keys / voice provider / character reference apply to every provider
 * file that calls getSetting() (kie.ts, elevenlabs-voiceover.ts, heygen-client.ts, …)
 * WITHOUT any of those ~30 files being touched — see studio-pipeline.ts
 * activateChannelOverrides() for where it's actually armed per run.
 *
 * afterEach clears the store unconditionally: AsyncLocalStorage.enterWith mutates the
 * CURRENT async context going forward, so a test that forgot to clean up could otherwise
 * leak its override into a sibling test's continuation.
 */

afterEach(() => {
  clearChannelSettingOverrides();
});

describe("channel setting overrides", () => {
  it("an override shadows whatever getSetting would otherwise return", () => {
    setChannelSettingOverrides({ HEYGEN_API_KEY: "channel-owns-this-key" });
    expect(getSetting("HEYGEN_API_KEY")).toBe("channel-owns-this-key");
  });

  it("only keys actually present in the override map fall through to normal lookup", () => {
    setChannelSettingOverrides({ HEYGEN_API_KEY: "channel-key" });
    // ELEVENLABS_API_KEY was never part of this channel's override map — must NOT be
    // shadowed by the fact that some other key is overridden.
    expect(getSetting("ELEVENLABS_API_KEY")).not.toBe("channel-key");
  });

  it("an empty-string override value does not shadow the real setting", () => {
    // filterToSecretKeys/channelSettingOverrides never produce an empty-string entry in
    // practice, but getSetting's own guard is what actually enforces this — pin it directly.
    setChannelSettingOverrides({ HEYGEN_API_KEY: "" });
    expect(getSetting("HEYGEN_API_KEY")).not.toBe("");
    // i.e. it fell through to the normal DB/env lookup, whatever that value is — the
    // meaningful assertion is just that "" from the override map was never returned.
  });

  it("clearChannelSettingOverrides() removes every override", () => {
    setChannelSettingOverrides({ HEYGEN_API_KEY: "channel-key" });
    expect(getSetting("HEYGEN_API_KEY")).toBe("channel-key");
    clearChannelSettingOverrides();
    expect(getSetting("HEYGEN_API_KEY")).not.toBe("channel-key");
  });

  it("a fresh call to setChannelSettingOverrides fully replaces the previous map (no merge)", () => {
    setChannelSettingOverrides({ HEYGEN_API_KEY: "first" });
    setChannelSettingOverrides({ ELEVENLABS_API_KEY: "second" });
    expect(getSetting("HEYGEN_API_KEY")).not.toBe("first"); // the first call's map is gone
    expect(getSetting("ELEVENLABS_API_KEY")).toBe("second");
  });
});
