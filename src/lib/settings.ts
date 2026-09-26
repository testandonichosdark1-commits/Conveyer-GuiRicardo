import { AsyncLocalStorage } from "node:async_hooks";
import db from "./db";
import { isRetiredGeminiModel, replacementForGeminiModel } from "./services/gemini-models";
import { defaultAiModel } from "./providers";

/**
 * Keys the user can edit through the UI or via .env.
 * UI takes precedence over .env (env is only the fallback when the DB row is empty).
 */
export const SETTING_KEYS = [
  // ── Required API keys ─────────────────────────────────────────────
  "GOOGLE_API_KEY",          // Gemini — scene splitting
  "LABS69_API_KEY",          // 69labs — Grok img2vid + images
  "HEYGEN_API_KEY",          // HeyGen — TTS / voiceover generation
  "HEYGEN_VOICE_ID",         // HeyGen voice_id (from VA's voice clone or stock voice)

  // ── Optional / backup providers ───────────────────────────────────
  "ELEVENLABS_API_KEY",      // direct ElevenLabs (without 69labs)
  "GROQ_API_KEY",            // Groq Whisper — word-level transcription for single-shot TTS mode
  "PEXELS_API_KEY",          // Pexels — stock b-roll source for the AI+stock mix (one key per line for multiple)
  "MINIMAX_API_KEY",         // MiniMax TTS (cheap high-quality alternative)
  "MINIMAX_GROUP_ID",        // MiniMax Group ID (required in URL query param)
  "MINIMAX_VOICE_ID",        // MiniMax voice_id (cloned voice or stock voice)
  "MINIMAX_MODEL",           // MiniMax model — speech-02-hd / speech-02-turbo
  "REPLICATE_API_TOKEN",     // Replicate (Flux / Kling)
  "ANTHROPIC_API_KEY",       // Claude (alternative to Gemini)
  "OPENAI_API_KEY",          // OpenAI TTS / image backup
  "FAL_API_KEY",             // fal.ai (alternative to Replicate)
  "FFMPEG_PATH",             // absolute path to ffmpeg.exe if not in system PATH

  // ── Storage ───────────────────────────────────────────────────────
  "RUNS_OUTPUT_DIR",         // where run folders are written. Empty = default

  // ── Scene splitting (LLM) ─────────────────────────────────────────
  "SCENE_SPLIT_PROVIDER",    // google | anthropic
  "SCENE_SPLIT_MODEL",       // e.g. gemini-3.5-flash, claude-sonnet-4-6

  // ── Text-to-Speech ────────────────────────────────────────────────
  "TTS_PROVIDER",            // heygen (default) | 69labs | elevenlabs | openai | minimax
  "TTS_MODE",                // per-scene (default) | single-shot. Single-shot synthesizes ONE audio for the whole script then aligns scene boundaries via Groq Whisper word-timestamps — fixes per-scene choppy boundaries.
  "TTS_VOICE_PROVIDER",      // For 69labs: edgetts | elevenlabs | voice-clone
  "TTS_VOICE_ID",            // Voice id (ElevenLabs / Edge / clone UUID). For HeyGen use HEYGEN_VOICE_ID
  "TTS_MODEL",               // e.g. eleven_multilingual_v2
  "TTS_SPLIT_TYPE",          // smart | paragraphs | max_length

  // ── ElevenLabs voice fine-tuning ──────────────────────────────────
  "TTS_SPEED",               // 0.7–1.2 (lower = slower)
  "TTS_STABILITY",           // 0–1
  "TTS_SIMILARITY_BOOST",    // 0–1
  "TTS_STYLE",               // 0–1
  "TTS_USE_SPEAKER_BOOST",   // "1" / "0" / ""

  // ── Auto-pause (stops TTS from "swallowing" sentence ends) ────────
  "TTS_AUTO_PAUSE",          // "1" to enable
  "TTS_PAUSE_DURATION",      // seconds (0.1–30)
  "TTS_PAUSE_FREQUENCY",     // 1–100

  // ── Images ────────────────────────────────────────────────────────
  "IMAGE_PROVIDER",          // 69labs | replicate | openai | fal
  "IMAGE_MODEL",             // e.g. nano-banana-pro, imagen-4, seedream-4.5
  "IMAGE_RATIO",             // e.g. 16:9, 9:16, 1:1
  "IMAGE_RESOLUTION",        // 1k | 2k | 4k (for models that support it)

  // ── Animations (img2vid) ──────────────────────────────────────────
  "ANIMATION_PROVIDER",      // off | 69labs | replicate | fal
  "ANIMATION_MODEL",         // e.g. veo-video, grok-imagine-video
  "ANIMATION_RATIO_PERCENT", // 0–100, percentage of scenes to animate
  "ANIMATION_DISTRIBUTION",  // first-half | alternating | random | all
  "ANIMATION_DURATION",      // seconds (provider-dependent)
  "ANIMATION_KEEP_VEO_AUDIO", // "1" to keep Veo's generated ambient audio

  // ── Video assembly (FFmpeg) ───────────────────────────────────────
  "VIDEO_RESOLUTION",        // e.g. 1920x1080
  "VIDEO_FPS",               // 24 / 30 / 60
  "SCENE_TRANSITIONS",       // Phase 1: "on" = dip-to-black between scenes/beats; "off" (default) = hard cuts, byte-identical to today.
  "SCENE_TRANSITION_MS",     // Phase 1: dip-to-black duration per side (ms). Clamped to beatDur/3 on short beats. Default 300.
  "SCENE_DURATION_SECONDS",  // fallback duration when TTS length is unknown
  "TRANSITION_DURATION",     // crossfade between scenes in seconds (0 = none)
  "SCENE_TAIL_SILENCE",      // silence appended to each clip's audio (seconds), creates breathing room between scenes

  // ── Performance / Concurrency ─────────────────────────────────────
  "IMAGE_CONCURRENCY",       // parallel image jobs
  "TTS_CONCURRENCY",         // parallel TTS jobs
  "ANIMATION_CONCURRENCY",   // parallel img2vid jobs
  "ASSEMBLE_CONCURRENCY",    // parallel FFmpeg clip renders
  "ASSEMBLE_XFADE_CHUNKS",   // split final xfade into N parallel chunks (1 = monolithic)

  // ── Visual source mix (AI generation + Pexels stock) ──────────────
  "STOCK_RATIO_PERCENT",       // 0–100. % of scenes that use a real Pexels stock clip instead of AI generation. 0 = full AI (default).
  "STOCK_FOOTAGE_ORIENTATION", // landscape | portrait | square
  "STOCK_FOOTAGE_MAX_HEIGHT",  // 720 | 1080 | 2160 — caps the stock file size
  "STOCK_FOOTAGE_MIN_DURATION",// seconds — skip stock stingers shorter than this

  // ── Avatar documentary mode ───────────────────────────────────────
  "VOICEOVER_PROVIDER",        // elevenlabs (direct, word-timestamps) | genaipro | ai84 | fishaudio | hume | 69labs | heygen | minimax
  "ELEVENLABS_VOICE_ID",       // ElevenLabs narration voice_id (the script voiceover)
  "ELEVENLABS_MODEL",          // eleven_multilingual_v2 (default) | eleven_flash_v2_5
  "ELEVENLABS_RETRIES",        // retries for the voiceover call on TRANSIENT failures (500/503/429/timeout/network) before the run fails. Permanent 4xx (bad key/voice/quota) fail fast. attempts = retries + 1. 0 = one-shot. Default 3 (clamped 0–8).
  "ELEVENLABS_CONCURRENCY",    // max CONCURRENT ElevenLabs voiceover requests PROCESS-WIDE (across all simultaneous runs) so several videos don't exceed the account's per-plan concurrency cap. Default 2 (clamped 1–15); raise to match your plan (≈ Free 2 / Starter 3 / Creator 5 / Pro 10).
  "GENAIPRO_API_KEY",          // GenAIPro Labs (ElevenLabs reseller) API key — async TTS task API
  "GENAIPRO_VOICE_ID",         // GenAIPro narration voice_id (from GET /labs/voices)
  "GENAIPRO_MODEL",            // ElevenLabs model name: eleven_multilingual_v2 (default) | eleven_turbo_v2_5 | eleven_flash_v2_5 | eleven_v3
  "AI84_API_KEY",              // AI84 (api.ai84.pro) API key (sk-user-…) — ElevenLabs/MiniMax reseller, async TTS task API. Sent as xi-api-key.
  "AI84_VOICE_ID",             // AI84 narration voice_id (an ElevenLabs shared-voice id, e.g. JBFqnCBsd6RMkjVDRZzb)
  "AI84_MODEL",                // ElevenLabs model name: eleven_multilingual_v2 (default) | eleven_turbo_v2_5 | eleven_flash_v2_5 | eleven_v3
  "COST_AI84_USD_PER_CREDIT",  // USD price of one AI84 credit (blank/0 → EUR shown as 0 until you set it). Cost rows still record the credit count.
  "AI33_API_KEY",              // ai33.pro / OpenSpeaker API key — reseller fronting six TTS engines behind one balance. Sent as xi-api-key.
  "AI33_VOICE_ID",             // ai33 narration voice_id, "<engine>:<id>" (e.g. edge:en-US-GuyNeural). The engine is IN the id — there is no engine setting.
  "AI33_BASE_URL",             // ai33 API host. Blank = https://api.openspeaker.ai. Only set this if ai33 tells you to; ai33.pro and openspeaker.ai are the same product.
  "COST_AI33_USD_PER_CREDIT",  // USD price of one ai33 credit (blank/0 → EUR shown as 0 until you set it). Cost rows still record the credit count.
  "FISHAUDIO_API_KEY",         // Fish Audio (api.fish.audio) API key — sent as `Authorization: Bearer`.
  "FISHAUDIO_VOICE_ID",        // Fish Audio voice = a MODEL id (`_id` from GET /model), sent as `reference_id`.
  "FISHAUDIO_MODEL",           // Backend model, sent as the `model` HTTP HEADER (not a body field): s2.1-pro (default) | s2-pro | s1 | s2.1-pro-free
  "COST_FISHAUDIO_USD_PER_1M_BYTES", // Fish Audio bills per MILLION UTF-8 BYTES ($15.00 list). NOT per character — non-Latin text costs 2–3x more per character.
  "HUME_API_KEY",              // Hume AI (api.hume.ai) API key — sent as the `X-Hume-Api-Key` header.
  "HUME_VOICE_ID",             // Hume voice UUID. A bare id resolves against BOTH the Voice Library and custom voices, so no provider is stored alongside it.
  "HUME_VERSION",              // Octave model version: "" = Hume's default | "1" | "2". Octave-2-only voices REQUIRE "2".
  "COST_HUME_USD_PER_1K_CHARS", // Hume Octave TTS list price per 1,000 characters ($0.15 entry tier, $0.05 on Business).
  "SECONDS_PER_VISUAL",        // seconds each image/clip stays on screen (default 4.5)
  // Longest voiceover an operator may upload, in minutes. The binding constraint is Groq's
  // 25 MB transcription limit: our mono/16 kHz/64 kbps downmix is ~8 kB/s, so 25 MB ≈ 54 min.
  // 50 leaves margin. Raising this past ~54 makes Whisper fail and the timings unusable.
  "UPLOAD_MAX_MINUTES",
  "BEAT_MIN_SEC",              // shortest beat/scene (s): sentence ends earlier than this merge into the next beat (default 3)
  "BEAT_MAX_SEC",              // hard cap on a beat/scene (s): mid-sentence cut only here (default 10)
  "VIDEO_MIN_MOVING_FRAMES",   // reject a stock VIDEO clip with fewer distinct frames than this over the 8s probe (near-static → replaced by a moving clip / Ken-Burned still; default 8, 0 = accept any)
  "AUDIO_LOUDNORM",            // "1" (default) = master the final video to AUDIO_TARGET_LUFS via two-pass linear loudnorm; "0" = leave audio at source (TTS) level
  "AUDIO_TARGET_LUFS",         // integrated loudness target for the final master (default -14, the YouTube reference)
  "AVATAR_FREQUENCY_PERCENT",  // 0–100, % of beats where the avatar appears (default 15)
  "AVATAR_SYNC_OFFSET_MS",     // fine-tune avatar lip timing vs narration (ms); + = video later, − = earlier; 0 = off
  "REAL_RATIO_PERCENT",        // 0–100, % of b-roll from real footage vs AI (default 80). Used for "mix" mode.
  "VISUAL_MODE",               // ai | real | mix — default visual source for new videos (default mix)
  "FOOTAGE_SOURCES",           // CSV priority list: pexels,pixabay,openverse,wikimedia
  "REAL_MATCH_THRESHOLD",      // 0–100. >0 = Gemini scores how well each stock hit matches the query; hits below the bar are skipped (falls back to AI). 0 = off.
  "REAL_MEDIA",                // image (photos only) | video (videos only) | auto (photos + video — DEFAULT). Filters real-footage candidates by media kind. Surfaced on the Run page.
  "AI_MATCH_THRESHOLD",        // 0–100. Early-exit bar for AI image regeneration. Empty = REAL_MATCH_THRESHOLD / 75. (AI typically scores 68–78, so a lower bar avoids wasted regens.)
  "VISION_MATCH_MODEL",        // Gemini model used to visually score footage candidates (vision). Default gemini-3.1-flash-lite (cheap/fast); empty = inherit SCENE_SPLIT_MODEL.
  "AI_REGEN_ATTEMPTS",         // 1–3. AI images are scored like real footage; below REAL_MATCH_THRESHOLD they regenerate up to this many tries (default 2). 1 = off.
  "STORYBLOCKS_API_KEYS",      // Storyblocks (PAID stock video). One "publicKey:privateKey" pair PER LINE — several
                               // pairs are rotated exactly like PEXELS_API_KEY. One Storyblocks account issues one
                               // keypair, so multiple pairs means multiple accounts (e.g. yours and an assistant's).
  "STORYBLOCKS_MAX_DOWNLOADS_PER_RUN", // Optional ceiling on BILLED Storyblocks downloads per video. 0 (default) = NO
                               // limit, so the source behaves like every other one. DB/API-only on purpose: it is a
                               // safety valve for an operator who wants one, not a knob every user must understand.
  "PIXABAY_API_KEY",           // Pixabay (images + videos). Free, no attribution.
  "OPENVERSE_TOKEN",           // Optional Openverse bearer token for higher rate limits
  "GOOGLE_CSE_KEY",            // Google Programmable Search (Custom Search JSON API) key — web image search ("web" source)
  "GOOGLE_CSE_CX",             // Google Programmable Search engine id (cx) — must have Image search ON
  "WIGOLO_URL",                // Local wigolo daemon base URL — web image search ("wigolo" source). Empty = source off.
  "WIGOLO_API_TOKEN",          // Bearer token; only needed when the daemon binds past loopback (it then refuses to start without one)
  "WIGOLO_EXCLUDE_DOMAINS",    // CSV of domains to drop — stock agencies serve WATERMARKED comps, unusable in a finished video
  "WIGOLO_MIN_PX",             // Drop hits smaller than this on either side; open-web search has no size floor of its own
  "WIGOLO_BIN",                // Explicit path to the wigolo binary. Empty = look on PATH, then node_modules/.bin. Never installs.
  "AVATAR_BACKGROUND",         // HeyGen avatar background color (hex) + placeholder color
  "VISUAL_CONCURRENCY",        // parallel b-roll fetch/gen jobs (default 3)
  "AVATAR_CONCURRENCY",        // parallel HeyGen avatar-clip jobs (default 2)
  "YT_DLP_ENABLED",            // "1" to allow the yt-dlp YouTube source (ON by default; note copyright/ToS risk)
  "YT_DLP_PATH",               // path to yt-dlp(.exe) if not on PATH
  "YT_DLP_CC_ONLY",            // DEPRECATED — CC gating removed; retained for backward compat but no longer read. Default "0".

  // ── AI provider (Flow browser, kie.ai nano-banana/Veo, or 69labs Grok) ─────
  "AI_PROVIDER",               // flow_browser | kie | 69labs | ... — engine for AI b-roll
  "FLOW_PROJECT_URL",          // Exact Google Flow project URL opened by the browser worker
  "FLOW_BROWSER_PROFILE_DIR",  // Persistent Chrome profile. Empty = DATA_DIR/flow-browser-profile
  "FLOW_BROWSER_CHANNEL",      // Playwright browser channel. Default chrome (uses installed Google Chrome)
  "FLOW_BROWSER_EXECUTABLE",   // Optional absolute browser executable path (advanced)
  "FLOW_BROWSER_HEADLESS",     // 0 = visible (recommended), 1 = headless
  "FLOW_CDP_PORT",             // localhost debugging port used to attach to normal Chrome
  "FLOW_GENERATION_TIMEOUT_SEC", // Max wait for one generated image
  "FLOW_FALLBACK_PROVIDER",    // none | kie | chain — what to do if the Flow UI fails
  "FLOW_IMAGE_MODEL",          // Model label/id expected in Flow (Nano Banana Pro)
  "VIDS_FIRST",               // Google Vids tried BEFORE Flow: off (default) | image | both. Beats wanting the character reference always skip it.
  "VIDS_PROJECT_URL",         // Optional docs.google.com/videos/d/… URL, opened in a new tab only if no Vids tab is already open.
  "FLOW_IMAGE_MODEL_FALLBACK", // Model to switch to when FLOW_IMAGE_MODEL hits a limit mid-run (e.g. Nano Banana Pro -> Nano Banana 2). Empty = no fallback (today's behavior).
  "FLOW_ASPECT_RATIO",         // Image aspect ratio selected/validated by the worker
  "FLOW_REGEN_ATTEMPTS",       // Flow generations per beat after visual quality scoring (default 1)
  "FLOW_PROMPT_SELECTOR",      // Optional CSS selector override for Flow prompt box
  "FLOW_GENERATE_SELECTOR",    // Optional CSS selector override for Flow Generate button
  "FLOW_REFERENCE_FILE_SELECTOR", // Optional CSS selector for Flow's character-reference file input
  "FLOW_REFERENCE_REMOVE_SELECTOR", // Optional CSS selector for removing a stale Flow reference attachment
  "FLOW_VIDEO_MODEL",          // Veo model label/id expected in Flow (e.g. "veo-3.1-fast" -> "Veo 3.1 Fast")
  "FLOW_VIDEO_TIMEOUT_SEC",    // Max wait for one generated Veo video — separate from (and longer than) the image timeout
  "FLOW_VIDEO_DURATION_SEC",   // Clip length requested from Flow's duration control, when Flow exposes one
  "FLOW_VIDEO_DOWNLOAD_SELECTOR", // Optional CSS selector override for Flow's video Download control
  "FLOW_MEDIA_MODE_SELECTOR",  // Optional CSS selector override for Flow's Image/Video mode switch
  "FLOW_ASPECT_RATIO_SELECTOR", // Optional CSS selector override for Flow's aspect-ratio control
  "FLOW_DURATION_SELECTOR",    // Optional CSS selector override for Flow's duration control
  "KIE_API_KEY",               // kie.ai API key (nano-banana images, Veo video)
  "KIE_IMAGE_MODEL",           // kie.ai image model id (nano-banana)
  "KIE_VIDEO_MODEL",           // kie.ai video model id (Veo)
  "KIE_AI_MEDIA",              // image (force nano-banana stills — DEFAULT, Veo off) | video (force Veo) | auto (per-beat routing)
  "FALLBACK_AI_MEDIA",         // What AI *fallback* (a real beat with no footage) may generate: image (DEFAULT, cheapest) | video | both. Does NOT touch normal AI mode.
  // Cloudflare Workers AI — optional free/cheap first-pass before kie.ai stills.
  // Primary profile keeps the original keys for backwards compatibility. Backup profiles are
  // ONLY for operational failover (bad credentials/config/transient outage), never quota rotation.
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID_2",
  "CLOUDFLARE_API_TOKEN_2",
  "CLOUDFLARE_ACCOUNT_ID_3",
  "CLOUDFLARE_API_TOKEN_3",
  "CLOUDFLARE_ACCOUNT_ID_4",
  "CLOUDFLARE_API_TOKEN_4",
  "CLOUDFLARE_IMAGE_MODEL",
  // Intermediate image fallbacks before kie.ai. Pollinations is tried first, then Meta Muse.
  "POLLINATIONS_API_KEY",
  "POLLINATIONS_IMAGE_MODEL",
  "META_API_KEY",
  "META_API_BASE_URL",
  "META_IMAGE_MODEL",
  // Magnific AI — one more AI b-roll backend (Mystic image + Ken Burns, or Hailuo video).
  // Selectable as AI_PROVIDER=magnific; when ENABLED it also acts as a fallback for kie/69labs.
  "MAGNIFIC_API_KEY",          // Magnific AI API key (x-magnific-api-key)
  "MAGNIFIC_ENABLED",          // 1 (available as provider + fallback) | 0 (never used) — DEFAULT 1
  "MAGNIFIC_IMAGE_MODEL",      // Mystic model id: zen | flexible | fluid | realism (DEFAULT) | super_real | editorial_portraits
  "MAGNIFIC_VIDEO_MODEL",      // Hailuo image-to-video model path segment (DEFAULT minimax-hailuo-02-1080p)
  "MAGNIFIC_RESOLUTION",       // Mystic resolution: 1k | 2k (DEFAULT) | 4k
  "MAGNIFIC_RETRIES",          // retries on TRANSIENT Magnific failures (429/5xx/timeout/network) before failing over. Permanent 4xx fail fast. Default 3 (clamped 0–8).
  "MAGNIFIC_CONCURRENCY",      // max CONCURRENT Magnific requests PROCESS-WIDE (across all runs). Default 2 (clamped 1–15).
  // Runware — EXPERIMENTAL AI b-roll backend (one API over many image models).
  // Selectable as AI_PROVIDER=runware; never a fallback for the others, and never the default.
  "RUNWARE_API_KEY",           // Runware API key (Authorization: Bearer …)
  "RUNWARE_IMAGE_MODEL",       // Runware AIR model id, e.g. runware:101@1 (FLUX.1 dev — DEFAULT)
  "RUNWARE_RETRIES",           // retries on TRANSIENT Runware failures (429/503/504/5xx/network) before failing over. Permanent 4xx and our own timeout fail fast. Default 3 (clamped 0–8).
  "RUNWARE_CONCURRENCY",       // max CONCURRENT Runware requests PROCESS-WIDE (across all runs). Runware recommends 2–4. Default 3 (clamped 1–15).
  // Higgsfield — additional AI b-roll backend (one async API over Soul/DoP + third-party engines).
  // Selectable as AI_PROVIDER=higgsfield; when ENABLED it also acts as a fallback for the others.
  "HIGGSFIELD_API_KEY",        // Higgsfield API key id (Authorization: Key {id}:{secret})
  "HIGGSFIELD_API_SECRET",     // Higgsfield API key secret — the second half of the Key auth pair
  "HIGGSFIELD_ENABLED",        // 1 (available as provider + fallback) | 0 (never used) — DEFAULT 1
  "HIGGSFIELD_IMAGE_MODEL",    // Higgsfield image model slug (DEFAULT higgsfield-ai/soul/standard)
  "HIGGSFIELD_VIDEO_MODEL",    // Higgsfield video model slug (DEFAULT higgsfield-ai/dop/standard)
  "HIGGSFIELD_RESOLUTION",     // requested output resolution, e.g. 1080p (passed through when the model accepts it)
  "HIGGSFIELD_RETRIES",        // retries on TRANSIENT Higgsfield failures (429/5xx/timeout/network) before failing over. Permanent 4xx fail fast. Default 3 (clamped 0–8).
  "HIGGSFIELD_CONCURRENCY",    // max CONCURRENT Higgsfield requests PROCESS-WIDE (across all runs). Default 2 (clamped 1–15).
  "SMART_ASSIGN",              // 0 (positional spread) | 1 (content-aware real/AI assignment by queryType+aiMedia)
  "TOPIC_POOL",                // 0 (off — one provider search per beat) | 1 (Topic Pool Retrieval: beats sharing a topicKey reuse ONE gathered candidate pool per attempt, cutting provider searches; per-beat vision scoring + usedIds allocation unchanged). Default 0.
  "PLAN_QUERY_TRIM",           // WI-13: 1 = strip non-depictable abstract/economic tails (e.g. "scaling energy output") from the footage query so search isn't pulled off-topic. 0 = off. Default 1.
  "YT_ROUTING",                // 0 (legacy: YouTube = end-fallback for all real beats) | 1 (entity beats → YouTube-first, generic → no YouTube)
  "YT_DEBUG",                  // 0 (off) | 1 (diagnostics: log YouTube segment/scoring metadata + save scored frames to DATA_DIR/debug_frames)
  "YT_SEGMENT",                // 0 (blind offset) | 1 (Phase 1A: localize the download window via the video's CHAPTERS; falls back to offset on no match)
  "YT_PREFER",                 // 0 (off) | 1 (Y1: contemporary beats → YouTube-first too, not just archival; requires YT_ROUTING=1; conceptual still AI)
  "YT_MATCH_THRESHOLD",        // DEPRECATED (WI-4) — per-frame consensus bar; no longer read (YT_CLIP_THRESHOLD replaces it). Retained for backward compat.
  "YT_CANDIDATES",             // M1: max YouTube candidates scored per beat before stock fallback (1–12). Higher = more YouTube, more latency. Default 6 (WI-10 deep sweep).
  "YT_CLIP_THRESHOLD",         // WI-4: clip acceptance bar (0–100) on clipScore = mean(frames) − YT_DEAD_PENALTY·deadCount. Default 64.
  "YT_DEAD_FRAME",             // WI-4: a frame scored below this is "dead" (black/wrong/absent). Default 25.
  "YT_DEAD_PENALTY",           // WI-4: clipScore penalty per dead frame. Default 8.
  "YT_EXCELLENT",              // WI-4: clipScore at/above which best-of-N early-exits (accept immediately). Default 85.
  "YT_SEGMENT_RETRIES",        // WI-9: on a text-vetoed but RELEVANT clip, max extra windows of the SAME video to try for a text-free segment. 0 = off. Default 1.
  "YT_BROLL_SHAPING",          // WI-10: 1 = bias contemporary search+ranking toward b-roll/cinematic sources and downrank news/explainer (less burned-in text). 0 = off (legacy ranking). Default 1.
  "YT_CROP_RECOVERY",          // WI-11: 1 = when a RELEVANT clip is text-vetoed and segment-retry fails, crop out a lower/upper caption strip + zoom-to-fill and re-score (text gone → keep). 0 = off. Default 1.
  "YT_CROP_FRACTION",          // WI-11: fraction of frame height removed as the caption strip on a crop-recovery (0.10–0.40). Default 0.22.
  "YT_HEAD_VETO",              // R1: 1 = hard-veto a YouTube clip on ANY frame whose primary content is a THIRD-PARTY talking-head/presentation (-2 sentinel, like the text veto); carve-out keeps the named subject's own footage. 0 = off. Default 0.
  "YT_SEPARATE_QUERY",         // #1: 1 = search YouTube with the planner's short title-optimized youtube_query (no suffix augmentation); per-frame scoring stays on the descriptive query. 0 = off (use visualQuery + augmentation). Default 0.
  "YT_TITLE_RERANK",           // #2: 1 = before download, one Gemini call scores each candidate title on relevance × cleanliness; download order is reranked and the beat early-bails to stock when the best combined score is below YT_RERANK_FLOOR. 0 = off. Default 0.
  "YT_RERANK_FLOOR",           // #2: early-bail threshold for the best combined (relevance·cleanliness/100, 0-100) title score — below this the whole YouTube pool is treated as hopeless → straight to stock/AI. Default 45.
  "YT_RERANK_RETRIES",         // Phase 1A: extra retries for the title-rerank Gemini call on TRANSIENT failures (5xx/429/timeout/network) before failing open. Restores the cheap pre-download early-bail when Gemini 503s. 0 = today's single-shot. Default 2.
  "YT_TEXT_VETO_LIMIT",        // Phase 1B: YouTube circuit breaker. Bail to stock/AI after this many CONSECUTIVE candidates whose terminal outcome is a text veto (caption-saturated pool, e.g. beat 5). Counts only terminal text vetoes (after segment-retry + crop-recovery); accept/below-bar/dead reset it. 0 = off (today's behavior). Default 3.
  "YT_DOWNLOAD_CONCURRENCY",   // Phase 3 (Step 2): max CONCURRENT yt-dlp segment downloads across all beats (1–8). Separate from VISUAL_CONCURRENCY so the risky knob (parallel YouTube hits from one IP) is dialed independently. 1 = serialized (today's behavior). Default 1; raise once parallel downloads prove stable.
  "HEYGEN_UPLOAD_RETRIES",     // extra retries for the HeyGen voiceover upload on TRANSIENT failures (transport/DNS/timeout, 429, 5xx) before dropping the beat to b-roll. Permanent 4xx fail fast. attempts = retries + 1. 0 = one-shot (old behavior). Default 2 (clamped 0–5).
  "HEYGEN_DOWNLOAD_RETRIES",   // H1b: extra retries for the FINAL rendered-MP4 download (has a 120s per-attempt timeout) on TRANSIENT failures (transport/DNS/connect-timeout, 429, 5xx). Permanent 4xx (e.g. expired signed URL) fail fast. attempts = retries + 1. 0 = one-shot (old behavior). Default 2 (clamped 0–5).
  "AI_IMAGE_STYLE",            // default style suffix for AI image/video prompts (channel can override)
  "AI_CHARACTER_TERMS",          // comma-separated words that attach the character reference to a beat (per channel; empty = built-in list)
  "AI_CHARACTER_REFERENCE_PATH", // local reference portrait used by kie.ai image-to-image when a female/housekeeper scene is detected
  "KIE_IMAGE_EDIT_MODEL",        // kie.ai image-to-image model used when a character reference is active

  // ── Reliability / scaling ─────────────────────────────────────────
  "FAILURE_THRESHOLD_PERCENT", // 0–100. If more than this % of scenes fail, the run aborts. Default 25.
  "AUTO_REUSE_ENABLED",      // "1" = pipeline auto-searches the library and reuses matches without a preview step
  "AUTO_REUSE_THRESHOLD",    // 0–100 confidence %. Scenes matching at/above this are auto-reused. Default 80.
  "MAX_FRESH_CLIPS_PER_RUN", // Hard cap. If more than N scenes remain fresh after normal auto-reuse, force additional library reuse at the lowest threshold until under cap. 0 = disabled.
  "SCENE_DEDUPE_ENABLED",    // "1" = post-process scene-split: detect adjacent near-duplicate visual_prompts and re-ask Gemini to vary them. Default "1".
  "SCENE_DEDUPE_THRESHOLD",  // 0–1 Jaccard similarity threshold for dedupe. Default 0.7.
  "SCENE_DEDUPE_MAX_PASSES", // 1–5. How many times to re-run the dedupe pass until no duplicate groups remain. Default 3.
  "ASSEMBLE_XFADE_MAX_SCENES", // Max scene count before assembly falls back to simple concat (no xfade). Prevents OOM on huge runs. Default 150.

  // ── Google Drive sync ─────────────────────────────────────────────
  // OAuth2 credentials from Google Cloud Console (Web Application client).
  // Redirect URI must be set to http://localhost:3000/api/gdrive/oauth/callback
  "GDRIVE_CLIENT_ID",
  "GDRIVE_CLIENT_SECRET",
  // Refresh token, set automatically after the user completes the OAuth flow.
  // Don't edit by hand.
  "GDRIVE_REFRESH_TOKEN",
  // Email of the Google account that authorized — set automatically, shown in UI.
  "GDRIVE_CONNECTED_EMAIL",
  // Folder IDs in Drive. Empty = auto-create `Conveyer Grok/Final Videos` and
  // `Conveyer Grok/Clips Library` in the user's Drive root on first sync.
  "GDRIVE_FINAL_VIDEOS_FOLDER_ID",
  "GDRIVE_CLIPS_LIBRARY_FOLDER_ID",
  // Master switch — a TRI-state, and the third state is load-bearing:
  //   "1" = upload after every run · "0" = the user deliberately turned it OFF
  //   ""  = never configured (default) — the ONLY state a first Drive connection
  //         may auto-enable, so an explicit opt-out is never undone by a reconnect.
  // Only "1" uploads, so "0" and "" behave identically at the gate (backward compatible).
  "GDRIVE_SYNC_ENABLED",

  // ── Cost Monitoring rates (configurable; defaults are documented public list
  //    prices in USD, converted to EUR with COST_USD_TO_EUR). Operator overrides
  //    these in Settings with their actual plan rate. See lib/pricing.ts. ──
  // USD→EUR FX used to convert provider list prices into the EUR shown on /costs.
  "COST_USD_TO_EUR",
  // DEPRECATED (kept for back-compat; no DB migration). ElevenLabs/HeyGen are now
  // always subscription — their plan is chosen on the Costs page (BILLING_PROFILES),
  // and their metered € is never displayed. pricing.ts still reads these to fill the
  // (ignored) run_costs.amount_eur, but no shown number depends on them anymore.
  "COST_ELEVENLABS_USD_PER_1K_CHARS",
  // Gemini token rates, $/1M. The planner/rerank text model (gemini-3.5-flash)
  // and the vision/scoring model (gemini-3.1-flash-lite) are priced separately —
  // the ledger prices geminiText with the first pair, geminiVision with the LITE pair.
  "COST_GEMINI_IN_USD_PER_1M",
  "COST_GEMINI_OUT_USD_PER_1M",
  "COST_GEMINI_LITE_IN_USD_PER_1M",
  "COST_GEMINI_LITE_OUT_USD_PER_1M",
  // kie.ai AI media. nano-banana = per generated image; Veo = per video-second.
  "COST_KIE_IMAGE_USD",
  "COST_KIE_VEO_USD_PER_SEC",
  // DEPRECATED (see COST_ELEVENLABS_USD_PER_1K_CHARS note). HeyGen per-minute rate.
  "COST_HEYGEN_USD_PER_MIN",
  // HeyGen rate for the "Unlimited" motion engine (rendered WITHOUT use_avatar_iv_model).
  "COST_HEYGEN_UNLIMITED_USD_PER_MIN",
  // HeyGen rate for the Avatar V engine (v3). ESTIMATE — see DEFAULTS.
  "COST_HEYGEN_AVATAR_V_USD_PER_MIN",
  // 69labs / Grok b-roll, per generated video. No public per-unit list price, so
  // default 0 (records the unit count but €0 amount) until the operator sets the
  // rate from their account. Fixes the old hardcoded €0 blind spot.
  "COST_LABS69_USD_PER_VIDEO",
  // 69labs also generates STILLS, which were priced with the video rate and labelled
  // "videos" — an image billed as a video. Separate rate, separate unit.
  "COST_LABS69_IMAGE_USD",
  // Magnific AI — credit-based billing with no public per-unit USD rate, so both
  // default 0 (unit count recorded, €0/estimated) until the operator sets a rate.
  "COST_MAGNIFIC_IMAGE_USD",
  "COST_MAGNIFIC_VIDEO_USD_PER_SEC",
  "COST_RUNWARE_IMAGE_USD",    // FALLBACK only — Runware reports its real billed cost per image, which always wins. Default 0.
  // Higgsfield — credit-based billing with no public per-unit USD rate, so both default
  // 0 (unit count recorded, €0/estimated) until the operator sets a rate.
  "COST_HIGGSFIELD_IMAGE_USD",
  "COST_HIGGSFIELD_VIDEO_USD_PER_SEC",
  // Voiceover providers that were spending real money and recording NOTHING: only
  // 3 of the 9 TTS branches were metered, so a run narrated by HeyGen, 69labs,
  // OpenAI, MiniMax or GenAIPro showed no voiceover cost at all. All bill per
  // character of synthesized text. No published per-unit price is verifiable for
  // most of them, so they default to 0 and the Costs page flags them as "rate not
  // set" rather than pretending the narration was free.
  "COST_HEYGEN_TTS_USD_PER_1K_CHARS",
  "COST_LABS69_TTS_USD_PER_1K_CHARS",
  "COST_OPENAI_TTS_USD_PER_1K_CHARS",
  "COST_MINIMAX_TTS_USD_PER_1K_CHARS",
  "COST_GENAIPRO_TTS_USD_PER_1K_CHARS",
  // Storyblocks — the resolve-file step is the BILLED one (the search is free), and it
  // was unmetered AND missing from the Costs page's provider table entirely.
  "COST_STORYBLOCKS_USD_PER_DOWNLOAD",
  // Google Custom Search — free for the first 100 queries/day, billed above that.
  "COST_GOOGLE_CSE_USD_PER_QUERY",
  // Groq Whisper transcription, $/hour of AUDIO (not wall-clock). Billed whenever we
  // recover word timings from an mp3 we didn't get alignment for — i.e. every
  // non-ElevenLabs voiceover provider. Public list price for whisper-large-v3.
  "COST_GROQ_USD_PER_AUDIO_HOUR",
  // DEPRECATED subscription tier picker — plan selection now lives solely in
  // BILLING_PROFILES (chosen on the Costs page). Kept only so pricing.ts + existing
  // DB rows keep resolving; removed from the Settings UI. No displayed number uses it.
  // (The HeyGen twin is gone: its API is pay-as-you-go, so no tier ever applied.)
  "COST_ELEVENLABS_TIER",
  // Per-provider billing profiles (JSON): which providers are on a subscription vs
  // pay-as-you-go, and the chosen plan / custom monthly fee. Drives the Cost page's
  // honest per-provider view. Not secret. See src/lib/billing.ts.
  "BILLING_PROFILES",
  // Day-of-month (1–28) the billing cycle resets on — the single clock for the Cost
  // page's Fixed/Variable/quota/overage window. Default "1" = plain UTC calendar month.
  "BILLING_CYCLE_START_DAY",
] as const;

