import { describe, it, expect } from "vitest";
import {
  filterToSecretKeys,
  mergeChannelApiKeys,
  maskedChannelApiKeys,
  channelSettingOverrides,
  toClientChannel,
  deriveVoiceProvider,
  type Channel,
} from "./channels";

/**
 * channels.ts's API-key isolation — pure functions only, no DB rows are created or read
 * (createChannel/getChannel are NOT exercised here on purpose: they'd write a real row
 * into whichever local studio.db this test happens to run against, which is someone's
 * actual channel list, not a fixture).
 *
 * The property that matters most: a channel's api_keys_json can NEVER smuggle an
 * override for a non-credential setting (e.g. FFMPEG_PATH) onto a run — every read AND
 * write path re-applies isSecretKey().
 */

function baseChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    name: "test",
    visual_mode: "mix",
    ai_style: null,
    visual_prompt: null,
    voice_id: null,
    voice_speed: null,
    voice_provider: null,
    character_reference_path: null,
    api_keys_json: null,
    interval_sec: 4.5,
    format: "1920x1080",
    avatar_id: null,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

describe("filterToSecretKeys", () => {
  it("keeps only isSecretKey() settings", () => {
    const json = JSON.stringify({ HEYGEN_API_KEY: "sk-abc", FFMPEG_PATH: "/usr/bin/ffmpeg" });
    expect(filterToSecretKeys(json)).toEqual({ HEYGEN_API_KEY: "sk-abc" });
  });

  it("drops non-string values", () => {
    const json = JSON.stringify({ HEYGEN_API_KEY: 12345 });
    expect(filterToSecretKeys(json)).toEqual({});
  });

  it("drops blank values", () => {
    const json = JSON.stringify({ HEYGEN_API_KEY: "   " });
    expect(filterToSecretKeys(json)).toEqual({});
  });

  it("is safe against malformed JSON, arrays, and null", () => {
    expect(filterToSecretKeys("not json")).toEqual({});
    expect(filterToSecretKeys(JSON.stringify(["a", "b"]))).toEqual({});
    expect(filterToSecretKeys(null)).toEqual({});
    expect(filterToSecretKeys(undefined)).toEqual({});
    expect(filterToSecretKeys("")).toEqual({});
  });
});

describe("mergeChannelApiKeys", () => {
  it("stores a real newly-typed value", () => {
    const result = mergeChannelApiKeys(null, { HEYGEN_API_KEY: "sk-new" });
    expect(JSON.parse(result!)).toEqual({ HEYGEN_API_KEY: "sk-new" });
  });

  it("keeps the existing value when the incoming one is still masked (contains …)", () => {
    const existing = JSON.stringify({ HEYGEN_API_KEY: "sk-realvalue1234" });
    const result = mergeChannelApiKeys(existing, { HEYGEN_API_KEY: "sk-r…1234" });
    expect(JSON.parse(result!)).toEqual({ HEYGEN_API_KEY: "sk-realvalue1234" });
  });

  it("clears an override when the field is explicitly emptied", () => {
    const existing = JSON.stringify({ HEYGEN_API_KEY: "sk-realvalue1234" });
    const result = mergeChannelApiKeys(existing, { HEYGEN_API_KEY: "" });
    expect(result).toBeNull();
  });

  it("never lets a non-secret key through, even if the client sends one", () => {
    const result = mergeChannelApiKeys(null, { FFMPEG_PATH: "/tmp/evil", HEYGEN_API_KEY: "sk-ok" });
    expect(JSON.parse(result!)).toEqual({ HEYGEN_API_KEY: "sk-ok" });
  });

  it("leaves untouched keys from the existing map alone", () => {
    const existing = JSON.stringify({ HEYGEN_API_KEY: "sk-heygen", ELEVENLABS_API_KEY: "sk-eleven" });
    const result = mergeChannelApiKeys(existing, { HEYGEN_API_KEY: "sk-heygen-new" });
    expect(JSON.parse(result!)).toEqual({ HEYGEN_API_KEY: "sk-heygen-new", ELEVENLABS_API_KEY: "sk-eleven" });
  });

  it("returns null (not '{}') when nothing ends up set", () => {
    expect(mergeChannelApiKeys(null, {})).toBeNull();
  });
});

