# Faceless Video Generator — design & API notes

Faceless Video Generator is a fork of **Conveyer Grok – Bullnet 2.0**. It turns a pasted
script into an **avatar-fronted documentary YouTube video**:

1. The operator pastes a script and picks a saved **avatar** (an ultra-realistic
   recurring presenter created once from a reference photo + name).
2. **ElevenLabs** narrates the full script.
3. **HeyGen** generates a talking-head video of the chosen avatar, lip-synced to
   the ElevenLabs voiceover.
4. The narration is split into timed **beats**; each beat is shown as the avatar
   full-screen, a split (avatar + visual), or full-screen B-roll.
5. B-roll is **AI-generated**, **real footage/stills sourced from the internet**,
   or a **mix** (operator's choice). Still images get a gradual **Ken Burns**
   zoom. Time-per-visual is adjustable.
6. FFmpeg composites everything over the voiceover → final MP4.

This is the **goal**: reproduce the style of the reference video
`https://www.youtube.com/watch?v=dg6C7p6ASig` (ultra-realistic, recurring
presenter, real internet footage).

> The base "avatar mode" only *accepted a finished HeyGen MP4*. The new flow
> **creates the avatar and generates the talking-head itself** — that's the new
> work, plus the avatar library, the broader real-footage search, Ken Burns on
> stills, and the script→ElevenLabs→HeyGen orchestration.

---

## HeyGen API — confirmed facts (research 2026-06-08)

Auth header on every call: `X-Api-Key: <HEYGEN_API_KEY>` (case-insensitive).
Two API generations coexist; **v1/v2 is fully supported through 2026-10-31** and
matches the `character`/`voice`/`video_inputs` shape — we build on v1/v2.

### Asset upload (raw binary, NOT multipart)
- `POST https://upload.heygen.com/v1/asset`
- Headers: `X-Api-Key`, `Content-Type: image/jpeg` | `image/png` | `audio/mpeg`
- Body: raw file bytes.
- Response: `{ "code":100, "data": { "id":"...", "image_key":"image/<hash>/original", "url":"...", "file_type":"image|audio" } }`
- **For creating a Photo Avatar Group use `data.image_key`, not `data.id`** (per HeyGen admin). For audio, use `data.id` as `audio_asset_id`.

### Avatar creation — two paths

**(A) Talking Photo — simplest, no training. DEFAULT.**
- `POST https://upload.heygen.com/v1/talking_photo` (raw image bytes, `Content-Type: image/jpeg`)
- Response: `{ "code":100, "data": { "talking_photo_id":"...", "talking_photo_url":"..." } }`
- Use `talking_photo_id` directly as a video character. A freshly uploaded photo
  may need a short moderation delay before it can generate.

**(B) Photo Avatar Group — trained, multi-look, most "consistent". OPTIONAL.**
- Create: `POST https://api.heygen.com/v2/photo_avatar/avatar_group/create` body `{ "name", "image_key" }` → `{ "data": { "id" (group_id), "image_url" } }`.
- Train: `POST https://api.heygen.com/v2/photo_avatar/train` body `{ "group_id" }`. (train-status path UNCONFIRMED — verify live.)
- The trained **look id** is what you pass as `avatar_id`.

### Video generation — drive avatar with our ElevenLabs MP3
- `POST https://api.heygen.com/v2/video/generate`
```json
{
  "video_inputs": [{
    "character": { "type": "talking_photo", "talking_photo_id": "...", "scale": 1.0, "talking_photo_style": "square" },
    "voice":     { "type": "audio", "audio_asset_id": "<asset id from upload>" },
    "background": { "type": "color", "value": "#101418" }
  }],
  "dimension": { "width": 1920, "height": 1080 },
  "test": false,
  "title": "..."
}
```
- For a Photo-Avatar-Group look use `character: { "type":"avatar", "avatar_id":"<look id>", "avatar_style":"normal" }`.
- For HeyGen TTS instead of our audio: `voice: { "type":"text", "input_text":"...", "voice_id":"..." }`.
- Optional `"use_avatar_iv_model": true` applies the higher-realism Avatar IV engine to a talking_photo.
- Response: `{ "error":null, "data": { "video_id":"..." } }`.

### Avatar IV (highest realism, single photo) — separate endpoint
- `POST https://api.heygen.com/v2/video/av4/generate` body `{ image_key, video_title, script, voice_id, custom_motion_prompt?, enhance_custom_motion_prompt? }` → `video_id`.
- Audio-driven AV4 supported in product; exact external-audio field name UNCONFIRMED — verify before using audio with av4.

### Poll status
- `GET https://api.heygen.com/v1/video_status.get?video_id=<id>`
- Response: `{ "code":100, "data": { "id","status","video_url","thumbnail_url","gif_url","error","duration" }, "message":"Success" }`
- status: `pending → processing → completed | failed`. On `completed`, `data.video_url` is a **time-limited** MP4 URL — download immediately.

### Credits / cost
- Avatar IV: 3 s = 1 credit; API ≈ $4/min @1080p, $5/min @4K; custom-motion-prompt 2:1.
- Plain talking-photo/avatar generation cost not published — check dashboard.

**Design choice:** default avatar engine = **Talking Photo** (upload → id, no
training) with optional `use_avatar_iv_model`. Photo Avatar Group is an
opt-in "trained" mode. The avatar's text *description* is our metadata (HeyGen
builds from the image); it can feed `custom_motion_prompt`.

