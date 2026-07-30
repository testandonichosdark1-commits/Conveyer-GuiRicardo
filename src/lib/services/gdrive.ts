import { google, drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import fs from "node:fs";
import path from "node:path";
import { getSetting, setSetting } from "../settings";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",       // only files we create/open
  "https://www.googleapis.com/auth/userinfo.email",   // to identify connected account
];

// MUST match the URI added in Google Cloud Console > OAuth client > Authorized redirect URIs.
// We hard-code port 3000 because Next.js may pick 3001 if 3000 is busy, but the OAuth
// flow has to run on a stable port the user registered in their Google Cloud project.
export const GDRIVE_REDIRECT_URI = "http://localhost:3000/api/gdrive/oauth/callback";

/** Build a fresh OAuth2 client, optionally with refresh_token loaded. */
export function getOAuth2Client(): OAuth2Client | null {
  const clientId = getSetting("GDRIVE_CLIENT_ID");
  const clientSecret = getSetting("GDRIVE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;

  const client = new google.auth.OAuth2(clientId, clientSecret, GDRIVE_REDIRECT_URI);
  const refresh = getSetting("GDRIVE_REFRESH_TOKEN");
  if (refresh) client.setCredentials({ refresh_token: refresh });
  return client;
}

/** First leg of OAuth: URL the user gets redirected to. */
export function buildAuthUrl(): string {
  const oauth = getOAuth2Client();
  if (!oauth) {
    throw new Error("Set GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in /settings first");
  }
  return oauth.generateAuthUrl({
    access_type: "offline",   // gets us a refresh_token
    prompt: "consent",        // forces refresh_token even on repeat connect
    scope: SCOPES,
  });
}

/** Second leg of OAuth: trade code for tokens, store refresh_token + email. */
export async function exchangeCodeForTokens(code: string): Promise<{ email: string }> {
  const oauth = getOAuth2Client();
  if (!oauth) throw new Error("OAuth client not configured");

  const { tokens } = await oauth.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Revoke prior access at https://myaccount.google.com/permissions and reconnect."
    );
  }
  oauth.setCredentials(tokens);

  const oauth2api = google.oauth2({ version: "v2", auth: oauth });
  const userinfo = await oauth2api.userinfo.get();
  const email = userinfo.data.email ?? "";

  setSetting("GDRIVE_REFRESH_TOKEN", tokens.refresh_token);
  setSetting("GDRIVE_CONNECTED_EMAIL", email);
  return { email };
}

/** Authenticated Drive client; null if creds/token missing. */
export function getDriveClient(): drive_v3.Drive | null {
  const oauth = getOAuth2Client();
  if (!oauth || !getSetting("GDRIVE_REFRESH_TOKEN")) return null;
  return google.drive({ version: "v3", auth: oauth });
}

/** Categorizes Drive errors so the UI can show targeted instructions. */
export type ConnectionErrorKind =
  | "api_not_enabled"   // Drive API not enabled in the user's Google Cloud project
  | "auth_invalid"       // refresh_token revoked, expired, or no longer valid
  | "network"            // transient network/timeout
  | "other";

export interface ConnectionStatus {
  connected: boolean;
  email?: string;
  /** Raw error message from the API call (kept verbatim for debugging). */
  error?: string;
  /** Categorized hint so UI can show the right action ("Enable API" vs "Reconnect"). */
  errorKind?: ConnectionErrorKind;
  /** When errorKind === "api_not_enabled", the direct Enable URL Google included in the response. */
  enableUrl?: string;
  /** Sync upload toggle. */
  syncEnabled: boolean;
  /** True when credentials are filled — i.e. OAuth flow can be started. */
  credentialsConfigured: boolean;
}

/** Parse the verbose Google API error string into a categorized hint. */
function classifyError(msg: string): { kind: ConnectionErrorKind; enableUrl?: string } {
  if (
    msg.includes("accessNotConfigured") ||
    msg.includes("has not been used in project") ||
    msg.includes("is disabled. Enable it")
  ) {
    // Pull the Enable URL out of the error if present.
    const m = msg.match(/https:\/\/console\.developers\.google\.com\/[^\s)]+/);
    return { kind: "api_not_enabled", enableUrl: m ? m[0] : undefined };
  }
  if (
    msg.includes("invalid_grant") ||
    msg.includes("Token has been expired") ||
    msg.includes("revoked") ||
    msg.includes("invalid_client") ||
    msg.includes("unauthorized")
  ) {
    return { kind: "auth_invalid" };
  }
  if (
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNRESET") ||
    msg.includes("network")
  ) {
    return { kind: "network" };
  }
  return { kind: "other" };
}