/** Keys whose values are secrets and should be masked when sent to the UI.
 *  Exported so a test can pin that a given key really is covered — the rule is a substring
 *  match, so a key gets masking implicitly and would lose it silently if the rule narrowed. */
export function isSecretKey(key: string): boolean {
  return key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET");
}

export type SettingKey = (typeof SETTING_KEYS)[number];

const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
// Row count, read once at seedDefaults entry to tell a fresh DB from a pre-existing one.
const settingsCountStmt = db.prepare("SELECT COUNT(*) AS n FROM settings");
const upsertStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

/**
 * Per-run channel overrides — API keys, voice provider, character reference — applied
 * TRANSPARENTLY to every `getSetting()` call made while a run is executing, with zero
 * changes to the ~30 provider files that already call it (kie.ts, elevenlabs-voiceover.ts,
 * heygen-client.ts, ai33-voices.ts, stock-footage.ts, …). AsyncLocalStorage.enterWith is
 * used rather than a wrapping `.run(store, fn)` callback specifically so
 * studio-pipeline.ts's existing single large try/finally body doesn't need to be
 * restructured — it just calls `setChannelSettingOverrides()` once, right after resolving
 * the run's channel, and every `await` after that point (across the whole pipeline: voice,
 * beats, visuals, assembly) sees the override for the REST of this run's async chain.
 * Concurrent runs never cross: each is its own top-level async invocation with its own
 * promise chain, and Node's async_hooks isolates the store per chain — the same mechanism
 * Next.js itself uses for request-scoped state.
 */
