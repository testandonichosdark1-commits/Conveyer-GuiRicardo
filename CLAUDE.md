# CLAUDE.md — project context for Claude Code

Auto-loaded by Claude Code. Full picture of **Faceless Video Generator**.

---

## What Faceless Video Generator is

A **local web app** that turns a written script into a finished, avatar-fronted
**documentary YouTube video**. The operator pastes a script and picks a recurring
**avatar** (an ultra-realistic presenter created once from a reference photo).
**ElevenLabs** narrates the whole script; **HeyGen** brings the avatar to life,
lip-synced to that narration; the rest of the screen time is filled with **real
internet footage** (Pexels / Pixabay / Openverse / Wikimedia, optionally YouTube)
or **AI b-roll** (Grok via 69labs) — operator's choice (AI / real / mix). Still
images get a **Ken Burns** zoom. Runs entirely on the user's machine
(Next.js dev server + local SQLite + local FFmpeg).

**Target user**: non-technical YouTube creators. UX must stay simple.
**Built from**: Conveyer Grok – Bullnet 2.0 (faceless AI-video pipeline). It
adds the avatar library, the script→ElevenLabs→HeyGen flow, the broader
real-footage search, and Ken Burns on stills.

**Read `docs/DESIGN.md`** — it has the full design + the confirmed HeyGen,
ElevenLabs, footage-source and Ken Burns API details.

---

## Stack

- **Next.js 16** (App Router, Turbopack) · **React 19** · **TypeScript** · **Tailwind 4**
- **better-sqlite3** — local DB at `~/.faceless-studio/studio.db` (override `FACELESS_STUDIO_DATA_DIR`)
- **fluent-ffmpeg** / system FFmpeg — voiceover concat, Ken Burns, beat compositing
- Node ≥ 20. Dev server: `npm run dev` on port 3000.

---

## The studio pipeline (the new core)

`POST /api/studio` (script **or** `voiceoverUploadId`, + avatarId + visualMode +
timing) → inserts a `runs` row, snapshots the chosen avatar + channel onto it,
fires `runStudioPipeline()` in the background → UI streams logs at `/runs/[id]`.

`src/lib/studio-pipeline.ts` `runStudioPipeline(runId, script, voiceoverUploadPath?)`:
1. **Voiceover** — the ONLY place the two narration sources differ (see
   "Upload voiceover" below). Script mode: `services/elevenlabs-voiceover.ts`
   synthesizes the whole script via ElevenLabs `/with-timestamps`, returning
   `voiceover.mp3` + per-word timings (no Whisper pass); long scripts are chunked
   + timings offset to one timeline. Upload mode: `services/voiceover-file.ts`
   ingests the operator's file instead. **Both return the same `Voiceover`**, so
   steps 2–4 are shared verbatim.
2. **Beats** — `services/studio-plan.ts` folds words into ~`SECONDS_PER_VISUAL`
   beats (sentence-aware), picks ~`AVATAR_FREQUENCY_PERCENT` avatar beats
   (beat 0 = full "avatar", others = "split"), asks Gemini for a concrete visual
   query per b-roll beat, and assigns real-vs-AI source by ratio.
3. **Per beat** (concurrency-limited):
   - b-roll (broll/split) → `services/visual-source.ts`: real footage from
     Pexels/Pixabay/Openverse/Wikimedia (+ opt-in YouTube via yt-dlp), else AI
     via `img2vid.ts`. Stills → `services/ken-burns.ts` zoom clip.
   - avatar (avatar/split) → slice that beat's audio, `services/heygen-video.ts`
     generates a HeyGen talking-head clip for just that slice (cheap — only ~15%
     of beats), driven by our ElevenLabs audio.
4. **Composite** — `services/studio-assemble.ts` renders each beat silent to its
   exact length, concatenates (hard cuts), and muxes the one master voiceover.

The faceless base pipeline (`pipeline.ts`, scene-split) and the old "upload a
finished avatar MP4" flow (`avatar-pipeline.ts`, `/avatar`) still exist but are
not in the nav.

### AI photo / video balance (`aiVideoPercent`)

A **per-run** slider on `/`, shown only when AI media is `auto`. It travels in the
POST body → `runs.config_json` (never a global setting), so Resume replays the ratio
the run was created with. `applyAiVideoRatio` in `studio-plan.ts` splits the AI beats
with the same `spread()` the real/AI ratio uses.

- **Absent = unchanged.** `aiVideoPercent` is spread into `config_json` only when
  actually sent, so a run created without it has a byte-identical config and plans
  exactly as it did before the slider existed. Don't give it a default in `readConfig`.
- **The denominator is AI b-roll beats only** — avatar and real-footage beats are
  excluded. Counting beats the ratio can't govern would quietly deliver less video the
  more real footage a run uses.
- **`KIE_AI_MEDIA` still outranks it.** `image`/`video` are hard modes checked first in
  `resolveAiMedia`; the ratio only applies under `auto`. A client on "Images only" must
  never be billed for video, whatever a resumed run's stored ratio says.
- `beat.aiMediaPinned` is **provenance, not control flow**: `applyAiVideoRatio`
  overwrites `beat.aiMedia`, so the planner branch below would return the same value.
  It exists so the run log says `run-ratio` rather than `planner`.

### Product shots (`product_label`)

An optional planner field carrying the wording that should be legible on a product's
packaging (`beat.productLabel`). **Empty on most beats, and empty means the generation
prompt is byte-identical to before the field existed** — that identity is pinned by
`LEGACY_KIE_PROMPT` in `runware-broll.test.ts`, which must not be edited.

- **The bug it fixes is a missing PRODUCT, not a missing label.** `blank unlabeled plain
  packaging` is a POSITIVE clause (it survives `keepPositiveClauses` into the positive
  prompt) and it describes the object, not just its text. Measured: a beat whose narration
  said "The brand name is Arm & Hammer Super Washing Soda" — and whose `ai_prompt` asked
  for that box "with the brand name clearly visible" — rendered as a **featureless yellow
  cube**. So the product branch asserts identity first, lettering second; a correctly
  spelled label on an anonymous block is the same failure.
- **The blanket ban cannot simply be lifted.** It is what keeps invented signage, captions
  and rendered narration off landscapes and faces. Only a planner-marked product beat
  swaps it out.
- **`normalizeProductLabel` is not tidiness.** The value is handed to an image model as
  text to RENDER: a sentence comes back as scribble across the pack, and a narration echo
  re-introduces the exact bug the ban was written to stop. Hence the 32-char / 4-word /
  no-sentence-punctuation gate.
- The planner already carried named brands into `ai_prompt` on its own (measured: 79% of
  185 branded beats across 183 stored plans). Rule (5) of the ENTITY RULE now says so
  explicitly, turning a habit into a guarantee.

---

## Upload voiceover (narration the operator recorded themselves)

The operator picks a narration source on `/` — **Script** (paste text, we
synthesize) or **Upload voiceover** (their own recording). Upload mode exists
because a creator who already has a narration — their own voice, or one produced
elsewhere — was otherwise forced through one of our TTS providers to use the
product at all, and paid for a voice they didn't want.

### The `Voiceover` abstraction is the whole design

```
synthesizeVoiceover(script) → ElevenLabs → mp3 + alignment → Voiceover
voiceoverFromFile(upload)   → transcode  → mp3 + Whisper   → Voiceover
                                                              ↓
                     planner · avatar slicing · assembly · Resume
```

`Voiceover { filePath, durationSec, words }` is the **single seam**. Everything
downstream already treated the audio as opaque, so the feature adds ONE branch to
`runStudioPipeline` (step 1) and changes nothing else — no planner, visual,
avatar or assembly code is branched or duplicated. When you extend this, keep new
narration sources behind that same seam; a second branch further down the
pipeline is the thing this design exists to prevent.

### Flow

1. **`POST /api/uploads/voiceover?filename=…`** — audio is the **raw request
   body, not multipart**, so it streams to disk via `Readable.fromWeb` +
   `stream/promises.pipeline` in constant memory (measured: a 403 MB upload moved
   RSS by ~31 MB). `formData()`/`arrayBuffer()` would spike the heap by the full
   file size.
2. The file is staged at `<DATA_DIR>/uploads/<uuid>.<ext>` and validated by
   `services/voiceover-upload.ts` **before any run row exists** — a rejection
   costs nothing: no run, no voiceover spend, no HeyGen call. Rejected and
   half-written files are deleted immediately.
   → 200 `{ uploadId, durationSec, sizeBytes, codec, sampleRateHz, channels }`
   → 400 `{ error, reason }`, `reason ∈ empty | unreadable | no_audio_stream |
   no_duration | too_long`.
3. **`POST /api/studio` with `voiceoverUploadId`** (never raw audio). Script and
   upload are **mutually exclusive** — neither is 400 "Script is required."
   (byte-identical to the pre-feature check, so old clients can't tell the
   difference), both is 400.
4. `resolveStagedUpload()` maps the id to its file; `runStudioPipeline(runId, "",
   path)` ingests it via `services/voiceover-file.ts`.

### Formats & limits

- **Whatever ffmpeg can decode.** The UI advertises mp3/wav/m4a/aac/flac/ogg, but
  the file **extension is never a gate** — `extForUpload()` is cosmetic (unknown →
  `.bin`) and ffprobe sniffs the real container. A video file works too (`-vn`
  takes its audio track); a renamed `.txt` is rejected by the probe, not the name.
- **50 minutes** (`UPLOAD_MAX_MINUTES`). The binding constraint is Groq's 25 MB
  limit: our mono/16 kHz/64 kbps downmix is ~8 kB/s → 25 MB ≈ 54 min. **Raising
  this past ~54 makes Whisper fail and the timings unusable.** No byte-size cap —
  duration is the real constraint and the stream never buys memory.