---

## ElevenLabs voiceover (confirmed 2026-06-08)

- Standard: `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`, header `xi-api-key`, body `{ text, model_id, voice_settings:{stability,similarity_boost,style,use_speaker_boost,speed} }` → raw MP3 bytes.
- **With timestamps (preferred):** `POST /v1/text-to-speech/{voice_id}/with-timestamps` → JSON `{ audio_base64, alignment:{ characters[], character_start_times_seconds[], character_end_times_seconds[] }, normalized_alignment }`. Use `alignment` (matches the input text verbatim). Group non-space chars → words (a word = first char start … last char end). **No separate Whisper pass needed.**
- Models: `eleven_multilingual_v2` (10k char/req, best quality — default) or `eleven_flash_v2_5` (40k char/req, cheapest/fastest). Both support timestamps. Chunk long scripts and offset each chunk's timings by the cumulative audio duration.
- List voices: `GET https://api.elevenlabs.io/v2/voices` → `voices[].voice_id`, `.name`.

## Real-footage sources (confirmed)

Default safe stack (licensed/CC, on by default): **Pexels** (already built) + **Pixabay** + **Openverse** + **Wikimedia Commons**. Each result is downloaded locally (never hotlinked) and attribution stored.

- **Pixabay images:** `GET https://pixabay.com/api/?key=&q=&image_type=photo&orientation=horizontal&safesearch=true&per_page=50` → `hits[].largeImageURL` (1280px). **Videos:** `GET https://pixabay.com/api/videos/?key=&q=&video_type=film&...` → `hits[].videos.large.url` (1920×1080, fallback `.medium`). License: free commercial, no attribution; MUST cache 24h, don't hotlink.
- **Openverse images:** `GET https://api.openverse.org/v1/images/?q=&license=pdm,cc0,by,by-sa&license_type=commercial,modification&page_size=20` → `results[].url`, `.license`, `.attribution`. Anonymous works (throttled); optional OAuth token for higher tier. Exclude `nd` (Ken Burns is a derivative) and `nc` if monetized; emit `attribution`.
- **Wikimedia Commons:** `GET https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1920` → `pages[].imageinfo[0].thumburl` (1920px) + `.extmetadata.License/Artist`. Send a descriptive `User-Agent`; ≤~1 req/s. Mostly CC-BY-SA / PD.
- **yt-dlp (OPTIONAL power stack, OFF by default, behind a blocking copyright/ToS warning):** search `yt-dlp "ytsearch10:QUERY" --dump-json --flat-playlist`; segment `yt-dlp --download-sections "*START-END" --force-keyframes-at-cuts -f "bv*[height<=1080]+ba/b" --merge-output-format mp4 URL`. Reusing YouTube content is legally risky — user picks each clip manually, provenance logged.

## Ken Burns (still → motion clip, 1920×1080@30) — confirmed recipe

