/**
 * Single source of truth for the settings form schema.
 *
 * Shared between /settings (only `MAIN_GROUPS`) and /advanced (only
 * `ADVANCED_GROUPS`). Editing a field's description here updates it on whatever
 * page renders that group.
 *
 * NOTE: only the settings relevant to Conveyer Grok's actual pipeline are
 * surfaced here. Legacy keys (image generation, ElevenLabs voice fine-tuning,
 * animation ratio/distribution) still exist in SETTING_KEYS / DEFAULTS so old
 * DB rows and code paths don't break — they're just hidden from the UI because
 * Conveyer Grok is video-only with HeyGen TTS and animates every scene.
 */

export interface Field {
  key: string;
  label?: string;
  desc: string;
  examples?: string;
  required?: boolean;
  multiline?: boolean;
  /** If set, renders a <select> dropdown with these options instead of a text input. */
  options?: string[];
}

export interface Group {
  title: string;
  subtitle?: string;
  required?: boolean;
  fields: Field[];
}

export const ALL_GROUPS: Group[] = [
  {
    title: "Required API Keys",
    subtitle: "The bare minimum for the avatar-documentary pipeline: HeyGen (avatar) + ElevenLabs (voice). Add Gemini for smarter visual matching and 69labs for AI b-roll.",
    required: true,
    fields: [
      {
        key: "HEYGEN_API_KEY",
        desc: "HeyGen API key — creates avatars from your reference photos and renders the talking-head clips. Get yours in the HeyGen dashboard → Settings → API.",
        examples: "Sign up / log in at https://app.heygen.com/settings/api",
        required: true,
      },
      {
        key: "ELEVENLABS_API_KEY",
        desc: "ElevenLabs API key — narrates your script (this is the voice you hear, and the audio HeyGen lip-syncs the avatar to).",
        examples: "elevenlabs.io → Profile → API Keys",
        required: true,
      },
      {
        key: "ELEVENLABS_VOICE_ID",
        desc: "The ElevenLabs voice for narration. Pick or clone a voice in ElevenLabs, then paste its voice_id here.",
        examples: "ElevenLabs → Voices → a voice → copy ID (e.g. 21m00Tcm4TlvDq8ikWAM)",
        required: true,
      },
      {
        key: "GOOGLE_API_KEY",
        desc: "Gemini — turns each beat of the narration into a concrete visual search query so real-footage matching is sharp. Optional but recommended (without it the raw beat text is used).",
        examples: "Get it free at https://aistudio.google.com/app/apikey",
      },
      {
        key: "LABS69_API_KEY",
        desc: "Key for AI b-roll (Grok text-to-video) through 69labs.vip — needed for the 'AI images' and the AI part of 'Mix'. Paste multiple keys (one per line) for more parallel jobs. Not needed if you only use real footage.",
        examples: "Single key: vk_abc... · Multiple keys: one per line. Each starts with vk_",
        multiline: true,
      },
    ],
  },
  {
    title: "Avatar & Voice",
    subtitle: "Defaults for the avatar-documentary pipeline. These can be overridden per video on the New Video page.",
    fields: [
      {
        key: "ELEVENLABS_MODEL",
        desc: "ElevenLabs model. `eleven_multilingual_v2` = best quality (10k chars/request). `eleven_flash_v2_5` = cheapest & fastest (40k chars/request). Both return word timings.",
        examples: "eleven_multilingual_v2  ·  eleven_flash_v2_5",
        options: ["eleven_multilingual_v2", "eleven_flash_v2_5"],
      },
      {
        key: "ELEVENLABS_RETRIES",
        desc: "How many times to retry the voiceover call when ElevenLabs returns a TRANSIENT error (500/503, 429 concurrency cap, timeout, network drop) before the run fails. Without this a single ElevenLabs blip crashes the whole video. Permanent errors (bad key/voice, exhausted quota) still fail fast. attempts = retries + 1.",
        examples: "0 = one-shot (old behavior)  ·  3 = default  ·  max 8",
      },
      {
        key: "ELEVENLABS_CONCURRENCY",
        desc: "Max ElevenLabs voiceover requests in flight at once ACROSS ALL simultaneous videos. Running several videos at once can exceed your ElevenLabs plan's concurrent-request cap (a 429) — this queues the extra requests instead. Raise it to match your plan; server CPU is unrelated.",
        examples: "2 = default (safe for low tiers)  ·  ≈ Free 2 / Starter 3 / Creator 5 / Pro 10",
      },
      {
        key: "VISUAL_MODE",
        desc: "Default visual source for a new video. `mix` blends real footage and AI; `real` is real-only; `ai` is AI-only.",
        examples: "mix  ·  real  ·  ai",
        options: ["mix", "real", "ai"],
      },
      {
        key: "REAL_RATIO_PERCENT",
        desc: "In 'mix' mode, the TARGET split between REAL footage and AI generation. Real beats still fall back to AI when no ≥threshold match is found after 3 attempts, so the final mix leans more AI on hard-to-match topics.",
        examples: "50 = half/half (default)  ·  80 = mostly real  ·  100 = prefer real everywhere",
      },
      {
        key: "SECONDS_PER_VISUAL",
        desc: "TARGET length of each scene. Actual scenes vary between BEAT_MIN_SEC and BEAT_MAX_SEC, cutting at sentence/clause pauses.",
        examples: "3 = fast  ·  4.5 = default  ·  6 = slower",
      },
      {
        key: "BEAT_MIN_SEC",
        desc: "Shortest allowed scene (s). A sentence that ends earlier than this merges into the next scene.",
        examples: "3 = default",
      },
      {
        key: "BEAT_MAX_SEC",
        desc: "Hard cap on a scene (s). A long sentence first tries to cut at a comma past the target; only at this cap does it cut mid-sentence.",
        examples: "10 = default  ·  8 = snappier",
      },
      {
        key: "AVATAR_FREQUENCY_PERCENT",
        desc: "What % of beats show the avatar (the rest are b-roll). The opening always shows the avatar. 15% = an occasional recurring presenter.",
        examples: "15 = occasional (default)  ·  30 = frequent host  ·  0 = faceless",
      },
      {
        key: "AVATAR_SYNC_OFFSET_MS",
        desc: "Fine-tune avatar lip timing vs the narration, in milliseconds. Use POSITIVE when the lips run AHEAD of the voice (delays the avatar video), NEGATIVE when the lips LAG BEHIND the voice. Leave 0 unless you consistently notice an offset.",
        examples: "0 = off (default)  ·  120 = lips were early  ·  -120 = lips were late",
      },
      {
        key: "AVATAR_BACKGROUND",
        desc: "Background colour HeyGen renders behind the avatar (hex). LEAVE EMPTY (default): a forced colour shows as bars around a portrait photo. The compositor already fills the frame (crop + blurred background).",
        examples: "empty = no forced background (default)  ·  #FFFFFF (white)",
      },
    ],
  },
  {
    title: "Real Footage Sources",
    subtitle: "Where real b-roll and stills come from. The default stack is licensed/CC and safe for commercial use. Stills get a Ken Burns zoom automatically.",
    fields: [
      {
        key: "FOOTAGE_SOURCES",
        desc: "Priority-ordered list of providers to search for real footage. The first that returns a match wins. Videos are used as-is; still images get a Ken Burns zoom. \"archive\" = archive.org (vintage commercials / industrial & educational films, no key needed).",
        examples: "pexels,pixabay,openverse,wikimedia  ·  archive,wikimedia,pexels",
      },
      {
        key: "PEXELS_API_KEY",
        desc: "Pexels — curated stock video & photos (free, commercial, no attribution). Enter ONE key per line: the app automatically rotates between all configured keys and waits out rate limits, so more keys = fewer pauses. Get one free at pexels.com/api.",
        examples: "563492ad6f917000010000xxxxxxxxxxxx…  (one key per line)",
        multiline: true,
      },
      {
        key: "PIXABAY_API_KEY",
        desc: "Pixabay — stock videos + images (free, commercial, no attribution). One key works for both. Get one at pixabay.com/api/docs.",
        examples: "12345678-abcdef…",
      },
      {
        key: "OPENVERSE_TOKEN",
        desc: "Optional Openverse bearer token for higher rate limits (Openverse also works anonymously). Openverse = huge Creative-Commons image pool; attribution is recorded automatically.",
        examples: "Leave empty to use Openverse anonymously",
      },
      {
        key: "GOOGLE_CSE_KEY",
        desc: "Google Programmable Search API key — enables the 'Web (Google)' footage source (web-wide image search for any topic). Get a key at console.cloud.google.com (enable 'Custom Search API'). Free 100 searches/day, then paid.",
        examples: "AIza…  ·  leave empty to disable web search",
      },
      {
        key: "GOOGLE_CSE_CX",
        desc: "Google Programmable Search engine id (cx) for the 'Web (Google)' source. Create one at programmablesearchengine.google.com, set it to search the entire web, and turn ON Image search. Paste the 'Search engine ID' here.",
        examples: "e.g. a1b2c3d4e5f6g7h8i",
      },
      {
        key: "STOCK_FOOTAGE_ORIENTATION",
        desc: "Orientation to request — landscape for 16:9, portrait for 9:16 shorts.",
        examples: "landscape / portrait / square",
        options: ["landscape", "portrait", "square"],
      },
      {
        key: "REAL_MATCH_THRESHOLD",
        desc: "Relevance bar (0–100) applied to BOTH real footage and AI images. Gemini-vision looks at each candidate and scores its fit to the scene + the whole-video topic. Real clips below the bar fall through to other sources then to AI; AI images below the bar are regenerated until one clears the bar (up to AI_REGEN_ATTEMPTS). Requires GOOGLE_API_KEY. Higher = stricter & slower.",
        examples: "85 = strict (default)  ·  75 = balanced  ·  0 = off (accept any match)",
      },
      {
        key: "AI_REGEN_ATTEMPTS",
        desc: "Max times an AI image is regenerated while it scores below REAL_MATCH_THRESHOLD (off-topic, low quality, or baked-in text). It keeps going until one clears the bar, up to this cap; if the cap is hit the best attempt is kept. Higher = better quality but slower/costlier.",
        examples: "5 = default (try until it matches)  ·  3 = faster  ·  1 = off (no regeneration)",
      },
      {
        key: "YT_DLP_ENABLED",
        desc: "⚠️ Allow sourcing footage from YouTube via yt-dlp. OFF by default — YouTube content is copyrighted and downloading may violate YouTube's Terms of Service. Only enable if you own / are licensed for / have fair-use grounds for the footage. You are responsible for what you publish.",
        examples: "empty = off (default)  ·  1 = on (advanced, at your own risk)",
        options: ["", "1"],
      },
      {
        key: "YT_DLP_PATH",
        desc: "Path to yt-dlp(.exe) if it isn't on your system PATH. Only used when the YouTube source is enabled.",
        examples: "C:\\tools\\yt-dlp.exe",
      },
      {
        key: "YT_DLP_CC_ONLY",
        desc: "Only use Creative-Commons-licensed YouTube videos (the uploader explicitly allowed reuse) — much lower copyright / Content-ID risk. Strongly recommended ON. Turn off only if you have your own rights/fair-use grounds. CC clips still require attribution (add the source link in your description).",
        examples: "1 = Creative Commons only (default, recommended)  ·  0 = any video (your risk)",
        options: ["1", "0"],
      },
    ],
  },
  {
    title: "Storage Location",
    subtitle: "Where the generated audio and final videos are saved on disk.",
    fields: [
      {
        key: "RUNS_OUTPUT_DIR",
        desc: "Absolute folder path for run outputs. Leave empty to use the default location inside your user profile (~/.conveyer-grok/runs). The settings database itself stays in the default location regardless.",
        examples: "Mac: /Users/you/Documents/Conveyer-Runs  ·  Windows: D:\\YouTube\\Conveyer-Runs",
      },
      {
        key: "FFMPEG_PATH",
        desc: "Absolute path to the FFmpeg binary. Only needed if FFmpeg is not in your system PATH. The platform requires FFmpeg for video assembly.",
        examples: "Mac: /opt/homebrew/bin/ffmpeg  ·  Windows: C:\\ffmpeg\\bin\\ffmpeg.exe  ·  Leave empty if `ffmpeg` works in your terminal",
      },
    ],
  },
  {
    title: "Script Breakdown (LLM)",
    subtitle: "How your script gets divided into scenes, and which language model does the splitting.",
    fields: [
      {
        key: "SCENE_SPLIT_PROVIDER",
        desc: "Which LLM service splits your script into scenes. Gemini is cheap and fast (recommended). Claude is more thorough but costs more.",
        examples: "google  or  anthropic",
      },
      {
        key: "SCENE_SPLIT_MODEL",
        desc: "Specific model id. For Google, the `-latest` alias auto-tracks the current stable Flash. For Anthropic use the full model id.",
        examples: "gemini-flash-latest, gemini-2.5-flash, gemini-2.5-pro",
      },
    ],
  },
  {
    title: "Voice Over (TTS)",
    subtitle: "Conveyer Grok uses HeyGen by default — set HEYGEN_API_KEY + HEYGEN_VOICE_ID above. The fields here only matter if you switch TTS_PROVIDER away from `heygen` to 69labs / ElevenLabs / OpenAI.",
    fields: [
      {
        key: "TTS_PROVIDER",
        desc: "Which TTS service generates the voiceover. `heygen` is the default for Conveyer Grok (uses HEYGEN_API_KEY + HEYGEN_VOICE_ID). `69labs` routes through the 69labs gateway. `elevenlabs` uses the ElevenLabs API directly. `genaipro` uses GenAIPro Labs (an ElevenLabs reseller, async task API). `openai` uses gpt-4o-mini-tts. `minimax` uses MiniMax T2A v2 (cheap, high-quality, supports voice cloning). `ai33pro` uses ai33.pro's unified v3 endpoint (ElevenLabs/MiniMax/clone/Edge/Kokoro/Vbee/FishAudio behind one async task API).",
        examples: "heygen  /  69labs  /  elevenlabs  /  genaipro  /  openai  /  minimax  /  ai33pro",
        options: ["heygen", "69labs", "elevenlabs", "genaipro", "openai", "minimax", "ai33pro"],
      },
      {
        key: "TTS_MODE",
        desc: "How the voiceover is assembled. `per-scene` (default) = one TTS call per scene, stitched in assembly — fastest, but broadcast-quality voices stitch with audible boundaries every 4-6s. `single-shot` = ONE TTS call for the whole script, Groq Whisper word-aligns scene boundaries back to it, and visuals are muxed under one continuous audio. Requires GROQ_API_KEY. Use single-shot for MiniMax `speech-02-hd` / ElevenLabs v3 — the choppiness vanishes.",
        examples: "per-scene  /  single-shot",
        options: ["per-scene", "single-shot"],
      },
      {
        key: "MINIMAX_API_KEY",
        desc: "MiniMax API key. Required when TTS_PROVIDER=minimax. Get one at platform.minimax.io → API Key (format starts with `sk-api-`).",
        examples: "sk-api-XXXXXXXXXXXXXXXX…",
      },
      {
        key: "MINIMAX_GROUP_ID",
        desc: "MiniMax Group ID — required for TTS API requests (goes in URL query param). Find it at platform.minimax.io → User Center → Basic Information.",
        examples: "514136049094139905",
      },
      {
        key: "MINIMAX_VOICE_ID",
        desc: "MiniMax voice_id (cloned voice or stock voice). Channel profiles can override this per channel.",
        examples: "moss_audio_a30ccfca-55b2-11f1-ae71-da201e9a1a2f  ·  male-qn-qingse  ·  female-shaonv",
      },
      {
        key: "MINIMAX_MODEL",
        desc: "MiniMax TTS model. `speech-02-hd` = best quality. `speech-02-turbo` = faster, slightly lower quality.",
        examples: "speech-02-hd  ·  speech-02-turbo",
        options: ["speech-02-hd", "speech-02-turbo"],
      },
      {
        key: "TTS_VOICE_ID",
        desc: "Voice id for the NON-HeyGen providers (69labs / ElevenLabs / OpenAI). HeyGen ignores this — it uses HEYGEN_VOICE_ID. For ElevenLabs: a voice ID from their library. For OpenAI: a voice name like `alloy`.",
        examples: "ElevenLabs: G17SuINrv2H9FC6nvetn  ·  OpenAI: alloy, onyx, nova",
      },
      {
        key: "TTS_MODEL",
        desc: "Optional model override for non-HeyGen providers. ElevenLabs: `eleven_multilingual_v2` (quality) or `eleven_flash_v2_5` (faster). Leave empty for provider default.",
        examples: "eleven_multilingual_v2, eleven_flash_v2_5, gpt-4o-mini-tts",
      },
      {
        key: "TTS_SPEED",
        desc: "Speech rate. 1.0 = neutral pace. Lower = slower. Applied by HeyGen (clamped 0.5–1.5) and ElevenLabs. 0.93 default sounds slightly more cinematic for documentary narration.",
        examples: "Range 0.5–1.5  ·  default 0.93",
      },
      {
        key: "GROQ_API_KEY",
        desc: "Groq Whisper API key — required when TTS_MODE = single-shot. Used to word-align scene boundaries inside the one-shot voiceover so visuals can be cut to match. Cheapest Whisper option (~$0.11/h audio, ~$0.006 per 3-min video). Get one free at console.groq.com/keys.",
        examples: "gsk_XXXXXXXXXXXXXXXXXXXXXXXX…",
      },
      {
        key: "GENAIPRO_API_KEY",
        desc: "GenAIPro Labs API key. Required when VOICEOVER_PROVIDER = genaipro (avatar documentary mode). GenAIPro is an ElevenLabs reseller exposed through an async task API; word timing is recovered via Groq Whisper (set GROQ_API_KEY) or a proportional fallback.",
        examples: "Bearer token from the GenAIPro dashboard",
      },
      {
        key: "GENAIPRO_VOICE_ID",
        desc: "GenAIPro narration voice_id (from the GenAIPro voice library / GET /labs/voices). A channel profile's voice_id overrides this per channel.",
        examples: "21m00Tcm4TlvDq8ikWAM",
      },
      {
        key: "GENAIPRO_MODEL",
        desc: "GenAIPro model_id — an ElevenLabs model name. `eleven_multilingual_v2` (quality, default) / `eleven_turbo_v2_5` / `eleven_flash_v2_5` (faster) / `eleven_v3`.",
        examples: "eleven_multilingual_v2  /  eleven_turbo_v2_5  /  eleven_flash_v2_5  /  eleven_v3",
        options: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_v3"],
      },
      {
        key: "AI33PRO_API_KEY",
        desc: "ai33pro API key. Required when TTS_PROVIDER / VOICEOVER_PROVIDER = ai33pro. Unified async task API in front of ElevenLabs, MiniMax, voice clones, Edge TTS, Kokoro, Vbee and FishAudio. Word timing is recovered via Groq Whisper (set GROQ_API_KEY) or a proportional fallback.",
        examples: "Copy from the ai33.pro dashboard → API Document (xi-api-key)",
      },
      {
        key: "AI33PRO_VOICE_ID",
        desc: "ai33pro voice_id — MUST include the provider prefix from their Voice Library: elevenlabs_, minimax_, clone_, edge_, kokoro_, vbee_ or fishaudio_. A channel profile's voice_id overrides this per channel.",
        examples: "elevenlabs_hpp4J3VqNfWAUOO0d1Us  ·  minimax_male-qn-qingse  ·  edge_vi-VN-HoaiMyNeural",
      },
    ],
  },
  {
    title: "Video Generation (Grok)",
    subtitle: "How each scene's video clip is generated. Conveyer Grok animates EVERY scene through Grok via 69labs.",
    fields: [
      {
        key: "ANIMATION_PROVIDER",
        desc: "Service for video generation. `69labs` (default) routes to xAI Grok. `replicate` / `fal` open the door to Kling, Luma, etc. Do not set to `off` — Conveyer Grok is video-only and needs a provider.",
        examples: "69labs  (default)  ·  replicate  ·  fal",
      },
      {
        key: "ANIMATION_MODEL",
        desc: "Specific model id. `grok-imagine-video` (xAI Grok) is the Conveyer Grok default — that's what this fork is built around. `veo-video` (Google Veo) is an alternate 69labs option. For Replicate use `kwaivgi/kling-v1.6-pro`.",
        examples: "grok-imagine-video  (default)  ·  veo-video  ·  kwaivgi/kling-v1.6-standard",
      },
      {
        key: "IMAGE_RATIO",
        label: "Aspect ratio",
        desc: "Aspect ratio of the generated video clips. 16:9 for landscape YouTube videos, 9:16 for vertical Shorts/Reels.",
        examples: "16:9 (default)  ·  9:16  ·  1:1",
      },
      {
        key: "ANIMATION_DURATION",
        desc: "Clip length in seconds. IGNORED for Grok (69labs hard-blocks the duration parameter — Grok always returns a fixed ~6s clip) and Veo. Only used for other providers (Kling via Replicate/fal).",
        examples: "empty = provider default  ·  4–10 = explicit (Kling/Replicate only)",
      },
      {
        key: "ANIMATION_KEEP_VEO_AUDIO",
        label: "Keep model ambient audio",
        desc: "Whether to keep the ambient audio the video model bakes into each clip. Default empty — we mute it so only the HeyGen voiceover is heard. Set `1` to layer the model's atmospheric sound behind the narrator. (Key name is legacy — applies to any model.)",
        examples: "empty = mute (default)  ·  1 = keep ambient audio",
      },
    ],
  },
  {
    title: "Video Assembly (FFmpeg)",
    subtitle: "Final stitching step. Controls output resolution, framerate, and how scenes transition into each other.",
    fields: [
      {
        key: "VIDEO_RESOLUTION",
        desc: "Final video resolution. 1920x1080 (1080p) is the YouTube standard. Grok source clips are scaled to fit.",
        examples: "1920x1080, 1280x720, 3840x2160",
      },
      {
        key: "VIDEO_FPS",
        desc: "Frames per second. 24 is cinematic. 30 is YouTube standard. 60 doubles render time and file size.",
        examples: "24, 30, 60",
      },
      {
        key: "SCENE_TRANSITION_MS",
        desc: "Dip-to-black duration per side, in milliseconds. The ON/OFF toggle is per video on the Create Video screen (Advanced options); this only sets how long each fade is. Automatically shortened on very short beats so the fades never overlap.",
        examples: "200 = quick  ·  300 = default  ·  500 = slow",
      },
      {
        key: "TRANSITION_DURATION",
        desc: "Crossfade length between scenes in seconds. 0.5 is a gentle blend. 1.0 is more cinematic and smooths over short clips. 0 disables transitions (instant cuts — faster to render but abrupt).",
        examples: "0.5 = smooth  ·  1.0 = cinematic  ·  0 = no transitions",
      },
      {
        key: "SCENE_TAIL_SILENCE",
        desc: "Silence appended to the END of every scene's audio before assembly. This is how you get breathing room BETWEEN scenes. Raise to 0.6–0.8 if narration feels rushed at sentence endings.",
        examples: "0 = back-to-back  ·  0.4 = natural breath (default)  ·  0.8 = reflective pacing",
      },
      {
        key: "SCENE_DURATION_SECONDS",
        desc: "Fallback clip duration when TTS audio length is somehow unknown. In normal operation this is never used — we measure actual audio length with ffprobe.",
        examples: "default 5",
      },
    ],
  },
  {
    title: "Performance (Concurrency)",
    subtitle: "How many parallel jobs and FFmpeg renders to run at once. Higher = faster but risks rate limits. Defaults are tuned for 69labs's limits.",
    fields: [
      {
        key: "TTS_CONCURRENCY",
        desc: "Simultaneous TTS jobs PER 69labs key. With multiple keys, total = this × number of keys.",
        examples: "default 3  ·  bump to 5–7 on higher-tier plans",
      },
      {
        key: "ANIMATION_CONCURRENCY",
        desc: "Simultaneous video jobs PER 69labs key. 69labs's hard limit is 5 per account. Default 3 leaves retry headroom. Total = this × number of keys. Lower this to 2 if you see lots of 429 'Too many requests' errors.",
        examples: "default 3  ·  max 5 per 69labs account",
      },
      {
        key: "ASSEMBLE_CONCURRENCY",
        desc: "How many FFmpeg clip renders happen in parallel. CPU-bound — set roughly to half your CPU core count.",
        examples: "default 4  ·  raise on 8+ core CPUs",
      },
      {
        key: "VISUAL_CONCURRENCY",
        desc: "Parallel b-roll jobs (real-footage downloads + AI generation) for the avatar pipeline.",
        examples: "default 3",
      },
      {
        key: "AVATAR_CONCURRENCY",
        desc: "Parallel HeyGen avatar-clip jobs. Keep low — HeyGen renders are heavier and rate-limited.",
        examples: "default 2",
      },
      {
        key: "ASSEMBLE_XFADE_CHUNKS",
        desc: "Splits the final crossfade pass into N parallel chunks, then crossfades the chunks together. Massively speeds up assembly for long videos (100+ scenes). Set to 1 to disable. Auto-skipped for short videos (fewer than 3×chunks scenes).",
        examples: "1 = no chunking  ·  4 = default  ·  6-8 for 16+ core CPUs",
      },
    ],
  },
  {
    title: "Visual Source (AI + Stock)",
    subtitle: "Mix AI-generated clips with real Pexels stock footage. STOCK_RATIO_PERCENT controls the split — 0 = full AI (default), 50 = half/half, 100 = all stock. Stock scenes are spread evenly across the video.",
    fields: [
      {
        key: "STOCK_RATIO_PERCENT",
        desc: "What % of scenes pull a REAL Pexels stock clip instead of generating one via Grok/Veo/gemini-omni. 0 = full AI (current behaviour); the rest of the scenes stay AI. Stock scenes are distributed evenly across the timeline. Requires PEXELS_API_KEY.",
        examples: "0 = full AI (default)  ·  50 = half/half  ·  100 = all stock",
      },
      {
        key: "PEXELS_API_KEY",
        desc: "Pexels API key — required when STOCK_RATIO_PERCENT > 0. Free tier: 200 req/hour, 20000/month. Enter ONE key per line to raise the ceiling — the app automatically rotates between all configured keys and waits out rate limits. Get one free at pexels.com/api.",
        examples: "563492ad6f9170000100000xxxxxxxxxxxx…  (one key per line)",
        multiline: true,
      },
      {
        key: "STOCK_FOOTAGE_ORIENTATION",
        desc: "Orientation to request from Pexels. Match your video — landscape for 16:9, portrait for 9:16 shorts.",
        examples: "landscape / portrait / square",
        options: ["landscape", "portrait", "square"],
      },
      {
        key: "STOCK_FOOTAGE_MAX_HEIGHT",
        desc: "Caps the resolution (and file size) of downloaded stock clips. 1080 is plenty for a 1080p render; 720 saves disk/bandwidth on long videos.",
        examples: "720  ·  1080 (default)  ·  2160",
      },
      {
        key: "STOCK_FOOTAGE_MIN_DURATION",
        desc: "Skip Pexels clips shorter than this many seconds — filters out flashy 1-2s stingers that can't cover a scene's narration.",
        examples: "4 = default  ·  6 = stricter",
      },
    ],
  },
  {
    title: "Reliability & Scaling",
    subtitle: "How tolerant a run is of failures, and the confidence bar for Auto library reuse. Matters most at high volume on unreliable nights.",
    fields: [
      {
        key: "FAILURE_THRESHOLD_PERCENT",
        desc: "If more than this percentage of scenes fail, the whole run aborts. Default 25. On unreliable nights (provider glitches) raise it to 60-70 so a partial run survives — you can then Resume it from the run page to regenerate only the missing scenes instead of losing everything.",
        examples: "25 = default (strict)  ·  60-70 = tolerant (keep partial runs)  ·  100 = never abort",
      },
      {
        key: "AUTO_REUSE_THRESHOLD",
        desc: "Confidence percentage for Auto reuse. When a run is in Auto reuse mode (chosen per run on the New Run page), a scene is reused only if its best library match scores at or above this. Higher = stricter (fewer but safer reuses).",
        examples: "80 = default  ·  90 = very strict  ·  70 = aggressive reuse",
      },
      {
        key: "MAX_FRESH_CLIPS_PER_RUN",
        desc: "Hard cap on the number of NEW (Grok-generated) clips per run. After normal auto-reuse, if fresh count is still above this, the pipeline forces additional library reuses at the lowest possible threshold until the cap is met. Useful for predictable per-video cost as the library matures. Set to 0 to disable.",
        examples: "0 = disabled (default)  ·  150 = max 150 fresh per run  ·  200 = balanced",
      },
      {
        key: "SCENE_DEDUPE_ENABLED",
        desc: "After Gemini returns the scene list, walk through it and detect adjacent scenes whose visual_prompt is near-identical. Re-call Gemini just for those duplicate groups with a focused 'give me N different angle/action/prop variations' instruction. Without this, Gemini's tendency to stay faithful to the script means 10-20% of scenes show back-to-back identical shots — looks like freeze-loops in the final video.",
        examples: "1 = on (default)  ·  empty / 0 = off",
        options: ["1", ""],
      },
      {
        key: "SCENE_DEDUPE_THRESHOLD",
        desc: "Word-similarity threshold (0–1, Jaccard) above which adjacent visual_prompts are treated as duplicates and re-varied. Lower = more aggressive (catches looser matches, more re-calls). Higher = only blatant duplicates. 0.7 catches most real cases without false positives.",
        examples: "0.7 = default  ·  0.6 = more aggressive  ·  0.8 = only obvious dupes",
      },
      {
        key: "SCENE_DEDUPE_MAX_PASSES",
        desc: "How many times to re-run the dedupe pass until no adjacent duplicates remain. Gemini duplicates 60-70% of consecutive prompts and a single pass leaves residuals; 2-3 passes clears most of them. Higher = cleaner but more Gemini calls per run. Only used when SCENE_DEDUPE_ENABLED is on.",
        examples: "3 = default  ·  1 = single pass (fastest)  ·  5 = max (cleanest)",
      },
      {
        key: "ASSEMBLE_XFADE_MAX_SCENES",
        desc: "Above this scene count, the assembler falls back from xfade-chunked concat to a simple concat (no transitions). The chunked xfade is memory-heavy and can OOM ffmpeg on 200+ scene Resumes (Bull Network hit SIGKILL on a 436-scene Resume). Default 150 is safe on a 15GB box.",
        examples: "150 = default safe  ·  300 = if you have plenty of RAM  ·  0 = always simple concat",
      },
    ],
  },
  {
    title: "Optional / Alternative Providers",
    subtitle: "Only needed if you switch away from the default Grok + HeyGen stack. Leave empty otherwise.",
    fields: [
      {
        key: "ELEVENLABS_API_KEY",
        desc: "Direct ElevenLabs API key. Only used when TTS_PROVIDER is set to `elevenlabs`.",
        examples: "Sign up at https://elevenlabs.io → Profile → API Keys",
      },
      {
        key: "REPLICATE_API_TOKEN",
        desc: "Replicate token — for using Kling or other video models directly instead of Grok via 69labs.",
        examples: "Sign up at https://replicate.com → Account → API Tokens",
      },
      {
        key: "FAL_API_KEY",
        desc: "fal.ai key — alternative to Replicate for video models.",
        examples: "Sign up at https://fal.ai → API keys",
      },
      {
        key: "ANTHROPIC_API_KEY",
        desc: "Anthropic Claude key. Only used when SCENE_SPLIT_PROVIDER is `anthropic`.",
        examples: "Sign up at https://console.anthropic.com",
      },
      {
        key: "OPENAI_API_KEY",
        desc: "OpenAI key — for backup TTS (gpt-4o-mini-tts) when TTS_PROVIDER is `openai`.",
        examples: "Sign up at https://platform.openai.com",
      },
    ],
  },
  {
    title: "Cost Monitoring Rates",
    subtitle:
      "Per-unit prices for PAY-AS-YOU-GO providers (Gemini, kie.ai), used by the Costs page. Defaults are documented public list prices in USD, converted to EUR — set them to YOUR actual rates. Subscription providers (ElevenLabs, HeyGen) are NOT configured here: pick your plan directly on the Costs page under “Billing setup”. The Costs page shows estimates from these numbers, not provider invoices.",
    fields: [
      {
        key: "COST_USD_TO_EUR",
        label: "USD → EUR rate",
        desc: "Exchange rate used to convert provider USD list prices into the EUR shown on the Costs page.",
        examples: "e.g. 0.92",
      },
      {
        key: "BILLING_CYCLE_START_DAY",
        label: "Billing cycle start day",
        desc: "Day of the month (1–28, UTC) the Costs page uses as the reset point for its billing window — Fixed / Variable / quota / overage all reconcile within this period. Default 1 = plain calendar month. Set it to your provider's real reset day for more accurate quota/overage; it approximates the cycle (ElevenLabs credit rollover is not modelled).",
        examples: "1 = calendar month · e.g. 14 if your plan resets on the 14th",
      },
      {
        key: "COST_GEMINI_IN_USD_PER_1M",
        label: "Gemini — USD per 1M input tokens",
        desc: "Input/prompt token price for the planner, title-rerank and vision scoring model. Default 0.30 = Gemini 2.5 Flash.",
        examples: "2.5 Flash = 0.30",
      },
      {
        key: "COST_GEMINI_OUT_USD_PER_1M",
        label: "Gemini — USD per 1M output tokens",
        desc: "Output token price for the same Gemini model. Default 2.50 = Gemini 2.5 Flash.",
        examples: "2.5 Flash = 2.50",
      },
      {
        key: "COST_KIE_IMAGE_USD",
        label: "kie.ai nano-banana — USD per image",
        desc: "Cost per generated AI still (counts every regeneration attempt). Set to your kie.ai credit cost per image.",
        examples: "e.g. 0.02",
      },
      {
        key: "COST_KIE_VEO_USD_PER_SEC",
        label: "kie.ai Veo — USD per video-second",
        desc: "Cost per second of generated Veo AI video.",
        examples: "e.g. 0.40",
      },
      {
        key: "COST_MAGNIFIC_IMAGE_USD",
        label: "Magnific (Mystic) — USD per image",
        desc: "Cost per generated Magnific AI still (counts every regeneration attempt). Magnific bills in credits with no public per-image USD price — default 0 records usage at €0 until you set your rate.",
        examples: "e.g. 0.02",
      },
      {
        key: "COST_MAGNIFIC_VIDEO_USD_PER_SEC",
        label: "Magnific (Hailuo) — USD per video-second",
        desc: "Cost per second of generated Magnific AI video (Hailuo renders fixed 6s clips). Default 0 until you set your credit-based rate.",
        examples: "e.g. 0.10",
      },
    ],
  },
];

/** Groups that stay on /settings (Keys & Settings). */
const MAIN_TITLES = new Set(["Required API Keys", "Avatar & Voice", "Real Footage Sources"]);
export const MAIN_GROUPS: Group[] = ALL_GROUPS.filter((g) => MAIN_TITLES.has(g.title));

/** Groups that move to /advanced. */
export const ADVANCED_GROUPS: Group[] = ALL_GROUPS.filter((g) => !MAIN_TITLES.has(g.title));