const channelSettingOverrideStore = new AsyncLocalStorage<Record<string, string>>();

/** Call once per run, after resolving its channel — see the store's doc comment above. */
export function setChannelSettingOverrides(overrides: Record<string, string>): void {
  channelSettingOverrideStore.enterWith(overrides);
}

/** Explicit no-op override map — a run with no channel (or a channel with nothing set)
 *  still establishes a store, so a stale one can never leak in from elsewhere. */
export function clearChannelSettingOverrides(): void {
  channelSettingOverrideStore.enterWith({});
}

export function getSetting(key: SettingKey): string {
  const overrides = channelSettingOverrideStore.getStore();
  if (overrides && overrides[key]) return overrides[key];
  const row = getStmt.get(key) as { value: string } | undefined;
  if (row && row.value !== "") return row.value;
  return process.env[key] ?? "";
}

export function setSetting(key: SettingKey, value: string) {
  upsertStmt.run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SETTING_KEYS) out[k] = getSetting(k);
  return out;
}

/**
 * Mask ONE stored entry for display.
 *
 * STORYBLOCKS_API_KEYS holds a PAIR per line, "publicKey:privateKey", and the UI splits
 * that colon into two inputs. Masking the line as one blob would swallow the colon and
 * leave the pair unsplittable, so each half is masked SEPARATELY and the colon is kept.
 * Both halves are hidden — a public key is still a credential the operator would rather
 * not have on screen, and it is treated like every other key here.
 */
