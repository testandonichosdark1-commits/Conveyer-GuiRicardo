import db from "./db";

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
  "AI33PRO_API_KEY",         // ai33pro API key
  "AI33PRO_VOICE_ID",        // ai33pro voice_id
  "REPLICATE_API_TOKEN",     // Replicate (Flux / Kling)
  "ANTHROPIC_API_KEY",       // Claude (alternative to Gemini)
  "OPENAI_API_KEY",          // OpenAI TTS / image backup
  "FAL_API_KEY",             // fal.ai (alternative to Replicate)
  "FFMPEG_PATH",             // absolute path to ffmpeg.exe if not in system PATH

  // ── Storage ───────────────────────────────────────────────────────
  "RUNS_OUTPUT_DIR",         // where run folders are written. Empty = default

  // ── Scene splitting (LLM) ─────────────────────────────────────────
  "SCENE_SPLIT_PROVIDER",    // google | anthropic
  "SCENE_SPLIT_MODEL",       // e.g. gemini-2.5-flash, claude-sonnet-4-6

  // ── Text-to-Speech ────────────────────────────────────────────────
  "TTS_PROVIDER",            // heygen (default) | 69labs | elevenlabs | openai | minimax | genaipro | ai33pro
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
  "VOICEOVER_PROVIDER",        // elevenlabs (direct, word-timestamps) | genaipro | 69labs | heygen | minimax | ai33pro
  "ELEVENLABS_VOICE_ID",       // ElevenLabs narration voice_id (the script voiceover)
  "ELEVENLABS_MODEL",          // eleven_multilingual_v2 (default) | eleven_flash_v2_5
  "ELEVENLABS_RETRIES",        // retries for the voiceover call on TRANSIENT failures (500/503/429/timeout/network) before the run fails. Permanent 4xx (bad key/voice/quota) fail fast. attempts = retries + 1. 0 = one-shot. Default 3 (clamped 0–8).
  "ELEVENLABS_CONCURRENCY",    // max CONCURRENT ElevenLabs voiceover requests PROCESS-WIDE (across all simultaneous runs) so several videos don't exceed the account's per-plan concurrency cap. Default 2 (clamped 1–15); raise to match your plan (≈ Free 2 / Starter 3 / Creator 5 / Pro 10).
  "GENAIPRO_API_KEY",          // GenAIPro Labs (ElevenLabs reseller) API key — async TTS task API
  "GENAIPRO_VOICE_ID",         // GenAIPro narration voice_id (from GET /labs/voices)
  "GENAIPRO_MODEL",            // ElevenLabs model name: eleven_multilingual_v2 (default) | eleven_turbo_v2_5 | eleven_flash_v2_5 | eleven_v3
  "SECONDS_PER_VISUAL",        // seconds each image/clip stays on screen (default 4.5)
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
  "AI_MATCH_THRESHOLD",        // 0–100. Early-exit bar for AI image regeneration. Empty = REAL_MATCH_THRESHOLD / 75. (AI typically scores 68–78, so a lower bar avoids wasted regens.)
  "VISION_MATCH_MODEL",        // Gemini model used to visually score footage candidates (vision). Empty = SCENE_SPLIT_MODEL / gemini-2.5-flash.
  "AI_REGEN_ATTEMPTS",         // 1–3. AI images are scored like real footage; below REAL_MATCH_THRESHOLD they regenerate up to this many tries (default 2). 1 = off.
  "PIXABAY_API_KEY",           // Pixabay (images + videos). Free, no attribution.
  "OPENVERSE_TOKEN",           // Optional Openverse bearer token for higher rate limits
  "GOOGLE_CSE_KEY",            // Google Programmable Search (Custom Search JSON API) key — web image search ("web" source)
  "GOOGLE_CSE_CX",             // Google Programmable Search engine id (cx) — must have Image search ON
  "AVATAR_BACKGROUND",         // HeyGen avatar background color (hex) + placeholder color
  "VISUAL_CONCURRENCY",        // parallel b-roll fetch/gen jobs (default 3)
  "AVATAR_CONCURRENCY",        // parallel HeyGen avatar-clip jobs (default 2)
  "YT_DLP_ENABLED",            // "1" to allow the yt-dlp YouTube source (ON by default; note copyright/ToS risk)
  "YT_DLP_PATH",               // path to yt-dlp(.exe) if not on PATH
  "YT_DLP_CC_ONLY",            // DEPRECATED — CC gating removed; retained for backward compat but no longer read. Default "0".

  // ── AI provider (kie.ai nano-banana/Veo, or 69labs Grok) ──────────
  "AI_PROVIDER",               // kie | 69labs — engine for AI b-roll + avatar-from-text image
  "KIE_API_KEY",               // kie.ai API key (nano-banana images, Veo video)
  "KIE_IMAGE_MODEL",           // kie.ai image model id (nano-banana)
  "KIE_VIDEO_MODEL",           // kie.ai video model id (Veo)
  "KIE_AI_MEDIA",              // image (force nano-banana stills — DEFAULT, Veo off) | video (force Veo) | auto (per-beat routing)
  // Magnific AI — one more AI b-roll backend (Mystic image + Ken Burns, or Hailuo video).
  // Selectable as AI_PROVIDER=magnific; when ENABLED it also acts as a fallback for kie/69labs.
  "MAGNIFIC_API_KEY",          // Magnific AI API key (x-magnific-api-key)
  "MAGNIFIC_ENABLED",          // 1 (available as provider + fallback) | 0 (never used) — DEFAULT 1
  "MAGNIFIC_IMAGE_MODEL",      // Mystic model id: zen | flexible | fluid | realism (DEFAULT) | super_real | editorial_portraits
  "MAGNIFIC_VIDEO_MODEL",      // Hailuo image-to-video model path segment (DEFAULT minimax-hailuo-02-1080p)
  "MAGNIFIC_RESOLUTION",       // Mystic resolution: 1k | 2k (DEFAULT) | 4k
  "MAGNIFIC_RETRIES",          // retries on TRANSIENT Magnific failures (429/5xx/timeout/network) before failing over. Permanent 4xx fail fast. Default 3 (clamped 0–8).
  "MAGNIFIC_CONCURRENCY",      // max CONCURRENT Magnific requests PROCESS-WIDE (across all runs). Default 2 (clamped 1–15).
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
  // Master switch. Empty/"0" = disabled (don't upload). "1" = upload after every run.
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
  // Gemini 2.5 Flash token rates (the planner/rerank/vision model). $/1M tokens.
  "COST_GEMINI_IN_USD_PER_1M",
  "COST_GEMINI_OUT_USD_PER_1M",
  // kie.ai AI media. nano-banana = per generated image; Veo = per video-second.
  "COST_KIE_IMAGE_USD",
  "COST_KIE_VEO_USD_PER_SEC",
  // DEPRECATED (see COST_ELEVENLABS_USD_PER_1K_CHARS note). HeyGen per-minute rate.
  "COST_HEYGEN_USD_PER_MIN",
  // 69labs / Grok b-roll, per generated video. No public per-unit list price, so
  // default 0 (records the unit count but €0 amount) until the operator sets the
  // rate from their account. Fixes the old hardcoded €0 blind spot.
  "COST_LABS69_USD_PER_VIDEO",
  // Magnific AI — credit-based billing with no public per-unit USD rate, so both
  // default 0 (unit count recorded, €0/estimated) until the operator sets a rate.
  "COST_MAGNIFIC_IMAGE_USD",
  "COST_MAGNIFIC_VIDEO_USD_PER_SEC",
  // DEPRECATED subscription tier pickers — plan selection now lives solely in
  // BILLING_PROFILES (chosen on the Costs page). Kept only so pricing.ts + existing
  // DB rows keep resolving; removed from the Settings UI. No displayed number uses them.
  "COST_ELEVENLABS_TIER",
  "COST_HEYGEN_TIER",
  // Per-provider billing profiles (JSON): which providers are on a subscription vs
  // pay-as-you-go, and the chosen plan / custom monthly fee. Drives the Cost page's
  // honest per-provider view. Not secret. See src/lib/billing.ts.
  "BILLING_PROFILES",
  // Day-of-month (1–28) the billing cycle resets on — the single clock for the Cost
  // page's Fixed/Variable/quota/overage window. Default "1" = plain UTC calendar month.
  "BILLING_CYCLE_START_DAY",
] as const;

