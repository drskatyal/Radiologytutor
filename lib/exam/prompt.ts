/** No clinical data argument: the examiner cannot accidentally inherit an answer-bearing pack. */
export function examinerPromptPack() {
  return {
    instruction: "ACTIVE MODE: Examiner. Ask one question about observations, then wait. Describe what you see on this series. Hint ladder: neutral observation questions only. Do not name the diagnosis. Answers and reference locations are held by the server and are unavailable before reveal.",
    tools: [] as never[],
  };
}
