// Sentence pipeline + duplex-lite barge-in for the attending tour.
// Two clips do not play at once. The next line's TTS fetch starts while the
// current line is still speaking and the viewer is still moving.

/** Next non-blank say after `afterIndex`. Empty when this beat is the last line. */
export function nextGuideSay(
  beats: readonly { say?: string | null }[],
  afterIndex: number
): string {
  for (let i = afterIndex + 1; i < beats.length; i++) {
    const line = beats[i]?.say?.trim() ?? "";
    if (line) return line;
  }
  return "";
}

export type SpaceGesture = "ignore" | "barge" | "push-to-talk";

/**
 * Space while the attending is speaking yields the floor (barge-in) so the
 * learner can answer. Space while idle is push-to-talk. Transcribe / think
 * and a key that is already recording do not start a second capture.
 */
export function spaceGesture(input: {
  code: string;
  repeat: boolean;
  typing: boolean;
  busy: boolean;
  speaking: boolean;
  recording: boolean;
}): SpaceGesture {
  if (input.typing || input.repeat || input.code !== "Space") return "ignore";
  if (input.recording || input.busy) return "ignore";
  if (input.speaking) return "barge";
  return "push-to-talk";
}