Pre-upscale large to kill zoompan integer-rounding jitter:
- Zoom-in: `-loop 1 -framerate 30 -i still.jpg -t N -filter_complex "scale=8000:-1,zoompan=z='min(zoom+0.0015,1.5)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=N*30:s=1920x1080:fps=30,format=yuv420p" -c:v libx264 -preset slow -crf 18 -r 30 -t N out.mp4`
- Zoom-out: `z='if(eq(on,1),1.5,max(zoom-0.0015,1.0))'`. `format=yuv420p` mandatory.

## Reference style — IMPORTANT finding

`dg6C7p6ASig` = **"Elias Yoder" (@EliasYoderAmish)** — a **faceless Amish/frugal-living AI-narration** channel, NOT an on-camera-presenter documentary. So the avatar appears only **occasionally** (matches the brief: "occasionally in the narration"). Recommended defaults to match the style:
- avatar on screen ≈ **15%** of beats (intro + sparse anchors); rest is full b-roll/split.
- real : AI b-roll ≈ **80 : 20**.
- **~4.5 s per visual** (3 s on hooks, up to 6 s on demos).
- Ken Burns on all stills; mostly **hard cuts**, occasional ~250 ms crossfade.
- 1920×1080 / 30 fps; calm narration ~150 wpm, ~0.4 s pause after sentences.

---

## Faceless Video Generator pipeline (new — `studio-pipeline.ts`)

```
script + chosen avatar + visual mode (ai|real|mix) + seconds-per-visual + avatar %  ->
 1. ElevenLabs synthesizes the whole script -> voiceover.mp3 + word timestamps (alignment)
 2. Beats: group words into ~seconds-per-visual chunks (respect sentence ends) -> timed beats
 3. Gemini plans each beat: layout avatar|broll|split + a short visual query; ~avatar% beats = avatar
 4. Source per visual beat: real (Pexels/Pixabay/Openverse/Wikimedia) or AI (69labs/image), per ai/real ratio
        - stills -> Ken Burns clip; videos -> trim/scale to 1920x1080/30
 5. HeyGen generates ONE talking-head clip of the avatar over the FULL voiceover (lip-synced)
        - avatar beats show the HeyGen clip; split shows HeyGen (one side) + b-roll; broll shows b-roll
 6. Composite all beats over the single ElevenLabs voiceover -> final.mp4
```
The avatar is generated PER avatar-beat (only ~15% of beats), driven by that
beat's audio slice — cheaper than rendering the avatar over the whole script.

---

## UI direction (operator's mockup — "Faceless Video Generator", French)

Per the operator's mockup, the UI is a French top-nav app: **Créer une vidéo /
Avatars / Chaînes / Jobs / Paramètres** (`_topnav.tsx`, replacing the sidebar).
- **Créer une vidéo** (`/`) — script + chaîne + avatar + mode visuel + intervalle.
- **Avatars** (`/avatars`) — create from a reference photo **OR a text description**
  (nano-banana generates the image), optional channel link, status grid.
- **Chaînes** (`/chaines`) — simple defaults bundle: nom, mode visuel, style images
  IA, intervalle (s), format. Table `channels` + `channels.ts` + `/api/channels`.
- **Jobs** (`/jobs`) — recent runs with status + mode + mp4 download / Suivre.
- **Paramètres** (`/parametres`) — API keys (ElevenLabs, kie.ai, HeyGen, Pexels,
  Pixabay) with **"Charger les voix"** loaders (`/api/voices/elevenlabs`,
  `/api/voices/heygen`) + a small "Avancé" block (provider toggle, Gemini, 69labs, style).

The legacy English pages (`/runs`, `/library`, `/prompts`, `/settings`, `/advanced`,
`/avatar`) remain reachable by URL but are off the main nav.

## AI provider — kie.ai (default), 69labs, and Magnific AI (all supported)

`AI_PROVIDER` setting (`kie` | `69labs` | `magnific`). kie.ai (`services/kie.ts`):
- **nano-banana** (image) via the Jobs API: `POST /api/v1/jobs/createTask`
  `{ model:"google/nano-banana", input:{ prompt, output_format, aspect_ratio } }`
  → taskId; poll `GET /api/v1/jobs/recordInfo?taskId=` → `data.state` +
  `JSON.parse(data.resultJson).resultUrls[0]`.
