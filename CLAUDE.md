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

## Video Factory (`/factory`) — titles in, finished videos out

Batch front end over the studio pipeline: title → script + description (Claude skills) →
thumbnail (ChatGPT, one image with text + arrow) → voice (VoiceStudio) → b-roll → video.
Zero-cost / zero-copyright-risk by design. **Setup, keys, defaults and troubleshooting:
`docs/FABRICA.md`.** Code: `src/lib/factory/`, `src/app/factory/`. Notable pieces added with it:
`services/voicestudio.ts` (local TTS), `services/planner-engine.ts` (`PLANNER_ENGINE=claude`),
`services/claude-vision.ts` / `chatgpt-vision.ts` (`VISION_SCORING`), `services/public-domain-sources.ts`
(NASA, Smithsonian, …), `services/beat-gap-fill.ts` (a beat with no asset is absorbed by its
neighbour — an asset is NEVER repeated), `services/respell-words.ts` (names from the script, not Whisper).

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

### Visual world (`VISUAL_WORLD`, 2026-11-06)

One Gemini call per run (`services/visual-world.ts`, called at the top of `planBeats`' query
step) reads the WHOLE script and returns `{topic, era, region, families[12–30], avoid[]}` — the
universe of imagery the video lives in. Built after reverse-engineering a reference documentary
(Sumer Vault, "Scorpion Men"): its editor keeps every shot on-topic by turning each abstract line
into a piece of the same world ("the cuneiform world ended" → a cracked tablet; "everyone who knew
it is dead" → an excavated burial). Before this, the planner's only notion of the topic was the
FIRST 60 WORDS of narration (that script never names Sumer in them), and abstract lines carried the
previous subject forward or fell back to generic stock.

- **Planner**: `formatVisualWorld()` is added to every chunk prompt plus `VISUAL_WORLD_RULE`, which
  overrides the ABSTRACT SCENE RULE's priority order (pick the family that embodies the idea; vary
  it; never the listed off-topic imagery or generic modern stock). No world → the prompt is
  byte-identical (pinned by `visual-world.test.ts`).
- **AI anchor + footage scorer**: `withWorldAnchor()` puts the world's one-line anchor FIRST in
  `videoContext`, because `buildPrompt`'s "in a documentary about:" reads only its first 160 chars.
- **Resume** re-plans nothing, so the world is persisted to `<runDir>/visual-world.json` and read back
  there (absent → the old title-only context).
- **On by default** (`VISUAL_WORLD: "1"`, DB/API-only key); anything else = off. Fail-open: no key or
  any Gemini failure logs one `warn` and plans exactly as before. Metered like the planner.
- Live-probed on the reference transcript (gemini-3.5-flash): returned seals, reliefs, kudurrus,
  tablets, excavation photos, an Assyriologist at work, desert scorpions — and listed fantasy CGI and
  office workers as off-topic. **Not yet verified on a full real run** (that the per-beat queries
  actually follow it end to end).
- **Shot variety** (with a world only): `SHOT VARIETY RULE` + the previous chunk's last 3 queries
  ("Recent shots") — measured on an archive test, 4 of 10 shots were the same tablet close-up because
  consecutive lines all mentioned tablets; the rule rotates the angle (object → site → people → the
  scene it records → map/document).
