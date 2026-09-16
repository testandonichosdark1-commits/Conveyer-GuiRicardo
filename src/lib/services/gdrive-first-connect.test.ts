import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Auto-enable auto-upload on a user's FIRST Google Drive connection.
 *
 * Connecting Drive and enabling uploads used to be unrelated actions on two different
 * pages, so the normal outcome was a correctly connected account that silently never
 * uploaded — with no error to explain it. Connecting now turns it on, but ONLY when
 * doing so cannot override something the user (or an existing install) already decided.
 *
 * The two guards, and why each exists:
 *   - no prior refresh token → this is a first-ever connection, not a reconnect or an
 *     account switch. This is what makes EXISTING installs untouchable: anyone already
 *     connected has a token, whatever their toggle says.
 *   - GDRIVE_SYNC_ENABLED === "" → never configured. "0" means a deliberate opt-out,
 *     which a reconnect must never undo.
 *
 * googleapis is stubbed — no network, no real OAuth.
 */

const { store } = vi.hoisted(() => ({ store: {} as Record<string, string> }));
const { google } = vi.hoisted(() => ({
  google: {
    tokens: { refresh_token: "rt-new" } as { refresh_token?: string },
    email: "user@example.com",
  },
}));

vi.mock("../settings", () => ({
  getSetting: (k: string) => store[k] ?? "",
  setSetting: (k: string, v: string) => {
    store[k] = v;
  },
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        generateAuthUrl() { return "https://accounts.google.com/o/oauth2/auth"; }
        async getToken() { return { tokens: google.tokens }; }
        setCredentials() {}
      },
    },
    oauth2: () => ({ userinfo: { get: async () => ({ data: { email: google.email } }) } }),
    drive: () => ({}),
  },
}));

import { exchangeCodeForTokens, getConnectionStatus } from "./gdrive";

/** A configured-but-not-yet-connected install: credentials saved, no token. */
function freshInstall() {
  for (const k of Object.keys(store)) delete store[k];
  store.GDRIVE_CLIENT_ID = "cid";
  store.GDRIVE_CLIENT_SECRET = "csecret";
}

beforeEach(() => {
  freshInstall();
  google.tokens = { refresh_token: "rt-new" };
});

describe("first connection enables auto-upload", () => {
  it("turns the toggle on when nothing was configured and nothing was connected", async () => {
    const r = await exchangeCodeForTokens("code");
    expect(r.autoEnabledSync).toBe(true);
    expect(store.GDRIVE_SYNC_ENABLED).toBe("1");
  });

  it("still stores the OAuth credentials it always did", async () => {
    const r = await exchangeCodeForTokens("code");
    expect(store.GDRIVE_REFRESH_TOKEN).toBe("rt-new");
    expect(store.GDRIVE_CONNECTED_EMAIL).toBe("user@example.com");
    expect(r.email).toBe("user@example.com");
  });

  it("does not touch any other Drive setting (folder ids stay lazily created)", async () => {
    await exchangeCodeForTokens("code");
    expect(store.GDRIVE_FINAL_VIDEOS_FOLDER_ID).toBeUndefined();
    expect(store.GDRIVE_CLIPS_LIBRARY_FOLDER_ID).toBeUndefined();
  });
});

describe("a deliberate opt-out is never undone", () => {
  it("leaves an explicit '0' alone on a fresh connection", async () => {
    store.GDRIVE_SYNC_ENABLED = "0";
    const r = await exchangeCodeForTokens("code");
    expect(r.autoEnabledSync).toBe(false);
    expect(store.GDRIVE_SYNC_ENABLED).toBe("0");
  });

  it("leaves an explicit '0' alone on a reconnect", async () => {
    store.GDRIVE_REFRESH_TOKEN = "rt-old";
    store.GDRIVE_SYNC_ENABLED = "0";
    const r = await exchangeCodeForTokens("code");
    expect(r.autoEnabledSync).toBe(false);
    expect(store.GDRIVE_SYNC_ENABLED).toBe("0");
  });

  it("treats an env-provided value as a choice too, and does not overwrite it", async () => {
    // getSetting falls back to process.env for an empty stored value, so an operator
    // who set it in the environment has already expressed a preference.
    store.GDRIVE_SYNC_ENABLED = "0";
    await exchangeCodeForTokens("code");
    expect(store.GDRIVE_SYNC_ENABLED).toBe("0");
  });
});

describe("existing installs are untouchable", () => {
  it("a reconnect never enables it, even when the toggle looks unconfigured", async () => {
    // The historical ambiguity: before the tri-state, unticking wrote "". A pre-existing
    // user who had turned it off is indistinguishable from one who never touched it —
    // so the prior-token guard, not the toggle, is what protects them.
    store.GDRIVE_REFRESH_TOKEN = "rt-old";
    store.GDRIVE_SYNC_ENABLED = "";
    const r = await exchangeCodeForTokens("code");
    expect(r.autoEnabledSync).toBe(false);
    expect(store.GDRIVE_SYNC_ENABLED).toBe("");
  });

  it("an account switch keeps an already-ON toggle on, and reports it did not change it", async () => {
    store.GDRIVE_REFRESH_TOKEN = "rt-old";
    store.GDRIVE_SYNC_ENABLED = "1";
    const r = await exchangeCodeForTokens("code");
    expect(r.autoEnabledSync).toBe(false); // it was already on — we did not enable it
    expect(store.GDRIVE_SYNC_ENABLED).toBe("1");
    expect(store.GDRIVE_REFRESH_TOKEN).toBe("rt-new"); // the new account's token wins
  });
});

describe("failure modes", () => {
  it("enables nothing when Google returns no refresh_token", async () => {
    google.tokens = {};
    await expect(exchangeCodeForTokens("code")).rejects.toThrow(/refresh_token/);
    expect(store.GDRIVE_SYNC_ENABLED).toBeUndefined();
    expect(store.GDRIVE_REFRESH_TOKEN).toBeUndefined();
  });

  it("enables nothing when the OAuth client is not configured", async () => {
    delete store.GDRIVE_CLIENT_ID;
    await expect(exchangeCodeForTokens("code")).rejects.toThrow(/not configured/);
    expect(store.GDRIVE_SYNC_ENABLED).toBeUndefined();
  });
});

describe("backward compatibility: the new '0' reads as OFF everywhere", () => {
  it('getConnectionStatus reports syncEnabled only for "1"', async () => {
    // The real read-side rule (`=== "1"`), exercised rather than restated. Introducing
    // "0" therefore cannot change any existing install: "" and "0" are both off, and
    // every stored value predating this change is one of "" or "1".
    for (const [value, expected] of [["1", true], ["0", false], ["", false]] as const) {
      store.GDRIVE_SYNC_ENABLED = value;
      expect((await getConnectionStatus()).syncEnabled, `value=${JSON.stringify(value)}`).toBe(expected);
    }
  });
});