/** first4…last4 — the raw masking primitive, byte-identical to the pre-existing inline
 *  version. Exported so any OTHER place that stores a secret value (e.g. a channel's own
 *  API-key override) can mask it the exact same way, instead of growing a second masking
 *  convention that could drift from this one. */
export function shortMask(x: string): string {
  return `${x.slice(0, 4)}…${x.slice(-4)}`;
}

function maskEntry(key: string, entry: string): string {
  if (key === "STORYBLOCKS_API_KEYS") {
    const i = entry.indexOf(":");
    if (i > 0) return `${shortMask(entry.slice(0, i))}:${shortMask(entry.slice(i + 1))}`;
  }
  return shortMask(entry);
}

/** Safe version — masks secret keys/tokens/secrets. Handles multi-line key lists too. */
export function getMaskedSettings(): Record<string, string> {
  const all = getAllSettings();
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (isSecretKey(k)) {
      if (!v) {
        masked[k] = "";
      } else {
        // Mask each line/entry separately so multi-key fields show all entries
        const parts = v.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
        masked[k] = parts.map((p) => maskEntry(k, p)).join("\n");
      }
    } else {
      masked[k] = v;
    }
  }
  return masked;
}

export const DEFAULTS: Record<SettingKey, string> = {
  // Required API keys — empty by default, user must provide
  GOOGLE_API_KEY: "",
  LABS69_API_KEY: "",
  HEYGEN_API_KEY: "",
  HEYGEN_VOICE_ID: "",

  // Optional providers
  ELEVENLABS_API_KEY: "",
  GROQ_API_KEY: "",
  PEXELS_API_KEY: "",
  MINIMAX_API_KEY: "",
  MINIMAX_GROUP_ID: "",
  MINIMAX_VOICE_ID: "",
  MINIMAX_MODEL: "speech-02-hd",
  REPLICATE_API_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  FAL_API_KEY: "",
  FFMPEG_PATH: "",

  // Storage — empty = use default (DATA_DIR/runs)
  RUNS_OUTPUT_DIR: "",

  // Scene split
  SCENE_SPLIT_PROVIDER: "google",
  SCENE_SPLIT_MODEL: "gemini-3.5-flash",

  // TTS — Conveyer Grok defaults to HeyGen (Miguel's VA voices live there).
  // Switch to 69labs/elevenlabs/openai via /settings if needed.
  TTS_PROVIDER: "heygen",
  TTS_MODE: "per-scene",
  TTS_VOICE_PROVIDER: "edgetts",
  TTS_VOICE_ID: "en-US-GuyNeural",
  TTS_MODEL: "",
  TTS_SPLIT_TYPE: "smart",

  // Voice fine-tuning (slightly slower + small style for documentary feel)
  TTS_SPEED: "0.93",
  TTS_STABILITY: "0.6",
  TTS_SIMILARITY_BOOST: "0.75",
  TTS_STYLE: "0.15",
  TTS_USE_SPEAKER_BOOST: "1",

  // Auto-pause on sentence boundaries
  TTS_AUTO_PAUSE: "1",
  TTS_PAUSE_DURATION: "0.4",
  TTS_PAUSE_FREQUENCY: "1",

  // Images — Conveyer Grok is video-only. These defaults are kept only so
  // that legacy DB rows don't crash anything; the pipeline never reads them.
  IMAGE_PROVIDER: "off",
  // Model defaults derive from the provider registry (src/lib/providers.ts) — the
  // single source of truth — so a default lives in exactly one place. IMAGE_MODEL /
  // ANIMATION_MODEL are the 69labs (Grok) b-roll model keys.
  IMAGE_MODEL: defaultAiModel("69labs", "image"), // = "nano-banana-pro"
  IMAGE_RATIO: "16:9",
  IMAGE_RESOLUTION: "1k",

  // Animations — Conveyer Grok animates EVERY scene through Grok via 69labs.
  ANIMATION_PROVIDER: "69labs",
  ANIMATION_MODEL: defaultAiModel("69labs", "video"),  // = "grok-imagine-video" — xAI Grok video via 69labs (text-to-video)
  ANIMATION_RATIO_PERCENT: "100",         // 100 % of scenes animated, no Ken-Burns mix
  ANIMATION_DISTRIBUTION: "all",
  ANIMATION_DURATION: "",                 // ignored by Grok (69labs hard-codes ~6s); applies only to non-Grok/non-Veo models
  ANIMATION_KEEP_VEO_AUDIO: "",           // legacy name — applies to any model with embedded audio

  // Video assembly
  VIDEO_RESOLUTION: "1920x1080",
  VIDEO_FPS: "30",
  SCENE_TRANSITIONS: "off",
  SCENE_TRANSITION_MS: "300",
  SCENE_DURATION_SECONDS: "5",
  TRANSITION_DURATION: "0.5",
  SCENE_TAIL_SILENCE: "0.4",

  // Performance
  IMAGE_CONCURRENCY: "5",
  TTS_CONCURRENCY: "3",
  ANIMATION_CONCURRENCY: "3",
  ASSEMBLE_CONCURRENCY: "4",
  ASSEMBLE_XFADE_CHUNKS: "4",

  // Visual source mix (AI + Pexels stock)
  STOCK_RATIO_PERCENT: "0",
  STOCK_FOOTAGE_ORIENTATION: "landscape",
  STOCK_FOOTAGE_MAX_HEIGHT: "1080",
  STOCK_FOOTAGE_MIN_DURATION: "4",

  // Avatar documentary mode
  VOICEOVER_PROVIDER: "elevenlabs",
  ELEVENLABS_VOICE_ID: "",
  ELEVENLABS_MODEL: "eleven_multilingual_v2",
  ELEVENLABS_RETRIES: "3",
  ELEVENLABS_CONCURRENCY: "2",
  GENAIPRO_API_KEY: "",
  GENAIPRO_VOICE_ID: "",
  GENAIPRO_MODEL: "eleven_multilingual_v2",
  AI84_API_KEY: "",
  AI84_VOICE_ID: "",
  AI84_MODEL: "eleven_multilingual_v2",
  COST_AI84_USD_PER_CREDIT: "",
  AI33_API_KEY: "",
  AI33_VOICE_ID: "",
  AI33_BASE_URL: "",
  COST_AI33_USD_PER_CREDIT: "",
  FISHAUDIO_API_KEY: "",
  FISHAUDIO_VOICE_ID: "",
  FISHAUDIO_MODEL: "s2.1-pro",
  COST_FISHAUDIO_USD_PER_1M_BYTES: "15.00",
  HUME_API_KEY: "",
  HUME_VOICE_ID: "",
  HUME_VERSION: "",
  COST_HUME_USD_PER_1K_CHARS: "0.15",
  SECONDS_PER_VISUAL: "4.5",
  UPLOAD_MAX_MINUTES: "50",
  BEAT_MIN_SEC: "3",
  BEAT_MAX_SEC: "10",
  VIDEO_MIN_MOVING_FRAMES: "8",
  AUDIO_LOUDNORM: "1",
  AUDIO_TARGET_LUFS: "-14",
  AVATAR_FREQUENCY_PERCENT: "15",
  AVATAR_SYNC_OFFSET_MS: "0",
  REAL_RATIO_PERCENT: "50",
  VISUAL_MODE: "mix",
  FOOTAGE_SOURCES: "youtube,storyblocks,pexels,pixabay,openverse,wikimedia,archive,web,wigolo",
  REAL_MATCH_THRESHOLD: "85",
  REAL_MEDIA: "auto",
  AI_MATCH_THRESHOLD: "75",
  VISION_MATCH_MODEL: "gemini-3.1-flash-lite",
  AI_REGEN_ATTEMPTS: "5",
  STORYBLOCKS_API_KEYS: "",
  STORYBLOCKS_MAX_DOWNLOADS_PER_RUN: "0",
  PIXABAY_API_KEY: "",
  OPENVERSE_TOKEN: "",
  GOOGLE_CSE_KEY: "",
  GOOGLE_CSE_CX: "",
  // The address of the daemon the app installs and starts for itself, so ticking the
  // checkbox is the whole opt-in. This used to default to EMPTY, from when wigolo had to be
  // installed by hand and an unset address was the honest way to say "not available here".
  // Once npm install ships the binary and `predev` runs it, that default silently disabled
  // the source for every install: the daemon was up, the box was ticked, and the app had
  // nowhere to send the query. Empty is still respected as an off switch — see wigoloSearch.
  WIGOLO_URL: "http://127.0.0.1:3477",
  WIGOLO_API_TOKEN: "",
  // Stock agencies serve watermarked comps, unusable in a finished video. The last three are
  // there for a different reason: they are RE-UPLOAD sites, so the page a search lands on is
  // never the rights holder and gives an operator nothing to check a licence against. A
  // verification run pulled a Pinterest image straight into a video, which is how they got here.
  WIGOLO_EXCLUDE_DOMAINS:
    "alamy.com,gettyimages.com,shutterstock.com,istockphoto.com,dreamstime.com,depositphotos.com,123rf.com,agefotostock.com,freepik.com,pinterest.com,pinimg.com,tumblr.com",
  WIGOLO_MIN_PX: "700",
  WIGOLO_BIN: "",
  AVATAR_BACKGROUND: "",
  VISUAL_CONCURRENCY: "3",
  AVATAR_CONCURRENCY: "2",
  YT_DLP_ENABLED: "1",
  YT_DLP_PATH: "",
  YT_DLP_CC_ONLY: "0",

  // AI provider
  AI_PROVIDER: "kie",
  FLOW_PROJECT_URL: "https://labs.google/fx/tools/flow",
  FLOW_BROWSER_PROFILE_DIR: "",
  FLOW_BROWSER_CHANNEL: "chrome",
  FLOW_BROWSER_EXECUTABLE: "",
  FLOW_BROWSER_HEADLESS: "0",
  FLOW_CDP_PORT: "9223",
  FLOW_GENERATION_TIMEOUT_SEC: "240",
  FLOW_FALLBACK_PROVIDER: "none",
  FLOW_IMAGE_MODEL: defaultAiModel("flow_browser", "image"),
  // Empty by default — an operator opts in once they know their account's limit shape.
  // "nano-banana-2" is the suggested value, not assumed: see flow-browser.ts's
  // ensureImageModel()/generateFlowImage() doc comments for why this isn't hardcoded.
  VIDS_FIRST: "off",
  VIDS_PROJECT_URL: "",
  FLOW_IMAGE_MODEL_FALLBACK: "",
  FLOW_ASPECT_RATIO: "16:9",
  FLOW_REGEN_ATTEMPTS: "1",
  FLOW_PROMPT_SELECTOR: "",
  FLOW_GENERATE_SELECTOR: "",
  FLOW_REFERENCE_FILE_SELECTOR: "",
  FLOW_REFERENCE_REMOVE_SELECTOR: "",
  FLOW_VIDEO_MODEL: defaultAiModel("flow_browser", "video"), // = "veo-3.1-fast"
  // Video generation on Flow legitimately takes minutes (Veo renders, then the UI has to
  // encode/publish the result) — far longer than a Nano Banana still. Kept separate from
  // FLOW_GENERATION_TIMEOUT_SEC so raising one never silently raises the other.
  FLOW_VIDEO_TIMEOUT_SEC: "600",
  FLOW_VIDEO_DURATION_SEC: "8",
  FLOW_VIDEO_DOWNLOAD_SELECTOR: "",
  FLOW_MEDIA_MODE_SELECTOR: "",
  FLOW_ASPECT_RATIO_SELECTOR: "",
  FLOW_DURATION_SELECTOR: "",
  KIE_API_KEY: "",
  KIE_IMAGE_MODEL: defaultAiModel("kie", "image"), // = "google/nano-banana"
  KIE_VIDEO_MODEL: defaultAiModel("kie", "video"), // = "veo3_fast"
  KIE_AI_MEDIA: "image",
  // AI FALLBACK media — what a real beat with no findable footage may generate. NEW
  // installs default to "image" (cheapest, and never an unexpected video bill); existing
  // installs are migrated to "both" (their prior un-gated behaviour — see
  // migrateFallbackAiMediaForExistingInstalls). Only "video"/"both" allow AI video on
  // the fallback path; normal AI mode (a planned AI beat) is unaffected.
  FALLBACK_AI_MEDIA: "image",
  CLOUDFLARE_ACCOUNT_ID: "",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_ACCOUNT_ID_2: "",
  CLOUDFLARE_API_TOKEN_2: "",
  CLOUDFLARE_ACCOUNT_ID_3: "",
  CLOUDFLARE_API_TOKEN_3: "",
  CLOUDFLARE_ACCOUNT_ID_4: "",
  CLOUDFLARE_API_TOKEN_4: "",
  CLOUDFLARE_IMAGE_MODEL: "@cf/black-forest-labs/flux-2-klein-4b",
  POLLINATIONS_API_KEY: "",
  POLLINATIONS_IMAGE_MODEL: "zimage",
  META_API_KEY: "",
  META_API_BASE_URL: "https://api.meta.ai/v1",
  META_IMAGE_MODEL: "muse-image-1.0",
  MAGNIFIC_API_KEY: "",
  MAGNIFIC_ENABLED: "1",
  MAGNIFIC_IMAGE_MODEL: defaultAiModel("magnific", "image"), // = "realism"
  MAGNIFIC_VIDEO_MODEL: defaultAiModel("magnific", "video"), // = "minimax-hailuo-02-1080p"
  MAGNIFIC_RESOLUTION: "2k",
  MAGNIFIC_RETRIES: "3",
  MAGNIFIC_CONCURRENCY: "2",
  RUNWARE_API_KEY: "",
  RUNWARE_IMAGE_MODEL: defaultAiModel("runware", "image"), // = "runware:101@1" (FLUX.1 [dev])
  RUNWARE_RETRIES: "3",
  RUNWARE_CONCURRENCY: "3",
  HIGGSFIELD_API_KEY: "",
  HIGGSFIELD_API_SECRET: "",
  HIGGSFIELD_ENABLED: "1",
  HIGGSFIELD_IMAGE_MODEL: defaultAiModel("higgsfield", "image"), // = "higgsfield-ai/soul/standard"
  HIGGSFIELD_VIDEO_MODEL: defaultAiModel("higgsfield", "video"), // = "higgsfield-ai/dop/standard"
  HIGGSFIELD_RESOLUTION: "1080p",
  HIGGSFIELD_RETRIES: "3",
  HIGGSFIELD_CONCURRENCY: "2",
  SMART_ASSIGN: "0",
  // On by default: beats sharing a topicKey reuse ONE provider gather per broaden
  // attempt, cutting Pexels/stock search volume (the main cause of 429 rate limits).
  // Per-beat vision scoring + usedIds allocation are unchanged.
  TOPIC_POOL: "1",
  PLAN_QUERY_TRIM: "1",
  YT_ROUTING: "1",
  YT_DEBUG: "0",
  YT_SEGMENT: "0",
  YT_PREFER: "1",
  YT_MATCH_THRESHOLD: "72",
  YT_CANDIDATES: "6",
  YT_CLIP_THRESHOLD: "64",
  YT_DEAD_FRAME: "25",
  YT_DEAD_PENALTY: "8",
  YT_EXCELLENT: "85",
  YT_SEGMENT_RETRIES: "1",
  YT_BROLL_SHAPING: "1",
  YT_CROP_RECOVERY: "1",
  YT_CROP_FRACTION: "0.22",
  YT_HEAD_VETO: "1",
  YT_SEPARATE_QUERY: "1",
  YT_TITLE_RERANK: "1",
  YT_RERANK_FLOOR: "58",
  YT_RERANK_RETRIES: "2",
  YT_TEXT_VETO_LIMIT: "3",
  YT_DOWNLOAD_CONCURRENCY: "1",
  HEYGEN_UPLOAD_RETRIES: "2",
  HEYGEN_DOWNLOAD_RETRIES: "2",
  AI_IMAGE_STYLE: "cinematic, photo realistic, natural lighting, documentary",
  AI_CHARACTER_REFERENCE_PATH: "",
  AI_CHARACTER_TERMS: "",
  KIE_IMAGE_EDIT_MODEL: "google/nano-banana-edit",

  // Reliability / scaling
  FAILURE_THRESHOLD_PERCENT: "25",
  AUTO_REUSE_ENABLED: "1",
  AUTO_REUSE_THRESHOLD: "80",
  MAX_FRESH_CLIPS_PER_RUN: "0",
  SCENE_DEDUPE_ENABLED: "1",
  SCENE_DEDUPE_THRESHOLD: "0.7",
  SCENE_DEDUPE_MAX_PASSES: "3",
  ASSEMBLE_XFADE_MAX_SCENES: "150",

  // Google Drive — all empty by default. User fills client_id/secret;
  // OAuth flow fills refresh_token + email; folders auto-create on first sync.
  GDRIVE_CLIENT_ID: "",
  GDRIVE_CLIENT_SECRET: "",
  GDRIVE_REFRESH_TOKEN: "",
  GDRIVE_CONNECTED_EMAIL: "",
  GDRIVE_FINAL_VIDEOS_FOLDER_ID: "",
  GDRIVE_CLIPS_LIBRARY_FOLDER_ID: "",
  GDRIVE_SYNC_ENABLED: "",

  // Cost Monitoring rates — documented public list prices (USD), operator-overridable.
  COST_USD_TO_EUR: "0.92",
  COST_ELEVENLABS_USD_PER_1K_CHARS: "0.22",
  // gemini-3.5-flash (planner/rerank text): $1.50 in / $9.00 out per 1M.
  COST_GEMINI_IN_USD_PER_1M: "1.50",
  COST_GEMINI_OUT_USD_PER_1M: "9.00",
  // gemini-3.1-flash-lite (vision/scoring): $0.25 in / $1.50 out per 1M.
  COST_GEMINI_LITE_IN_USD_PER_1M: "0.25",
  COST_GEMINI_LITE_OUT_USD_PER_1M: "1.50",
  COST_KIE_IMAGE_USD: "0.02",
  COST_KIE_VEO_USD_PER_SEC: "0.40",
  // HeyGen Avatar IV, Photo Avatar @720p/1080p = $3.00/min (HeyGen's published API
  // rate). This is what an avatar beat costs when use_avatar_iv_model is sent.
  // Only applies on avatar beats; overridable in Advanced settings.
  COST_HEYGEN_USD_PER_MIN: "3.00",
  // HeyGen's "Unlimited" motion engine (use_avatar_iv_model omitted) — the other
  // engine their Photo Avatar docs list alongside AvatarIV. HeyGen publishes no
  // explicit line item for it; their documented general rule is "$1 = 1 minute of
  // generated avatar video in 720p or 1080p (standard generation)". Estimate —
  // override if your invoice says otherwise.
  COST_HEYGEN_UNLIMITED_USD_PER_MIN: "1.00",
  // Avatar V (v3). Still an ESTIMATE, but now a measured one. HeyGen publishes an Avatar V
  // rate only for Digital Twin ($0.0667/sec = $4.00/min); Avatar V on an ordinary photo
  // avatar — which the live API renders, contradicting HeyGen's own docs — has no published
  // price. Measured on 2026-07-17: three real avatar beats totalling 14.977s consumed 20
  // plan credits = 80.1 credits/min. That is consistent with $4.00/min if a credit is worth
  // $0.05 — but HeyGen's API exposes no credit→USD rate, so the conversion is NOT verified
  // and this stays an estimate. Override it if your invoice says otherwise.
  // Caveat: consumption rounds up per RENDER (a 1s probe clip cost 2 credits where the
  // measured per-second rate predicts 1.3), so very short avatar beats cost more than this
  // per-second model says. At typical beat lengths (~4-6s) the difference is small.
  COST_HEYGEN_AVATAR_V_USD_PER_MIN: "4.00",
  // 69labs / Grok — default 0 until the operator sets their account rate.
  COST_LABS69_USD_PER_VIDEO: "0",
  COST_LABS69_IMAGE_USD: "0",
  COST_MAGNIFIC_IMAGE_USD: "0",
  COST_MAGNIFIC_VIDEO_USD_PER_SEC: "0",
  COST_RUNWARE_IMAGE_USD: "0",
  COST_HIGGSFIELD_IMAGE_USD: "0",
  COST_HIGGSFIELD_VIDEO_USD_PER_SEC: "0",
  // All default 0: we do NOT invent a price. Usage is recorded either way, and an
  // unset rate is surfaced as "rate not set" on the Costs page, never as €0.00 spend.
  COST_HEYGEN_TTS_USD_PER_1K_CHARS: "0",
  COST_LABS69_TTS_USD_PER_1K_CHARS: "0",
  COST_OPENAI_TTS_USD_PER_1K_CHARS: "0",
  COST_MINIMAX_TTS_USD_PER_1K_CHARS: "0",
  COST_GENAIPRO_TTS_USD_PER_1K_CHARS: "0",
  COST_STORYBLOCKS_USD_PER_DOWNLOAD: "0",
  COST_GOOGLE_CSE_USD_PER_QUERY: "0",
  // Groq whisper-large-v3 published list price: $0.111 per hour of audio. Unlike the
  // 69labs/Magnific rates above this is a REAL public number, so it defaults to the
  // real rate rather than 0 — a transcribed run shows honest (small) spend out of the box.
  COST_GROQ_USD_PER_AUDIO_HOUR: "0.111",
  // ElevenLabs tier default = Creator → $0.22/1k (matches the manual default, so
  // behavior is unchanged out of the box). HeyGen has no tier: its API is pay-as-you-go,
  // priced per engine from the COST_HEYGEN_*_USD_PER_MIN rates above.
  COST_ELEVENLABS_TIER: "Creator",
  BILLING_PROFILES: "{}",
  BILLING_CYCLE_START_DAY: "1",
};

