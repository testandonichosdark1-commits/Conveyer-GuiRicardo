import { LoginForm } from "./_form";

export const metadata = {
  title: "Sign in — Faceless Video Generator",
};

/**
 * Login screen. The middleware sends unauthenticated visitors here with the
 * originally-requested path in ?redirect=, which we thread into the form so the
 * login action can send them back to it. No signup — users are created in the
 * Supabase dashboard.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;

  return (
    <div
      style={{
        minHeight: "70vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 380, display: "grid", gap: 18 }}>
        <div style={{ display: "grid", gap: 6, textAlign: "center" }}>
          <div style={{ fontSize: 26 }}>🎬</div>
          <h1 style={{ fontSize: 19, fontWeight: 700, margin: 0 }}>Faceless Video Generator</h1>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            Sign in to continue
          </p>
        </div>

        <LoginForm redirect={redirect ?? "/"} />
      </div>
    </div>
  );
}
