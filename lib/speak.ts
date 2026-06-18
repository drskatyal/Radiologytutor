"use client";

// Tutor narration playback. Prefers ElevenLabs (via our /api/tts route);
// falls back to the browser speechSynthesis if the key is missing or the
// request fails. Supports barge-in: stopSpeaking() cancels both paths so the
// student can interrupt and ask a question.

let currentAudio: HTMLAudioElement | null = null;

export async function speak(text: string, onEnd?: () => void): Promise<void> {
  if (typeof window === "undefined" || !text.trim()) {
    onEnd?.();
    return;
  }

  stopSpeaking();

  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) throw new Error("tts unavailable");

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      onEnd?.();
    };
    await audio.play();
  } catch {
    // Fallback: browser speechSynthesis.
    fallbackSpeak(text, onEnd);
  }
}

function fallbackSpeak(text: string, onEnd?: () => void): void {
  if (!window.speechSynthesis) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.0;
  utter.lang = "en-US";
  if (onEnd) utter.onend = () => onEnd();
  window.speechSynthesis.speak(utter);
}

export function stopSpeaking(): void {
  if (typeof window === "undefined") return;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}
