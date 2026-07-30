/**
 * Curated starter set for the "Add starter voices" one-click button on /voices —
 * 10 English female + 10 English male Kokoro preset voices (no sample needed,
 * no cloning). Kokoro ships far more (see backend/backends/kokoro_backend.py's
 * KOKORO_VOICES), this is just a sane default so a new install isn't stuck
 * picking one voice at a time.
 */
export interface StarterVoice {
  voiceId: string;
  name: string;
  gender: "female" | "male";
}

export const KOKORO_STARTER_VOICES: StarterVoice[] = [
  // American English female
  { voiceId: "af_alloy", name: "Alloy", gender: "female" },
  { voiceId: "af_aoede", name: "Aoede", gender: "female" },
  { voiceId: "af_bella", name: "Bella", gender: "female" },
  { voiceId: "af_heart", name: "Heart", gender: "female" },
  { voiceId: "af_jessica", name: "Jessica", gender: "female" },
  { voiceId: "af_kore", name: "Kore", gender: "female" },
  { voiceId: "af_nicole", name: "Nicole", gender: "female" },
  { voiceId: "af_nova", name: "Nova", gender: "female" },
  { voiceId: "af_river", name: "River", gender: "female" },
  { voiceId: "af_sarah", name: "Sarah", gender: "female" },
  // American + British English male (American only has 9, so one British voice
  // (Daniel) rounds this out to 10).
  { voiceId: "am_adam", name: "Adam", gender: "male" },
  { voiceId: "am_echo", name: "Echo", gender: "male" },
  { voiceId: "am_eric", name: "Eric", gender: "male" },
  { voiceId: "am_fenrir", name: "Fenrir", gender: "male" },
  { voiceId: "am_liam", name: "Liam", gender: "male" },
  { voiceId: "am_michael", name: "Michael", gender: "male" },
  { voiceId: "am_onyx", name: "Onyx", gender: "male" },
  { voiceId: "am_puck", name: "Puck", gender: "male" },
  { voiceId: "am_santa", name: "Santa", gender: "male" },
  { voiceId: "bm_daniel", name: "Daniel", gender: "male" },
];
