"use client";

import { useT } from "@/app/_i18n";

/**
 * A channel's own accounts — deliberately just Cloudflare + ai33.pro, not a generic
 * "every provider" grid (that existed briefly; scoped down to what the operator actually
 * needs channels for). CLOUDFLARE_ACCOUNT_ID is not itself a credential (it's the
 * "username" half of the Cloudflare pair) but is allowed through the same override path
 * as an explicit exception — see channels.ts's CHANNEL_EXTRA_OVERRIDE_KEYS.
 */
export function ChannelApiKeysField({
  value,
  onChange,
}: {
  /** Masked map from the server (toClientChannel's `api_keys`) merged with any edits made
   *  this session — "…" substrings mean "untouched, keep the real stored value" for the
   *  secret fields; CLOUDFLARE_ACCOUNT_ID is never masked (it isn't a secret). */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const tr = useT();

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <div className="label" style={{ marginBottom: 6 }}>{tr("Cloudflare (optionnel)", "Cloudflare (optional)")}</div>
        <div className="grid-2" style={{ gap: 10 }}>
          <div>
            <label className="label" style={{ fontSize: 12 }}>{tr("Account ID", "Account ID")}</label>
            <input
              className="input"
              value={value.CLOUDFLARE_ACCOUNT_ID ?? ""}
              onChange={(e) => onChange({ ...value, CLOUDFLARE_ACCOUNT_ID: e.target.value })}
              placeholder={tr("vide = compte global", "empty = global account")}
            />
          </div>
          <div>
            <label className="label" style={{ fontSize: 12 }}>{tr("API Token", "API Token")}</label>
            <input
              className="input"
              value={value.CLOUDFLARE_API_TOKEN ?? ""}
              onChange={(e) => onChange({ ...value, CLOUDFLARE_API_TOKEN: e.target.value })}
              placeholder={tr("vide = clé globale", "empty = global key")}
            />
          </div>
        </div>
      </div>

      <div>
        <label className="label" style={{ fontSize: 12 }}>{tr("ai33.pro — clé API (optionnel)", "ai33.pro — API key (optional)")}</label>
        <input
          className="input"
          value={value.AI33_API_KEY ?? ""}
          onChange={(e) => onChange({ ...value, AI33_API_KEY: e.target.value })}
          placeholder={tr("vide = clé globale", "empty = global key")}
        />
      </div>

      <div className="faint" style={{ fontSize: 11, lineHeight: 1.5 }}>
        {tr(
          "Laissez vide pour utiliser le compte/la clé globale (Paramètres). Rempli = TOUTES les vidéos de cette chaîne utilisent ce compte à la place.",
          "Leave blank to use the global account/key (Settings). Filled in = EVERY video on this channel uses this account instead."
        )}
      </div>
    </div>
  );
}