- **The world made Flow's concurrent tile matching ambiguous — fixed in `flow-browser.ts`.** Shared
  vocabulary ("ancient clay cuneiform tablet") let one beat's tile clear `MIN_CAPTION_MATCH` for
  another beat's prompt. Two guards, both in the concurrent path: (1) `pendingFlowPrompts` — a tile
  goes to the submitted prompt it matches BEST (`tileBelongsToPrompt`; tie → earlier submit;
  abandoned prompts keep competing for 10 min so their late tile can't be taken as an orphan);
  (2) a per-submit snapshot of tiles already finished in the grid, which are never a result. (2) was
  a pre-existing hole: the project grid is shared and never cleared, and a later beat took a stale
  tile from ANOTHER channel's earlier run at "100%". Pinned by `flow-tile-ownership.test.ts`; verified
  live on a 10-beat run (every AI image matched its own prompt).
- Archive sources, live-checked 2026-11-06: **Met** search moved to `/v1.1/search` (v1 answers 410)
  — fixed; **Art Institute** images sit behind a Cloudflare bot challenge (search works, every
  download 403s) and **Library of Congress** 403s even to a browser UA. Neither is worked around.
- **Archive fidelity fixes (2026-11-06, from a 90%-real archive test):**
  - *Namesakes.* "George Smith British" returned the NPG portrait of George Smith the publisher
    (d. 1901) for the Assyriologist (d. 1876). Archive hits now carry `ProviderHit.description`
    (Commons ImageDescription + date, Met title/date/culture — `catalogueText()`), shown ONLY to
    the vision scorer with an IDENTITY RULE (lexical scorers untouched). **That alone did not fix
    it** — the lite vision model still scored the namesake 95. What did: `PERSON_ROLE_RULE`
    (archive + world prompts) puts the role right after a person's name, which survives
    `broadenQuery`'s 3-token cap; with "George Smith Assyriologist" Commons' top 5 are all him.
  - *Crop.* `KEN_BURNS_FIT` ("" default = cover, unchanged; "contain"; "auto" = contain when the
    16:9 cover-crop would lose > 25%, `coverCropLoss`). Archive sets "auto": a portrait-format 1850
    watercolour had been cropped into a smear; it now shows whole on a near-black ground.
  - *Fake documents.* `NO_FAKE_DOCUMENT_RULE`: an AI "1870s newspaper" came back with an invented,
    legible masthead and headline. ai_prompt may not depict readable documents (archive + world
    prompts only); the document stays in visual_query, where only real archive items are found.
  - Still open: AI can still render an imitation ARTIFACT (an "Assyrian relief" of the flood boat)
    when no real one is found — a fake object rather than a fake document.
  - Pinned by `archive-fidelity.test.ts`.
- Archive style also gained ancient-era vocabulary (relief, stele, cylinder seal impression,
  cuneiform tablet…) in `ARCHIVE_QUERY_RULE` / `ARCHIVE_AI_PROMPT_RULE`; it only knew photo/painting media.

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

### Image path (Nano Banana, + its own model-tier fallback)

`generateFlowImage()`: `ensureFlowImageMode` (mode switch + `ensureImageModel` — confirms the
wanted model, e.g. `nano-banana-pro`, is the ACTIVE model; **fails loud**, never silently
generates on a different model) → `ensureFlowAspectRatio` (best-effort) →
`prepareComposerReference` (clear any previous beat's attachment, attach the character reference
only when `beatWantsCharacterReference(beat)` says so) → fill prompt → `submitPrompt` (accessible
Generate button → `form.requestSubmit()` → `Enter`, in that order — the button is looked for
**after** the prompt is filled, because Flow can leave it absent/disabled until then) → capture the
result from network responses (`image/*` content-type, ≥512×512, chosen by
`chooseBestCapturedImage()` against the target aspect) or, failing that, the Download button →
`FLOW_REGEN_ATTEMPTS` (default 1) scored attempts against `REAL_MATCH_THRESHOLD`/`AI_MATCH_THRESHOLD`
→ Ken Burns → `provider: "flow:<model-slug>"` (e.g. `flow:nano-banana-pro`, `flow:nano-banana-2` —
reflects whichever tier actually produced the image, see below).

**`FLOW_IMAGE_MODEL_FALLBACK` (default empty = off) — a client asked for exactly this:
"when Nano Banana Pro hits its limit, switch to Nano Banana 2 so it keeps generating."**
`generateFlowImage` tries the primary `FLOW_IMAGE_MODEL` first; on ANY failure except one no
model choice can fix (`FlowBrowserError` code `login` or `config` — `isModelIndependentFailure`),
it logs a `warn` and retries the WHOLE attempt once against the configured fallback model
(`ensureImageModel(page, fallbackModel)`, the same fail-loud confirmation as the primary). The
returned `{ path, model }` tells the caller which tier actually ran, so the provider string and
run log are never misattributed to the primary model when the fallback produced the image.

- **Deliberately NOT gated on recognizing a specific "limit reached" message.** That exact
  wording has never been observed against a live session, and a broad "any retryable failure"
  rule is more robust to Google changing it than a guessed regex would be — the alternative was
  either a fragile pattern-match or blocking this feature on a live probe. The cost of trying the
  fallback needlessly on a genuine full outage is a few extra seconds of UI interaction, not a
  paid retry: Flow spends the operator's own Google account, never a per-call bill.
- **The matcher (`flowModelLabelMatches`, formerly `veoModelLabelMatches` — kept as an alias so
  existing imports/tests don't break) is shared between Nano Banana tiers and Veo tiers.** It was
  never Veo-specific logic to begin with, just named after its first caller; `ensureImageModel` and
  `ensureVeoModel` both pick the visible menu option whose text, after stripping only cosmetic
  decoration, equals the wanted id exactly — so `nano-banana` never matches a menu entry for
  `Nano Banana Pro`, and `nano-banana-pro` never matches `Nano Banana 2`.
- **The image-model catalog (`providers.ts`, `flow_browser.image.models`) now lists three tiers**
  (`nano-banana-pro` recommended, `nano-banana-2`, `nano-banana`) so both `FLOW_IMAGE_MODEL` and
  `FLOW_IMAGE_MODEL_FALLBACK` can be picked from a dropdown — plus the registry's normal free-text
  escape for whatever Google names the next tier.
- **Not yet validated against a live Flow session** (same caveat as the rest of this section): the
  fallback retry's *orchestration* (which model runs when) is unit-tested via
  `isModelIndependentFailure`/`flowModelLabelMatches`, but the actual in-browser retry — does
  Flow really offer a distinct "Nano Banana 2" menu entry, and does switching mid-session work
  cleanly — has not been driven against a real account. Confirm once and update this note.

**Model switching is a two-click flow through the composer chip — verified against the live DOM
(2026-09-23, pt-BR account).** The chip (`aria-label="Gatilho de configurações"`, innerText
`🍌 Nano Banana 2 | crop_16_9 | x1` — `crop_16_9` is a Material-icon ligature leaking into the text)
opens a popover with a SECOND button, the family select (`aria-label="Selecionar família de modelos"`,
`aria-haspopup="menu"`); that opens a `role=menu` of `role=menuitem` tiers (Nano Banana Pro / 2 /
2 Lite). `selectModelViaComposer` does exactly that and confirms by reading the chip back
(`chipShowsModel`). Two traps it exists to avoid: (1) the old routine made only the FIRST click, saw
just the collapsed select's own text, and gave up — so Pro never confirmed while "2" only passed
because it was already active; (2) locators must not use accessible names (both labels are localized)
— structure (`aria-haspopup`, `role=menuitem`) plus the model-family text is language-neutral. The
Veo path reuses the same helper but its popover has NOT been inspected live; if it differs the legacy
routine still runs as fallback. `flow-model-select.test.ts` drives the logic in real headless Chrome
against a structural mock — it proves the click/wait/verify logic, not that Google hasn't moved its
markup, so re-inspect the live page when a run fails to confirm a model.

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

### Fallback — `FLOW_FALLBACK_PROVIDER` (`none` default | `kie` | `chain` | `vids`)

Preserves the beat's media KIND on failure, for both directions: a video-routed beat that exhausts
Flow's Veo path falls to `kie.ai`'s Veo (never its nano-banana image path), and an image-routed beat
falls to `kie.ai`'s nano-banana (never Veo). `none` fails closed — a `FlowBrowserError` propagates
rather than silently reaching Grok/Cloudflare/Pollinations/Meta/Magnific/Runware/kie.ai. This holds
even though the KIE branch below is itself generic: on a Flow-video fallback, `provider` is set to
`"kie"` and execution falls through into the SAME `resolveAiMedia()` call the kie branch already
makes for every other route — it independently resolves back to `"video"` from the same beat/override/
settings, so the handoff is not a special case, just letting the existing kie logic run.

**`vids` (2026-09-29) — a free try on Google Vids IN FRONT of the `chain` fallback, requested after
a real run showed Flow occasionally missing its own 240s window under `FLOW_IMAGE_CONCURRENCY`.**
It is a layer, not a replacement: on an ordinary still, when Flow's own attempt loop fails,
`generateVidsImage` is tried once before anything paid; if it also fails (or scores below the
gate), or the beat wants the character reference (Vids' image panel has no reference input — same
exclusion as `VIDS_FIRST` above), execution falls straight through to the SAME
Cloudflare → Pollinations → Meta Muse → kie.ai chain `chain` already runs. `vids` is never left with
no fallback just because the free source happened to be down too — the chain still runs underneath
it, unconditionally. Reuses the EXISTING `vidsSpentRuns`/`vidsConsecutiveFailures` circuit breaker
(built for `VIDS_FIRST`) rather than duplicating it, since it's the same Vids account/quota whether
Vids is tried before or after Flow. Covered by `flow-vids-fallback.test.ts` (Vids succeeds; Vids
also fails and falls to Cloudflare; both unavailable and it still reaches kie.ai; a
character-reference beat skips Vids entirely; plain `chain` never touches Vids — regression guard).
Video beats are unaffected — Vids' video path isn't wired into this fallback, only its image panel.

**Attaching the reference — verified live (2026-09-24, pt-BR), and it is SELECT-or-upload, in two
layouts.** The composer's "+" (`aria-label="Adicionar elementos à caixa de comando"`) opens Flow's
own asset picker — a `role=dialog` in the compact layout, an inline `flow-add-menu-popover-content`
in the wide one (no dialog there). Both hold `flow-add-menu-asset-list` → `[role=option]` rows (first
line = file name). **Clicking an existing row closes the picker and attaches it**; a native file
chooser exists only behind the upload button (`button.sidebar-upload-btn`; compact: aria-label
"Enviar mídia"; wide: no aria-label, and its `textContent` is `"uploadEnviar mídia"` — icon glued to
the label, so a `\b` after "upload" never matches). `attachFlowReferenceViaAssetPicker` uploads the
portrait ONCE under a content-hash name (`character-reference-<sha8>.jpg`) and selects it by exact name
on every later beat — so replacing the portrait can never resolve to a stale asset that merely shares a
file name. A fresh upload is listed only ~15 s later and is not clickable until then, hence the retry loop.
The attachment is a chip: `button:has(img[alt="Imagem do elemento"])` (aria-label "Elemento"; clicking it
removes it). Match it structurally — `[aria-label*="lemen"]` also matches the "+" ("Adicionar ELEMENTOS").

What this fixed, all one root cause: the old code only UPLOADED (never selected), and looked for English
"remove … reference" buttons, so (1) the attach was never confirmed, (2) every beat re-uploaded the file
(four identical assets piled up in the project), and (3) worst, the chip that DID attach was never cleared —
a later beat that wanted no reference was generated with the previous beat's still attached and came back as
the reference photo itself. `prepareComposerReference` now fails CLOSED if a stale attachment can't be cleared.

**Escape does not close the wide layout's popover** — it is a CDK overlay that stays open behind a
`.cdk-overlay-backdrop-showing` and swallows every later click. `dismissOpenOverlays` (Escape, then click the
backdrop) is what closes it; that leftover was how a failed attach used to poison the next model switch.

**Layout depends on the window width, and only the compact one is what this code was built for.** The model
chip (`Gatilho de configurações`) exists only in the compact composer. The wide layout has an "Agente" pill and
no chip: the models live behind a `tune` button in a "Configurações do agente" panel (image/video default
model selects) that is NOT closed by Escape (use its back arrow — never "Salvar"). Model switching in the wide
layout is not implemented, and generation semantics there (agent "confirmar antes de gerar") are unverified.
Keep the Flow window in the compact layout. `flow-reference-upload.test.ts` drives all of this in real headless
Chrome against a structural mock (both layouts) — it proves the logic, not that Google hasn't moved the markup.

### Failure handling, fallback chain, sequencing (2026-09-24)

- **Failure cards are counted against a baseline.** Flow keeps failed tiles in the project grid, so an
  old refusal / usage-limit card is still in `body`. `failureBaselineOf(body)` is taken right before
  submit and `classifyFlowFailureBody(body, media, baseline)` only reports a card that is NEW. Without
  it, object-only beats were "refused" ~17 s after submit by a stale card.
- **`FlowBrowserError` code `policy`** = Google's "talvez viole nossas políticas". Never worked around.
  It is model-independent (`isModelIndependentFailure`: no retry on the fallback model) and counts as
  a beat-exhausted failure (`isFlowBeatExhausted`: neighbour reuse, the run does not crash). The
  refusal was traced to the identity prompt ("preserve facial structure … likeness"), NOT the attached
  photo: `CHARACTER_REFERENCE_INSTRUCTION` is now "same outfit, hairstyle and general look".
- **Usage limit** ("Você chegou ao limite de uso", live-observed) is code `credits`. `generateFlowImage`
  remembers per model, for 30 min (`state.limitedModels`, in-process), that it hit its limit and goes
  straight to `FLOW_IMAGE_MODEL_FALLBACK`; both limited -> throws at once. In `visual-source.ts`, a
  credits error or 3 consecutive non-policy failures marks the run's Flow "spent"
  (`flowSpentRuns`) and later beats go straight to the fallback.
- **`FLOW_FALLBACK_PROVIDER=chain`**: Cloudflare -> Pollinations -> Meta Muse -> kie.ai for ordinary
  stills. Character-reference beats and videos never use the cheap chain (only kie Edit / kie Veo).
- **Beats run in parallel with Flow (`VISUAL_CONCURRENCY`, default 3).** Flow generation stays serial through its own
  process-wide queue, so parallel beats never overlap inside the one controlled tab; they only let Pexels/YouTube
  beats and fallback providers work while Flow generates. (A short-lived rule forcing concurrency 1 under
  `AI_PROVIDER=flow_browser` was removed: it made a 157-beat run take ~2.7 h.) Neighbour reuse for an exhausted
  beat is intentionally kept.
- **Attach retries**: `prepareComposerReference` retries the attach 3x (close overlays, clear chips)
  before failing closed.
- **Style slot**: when the style has `[INSIRA O ASSUNTO AQUI]`, the subject goes through
  `fitSubjectToSlot` ("An over-the-shoulder shot of X." -> "X, over-the-shoulder shot") and the
  "in a documentary about: …" anchor is omitted. Prompts without a slot are byte-identical to before.

### Second Flow account mapping — "Frames" vs "Elementos" video input mode (2026-09-30)

Mapped by screenshot walkthrough (no CDP access to this account — a separate anti-detect-browser
profile, not the operator's normal automation Chrome) against a second Flow account ("guiaraki",
ULTRA plan). Two findings:

- **The model-name matcher needed no fix.** This account's Veo dropdown lists FIVE distinct tiers
  — Omni 1.1 Flash, Veo 3.1 - Lite, Veo 3.1 - Fast, Veo 3.1 - Quality, **and** Veo 3.1 - Lite
  [Lower Priority] as a SEPARATE entry (the operator gets unlimited generation specifically on the
  bracketed one). This looked at first like it would collide with `flowModelLabelMatches`'s
  "strips cosmetic decoration" rule, but re-reading `cleanModelLabelLine` settled it: it only
  replaces the bracket/paren PUNCTUATION characters with spaces — it does not drop their
  contents — so "Veo 3.1 - Lite [Lower Priority]" normalizes to `veo 3.1 lite lower priority`,
  genuinely different from plain `veo 3.1 lite`. Setting `FLOW_VIDEO_MODEL=veo-3.1-lite-lower-priority`
  is all that is needed to target the unlimited tier specifically; no code changed.
- **A second `role="radio"` pair the video composer settings popover — "Frames" (start/end still
  images) vs "Elementos"/"Elements" (character/object reference "ingredients") — was NOT wired
  into `generateFlowVideo` at all**, though `openComposerSettingsPopover`'s own doc comment had
  already noted its existence from an earlier session without anyone acting on it. On this
  account the reference-photo attach only works with "Elementos" active; Flow's own default is
  "Frames" (accepts start/end stills instead). The operator confirmed there is no way to
  deselect it back to "Frames" once chosen, and that leaving "Elementos" selected with nothing
  attached is safe — so `ensureFlowVeoElementsMode` (same `role="radio"` + `aria-checked` pattern
  as `ensureFlowMediaMode`/`ensureFlowAspectRatio`) now runs on EVERY video generation, before the
  reference-attach step, regardless of whether that beat actually has a reference. Best-effort
  like aspect ratio/duration: an older layout without this second radio pair has nothing to find
  and generation proceeds exactly as before this existed.
- **Not yet verified**: whether this second radio pair exists on the PRIMARY Flow account/project
  documented elsewhere in this file, or is specific to this second account/a newer Flow rollout.
  `openComposerSettingsPopover`'s own doc comment already described seeing "Frames/Elementos"
  together with the other radios, so it is likely present broadly — but only this second
  account's reference-attach dependency on it has actually been confirmed live.

### A one-shot "Sign in" check retired Flow for an entire run over a blip, not a real logout (fixed 2026-10-01)

Diagnosed on a real run: 3 CONCURRENT beats (15/16/17) all reported "Google session expired
during generation" within under a second of each other — three non-policy/non-credits failures
is exactly `FLOW_FAILURES_BEFORE_SPENT`, so `flowSpentRuns` tripped at beat 18 and every later
beat skipped Flow for the rest of the run. **The operator confirmed the Google login never
actually dropped.** All three beats were polling the SAME shared page (Flow's tab is one
module-global page, per the "serialized process-wide" design) at the same instant, and all
three caught the SAME one-shot reading from `pageHasLoginPrompt` — a plain URL-pattern check
(`accounts.google.com`/`/signin`/`ServiceLogin`) plus a page-wide text search for "Sign in". Both
halves can be transiently true for an instant during a SILENT background session/token recheck
that Google itself resolves in well under a couple of seconds, with no operator action and
nothing actually wrong with the login — a momentary bounce is indistinguishable from a real
logout at the exact instant it's sampled.

The cost of trusting that one-shot reading is wildly disproportionate: a single false positive
doesn't just fail one beat, it marks the run's whole Flow session "spent" (`login` is a
non-policy code, so it counts toward the same 3-strikes counter a real problem would trip) —
permanently retiring Flow for every remaining beat even though the account was never actually
logged out. Fixed by splitting the check into `pageLooksLoggedOut` (the original one-shot
logic) and `pageHasLoginPrompt` (exported for tests), which now only trusts a positive reading
after a 2.5s settle wait AND a second check still agreeing. This costs nothing on the ordinary
path (the wait only ever runs on the rare positive branch, never on every poll tick) and costs
a genuine logout only ~2.5s of extra detection time — trivial next to losing Flow for an entire
run over a blip that would have resolved on its own. All 9 call sites across the image/video
setup checks and wait loops share the one fixed function, so every one of them benefits
uniformly without the fix needing to be duplicated. Covered by `flow-browser.test.ts`: a clean
page reports false with no wait, a momentary bounce that resolves during the recheck is NOT
reported as a logout, and a persistent logout (URL or visible "Sign in" text, still true after
the recheck) is still correctly reported.

**The SAME day, a second and more stubborn false positive in this exact check, found live on a
later run**: 3 beats again reported "session expired"/"login required", this time surviving
BOTH the 2.5s recheck above AND a full server restart — yet the operator confirmed no login or
consent screen was ever visible in the Flow tab. Connecting Playwright directly to the SAME
CDP port the app's own automation Chrome uses (`127.0.0.1:9223` — this is the operator's own
local automation profile, not a third-party tool) and running the live `getByText` search
found the culprit: it matched a `<span>` reading **"Snow covered street sign in winter, muted
colors..."** — one of Flow's own auto-generated tile captions (see "Concurrent image generation
v2" above: Flow captions every finished tile from its own content) for a winter-themed run. A
bare, unanchored `/Sign in/i` search matches that substring anywhere ANY text contains those
characters in sequence — "street SIGN IN winter" quietly satisfies it exactly as much as a real
"Sign in" button would. This is why neither the recheck nor a restart ever cleared it: a tile
caption is permanent page content, not a transient state, so the false reading was never
going to resolve on its own. Fixed by requiring the match to be a clickable control
(`button, a, [role="button"], [role="link"]`) whose ENTIRE text is (closely) just "Sign in" /
"Fazer login" / "Iniciar sessão" (`SIGN_IN_PHRASE`, anchored `^...$`) rather than a substring
search over the whole page — a caption with many other words in it can no longer match no
matter what words it happens to contain. Pinned by a regression test using this EXACT caption
string, plus confirms the PT-BR phrases are still caught as exact button text.

### Veo video capture — verified live (2026-09-25)

- **A finished video is NOT reliably visible to `page.on("response")`.** Flow binds `<video src>` (a
  `flow-content.google/video/<uuid>?Expires=…` URL, no file extension) as soon as the card renders, but the
  browser may not fetch the bytes until the element is scrolled/played. A clip ready in ~83 s once sat there
  while the passive listener waited the full 600 s. `generateFlowVideo` now snapshots the page's `<video>` srcs
  BEFORE submitting (`currentFlowVideoSrcs`), breaks out as soon as a NEW src appears, and fetches it directly
  (`fetchVideoFromResultElement`, `page.request.get`). The baseline is what stops an older video in this
  shared project grid from being taken as the beat's result.
- **Direct fetch = the manual download.** md5-identical to the file the card's ⋮ menu saves
  (`Mais opções` → `Fazer o download` → submenu `270p GIF animado` / `720p Tamanho original` / `1080p` and `4K`
  "Aprimorada"). Clicking that menu makes Chrome save into ~/Downloads and Playwright (attached with
  `noDefaults`) gets NO `download` event — so the menu is deliberately not used by the pipeline.
- Capture order: download button (none exists passively) → direct fetch → network response. The run log says
  which one won: `Flow video captured via: …`.

- **Out of Veo credits -> the beat is rendered as a Flow IMAGE.** A `credits` failure on a video beat (or a run
  already marked in `flowVideoSpentRuns`) switches that beat to the Flow Nano Banana image path (Ken Burns) in
  `acquireAi` — no kie.ai Veo attempt, no wait. Skipped when the operator pinned "Videos only"
  (`KIE_AI_MEDIA=video` / `mediaOverride==="video"`), which keeps the old fail/fallback behaviour. Covered by
  `flow-media-routing.test.ts`.
- **Insufficient-credits alert (observed 2026-09-25, semantics partly unverified).** When the balance cannot
  cover a generation Flow swaps the arrow for `button.prompt-warning-button` (aria "Alerta de créditos
  insuficientes") and shows NO failure card. `flowInsufficientCreditsWarning` checks for it right before
  submit (image and video) and throws code `credits`; a video-side credits failure is tracked apart
  (`flowVideoSpentRuns`) so it does not send the still images to the fallback chain. NOT verified: whether
  Flow truly blocks submission while the alert shows — one Veo beat still finished (~5 min) with the alert on
  screen, so it may also appear after a submit reserves credits.

### Concurrent image generation (`FLOW_IMAGE_CONCURRENCY`) — BROKEN, confirmed live, reverted to 1

**2026-09-27, later the same day: a real 7-beat run at concurrency 2 produced a confirmed
misattribution.** Beat 0's own image (hand pointing at a PVC pipe) was correct; beat 1's
prompt asked for a close-up of water dripping onto dirt but rendered as a near-duplicate of
beat 0's scene; beat 2's prompt asked for heat waves over a driveway but rendered beat 1's
water-dripping close-up. A one-position shift, confined to the three beats submitted in the
same concurrent batch (0/1/2) — beat 3, submitted once a concurrency slot freed up, was
correct again. **This is the exact failure mode the design below was meant to prevent, and
it happened on the first real run. `FLOW_IMAGE_CONCURRENCY` has been reverted to `1` and
must NOT be raised again until this is actually fixed** — the DB value alone stopping it
(rather than removing the code) is deliberate, so the mechanism stays available to fix and
re-test without another round of wiring it back in.

**Root cause, also confirmed live the same day**: the design below assumed
`img[data-media-id]` is assigned as soon as a placeholder tile appears, seconds after
submit. It is not — a DevTools check on the SAME account showed the id/src only resolve to
a real fetchable image once the generation is well along (real generations here ran
~40–50s end to end), nowhere near the 8-second grace window `waitForNewFlowImageSrc` was
given while still holding the submit lock. In this run, 5 of 7 beats never found their tile
in time and fell through to the response-listener fallback — and it is that fallback,
running concurrently across several in-flight generations sharing the SAME
`page.on("response")` stream, that cannot actually tell whose image is whose. The
CLAUDE.md text below describing this as "best-effort… a known, documented trade-off" was
correct that it was a trade-off; it was wrong that the trade-off was rare — with the real
8s window, it is the common case, not the exception.

**Fixed the same day — see "Concurrent image generation v2" below.** Identification cannot
happen inside a short, lock-holding window if the id genuinely takes tens of seconds to
resolve; the fix was to stop needing early identification at all, by correlating on tile
CONTENT (a caption Flow derives from the result) once it resolves, whenever that is,
instead of tile IDENTITY captured the instant a placeholder appears. `FLOW_IMAGE_CONCURRENCY`
stays at `1` in the DB regardless — this incident is the reason to re-verify on a small run
before raising it again, not a reason the code can't be trusted at all.

The section below is kept as a record of the incident and of what v1 got right (the DOM
facts about `img[data-media-id]`, direct-fetch-by-src, the submit-lock/wait-concurrency
split) — only its "identify while holding the lock" scheduling assumption was wrong, and v2
keeps everything else.

### Concurrent image generation v2 (`FLOW_IMAGE_CONCURRENCY`, 2026-09-27) — caption-match correlation

Still defaults to `1` (the fully-serial `attemptFlowImage`, byte-identical to before any of
this existed) until raised deliberately. v1 (above) is disproven and MUST NOT be revived
as written; this is the replacement design, and it fixes the root cause rather than
patching the symptom.

**Why v1 failed, in one sentence**: it needed to identify a submission's own tile within an
8-second in-lock window, but `data-media-id` does not exist until the generation is
essentially done (tens of seconds) — so it almost never found anything, fell back to a
signal (`page.on("response")`) that cannot be attributed to one of several concurrent
generations, and that is exactly what produced the confirmed off-by-one image shift.

**v2's insight, found by inspecting the live DOM while debugging v1's failure**: Flow
assigns each finished tile (`<flow-grid-tile-container aria-label="…">`) a short caption of
its OWN content — confirmed live, twice, on our real account:
- a prompt for *"a bright blue teacup on top of a dark wooden table"* produced a tile
  captioned **"Blue teacup on wooden table"**;
- with 19 unrelated tiles already in the grid (water, industrial, housekeeper, dinosaur
  content from earlier tests), a prompt for *"a red vintage bicycle leaning against a brick
  wall"*, submitted 1.5s after a second concurrent prompt, produced a tile captioned
  **"Red vintage bicycle leaning agai…"**, matched with score 0.8 against **only** its own
  prompt — never confused with any of the 19 others.

Because the caption is not opaque, correlation no longer needs to happen EARLY. Each beat
can recognize its own result whenever it happens to resolve, by matching content, not by
having grabbed a reference the instant a placeholder appeared:

- **Submission stays fully serialized**, through the SAME `enqueue()` lock video uses — one
  beat's composer setup + prompt + click at a time. The lock is now held for LESS time than
  v1 (nothing is awaited after the click; v1 additionally waited up to 8s in-lock for an id
  that usually never came), so v2 is *shorter*-locked than v1, not longer.
- **The WAIT is concurrent**, bounded by `imageWaitLimit()`, unchanged from v1 — this is
  still the entire speed win, and nothing about the correlation fix touches it.
- **`currentFlowImageTiles(page)`** returns every tile that has BOTH a `data-media-id` and a
  resolved src — a tile mid-render is invisible to it, by construction, never a false empty
  match. **`captionMatchScore(caption, prompt)`** is recall of the caption's meaningful words
  (stopwords stripped) against the submitted prompt — asymmetric on purpose: the caption is
  short and the prompt is long and rich, so scoring "how much of the caption is IN the
  prompt" is the well-posed direction; the reverse would fail on true positives (a 5-word
  caption can't contain much of a 30-word prompt). **`MIN_CAPTION_MATCH = 0.6`** — pinned by
  a regression test built from the confirmed misattribution: the WRONG beat's caption scores
  well under this bar against the RIGHT beat's prompt.
- **`claimFlowTile(mediaId)`** is a synchronous Set test-and-set — `Set.has`/`Set.add` never
  yield, so two concurrent waiters checking the same tile on the same poll can never both
  claim it; whichever call sees `false` first tries the next-best-scored candidate instead
  of giving up. `claimedMediaIds` is module-global (the tab outlives any one run), so a tile
  claimed by one beat is permanently off the table for every later beat too.
- **No match clearing the bar within the timeout is a real failure** (`timeout`, same
  contract as everywhere else in this file) — never guessed at, never silently accepted
  below-threshold. There is no response-listener fallback in v2 at all: v1's fallback was
  itself the unsafe-under-concurrency mechanism that actually caused the incident, so it was
  removed rather than kept as a second-tier "better than nothing" — a clean failure beats a
  second path back into the same bug.
- Covered by `flow-image-concurrency.test.ts`: concurrency parsing/clamping,
  `currentFlowImageTiles`'s empty-tile exclusion (via a fake DOM element that runs the REAL
  evaluateAll callback, not a mock that bypasses it), `captionMatchScore` on the two
  confirmed live pairs above (including the actual misattribution as a MUST-score-low
  regression case), `claimFlowTile`'s test-and-set, and `imageWaitLimit`'s bound.
- **What live testing did NOT fully exercise**: two-image-truly-concurrent claiming under
  contention (the bicycle test's second prompt — a fluffy cat in a box — never resolved in
  ~2.5 minutes in the ad hoc validation script, most likely because that quick script didn't
  replicate our own credits/model-confirmation handling before submitting, not a flaw in the
  matching logic itself). The matching algorithm's correctness against real, rich captions
  and a crowded grid (20 candidates) IS confirmed; a real multi-beat run is still the next
  checkpoint before trusting this unattended on a large batch.

**Before raising this above 1 on a large real run**: try `FLOW_IMAGE_CONCURRENCY=2` on a
small run (10–15 beats) first and check every resulting image against its own beat's prompt
— cheap to eyeball in full, and exactly how v1's bug was actually caught.

**A second real bug, found live 2026-09-29: `findAndClaimMatchingTile` never checked for a
failure card WHILE polling, only after — and "after" can never fire.** The serial
(non-concurrent) `attemptFlowImage` interleaves `detectFlowFailure` every 4s inside its wait
loop, so a credits/policy card ends the wait in seconds. The concurrent path's wait was split
into `findAndClaimMatchingTile` (poll for a matching TILE) and a failure check the caller ran
`if (!claimed && Date.now() < deadline)` — but `findAndClaimMatchingTile` itself loops until
`Date.now() >= deadline`, so by the time it returns `null` that condition is already false:
the failure check is dead code, unreachable in practice. Confirmed live on a real account
whose Nano Banana 2 had hit its usage limit (a Flow project grid full of "Você chegou ao
limite de uso" cards): every affected beat burned the full 240s and was misclassified as a
generic `"timeout"` instead of `"credits"` — and because `noteFlowFailure` (visual-source.ts)
only marks `flowSpentRuns` on an explicit `credits` code (or 3 CONSECUTIVE non-policy
failures, a counter any interleaved Flow success resets), the run's circuit breaker never
tripped and Flow kept being retried fresh on every later beat instead of the run correctly
recognizing "Flow is out" and sticking to `FLOW_FALLBACK_PROVIDER` (Vids) for its remainder.
Fixed by moving the same 4s-interleaved `detectFlowFailure` check inside
`findAndClaimMatchingTile`'s own loop (now takes `failureBaseline`), matching the serial
path; the caller's now-unreachable post-loop check was removed rather than kept as dead code.

### Self-healing for "random-looking" Flow UI failures (2026-09-27)

Diagnosed against a real 174-beat run: three DIFFERENT UI-detection errors fired within 33
seconds of each other (beats 149/151/152 — "no full-size image captured", "could not switch
to Image mode", "could not find the prompt box"), all after ~1h40 of continuous automated use
of the SAME long-lived Chrome tab. The exact Google-side trigger (a stuck overlay, a stale
toast, accumulated DOM/memory cruft in the SPA's own project grid) is not provable without a
live repro — but the shared, plausible cause is the tab itself degrading over a long
uninterrupted session, not three independent selector bugs.

- **`isPresubmitUiGlitch(code)` draws the ONE line that matters: pre-submit vs. post-submit.**
  Only `"ui"` — a mode-switch/prompt-box-lookup/reference-attach failure — ever gets an
  automatic reload-and-retry, because nothing has been submitted yet at that point: a reload
  is free. `"timeout"` ("no image/video captured") is EXCLUDED on purpose even though it can
  look just as random — it fires AFTER `submitPrompt`, where a real generation may already
  have consumed the account's usage allowance even though we failed to capture the result;
  retrying that blindly would risk a silent double-spend. `"credits"`/`"policy"` are real
  account states a reload cannot change; `"login"`/`"config"` need the operator. Pinned by
  `flow-ui-glitch-retry.test.ts` so this boundary can't quietly widen to "any failure."
- **`attemptFlowImage`'s composer setup (dismiss overlays → prompt box → mode/model →
  aspect ratio → reference attach) is now wrapped**: on a qualifying failure, `page.reload()`
  + a settle wait + one retry of the exact same setup, BEFORE falling through to the existing
  model-fallback (`FLOW_IMAGE_MODEL_FALLBACK`) / provider-fallback (`FLOW_FALLBACK_PROVIDER`)
  chain. Only the image path got this — the video path's equivalent pre-submit steps already
  have a different, arguably safer mitigation (see below): they degrade the beat to a Flow
  IMAGE instead of retrying an expensive Veo generation.
- **Video's presubmit steps (`FLOW_PRESUBMIT_STEP_MS`, 90s deadline per step in
  `generateFlowVideo`) are a SEPARATE, earlier fix for the same family of symptom** — a step
  that never returns at all (observed: a beat sat 9m43s with zero log output before a
  manual cancel) rather than one that returns a clean "ui" error. A stalled step throws
  `FlowBrowserError(..., "timeout", stalled: true)`; `visual-source.ts` treats `stalled` the
  same as a credits failure and renders that beat as a Flow image instead of hanging the
  whole serialized Flow queue for everyone behind it.
- **`FLOW_TAB_RECYCLE_EVERY` (default 20) — the preventive half, added same day.** Rather
  than only reacting after a failure, `maybeRecycleFlowTab` counts every generation (image
  or video, success or failure — the tab ages either way) in a module-global counter and
  forces one reload before the Nth, resetting to 0. Called at the start of both
  `attemptFlowImage` and `generateFlowVideo`, right after the login check. This is the
  middle ground between never reloading (what produced the 149/151/152 cluster) and
  reloading before every single beat (which would cost real seconds on every generation for
  a problem that, so far, only showed up after sustained use). `0`/blank disables it; a
  blank setting still falls back to 20, not to "disabled" — pinned by
  `flow-tab-recycle.test.ts` (the module reads `globalThis.__facelessFlowBrowserState` only
  ONCE at import time, so the test resets the counter with `vi.resetModules()` + a fresh
  dynamic import, not by mutating the global after the module is already loaded).
- **What this does NOT explain**: why the tab degrades in the first place. The counter is a
  schedule, not a diagnosis — if the cluster still recurs at a materially different beat
  count than ~20, that's a signal the real trigger is something else (e.g. elapsed TIME
  rather than generation COUNT), and the fix should move from a count-based to a
  time-based schedule instead.

### The IMAGE path's composer setup had no presubmit deadline (fixed 2026-09-29)

Diagnosed live: a resumed run submitted 3 beats to Flow's image queue (`FLOW_IMAGE_CONCURRENCY=2`)
and then went **completely silent for 5+ minutes** — no log line, no error, no timeout — for all
three. `generateFlowVideo` already wraps every composer-setup step (mode switch, ratio, reference
attach) in `withPresubmitDeadline` (90s) specifically because "a control that never answered held
Flow's single serialized queue for good, stalling every later beat — images included" (see the
comment on `FLOW_PRESUBMIT_STEP_MS` above) — but `attemptFlowImage` and
`attemptFlowImageConcurrent`'s `setupComposer()` (`dismissOpenOverlays` → `promptBox` →
`ensureFlowImageMode` → `ensureFlowAspectRatio` → `prepareComposerReference`) ran those same steps
**bare, with no deadline at all**. A control that never resolves there hangs forever, holding
`enqueue()`'s lock and silently blocking every later Flow beat behind it — exactly the symptom
observed, and worse than the video case since NOTHING downstream of that lock can run at all.

