"use client";
import type { Val, Set } from "./useSettings";

/** One labelled text input bound to a setting key. `required` shows a red badge. */
export function SettingsField({
  label,
  settingKey,
  val,
  set,
  required,
  placeholder,
  displayValue,
}: {
  label: string;
  settingKey: string;
  val: Val;
  set: Set;
  required?: boolean;
  placeholder?: string;
  /**
   * DISPLAY-ONLY override for the input's rendered text. The stored setting is untouched —
   * pass "" to show the placeholder while a stale value stays saved. Omit for normal binding.
   */
  displayValue?: string;
}) {
  return (
    <div>
      <label className="label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {label}
        {required && (
          <span className="badge" style={{ background: "var(--warning-soft)", color: "var(--warning)", fontSize: 9.5, padding: "1px 6px" }}>
            required
          </span>
        )}
      </label>
      <input className="input" value={displayValue ?? val(settingKey)} onChange={(e) => set(settingKey, e.target.value)} placeholder={placeholder} />
    </div>
  );
}
