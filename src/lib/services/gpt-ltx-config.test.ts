import { expect, it } from "vitest";
import { gptLtxRunConfig, gptLtxOverrides } from "./gpt-ltx-config";
it("pins the selected route and ratio across resume, without changing channel voice or keys", () => {
  const cfg = gptLtxRunConfig({ aiProvider: "ltx", aiVideoPercent: 40 });
  expect(cfg).toEqual({ aiProvider: "ltx", gptLtxEnabled: true, aiMedia: "auto", aiVideoPercent: 40 });
  const resumed = JSON.parse(JSON.stringify(cfg));
  expect({ VOICEOVER_PROVIDER: "ai33", AI_PROVIDER: "flow_browser", ...gptLtxOverrides(resumed) }).toEqual({ VOICEOVER_PROVIDER: "ai33", AI_PROVIDER: "ltx", KIE_AI_MEDIA: "auto" });
  expect(gptLtxRunConfig({})).toEqual({}); expect(gptLtxOverrides({})).toEqual({});
  expect(gptLtxRunConfig({ aiProvider: "ltx", aiVideoPercent: 200 }).aiVideoPercent).toBe(100);
  expect(gptLtxRunConfig({ aiProvider: "ltx", aiVideoPercent: null }).aiVideoPercent).toBe(30);
});
it("the GPT/Flow toggle (aiProvider: 'flow') forces Flow, never the channel/global AI_PROVIDER", () => {
  expect(gptLtxOverrides({ aiProvider: "flow" })).toEqual({ AI_PROVIDER: "flow_browser" });
  // Toggling away from "ltx" is NOT a creation-time choice — gptLtxRunConfig (create-time
  // only) must stay a no-op for it; the live aiProvider field is preserved elsewhere
  // (studio-pipeline.ts's readConfig), not through this function.
  expect(gptLtxRunConfig({ aiProvider: "flow" })).toEqual({});
});