describe("maskedChannelApiKeys", () => {
  it("masks every value the same way getMaskedSettings() does", () => {
    const json = JSON.stringify({ HEYGEN_API_KEY: "sk-1234567890abcdef" });
    expect(maskedChannelApiKeys(json)).toEqual({ HEYGEN_API_KEY: "sk-1…cdef" });
  });

  it("is {} for no overrides", () => {
    expect(maskedChannelApiKeys(null)).toEqual({});
  });
});

describe("channelSettingOverrides", () => {
  it("null channel -> no overrides at all (every global setting applies, unchanged)", () => {
    expect(channelSettingOverrides(null)).toEqual({});
  });

  it("merges api keys + voice provider + character reference into one override map", () => {
    const channel = baseChannel({
      api_keys_json: JSON.stringify({ HEYGEN_API_KEY: "sk-heygen" }),
      voice_provider: "ai33",
      character_reference_path: "/data/channels/1/character-reference.jpg",
    });
    expect(channelSettingOverrides(channel)).toEqual({
      HEYGEN_API_KEY: "sk-heygen",
      VOICEOVER_PROVIDER: "ai33",
      AI_CHARACTER_REFERENCE_PATH: "/data/channels/1/character-reference.jpg",
    });
  });

  it("a channel with nothing set overrides nothing", () => {
    expect(channelSettingOverrides(baseChannel())).toEqual({});
  });

  it("blank voice_provider/character_reference_path are NOT sent as overrides", () => {
    const channel = baseChannel({ voice_provider: "   ", character_reference_path: "" });
    expect(channelSettingOverrides(channel)).toEqual({});
  });
});

describe("toClientChannel", () => {
  it("never leaks the raw api_keys_json to the client", () => {
    const channel = baseChannel({ api_keys_json: JSON.stringify({ HEYGEN_API_KEY: "sk-realsecretvalue" }) });
    const client = toClientChannel(channel);
    expect(client).not.toHaveProperty("api_keys_json");
    expect(JSON.stringify(client)).not.toContain("sk-realsecretvalue");
    expect(client.api_keys).toEqual({ HEYGEN_API_KEY: "sk-r…alue" });
  });
});

describe("CLOUDFLARE_ACCOUNT_ID — the one non-secret exception", () => {
  it("passes the write-time/read-time filter alongside real secret keys", () => {
    const json = JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "abc123", CLOUDFLARE_API_TOKEN: "cfut_realtoken1234" });
    expect(filterToSecretKeys(json)).toEqual({ CLOUDFLARE_ACCOUNT_ID: "abc123", CLOUDFLARE_API_TOKEN: "cfut_realtoken1234" });
  });

  it("is never masked — it isn't a credential", () => {
    const json = JSON.stringify({ CLOUDFLARE_ACCOUNT_ID: "abcdef0123456789" });
    expect(maskedChannelApiKeys(json)).toEqual({ CLOUDFLARE_ACCOUNT_ID: "abcdef0123456789" });
  });

  it("mergeChannelApiKeys treats it as a plain field — no mask-preservation needed", () => {
    const result = mergeChannelApiKeys(null, { CLOUDFLARE_ACCOUNT_ID: "abc123" });
    expect(JSON.parse(result!)).toEqual({ CLOUDFLARE_ACCOUNT_ID: "abc123" });
  });

  it("still never lets through a truly unrelated non-secret key", () => {
    const result = mergeChannelApiKeys(null, { CLOUDFLARE_ACCOUNT_ID: "abc123", FFMPEG_PATH: "/tmp/evil" });
    expect(JSON.parse(result!)).toEqual({ CLOUDFLARE_ACCOUNT_ID: "abc123" });
  });
});

describe("deriveVoiceProvider", () => {
  it("returns 'ai33' whenever a voice id is present", () => {
    expect(deriveVoiceProvider("edge:en-US-GuyNeural")).toBe("ai33");
    expect(deriveVoiceProvider("  spaced  ")).toBe("ai33");
  });
  it("returns null for empty/blank/missing voice ids — the channel uses the global provider", () => {
    expect(deriveVoiceProvider("")).toBeNull();
    expect(deriveVoiceProvider("   ")).toBeNull();
    expect(deriveVoiceProvider(null)).toBeNull();
    expect(deriveVoiceProvider(undefined)).toBeNull();
  });
});
