# Full guide — Faceless Video Generator

> A step-by-step guide for **beginners**. No technical skills needed.
> You paste a script, and the app builds a complete YouTube video: a voice
> (ElevenLabs), a recurring presenter-avatar (HeyGen) that appears now and then,
> and real or AI-generated images/videos to illustrate the narration. Everything
> runs **on your own computer**. (Version française : [GUIDE-FR.md](./GUIDE-FR.md).)

---

## 1. How it works (in 30 seconds)

```
Your script (text)
      │
      ▼
1) ElevenLabs reads the script out loud  →  the video's voice
      │
      ▼
2) The app splits the narration into small "beats" (using the voice's timing)
      │
      ▼
3) For each beat:
      • sometimes → the AVATAR talks on screen (HeyGen)
      • the rest  → an image/video illustrating the sentence
                    (real footage from the internet  OR  an AI image — your choice)
                    still photos get a slow zoom (the "Ken Burns" effect)
      │
      ▼
4) Everything is assembled into a single MP4 video, ready for YouTube
```

You stay in control: how often the avatar appears, real vs AI, how long each
image stays, the style, and more.

---

## 2. What you need

### A computer
- **Mac** or **Windows** (10/11). Nothing else to buy.

### Two free programs (installed once)
1. **Node.js** (version 20 or newer) — the app's engine.
   Download the "LTS" button at **https://nodejs.org/** and install (Next → Next).
