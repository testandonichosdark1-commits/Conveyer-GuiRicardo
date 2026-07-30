# Faceless Video Generator

**A local studio for avatar-fronted documentary YouTube videos — powered by a HeyGen avatar, ElevenLabs voiceover, and real internet footage or AI b-roll.**

> 📖 **Non-technical user? Start here:** full step-by-step guide — **[English](./docs/GUIDE-EN.md)** · **[Français](./docs/GUIDE-FR.md)** (installation, API keys, creating avatars/channels/videos, what to type where, costs, troubleshooting).
>
> 🌍 The interface itself is **bilingual (English / French)** — toggle FR/EN in the top-right corner.
>
> 🔄 **Already installed? How to update:** **[docs/UPDATE.md](./docs/UPDATE.md)** (2 minutes; your keys/avatars/videos are kept).

Paste a script. Pick a recurring **avatar** (created once from a single reference photo and memorized with a name). ElevenLabs narrates the whole script, HeyGen brings your avatar to life lip-synced to that narration, and the rest of the screen is filled with **real footage / photos sourced from across the internet** or **AI-generated b-roll** — your choice (AI / real / mix). Still images get a gradual Ken Burns zoom. Everything is stitched into one MP4 ready for YouTube.

Everything runs locally through a simple web interface.

---

## Features

- **Avatar library** — upload a reference photo (or describe one), give it a name, and reuse that ultra-realistic presenter across every video. The avatar appears *occasionally* during the narration (full-screen or sharing the screen with a visual) — you set how often.
- **Your voice, your script** — ElevenLabs narrates the exact script you paste (with word-level timing, so visuals cut to the words).
- **Real or AI visuals** — pull real clips/stills from Pexels, Pixabay, Openverse and Wikimedia (free, licensed), optionally YouTube, or generate AI b-roll (kie.ai nano-banana / Veo, or 69labs Grok) — or mix them.
- **Channels** — save per-channel defaults (visual mode, AI style, visual prompt, interval, format) and pick one in a click.
- **Adjustable pacing** — set how many seconds each image/clip stays on screen.
- **Low cost** — the avatar is rendered only for the beats where it appears, and licensed footage is free.
- **Bilingual UI** — English / French toggle.

---

## Quick start (Git, Node 20+, FFmpeg already installed)

```bash
npm install
npm run dev
```

Open http://localhost:3000 → **Settings** → paste at least:
`HEYGEN_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `KIE_API_KEY`
(plus `GOOGLE_API_KEY` for sharper visual matching, and `PEXELS_API_KEY` / `PIXABAY_API_KEY` for real footage) → Save.

Then:
1. **Avatars** → create an avatar from a photo or a description, wait for **Ready**.
2. *(optional)* **Channels** → create a channel with your style + visual prompt.
3. **Create a video** → paste your script, pick the avatar, choose AI / real / mix, set the pacing → **Create the video**.

Live logs stream on the run page; the finished MP4 appears there (and on the **Jobs** page) when done.

> 💡 Most users should follow the friendly **[step-by-step guide](./docs/GUIDE-EN.md)** instead of this quick start.

---

## Supabase Setup (required — the app is login-gated)

The whole app is private: every page and API is gated behind a login. This is the
**only** manual setup needed for authentication — the app fails to start with a
clear message until it's done. Unlike the provider API keys (which you paste into
**Settings**), Supabase must come from `.env.local` because the auth check runs in
Edge middleware, before the database is reachable.

**1. Create `.env.local` in the project root** with these two lines:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

Use the **publishable** key (safe for the browser, protected by Row-Level
Security). **Never** put the `sb_secret_...` key here — it's an admin key and any
`NEXT_PUBLIC_*` value is shipped to the browser. `.env.local` is gitignored.

**2. Create a Supabase project** at [supabase.com](https://supabase.com). Copy the
**Project URL** and **publishable key** from *Settings → API* into the file above.

**3. Enable Email authentication** — *Authentication → Providers → Email* → enable.

**4. Disable public signups** — in the same Email provider settings, turn **off
"Enable Sign Ups"**. There is no signup UI; accounts are created by you only.

**5. Create users manually** — *Authentication → Users → Add user* (email +
password, auto-confirm). One per person who should have access.

**6. Make yourself admin** — edit your user and set **`app_metadata`** to:

```json
{ "role": "admin" }
```

Admins get the **Settings** page (where the provider API keys live). Everyone else
can use the app but Settings is hidden and blocked. Add `http://localhost:3000` (and
your production HTTPS origin, once deployed) under *Authentication → URL Configuration*.

Restart the dev server after creating/editing `.env.local` (middleware loads once at
startup). Then open http://localhost:3000 → you'll be sent to `/login` → sign in.

---

## Stack

- **Next.js 16** (Turbopack) + **React 19** + **TypeScript** + **Tailwind 4**
- **ElevenLabs** — full-script voiceover + word timings (`/with-timestamps`)
- **HeyGen** — avatar creation (talking photo / photo-avatar group, optional Avatar IV) + talking-head rendering driven by the ElevenLabs audio
- **Pexels / Pixabay / Openverse / Wikimedia** (+ optional yt-dlp YouTube) — real footage & stills
- **kie.ai** (nano-banana images / Veo video) or **xAI Grok via 69labs** — AI b-roll; **Gemini** — per-beat visual queries
- **FFmpeg** — Ken Burns on stills, beat compositing, final mux
- **better-sqlite3** — a local SQLite database in your home folder

See **[docs/DESIGN.md](./docs/DESIGN.md)** for the full architecture and the confirmed external-API details, and **CLAUDE.md** for a developer map.

---

## How it works under the hood

```
script
  │  ElevenLabs → voiceover.mp3 + word timings
  ▼
beats (~N seconds each)  ── Gemini → a visual query per beat
  │
  ├─ avatar beats (~15%) → HeyGen renders the avatar for that beat's audio slice
  └─ b-roll beats        → real footage / stills (Ken Burns) or AI clip
  │
  ▼
FFmpeg composites every beat over the one voiceover → final.mp4
```

---

## A note on YouTube footage

The default footage sources (Pexels, Pixabay, Openverse, Wikimedia) are free for commercial use. The optional **YouTube** source (via yt-dlp) is **off by default**: most YouTube content is copyrighted and downloading it may violate YouTube's Terms. Only enable it for footage you own, that is licensed to you, that is public-domain/Creative-Commons, or that qualifies as fair use — you are responsible for what you publish.

---

## License

MIT — see [LICENSE](./LICENSE).
