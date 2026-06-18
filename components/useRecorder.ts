"use client";

// Mic capture via MediaRecorder. We send the recorded audio to the server,
// where Gemini Flash does speech-to-text + reasoning in a single call (no
// separate STT). Surface stays stable so callers don't care what's behind it.

import { useCallback, useRef, useState } from "react";

export interface Recording {
  base64: string;
  mimeType: string;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "audio/webm";
}

export function useRecorder() {
  const supported =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof MediaRecorder !== "undefined";

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);

  const start = useCallback(async () => {
    if (!supported) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const mimeType = pickMime();
    const rec = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.start();
    recorderRef.current = rec;
    setRecording(true);
  }, [supported]);

  /** Stop and resolve with the recorded audio as base64 (no data: prefix). */
  const stop = useCallback((): Promise<Recording | null> => {
    return new Promise((resolve) => {
      const rec = recorderRef.current;
      if (!rec) return resolve(null);
      rec.onstop = async () => {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        const base64 = await blobToBase64(blob);
        resolve({ base64, mimeType: rec.mimeType.split(";")[0] });
      };
      rec.stop();
    });
  }, []);

  return { supported, recording, start, stop };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip "data:audio/webm;base64," prefix.
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
