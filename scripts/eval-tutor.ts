/**
 * Tutor eval scorecard.
 *
 *   npm run eval:tutor
 *   npm run eval:tutor -- --live
 *   EVAL_TUTOR_LIVE=1 npm run eval:tutor
 *   npm run eval:tutor -- --json
 *   npm run eval:tutor -- --fixture fixtures/tutor-eval/apical-pneumothorax.json
 *
 * Default mode is deterministic. The apical fixture must fail a text-only
 * fake and pass a viewer-driving reference. The LIDC demo guide must be
 * fidelity TAUGHT and world YES, and both a text-only lecture and a silent
 * tool drive must fail. Exit 0 only when those contracts hold.
 * --live also scores Gemini on the selected fixture (GEMINI_API_KEY). No key
 * is read from the repo. A live failure exits 1 even if the mock contract holds.
 * --fixture scores that file only and skips the LIDC scenario.
 */

import { buildLidcTutorFixture } from "../lib/lidcTutorFixture";
import {
  formatContract,
  formatLidcContract,
  formatScorecard,
  guideReplayTutor,
  harnessContractHeld,
  lidcGuideContractHeld,
  loadTutorFixture,
  scoreTutorSession,
  silentToolsTutor,
  textOnlyTutor,
  viewerDrivingTutor,
  type SessionScore,
  type TutorEvalContext,
  type TutorEvalFixture,
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
    findings: ctx.fixture.case.findings.map((finding) => ({
      id: finding.id,
      label: finding.label,
      description: finding.description,
      teachingPoints: finding.teachingPoints,
      order: finding.order,
    })),
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
    fidelityTaught: score.fidelityTaught,
    fidelityMet: score.fidelityMet,
    fidelityRequired: score.fidelityRequired,
    holes: score.holes,
    beats: score.beats.map((beat) => ({
      beatId: beat.beatId,
      tools: beat.tools,
      drive: beat.drive,
      taught: beat.fidelity.taught,
      phases: beat.fidelity.phases.map((phase) => ({ phase: phase.phase, status: phase.status })),
      failed: beat.checks.filter((check) => !check.pass).map((check) => check.id),
    })),
  };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: npm run eval:tutor -- [--live] [--json] [--fixture path]"
    );
    return;
  }

  const live = process.argv.includes("--live") || process.env.EVAL_TUTOR_LIVE === "1";
  const json = process.argv.includes("--json");
  const fixturePath = argValue("--fixture");
  const fixture = loadTutorFixture(fixturePath);
  const includeLidc = !fixturePath;

  const textOnly = await scoreTutorSession(fixture, textOnlyTutor, "text-only fake");
  const driver = await scoreTutorSession(fixture, viewerDrivingTutor, "viewer-driving reference");
  const contract = harnessContractHeld(textOnly, driver);

  let lidc:
    | {
        fixture: TutorEvalFixture;
        textOnly: SessionScore;
        silent: SessionScore;
        driver: SessionScore;
        contract: boolean;
      }
    | undefined;
  if (includeLidc) {
    const lidcFixture = buildLidcTutorFixture();
    const lidcText = await scoreTutorSession(lidcFixture, textOnlyTutor, "text-only fake");
    const lidcSilent = await scoreTutorSession(lidcFixture, silentToolsTutor, "silent tools");
    const lidcDriver = await scoreTutorSession(
      lidcFixture,
      guideReplayTutor,
      "teaching-guide replay"
    );
    lidc = {
      fixture: lidcFixture,
      textOnly: lidcText,
      silent: lidcSilent,
      driver: lidcDriver,
      contract: lidcGuideContractHeld(lidcText, lidcSilent, lidcDriver),
    };
  }

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
          lidc: lidc
            ? {
                fixtureId: lidc.fixture.id,
                contract: lidc.contract,
                textOnly: summarize(lidc.textOnly),
                silent: summarize(lidc.silent),
                driver: summarize(lidc.driver),
              }
            : null,
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
    if (lidc) {
      console.log("");
      console.log(formatScorecard(lidc.textOnly));
      console.log("");
      console.log(formatScorecard(lidc.silent));
      console.log("");
      console.log(formatScorecard(lidc.driver));
      console.log("");
      console.log(formatLidcContract(lidc.textOnly, lidc.silent, lidc.driver));
    }
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

  if (!contract || (lidc && !lidc.contract) || liveError || (liveScore && !liveScore.hardPass)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