Fixed by wrapping both composer-setup closures in `withPresubmitDeadline` the same way
`generateFlowVideo` already does (`prepareComposerReference` gets `3× FLOW_PRESUBMIT_STEP_MS`,
same as video, since it can involve an upload). **Deliberately does NOT widen
`isPresubmitUiGlitch`'s free-reload-retry to cover the resulting stall** (`code: "timeout",
stalled: true`) — that boundary is pinned by test as "ui" only, and a stall now simply throws
out of `setupComposer()` into the SAME fallback chain (model fallback → `FLOW_FALLBACK_PROVIDER`)
that already handles every other Flow image failure. Unlike video, an image beat has no cheaper
media kind to degrade to, so a reload-retry would buy nothing the existing chain doesn't already
provide.

**A second, independent misconfiguration compounded the same incident**: `FLOW_IMAGE_MODEL_FALLBACK`
was set to the SAME value as `FLOW_IMAGE_MODEL` (both `nano-banana-2`), on an account whose Nano
Banana 2 had hit its usage limit (confirmed live — a Flow project grid full of "Você chegou ao
limite de uso" cards). `generateFlowImageConcurrent`'s own guard (`isLimited(primaryModel) &&
(!fallbackModel || isLimited(fallbackModel))` → throw immediately) means a fallback model equal to
an already-limited primary is worse than no fallback at all: it walks through a second full
composer-setup + submit cycle against a model already known to be blocked, burning the presubmit
deadline's 90s+ again before finally giving up — instead of the immediate `credits` throw an EMPTY
`FLOW_IMAGE_MODEL_FALLBACK` produces. Operator fix (not code): set `FLOW_IMAGE_MODEL_FALLBACK` to a
genuinely different tier, or leave it blank so a limit hit falls straight through to
`FLOW_FALLBACK_PROVIDER` (here, `vids`) with no wasted retry.

**Live-testing the two fixes above surfaced a third, more fundamental bug, also fixed 2026-09-29**:
neither Flow nor Vids ever called `page.bringToFront()`. They share ONE Chrome window as separate
tabs, and the operator watched it happen live — a beat correctly fell over to Vids and generated
successfully (100% match) **only after manually switching Chrome to the Vids tab**; a later beat's
Vids fallback then failed outright (`locator.click: Timeout 8000ms exceeded … waiting for
locator('textarea').filter({ visible: true })`) while the operator was looking at the Flow tab
instead, and the run only recovered once they switched back to Vids. Some of Vids' own Angular UI
(confirmed live: the prompt textarea) simply does not resolve as `visible` to Playwright while its
tab is backgrounded — so which automation actually WORKS silently depended on which tab a human
happened to have on screen, defeating the entire point of an unattended fallback chain. Fixed by
calling `page.bringToFront()` in both `vidsPage()` (vids-browser.ts) and `launchBrowser()`
(flow-browser.ts, both the cached-page fast path and the freshly-connected path) — each automation
now makes ITS OWN tab the active one via CDP immediately before touching it, regardless of what the
operator has on screen. The operator no longer needs to babysit which tab is focused.

**A fourth bug, found the same day once the failure-detection fix above (see "Concurrent image
generation v2") started correctly tripping `flowSpentRuns`**: once a run's Flow session is marked
spent, `visual-source.ts`'s early short-circuit (right before `if (provider === "flow_browser")`)
unconditionally set `provider = "kie"` — which skips the ENTIRE `flow_browser` branch, including the
per-beat "Flow failed → try Vids → then the chain" block that lives inside it. So the very first
`credits` hit correctly stopped wasting time on Flow, but **every beat after that jumped straight
to the paid chain, never trying Vids again** — exactly backwards from `vids`'s purpose as a free
layer in front of the chain, and exactly the gap the operator caught live ("não faz sentido... era
pra ficar somente no Vids"). Fixed with a `flowImageKnownSpent` flag: when `flowFallbackVids` is
configured, the short-circuit no longer reassigns `provider` at all — it lets the beat still enter
the `flow_browser` branch, skips only the actual `generateFlowImage` attempt loop (logging "Flow
session spent for this run — skipping straight to Google Vids"), and falls through to the SAME
Vids-then-chain block a fresh per-beat failure already uses. `flowSpentRuns` is IMAGE-only
(`flowVideoSpentRuns` is separate), so this only ever touches the image path; a video-routed beat is
unaffected. Regression-covered in `flow-vids-fallback.test.ts`: a run whose first beat trips
`flowSpentRuns` via a `credits` failure, then a second beat on the SAME run id, asserts
`generateFlowImage` is never called again while `generateVidsImage` still is, every beat.

### Google Vids provider (`VIDS_FIRST`) — verified live 2026-09-26

`services/vids-browser.ts` drives the Vids editor (docs.google.com/videos) in the SAME Chrome Flow uses (its own tab,
its own queue, so it runs in parallel with Flow's). It is tried BEFORE Flow when `VIDS_FIRST` = `image` | `both`
(default `off`); any failure or a weak score falls through to the ordinary Flow path, so enabling it only ADDS a source.
Beats that need the character reference never use it (Vids' "Ingredientes" upload is not wired). A per-run circuit
breaker (`vidsSpentRuns`: credits/config/login, or 3 failures in a row) stops it costing latency on every beat.

- **Image**: side button "Gerar uma imagem" (Nano Banana) -> the only visible `textarea` (its placeholder ROTATES after
  the first generation — never match it by text) -> aspect popover "Proporção" -> send `button[aria-label="Criar"]`.
  ~15 s, 1376x768 at 16:9 (1024x1024 at the 1:1 default). Result = `<img src="…googleusercontent.com/gg-dl/…">`.
- **Video**: "Gerar um vídeo com IA" (Omni) -> `div[role=textbox]` -> composer chevron `Abrir` (pick it BY POSITION; a toast
  has one too) -> chip `Generation settings…` -> duration slider 3–10 s -> send `button[aria-label="Gerar"]`.
  ~33 s, 720p H.264 + AAC. Result = `<video src="…usercontent.google.com/download?…">`.
- **Typing must be real key events.** `fill()` leaves "Criar" DISABLED; click, select-all, Backspace, `keyboard.type`.
- **Results are fetched straight from the element's src** (`page.request.get`, the tab's cookies) — nothing is inserted
  into the Vids project, and no download button is needed.
- **Never click the panel's "Remover"**: it opens a modal "Remover este clipe de vídeo?" that blocks the whole editor.
  `dismissWelcome` cancels one if it is found (and closes the first-run welcome dialog).
- **The failure classifier must ignore Vids' permanent banners** ("Faça upgrade para…", "Ainda não é possível usar outros
  idiomas", "limites de geração…") — one of them ("não é possível") already produced a false positive (`STATIC_NOISE`).
- **The account HAS a quota, and it is per KIND.** Observed live 2026-09-26: after ~8 short videos the VIDEO composer answered
  "Você atingiu seu limite para gerar conteúdo no Vids." (classified `credits`, 30-min cooldown), while IMAGES still generated
  (~20 s, 1376x768) — so `VIDS_FIRST=image` is not affected and `both` degrades to Flow for video once the limit hits.
- **Reference photo (video only).** Clicking "Ingredientes" opens the native file chooser directly (`page.waitForEvent("filechooser")`
  + `setFiles`); the FIRST time, Google shows a rights notice ("Criar conteúdo com imagens no Workspace") that the OPERATOR must
  accept — the code never clicks "Concordo" and reports it as a `config` error. The attached image shows as `@Imagem1` with a
  "Remover imagem" button (aria-label; also removes its prompt chip). The prompt mentions it via Vids' own chip: type `@`, wait,
  press Enter (`prompt-chip-wrapper`). Once an ingredient exists the prompt textbox's aria-label CHANGES, so it is matched by
  `div[role=textbox][contenteditable=true]`. `syncReference` reuses the same image (hash) and ALWAYS clears it for a beat with no
  reference. Verified: the housekeeper's face/uniform carried into the clip (~30–40 s). The IMAGE panel has no reference input
  (only 7 style presets), so a reference beat rendered as a still stays on Flow.

### Per-channel character words (`channels.character_terms`)

Comma-separated words that decide which beats get the reference photo, edited in Channels and
delivered as `AI_CHARACTER_TERMS` through `channelSettingOverrides`. Empty = the built-in housekeeper
list AND the cleaning-verb first-person rule; a channel with its own words uses only those (plural
tolerant, whole-word, regex-escaped: `characterTermsRegex`). Matched against the planner's visual
description first, narration only when there is none. Prefer role/name/pronoun words; avoid bare
`man`/`person`, which pull the portrait into bystander beats.

**A second, structured signal is checked FIRST and independently: the beat's own `overlay` field,
when `overlay.type === "person"`.** Found live on a second channel (Finn, "The DIY Guy",
`character_terms = "finn stone, finn, diy guy, handyman, homeowner"`): a beat the planner had ALREADY
tagged `overlay: {type:"person", title:"Finn Stone"}` for its on-screen name card still rendered
"A friendly middle-aged man in a canvas work shirt smiling directly at the camera in a well-organized
home workshop" as its VISUAL description — no configured term anywhere in that prose, so the
text-only check never fired and the beat generated without the reference despite the planner having
already, in a different field, said exactly whose beat it was. `beatWantsCharacterReference` now
tests `overlay.title` against the same term regex before falling through to the prose checks — a
structured planner field is authoritative here for the same reason `entityProtected` prefers
planner fields over pattern-matching prose elsewhere in this file: prose is Gemini's free paraphrase
and can legitimately omit a name the planner captured cleanly somewhere else. Pinned by
`beat-character-reference.test.ts` using the real measured pair (title "Finn Stone" + that exact
generic prose) as the regression case, plus: a `person` overlay for someone ELSE doesn't fire (the
channel's words still decide who), and a non-`person` overlay type never fires even if its title
happens to share a word.

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
Added for the Nano Banana model-tier fallback: `FLOW_IMAGE_MODEL_FALLBACK` (default empty = off;
see "Image path" above), exposed on `FlowBrowserBlock.tsx` as its own select next to the fallback-
provider one — a DIFFERENT axis (which Flow model tier to retry with) from `FLOW_FALLBACK_PROVIDER`
(which OTHER provider entirely to fall to once Flow itself is exhausted).

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

## Channels — the per-channel/per-client override profile

A channel (`channels` table) is "a name + a default voice + a default avatar" (unchanged,
pre-existing) **plus** a small, deliberately narrow account-isolation profile:
**Cloudflare** (Account ID + Token), **ai33.pro** (API key + voice id), a **character
reference portrait**, and a **default AI image style**. Settings stays the app-wide
default for everything else; these five things are configured per channel instead —
"a client with their own Cloudflare/ai33 accounts and their own visual identity" is the
scenario this exists for. It was briefly a fully generic "any provider, any key, any
voice engine" system; that was more than the app needed and was scoped back down to
exactly this — see the git history if a broader version is ever wanted again, the
underlying mechanism below still supports it.

- **The mechanism is `getSetting()` itself, not N call sites.** `settings.ts` keeps an
  `AsyncLocalStorage<Record<string,string>>` (`channelSettingOverrideStore`).
  `setChannelSettingOverrides(map)` (`enterWith`, not a wrapping `.run()`) is called
  **once**, in `studio-pipeline.ts`'s `activateChannelOverrides(cfg)`, right after
  `readConfig()` resolves the run's channel — and every `getSetting(KEY)` call made
  anywhere in the rest of that run's async chain (cloudflare-image.ts, ai33-voices.ts, …)
  sees the override transparently, with **zero changes to any provider file**. `enterWith`
  (not `.run(store, fn)`) was chosen specifically so `runStudioPipeline`'s existing large
  single try/finally body didn't need restructuring. Concurrent runs never cross: each is
  its own top-level async invocation with its own promise chain, and Node's async_hooks
  isolate the store per chain — the same primitive Next.js itself uses for request-scoped
  state.
- **Called on BOTH the fresh-run and Resume paths.** Resume re-enters the pipeline
  without going through `/api/studio`, so it must re-resolve the channel and re-arm the
  overrides itself — the same reasoning as the Avatar V eligibility re-check. Unlike the
  avatar snapshot on `runs.avatar_*` (a billable choice that must replay exactly what a
  run was created with), the channel's overrides are read **live** at pipeline start: a
  key fixed on the channel AFTER a run was created still applies on that run's Resume.
  Deliberate — account config isn't a cost decision that must stay pinned.
- **ai33 is the ONLY voice provider a channel can pin, and it's never a raw selector.**
  `channels.voice_id` holds an ai33.pro voice id (`ChannelAi33VoiceField.tsx` — its own
  component, not inlined into the parent's `fields()` closure, because it calls
  `useVoiceCatalogue()`, a hook, and `fields()` is invoked a *variable* number of times per
  render: once for the create draft, plus once per channel currently being edited — a hook
  called there directly would violate the Rules of Hooks the moment the edited channel
  changes). `deriveVoiceProvider(voiceId)` (channels.ts) — `"ai33"` when non-empty, else
  `null` — is computed by the API routes, **never trusted from the client**: there is no
  `voice_provider` input anywhere in the UI. `voice_id`/`voice_provider` stay generic
  columns underneath (nothing ai33-specific about their storage or about
  `channelSettingOverrides()`), so a broader provider set is a UI change away if ever
  wanted, without touching the DB or the override plumbing.
- **`CLOUDFLARE_ACCOUNT_ID` is the one exception to "only `isSecretKey()` settings can be
  overridden."** It isn't a credential itself — no `KEY`/`TOKEN`/`SECRET` in the name — but
  Cloudflare cannot run for a channel without it sitting next to `CLOUDFLARE_API_TOKEN`.
  `channels.ts`'s `CHANNEL_EXTRA_OVERRIDE_KEYS` names it explicitly rather than loosening
  `isSecretKey()` itself, so the actual security boundary — a channel can never override an
  unrelated setting like `FFMPEG_PATH` — stays exactly as narrow as it was, with this one
  reviewed, named exception. It is also never masked in the UI (`maskedChannelApiKeys`):
  `getMaskedSettings()` doesn't mask it globally either, since it isn't sensitive.
- **`api_keys_json` is filtered through `isChannelOverridableKey()` on BOTH write and
  read** (`channels.ts`: `setChannelApiKeysJson`, `filterToSecretKeys`) — a malformed or
  hand-crafted request body can never smuggle an override for anything outside that
  allowlist onto a channel. `ChannelApiKeysField.tsx` hardcodes just the two fields
  (Cloudflare Account ID + Token, ai33 API key) rather than importing any key list from
  `settings.ts` — that module pulls in `./db` (better-sqlite3, a native Node module) and
  must never be imported from client code.
- **`character_reference_path` has its OWN setter and is deliberately absent from
  `updateChannel`'s SQL.** It is managed only by
  `/api/channels/[id]/character-reference` (GET/POST/DELETE, same contract as the
  now-removed global `/api/settings/character-reference` UI, storage under
  `DATA_DIR/channels/<id>/`), so an ordinary channel-form save — which has no field for
  it — can never blank it out. `CharacterReferenceField.tsx` was generalized with an
  `endpoint` prop (default unchanged) to serve both the global route (still functional,
  just no longer linked from the Settings UI) and the per-channel one from one component.
- **A channel's portrait is its own or NONE (2026-11-06).** A channel without
  `character_reference_path` used to inherit the global `AI_CHARACTER_REFERENCE_PATH` — which
  put one channel's presenter into another channel's video (measured: a survival-channel face
  composited into a Nineveh excavation shot on a new history channel). `channelSettingOverrides`
  now always sets the key, to `NO_CHARACTER_REFERENCE` (`"none"`, `src/lib/character-reference.ts`)
  when the channel has none. A plain `""` could not do it: an empty override deliberately falls
  through to the global value, pinned in `channel-settings-override.test.ts`. Readers must go
  through `resolveCharacterReference()` so the sentinel never reaches `fs`. The global portrait
  still applies to runs created with NO channel.
- **Never send `api_keys_json` (raw) to the browser.** Every API route returns
  `toClientChannel(channel)`, which replaces it with `api_keys` — a masked map
  (`shortMask`, the same first4…last4 convention as `getMaskedSettings()`, exported from
  `settings.ts` for exactly this reuse — except `CLOUDFLARE_ACCOUNT_ID`, see above). Saving
  back respects the same "don't-overwrite-a-mask" rule `/api/settings` already uses:
  `mergeChannelApiKeys` keeps the stored value for any SECRET field still containing `…`,
  clears the override for a field explicitly emptied, and only stores fields that changed.
- **`ai_style` (Default AI image style) needed no backend work at all** — it was already a
  channel column, already resolved at `/api/studio` create-time
  (`aiStyle: body.aiStyle ?? channel?.ai_style ?? undefined`) into `config_json`, and
  already read by the pipeline (`acquireVisual`'s `opts.aiStyle`, which `visual-source.ts`
  prefers over the global `AI_IMAGE_STYLE`). It had only been hidden from the Chaînes UI;
  re-exposing the textarea was the whole fix.
- **Removed from the global Settings page, on purpose, now that Channels owns them**:
  the Cloudflare "Primary profile" fields (Account ID + Token — the numbered backup
  profiles 2/3/4 stay global, they're operational failover, not a client credential),
  `AI_IMAGE_STYLE`, the global `CharacterReferenceField`, and `ai33` from the
  `VOICEOVER_PROVIDER` dropdown (filtered out locally in `settings/page.tsx`, not removed
  from the `VOICE_PROVIDERS` registry — `voiceProviderMeta("ai33")` etc. still have to work
  for actual generation). None of the underlying `SETTING_KEYS`/`DEFAULTS` were removed:
  an install that already had a global Cloudflare/ai33/style/reference value keeps reading
  it (same "a settings key with no form field is normal" convention used throughout this
  app), it's just no longer editable from Settings — only from a channel.

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

### Voicebox (local, free) — added 2026-10-05

`VOICEOVER_PROVIDER=voicebox` narrates through the operator's own **Voicebox** app
(github.com/jamiepine/voicebox — open-source voice cloning running on their machine).
Contract read from Voicebox's backend source (`backend/routes/*.py`), not live-probed here:
`POST /generate` queues and returns `{id, status:"generating"}` → poll `GET /history/{id}`
(`loading_model`/`generating` → `completed`|`failed`) → `GET /audio/{id}` serves **WAV**.

- **No key, no cost, nothing metered.** It's the one voice provider with `apiKey: ""`;
  `ProviderVoiceFields` hides the key field for it, and the registry tests skip the
  key checks for it. Only setting besides the voice: `VOICEBOX_URL` (blank =
  `http://127.0.0.1:17493`). It is deliberately absent from `COST_PROVIDERS`.
- **The voice id is a Voicebox PROFILE id.** The profile decides the engine (Qwen /
  Chatterbox / …) and its language is sent with the request — there is no
  `VOICEBOX_ENGINE` setting, for the same second-source-of-truth reason as ai33.
- **The WAV is transcoded to MP3** (libmp3lame 192k/44.1 kHz) at `outPath`: chunk concat
  stream-copies MP3 and the master must be `voiceover.mp3`.
- Generation is local GPU/CPU and can be slow; the poll deadline is 45 min per chunk.
  The Voicebox app must be open during the voiceover step — an unreachable server says so.
- Covered by `voicebox.test.ts` (a fake server speaking the contract + real ffmpeg).

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

## Studio run wall-time — what a "16-minute video took 2 hours" actually breaks down to

Diagnosed 2026-09-27 against a real 174-beat run (`d5d1a47b`, 1025s/~17min output, 2h13m
wall clock). Three independent causes, not one:

1. **`VIDS_PROJECT_URL` was blank, so Vids never contributed.** `services/vids-browser.ts`
   failed at beat 2 ("Open a Google Vids project…") and was marked spent for the rest of
   the run — every AI beat after that went through Flow's ONE serialized queue alone. With
   `mode=mix, real=30%` that's ~122 of 174 beats through a single tab at ~20–40s each ≈ the
   dominant share of the run. **Fix (operator action, not code): open a real Vids project
   once in the Flow Chrome window and set `VIDS_PROJECT_URL` to it.** With `VIDS_FIRST=both`
   this turns one serialized AI lane into two parallel ones.
2. **kie.ai ran out of credit mid-run (`402: Credits insufficient`), and it is the ONLY
   fallback for character-reference beats.** `FLOW_FALLBACK_PROVIDER=chain` was already
   configured and DID work exactly as designed for the two ordinary stills in this batch
   (beat 151 recovered via Cloudflare/FLUX.2, beat 152 via Pollinations) — but 6 of the 8
   beats that hit this were the housekeeper (`character reference active`), and per design
   (see "Failure handling…" above) a character-reference beat skips the cheap chain
   entirely and goes straight to kie.ai's Nano Banana Edit. With kie.ai empty, those 6 beats
   (149,154,155,158,171,172) had no fallback left and fell to neighbour reuse. **Fix
   (operator action): keep kie.ai funded** — the chain setting is already doing its job for
   everything it's allowed to touch.
3. **The final assembly pass (`assembleStudioVideo` in `studio-assemble.ts`) rendered its
   174 per-beat clips in a plain sequential `for` loop** — one `spawnSync` ffmpeg process at
   a time, on a 10-core machine. Measured: ~27 minutes for this run's compositing step alone,
   almost entirely idle CPU. **Fixed in code (2026-09-27):** the loop is now a `pLimit`-bounded
   concurrent pass (`runFfmpegAsync` via `spawn`, not `spawnSync`, so the event loop stays free
   while several ffmpeg processes run at once). Reuses the **existing** `ASSEMBLE_CONCURRENCY`
   setting (already on Settings, previously only read by the legacy `video-assemble.ts`
   pipeline) rather than adding a second concurrency knob — one setting now governs both
   assemblers. Order is preserved by construction: each beat's clip is written into a
   FIXED array slot by its own index, and the concat list is rebuilt by iterating that
   array 0..N afterward — never by push-order, which would scramble under concurrent
   completion. Pinned by `studio-assemble-parallel.test.ts` (real ffmpeg, a deliberately
   broken beat mixed in to confirm the filler fallback still fires positionally correctly).
4. **The presubmit stall on Flow's video path** (a step before the Veo prompt is even sent —
   mode switch, ratio, duration, reference attach — hanging with no error and no timeout)
   cost this specific run one full cancel/resume cycle (~10 min of dead time + operator
   attention). Already fixed separately (`FLOW_PRESUBMIT_STEP_MS` = 90s deadline per step,
   `flow-browser.ts`) — a stall now degrades the beat to a Flow image instead of hanging the
   whole Flow queue.

None of these four fixes are additive shortcuts on each other — (1) and (2) are operator
config, (3) and (4) are code, and all four were independently necessary to explain the 2h13m:
even with the assembly pass at full speed, a single dead Flow lane (1) plus a mid-run kie.ai
outage (2) would still have made this run slow and partially degraded.

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

## Manual AI generation (`AI_PROVIDER=manual`) — added 2026-09-30

For an operator whose target account can only be reached by hand — e.g. a second Flow account
logged into an anti-detect-browser profile (GinsBrowser/DICloak) whose vendor charges $28.80/mo
extra (the "Plus" tier) just for local CDP/API automation access, confirmed against DICloak's
own pricing page. Rather than pay for that or risk the account by moving its login into the
app's own automation Chrome (defeats the point of an isolated fingerprint profile), the operator
pastes prompts into the account themselves and hands the resulting files back to the pipeline.

- **No generation API is called at all.** A beat routed here (`services/manual-pending.ts`)
  first checks `<runDir>/manual/` for a file already named `beat_XXXX.<ext>` (any extension —
  never assumed, since an operator's download could be .png/.jpg or .mp4/.mov/.webm). Found: an
  image goes through Ken Burns exactly like any other AI still (`provider: "manual:image"`); a
  video is copied through as-is, unmodified — no re-encoding here, same reasoning as every other
  video source (the beat compositor's `renderBeat` already re-encodes every beat visual to the
  project's exact frame count, `-an` always strips audio). Not found: the beat's prompt (built
  from the SAME `buildPrompt` every other AI provider uses, so wording is never a second,
  drifted copy) is appended to `<runDir>/manual-prompts.txt`, and `ManualGenerationPendingError`
  is thrown.
- **Never reused from a neighbour, never silently degrades the video.** `studio-pipeline.ts`
  recognizes that error specially in both `runStudioPipeline` and `resumeStudioPipeline`'s
  per-beat catch (both the b-roll attempt and the avatar-beat's b-roll-degrade fallback): the
  beat's index is collected into `manualPendingBeats` instead of falling into the ordinary
  "will reuse a neighbour" path. Every OTHER beat still proceeds completely normally — real
  footage, avatar clips, other AI providers — only the ones actually needing manual input wait.
- **The run pauses, it doesn't half-finish.** Once every beat that COULD proceed has, if
  `manualPendingBeats` is non-empty the pipeline calls `pauseRunForOperator` (the exact same
  mechanism a kie.ai credit exhaustion already uses — see Cost Monitoring above) naming the
  prompts file and the folder to drop files into, then `checkCancelled(runId)` to unwind through
  the identical clean-stop path a user-initiated Stop uses. This runs BEFORE the neighbour
  carry-over loop and BEFORE `assembleStudioVideo`, so a pending beat is never patched with a
  duplicate visual or shipped inside a video marked "done". Resume re-enters the SAME per-beat
  check, which now finds the operator's files (or re-writes the prompt again, harmlessly — see
  below — if some are still missing) and only regenerates what's still absent.
- **The prompts file never accumulates duplicates across retries/resumes.** `appendManualPrompt`
  checks for the beat's own `===== Beat NNNN (...) =====` header before writing, so a beat
  re-attempted on a later Resume (because the operator hadn't gotten to it yet) does not grow
  the file with the same prompt over and over.
- **Registered as a normal `AiProviderId`** (`providers.ts`) with no `image`/`video` model
  catalog and no `apiKey` — `ProviderModelFields`/`ProviderAiFields` already render nothing for
  a provider missing those (capability-driven, no dead fields), so selecting "Manual" in
  Settings shows no irrelevant model-picker or API-key box.
- Covered by `manual-pending.test.ts` (the pure file/prompt-file helpers) and
  `visual-source-manual.test.ts` (the `acquireAi` branch: pending-then-throw, image-found,
  video-found, and that a video-pinned beat's prompt is labelled `video` not `image`). The
  pause/never-reuse behavior in `studio-pipeline.ts` itself is not unit-tested — that file has
  no test suite at all (too integration-heavy; every other guarantee there is verified by
  running real end-to-end video pipelines, per this file's own "Verified" sections).

## GPT + LTX (`AI_PROVIDER=ltx`) — stills generate automatically, GPU video stays gated (2026-10-07)

The "ltx" provider renders b-roll two ways: stills via the exclusive Codex/GPT account
(`src/lib/services/codex-image-*.ts`), motion clips via a rented GPU running LTX
(`workers/ltx-pod`, `services/ltx/session.ts`). Both used to pause the run for an explicit
operator approval — `GptLtxBatch.tsx`'s "Preparar lote" / "Autorizo gerar..." checkbox — the
same pattern as `AI_PROVIDER=manual`. **The image half no longer does.**

- **Why the split.** A GPU round spends real Runpod dollars, budget-capped and guardian-
  watched for exactly that reason (see the GPU section above). A still only spends the
  operator's own Codex **plan quota** — there is no runaway-cost scenario a pause protects
  against, and the operator asked for it to "just follow the planner's own prompt, in the
  background." Video keeps its authorization gate unchanged; only stills changed.
- **Notebook GPU import (Colab/Kaggle).** `/tools/ltx-scene-test` also accepts a manually
  downloaded MP4 for a selected pending video scene (`/api/tools/ltx-scenes/import`).
  The upload is streamed with a 256 MiB cap, checked by ffprobe and decoded by FFmpeg,
  then attached to the scene fingerprint. Imported results are marked
  `source: "notebook-upload"` and do not pretend that the RunPod guardian stopped an
  external GPU. No notebook API, tunnel, automatic generation, or fallback is involved;
  a ready scene requires explicit confirmation before its clip can be replaced.
- **Live notebook GPU (2026-10-26).** A Colab/Kaggle notebook (`workers/ltx-notebook`)
  can also be CONNECTED: ComfyUI on the notebook's loopback, `conveyer_proxy.py` (bearer
  token, six whitelisted routes) in front, a trycloudflare tunnel. `/api/tools/ltx-notebook`
  stores `{baseUrl, token}` in `<DATA_DIR>/ltx-session/notebook.json` (`services/ltx/notebook.ts`).
  While connected, `visual-source.ts`'s video branch generates a pending scene inline
  (start frame via GPT, then `animateLtxScene` through `notebookTransport`, serialized
  process-wide) instead of pausing; any failure still pauses. No guardian/stop: nothing is
  billed per hour by us, so `stopAndVerify` is `true` and results carry
  `source: "notebook-remote"`. Without the sol-attn node the graph drops only `sol`
  (`buildLtxWorkflow(..., { sparseAttention: false })`). The `.ipynb` is GENERATED by
  `build_notebook.py` (embeds the proxy + models.json); `notebook-build.test.ts` fails when
  stale. Verified only against a fake ComfyUI through the real proxy — never on a real GPU.
  **`lite` profile** for the 16 GB T4 (the only GPU a free Colab account gets):
  `workflow-lite.json` (LTX-Video 2B distilled 0.9.8 + T5 fp8, core nodes only, 832x480x121)
  + `models-lite.json` (per-file repo/revision/sha256). The notebook picks `full` at >= 40 GB
  VRAM, else `lite`; the proxy reports it in `/conveyer/health`, the session stores
  `profile`, and `finalizeLtxClip(..., "lite")` scales-to-cover + crops to 1080p (never
  stretches). The lite graph passed pinned ComfyUI 0.37.1's own `/prompt` validation
  (CPU, empty model files); actual generation quality on a T4 is unverified.
- **`services/ltx/auto-image.ts`** (`generateLtxImageAutomatically`) drives the SAME job
  machinery the manual batch UI used — `prepareImageJob` → `reserveImageJob(..., confirmed:
  true)` → `executeImageJob` — but calls it inline, awaited, with the reservation
  auto-confirmed instead of waiting for a checkbox. A job left `generating`/`needs-recovery`
  by an earlier crashed attempt is recovered (never resubmitted); a job left `reserved` is
  executed, never re-reserved — same idempotent job ids as the manual path, so Resume finds
  and continues the SAME job rather than starting a fresh one.
  `visual-source.ts`'s `provider === "ltx"` branch now forks on `media`: `"video"` keeps the
  exact original try/catch (any failure → `LtxGenerationPendingError` → run-wide pause,
  via `/tools/ltx-scene-test`); `"image"` calls `generateLtxImageAutomatically` the moment
  `acquireLtxScene` reports pending, and ANY failure there (quota, a bad generation, a local
  resize error) is now an **ordinary beat failure** — it falls through to the normal
  neighbour-reuse path, never a pause. There is no human step left for a pause to wait on.
- **This also fixes a real data-loss bug, as a side effect.** The old flow required
  re-clicking "Atualizar lote" to see new pending scenes, which called `prepareImageJob`
  again for every not-yet-ready scene — and because a job's id is a hash of
  `{beat, description, model}`, if anything about the scene's stored identity had drifted
  between clicks (observed live: beats re-planned with slightly different values across a
  Resume), the re-prepare silently created a FRESH job under a new id, orphaning whatever the
  old job had already generated (confirmed on a real run: 23 completed Codex images, 0
  applicable to any current scene). With no separate "prepare" click in the automatic path —
  generation happens inline, once, inside the same `acquireAi` call that computed the
  identity — that drift window no longer exists.
- **The manual batch UI (`GptLtxBatch.tsx`, `/api/tools/ltx-image-batch`) was deliberately
  left in place**, not removed: it's still a working manual override/recovery tool, and its
  visibility condition on the run page (`logs.some(m => m.includes("aguardando LTX"))`)
  already degrades correctly on its own — that log line is now only ever written for a
  video/GPU scene, so the card naturally stops appearing for an all-stills run without any
  change to `page.tsx`.
- Covered by `services/ltx/auto-image.test.ts` (prepare→reserve→execute end to end; a
  `reserved`-but-uncompleted job is executed, never re-reserved; a `generating` job is
  recovered via its existing thread, never resubmitted; a failure surfaces without writing a
  completed result) and `visual-source-ltx.test.ts` (video beats still pause unchanged; a
  missing image generates automatically with no approval; a failed auto-generation — and a
  failed local still-render after a successful generation — are both ordinary, non-pending
  failures; a video beat never touches the image auto-generator at all).

## Graphic beats (2026-10-29)

The motion-graphics layer of `docs/SPEC-motion-graphics.md`: nine phase-1 templates
(`product_hero`, `spec_callouts`, `kinetic_quote`, `impact_bars`, `counter`, `versus`,
`checklist_card`, `polaroids`, `timeline`), previewed at `/tools/graphic-preview`, planned and
rendered inside studio runs.

### In a run

- **Off unless asked.** Channel checkbox (`channels.graphics_enabled` '1'/'0', NULL = global
  `GRAPHICS_ENABLED`, default "0") + % slider + theme. `/api/studio` adds `graphics:
  {percent, theme}` to `config_json` ONLY when on (`resolveChannelGraphics`), so every other
  run has a byte-identical config and plan — pinned by `graphic-plan.test.ts` (the ordinary
  planner prompts are identical with and without the pass). The channel form sends its graphics
  fields only once touched, so a save never turns NULL ("follow global") into an explicit off.
- **On → the avatar is off for the run** (spec 3.4: `avatarPercent` passed as 0).
- **The pass runs LAST in `planBeats`** (`graphic-plan.ts`), on the finished plan: one Gemini
  call per 40 beats returns `{index, through, template, data}`; then, deterministically: zod
  validation (invalid → the beat stays b-roll), merge of following beats up to
  `GRAPHIC_MAX_SEC` (20) / `GRAPHIC_LIST_MAX_SEC` (45, list templates) on beat boundaries, no
  template twice in a row, graphic screen time capped at percent + 10. Merging reindexes beats,
  which is why nothing before it may see a graphic.
- **A graphic beat keeps its first beat's b-roll fields** (visualQuery, aiPrompt, source). That
  IS the fallback: any render failure flips `layout` to "broll" in the pipeline
  (`graphicVisual`) and the ordinary visual path fills it — never a run failure, never a
  second planner call. Graphic clips live in `<runDir>/graphics/`; Resume reuses intact ones and
  reads `words.json` for cue timing. Neighbour carry-over never borrows a graphic (it would put
  another beat's words on screen), and graphic beats are left out of the real/AI source ratio log.
- **Clip length = the compositor's own rounding** (`graphicBeatFrames` ≡ `beatFrames`). One
  frame short and the compositor's `-stream_loop` would flash the first frame at the end.
- **Products: the planner writes `product:<name>`** and `product-cutout.ts` resolves it before
  rendering: free photo search (wigolo/Openverse/Pixabay images via `searchStillPhotos`) →
  background removed by a sharp flood fill from the border (only works on a light, plain ground,
  which is what the query asks for; anything else is skipped, not half-cut) → Gemini confirms it
  is that product → cached at `<DATA_DIR>/products/<slug>.png`. No ML model: the spec's options
  were @imgly (AGPL, ~130 MB) and rembg (no wheels for this Python). Not built yet: generating
  the product with the AI provider when no photo works — such a beat falls back to b-roll.
- **First real run (2026-10-29, 35 s, 6 beats): 52% graphic time vs a 65% target.** Two
  cut-out defects it exposed, both fixed: (1) a shop photo kept its grey display plate and a
  printed "MINI MAGLITE 2AA" logo — small separate islands (< 12% of the largest) are now
  dropped, and the judge must also say `isolated` (no surface, reflection, packaging, text);
  (2) a flashlight photographed standing up rendered ~100 px wide — the judge flags
  `upright_long_object` and a clearly portrait (h/w ≥ 1.8) long tool is laid flat. The cache
  file name carries `CACHE_VERSION` so cut-outs made under older rules are not reused.
- **A failed b-roll beat in a graphics run still reuses a neighbour**, exactly as in any run —
  the repeated shot in that first run was a real beat routed to AI with the AI provider
  unconfigured. Not graphic-specific; not changed.
- Still unmeasured: a 15-min render time, and the 55–75% acceptance band on a full script.

- **`stamp` is a layer, not a template** (spec #10): `data.stamp` (a string or `{text, cueWord}`)
  on `product_hero`, `spec_callouts` and `checklist_card`, drawn by `GR.stamp`. Shared pieces
  live in `runtime.js` (`GR.product` = cut-out + floor shadow + float, `GR.odometer`) so the
  templates cannot drift on them.
- **One animation per element per property.** Two WAAPI animations on the same property fight:
  the later one's backwards fill holds its first keyframe from t=0 and silently erases the
  earlier one (an entry fade simply vanishes). Enter-hold-leave is ONE animation with keyframe
  offsets (see spec_callouts' dimming, versus' VS seal), or the second effect goes on a wrapper.
- **Fit loops must measure the content, not a fixed-size container** — impact_bars first shrank
  every line to the minimum because it measured its 1080 px flex box.
- Sample images for the preview: `sample:flashlight`, `sample:knife`, `sample:phone`
  (`src/graphics/samples/*.svg`). `image` is resolved at any depth (versus sides, polaroids).

- **A template is an HTML page** (`src/graphics/templates/<key>.html`) on a fixed 1920×1080
  `#stage` that `runtime.js` scales to the output size. `window.__setup(data, theme, words,
  {durationMs})` builds it; `window.__seek(ms)` poses it. Every animation is a PAUSED Web
  Animation whose `currentTime` is set by seek, or an `onSeek(ms)` function — no clock, no
  `setTimeout`, no `Math.random`. Paper noise is `feTurbulence` with a fixed seed for the same reason.
- **Determinism is pinned by test**: the same frame renders byte-identically twice, and a frame
  reached by seeking forward equals a fresh render at that time. Going backward can differ by
  1/255 on a few pixels (compositor caching of rotated/transformed layers) — invisible after
  H.264, so that check uses a ≤ 2/255 tolerance. Anything driven per frame that must be exact
  (the kinetic_quote progress bar) animates `width`, not `scaleX`, for this reason.
- **Data is validated by zod before a browser opens** (`graphic-templates.ts`, `.strict()`).
  Templates write text with `textContent` only, so the schema is the one gate.
- **Fonts are bundled** (`src/graphics/fonts`, OFL: Oswald, EB Garamond Italic, JetBrains Mono)
  and loaded via `@font-face`; `__setup` awaits them before measuring/fitting text.
- **Chromium is Playwright's bundled headless shell, launched** — never the operator's Flow
  Chrome. One browser per process (`globalThis.__facelessGraphicRenderer`),
  `GRAPHIC_RENDER_CONCURRENCY` pages (default 2, DB/API-only key).
- **Capture is CDP `Page.captureScreenshot` with `optimizeForSpeed`, not `page.screenshot()`.**
  Measured at 1080p: Playwright's PNG encoder ~400 ms/frame, CDP fast PNG ~80 ms (still
  lossless). A 6 s clip went from ~80 s to ~25 s end to end. Frames are piped to ffmpeg
  (`image2pipe` → libx264 crf 16, yuv420p, `-an`) with `-frames:v` = round(duration × 30).
- `cueWord` timing (spec 3.3) lives in `runtime.js` (`scheduleEntries`, `cueStart`), and
  `kinetic_quote` types each word while it is spoken (`typingSchedule`). Those pure helpers are
  exported through `module.exports` and unit-tested in node.
- The preview's word timings are synthetic (narration spread evenly over the clip), and its
  product image is a placeholder SVG (`sample:flashlight`) or an uploaded PNG — the cutout
  service (spec 3.5) does not exist yet.

## Archive edit style (`channels.edit_style = "archive"`, 2026-10-29)

The historical-documentary look (reference: a royal-history channel — period paintings,
engravings, archive photos, slow moves, dissolves, sparse slab-serif cards). One channel field
turns it on; `channelSettingOverrides()` then applies `ARCHIVE_STYLE_OVERRIDES` (channels.ts)
through the normal per-run getSetting() override store, so no call site knows about channels.

- **Ken Burns** (`ken-burns.ts`): `KEN_BURNS_RANGE` (archive 0.06; default 0.18 = unchanged) and
  `KEN_BURNS_MOTION=varied` → per-beat cycle in / out / tilt-up / pan (`variedMotion`), plus a
  top-biased cover crop for portrait sources (keeps the face). Needs the beat index, so
  `animateStill` forwards `beatIndex` — omitted, the kenBurns call is byte-identical (pinned by
  still-animator.test.ts).
- **Crossfade** (`SCENE_TRANSITIONS=crossfade`, `SCENE_TRANSITION_MS`): length-neutral like the
  dip. Stills are rendered `crossfadeTailSec()` longer; each full-screen b-roll beat's own encode
  dissolves in from the previous beat's source trimmed at that beat's end (xfade offset 0), so the
  concat stays a stream copy and sync is untouched. Avatar/split beats never dissolve. It is a
  STYLE, so it ignores the per-run dip-to-black checkbox.
- **Cards** (`overlay-themes.ts`): archive-label (date/person/title: bottom-left slab on a dark
  box), archive-statement (quote: centred, no box, shadow — new `center` placement),
  archive-callout (fact: yellow on dark, bottom-centre). Font chain starts at Rockwell (ships with
  macOS). `buildOverlayPlan(…, editStyle)` picks them; overlays must still be ticked per run.
- **Planner** (`buildPlanPrompt(…, editStyle)`): archive swaps the PHOTOREALISTIC ai_prompt rule
  for a period-authentic one (painting/engraving before ~1850, vintage photo 1850–1950), adds an
  archive-catalogue search rule and the archive card rules. Default "" → byte-identical prompt.
- **Museum sources** (`visual-source.ts`): `met`, `artic`, `loc` (no key, public-domain stills),
  same weight tier as wikimedia. NOT yet verified against the live APIs (built from their
  documented response shapes; the dev sandbox could not reach them).
- **Anchor images** (`anchor-images.ts`, `channels.anchor_dir` → `ANCHOR_IMAGES_DIR`): the
  protagonist's own photos, placed deterministically on beats matching `ANCHOR_TERMS` /
  `AI_CHARACTER_TERMS`, ≥ `ANCHOR_MIN_GAP_SEC` apart, always on the last eligible beat. Rendered
  before any search; Resume reuses intact clips.
- Preset also sets `REAL_MEDIA`/`KIE_AI_MEDIA`/`FALLBACK_AI_MEDIA=image` (stills only) and
  `BEAT_MAX_SEC=18` (longer holds; the channel's interval sets the target).
- Tests: `archive-style.test.ts`.

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
