import { describe, it, expect } from "vitest";
import {
  AI33_ENGINES,
  pickTaskId,
  readTaskState,
  describeUnparsed,
  parseVoiceList,
  qualifyVoiceId,
  engineOfVoiceId,
} from "./ai33-response";

/**
 * ai33.pro response reading.
 *
 * Every other provider here was pinned against live requests first. ai33 could not be:
 * keys are issued only to donors and the real API document sits behind Cloudflare + a
 * login, so four field spellings are genuinely unknown (task id, status word, audio URL,
 * credits). These tests therefore pin the TOLERANCE — that each plausible spelling is
 * read, that an absent field is null rather than a default, and above all that an
 * unreadable payload comes back quoted, because the first operator to run ai33 is the
 * probe we could not perform.
 */

describe("pickTaskId — the id to poll with, whatever it is called", () => {
  it("reads the documented spelling", () => {
    expect(pickTaskId({ task_id: "t-1" })).toBe("t-1");
  });

  it("reads the same field nested under a container", () => {
    // Task APIs in this codebase wrap payloads three different ways; all are plausible here.
    expect(pickTaskId({ success: true, data: { task_id: "t-2" } })).toBe("t-2");
    expect(pickTaskId({ result: { id: "t-3" } })).toBe("t-3");
  });

  it("accepts the other plausible spellings, outermost first", () => {
    expect(pickTaskId({ taskId: "camel" })).toBe("camel");
    expect(pickTaskId({ job_id: "j" })).toBe("j");
    // A top-level task_id beats a nested id — the outer scope is searched first.
    expect(pickTaskId({ task_id: "outer", data: { id: "inner" } })).toBe("outer");
  });

  it("accepts a numeric id, which a task API may well return", () => {
    expect(pickTaskId({ id: 12345 })).toBe("12345");
  });

  it("returns null rather than inventing one", () => {
    for (const p of [{}, null, undefined, [], "text", { task_id: "" }, { task_id: "   " }]) {
      expect(pickTaskId(p), JSON.stringify(p)).toBeNull();
    }
  });
});

describe("readTaskState — finishing, failing, and everything unrecognised", () => {
  it("reads a completed task in the documented shape", () => {
    const s = readTaskState({ status: "done", audio_url: "https://cdn/a.mp3", credit_cost: 950 });
    expect(s.phase).toBe("done");
    expect(s.audioUrl).toBe("https://cdn/a.mp3");
    expect(s.credits).toBe(950);
  });

  it("treats a PRESENT audio URL as done even when the status word is unrecognised", () => {
    // The rule that makes an unknown status vocabulary survivable: if ai33 hands us the
    // file, the job is finished whatever it called the state. Without this a working
    // render polls to the deadline and the operator is billed for audio we threw away.
    const s = readTaskState({ status: "SUCCEED", audioUrl: "https://cdn/a.mp3" });
    expect(s.phase).toBe("done");
    expect(s.rawStatus).toBe("SUCCEED");
  });

  it("accepts every plausible spelling of the audio URL", () => {
    for (const k of ["audio_url", "audioUrl", "audio", "output_url", "download_url", "file_url", "url"]) {
      expect(readTaskState({ [k]: "https://cdn/a.mp3" }).audioUrl, k).toBe("https://cdn/a.mp3");
    }
    expect(readTaskState({ data: { audio_url: "https://cdn/n.mp3" } }).audioUrl).toBe("https://cdn/n.mp3");
  });

  it("finds a real-world reply that nested audio_url under metadata instead of the root", () => {
    // Verbatim shape of a live /v1/task/:id response that crashed a run: status="done" at
    // the root, but audio_url (and voice_id, query, a second "data") sit inside "metadata".
    const payload = {
      id: "a3679c5f-0875-41ef-9402-7502937b8fe7",
      status: "done",
      credit_cost: 4935,
      metadata: {
        v3: { provider: "elevenlabs", raw_voice_id: "elevenlabs_cjVigY5qzO86Huf0OWal" },
        data: { model_id: "eleven_multilingual_v2" },
        query: {},
        voice_id: "cjVigY5qzO86Huf0OWal",
        audio_url: "https://cdn.ai33.pro/v3/tts/a3679c5f-0875-41ef-9402-7502937b8fe7_1789563061714.mp3",
      },
    };
    const s = readTaskState(payload);
    expect(s.phase).toBe("done");
    expect(s.audioUrl).toBe("https://cdn.ai33.pro/v3/tts/a3679c5f-0875-41ef-9402-7502937b8fe7_1789563061714.mp3");
  });

  it("ignores anything that is not an http(s) URL", () => {
    // A relative path or a stray word is not audio, and downloading it would write
    // something that is not an mp3 to disk — a silently wrong duration, not a loud failure.
    for (const v of ["/tmp/a.mp3", "pending", "", "ftp://x/a.mp3"]) {
      expect(readTaskState({ audio_url: v }).audioUrl, v).toBeNull();
    }
  });

  it("a recognised FAILURE outranks a leftover URL", () => {
    const s = readTaskState({ status: "failed", audio_url: "https://cdn/a.mp3", error: "voice not found" });
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("voice not found");
  });

  it("recognises the failure words a task API might use", () => {
    for (const w of ["failed", "error", "cancelled", "canceled", "timeout", "REJECTED"]) {
      expect(readTaskState({ status: w }).phase, w).toBe("failed");
    }
  });

  it("recognises the success words even with no URL, so the caller can report the gap", () => {
    for (const w of ["done", "success", "succeeded", "completed", "complete", "finished"]) {
      const s = readTaskState({ status: w });
      expect(s.phase, w).toBe("done");
      expect(s.audioUrl, w).toBeNull();
    }
  });

  it("everything else is pending — an unknown word must never look terminal", () => {
    for (const w of ["queued", "processing", "waiting", "", "sausage"]) {
      expect(readTaskState({ status: w }).phase, w).toBe("pending");
    }
  });

  it("reports MISSING credits as null, never as zero", () => {
    // Zero would mean "this cost nothing", which is a confident claim about money we have
    // no basis for. null means "not reported", and the caller says so out loud.
    expect(readTaskState({ status: "processing" }).credits).toBeNull();
    expect(readTaskState({ status: "done", credit_cost: 0 }).credits).toBe(0);
  });

  it("accepts every plausible spelling of credits, including a numeric string", () => {
    for (const k of ["credit_cost", "credits", "credits_used", "cost", "consumed_credits"]) {
      expect(readTaskState({ [k]: 12 }).credits, k).toBe(12);
    }
    expect(readTaskState({ credits: "34" }).credits).toBe(34);
  });
});

