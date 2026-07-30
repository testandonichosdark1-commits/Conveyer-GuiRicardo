"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

export function LoginForm({ redirect }: { redirect: string }) {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form action={formAction} style={{ display: "grid", gap: 14 }}>
      <input type="hidden" name="redirect" value={redirect} />

      <div>
        <label className="label" style={{ display: "block", marginBottom: 6 }}>
          Email
        </label>
        <input
          className="input"
          type="email"
          name="email"
          autoComplete="email"
          autoFocus
          required
        />
      </div>

      <div>
        <label className="label" style={{ display: "block", marginBottom: 6 }}>
          Password
        </label>
        <input
          className="input"
          type="password"
          name="password"
          autoComplete="current-password"
          required
        />
      </div>

      {state.error && (
        <div
          role="alert"
          style={{
            fontSize: 13,
            color: "var(--danger, #e5484d)",
            background: "var(--danger-soft, rgba(229,72,77,0.1))",
            border: "1px solid var(--danger, #e5484d)",
            borderRadius: 8,
            padding: "8px 11px",
          }}
        >
          {state.error}
        </div>
      )}

      <button className="btn" type="submit" disabled={pending} style={{ marginTop: 4 }}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