- `UPLOAD_MAX_MINUTES` is a DB/API-only key with no form field. Normal, not an
  oversight (see the settings note below).

### Invariants — the load-bearing ones

- **The master is ALWAYS `<runDir>/audio/voiceover.mp3`.** Any input is transcoded
  to it (libmp3lame 192k/44.1 kHz). That filename is why Resume needed **zero
  changes**: `canResumeStudioRun` and `resumeStudioPipeline` look it up by name,
  so an upload-sourced run resumes exactly like a script one. Don't "optimize"
  away the transcode for an mp3 input — normalizing the container is what makes
  the rest true.
- **Duration is probed from the TRANSCODED master, never the upload.** A truncated
  source can declare a longer duration in its header than it contains, and every
  beat timing derives from this number.
- **Validation uses `probeAudioStrict`, not `probeDurationSafe`** — the safe probe
  invents a duration from file size for unreadable input, which would let a
  renamed text file through the gate.
- **Timings are real or the run fails.** There is no script to fall back on, so
  `voiceoverFromFile` throws on zero words rather than accepting
  `proportionalWords()`. Evenly-spaced fabricated timings are precisely the defect
  that desynced every pre-Groq non-ElevenLabs run; a clear failure beats a
  silently drifting video.
- **`GROQ_API_KEY` is required, and refused early — twice.** `/api/studio` 409s
  before the run row exists; `voiceoverFromFile` re-checks *before* transcoding.
  Neither is redundant: the pipeline is also reachable without passing through the
  route. Whisper is the only way to time audio that has no script.
- **`resolveStagedUpload` treats the id as hostile.** It comes from a request
  body, so it is matched against a strict UUID pattern **before** the filesystem is
  touched — that, not sanitization afterwards, is what stops `../../etc/passwd`
  being joined onto the staging path. The extension is discovered by listing the
  directory, never trusted from input.
- **Script mode is byte-identical.** `config_json` gains `voiceoverSource:
  "upload"` **only** on upload runs, and nothing branches on it (the pipeline is
  handed the path directly) — it is provenance, so a run can be identified later.
  Verified against a pre-change run.

### Cost

No voiceover generation cost — the operator supplies the audio. The only spend is
Groq Whisper (`COST_GROQ_USD_PER_AUDIO_HOUR`, ~$0.11/h ⇒ ~$0.006 for a 3-min
video), metered by the existing `recordGroqTranscription` inside `alignWords`.

---

## Avatar library (the core feature)

- DB table `avatars` (see `db.ts`) + CRUD in `src/lib/avatars.ts`.
- Create: `/avatars` page → `POST /api/avatars` (multipart: name, description,
  engine, image). Saves a local copy of the reference image under
  `<DATA_DIR>/avatars/<id>.<ext>`, then `services/heygen-avatar.ts` `ingestAvatar()`
  registers it with HeyGen in the background; the UI polls status.
- Avatar **type** (`avatars.engine`): **talking_photo** (default, no training —
  upload → `talking_photo_id`) or **photo_avatar_group** (trained, slower).
  `status`: pending → training → ready → error.
- Render **engine** — a separate axis from the type, stored across TWO columns, and
  the operator's INTENT (never a cached capability). There is no `render_engine`
  column; don't add one, it would only drift:
  | stored | engine | rendered via |
  |---|---|---|
  | `api_engine = 'avatar_v'` | Avatar V | v3 `POST /v3/videos` |
  | `use_avatar_iv = '1'` | Avatar IV | v2 `use_avatar_iv_model: true` |
  | both NULL | Legacy (HeyGen calls it "Unlimited") | v2, flag omitted |
  NULL `use_avatar_iv` genuinely means Legacy, not "unset": the pipeline decodes it
  with a strict `=== "1"`, so pre-column rows really do render without the flag.
  `use_avatar_iv_model` is valid for **both** v2 character types (talking_photo AND
  avatar) — it applies to imported avatars too.
- **Avatar V availability is HeyGen's live `supported_api_engines`, per avatar, and is
  never cached or inferred.** HeyGen's docs claim Avatar V is Digital-Twin-only; the
  live API contradicts them and grants it to ordinary photo avatars, so nothing
  filters on `avatar_type` — follow the API, not the docs. Avatars created through our
  own upload flow arrive WITHOUT avatar_v, and no rule for how support is granted is
  documented or discoverable (several hypotheses were tested and falsified), so the UI
  never advises how to obtain it. A v3 look id IS a v2 avatar id — the same avatar
  through two APIs — which is why the Avatar V picker reuses the ordinary
  import-by-id flow instead of adding a second workflow.
- A run snapshots the resolved avatar onto `runs.avatar_*` columns at create time,
  **including `avatar_api_engine`** — that one is load-bearing, not bookkeeping: an
  Avatar V avatar stores as `engine='talking_photo'` + `use_avatar_iv=NULL`, byte-identical
  to a Legacy one, so without the snapshot a resumed run cannot tell them apart, falls onto
  v2, and renders Avatar V as Legacy at $1/min instead of $4. Don't "simplify" it into a
  live read of `avatars.api_engine`: the row can be edited or deleted between create and
  resume, and a run must replay what it was CREATED with.
- **Eligibility is re-checked live once per execution, never cached.** `/api/studio`
  checks before the run row exists (a refusal costs nothing); `resumeStudioPipeline`
  checks again, because resume re-enters the pipeline without passing through that route.
  Neither fails open, and neither ever downgrades to Avatar IV — a stored `api_engine`
  records what was CHOSEN, never that HeyGen still grants it.

### Rendering Avatar V (`POST /v3/videos`)

Verified live (2026-07-17) — the v3 body is built SEPARATELY from v2's in
`heygen-video.ts`, and must stay that way:

- **v3 validates strictly**: an unknown field is `400 "Extra inputs are not permitted"`,
  never a silent ignore. Every v2-only field is therefore fatal here — which is why there
  is no shared request builder, and why `buildV3Body`'s exact key set is pinned by a test.
  Do not add a field without probing it first.
- Body is a **tagged union on top-level `type`** (`avatar` | `image` | `cinematic_avatar`).
  Omitting it 400s before any other validation.
- `engine.type` (`avatar_v` | `avatar_iv` | `avatar_iii`) is **optional to the API** —
  omitted, it renders on HeyGen's default. Always send it: an omitted engine is a silent
  substitution.
- v2's `dimension: {width,height}` is **rejected**. v3 takes `resolution`
  (`4k`|`1080p`|`720p`) + `aspect_ratio` (`16:9`|`9:16`|`4:5`|`5:4`|`1:1`|`auto`).
  `v3Size()` maps our `WxH`, keying the tier off the **shorter** side (portrait 1080 is
  still 1080p). `1:1` is real here — square needs no coercion, unlike Veo.
- `expressiveness` is **rejected** for `avatar_v`. `title`, `background` and
  `motion_prompt` are accepted.
- **No `/v3/assets` upload path, deliberately.** An asset from the existing raw v1
  endpoint (`uploadAsset`) resolves via `GET /v3/assets/{id}` and is accepted as
  `audio_asset_id` — proven by a real render. So `uploadWithRetry` is shared, and its
  retry/cancellation handling is not duplicated. (The two endpoints return different
  shapes: v1 `data.id`, v3 `data.asset_id`.)
- Create returns `data.video_id`; the status payload calls the same thing `id`.
  Poll `GET /v3/videos/{id}`: `waiting` → `processing` → `completed`, with `video_url`
  and `duration` appearing only on completion. The failure payload has never been
  observed. Polling/deadline/cancellation and `download()` are the v2 ones, reused.

---

## Google Flow browser provider (`AI_PROVIDER=flow_browser`)

An **experimental** AI b-roll provider that has no API of its own: `src/lib/services/flow-browser.ts`
drives the normal Google Flow web UI (`labs.google/fx/tools/flow`) through a locally-attached,
operator-owned Chrome — never the Gemini image API, the Veo API, a Google Flow API, MCP, or any
paid fallback unless `FLOW_FALLBACK_PROVIDER=kie` is explicitly set. It generates **both**
Nano Banana stills and Veo videos; it is not image-only.

