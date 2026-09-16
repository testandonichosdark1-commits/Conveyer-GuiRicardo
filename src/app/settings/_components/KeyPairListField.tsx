"use client";
import { useEffect, useRef, useState } from "react";
import type { Val, Set } from "./useSettings";

/**
 * Multi-key editor for credentials that come as a PAIR (Storyblocks: a Public Key and a
 * Private Key). Same idea as KeyListField, but each row is TWO inputs instead of one.
 *
 * Why a separate component rather than telling the operator to type "public:private":
 * the colon is invisible plumbing, and a pasted key with a stray space or a missing colon
 * silently produces a credential that fails every request with an opaque HMAC error. Two
 * labelled boxes make that impossible to get wrong.
 *
 * The STORAGE FORMAT IS UNCHANGED — still one "public:private" line per pair, exactly what
 * the key pool already parses. The colon lives only in this file and in the parser.
 *
 * Masking: values load back with each half masked separately (first4…last4) and the colon
 * kept, so a saved pair still splits into the two boxes. The settings POST handler
 * re-hydrates masked halves from the DB, so adding a second pair never requires re-typing
 * the first.
 */

const LINE_SPLIT = /[\n;]+/;

interface Pair {
  pub: string;
  priv: string;
}

function toRows(v: string): Pair[] {
  const rows = v
    .split(LINE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(":");
      return i > 0 ? { pub: line.slice(0, i).trim(), priv: line.slice(i + 1).trim() } : { pub: line, priv: "" };
    });
  return rows.length ? rows : [{ pub: "", priv: "" }]; // always show one empty row
}

/** Back to storage form. A row missing either half is dropped — half a pair cannot sign. */
function toValue(rows: Pair[]): string {
  return rows
    .map((r) => ({ pub: r.pub.trim(), priv: r.priv.trim() }))
    .filter((r) => r.pub && r.priv)
    .map((r) => `${r.pub}:${r.priv}`)
    .join("\n");
}

export function KeyPairListField({
  label,
  settingKey,
  val,
  set,
  labelA,
  labelB,
  placeholderA,
  placeholderB,
  addLabel,
  help,
}: {
  label: string;
  settingKey: string;
  val: Val;
  set: Set;
  labelA: string;
  labelB: string;
  placeholderA?: string;
  placeholderB?: string;
  addLabel: string;
  help?: string;
}) {
  const loaded = val(settingKey);
  const [rows, setRows] = useState<Pair[]>(() => toRows(loaded));
  const edited = useRef(false);

  // Seed from the async-loaded value, but stop once the user types so an in-flight
  // settings refresh cannot wipe a half-entered pair.
  useEffect(() => {
    if (!edited.current) setRows(toRows(loaded));
  }, [loaded]);

  const commit = (next: Pair[]) => {
    edited.current = true;
    setRows(next.length ? next : [{ pub: "", priv: "" }]);
    set(settingKey, toValue(next));
  };

  const complete = rows.filter((r) => r.pub.trim() && r.priv.trim()).length;
  const halfFilled = rows.some((r) => (r.pub.trim() && !r.priv.trim()) || (!r.pub.trim() && r.priv.trim()));

  return (
    <div>
      <label className="label" style={{ display: "block", marginBottom: 6 }}>
        {label}
      </label>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((row, i) => (
          // No per-input captions: the two boxes carry their own placeholders, and an extra
          // label row here would push these inputs ~20px below the single-input Pexels
          // column beside them, which reads as a misaligned form.
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              value={row.pub}
              placeholder={placeholderA ?? labelA}
              aria-label={labelA}
              onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, pub: e.target.value } : r)))}
            />
            <input
              className="input"
              style={{ flex: 1, minWidth: 0 }}
              value={row.priv}
              placeholder={placeholderB ?? labelB}
              aria-label={labelB}
              onChange={(e) => commit(rows.map((r, j) => (j === i ? { ...r, priv: e.target.value } : r)))}
            />
            <button
              type="button"
              className="btn btn-sm"
              aria-label="Remove key pair"
              title="Remove"
              // Nothing to remove when this is the only row and it is already blank —
              // keeps one empty pair on screen as the obvious place to paste into.
              disabled={rows.length === 1 && !row.pub.trim() && !row.priv.trim()}
              onClick={() => commit(rows.filter((_, j) => j !== i))}
              style={{ flexShrink: 0 }}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => commit([...rows, { pub: "", priv: "" }])} style={{ marginTop: 8 }}>
        {addLabel}
      </button>
      {complete > 0 && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          <b>{complete}</b> {complete === 1 ? "key configured" : "keys configured"} — the app rotates between them automatically
        </p>
      )}
      {/* A row with only one half filled is silently dropped on save, which would look
          like "my key vanished". Say so while they are still looking at it. */}
      {halfFilled && (
        <p style={{ fontSize: 12, marginTop: 6, color: "var(--warning)" }}>
          Both boxes are needed — a pair with one half empty is not saved.
        </p>
      )}
      {help && (
        <p className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
          {help}
        </p>
      )}
    </div>
  );
}