describe("describeUnparsed — the line that turns an unverified contract into a verified one", () => {
  it("quotes the payload verbatim, because that is the whole point", () => {
    const msg = describeUnparsed("create returned no task id", { weird_key: "abc", nested: { x: 1 } });
    expect(msg).toContain("weird_key");
    expect(msg).toContain("abc");
    expect(msg).toContain("create returned no task id");
  });

  it("survives a payload that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeUnparsed("x", cyclic)).not.toThrow();
  });

  it("caps the quote so one bad response cannot flood the run log", () => {
    const msg = describeUnparsed("x", { blob: "y".repeat(10_000) });
    expect(msg.length).toBeLessThan(1000);
  });
});

describe("voice ids carry their own engine — which is why ai33 needs no engine setting", () => {
  it("qualifies a bare id with the engine it was listed under", () => {
    expect(qualifyVoiceId("en-US-GuyNeural", "edge")).toBe("edge:en-US-GuyNeural");
  });

  it("leaves an already-qualified id byte-identical", () => {
    // Whether /v3/voices returns ids prefixed is one of the facts we could not probe. Both
    // answers must produce the same stored value, so that question changes nothing.
    expect(qualifyVoiceId("edge:en-US-GuyNeural", "edge")).toBe("edge:en-US-GuyNeural");
    expect(qualifyVoiceId("minimax:English_Explanatory_Man", "clone")).toBe("minimax:English_Explanatory_Man");
  });

  it("does not mistake a colon inside an id for an engine prefix", () => {
    expect(qualifyVoiceId("weird:name", "vbee")).toBe("vbee:weird:name");
  });

  it("reads the engine back out, and refuses to guess for a bare id", () => {
    expect(engineOfVoiceId("fishaudio:abc")).toBe("fishaudio");
    expect(engineOfVoiceId("CLONE:abc")).toBe("clone");
    for (const v of ["abc", "", null, undefined, "eleven:abc"]) {
      expect(engineOfVoiceId(v), String(v)).toBeNull();
    }
  });

  it("leads with the operator's own cloned voices", () => {
    // A creator opens this list looking for the voice they recorded; burying it under
    // several hundred stock voices reads as "my voice is missing".
    expect(AI33_ENGINES[0]).toBe("clone");
  });
});

describe("parseVoiceList — a picker row must never write an unusable id", () => {
  it("reads the array whatever key it arrived under", () => {
    for (const k of ["voices", "data", "items", "results", "list"]) {
      const r = parseVoiceList({ [k]: [{ voice_id: "a", name: "Anna" }] }, "elevenlabs");
      expect(r, k).toHaveLength(1);
      expect(r[0].voice_id).toBe("elevenlabs:a");
    }
    expect(parseVoiceList([{ id: "b" }], "edge")).toHaveLength(1);
  });

  it("drops entries with no id instead of inventing a placeholder", () => {
    // A row that stores an unusable value fails at synthesis time, when the run has already
    // started — strictly worse than not offering the row at all.
    const r = parseVoiceList({ voices: [{ name: "no id" }, { voice_id: "ok", name: "Ok" }] }, "vbee");
    expect(r).toHaveLength(1);
    expect(r[0].voice_id).toBe("vbee:ok");
  });

  it("labels each voice with its engine, because engines are priced differently", () => {
    const r = parseVoiceList({ voices: [{ voice_id: "x", name: "Sam", gender: "male", language: "en-US" }] }, "edge");
    expect(r[0].name).toBe("Sam (male, en-US) · edge");
    expect(r[0].engine).toBe("edge");
    expect(r[0].cloned).toBeUndefined();
  });

  it("marks the account's own voices as clones", () => {
    const r = parseVoiceList({ voices: [{ voice_id: "mine", name: "My voice" }] }, "clone");
    expect(r[0].cloned).toBe(true);
    expect(r[0].name).toContain("your clone");
  });

  it("dedupes within one engine and survives a junk payload", () => {
    expect(parseVoiceList({ voices: [{ id: "a" }, { voice_id: "a" }] }, "edge")).toHaveLength(1);
    for (const p of [null, undefined, {}, "nope", { voices: "nope" }]) {
      expect(parseVoiceList(p, "edge"), JSON.stringify(p)).toEqual([]);
    }
  });
});