- **Normal Chrome, attached over local CDP — never a Playwright-launched browser.** `ensureNormalChrome`
  spawns system Chrome with `--remote-debugging-port` (`FLOW_CDP_PORT`, default `9223`, loopback
  only) + a **persistent, dedicated profile** (`FLOW_BROWSER_PROFILE_DIR`, default
  `<DATA_DIR>/flow-chrome-profile` — never the operator's personal Chrome profile), then
  `chromium.connectOverCDP(endpoint, { noDefaults: true })` attaches to it. `noDefaults: true` is
  load-bearing: without it Playwright issues `Browser.setDownloadBehavior` against the default
  context, which recent Chrome rejects with "Browser context management is not supported". A
  `launchPersistentContext`/automated-Chromium launch was tried historically and made Google block
  sign-in ("this browser or app may not be secure") — do not go back to it. One login persists
  across app restarts; Resume/reconnect needs no re-login.
- **Serialized process-wide, images and video share ONE queue** (`enqueue()` / `state.queue`,
  a module-global surviving hot-reload via `globalThis.__facelessFlowBrowserState`). Even though
  `studio-pipeline` requests several beats concurrently, only one prompt/generation/download is ever
  in flight in the one controlled tab — mode switches (Image↔Video, Nano Banana↔Veo tier) can never
  interleave with an in-progress generation.
- **`openFlowSession()` / `flowSessionStatus()` (Settings → "Open Flow / test session") only verify
  connectivity + login — they never generate anything and spend no credits.** Success message:
  *"Normal Chrome is connected to Google Flow. Session is ready; no image or video was generated."*

### Image path (Nano Banana) — unchanged by the Veo work

`generateFlowImage()`: `ensureFlowImageMode` (mode switch + `ensureNanoBanana` — confirms the
configured `FLOW_IMAGE_MODEL`, e.g. `nano-banana-pro`, is the ACTIVE model; **fails loud**, never
silently generates on a different model) → `ensureFlowAspectRatio` (best-effort) →
`prepareComposerReference` (clear any previous beat's attachment, attach the character reference
only when `beatWantsCharacterReference(beat)` says so) → fill prompt → `submitPrompt` (accessible
Generate button → `form.requestSubmit()` → `Enter`, in that order — the button is looked for
**after** the prompt is filled, because Flow can leave it absent/disabled until then) → capture the
result from network responses (`image/*` content-type, ≥512×512, chosen by
`chooseBestCapturedImage()` against the target aspect) or, failing that, the Download button →
`FLOW_REGEN_ATTEMPTS` (default 1) scored attempts against `REAL_MATCH_THRESHOLD`/`AI_MATCH_THRESHOLD`
→ Ken Burns → `provider: "flow:nano-banana-pro"`.

### Video path (Veo) — NEW

`generateFlowVideo()` mirrors the image path's shape but is its own function, driven by
`resolveAiMedia(beat, mediaOverride)` **exactly like every other AI provider** — Flow is no longer
hardcoded image-only (that used to throw `"Google Flow browser is image-only, but this fallback
beat requires video."` for any video-routed beat; removed):

- `ensureFlowVideoMode` → mode switch + `ensureVeoModel`, which confirms the configured
  `FLOW_VIDEO_MODEL` is active. **Fuzzy-matched, not a fixed string** — `normalizeFlowModelLabel`
  lowercases and turns hyphens/underscores into spaces, and `veoModelLabelMatches` strips only
  cosmetic decoration (`(Beta)`, `New:`, bracket/punctuation noise) before requiring EXACT equality
  — so a stored id like `veo-3.1-fast` matches a rendered `"Veo 3.1 Fast"`, `"New: Veo 3.1 Fast"`, or
  `"Veo 3.1 Fast (Beta)"`, but never a DIFFERENT tier (`veo-3.1` must never match a menu entry for
  `"Veo 3.1 Fast"` just because it's a prefix). **Fails loud** on no confirmed match — same contract
  as `ensureNanoBanana`, never silently substitutes a cheaper/different tier.
- `ensureFlowAspectRatio` / `ensureFlowDuration` are **best-effort** (log + continue if the control
  isn't found) — `FLOW_VIDEO_DURATION_SEC` (default `8`) is what gets requested from Flow's own
  duration control WHEN ONE EXISTS; it is not a promise that the delivered clip is that long.
- Reference handling goes through the SAME `prepareComposerReference` seam as images — clear-then-
  attach can never drift between the two media kinds. If the configured Veo tier doesn't accept an
  ingredient, the attach is not silently skipped: `confirmReferenceAttached` requires a visible
  remove/chip control before calling it a success (see "Reference attach confirmation" below), and a
  failed confirmation throws rather than rendering a video that looks like it used the reference
  when it didn't.
- **Capture prefers the official Download control** (`tryDownloadVideoFromUi`, `FLOW_VIDEO_DOWNLOAD_SELECTOR`
  optional override) over network-response capture, because `download.saveAs()` is streamed
  straight to disk by Chrome — never buffered in this process — whereas a captured `response.body()`
  does buffer the whole clip in Node memory. Network capture is the fallback, filtered by
  `isVideoResponseCandidate` (`video/*` content-type or a `.mp4`/`.webm`/`.mov`/`.m4v` URL) and a
  minimum-byte floor so a poster frame or tracking pixel is never mistaken for the result; among
  several matches, `newestVideoCandidate` picks the one captured LAST (capture order is chronological
  by construction — a named, tested function rather than an inline `[length - 1]`).
- **Validation is real, via `validateFlowVideoFile()` (ffprobe, not a duplicate FFmpeg pipeline)**:
  file exists, non-empty, a cheap byte-sniff (`looksLikeNonVideoBody`) rejects an HTML/JSON error
  page arriving with a `200` and an `.mp4`-shaped URL BEFORE spending an ffprobe subprocess on it,
  then ffprobe confirms a real video stream with readable width/height/duration/codec/fps. Any
  rejection is a `FlowBrowserError("capture")` — never a silently-accepted thumbnail or truncated
  download.
- **No second FFmpeg implementation for duration matching or audio removal.** The downloaded clip is
  handed to the pipeline as-is (after validation) — exactly like `kie.ai`'s Veo path, which also just
  downloads the raw result. The shared beat compositor (`services/studio-assemble.ts` → `renderBeat`)
  already re-encodes EVERY beat visual (real footage, `kie:veo`, Flow's Veo alike) to the project's
  exact frame count — `-stream_loop -1` fills a clip shorter than the beat, `-frames:v <exact beat
  frame count>` hard-cuts one that's longer, deterministically, no slow-motion — and strips audio
  UNCONDITIONALLY (`-an` is always in `encodeV()`'s output flags). Writing a beat-aware trim/mute
  pass inside `generateFlowVideo` would be a second implementation of behavior the compositor already
  guarantees for every video source; don't add one.
- **No score/regenerate loop for video** (unlike the image path's `FLOW_REGEN_ATTEMPTS`): one
  generation, one result — mirrors `kie.ai`'s Veo branch, which doesn't re-score/regenerate video
  either, and avoids resubmitting the same prompt.
- Returns `{ kind: "ai", provider: "flow:veo3" }`; Ken Burns is never applied to a video result.

### Fallback — `FLOW_FALLBACK_PROVIDER` (`none` default | `kie`)

Preserves the beat's media KIND on failure, for both directions: a video-routed beat that exhausts
Flow's Veo path falls to `kie.ai`'s Veo (never its nano-banana image path), and an image-routed beat
falls to `kie.ai`'s nano-banana (never Veo). `none` fails closed — a `FlowBrowserError` propagates
rather than silently reaching Grok/Cloudflare/Pollinations/Meta/Magnific/Runware/kie.ai. This holds
even though the KIE branch below is itself generic: on a Flow-video fallback, `provider` is set to
`"kie"` and execution falls through into the SAME `resolveAiMedia()` call the kie branch already
makes for every other route — it independently resolves back to `"video"` from the same beat/override/
settings, so the handoff is not a special case, just letting the existing kie logic run.

### Reference attach confirmation

`beatWantsCharacterReference(beat)` decides whether the configured `AI_CHARACTER_REFERENCE_PATH`
portrait is attached — explicit terms (woman/housekeeper/maid/room attendant/hotel worker/she/her/
…) or embodied first person (`I saw/noticed/entered/checked/cleaned/wiped/examined…`, but
deliberately NOT generic `I think/I know`, so the portrait isn't forced into explanatory object
shots). `prepareComposerReference()` is the ONE seam both `generateFlowImage` and `generateFlowVideo`
call: clear whatever the PREVIOUS beat left attached, then attach only if this beat wants one — so
the two media paths can never drift on when the reference is added or removed.

`dispatchEvent()` firing without a thrown error is **not proof the drag-and-drop upload worked** — a
layout that silently ignores the synthetic `DragEvent` looks identical from the caller's side. So
every attach path (native `input[type=file]`, the synthetic drop, and the file-chooser trigger flow)
is followed by `confirmReferenceAttached()`, which requires a visible remove/chip control
(`referenceRemoveControls` — the same locators `clearFlowReferences` clicks) before calling the
attach a success. No visible evidence → `prepareComposerReference` throws, with a safe DOM-only
diagnostic (`diagnoseComposerControls`: nearby button names/aria-labels/titles/`data-testid`s, file
input count — never cookies, tokens, or account data).

### Settings

`FLOW_PROJECT_URL`, `FLOW_BROWSER_PROFILE_DIR`, `FLOW_BROWSER_EXECUTABLE`, `FLOW_CDP_PORT` (default
`9223`, loopback-only), `FLOW_FALLBACK_PROVIDER`, `FLOW_IMAGE_MODEL`, `FLOW_ASPECT_RATIO`,
`FLOW_REGEN_ATTEMPTS`, `FLOW_GENERATION_TIMEOUT_SEC` (default `240`s, image) — all pre-existing.
Added for Veo: `FLOW_VIDEO_MODEL` (default `veo-3.1-fast`; kebab-case id, fuzzy-matched against
Flow's own label text — see above), `FLOW_VIDEO_TIMEOUT_SEC` (default `600`s = 10 min — deliberately
separate from and much larger than the image timeout; Veo renders take minutes), `FLOW_VIDEO_DURATION_SEC`
(default `8`s — requested, not guaranteed, see above). Advanced/DB-API-only overrides (no form field,
same convention as the pre-existing `FLOW_*_SELECTOR` keys — a settings key with no field is normal,
not an oversight): `FLOW_VIDEO_DOWNLOAD_SELECTOR`, `FLOW_MEDIA_MODE_SELECTOR`,
`FLOW_ASPECT_RATIO_SELECTOR`, `FLOW_DURATION_SELECTOR`. The image/video MODEL selects render
automatically on Settings via `ProviderModelFields` (capability-driven off the `flow_browser` entry
in `providers.ts`'s `AI_PROVIDERS`, now carrying a `video` catalog alongside `image` — Veo 3 / Veo 3
Fast / Veo 3.1 / Veo 3.1 Fast (recommended) / Veo 3.1 Quality, plus the registry's normal "Custom…"
free-text escape for a label Google renames or adds later). The image/video split itself reuses the
existing run-level "AI media" selector (`KIE_AI_MEDIA`: Images only / Auto / Video only, shown on `/`
whenever Visual mode is AI or Mix) — Flow does not get a second, parallel media-mode setting.

### Not yet validated against a live Flow session

Everything in this section was built by extending the PROVEN image-generation selector cascade
(accessible role/name matching first, `FLOW_*_SELECTOR` overrides second) to video, and is covered by
unit tests for every pure/testable piece (model-name normalization and matching, newest-result
selection, content-type filtering, ffprobe-backed file validation, per-media timeout bounds, the
clear-then-attach sequencing via a fake Page/Locator). What is **not** verified end-to-end against the
real Flow UI (no CDP/Chrome session was available while building this): `ensureFlowMediaMode`'s
Image↔Video switch control, `ensureVeoModel`'s option-picking, `ensureFlowAspectRatio`/
`ensureFlowDuration`'s control discovery, and the network-response/official-download capture race in
`generateFlowVideo` itself. Drive it once over a real session (Settings → Open Flow / test session,
then a short real run) before relying on it unattended, and update this note with what was confirmed.

---

## Key external services

| Service | Used for | Setting |
|---|---|---|
| **ElevenLabs** | narration voiceover (+ word timings) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` |
| **Fish Audio** | OPTIONAL narration voiceover (audio only) | `FISHAUDIO_API_KEY`, `FISHAUDIO_VOICE_ID`, `FISHAUDIO_MODEL`, `COST_FISHAUDIO_USD_PER_1M_BYTES` |
| **Hume AI** | OPTIONAL narration voiceover (Octave, audio only) | `HUME_API_KEY`, `HUME_VOICE_ID`, `HUME_VERSION`, `COST_HUME_USD_PER_1K_CHARS` |
| **Groq (Whisper)** | word timings for an UPLOADED voiceover — **required** in upload mode (also single-shot TTS) | `GROQ_API_KEY`, `UPLOAD_MAX_MINUTES` |
| **HeyGen** | create avatar + render talking-head clips | `HEYGEN_API_KEY` |
| **Gemini** | per-beat visual search query | `GOOGLE_API_KEY` (optional) |
| **Pexels / Pixabay / Openverse / Wikimedia** | real footage + stills | `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `OPENVERSE_TOKEN`, `FOOTAGE_SOURCES` |
| **wigolo** | OPT-IN real footage — open-web PHOTOS only, served by a local daemon (free, no key) | `WIGOLO_URL`, `WIGOLO_BIN`, `WIGOLO_API_TOKEN`, `WIGOLO_EXCLUDE_DOMAINS`, `WIGOLO_MIN_PX` |
| **yt-dlp (YouTube)** | OPT-IN real footage (copyright risk) | `YT_DLP_ENABLED`, `YT_DLP_PATH` |
| **69labs (Grok)** | AI b-roll | `LABS69_API_KEY` |
| **Magnific AI** | AI b-roll (Mystic image + Ken Burns / Hailuo video) — extra backend + fallback | `MAGNIFIC_API_KEY`, `MAGNIFIC_ENABLED` |

HeyGen v1/v2 API (supported through 2026-10-31): `X-Api-Key` header; upload asset
(raw binary) → `image_key`/audio `id`; `/v2/video/generate` with `voice.type:"audio"`
+ `audio_asset_id`; poll `/v1/video_status.get`. Details in `docs/DESIGN.md`.

### Wigolo — the opt-in open-web PHOTO source

Exists because real footage is effectively single-source: over 216 runs Pexels supplied 75%
of all real clips, YouTube is off, Pixabay has no key — and **19% of beats the planner marked
"real" find nothing and fall through to paid AI generation**. Wigolo is free, runs locally,
and lands the descriptive shots Pexels misses ("dangerous wild animal growling in a living
room" returns house cats there).

**It is not a replacement for any stock source and cannot become one.** Wigolo has no video
surface at all — its `category` enum is `general|news|code|docs|papers|images`, and the word
"video" appears nowhere in its 170 KB OpenAPI spec — and the adapter only ever emits
`kind: "image"`.

- **ON by default since 2026-08-11** (owner's decision, reversing the opt-in shape it shipped
  with): `wigolo` is in the `FOOTAGE_SOURCES` default, and `_migration_wigolo_default_on`
  appends it once to existing DBs — DEFAULTS never revisit a key that is already seeded, so
  without that migration the flip would reach only fresh installs, which is nobody. The
  migration is marked done immediately, so an operator who unticks it afterwards stays
  unticked. `WIGOLO_URL` ships filled in so nobody has to type it.
- **Install is manual and deliberate.** `scripts/wigolo.mjs ensure` (wired to `predev` AND
  `prestart`, so a production `npm start` — how the deployed servers run — brings the daemon up
  too, not just the local launchers) starts a daemon it finds via `WIGOLO_BIN` → the package's
  own JS entry → PATH → `node_modules/.bin`. It **never installs**: `npx wigolo` would prompt
  in a terminal or, with `-y`, re-download on every app start. Nothing found = one log line
  and exit 0.
- **The daemon is started as `node <wigolo>/dist/index.js`, not through the npm shim.** wigolo
  is a dependency here and its `bin` is a plain .js file, so handing it to the node already
  running skips the shim layer on every platform at once. That is not a tidy-up — it is what
  makes Windows work, and it keeps the pid ours (a `.cmd` must be launched through a shell,
  and the resulting cmd.exe parent owns the pid and survives being killed). Resolve the
  package by PATH, never `require.resolve("wigolo/package.json")`: wigolo's `exports` map
  doesn't expose `./package.json`, so that throws and falls back to the broken shim silently.
- **Windows breaks three ways here, and all three are load-bearing** (a client could not start
  the app at all: `Error: spawn …\node_modules\.bin\wigolo ENOENT`):
  1. npm writes the bin as an extensionless script + `.cmd` + `.ps1`, and only the last two
     run. npm also puts `node_modules/.bin` on PATH for scripts, so `where wigolo` lists the
     **extensionless one first** — taking the first line picks the one file that cannot run.
     `pickFromPathLookup` skips it (scripts/wigolo-launch.mjs, unit-tested off-Windows).
  2. Since the CVE-2024-27980 fix (Node ≥ 18.20.2), spawning a `.cmd` **without**
     `shell: true` throws `EINVAL`. Hence `needsShell` — and hence preferring the .js entry,
     which needs no shell at all.
  3. `spawn` reports a launch failure as an **'error' EVENT, not a throw**, so the file's
     outer try/catch never saw it. An unhandled 'error' event exits non-zero, and this runs
     from `predev` — so a missing optional photo source took `npm run dev` down with it. Both
     the sync throw and the async event are caught now. **Rule 1 of the file is that every
     path ends in exit 0; that rule was being violated, not merely bent.**
- **`stop` won't kill what it can't identify.** Pids get recycled, so it requires the process
  to exist AND its command line to contain both `wigolo` and `serve` — the name alone matches
  any node process in a checkout living under a directory named `…-wigolo`. On Windows it
  kills via `taskkill /T` (the process TREE): the pid may be a cmd.exe wrapper, and killing
  only the wrapper would leave the real daemon running and unreachable.

Contract facts, all verified against a live daemon (2026-08-10) — the docs alone would have
misled on every one of them:

- `results[i].url` is the **page**, `results[i].image_url` is the **file** (proven by
  behaviour: the file serves `200 image/jpeg`, the page `403 text/html`). The same payload's
  `images[]` array inverts the meaning of `url`. Read `results[]` only; don't unify them.
  `sourceUrl` must stay the page — `hitLabel()` builds the candidate's label from that slug
  and the label feeds both scorers.
- `exclude_domains` matches the **page** domain and its subdomains, never the image CDN:
  `dreamstime.com` filters the results, `thumbs.dreamstime.com` filters nothing. Stock
  agencies serve watermarked comps, so this list is what keeps watermarks out of the video.
- Rejections arrive as **HTTP responses** (`400` `invalid_input`, `401` `unauthorized`) with
  `{ok:false,error}` — not as thrown fetch errors. Without a `resp.ok` check an auth failure
  reads as "the source found nothing".
- Auth is `Authorization: Bearer <token>`, required even on loopback once `WIGOLO_API_TOKEN`
  is set. `/health` stays open regardless, which is why the UI indicator works in any setup.
- **AI-labelled results are dropped by URL slug, checked on BOTH the file and the page.** A
  captured freepik hit has `premium-ai-image` in its page URL and `premium-photo` in its file
  URL. This is a REAL-footage provider: an AI picture arriving through it silently overrides
  the operator's real/AI split.

**EVERY key of `PROVIDERS` must carry an explicit weight in BOTH tables** (`PROVIDER_WEIGHT`
for final ranking, `PREFILTER_PROVIDER_WEIGHT` for the pre-Gemini cut), and the two tables
must stay identical. An unlisted provider does not rank last — it defaults to **0**, which
lands it THIRD, above wikimedia, openverse, web and archive, purely by omission. Enforced by
`visual-source.weights.test.ts`, which fails naming the missing provider; this was a comment
before, and storyblocks slipped past the comment anyway.

- `wigolo: -3` — same tier as `web`, the same kind of source (unlicensed open-web stills). At
  `-3` every existing provider keeps its order and `poolIsWeak`'s route-to-AI verdict is unchanged.
- `storyblocks: 3` — the only PAID source, video-only, professionally shot, always thumbnailed.
  Below pexels so a free video wins a straight tie; **above** pixabay because `storyblocksSearch`
  books the run's download budget at SEARCH time, so a demoted storyblocks hit has already spent
  a slot and bought nothing. Demoting it is the worst of both worlds, not the cautious choice.
  At `3` the Gemini bypass is unaffected (pexels 9 leads storyblocks 8 by 1, short of the ≥ 6
  margin), so this moved ranking only, never how many candidates skip the vision check.

Measure it, don't assume it: `npm run wigolo:queries` extracts a script's real per-beat
queries for one Gemini call, and `npm run wigolo:bakeoff` runs them through every provider
and counts how often the route-to-AI gate fires with and without wigolo. Candidate counts
prove nothing on their own — watch the video/photo ratio too, since trading Pexels video for
stills would improve the headline number while making the video worse.

---

### Candidate selection — how a beat picks ONE clip (visual-source.ts)

Reworked 2026-08-17 after a code audit found six defects in this path. The whole subsystem is
governed by one cost constraint: **`SOURCE_POOL_MAX` (14) and `MAX_GEMINI_CANDIDATES` (10)
must not be raised.** Every extra candidate is another inline image in the per-beat
multimodal call — direct client money and a step toward the request limit. The job is a
smarter choice of the same ten, never more than ten.

The path, in order, per broaden attempt:

1. **Gather** — every enabled provider in parallel, each capped at `SOURCE_POOL_PER_PROVIDER` (5).
2. **`mergePools`** — floor → quota → drain, strongest source first. Was a plain round-robin
   by rank index, which gave every provider the SAME number of places: with eight sources
   that is ranks 0–1 of the first six, so **ranks 2–4 of every provider were unreachable**,
   pexels included. Each extra source a client ticked took places from the ones that deliver.
   Quota is `1 + ceil(weight/2)`, derived from the ranking weight table so there is no second
   set of constants. **The DRAIN pass is load-bearing**: it guarantees the same candidate
   COUNT as the old rule for every input (pinned by a property test) — reallocating places
   must never cost places, or a smaller pool would flatter every metric while handing the
   scorer less.
3. **`weakPoolVerdict`** — the surrender gate. A first weak pool now only earns a broadening;
   giving up also requires that no earlier attempt was strong (`weakSoFar`). It used to fire
   on `attempt === 0`, so "stock does not have this" was decided on the planner's FIRST and
   most abstract query while attempts 1–2 could never run. The delayed pool goes to the
   reserve (below), so the cost is one provider fan-out and **zero Gemini**.
4. **`shouldBypassGemini`** — a dominant pexels video (≥ 6 heuristic margin) skips scoring.
5. **`prefilterCandidates`** — the 14 → 10 cut, now `heuristicScore + LEX_WEIGHT *
   lexicalMatchScore`. Provenance alone used to decide it, so an archive still that was
   exactly about the beat lost to an off-topic pexels clip by −4 vs +4 before anything looked
   at either. **`LEX_WEIGHT = 0.1` is the entire design decision** — the lexical range is
   ≈[−30,+120] against a provenance range of [−4,+9], so undamped it hands the cut to
   whichever FILENAME echoes the query (open-web sources win that by SEO, not by being right)
   and trades video for stills. At 0.1 a full match rescues a weak-provider candidate while a
   merely partial one never overturns a strong video. Pinned numerically.
6. **Gemini vision scoring** → kind-specific bars (video 75 / image 80).
7. **Reserve tier** — the candidates the cut dropped, drained ONCE after the attempt loop and
   before the YouTube rung. They were previously discarded, so a beat could pay for AI while a
   matching real clip it had already fetched sat in memory. Judged on the **existing** lexical
   bars (65/80) — no Gemini call, no extra image. **Not a relaxation**: the reserve is by
   construction what the cut judged weakest, so admitting anything that merely exists would
   trade a generated image for a bad real one. Drained late on purpose — a later broadened
   attempt can still yield a Gemini-SCORED passer, which beats a lexically-admitted one.

**`entityProtected(beat, query)` decides which beats the surrender gates may touch** — both
`weakPoolVerdict` and `getAiPreferenceReason` (which skips stock ENTIRELY). It reads the
planner's `queryType` / `footageKind` / `productLabel`, written from the narration. It was
`hasLikelyEntity` alone — a capital letter or "&" — which protected "Cummins P7100" and
abandoned "steel mill workers 1940s". **A present planner field is authoritative in BOTH
directions**; OR-ing the text test back in "for safety" would preserve the exact defect, since
capitals protect regardless of what the planner said. `archival` is protected because AI
cannot produce archival footage, only an imitation. The text test survives only as the
fallback for beats with no planner fields.

**`lexicalMatchScore` is the lexical half of `fallbackSemanticScore`, split out** so the
prefilter can weigh relevance without double-counting the provider weight it already applies.
`fallbackSemanticScore`'s own value is byte-identical after the split (golden-value test).

Measuring it: `scripts/pool-metrics.ts` replays CAPTURED pools through the real internals
(`--capture` once live, then `--pools` / `--baseline`), because providers are live services and
re-fetching drowns a code change in their noise. Two limits are in its header and matter: the
stand-in scorer is lexical, and only attempt 0 is modelled — **read the deltas, never the
absolute levels**. Watch `video picks N of M`, not just the video SHARE: rescuing a beat from
AI with a still lowers the share while costing no video at all, and reads exactly like the
video-traded-for-stills regression the share exists to catch.

**`broadenQuery` caps the protected entity at 3 tokens (`MAX_ENTITY_TOKENS`), and the cap is
load-bearing.** The entity is the leading run of non-`GENERIC_DESCRIPTOR` tokens, so a query
with no descriptor anywhere — most plain descriptive queries — used to have its WHOLE text
read as one entity: nothing left to drop, every level returned the original string, the
retries were skipped as duplicates, and the three-attempt ladder silently collapsed to one for
exactly the queries that most need broadening. Measured on 217 runs: **182 of 585 broaden
attempts were discarded as identical.** Three words is what a real entity looks like ("Arm &
Hammer", "Cummins P7100"); a six-word entity is an unbroadened sentence wearing the label.
Queries that already lead with a descriptor are byte-identical, and level 3 is unchanged —
both pinned in `visual-broaden.test.ts`.

This is also what makes `weakPoolVerdict`'s "broaden and look again" worth anything: answering
a weak pool with a retry is empty if the retry re-issues the same string.

---

### Adding a voice provider (Fish Audio / Hume are the worked examples)

A TTS provider is a **7-file change and nothing else** — no pipeline, planner, avatar,
assembly or Resume code is touched, because `Voiceover` (see above) is the only seam:
register it in `VOICE_PROVIDERS` (providers.ts) → keys in `SETTING_KEYS`/`DEFAULTS` →
one function + one `dispatchTts` branch (tts.ts) → `price*`/`record*` (pricing.ts,
cost-ledger.ts) → `COST_PROVIDERS` (billing.ts) → fields in `full-settings/_groups.ts`.
Everything below `synthesizeViaProvider` is provider-blind: audio-only providers get
word timings from the shared Groq Whisper pass, so **only ElevenLabs has native timestamps
and only ElevenLabs is branched on**. A second branch further down is the thing this
design exists to prevent.

- **A provider that can list its voices sets `voicesEndpoint`, and its value IS the
  `/api/voices/<x>` route segment** — no slug→URL mapping to drift. `ProviderVoiceFields`
  then renders the "Load voices" picker automatically. Pinned by a test that reads the
  route directory, so a registry entry can't point at a route that doesn't exist.
- **Billing units are per-provider and are NOT interchangeable.** Fish Audio bills per
  million **UTF-8 BYTES** — `Buffer.byteLength(text,"utf8")`, never `text.length`, or a
  Cyrillic/CJK script under-reports by ~2x. Hume bills per 1,000 **characters**.
- **A blank `COST_*` rate prices at 0** (`Number("") === 0`, so `num`'s fallback only
  catches non-numeric values). `seedDefaults` writes a key only when it is MISSING, so a
  rate seeded under an old default is frozen there forever — measured: an install still on
  `COST_GEMINI_IN=0.30` long after DEFAULTS moved to `1.50`. Raising a default is therefore
  NOT enough; add the old value to `SUPERSEDED_RATE_DEFAULTS` (settings.ts) so the migration
  bumps installs still sitting on it, while leaving operator-set values alone.
- **Hume voices are stored as a bare UUID with no provider.** A voice referenced by `id`
  resolves against both the shared Voice Library (`HUME_AI`) and the account's own
  (`CUSTOM_VOICE`); only the LISTING call needs `provider`, so `/api/voices/hume` queries
  both and merges them into one labelled list. Storing a provider alongside the id would
  be a second, confusable source of truth for the same voice.
- **Octave compatibility is surfaced, never enforced.** Octave-1 voices run on both
  generations; Octave-2 voices need `version: 2`. `HUME_VERSION` defaults to EMPTY (Hume's
  own default) so nothing is silently pinned, the picker flags a mismatch, and the runtime
  turns the API's rejection into "set HUME_VERSION to 2". The compat check matches on the
  version DIGIT because Hume's exact spelling of `compatible_octave_models` is unverified —
  guessing that enum must never hide a usable voice.
- **Fish Audio's backend model is an HTTP HEADER (`model`), not a body field.** In the body
  it is silently ignored and the account quietly stays on the default model.

### AI84 (api.ai84.pro) — TWO engines behind one key. Verified live 2026-08-12

AI84 is a reseller fronting **both ElevenLabs and MiniMax**, and they are genuinely
different services: different create endpoints, different body shapes, **separate voice
libraries**. It is ElevenLabs-shaped but NOT an ElevenLabs mirror, and assuming the mirror
is wrong in both directions.

**The MODEL picks the engine** — `eleven_*` → ElevenLabs, `speech-*` → MiniMax
(`ai84Backend` + `AI84_MODELS` in providers.ts). There is deliberately **no
`AI84_BACKEND` setting**: a second source of truth for one fact, whose out-of-sync state
("MiniMax engine, `eleven_*` model") produces exactly the failure below. An empty or
legacy value resolves to ElevenLabs, so pre-existing installs are unchanged and no
migration exists.

**…and the VOICE picks the model.** `AI84_MODEL` is a global setting read at synthesis
time, so on its own it can serve only one engine at a time — a client running some channels
on ElevenLabs and some on MiniMax could use whichever they had selected and nothing else.
`resolveAi84Backend` (services/ai84-voice-engine.ts) asks AI84 which catalogue holds the
voice, `/api/studio` snapshots the matching model onto `runs.voice_model`, and the setting
is left deciding the TIER (2.8 HD vs 2.6 turbo) and nothing else.

- **It applies to the voice the run will REALLY use** — create page → channel →
  `AI84_VOICE_ID` — not just one picked on the create page. Restricting it to the page was
  the original bug: a voice is no less chosen for being chosen on the channel.
- **Unknown is `null`, never a guess.** Not in either catalogue, in both, or the lookup
  threw → the global model stays in charge, i.e. the old behaviour. A wrong guess is a
  failed run that has already been billed, and `English_Explanatory_Man` is not reliably
  distinguishable from an ElevenLabs id by shape. The one exception is the anchored clone
  pattern, which is a local certainty and costs no request.
- **The 10-minute catalogue cache is INTERNAL to the resolver** and must not back
  `/api/voices/ai84`: a list read with human eyes has to show a voice cloned a minute ago.
  It caches the promise, not the result (two runs starting together is the whole scenario),
  and drops failures so the next run retries rather than inheriting ten minutes of "unknown".
- **No auto-retry on the other engine after a rejection.** ElevenLabs-engine credits are
  charged at create, so a retry is a second bill — and it could only fire where we would be
  guessing anyway.

**Cloned voices (`user_<n>_voice_<ts>`) exist ONLY on MiniMax.** Sent to the ElevenLabs
engine they return `internal.VOICE_NOT_FOUND_LOCAL` — "not found in the LOCAL store" means
*this engine's* store. This cost a real client two failed runs and cost us a wrong
diagnosis: we told them the voice didn't exist on their account, when in fact the app was
asking the wrong engine. `ai84VoiceModelMismatch` (services/voice-errors.ts) now names
that cause; it is **advisory, never a gate**.

| | ElevenLabs engine | MiniMax engine |
|---|---|---|
| create | `POST /v2/text-to-speech/async` → **201** | `POST /v1/minimax/text-to-speech/async` → **200** |
| voice field | `voice_id` | **`canonical_voice_id`** (else `400`) |
| tuning | nested `voice_settings` | **flat** `speed` (+`pitch`/`volume`, ranges unverified — not sent) |
| create reply | `{job_id, task_id, …}` | `{job_id, …}` — **no `task_id`** |
| bad voice | create succeeds, **credits charged**, job then fails | **`404 VOICE_NOT_FOUND`, nothing charged** |
| price | 4 credits / 4 chars | 5 credits / 4 chars |
| models | `GET /v1/models` → 6 | `GET /v1/minimax/models` → 10 |
| library | `GET /v1/shared-voices?page_size=100` → 28, `last_sort_id: null` so **one request IS the list** | `GET /v1/minimax/voices?page=&page_size=200` → 695, real pagination |
| cloned | none — no endpoint exists | **`GET /v1/minimax/voices/cloned`** |

- **Polling and download are ONE code path.** `GET /v2/text-to-speech/async/{jobId}` serves
  **both** kinds of job in the same camelCase shape (`audioUrl`, `credit_cost`,
  `errorMessageKey`). `/v1/minimax/text-to-speech/async/{id}` also exists but is snake_case
  — don't use it, it would be a second parser for nothing. So only `create` is branched
  (two builders in `services/ai84-request.ts`, never one builder with flags — the HeyGen
  v2/v3 lesson). `POST /v2/minimax/...` does not exist.
- Billing is charged **at create**, so `recordAi84` fires there (plus a positive delta on
  `done`), never after the download — a job that fails still cost money. `/costs` shows
  €0.00 until `COST_AI84_USD_PER_CREDIT` is set; it appears in the "rate not set" banner,
  and setting the rate re-prices the recorded history.
- **Every AI84 request goes through `requestWithPolicy`** (services/http.ts), and the poll
  loop treats a surviving transport throw as "still running", not as run death. A naked
  fetch there destroyed a real run 78s after its ~950 credits were already spent. Same for
  `genaiproTts`, which AI84 was copied from.
- `isVoiceRejection` (elevenlabs-voices.ts) **is shared and does match**
  `VOICE_NOT_FOUND_LOCAL`; `classifyVoiceError` is **not** shared — pointed at AI84 it would
  send an AI84 key to api.elevenlabs.io and name `ELEVENLABS_VOICE_ID`. Non-ElevenLabs
  providers use `services/voice-errors.ts` instead.

### ai33.pro / OpenSpeaker — SIX engines, and the engine lives in the voice id

Added 2026-08-18. A reseller fronting `clone`, `elevenlabs`, `minimax`, `fishaudio`, `edge`
and `vbee` behind one key and one credit balance. What it really adds to the product is
**Edge and Vbee** (no other provider here reaches them) and cheaper credits — not new
quality. ElevenLabs, MiniMax and Fish Audio are already reachable directly.

**A voice id is `"<engine>:<id>"`, and that one fact removes a whole subsystem.** Because the
engine travels inside the voice, ai33 needs **no `AI33_MODEL`, no `AI33_BACKEND`, and none of
AI84's engine-resolution machinery** — no `resolveAi84Backend` equivalent, no catalogue cache,
no per-run `voice_model` snapshot. The disagreeing state those exist to prevent ("MiniMax
engine, an `eleven_*` model") is **unrepresentable** here. Adding a setting "for symmetry with
AI84" would recreate exactly the defect AI84's comment warns about; a test in
`providers.test.ts` asserts `DEFAULTS` has no such key.

**THE CONTRACT IS NOT LIVE-VERIFIED — the only provider here of which that is true.** ai33
issues API keys to donors only and puts its real API document behind Cloudflare + a login, so
no probe was possible. Four field spellings are genuinely unknown: the task id in the create
reply, the completion status word, the audio-URL field and the credits field.

- **The alternative to tolerance was not precision, it was a guess.** `services/ai33-response.ts`
  reads each field through its plausible spellings across the payload and its usual nesting
  containers. Pinning one spelling would have been exactly as unverified and would fail the
  tester's first run with "returned no task id", telling nobody anything.
- **`describeUnparsed` is the load-bearing half.** An unreadable payload is quoted VERBATIM
  into the error (capped at 600 chars), so the first real run either works or hands back the
  actual field names. That is what a probe would have bought; without it the run is wasted.
  When that happens, add the observed spelling and delete this paragraph's hedging.
- **A present audio URL outranks an unrecognised status**, so an unknown word like `"succeed"`
  still finishes the job instead of polling to the deadline on audio already paid for. A
  recognised FAILURE still outranks a URL. Everything unrecognised is `pending`.
- **The download checks `content-type`.** The last URL alias accepted is a bare `url`, which on
  an unknown payload could be a self-link — and an HTML page written to disk as "audio" would
  not fail loudly, it would become a silently wrong duration, which every beat timing derives
  from.

**The money is NOT hedged.** Credits are recorded the moment a figure appears — at create OR
on completion, since which one ai33 bills at is one of the unknowns — and only ever as a
POSITIVE delta, so a lower late figure never invents a refund. If ai33 reports **no** credit
figure at all, the run logs one `warn` naming the task id: an unrecorded spend must not render
as €0.00, which is the confident-zero failure the /costs work exists to prevent.

- `COST_AI33_USD_PER_CREDIT` defaults to **blank** on purpose. ai33 sells packs (~$5 per 1M
  premium credits) but publishes no per-engine rate and its engines are not priced alike.
- `AI33_BASE_URL` defaults to blank = `https://api.openspeaker.ai`. It exists because ai33.pro
  and openspeaker.ai are the same product under two names and which host an account is issued
  against could not be verified — the tester can move it without a release.
- Auth is `xi-api-key`, i.e. **ElevenLabs-SHAPED, not ElevenLabs.** Same trap as AI84:
  `classifyVoiceError` must never be pointed here (it would send an ai33 key to
  api.elevenlabs.io and name `ELEVENLABS_VOICE_ID`). Use `services/voice-errors.ts`.
- **`ai33LooksLikeVoiceRejection` is deliberately narrow.** The shared `isVoiceRejection` needs
  a 400/404 or the literal `voice_not_found`, and a failed TASK body carries neither. It
  requires "voice" AND a not-found phrasing in the same message, because the wrapper it gates
  says "change your voice id" — firing that on "insufficient credits" would send an operator
  to change a voice that works.
- `ai33VoiceIdUnqualified` names the one ai33-specific cause: a **bare** id names no engine,
  and there are six. **Advisory, never a gate**, same rule as the Hume Octave check.

Verified 2026-08-18: `tsc` 0 · `vitest` 1246 pass · `next build` exit 0. The settings page was
driven over CDP against the real dev server — ai33 appears in the narration dropdown, its API
key field accepts a value, and "Load voices" calls `/api/voices/ai33` and offers what it
returns (the route was stubbed via `Fetch.fulfillRequest`; no key exists and the DB was not
written to). **What is NOT verified is any live ai33 request** — no key was available.

## Conventions & gotchas (inherited base — still true)

- DB lives **outside** the project tree so `git pull` never touches user data.
  Schema changes use `tryAddColumn()` in `db.ts` (no `ADD COLUMN IF NOT EXISTS`).
- Settings form is schema-driven — add the key to `SETTING_KEYS` + `DEFAULTS` in
  `settings.ts`, and (only if it needs a form field) a field in
  **`app/full-settings/_groups.ts`** — NOT `app/settings/`, which is a hand-written
  page built from `_components/`. `MAIN_TITLES` there picks which groups appear on
  the main `/settings` page; the rest show on `/full-settings`.
  A key does **not** have to appear in the form: only 7 of the 35 `COST_*` rates do,
  and the `COST_HEYGEN_*` ones are deliberately DB/API-only. A settings key with no
  field is a normal, working key — not an oversight to "fix".
- Settings **seed the DB from `DEFAULTS` on first run, and the DB then wins over the
  environment**. So exporting an env var does nothing for any key that has a
  `DEFAULTS` value — change it in the DB (or via the settings API), not the env.
- Secrets are masked with `…` to the UI; the save handler skips values still
  containing `…` so it never overwrites a real key with the mask.
- Project path can contain spaces — always `path.join`; ffmpeg concat lists
  single-quote-escape paths.
- UI uses the `globals.css` design tokens / `.btn` / `.card` / `.input` classes.
- **`avatars.imported` = '1' means we only REFERENCE an avatar the operator made on
  HeyGen.** Deleting such a row must never DELETE it from their HeyGen account
  (`ownsHeygenAsset()` is the guard). Only avatars we created there are ours to remove.
- **"ready" in our DB ≠ still exists on HeyGen.** An avatar can be deleted on HeyGen's
  side while its row stays `ready` here; every avatar beat then 404s
  ("avatar look not found"). `/api/studio` pre-flights the asset with
  `verifyHeygenAvatar` BEFORE the voiceover is paid for — it fails **open**
  (only a definitive `checked && !engine` refuses), so a network blip never blocks a
  run. If beats still fail mid-run they degrade to b-roll, and the run records
  `runs.degraded` ('avatar_all' | 'avatar_partial') so it can't pass for a clean
  success. Keep that honest: a run that quietly ships a faceless video as "done" is
  the bug this exists to prevent.

## Verify a change

1. `npx tsc --noEmit` — 0 errors.
2. `npx vitest run` — all pass. Tests import with **relative** paths (`./avatars`),
   not the `@/` alias: that alias is a Next tsconfig path and vitest does not resolve
   it, so `@/lib/...` in a test fails to import even though `tsc` is happy.
3. `npx next build` — compiles + prerenders all pages. (It rewrites `next-env.d.ts`;
   that edit is a build artifact, not yours — revert it.)
4. `npm run dev`, exercise the changed page. A real end-to-end render needs
   HeyGen + ElevenLabs keys (you provide them).

**A curl of the page proves almost nothing about the UI.** Client-side effects don't
run, so a render loop, a request storm or a dead handler all look fine. To check
behaviour, drive the real page over the Chrome DevTools Protocol
(`--headless=new --remote-debugging-port=9222`), and stub server data by intercepting
the API with `Fetch.enable`/`fulfillRequest` rather than writing fixtures into the
user's DB. When asserting on `innerText`, pick a string unique to the block you're
testing — `innerText` includes `<option>` labels, so probing for text that also
appears in a `<select>` matches in every state.

## Cost Monitoring — how /costs stays truthful

Audited end-to-end 2026-08-12 against a copy of a real 217-run DB. The page needed no
redesign; it needed to stop reporting numbers it could not stand behind.

### Read-time pricing is the core invariant

`run_costs` stores the priceable FACTS; `/api/costs` computes the euro on every read via
`priceRow()`. **`amount_eur` is provenance only — never read it as the answer.**

Write-time pricing was the root defect: a rate the operator fixed today did not touch
yesterday's rows, so 382 recorded 69labs videos sat at €0.00 permanently. Now correcting a
rate (or the FX rate) restates all history on the next page load. Say so when you change
a rate — past totals legitimately move.

- **`rate_kind` is required on every new row.** `provider` cannot price a row on its own:
  HeyGen's engine spans $1–$4/min and lived in no column, and a 69labs image is
  indistinguishable from its video. Adding a provider means adding a `RATE_KINDS` entry —
  the set is closed and pinned by a test.
- **Every aggregate GROUPs by `rate_kind`, `estimated`, `(units_out IS NULL)` and
  `(amount_usd IS NULL)`.** Summing-then-pricing is only valid because rates are linear in
  units; a group that mixes those flags would price part of itself with another's rate.
- **Never reprice real money.** `estimated = 0` marks a provider-reported amount (only
  Runware today). Repricing those by units would have erased €7.00 of genuinely billed
  spend to €0.00 against the 0-default fallback rate — caught in verification.
- **Fall back rather than fabricate.** A row that cannot be repriced (no `rate_kind`, or a
  Gemini row predating `units_out`) shows its as-recorded euro with `repriced: false`.
  Splitting a Gemini token TOTAL by guesswork to reprice it would be inventing history.
- **`rateKnown: false` is not €0.00 of spend.** An unset rate means "nobody priced this",
  and the page says so. A confident zero over 382 generated videos is the exact failure
  this whole layer exists to prevent.

### A fail-open 100 means "not checked", and the run now says so

`scoreLocalImage` fails **open**: no `GOOGLE_API_KEY`, an empty / >6 MB / unreadable file, or
any API error returns **100**. That routing is deliberate — a broken judge must not stall a
run — and it is unchanged. The defect was that 100 clears every bar, reads in the log exactly
like a genuine perfect score, and emitted **nothing at all**: the AI-image gate only logs
scores BELOW its threshold (`scored N% (<75) — regenerating`), so a fail-open was completely
invisible. With `AI_REGEN_ATTEMPTS` defaulting to **5**, a broken judge meant every generated
image was accepted on the first try with no regeneration, and the operator shipped a video
whose frames nobody had checked. A client asked exactly that question.

`noteVisionUnjudged` (services/vision-qc.ts) logs **one** `warn` per run naming the cause and
the consequence. Modelled on `gemini-quota.ts` — same shape of problem, same once-per-run
`Set<runId>` and test seam. It **reports and routes nothing**; that the score is still 100 is
pinned by test alongside the notice.

- **Once per run, not per frame.** A run scores hundreds of frames; a line each would bury the
  fact rather than surface it (a real run logged ~170 quota failures that way).
- **Don't "fix" this by returning `{score, judged}`.** The return is already overloaded with
  sentinels read by caller arithmetic — **`-1`** = prominent burned-in text veto, **`-2`** =
  third-party talking-head veto, consumed as `perFrame.some(s => s < 0)` /
  `.filter(s => s >= 0)` — so a type change means editing seven call sites for a fact one log
  line already carries.
- Still open: a `runs.degraded` code for "shipped unverified" (that is a type + UI change), and
  an end-of-run count of unjudged frames (needs `studio-pipeline` integration).

### A failing Gemini model is remembered ACROSS calls

`callGemini`'s `dead` set is per-call, which is right for "don't try this model twice in
this request" — but nothing survived the call, so a model broken for a whole install was
re-tried first on every one. A run makes dozens of Gemini calls (planner chunks + per-beat
vision scoring), and an operator reported the symptom: the configured model "constantly"
failing, the system "always" falling back.

`preferredOrder` + `noteGeminiModelFailure`/`noteGeminiModelSuccess` keep short-lived
health per model and reorder the ladder. Measured against the live API — 10 calls to a
model that always 404s: **10 wasted round-trips before, 1 after.**

- **DEMOTE, never remove.** If every model is failing (Gemini down, key revoked) a filtered
  ladder would be empty and the call would fail having tried nothing. Pinned by a test.
- **A single 429 must not demote.** A per-minute rate limit clears on its own; only
  `DEMOTE_AFTER_TRANSIENT` consecutive failures do, and briefly. Permanent errors
  (403/404/400) demote for much longer — they will not fix themselves.
- **Success clears the record outright**, so a recovered model leads again. Routing around
  a working model is the mirror-image bug.
- **The demotion is announced once** (`console.warn`), never silent: the run must keep
  working AND the operator must still learn their key has a problem.
- **A `validate()` throw does NOT count.** It is a content blip, not model health — the
  same reason it never adds to `dead`.

### What the models actually tolerate (measured 2026-08-13, one key)

Rate limits are per-model, and the two call patterns in a run are nothing alike: the planner
makes a few calls seconds apart, the vision scorer fires many back-to-back.

| model | 20 back-to-back | 4 calls, 3 s apart | notes |
|---|---|---|---|
| `gemini-3.5-flash` | **0/20** | 4/4, then 2/4 | on the edge even at planner cadence |
| `gemini-3.1-flash-lite` | 11/20 | 4/4 | the shipped vision model |
| `gemini-3.5-flash-lite` | — | 4/4, ~1.3 s | fastest; **rejects `thinkingBudget: 0`** |
| `gemini-3.6-flash` | — | 4/4, ~5.9 s | 96 thinking tokens/call; **rejects `thinkingBudget: 0`** |
| `gemini-3-flash-preview` | — | 4/4 | works with budget 0 |
| `gemini-3.1-pro-preview` | — | **0/4** | 429s at any cadence |

Two consequences:

- **`thinkingBudget: 0` is hardcoded at every call site** (`studio-plan.ts`, `scene-split.ts`,
  `visual-source.ts`, `avatar-plan.ts`). The newest models **400** on it — verified by
  isolating the field: the same request succeeds with the key absent or a positive budget.
  A 400 is classified `permanent`, so selecting one of those models in Settings makes every
  call fail. They are unusable until the budget is made per-model.
- **A blank `VISION_MATCH_MODEL` silently moves the BURST onto the planner's model** — and
  a whole generation of installs was blank without anyone choosing it. All four read sites
  are `VISION_MATCH_MODEL || SCENE_SPLIT_MODEL` (`visual-source.ts`), v0.3.0 seeded the key
  as `""`, and the real default landed a month later — but `seedDefaults` never revisits a
  key it already wrote, and the key has **no form field**, so the operator can neither see
  nor fix it. Measured on a real 5-minute run: **5 planner calls vs 275 vision calls**. Point
  those 275 at `gemini-3.5-flash` and they measure **0/20** back-to-back — which is precisely
  the field report "3.5 falls constantly and it always drops to the 3.1 fallback".
  `migrateBlankVisionModel` (settings.ts) rewrites the exact superseded `""` once, on the
  same contract as `migrateSupersededCostRates`: an operator-chosen model is untouched, and
  it runs once so blanking it deliberately afterwards still sticks. **The cross-call health
  memory above does not substitute for this** — it stops re-probing a dead model, but a
  rate-limited model isn't dead, so without the migration those 275 calls still hammer the
  planner's model and still fall back.

### Gemini is priced by the MODEL, not by the call site

`geminiRateKind(model)` — `-lite` → lite rates, else standard. `category` now only picks
the UI bucket. The old rule assumed `SCENE_SPLIT_MODEL` is always standard and
`VISION_MATCH_MODEL` always lite; on a real install the planner ran a lite model and was
billed ~6x, while 1,428 `gemini-2.5-flash` rows were billed at the lite rate.

### Other load-bearing points

- **ONE ElevenLabs plan.** `BILLING_PROFILES.elevenlabs.plan` is the single source;
  `COST_ELEVENLABS_TIER` is a legacy fallback only. They disagreed in the field (profile
  "Starter", tier "Creator"), so one page reported one plan's fee against another's rate.
  The Flash/Turbo 0.5 halving in `elevenlabsRatePer1k` is NOT a double-discount with
  `elevenlabsCharsToCredits` — one is $/1k chars, the other chars→credits; parallel views,
  never composed.
- **`COST_PROVIDERS[].apiKeySetting` is typed `SettingKey`, deliberately.** A wrong name
  resolves to `""` and silently marks the provider inactive — it just never appears, with
  nothing to say why. (Storyblocks' key is `STORYBLOCKS_API_KEYS`, plural.)
- **A provider missing from `COST_PROVIDERS` is invisible in every dimension** — no chip,
  no rate field, nowhere to attribute spend. Storyblocks is paid and was absent entirely.
- **TTS is metered in `dispatchTts`, not per provider.** It is the one seam all nine
  branches pass through; only three were metered, so a run narrated by the DEFAULT provider
  (HeyGen) reported no voiceover cost at all.
- **The €/min denominator is its own SQL query.** It was built from the same `LIMIT 200`
  list the table used while the € came from the unbounded ledger, had no upper period bound,
  and counted cancelled runs. Never derive it by looping the run list again.
- **`Total = Σ visible rows + orphaned`.** Hard-deleted runs leave their cost rows behind
  (correctly — the money was spent), so the all-time card summed rows the table cannot show.
  `orphanedPaygEur` is published so the two visibly reconcile instead of quietly differing.
- **"Not tracked" must never render as €0.00.** 112 of 219 runs have no ledger rows; their
  cost is unknown, and a euro figure there is the most misleading cell on the page. Same for
  `subscriptionAllocEur`: `null`, not 0, when there is nothing to allocate.
- **`duration_sec` backfill uses `probeAudioStrict`, never `probeDurationSafe`** — the safe
  probe invents a duration from file size, which is exactly the fabrication this column is
  being repaired to remove. Unrecoverable rows are marked `-1`, NOT 0: the selection means
  "not yet attempted", and 0 does not exclude a row from `duration_sec <= 0`, so dead files
  were re-probed forever and blocked the batch behind them (measured: 12 polls recovered 18
  of 101 instead of draining it).

### Deliberately NOT fixed (scoped out by the owner)

- **Quantity accuracy.** kie Veo records requested seconds but bills in 4/6/8s buckets;
  provider-internal retries create 2–4 billable jobs but write one row; a generation whose
  download fails is billed and never recorded. HeyGen's v3→v1 TTS fallback bills twice and
  records once. All understatements, all still present.
- **Legacy pipelines.** `pipeline.ts` and `avatar-pipeline.ts` import nothing from the
  ledger; their runs are near-zero on /costs by construction.
- **Avatar creation spend.** HeyGen group create/train and the kie reference image are
  billable but run under an avatar id, not a run id — they need an account-level scope.

## Known follow-ups

- **Staged uploads are never swept.** `<DATA_DIR>/uploads/<uuid>.<ext>` is deleted on
  rejection and on a failed transfer, but a *successful* upload stays on disk forever —
  including one the operator staged and then never started a run with. Nothing breaks
  (ids are UUIDs, `resolveStagedUpload` only ever finds the right one), it just grows.
  A sweep of files older than N days is the fix; deleting on consumption is NOT, because
  a run must stay re-runnable from its staged source.
- ~~**Two Groq call sites are unmetered.**~~ FIXED 2026-08-12 — `transcribe.ts` and
  `tts-align.ts` now both call `recordGroqTranscription` with the duration Whisper itself
  reports. See the Cost Monitoring section above.
- **Avatar V pricing is measured, not published.** `COST_HEYGEN_AVATAR_V_USD_PER_MIN`
  ($4.00) remains an estimate: HeyGen prices Avatar V only for Digital Twin, and this
  combination is unpriced. Measured 2026-07-17 — 14.977s of avatar beats over 3 renders
  consumed 20 plan credits (80.1 credits/min), consistent with $4.00/min **if** a credit
  is $0.05, which HeyGen's API does not expose. Consumption also rounds up per render
  (a 1s clip cost 2 credits vs the 1.3 a linear rate predicts), so very short avatar
  beats cost more than the per-second model says. Settle it from an invoice, not by
  guessing.
- `AvatarHandle.motionPrompt` is **dead**: collected, stored and snapshotted, but
  never put on any HeyGen request. `/v3/videos` accepts `motion_prompt` (verified) —
  wire it on the Avatar V path, or drop the field. It does nothing today.
- **Avatar V at 4K is untested.** `v3Size()` will emit `resolution: "4k"` for a ≥2160
  channel. The enum accepts it, but no 4K Avatar V render has ever been attempted —
  validation stopped at the audio check. If it fails it fails loudly (the beat degrades
  to b-roll and the run is marked `degraded`), but don't claim it works.
- `useT()` returns a **NEW function on every render**. It is therefore unsafe as a
  `useCallback`/`useEffect` dependency — doing so gives the callback a new identity
  every render, which re-fires the effect, which sets state, which re-renders. That
  loop already shipped once and hammered the HeyGen API from a single page view. Keep
  `tr()` out of those deps (translate at render), or memoize `useT`.
- Channels (`channels` table) carry a default avatar (`channels.avatar_id`); the
  Chaînes UI doesn't yet expose picking it (set via API). A stale/deleted channel
  default degrades to a faceless run (it won't block the channel).
- YouTube/yt-dlp source is wired but OFF by default (legal); needs the `yt-dlp`
  binary installed.
- Avatar beats each call HeyGen separately — could be batched to cut render time.
- Veo can't render 1:1, so a square channel + `KIE_AI_MEDIA=video` coerces to 16:9
  (nano-banana images and real footage honor square). Minor.
- Per-channel `format` (resolution) IS threaded end-to-end (voiceover→beats→
  Ken Burns→HeyGen dimension/v3Size→assemble) as of the post-review pass.

## Verified (2026-07-24) — Upload voiceover

`tsc` 0 · `vitest` 279 pass · `next build` exit 0. Shipped in six staged commits
(rate constant → strict probe → upload route → `Voiceover` abstraction → pipeline seam →
UI), each audited and gated separately.

- **End-to-end**: an uploaded mp3 produced a finished video — transcribed by Groq
  Whisper, beats planned from those timings, avatar beats lip-synced, assembled.
- **Script mode is byte-identical**: `config_json` compared byte-for-byte against a
  pre-change run; identical tokens and beat structure.
- **Streaming, not buffering**: a 403.7 MB upload moved RSS by ~31 MB (~7.7%).
- **Resume unchanged**: an upload-sourced run resumes through the existing code path
  because the master is normalized to `audio/voiceover.mp3`. No Resume code was touched.
- **Traversal**: `resolveStagedUpload` rejects `../../etc/passwd` and 7 other hostile
  ids without touching the filesystem.
- **UI** driven over CDP (31/31) with `/api/*` intercepted — no runs created, DB untouched.

## Verified (2026-07-17)

`tsc` 0 · `vitest` 200 pass · `next build` exit 0 · DB migrations apply. The avatar
engine selector, Avatar V picker and run pages were driven in a real browser (CDP)
against a live HeyGen account; every HeyGen v3 fact above comes from probing that
account, not from the docs — which are wrong about Avatar V.

**Avatar V renders end-to-end through the pipeline.** Two real runs (2026-07-17)
produced 3 Avatar V beats via `POST /v3/videos`, `done`, not degraded.

Open, and deliberately not guessed at: the **credit→USD rate** (see pricing follow-up),
**4K** on Avatar V, and the **v3 failure payload** — no Avatar V render has ever failed,
so `pollVideoV3`'s error branch is written defensively but has never fired.

Earlier (2026-06-08): a 3-dimension adversarial review (kie/contract/UI) found 9
issues — all fixed (non-array fetch guards, kie.ai body-`code` error surfacing,
channel-default-avatar graceful degrade, format threading, empty-number input guard,
broken-thumbnail fallback, settings-load guard, dead-branch cleanup).
