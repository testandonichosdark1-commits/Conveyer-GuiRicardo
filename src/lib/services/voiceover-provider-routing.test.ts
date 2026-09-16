import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The studio voiceover seam: VOICEOVER_PROVIDER (what the Settings dropdown writes) →
 * synthesizeVoiceover → the shared TTS engine → a `Voiceover` with word timings.
 *
 * This is the join the unit tests either side of it can't prove on their own — the
 * dropdown's option VALUE has to be the exact string dispatchTts branches on, or a
 * provider is selectable in the UI and dead at runtime.
 *
 * Relative imports on purpose: the `@/` alias is a Next tsconfig path vitest doesn't resolve.
 */

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
vi.mock("../logger", () => ({ log: () => {} }));
vi.mock("../ffmpeg-bin", () => ({ resolveFfmpeg: () => "ffmpeg" }));
vi.mock("../cancellation", () => ({ checkCancelled: () => {} }));
vi.mock("../plimit", () => ({ pLimit: () => (fn: () => unknown) => fn() }));
vi.mock("./video-assemble", () => ({ probeDurationSafe: async () => 30 }));
vi.mock("./cost-ledger", () => ({ recordElevenlabs: vi.fn(), recordGroqTranscription: vi.fn() }));
vi.mock("./elevenlabs-voices", () => ({
  keyFingerprint: () => "fp",
  resolveElevenLabsVoiceId: (v?: string | null) => v || "el-voice",
  listElevenLabsVoices: async () => null,
  isVoiceRejection: () => false,
  classifyVoiceError: async (m: string) => m,
}));

const synthesizeFullScript = vi.fn(async () => ({ filePath: "/tmp/vo.mp3", durationSec: 30 }));
vi.mock("./tts", () => ({ synthesizeFullScript: (...a: unknown[]) => synthesizeFullScript(...(a as [])) }));

import { synthesizeVoiceover } from "./elevenlabs-voiceover";

const SCRIPT = "One two three four five six seven eight.";

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  synthesizeFullScript.mockClear();
});

/** The (runId, text, outPath, options) the voiceover lane handed the TTS engine. */
const dispatched = () => synthesizeFullScript.mock.calls[0] as unknown as [string, string, string, { provider: string }];

describe("VOICEOVER_PROVIDER routing", () => {
  it("routes fishaudio to the shared TTS engine under that exact provider string", async () => {
    settings.VOICEOVER_PROVIDER = "fishaudio";
    const vo = await synthesizeVoiceover("run-1", SCRIPT, "/tmp");
    expect(dispatched()[3].provider).toBe("fishaudio");
    expect(vo.filePath).toContain("voiceover.mp3");
    expect(vo.durationSec).toBe(30);
  });

  it("routes hume the same way", async () => {
    settings.VOICEOVER_PROVIDER = "hume";
    await synthesizeVoiceover("run-1", SCRIPT, "/tmp");
    expect(dispatched()[3].provider).toBe("hume");
  });

  it("produces a Voiceover with word timings, so the planner needs no new branch", async () => {
    // No GROQ key here, so this exercises the proportional fallback — the point is that
    // the shape the rest of the pipeline consumes is identical to ElevenLabs'.
    settings.VOICEOVER_PROVIDER = "fishaudio";
    const vo = await synthesizeVoiceover("run-1", SCRIPT, "/tmp");
    expect(vo.words.length).toBe(8);
    expect(vo.words[0]).toMatchObject({ word: "One", startMs: 0 });
    expect(vo.words.at(-1)!.endMs).toBe(30000);
  });

  it("forwards the channel's voice and speed overrides to the new providers", async () => {
    settings.VOICEOVER_PROVIDER = "hume";
    await synthesizeVoiceover("run-1", SCRIPT, "/tmp", { voiceOverride: "chan-voice", speedOverride: 1.1 });
    expect(dispatched()[3]).toMatchObject({ provider: "hume", voiceOverride: "chan-voice", speedOverride: 1.1 });
  });

  it("REGRESSION: elevenlabs still takes its own native-timestamps path, not the TTS engine", async () => {
    settings.VOICEOVER_PROVIDER = "elevenlabs";
    settings.ELEVENLABS_API_KEY = "";
    // Fails on the missing key — which proves it entered synthesizeElevenLabs and never
    // reached the shared engine the new providers use.
    await expect(synthesizeVoiceover("run-1", SCRIPT, "/tmp")).rejects.toThrow(/ELEVENLABS_API_KEY is not set/);
    expect(synthesizeFullScript).not.toHaveBeenCalled();
  });

  it("REGRESSION: an unset provider still defaults to elevenlabs", async () => {
    await expect(synthesizeVoiceover("run-1", SCRIPT, "/tmp")).rejects.toThrow(/ELEVENLABS_API_KEY is not set/);
    expect(synthesizeFullScript).not.toHaveBeenCalled();
  });
});