/** Keys whose values are secrets and should be masked when sent to the UI. */
function isSecretKey(key: string): boolean {
  return key.includes("KEY") || key.includes("TOKEN") || key.includes("SECRET");
}

export type SettingKey = (typeof SETTING_KEYS)[number];

const getStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertStmt = db.prepare(
  "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
);

export function getSetting(key: SettingKey): string {
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
        masked[k] = parts.map((p) => `${p.slice(0, 4)}…${p.slice(-4)}`).join("\n");
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
  AI33PRO_API_KEY: "",
  AI33PRO_VOICE_ID: "",
  REPLICATE_API_TOKEN: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  FAL_API_KEY: "",
  FFMPEG_PATH: "",

  // Storage — empty = use default (DATA_DIR/runs)
  RUNS_OUTPUT_DIR: "",

  // Scene split
  SCENE_SPLIT_PROVIDER: "google",
  SCENE_SPLIT_MODEL: "gemini-2.5-flash",

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
  IMAGE_MODEL: "nano-banana-pro",
  IMAGE_RATIO: "16:9",
  IMAGE_RESOLUTION: "1k",

  // Animations — Conveyer Grok animates EVERY scene through Grok via 69labs.
  ANIMATION_PROVIDER: "69labs",
  ANIMATION_MODEL: "grok-imagine-video",  // xAI Grok video via 69labs (text-to-video)
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
  SECONDS_PER_VISUAL: "4.5",
  BEAT_MIN_SEC: "3",
  BEAT_MAX_SEC: "10",
  VIDEO_MIN_MOVING_FRAMES: "8",
  AUDIO_LOUDNORM: "1",
  AUDIO_TARGET_LUFS: "-14",
  AVATAR_FREQUENCY_PERCENT: "15",
  AVATAR_SYNC_OFFSET_MS: "0",
  REAL_RATIO_PERCENT: "50",
  VISUAL_MODE: "mix",
  FOOTAGE_SOURCES: "youtube,pexels,pixabay,openverse,wikimedia,archive,web",
  REAL_MATCH_THRESHOLD: "85",
  AI_MATCH_THRESHOLD: "75",
  VISION_MATCH_MODEL: "",
  AI_REGEN_ATTEMPTS: "5",
  PIXABAY_API_KEY: "",
  OPENVERSE_TOKEN: "",
  GOOGLE_CSE_KEY: "",
  GOOGLE_CSE_CX: "",
  AVATAR_BACKGROUND: "",
  VISUAL_CONCURRENCY: "3",
  AVATAR_CONCURRENCY: "2",
  YT_DLP_ENABLED: "1",
  YT_DLP_PATH: "",
  YT_DLP_CC_ONLY: "0",

  // AI provider
  AI_PROVIDER: "kie",
  KIE_API_KEY: "",
  KIE_IMAGE_MODEL: "google/nano-banana",
  KIE_VIDEO_MODEL: "veo3_fast",
  KIE_AI_MEDIA: "image",
  MAGNIFIC_API_KEY: "",
  MAGNIFIC_ENABLED: "1",
  MAGNIFIC_IMAGE_MODEL: "realism",
  MAGNIFIC_VIDEO_MODEL: "minimax-hailuo-02-1080p",
  MAGNIFIC_RESOLUTION: "2k",
  MAGNIFIC_RETRIES: "3",
  MAGNIFIC_CONCURRENCY: "2",
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
  COST_GEMINI_IN_USD_PER_1M: "0.30",
  COST_GEMINI_OUT_USD_PER_1M: "2.50",
  COST_KIE_IMAGE_USD: "0.02",
  COST_KIE_VEO_USD_PER_SEC: "0.40",
  // HeyGen default = $1.90/min — the Creator-tier list price (matches the tier
  // table in pricing.ts). The old $1.50 under-stated avatar cost. Only applies on
  // avatar beats; overridable per plan in Advanced settings.
  COST_HEYGEN_USD_PER_MIN: "1.90",
  // 69labs / Grok — default 0 until the operator sets their account rate.
  COST_LABS69_USD_PER_VIDEO: "0",
  COST_MAGNIFIC_IMAGE_USD: "0",
  COST_MAGNIFIC_VIDEO_USD_PER_SEC: "0",
  // ElevenLabs tier default = Creator → $0.22/1k (matches the manual default, so
  // behavior is unchanged out of the box). HeyGen defaults to Custom = use the
  // manual $/min field above ($1.50 estimate).
  COST_ELEVENLABS_TIER: "Creator",
  COST_HEYGEN_TIER: "Custom",
  BILLING_PROFILES: "{}",
  BILLING_CYCLE_START_DAY: "1",
};

/** Write defaults for any keys that aren't already in the DB. */
export function seedDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const row = getStmt.get(k) as { value: string } | undefined;
    if (!row) upsertStmt.run(k, v);
  }
  forceVideoOnlyMode();
  clearStaleAvatarBackground();
  bumpStaleRegenAttempts();
  migrateStaleSceneSplitModel();
  enableYoutubeDefaultOnce();
}

/**
 * One-time migration: YouTube became an on-by-default footage source, but updates
 * never overwrite already-seeded rows, so existing DBs (anyone who ran an older
 * build) stayed with YouTube OFF. Force the YouTube flags ON exactly once so a
 * pulled/zipped project "just works" without manually ticking the toggle. Runs
 * once (guarded by a marker), so a user who later turns YouTube off stays off.
 */
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
    // Migrate inherited Veo model IDs from Hum Conveyer template
    ["ANIMATION_MODEL", (v) => (/^veo/i.test(v) ? "grok-imagine-video" : null)],
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