/** Write defaults for any keys that aren't already in the DB. */
export function seedDefaults() {
  // Captured BEFORE the seed loop writes anything: a brand-new DB has an empty settings
  // table here; a pre-existing install already has rows. This is the only reliable
  // fresh-vs-existing signal, because after seeding both look identical — every
  // value-based check (like the youtube migration's) would see the just-written default.
  // migrateFallbackAiMediaForExistingInstalls needs it and nothing else does.
  const preexistingInstall = (settingsCountStmt.get() as { n: number }).n > 0;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const row = getStmt.get(k) as { value: string } | undefined;
    if (!row) upsertStmt.run(k, v);
  }
  forceVideoOnlyMode();
  clearStaleAvatarBackground();
  bumpStaleRegenAttempts();
  migrateStaleSceneSplitModel();
  migrateSceneSplitModelTo35();
  migrateRetiredGeminiModels();
  migrateBlankVisionModel();
  migrateHeygenAvatarIvRate();
  migrateSupersededCostRates();
  enableYoutubeDefaultOnce();
  enableStoryblocksDefaultOnce();
  backfillWigoloUrlOnce();
  widenWigoloExcludeDomainsOnce();
  enableWigoloDefaultOnce();
  migrateFallbackAiMediaForExistingInstalls(preexistingInstall);
  migrateFallbackAiMediaToImageDefault();
}

