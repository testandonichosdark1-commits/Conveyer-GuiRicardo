"use client";
import { useEffect, useState } from "react";

type State = { eligible: boolean; provider: "ltx" | "flow" };

export default function VisualProviderToggle({ runId }: { runId: string }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch(`/api/runs/${runId}/visual-provider`)
      .then((r) => r.json())
      .then((s) => setState(s.error ? null : s))
      .catch(() => {});
  }, [runId]);

  async function choose(provider: "ltx" | "flow") {
    if (busy || !state || state.provider === provider) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/runs/${runId}/visual-provider`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setState({ eligible: true, provider: result.provider });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível trocar.");
    } finally {
      setBusy(false);
    }
  }

  if (!state?.eligible) return null;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h2>Gerar cenas de IA via</h2>
      <p className="muted">
        Afeta só as cenas ainda não geradas. Depois de trocar, clique Resume para aplicar.
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          className={state.provider === "ltx" ? "btn" : "btn-secondary"}
          disabled={busy}
          onClick={() => choose("ltx")}
        >
          GPT (Codex + LTX)
        </button>
        <button
          className={state.provider === "flow" ? "btn" : "btn-secondary"}
          disabled={busy}
          onClick={() => choose("flow")}
        >
          Google Flow
        </button>
      </div>
      {error && (
        <p role="alert" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}
    </div>
  );
}
