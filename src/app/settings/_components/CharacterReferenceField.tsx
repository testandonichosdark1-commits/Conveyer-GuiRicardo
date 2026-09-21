"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/app/_i18n";

export function CharacterReferenceField({ provider = "kie" }: { provider?: string }) {
  const tr = useT();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [hasImage, setHasImage] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings/character-reference", { cache: "no-store" })
      .then((r) => { if (alive) setHasImage(r.ok); })
      .catch(() => { if (alive) setHasImage(false); });
    return () => { alive = false; };
  }, [previewNonce]);

  async function upload(file: File) {
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("image", file);
      const r = await fetch("/api/settings/character-reference", { method: "POST", body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      setHasImage(true);
      setPreviewNonce(Date.now());
      setMessage(tr("Image de référence enregistrée.", "Reference image saved."));
    } catch (e) {
      setMessage(`${tr("Erreur", "Error")}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    if (!confirm(tr("Supprimer l'image de référence ?", "Remove the character reference image?"))) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch("/api/settings/character-reference", { method: "DELETE" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      setHasImage(false);
      setPreviewNonce(Date.now());
      setMessage(tr("Image de référence supprimée.", "Reference image removed."));
    } catch (e) {
      setMessage(`${tr("Erreur", "Error")}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label className="label">{tr("Personnage de référence (optionnel)", "Character reference image (optional)")}</label>
      <div className="faint" style={{ fontSize: 12, lineHeight: 1.5 }}>
        {tr(
          "Utilisée uniquement quand la scène IA mentionne une femme, une housekeeper ou une employée d'hôtel. Les scènes d'objets continuent en text-to-image normal.",
          "Used only when an AI scene mentions a woman, housekeeper, or female hotel worker. Object-only scenes stay normal text-to-image."
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        {hasImage ? (
          <img
            key={previewNonce}
            src={`/api/settings/character-reference?t=${previewNonce}`}
            alt={tr("Personnage de référence", "Character reference")}
            style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 10, border: "1px solid var(--border)" }}
          />
        ) : (
          <div
            className="faint"
            style={{ width: 96, height: 96, borderRadius: 10, border: "1px dashed var(--border)", display: "grid", placeItems: "center", fontSize: 12, textAlign: "center", padding: 8 }}
          >
            {tr("Aucune image", "No image")}
          </div>
        )}

        <div style={{ display: "grid", gap: 8 }}>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn secondary" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? tr("Traitement…", "Working…") : hasImage ? tr("Remplacer l'image", "Replace image") : tr("Ajouter une image", "Upload image")}
            </button>
            {hasImage && (
              <button className="btn secondary" type="button" disabled={busy} onClick={() => void remove()}>
                {tr("Supprimer", "Remove")}
              </button>
            )}
          </div>
          <div className="faint" style={{ fontSize: 11.5 }}>
            JPEG / PNG / WebP · max 10 MB · {provider === "flow_browser" ? "Google Flow / Nano Banana" : "kie.ai Nano Banana Edit"}
          </div>
        </div>
      </div>
      {message && <div className="faint" style={{ fontSize: 12 }}>{message}</div>}
    </div>
  );
}