/**
 * One-time: AI fallback used to generate BOTH images and videos with no gate — and AI
 * video is far pricier than AI images (a real operator was surprised by ~$40 of fallback
 * video). New installs now default FALLBACK_AI_MEDIA to "image" (safe, cheap), but an
 * EXISTING install must keep the behaviour it already had, so we set it to "both" here.
 *
 * `preexistingInstall` is the only thing that distinguishes the two: after seedDefaults,
 * a fresh and an existing DB both hold "image" for this key (the seed loop just wrote it),
 * so nothing about the key's own value could tell them apart. A fresh install (empty
 * settings table at seed time) is left on the "image" default. Idempotent via the flag.
 */
function migrateFallbackAiMediaForExistingInstalls(preexistingInstall: boolean) {
  const flag = getStmt.get("_migration_fallback_ai_media_v1") as { value: string } | undefined;
  if (flag?.value === "1") return;
  if (preexistingInstall) upsertStmt.run("FALLBACK_AI_MEDIA", "both");
  upsertStmt.run("_migration_fallback_ai_media_v1", "1");
}

/**
 * The AI-fallback-media default is now "image" (Images only) for EVERYONE — the safe,
 * cheap default. The v1 migration above had force-set existing installs to "both"
 * (images + videos) to preserve pre-feature behaviour, but "both" reopens the exact
 * surprise-cost hole the gate exists to close (fallback AI *video* billed a real operator
 * ~$40). This one-time v2 pass — run right AFTER v1, so it also catches the value v1 just
 * wrote — returns any install still on that auto-set "both" to "image". A DELIBERATE
 * "video" (or "image") choice is left untouched: this only undoes the automatic bump,
 * never a user's explicit pick. Idempotent via its own flag.
 */
