"use client";
import { useState } from "react";
import { useT } from "../_i18n";
import { classifyVoiceCatalogueError } from "@/lib/voice-catalogue-error";

export interface VoiceOption {
  voice_id: string;
  name: string;
  /** Which AI84 engine the voice belongs to; absent for single-engine providers. */
  backend?: "minimax" | "elevenlabs";
  /** True for the account's own cloned voices — they get their own group at the top. */
  cloned?: boolean;
}

/**
 * Voice dropdown for the Create Video page. Presentational only — the parent owns the
 * list, the selected value and the loading/error state, exactly like AvatarSelect.
 *
 * WHY IT EXISTS: the voice used to be a single global setting read at synthesis time, so
 * two videos started minutes apart could not use different voices, and changing the
 * setting mid-run changed a video that was already generating. Choosing it here pins it
 * to this video.
 *
 * TWO RULES:
 *
 * 1. The empty option must always work. It means "use the channel's voice, or the one in
 *    Settings" — i.e. exactly the old behaviour — so an operator who ignores this control
 *    loses nothing.
 * 2. It must never block making a video. If the list can't be fetched we fall back to a
 *    plain text field rather than disabling anything: a voice catalogue is a convenience,
 *    and it has no business standing between a creator and their video.
 *
 * Cloned voices are grouped first because they are what a creator opens this list for —
 * and, for AI84, they only exist on one of its two engines, which is why the parent sends
 * the chosen voice's `backend` along with its id.
 *
 * 3. TYPING AN ID IS ALWAYS AVAILABLE. The first version offered it only when the catalogue
 *    failed, and a client reported the consequence within a day: "now it's not letting me
 *    paste the voice code, only the dropdown". For AI84 that is not a convenience — its
 *    ElevenLabs engine publishes ONLY ~25 shared voices, so an operator's own ElevenLabs
 *    voice can never appear in any list and pasting is the sole way to use it.
 *
 * `where` only picks the wording. The two places a voice is chosen fall back to different
 * things — a video to its channel, a channel to Settings — and saying the wrong one is worse
 * than saying nothing, since the empty option is the one every operator lands on by default.
 */