2. **FFmpeg** — assembles the video.
   - **Mac**: open the "Terminal" app and type: `brew install ffmpeg`
     (if `brew` doesn't exist, first install Homebrew from **https://brew.sh/**).
   - **Windows**: download "ffmpeg" from **https://www.gyan.dev/ffmpeg/builds/**
     (the "ffmpeg-release-essentials.zip" file), unzip it, then either add the
     `bin` folder to your PATH, or point the app to the `ffmpeg.exe` file
     (see §9 "FFmpeg not found").

### API keys (the "passwords" for the services)
You paste them **once** into the app (the **Settings** page). Required:

| Service | What it's for | Where to get it |
|---|---|---|
| **HeyGen** | creates & animates the avatar | https://app.heygen.com/settings/api |
| **ElevenLabs** | the voice that reads the script | https://elevenlabs.io → Profile → API Keys |
| **kie.ai** | AI images/videos (nano-banana, Veo) | https://kie.ai/api-key |

Optional (recommended):

| Service | What it's for | Where to get it |
|---|---|---|
| **Google Gemini** | picks better what to show on screen | https://aistudio.google.com/app/apikey (free) |
| **Pexels** | free real footage/photos | https://www.pexels.com/api/ |
| **Pixabay** | free real footage/photos | https://pixabay.com/api/docs/ |

> 💡 You don't need ALL the keys. Minimum to start: **HeyGen + ElevenLabs**
> (avatar + voice) and **kie.ai** (AI visuals). Add Pexels/Pixabay when you want
> real footage.

---

## 3. Installation (once)

1. **Get the project**:
   - Easiest: on the GitHub page, green **"Code" → "Download ZIP"** button, then
     unzip the folder wherever you like (e.g. Documents).
   - (Advanced: `git clone https://github.com/Bander4ik/Conveyer-Patrice.git`)
2. **Install the dependencies** (once):
   - **Mac**: double-click **`install.command`** in the folder.
     *(If macOS blocks it: right-click → Open → Open.)*
   - **Windows**: double-click **`install.bat`**.
   - A black window opens, it downloads for ~1-2 min, then says "Done!".

That's all for installation.

---

## 4. Launch the app (each time you use it)

- **Mac**: double-click **`start.command`**.
- **Windows**: double-click **`start.bat`**.

A black window stays open (this is normal — it's the "engine", don't close it
while you work), and your browser opens **http://localhost:3000**.

To **stop**: close that black window (or use `stop.bat` / `stop.command`).

---

## 5. Configure the keys (the **Settings** page)

Top right, click **Settings**. Paste your keys:

1. **ElevenLabs — API key**: paste the key.
2. **ElevenLabs — voice_id**: this is the VOICE. Click **"Load voices"**, then pick
   a voice from the list (it fills the field automatically).
3. **kie.ai — API key**: paste the key.
4. **HeyGen — API key**: paste the key.
5. **HeyGen — voice_id**: leave as-is (the voice comes from ElevenLabs; this field
   is only used if you make the avatar speak directly without ElevenLabs).
6. **Pexels / Pixabay** (optional): paste if you have them.
7. **Advanced** block: **AI provider** = `kie.ai` (default); **AI media** =
   `Images` (cheaper) or `Video (Veo)` (more realistic, see §8).
8. Click **Save**.

> 🔒 The keys stay **on your computer** (local database). A saved key shows masked
> (•••) — if you don't touch it, it won't change.

---

## 6. Create an avatar (the **Avatars** page)

The avatar is your recurring presenter — created once, reusable everywhere.

1. **Name**: e.g. "Narrator Alex".
2. **Channel (optional)**: leave "All" to make it available everywhere.
3. Choose **ONE** of the two options:
   - **Reference image**: click "Choose file" and upload a sharp, front-facing,
     well-lit photo. **OR**
   - **Text description**: describe the person in English
     (e.g. *"a friendly man in his 30s, short brown hair, blue shirt"*) — the app
     generates the image via nano-banana.
4. (Option) **Avatar IV engine** checked = more realistic (uses more credits).
5. **Create avatar**.

The avatar appears in the grid with a status:
- **Preparing… / Training…**: wait (a few seconds to a few minutes).
- **Ready** ✅: usable in a video.
- **Error**: see the message (often: missing HeyGen key / photo rejected).

---

## 7. Create a channel (the **Channels** page) — optional but handy

A **channel** = a set of default settings, so you don't re-configure everything
each time. Fields:

- **Name**: e.g. "History".
- **Visual mode**: `Mix` (real + AI), `Real footage` (real only) or `AI images`.
- **AI image style (look / animation)**: the style of the AI visuals
  (e.g. *"cinematic, photo realistic"*). This is your **style / animation prompt**.
- **Interval (s)**: how long each image/clip stays on screen (e.g. 4–6 s).
- **Format**: `1920x1080` (classic YouTube) or `1080x1920` (vertical Shorts).
- **Visual prompt (what to show per beat)**: your **"split" prompt**. It guides
  WHAT is searched/shown for each sentence of the narration. **Leave empty** for
  default behavior, or write e.g.:
  *"Historical documentary. For each line, give a 3–8 word visual query of concrete
  nouns: places, objects, real archive footage. Avoid the abstract."*

Click **Create channel**. To change it later: **Edit** on the channel.

---

## 8. Create a video (the **Create a video** page)

1. **Title (optional)**: to find it again.
2. **Channel**: pick one (it pre-fills mode, style, prompt, interval, format) — or
   "None — manual settings".
3. **Script**: paste the full narration text.
4. **Avatar**: pick a **Ready** avatar, or "None" (faceless video).
5. **Visual mode**: `AI images`, `Real footage`, or `Mix`.
6. **Real / AI balance** (in Mix mode): e.g. 80% real / 20% AI.
7. **Seconds per visual**: how long each image/clip lasts.
8. **Avatar on screen (%)**: how often the avatar appears (e.g. 15% = "now and
   then"). Disabled if no avatar is chosen.
9. **Create the video**.

You're taken to the tracking page: the steps show live (voice → beats → visuals →
assembly).

---

## 9. Track the render & get the video (the **Jobs** page)

- Each video shows its **status** (`running`, `done`, `error`) and its **mode**.
- When **done**: click **⬇ mp4** to download, or **Follow** to see details and play it.

⏱️ **How long?** Depends on script length and mode. The slowest parts are the
avatar (HeyGen) and AI video (Veo). A short video: a few minutes; a long one with
lots of avatar: 10–30 min. That's normal.

---

## 10. Tips for a REALISTIC result (important)

"Stock" footage (Pexels/Pixabay) can look too "stock-photo". For an authentic
result like the good YouTube channels:

- **Favor real footage**: push the balance toward **80–100% real**.
- **For the AI part, use Veo**: Settings → Advanced → **AI media = Video (Veo)**.
  Veo produces far more realistic shots than plain images (but costs more).
- **Craft the channel's "Visual prompt"**: ask for concrete imagery (real places,
  objects, archives) rather than abstract concepts.