function migrateFallbackAiMediaToImageDefault() {
  const flag = getStmt.get("_migration_fallback_ai_media_v2") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const cur = getStmt.get("FALLBACK_AI_MEDIA") as { value: string } | undefined;
  if (cur?.value === "both") upsertStmt.run("FALLBACK_AI_MEDIA", "image");
  upsertStmt.run("_migration_fallback_ai_media_v2", "1");
}

/**
 * One-time migration: YouTube became an on-by-default footage source, but updates
 * never overwrite already-seeded rows, so existing DBs (anyone who ran an older
 * build) stayed with YouTube OFF. Force the YouTube flags ON exactly once so a
 * pulled/zipped project "just works" without manually ticking the toggle. Runs
 * once (guarded by a marker), so a user who later turns YouTube off stays off.
 */
/**
 * One-time migration: add "storyblocks" to FOOTAGE_SOURCES on existing DBs.
 *
 * DEFAULTS only seed a FRESH database, so shipping the source "on by default" would
 * otherwise reach nobody who already has the app installed. Enabling it costs nothing
 * and cannot break a run: with no STORYBLOCKS_API_KEYS the provider returns an empty
 * list and the beat falls through to the other sources exactly as before.
 * Guarded by a marker, so a user who later unticks it stays unticked.
 */
/**
 * Give an existing install the daemon address it never got.
 *
 * `seedDefaults` only fills MISSING keys, so an install that already ran while the default
 * was empty keeps the empty row forever — checkbox ticked, daemon running, source silently
 * dead. Only an EMPTY value is filled: a deliberately blank address is indistinguishable
 * from an unset one, but the source is off by default anyway, so the cost of guessing wrong
 * is nil while the cost of not guessing is a feature that never works.
 */
function backfillWigoloUrlOnce() {
  const flag = getStmt.get("_migration_wigolo_url_backfill") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("WIGOLO_URL") as { value: string } | undefined;
  if (row && !row.value.trim()) upsertStmt.run("WIGOLO_URL", DEFAULTS.WIGOLO_URL);
  upsertStmt.run("_migration_wigolo_url_backfill", "1");
}

/**
 * Add the re-upload sites to an install that predates them.
 *
 * Replaces the value ONLY when it is byte-identical to the previous default — that proves
 * nobody edited it. A customised list is left exactly as the operator wrote it: appending to
 * someone's deliberate choice is a worse failure than leaving three domains off it.
 */
const WIGOLO_EXCLUDE_DOMAINS_PRE_REUPLOAD =
  "alamy.com,gettyimages.com,shutterstock.com,istockphoto.com,dreamstime.com,depositphotos.com,123rf.com,agefotostock.com,freepik.com";

function widenWigoloExcludeDomainsOnce() {
  const flag = getStmt.get("_migration_wigolo_exclude_reupload") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("WIGOLO_EXCLUDE_DOMAINS") as { value: string } | undefined;
  if (row && row.value.trim() === WIGOLO_EXCLUDE_DOMAINS_PRE_REUPLOAD) {
    upsertStmt.run("WIGOLO_EXCLUDE_DOMAINS", DEFAULTS.WIGOLO_EXCLUDE_DOMAINS);
  }
  upsertStmt.run("_migration_wigolo_exclude_reupload", "1");
}

/**
 * One-time migration: add "wigolo" to FOOTAGE_SOURCES on existing DBs.
 *
 * Shipped OFF, turned ON by the owner's decision (2026-08-11): the source exists to fill the
 * 19% of "real" beats that find nothing and fall through to PAID AI generation, and leaving
 * it behind a checkbox meant every existing install — which is all of them — kept paying for
 * that gap. Same shape as the storyblocks migration: DEFAULTS only seed a FRESH database.
 *
 * Runs after backfillWigoloUrlOnce, so the address is already in place — enabling a source
 * with nowhere to send the query is the failure the URL backfill exists to prevent.
 * Guarded by a marker, so an operator who later unticks it stays unticked. Costs nothing
 * when the daemon is down: wigoloSearch returns an empty list and the beat falls through to
 * the other sources exactly as before.
 */