export function VoiceSelect({
  voices,
  value,
  onChange,
  loading,
  error,
  onRetry,
  where = "video",
  providerLabel,
}: {
  voices: VoiceOption[];
  value: string | null;
  onChange: (voiceId: string | null, backend: VoiceOption["backend"]) => void;
  loading: boolean;
  /** Non-null when the catalogue could not be loaded; the field degrades to free text. */
  error: string | null;
  onRetry: () => void;
  /** Which thing the voice is being chosen for — decides the copy, nothing else. */
  where?: "video" | "channel";
  /** The provider's display name ("AI84"), so a failure can name who refused. */
  providerLabel?: string;
}) {
  const tr = useT();
  // Typing is a mode the operator can switch INTO at will, not only a fallback we drop them
  // in. Local state, because it is a view preference and nothing outside cares about it.
  const [manual, setManual] = useState(false);
  const forVideo = where === "video";
  const fallbackLabel = forVideo
    ? tr("Voix de la chaîne / des réglages", "Channel's voice / the one in Settings")
    : tr("Voix globale (Paramètres)", "Global voice (Settings)");

  // Could not load the list → let them type an id. Never a dead end.
  if (error) {
    const who = providerLabel || tr("le fournisseur de voix", "the voice provider");
    // Say WHY first. The routes know the difference between "no key", "your key was refused"
    // and "we couldn't reach them", and only the first two are the operator's to fix — an
    // impersonal "couldn't load" for all three is what made an expired key look like a broken
    // deploy and sent someone hunting through git branches.
    const cause = {
      no_key: tr(
        `Aucune clé API ${who} — ajoutez-la dans les Paramètres.`,
        `No ${who} API key — add one in Settings.`
      ),
      // Valid key, missing scope. Saying "the narration itself still works" is the whole
      // point: without it this reads as an outage, and the operator goes and replaces a key
      // that is doing its job.
      no_permission: tr(
        `Votre clé ${who} n'a pas le droit de lister les voix (${error}). La narration, elle, fonctionne — ajoutez ce droit à la clé chez ${who} pour voir la liste.`,
        `Your ${who} key isn't allowed to list voices (${error}). Narration still works — grant that permission to the key in your ${who} account to see the list.`
      ),
      rejected: tr(
        `${who} a refusé votre clé API. Vérifiez-la dans les Paramètres.`,
        `${who} rejected your API key. Check it in Settings.`
      ),
      // The provider's own words, unedited: a 429 or a 500 means something different to the
      // operator than either of the above, and inventing a friendlier phrasing would hide it.
      unreachable: tr(
        `Impossible de joindre ${who} (${error}).`,
        `Couldn't reach ${who} (${error}).`
      ),
    }[classifyVoiceCatalogueError(error)];
    return (
      <div>
        <input
          className="input"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value.trim() || null, undefined)}
          placeholder={tr("voice_id (optionnel)", "voice_id (optional)")}
        />
        <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
          <strong style={{ fontWeight: 600 }}>{cause}</strong>{" "}
          {forVideo
            ? tr(
                "Cette vidéo utilisera la voix de la chaîne / des réglages, sauf si vous collez un voice_id ci-dessus.",
                "This video will use the channel's voice / the one in Settings, unless you paste a voice_id above."
              )
            : tr(
                "Cette chaîne utilisera la voix globale, sauf si vous collez un voice_id ci-dessus.",
                "This channel will use the global voice, unless you paste a voice_id above."
              )}{" "}
          <button
            type="button"
            onClick={onRetry}
            style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", font: "inherit" }}
          >
            {tr("Réessayer", "Retry")}
          </button>
        </div>
      </div>
    );
  }

  // GROUPED BY ENGINE, not just clone-vs-rest. With one "Library" group the 25 ElevenLabs
  // voices sat behind 702 MiniMax ones — technically present, and a client reported them as
  // simply missing. ElevenLabs goes second because it is the short list: the long one must
  // never be the thing standing between an operator and the other engine.
  const cloned = voices.filter((v) => v.cloned);
  const rest = voices.filter((v) => !v.cloned);
  const eleven = rest.filter((v) => v.backend === "elevenlabs");
  const minimax = rest.filter((v) => v.backend === "minimax");
  // Providers other than AI84 tag nothing, so everything they return lands here and keeps
  // the single "Library" group it has always had.
  const untagged = rest.filter((v) => !v.backend);
  const groups: { key: string; label: string; items: VoiceOption[] }[] = [
    { key: "cloned", label: tr("Vos voix clonées", "Your cloned voices"), items: cloned },
    { key: "el", label: "ElevenLabs", items: eleven },
    { key: "mm", label: tr("MiniMax — bibliothèque", "MiniMax — library"), items: minimax },
    { key: "lib", label: tr("Bibliothèque", "Library"), items: untagged },
  ].filter((g) => g.items.length > 0);

  // A value that isn't in the catalogue opens the typing field directly, rather than showing
  // an uneditable "saved choice" row: for AI84 a pasted ElevenLabs id is a NORMAL state, not
  // a leftover, because that engine's own voices are never listed.
  const known = !value || voices.some((v) => v.voice_id === value);
  const typing = manual || !known;

  return (
    <div>
      {typing ? (
        <input
          className="input"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value.trim() || null, undefined)}
          placeholder={tr("voice_id (optionnel)", "voice_id (optional)")}
        />
      ) : (
        <select
          className="input"
          value={value ?? ""}
          disabled={loading}
          onChange={(e) => {
            const id = e.target.value || null;
            onChange(id, id ? voices.find((v) => v.voice_id === id)?.backend : undefined);
          }}
        >
          <option value="">{loading ? tr("Chargement des voix…", "Loading voices…") : fallbackLabel}</option>
          {groups.map((g) => (
            <optgroup key={g.key} label={g.label}>
              {g.items.map((v) => (
                <option key={`${g.key}-${v.voice_id}`} value={v.voice_id}>{v.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
      <div className="faint" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>
        {forVideo
          ? tr(
              "S'applique à cette vidéo uniquement — vous pouvez lancer plusieurs vidéos avec des voix différentes en même temps.",
              "Applies to this video only — you can run several videos with different voices at the same time."
            )
          : tr(
              "Voix par défaut de cette chaîne. Chaque chaîne peut avoir la sienne — y compris sur un moteur AI84 différent.",
              "This channel's default voice. Each channel can have its own — including one on a different AI84 engine."
            )}{" "}
        <button
          type="button"
          onClick={() => setManual(!typing)}
          style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", font: "inherit" }}
        >
          {typing
            ? tr("Choisir dans la liste", "Choose from the list")
            : tr("Coller un ID à la place", "Paste an ID instead")}
        </button>
        {/* Said out loud because no amount of scrolling will find a voice that the provider
            never publishes, and an operator will keep looking until told. */}
        {eleven.length > 0 && (
          <div style={{ marginTop: 3 }}>
            {tr(
              `AI84 ne publie que ses ${eleven.length} voix ElevenLabs partagées. Pour une voix ElevenLabs qui vous appartient, collez son ID.`,
              `AI84 only publishes its ${eleven.length} shared ElevenLabs voices. For an ElevenLabs voice of your own, paste its ID.`
            )}
          </div>
        )}
      </div>
    </div>
  );
}