/** Live check: do we have a working connection right now? */
export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const credentialsConfigured =
    !!getSetting("GDRIVE_CLIENT_ID") && !!getSetting("GDRIVE_CLIENT_SECRET");
  const syncEnabled = getSetting("GDRIVE_SYNC_ENABLED") === "1";
  const email = getSetting("GDRIVE_CONNECTED_EMAIL");

  const drive = getDriveClient();
  if (!drive) return { connected: false, credentialsConfigured, syncEnabled };

  try {
    await drive.about.get({ fields: "user(emailAddress)" });
    return { connected: true, email: email || undefined, credentialsConfigured, syncEnabled };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { kind, enableUrl } = classifyError(msg);
    return {
      connected: false,
      email: email || undefined,
      error: msg,
      errorKind: kind,
      enableUrl,
      credentialsConfigured,
      syncEnabled,
    };
  }
}

/** Clears refresh_token + email (does NOT clear client_id/secret). */
export function clearConnection(): void {
  setSetting("GDRIVE_REFRESH_TOKEN", "");
  setSetting("GDRIVE_CONNECTED_EMAIL", "");
}

/**
 * Find a folder by name under a parent (or root). Returns the first match or
 * creates one if none exist. Folder name is exact-match.
 */
export async function findOrCreateFolder(name: string, parentId?: string): Promise<string> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  // Escape single quotes in the name to keep the query valid.
  const escapedName = name.replace(/'/g, "\\'");
  const qParts = [
    `name='${escapedName}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    parentId ? `'${parentId}' in parents` : "'root' in parents",
  ];

  const found = await drive.files.list({
    q: qParts.join(" and "),
    fields: "files(id, name)",
    pageSize: 1,
  });
  if (found.data.files && found.data.files.length > 0) {
    return found.data.files[0].id!;
  }

  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id",
  });
  return created.data.id!;
}

/**
 * Resolve the two top-level folders we use. If folder IDs are already saved in
 * settings, they're returned as-is. Otherwise creates `Conveyer Grok/Final Videos`
 * and `Conveyer Grok/Clips Library` in the user's Drive root and persists the IDs.
 * Separate root folder from Hum Conveyer so the two projects stay isolated in Drive.
 */
export async function ensureTopLevelFolders(): Promise<{
  finalVideosId: string;
  clipsLibraryId: string;
}> {
  let finalId = getSetting("GDRIVE_FINAL_VIDEOS_FOLDER_ID");
  let clipsId = getSetting("GDRIVE_CLIPS_LIBRARY_FOLDER_ID");

  if (!finalId || !clipsId) {
    const rootFolder = await findOrCreateFolder("Conveyer Grok");
    if (!finalId) {
      finalId = await findOrCreateFolder("Final Videos", rootFolder);
      setSetting("GDRIVE_FINAL_VIDEOS_FOLDER_ID", finalId);
    }
    if (!clipsId) {
      clipsId = await findOrCreateFolder("Clips Library", rootFolder);
      setSetting("GDRIVE_CLIPS_LIBRARY_FOLDER_ID", clipsId);
    }
  }
  return { finalVideosId: finalId, clipsLibraryId: clipsId };
}

function guessMime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".mp4": return "video/mp4";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".json": return "application/json";
    case ".md": return "text/markdown";
    case ".txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

/** Upload a local file to Drive. Returns the new file's ID. */
export async function uploadFile(
  localPath: string,
  parentId: string,
  options: { name?: string; mimeType?: string } = {}
): Promise<string> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const fileName = options.name ?? path.basename(localPath);
  const mimeType = options.mimeType ?? guessMime(localPath);

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: "id",
  });
  return res.data.id!;
}

/** Upload arbitrary in-memory content as a file (used for clips.json, description.md). */
export async function uploadString(
  content: string,
  parentId: string,
  name: string,
  mimeType: string
): Promise<string> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const res = await drive.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: content },
    fields: "id",
  });
  return res.data.id!;
}

/**
 * Get the human-openable Drive web link for a file or folder ID.
 * Used by the UI to render "Open in Drive" buttons.
 */
export async function getFileWebLink(fileId: string): Promise<string | null> {
  const drive = getDriveClient();
  if (!drive) return null;
  try {
    const res = await drive.files.get({ fileId, fields: "webViewLink" });
    return res.data.webViewLink ?? null;
  } catch {
    return null;
  }
}

/** Download a file from Drive to a local path. */
export async function downloadFile(fileId: string, destPath: string): Promise<void> {
  const drive = getDriveClient();
  if (!drive) throw new Error("Drive not connected");

  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.data.on("end", resolve).on("error", reject).pipe(out);
  });
}
