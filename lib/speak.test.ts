import { test } from "node:test";
import assert from "node:assert/strict";
import { primeAttendingSpeech, speak, speakBeats, stopSpeaking } from "./speak.ts";

class FakeUtterance {
  rate = 1;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onstart: (() => void) | null = null;
  constructor(public text: string) {}
}

function installWindow() {
  const g = globalThis as unknown as {
    window: typeof globalThis;
    SpeechSynthesisUtterance: typeof FakeUtterance;
    Audio: new (src?: string) => FakeAudio;
    fetch: typeof fetch;
  };
  g.window = globalThis;
  g.SpeechSynthesisUtterance = FakeUtterance;
  if (typeof URL.createObjectURL !== "function") {
    URL.createObjectURL = () => "blob:test";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    URL.revokeObjectURL = () => {};
  }
}

class FakeAudio {
  paused = true;
  src = "";
  duration = NaN;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  playStarted = false;
  resumeTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(public url?: string) {
    lastAudio = this;
  }
  play(): Promise<void> {
    this.playStarted = true;
    const el = this;
    return new Promise((resolve) => {
      // Playback start is a later task. pause() in between does not stick
      // unless the caller silences this resolution.
      el.resumeTimer = setTimeout(() => {
        el.paused = false;
        el.onplaying?.();
        resolve();
      }, 20);
    });
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  load() {}
}

let lastAudio: FakeAudio | null = null;

test("stopSpeaking cancels a queued utterance before Chrome marks it speaking", async () => {
  installWindow();
  let cancelCount = 0;
  let queued: FakeUtterance | null = null;
  const synth = {
    speaking: false,
    pending: false,
    speak(utter: FakeUtterance) {
      queued = utter;
    },
    cancel() {
      cancelCount += 1;
      const utter = queued;
      queued = null;
      utter?.onerror?.();
    },
  };
  (globalThis as unknown as { speechSynthesis: typeof synth }).speechSynthesis = synth;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
    throw new Error("tts down");
  };

  const pending = speak("Follow the stack.", undefined, { persona: "attending" });
  for (let i = 0; i < 20 && !queued; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(queued, "fallback should queue the look-cue");
  assert.equal(synth.speaking, false);
  assert.equal(synth.pending, false);
  stopSpeaking();
  assert.ok(cancelCount >= 1);
  await pending;
  assert.equal(queued, null);
});

test("a clip that starts after stopSpeaking stays silent", async () => {
  installWindow();
  lastAudio = null;
  (globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () =>
    new Response(new Uint8Array(64));
  (globalThis as unknown as { speechSynthesis: { speak: () => void; cancel: () => void; speaking: boolean; pending: boolean } }).speechSynthesis =
    {
      speaking: false,
      pending: false,
      speak() {},
      cancel() {},
    };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};

  try {
    const pending = speak("Follow the stack.", undefined, { persona: "attending" });
    for (let i = 0; i < 30 && !lastAudio?.playStarted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const audio = lastAudio;
    assert.ok(audio?.playStarted);
    stopSpeaking();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(audio?.paused, true);
    await pending;
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("speakBeats fetches the next sentence while the first fetch is still open", async () => {
  installWindow();
  const fetched: string[] = [];
  let releaseFirst: (() => void) | null = null;
  (globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;
  (globalThis as unknown as { speechSynthesis: { speak: () => void; cancel: () => void; speaking: boolean; pending: boolean } }).speechSynthesis =
    {
      speaking: false,
      pending: false,
      speak() {},
      cancel() {},
    };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (_url, init) => {
    const text = String(JSON.parse(String((init as RequestInit).body)).text);
    fetched.push(text);
    if (fetched.length === 1) {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return new Response(new Uint8Array(64));
  };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  try {
    const pending = speakBeats(["Look here.", "Name the nodule."], { persona: "attending" });
    for (let i = 0; i < 30 && fetched.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.deepEqual(fetched, ["Look here.", "Name the nodule."]);
    releaseFirst?.();
    for (let i = 0; i < 40 && !lastAudio?.playStarted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    lastAudio?.onended?.();
    // Second clip: let it start, then end it so the pipeline can finish.
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (lastAudio && lastAudio.playStarted && lastAudio.onended) {
        const end = lastAudio.onended;
        lastAudio.onended = null;
        end();
      }
    }
    await pending;
  } finally {
    stopSpeaking();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("a primed attending line is not fetched again when it plays", async () => {
  installWindow();
  lastAudio = null;
  let fetches = 0;
  (globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;
  (globalThis as unknown as { speechSynthesis: { speak: () => void; cancel: () => void; speaking: boolean; pending: boolean } }).speechSynthesis =
    {
      speaking: false,
      pending: false,
      speak() {},
      cancel() {},
    };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
    fetches += 1;
    return new Response(new Uint8Array(64));
  };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  try {
    primeAttendingSpeech("Lean in.");
    for (let i = 0; i < 10 && fetches < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(fetches, 1);
    const pending = speak("Lean in.", undefined, { persona: "attending" });
    for (let i = 0; i < 40 && !lastAudio?.playStarted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(fetches, 1);
    lastAudio?.onended?.();
    await pending;
    assert.equal(fetches, 1);
  } finally {
    stopSpeaking();
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("stopSpeaking drops a primed line so the next speak fetches fresh", async () => {
  installWindow();
  lastAudio = null;
  let fetches = 0;
  (globalThis as unknown as { Audio: typeof FakeAudio }).Audio = FakeAudio;
  (globalThis as unknown as { speechSynthesis: { speak: () => void; cancel: () => void; speaking: boolean; pending: boolean } }).speechSynthesis =
    {
      speaking: false,
      pending: false,
      speak() {},
      cancel() {},
    };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => {
    fetches += 1;
    return new Response(new Uint8Array(32));
  };
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => {};
  try {
    primeAttendingSpeech("Follow the stack.");
    for (let i = 0; i < 10 && fetches < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    stopSpeaking();
    const pending = speak("Follow the stack.", undefined, { persona: "attending" });
    for (let i = 0; i < 40 && !lastAudio?.playStarted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const clip = lastAudio;
    assert.ok(clip?.playStarted);
    clip?.onended?.();
    await pending;
    assert.equal(fetches, 2);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
