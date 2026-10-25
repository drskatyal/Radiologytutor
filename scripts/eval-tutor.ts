/**
 * Tutor eval scorecard.
 *
 *   npm run eval:tutor
 *   npm run eval:tutor -- --live
 *   EVAL_TUTOR_LIVE=1 npm run eval:tutor
 *   npm run eval:tutor -- --json
 *   npm run eval:tutor -- --fixture fixtures/tutor-eval/apical-pneumothorax.json
 *
 * Default mode is deterministic: a text-only fake must fail and a
 * viewer-driving reference must pass. Exit 0 only when that contract holds.
 * --live also scores Gemini (GEMINI_API_KEY). No key is read from the repo.
 * A live failure exits 1 even if the mock contract holds.
 */

import {
  formatContract,
  formatScorecard,
  harnessContractHeld,
  loadTutorFixture,
  scoreTutorSession,
  textOnlyTutor,
  viewerDrivingTutor,
  type SessionScore,
  type TutorEvalContext,
  type TutorTurn,
} from "../lib/harness/tutorEval";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function liveTutor(ctx: TutorEvalContext): Promise<TutorTurn> {
  const { runTeachingPlan } = await import("../lib/gemini");
  const { formatFindingsContextFromCase } = await import("../lib/teachingPrompt");
  const result = await runTeachingPlan({
    question: ctx.beat.prompt,
    history: ctx.history,
    caseTitle: ctx.fixture.case.title,
    modality: ctx.fixture.case.modality,
    mode: ctx.fixture.mode,
    findingsContext: formatFindingsContextFromCase(ctx.fixture.case),
    currentFindingId: ctx.viewer.activeFindingId ?? undefined,
  });
  return { answer: result.answer, actions: result.actions };
}

function summarize(score: SessionScore): Record<string, unknown> {
  return {
    tutorName: score.tutorName,
    hardPass: score.hardPass,
    hardScore: score.hardScore,
    hardPassed: score.hardPassed,
    hardTotal: score.hardTotal,
    worldClass: score.worldClass,
    holes: score.holes,
    beats: score.beats.map((beat) => ({
      beatId: beat.beatId,
      tools: beat.tools,
      drive: beat.drive,
      failed: beat.checks.filter((check) => !check.pass).map((check) => check.id),
    })),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log("Usage: npm run eval:tutor -- [--live] [--json] [--fixture path]");
    return;
  }

  const live = process.argv.includes("--live") || process.env.EVAL_TUTOR_LIVE === "1";
  const json = process.argv.includes("--json");
  const fixture = loadTutorFixture(argValue("--fixture"));

  const textOnly = await scoreTutorSession(fixture, textOnlyTutor, "text-only fake");
  const driver = await scoreTutorSession(fixture, viewerDrivingTutor, "viewer-driving reference");
  const contract = harnessContractHeld(textOnly, driver);

  let liveScore: SessionScore | undefined;
  let liveError: string | undefined;
  if (live) {
    if (!process.env.GEMINI_API_KEY) {
      liveError = "EVAL live mode needs GEMINI_API_KEY in the environment. Nothing was sent.";
    } else {
      try {
        liveScore = await scoreTutorSession(fixture, liveTutor, "gemini live");
      } catch (err) {
        liveError = err instanceof Error ? err.message : "Live tutor failed.";
      }
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          fixtureId: fixture.id,
          contract,
          textOnly: summarize(textOnly),
          driver: summarize(driver),
          live: liveScore ? summarize(liveScore) : null,
          liveError: liveError ?? null,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatScorecard(textOnly));
    console.log("");
    console.log(formatScorecard(driver));
    console.log("");
    console.log(formatContract(textOnly, driver));
    if (liveError) {
      console.log("");
      console.log("LIVE");
      console.log(`  VERDICT   FAIL`);
      console.log(`  ${liveError}`);
    } else if (liveScore) {
      console.log("");
      console.log(formatScorecard(liveScore));
    }
  }

  if (!contract || liveError || (liveScore && !liveScore.hardPass)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