- **Avatar "now and then"**: 15–25% is enough for a recurring presenter without
  overdoing it.
- **(Advanced) YouTube**: you can enable a YouTube source (full Settings →
  `YT_DLP_ENABLED`), but ⚠️ YouTube content is copyrighted — only use it for
  content that is free / that you have the rights to. Off by default.

---

## 11. How much does it cost?

The app is free; you only pay for the services you use:

- **ElevenLabs**: by the number of characters read (limited free tier, then subscription).
- **HeyGen**: in credits, mainly for the avatar (Avatar IV ≈ 3 s = 1 credit;
  ~$4/min at 1080p on the API). The avatar is only generated for the ~15% of beats
  where it appears → controlled cost.
- **kie.ai**: per generated image/video (Veo costs more than nano-banana images).
- **Pexels / Pixabay / Wikimedia / Openverse**: **free**.
- **Google Gemini**: nearly free (small usage).

> 💡 To keep costs down: **Real footage** mode (free) + a low avatar %, and
> **AI media = Images** rather than Video.

---

## 12. Troubleshooting (common problems)

| Symptom | Fix |
|---|---|
| Avatar stuck on "Preparing" / "Error" | Check the **HeyGen key** (Settings). A blurry or moderation-rejected photo fails — try another photo. |
| "ELEVENLABS…" / no voice | Missing ElevenLabs key or empty **voice_id**. Click "Load voices" and pick one. |
| kie.ai error ("code 402 / 401") | 402 = out of credits on kie.ai; 401 = invalid key. Top up / fix the key. |
| "FFmpeg failed" / no final video | FFmpeg isn't installed. Mac: `brew install ffmpeg`. Windows: install it, or open **full settings** (link at the bottom of Settings) and set **FFMPEG_PATH** to the path of `ffmpeg.exe`. |
| No real footage found | Add a **Pexels** and/or **Pixabay** key (Settings). Without them, the app falls back to AI. |
| The video looks too "stock" | See §10: more real, Veo for AI, a better visual prompt. |
| The black window (Terminal/CMD) closed | That's the engine — relaunch `start.command` / `start.bat`. |
| Vertical format (Shorts) | Create a channel with **Format = 1080x1920** and select it. |

---

## 13. Where are my files stored?

- **Settings, avatars, history**: in a hidden folder of your user profile,
  `~/.faceless-studio` (Mac/Linux) or `C:\Users\YOU\.faceless-studio` (Windows).
  It is **never** deleted by an app update.
- **Generated videos**: in that same folder, under `runs/<name>/final.mp4`
  (also downloadable from the **Jobs** page).

---

## Quick recap

1. Install **Node.js** + **FFmpeg** (once).
2. `install.command` / `install.bat`, then `start.command` / `start.bat`.
3. **Settings** → paste HeyGen + ElevenLabs + kie.ai → Save.
4. **Avatars** → create an avatar (photo or description) → wait for "Ready".
5. *(optional)* **Channels** → create a channel with your style + visual prompt.
6. **Create a video** → paste the script, pick the avatar and mode → **Create the video**.
7. **Jobs** → download the **mp4**.

Tip: use the **FR / EN** toggle (top right) to switch the interface language.

Happy filming! 🎬