- **Veo** (video) via dedicated API: `POST /api/v1/veo/generate`
  `{ prompt, model:"veo3_fast", generationType:"TEXT_2_VIDEO", aspect_ratio, duration, resolution }`
  → taskId; poll `GET /api/v1/veo/record-info?taskId=` → `data.successFlag` (1=ok) +
  `data.response.resultUrls[0]`. Auth `Authorization: Bearer KIE_API_KEY`.
- AI b-roll: `KIE_AI_MEDIA=image` → nano-banana + Ken Burns (cheap, default);
  `=video` → Veo (more realistic — likely how the reference avoids the "stock look"
  the operator flagged). 69labs/Grok remains the alternative engine.
- Text→image avatar reuses nano-banana (`generateAvatarImage`) inside `ingestAvatar`.

### Magnific AI (`services/magnific.ts`)

One MORE AI b-roll backend — it never replaces kie/69labs. Same async envelope for
every model: `POST /v1/ai/<model>` → `{ data:{ task_id, status } }`; poll
`GET /v1/ai/<model>/{task_id}` → `{ data:{ status, generated:[urls] } }` until
`status:"COMPLETED"` (`CREATED|IN_PROGRESS|COMPLETED|FAILED`). Auth header
`x-magnific-api-key`; base `https://api.magnific.com`. Operations wired:
- **Text→image**: **Mystic** `POST /v1/ai/mystic` `{ prompt, model, resolution, aspect_ratio }`
  (`MAGNIFIC_IMAGE_MODEL` default `realism`, `MAGNIFIC_RESOLUTION` default `2k`) → Ken Burns.
- **Image→image**: same Mystic endpoint + `structure_reference` (base64) — exported
  `editMagnificImageUrl()`; documented + implemented, not currently called by the
  text-driven b-roll pipeline.
- **Text/image→video**: **MiniMax Hailuo 02 1080p** `POST /v1/ai/image-to-video/minimax-hailuo-02-1080p`
  (`MAGNIFIC_VIDEO_MODEL`). Optional `first_frame_image` (base64) = image→video; 1080p
  is a fixed **6-second** clip (assemble trims to the beat length).

Selection & fallback (in `visual-source.ts` `acquireAi`): `AI_PROVIDER=magnific` makes
Magnific the primary (honoring `KIE_AI_MEDIA` image/video/auto exactly like kie); on a
shortfall it falls through to the universal 69labs/Grok floor. When `MAGNIFIC_ENABLED=1`
but Magnific is NOT the chosen provider, it's also tried as a **fallback** after kie/69labs
produce nothing, before that floor — so it's a genuine extra backend in the chain. With
`MAGNIFIC_ENABLED=0` (or no key) the fallback is a no-op and the pipeline is byte-identical
to before. Resilience mirrors Gemini/ElevenLabs: process-wide FIFO concurrency limiter
(`MAGNIFIC_CONCURRENCY`), per-request 120s timeout, and a retry loop (`MAGNIFIC_RETRIES`)
that backs off on transient 429/5xx/timeout/network and fails fast on permanent 4xx.
Cost: `magnific:mystic` (per image) + `magnific:video` (per video-second), both `payg`,
rate operator-configurable via `COST_MAGNIFIC_IMAGE_USD` / `COST_MAGNIFIC_VIDEO_USD_PER_SEC`
(default 0 / estimated — Magnific bills in credits with no public per-unit USD price, so we
record usage and never invent a euro). **Not implemented** (out of scope): TTS/voiceover,
upscaling, relight, style-transfer, music/sound — the API offers them but the pipeline
doesn't need them.

Channel `ai_style` ("Style images IA") threads into the AI prompt via the run
config (`aiStyle`) → `acquireVisual(..., { aiStyle })`.

> Operator feedback: stock (Pexels/Pixabay) looks "too obvious / not realistic".
> Lean on Veo (kie.ai) for realistic AI + the non-stock real sources (Openverse,
> Wikimedia, YouTube via yt-dlp) for authentic footage; keep Pexels/Pixabay as
> fallback, not primary, when authenticity matters.
