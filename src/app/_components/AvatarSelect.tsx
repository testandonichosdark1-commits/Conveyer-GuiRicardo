"use client";
import { useT } from "../_i18n";

export interface AvatarLite {
  id: number;
  name: string;
  status: "pending" | "training" | "ready" | "error";
}

/**
 * Shared avatar dropdown (Create Video + Channels). Shows ALL saved avatars so
 * they're visibly present; non-ready ones are disabled with their status. The
 * empty option = no avatar (faceless / channel fallback). Presentational only —
 * the parent owns the avatars list + selected value.
 */
export function AvatarSelect({
  avatars,
  value,
  onChange,
  noneLabel,
}: {
  avatars: AvatarLite[];
  value: number | null;
  onChange: (id: number | null) => void;
  noneLabel?: string;
}) {
  const tr = useT();
  return (
    <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
      <option value="">{noneLabel ?? tr("Aucun — sans visage (b-roll uniquement)", "None — faceless (b-roll only)")}</option>
      {avatars.map((a) => (
        <option key={a.id} value={a.id} disabled={a.status !== "ready"}>
          {a.name}
          {a.status !== "ready" ? ` — ${a.status === "error" ? tr("erreur", "error") : tr("préparation…", "preparing…")}` : ""}
        </option>
      ))}
    </select>
  );
}