function enableWigoloDefaultOnce() {
  const flag = getStmt.get("_migration_wigolo_default_on") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const fs = getStmt.get("FOOTAGE_SOURCES") as { value: string } | undefined;
  if (fs) {
    const list = fs.value.split(/[,\n;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!list.includes("wigolo")) upsertStmt.run("FOOTAGE_SOURCES", [...list, "wigolo"].join(","));
  }
  upsertStmt.run("_migration_wigolo_default_on", "1");
}

function enableStoryblocksDefaultOnce() {
  const flag = getStmt.get("_migration_storyblocks_default_on") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const fs = getStmt.get("FOOTAGE_SOURCES") as { value: string } | undefined;
  if (fs) {
    const list = fs.value.split(/[,\n;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!list.includes("storyblocks")) upsertStmt.run("FOOTAGE_SOURCES", [...list, "storyblocks"].join(","));
  }
  upsertStmt.run("_migration_storyblocks_default_on", "1");
}

function enableYoutubeDefaultOnce() {
  const flag = getStmt.get("_migration_youtube_default_on") as { value: string } | undefined;
  if (flag?.value === "1") return;

  // Add "youtube" to the CSV if a row exists but lacks it (fresh DBs already
  // include it from DEFAULTS). Preserve the user's other ticked sources.
  const fs = getStmt.get("FOOTAGE_SOURCES") as { value: string } | undefined;
  if (fs) {
    const list = fs.value.split(/[,\n;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.includes("youtube")) upsertStmt.run("FOOTAGE_SOURCES", ["youtube", ...list].join(","));
  }
  // Open the yt-dlp gate + YouTube-first routing (matches the shipped defaults).
  upsertStmt.run("YT_DLP_ENABLED", "1");
  upsertStmt.run("YT_ROUTING", "1");
  upsertStmt.run("YT_PREFER", "1");
  // Quality flags tuned + validated on our runs — without these YouTube returns
  // the old noisy pool (talking-head creators, captioned clips). Force them on so
  // a fresh recipient gets the clean YouTube, not the raw one.
  upsertStmt.run("YT_HEAD_VETO", "1"); // hard-veto third-party talking heads (R1)
  upsertStmt.run("YT_SEPARATE_QUERY", "1"); // dedicated short youtube_query (#1)
  upsertStmt.run("YT_TITLE_RERANK", "1"); // relevance×cleanliness title rerank (#2)
  upsertStmt.run("YT_RERANK_FLOOR", "58"); // early-bail threshold for caption/vlog pools

  upsertStmt.run("_migration_youtube_default_on", "1");
}

/**
 * One-time migration: v0.3.3 seeded AI_REGEN_ATTEMPTS="2" into existing DBs.
 * v0.3.4 raised the default to 5 ("regenerate until it matches"), but updates
 * never overwrite saved values, so users stayed on 2 (only one regeneration).
 * Bump that exact legacy "2" to "5" once; a value the user chose themselves
 * later is left alone (this runs only if the migration flag is unset).
 */
function bumpStaleRegenAttempts() {
  const flag = getStmt.get("_migration_regen_bump_v034") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("AI_REGEN_ATTEMPTS") as { value: string } | undefined;
  if (row && row.value.trim() === "2") {
    upsertStmt.run("AI_REGEN_ATTEMPTS", "5");
  }
  upsertStmt.run("_migration_regen_bump_v034", "1");
}

/**
 * One-time migration: early builds seeded SCENE_SPLIT_MODEL="gemini-flash-latest",
 * an unstable rolling alias that frequently 503s ("model experiencing high load").
 * Updating the app never overwrites existing DB rows, so rewrite that exact legacy
 * value to the pinned "gemini-2.5-flash" once; a model the user chose themselves
 * later is left alone (this runs only if the migration flag is unset).
 */
function migrateStaleSceneSplitModel() {
  const flag = getStmt.get("_migration_scene_split_model_v1") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("SCENE_SPLIT_MODEL") as { value: string } | undefined;
  if (row && row.value.trim() === "gemini-flash-latest") {
    upsertStmt.run("SCENE_SPLIT_MODEL", "gemini-2.5-flash");
  }
  upsertStmt.run("_migration_scene_split_model_v1", "1");
}

/**
 * One-time migration: gemini-2.5-flash (the previous default planner model) has an
 * earliest shutdown of 2026-10-16 (Google names gemini-3.5-flash as its successor).
 * Rewrite the exact old-default value "gemini-2.5-flash" → "gemini-3.5-flash" once,
 * so already-deployed installs move off the retiring model too. Any value the user
 * chose themselves (claude-*, gemini-2.5-pro, a hand-picked model) is NOT this exact
 * string and is left untouched — and even if it were retired, the failover ladder
 * self-heals to a live 3.x model.
 */
function migrateSceneSplitModelTo35() {
  const flag = getStmt.get("_migration_scene_split_model_v2") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("SCENE_SPLIT_MODEL") as { value: string } | undefined;
  if (row && row.value.trim() === "gemini-2.5-flash") {
    upsertStmt.run("SCENE_SPLIT_MODEL", "gemini-3.5-flash");
  }
  upsertStmt.run("_migration_scene_split_model_v2", "1");
}

/**
 * One-time: bump the HeyGen manual-rate default from the old $1.90/min to the
 * Avatar IV rate ($3.00/min), which is what the pipeline actually renders at
 * (use_avatar_iv). Only touches installs still on the exact OLD seeded default
 * ("1.90") — any value the operator configured themselves is left untouched, so
 * the custom-override mechanism is fully preserved. Fresh installs seed "3.00"
 * directly (DEFAULTS), so this only migrates pre-existing DBs. Idempotent via flag.
 */
function migrateHeygenAvatarIvRate() {
  const flag = getStmt.get("_migration_heygen_avatar_iv_rate") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("COST_HEYGEN_USD_PER_MIN") as { value: string } | undefined;
  if (row && row.value.trim() === "1.90") {
    upsertStmt.run("COST_HEYGEN_USD_PER_MIN", "3.00");
  }
  upsertStmt.run("_migration_heygen_avatar_iv_rate", "1");
}

/**
 * One-time: un-freeze Gemini rates left on a SUPERSEDED seeded default.
 *
 * `seedDefaults` only writes a key that is MISSING, so a rate seeded years ago keeps
 * its old value forever even after the code default is raised. Measured on a real
 * install: the DB held $0.30 in / $2.50 out (the gemini-2.5-flash prices) while
 * DEFAULTS had already moved to $1.50 / $9.00 for gemini-3.5-flash — understating
 * every Gemini row by ~5x on input and ~3.6x on output. Nothing surfaced it, because
 * an old default and a deliberate operator override look identical in the settings table.
 *
 * So this only rewrites a value that EXACTLY matches a known previous default. Any
 * other value is the operator's own and is left alone — same contract as
 * `migrateHeygenAvatarIvRate` above. Idempotent via flag.
 *
 * With read-time pricing this reaches history too: correcting the rate here restates
 * every already-recorded Gemini row that carries its token split.
 */
const SUPERSEDED_RATE_DEFAULTS: { key: SettingKey; old: string[]; next: string }[] = [
  { key: "COST_GEMINI_IN_USD_PER_1M", old: ["0.30", "0.3"], next: "1.50" },
  { key: "COST_GEMINI_OUT_USD_PER_1M", old: ["2.50", "2.5"], next: "9.00" },
];

function migrateSupersededCostRates() {
  const flag = getStmt.get("_migration_superseded_cost_rates_v1") as { value: string } | undefined;
  if (flag?.value === "1") return;
  for (const { key, old, next } of SUPERSEDED_RATE_DEFAULTS) {
    const row = getStmt.get(key) as { value: string } | undefined;
    if (row && old.includes(row.value.trim())) upsertStmt.run(key, next);
  }
  upsertStmt.run("_migration_superseded_cost_rates_v1", "1");
}

/**
 * One-time migration: the whole gemini-2.5-* family is now proactively retired
 * (shutdown 2026-10-16). Rewrite BOTH model settings (planner + vision) to their
 * live Gemini-3 replacement if they still name any retired id, so no install runs
 * an EOL model — broader than the v2 migration above, which only caught the exact
 * old default "gemini-2.5-flash". The mapping (replacementForGeminiModel) keeps the
 * model class (flash→3.5-flash, flash-lite→3.1-flash-lite, pro→3.1-pro-preview); a
 * current/user-chosen model is left untouched. Idempotent via the flag.
 */
function migrateRetiredGeminiModels() {
  const flag = getStmt.get("_migration_retire_gemini_25_v3") as { value: string } | undefined;
  if (flag?.value === "1") return;
  for (const key of ["SCENE_SPLIT_MODEL", "VISION_MATCH_MODEL"] as const) {
    const row = getStmt.get(key) as { value: string } | undefined;
    const cur = row?.value?.trim();
    if (cur && isRetiredGeminiModel(cur)) {
      upsertStmt.run(key, replacementForGeminiModel(cur));
    }
  }
  upsertStmt.run("_migration_retire_gemini_25_v3", "1");
}

/**
 * One-time migration: un-freeze VISION_MATCH_MODEL for installs seeded while its
 * default was still "".
 *
 * v0.3.0 (2026-06-14) seeded VISION_MATCH_MODEL: "". The default became
 * "gemini-3.1-flash-lite" on 2026-07-11, but `seedDefaults` only writes a key that is
 * MISSING — so every install created in that window keeps "" forever, and there is no
 * form field to correct it by hand (the key is DB/API-only by design).
 *
 * "" is not inert: all four read sites are `VISION_MATCH_MODEL || SCENE_SPLIT_MODEL`,
 * so the vision scorer silently runs on the PLANNER's model. The two call patterns are
 * nothing alike — the planner makes a handful of calls seconds apart, the scorer fires
 * hundreds back-to-back (measured on a real 5-minute run: 5 planner calls, 275 vision
 * calls). Against gemini-3.5-flash that burst measured 0/20 successes, which is exactly
 * the field report "3.5 falls constantly and it always drops to the 3.1 fallback".
 *
 * Same contract as migrateSupersededCostRates: only the EXACT superseded default ("")
 * is rewritten, so any model the operator picked is left alone. Idempotent via the flag.
 */
function migrateBlankVisionModel() {
  const flag = getStmt.get("_migration_vision_model_default_v1") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("VISION_MATCH_MODEL") as { value: string } | undefined;
  if (row && row.value.trim() === "") {
    upsertStmt.run("VISION_MATCH_MODEL", DEFAULTS.VISION_MATCH_MODEL);
  }
  upsertStmt.run("_migration_vision_model_default_v1", "1");
}

/**
 * One-time migration: early builds seeded AVATAR_BACKGROUND="#101418", which
 * forced HeyGen to render the avatar on a near-black canvas (the pillarbox
 * bars). Updating the app doesn't touch existing DB rows, so clear that exact
 * legacy value once; anything user-chosen is left alone.
 */
function clearStaleAvatarBackground() {
  const flag = getStmt.get("_migration_avatar_bg_clear") as { value: string } | undefined;
  if (flag?.value === "1") return;
  const row = getStmt.get("AVATAR_BACKGROUND") as { value: string } | undefined;
  if (row && row.value.trim().toLowerCase() === "#101418") {
    upsertStmt.run("AVATAR_BACKGROUND", "");
  }
  upsertStmt.run("_migration_avatar_bg_clear", "1");
}

/**
 * One-time correction for users coming from the Hum Conveyer template (Veo →
 * Grok migration). Conveyer Grok runs Grok via 69labs for every scene, so we
 * flip any inherited `veo-*` model IDs to `grok-imagine-video` on first boot.
 * Tracked via a flag so we never overwrite a user's later manual choice.
 */
function forceVideoOnlyMode() {
  const flag = getStmt.get("_migration_grok_video_only") as { value: string } | undefined;
  if (flag?.value === "1") return;

  const rules: Array<[string, (current: string) => string | null]> = [
    ["ANIMATION_PROVIDER", (v) => (v === "off" ? "69labs" : null)],
    ["ANIMATION_RATIO_PERCENT", (v) => (v !== "100" ? "100" : null)],
    ["ANIMATION_DISTRIBUTION", (v) => (v !== "all" ? "all" : null)],
    ["IMAGE_PROVIDER", (v) => (v && v !== "off" ? "off" : null)],
    // Migrate inherited Veo model IDs from Hum Conveyer template → the 69labs video
    // default (from the provider registry — single source, no drift).
    ["ANIMATION_MODEL", (v) => (/^veo/i.test(v) ? defaultAiModel("69labs", "video") : null)],
  ];
  for (const [key, transform] of rules) {
    const row = getStmt.get(key) as { value: string } | undefined;
    if (!row) continue;
    const next = transform(row.value);
    if (next !== null && next !== row.value) {
      upsertStmt.run(key, next);
    }
  }
  upsertStmt.run("_migration_grok_video_only", "1");
}
