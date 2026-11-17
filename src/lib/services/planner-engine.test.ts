import { describe, expect, it, vi } from "vitest";

const settings: Record<string, string> = {};
vi.mock("../settings", () => ({ getSetting: (k: string) => settings[k] ?? "" }));
const callGemini = vi.fn(async () => ({ json: { candidates: [] }, model: "gemini-x" }));
vi.mock("./gemini-models", () => ({ callGemini: (...a: unknown[]) => callGemini(...(a as [])) }));

import { callPlanner, claudeRequestFromGeminiBody, toJsonSchema } from "./planner-engine";

describe("planner engine", () => {
  it("converts Gemini's schema dialect to JSON Schema", () => {
    expect(
      toJsonSchema({ type: "ARRAY", items: { type: "OBJECT", propertyOrdering: ["a"], properties: { a: { type: "INTEGER" }, b: { type: "STRING", enum: ["x"] } }, required: ["a"] } })
    ).toEqual({ type: "array", items: { type: "object", properties: { a: { type: "integer" }, b: { type: "string", enum: ["x"] } }, required: ["a"] } });
  });

  it("recovers the prompt and schema from a Gemini request body", () => {
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "plan this" }] }], generationConfig: { responseSchema: { type: "ARRAY", items: { type: "STRING" } } } });
    expect(claudeRequestFromGeminiBody(body)).toEqual({ prompt: "plan this", system: undefined, schema: { type: "array", items: { type: "string" } } });
  });

  it("is plain callGemini unless PLANNER_ENGINE=claude", async () => {
    callGemini.mockClear();
    await callPlanner({ apiKey: "k", model: "m", body: "{}" });
    expect(callGemini).toHaveBeenCalledTimes(1);
  });

  it("falls back to Gemini when the Claude CLI cannot run", async () => {
    settings.PLANNER_ENGINE = "claude";
    const prev = process.env.FACTORY_CLAUDE_BIN;
    process.env.FACTORY_CLAUDE_BIN = "/nonexistent/claude-binary";
    callGemini.mockClear();
    const logs: string[] = [];
    const r = await callPlanner({ apiKey: "k", model: "m", body: JSON.stringify({ contents: [{ parts: [{ text: "x" }] }] }), log: (m) => logs.push(m) });
    expect(r.model).toBe("gemini-x");
    expect(logs[0]).toMatch(/Claude planner failed/);
    process.env.FACTORY_CLAUDE_BIN = prev;
    delete settings.PLANNER_ENGINE;
  });
});
