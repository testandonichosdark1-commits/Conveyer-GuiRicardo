"use client";
import { useEffect, useRef, useState } from "react";
import type { Val, Set } from "./useSettings";

/**
 * Multi-key editor: one input per API key, with add/remove buttons and a live
 * "N keys configured" count. Backend format is unchanged — the keys are stored
 * as a single newline-separated string (empties ignored), exactly what the key
 * pools already parse. Existing keys load back MASKED (first4…last4 per entry);
 * the settings save handler re-hydrates masked entries from the DB, so adding a
 * key to an already-saved set works without re-typing the old ones.
 */

const SPLIT = /[\n,;]+/;

function toRows(v: string): string[] {
  const arr = v.split(SPLIT).map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : [""]; // always show at least one input
}

export function KeyListField({
  label,
  settingKey,
  val,
  set,
  placeholder,
  addLabel,
  help,
}: {
  label: string;
  settingKey: string;
  val: Val;
  set: Set;
  placeholder?: string;
  addLabel: string;
  help?: string;
}) {
  const loaded = val(settingKey);
  const [rows, setRows] = useState<string[]>(() => toRows(loaded));
  const edited = useRef(false);

  // Seed from the async-loaded setting value, but stop once the user edits so we
  // don't clobber in-progress input (incl. the empty row they're typing into).
  useEffect(() => {
    if (!edited.current) setRows(toRows(loaded));
  }, [loaded]);

  const commit = (next: string[]) => {
    edited.current = true;
    // Always keep at least one input on screen — removing the last key clears it
    // (leaves an empty input) rather than making the whole field disappear.
    setRows(next.length ? next : [""]);
    // Store as newline-separated, empties ignored — the exact format the pool reads.
    set(settingKey, next.map((s) => s.trim()).filter(Boolean).join("\n"));
  };

  const count = rows.map((r) => r.trim()).filter(Boolean).length;

  return (
    <div>
      <label className="label" style={{ display: "block", marginBottom: 6 }}>
        {label}
      </label>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              value={row}
              placeholder={placeholder}
              onChange={(e) => commit(rows.map((r, j) => (j === i ? e.target.value : r)))}
            />
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Remove key"
              title="Remove"
              // Nothing to remove when this is the only input and it's already empty
              // — keeps the lone empty field as an obvious place to paste a key.
              disabled={rows.length === 1 && !row.trim()}
              onClick={() => commit(rows.filter((_, j) => j !== i))}
              style={{ flexShrink: 0 }}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => commit([...rows, ""])} style={{ marginTop: 8 }}>
        {addLabel}
      </button>
      {count > 0 && (
        <div style={{ color: "var(--accent-hover)", fontSize: 12, marginTop: 8 }}>
          <strong>{count}</strong> key{count === 1 ? "" : "s"} configured — the app rotates between them automatically
        </div>
      )}
      {help && (
        <div style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>{help}</div>
      )}
    </div>
  );
}
