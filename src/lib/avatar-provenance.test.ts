import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Regression guard: an IMPORTED avatar must never be deletable from the operator's
 * HeyGen account.
 *
 * The bug: the delete route fired DELETE /v2/talking_photo/{id} for any
 * engine="talking_photo" row with a heygen_id. Imported rows reference an avatar the
 * operator created on HeyGen — removing it from OUR library destroyed THEIR asset,
 * with no way to tell the two apart. `avatars.imported` is that distinction; these
 * tests pin the flag and the backfill that classifies pre-existing rows.
 *
 * Runs against a throwaway DB (FACELESS_STUDIO_DATA_DIR) — no real data, no keys.
 */
let avatars!: typeof import("./avatars");
let db!: typeof import("./db").default;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "avatar-prov-"));
  process.env.FACELESS_STUDIO_DATA_DIR = dir;
  const { ensureInit } = await import("./init");
  ensureInit();
  avatars = await import("./avatars");
  db = (await import("./db")).default;
});

describe("avatar provenance flag", () => {
  it("marks an imported avatar and leaves a locally-created one unmarked", () => {
    const importedId = avatars.createAvatar({ name: "Imported One", imported: true, status: "ready" });
    const localId = avatars.createAvatar({ name: "Local One", status: "pending" });

    expect(avatars.getAvatar(importedId)!.imported).toBe("1");
    expect(avatars.getAvatar(localId)!.imported).toBeNull();
  });

  it("exposes the flag through listAvatars (the delete route reads it off the row)", () => {
    const row = avatars.listAvatars().find((a) => a.name === "Imported One");
    expect(row?.imported).toBe("1");
  });
});

/**
 * The REAL guard the delete route calls (src/app/api/avatars/[id]/route.ts) — imported
 * here rather than restated, so these assertions actually bind the route's behavior.
 */
const deletesRemotely = (a: { imported: string | null; engine: string; heygen_id: string | null }) =>
  avatars.ownsHeygenAsset(a as Parameters<typeof avatars.ownsHeygenAsset>[0]);

describe("remote-delete guard", () => {
  it("never deletes remotely for an imported talking photo (the bug)", () => {
    expect(deletesRemotely({ imported: "1", engine: "talking_photo", heygen_id: "tp_1" })).toBe(false);
  });

  it("still frees the slot for a locally-created talking photo (unchanged)", () => {
    expect(deletesRemotely({ imported: null, engine: "talking_photo", heygen_id: "tp_1" })).toBe(true);
  });

  it("does not call HeyGen for a group/avatar-type row or one with no handle", () => {
    expect(deletesRemotely({ imported: null, engine: "photo_avatar_group", heygen_id: "look_1" })).toBe(false);
    expect(deletesRemotely({ imported: null, engine: "talking_photo", heygen_id: null })).toBe(false);
  });
});

describe("backfill for rows imported before the column existed", () => {
  /** Re-run the migration's backfill statement (idempotent — only fills NULLs). */
  function backfill() {
    db.exec(
      `UPDATE avatars SET imported = '1'
        WHERE imported IS NULL AND ref_image_path IS NULL AND heygen_id IS NOT NULL`
    );
  }

  it("classifies a legacy imported row (no ref image, has a handle) as imported", () => {
    const id = avatars.createAvatar({ name: "Legacy Import", status: "ready" });
    avatars.updateAvatar(id, { heygen_id: "tp_legacy" }); // no ref_image_path — the import tell
    db.prepare("UPDATE avatars SET imported = NULL WHERE id = ?").run(id); // pre-column state

    backfill();
    expect(avatars.getAvatar(id)!.imported).toBe("1");
    expect(deletesRemotely(avatars.getAvatar(id)!)).toBe(false);
  });

  it("leaves a locally-created row alone — it always has a ref_image_path once ingested", () => {
    const id = avatars.createAvatar({ name: "Legacy Local", ref_image_path: "/tmp/ref.jpg", status: "ready" });
    avatars.updateAvatar(id, { heygen_id: "tp_local" });

    backfill();
    expect(avatars.getAvatar(id)!.imported).toBeNull();
    expect(deletesRemotely(avatars.getAvatar(id)!)).toBe(true); // still frees its own slot
  });

  it("leaves a never-ingested row alone (no handle → nothing to own)", () => {
    const id = avatars.createAvatar({ name: "Pending Local", status: "pending" });
    backfill();
    expect(avatars.getAvatar(id)!.imported).toBeNull();
  });
});

/**
 * Avatar V metadata (Stage 1). Avatar V is an ENGINE, not an avatar type — the avatar is
 * an ordinary talking_photo that HeyGen happens to report as Avatar V-capable. So
 * `api_engine` records the operator's CHOICE (intent); it is never a cached capability,
 * because capability comes from HeyGen's live supported_api_engines and can change.
 */
describe("avatar V metadata", () => {
  it("stores the operator's engine choice as intent, alongside an ordinary avatar type", () => {
    const id = avatars.createAvatar({
      name: "AV Pick", engine: "talking_photo", api_engine: "avatar_v", imported: true, status: "ready",
    });
    const row = avatars.getAvatar(id)!;
    expect(row.engine).toBe("talking_photo"); // no separate avatar type exists for Avatar V
    expect(row.api_engine).toBe("avatar_v");
    expect(row.imported).toBe("1"); // picked from HeyGen → never deleted there
  });

  it("leaves api_engine NULL for the v2 engines (Avatar IV / Legacy)", () => {
    const id = avatars.createAvatar({ name: "Plain TP", engine: "talking_photo" });
    expect(avatars.getAvatar(id)!.api_engine).toBeNull();
  });

  it("never deletes a picked Avatar V avatar from HeyGen (it is imported)", () => {
    const id = avatars.createAvatar({
      name: "AV Del", engine: "talking_photo", api_engine: "avatar_v", imported: true, status: "ready",
    });
    avatars.updateAvatar(id, { heygen_id: "87a11dc1" });
    expect(avatars.ownsHeygenAsset(avatars.getAvatar(id)!)).toBe(false);
  });
});

/**
 * Stage 2 renders Avatar V on v3, so `isRenderableAvatar` — the Stage-1 guard that made
 * such an avatar unselectable — is gone, along with the tests that pinned it.
 *
 * Nothing replaces it HERE, and that is the point: renderability is no longer a property
 * of the stored row. It is a live question for HeyGen, asked once per execution by
 * /api/studio and resumeStudioPipeline (see avatar-v.test.ts → checkAvatarVSupport).
 * A test asserting "this row is renderable" would be asserting exactly the cached
 * capability the design forbids.
 */
