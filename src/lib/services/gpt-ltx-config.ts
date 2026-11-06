/**
 * Pin the new route only when explicitly selected; older/channel runs keep their settings.
 * `gptLtxEnabled` is stamped once, at creation, and never removed by the later GPT/Flow
 * toggle (`/api/runs/[id]/visual-provider`) — it marks "this run CAN switch between the
 * two", independent of which one is active right now. Only this creation path (called
 * with the raw POST body, whose `aiProvider` is only ever "ltx" or absent) sets it; the
 * toggle route stamps it onto pre-existing runs that predate the flag, see that route.
 */
export function gptLtxRunConfig(input: { aiProvider?: unknown; aiVideoPercent?: unknown }) {
  if (input.aiProvider !== "ltx") return {};
  const ratio = input.aiVideoPercent == null ? NaN : Number(input.aiVideoPercent);
  return { aiProvider: "ltx" as const, gptLtxEnabled: true as const, aiMedia: "auto" as const,
    aiVideoPercent: Number.isFinite(ratio) ? Math.max(0, Math.min(100, ratio)) : 30 };
}
/** "flow" is the live toggle's other position — same run, same beats, Google Flow instead
 *  of Codex for whatever hasn't rendered yet. Never degrades to the channel/global
 *  AI_PROVIDER so the choice stays exactly binary, regardless of what Settings has. */
export function gptLtxOverrides(input: { aiProvider?: unknown }): Record<string, string> {
  if (input.aiProvider === "ltx") return { AI_PROVIDER: "ltx", KIE_AI_MEDIA: "auto" };
  if (input.aiProvider === "flow") return { AI_PROVIDER: "flow_browser" };
  return {};
}
