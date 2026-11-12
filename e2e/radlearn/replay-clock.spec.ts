import { expect, test } from '@playwright/test';
import { authorReplayCase, replayState } from '../support/replayFixture';
test('M8 T6 decoded synthetic beep onsets align with the shared replay clock within 100 ms', async ({ page }) => {
  await page.addInitScript(() => {
    const Base = window.AudioContext;
    const evidence = { beeps: [] as number[], elapsed: 0, phase: '' };
    (window as unknown as { beepEvidence: typeof evidence }).beepEvidence = evidence;
    window.addEventListener('radlearn:replay', event => { const detail = (event as CustomEvent).detail; if (detail.type === 'state') { evidence.elapsed = detail.elapsedMs; evidence.phase = detail.phase; } });
    window.AudioContext = class extends Base {
      createBufferSource() {
        const source = super.createBufferSource(), connect = source.connect.bind(source), analyser = this.createAnalyser();
        analyser.fftSize = 256;
        source.connect = ((destination: AudioNode) => { connect(analyser); analyser.connect(destination); return destination; }) as typeof source.connect;
        const samples = new Float32Array(analyser.fftSize); let high = false;
        const timer = setInterval(() => {
          if (this.state === 'closed') { clearInterval(timer); return; }
          analyser.getFloatTimeDomainData(samples);
          const audible = samples.some(x => Math.abs(x) > .12);
          if (audible && !high && evidence.phase === 'playing') evidence.beeps.push(evidence.elapsed);
          high = audible;
        }, 4);
        return source;
      }
    };
  });
  const { panel } = await authorReplayCase(page);
  await panel.getByRole('button', { name: 'Start exact replay' }).click();
  await expect(panel).toContainText('Exact replay complete.', { timeout: 15000 });
  const measured = await page.evaluate(() => (window as unknown as { beepEvidence: { beeps: number[] } }).beepEvidence.beeps);
  // Ignore multiple analyser observations of the same sustained beep; not separate cues.
  const cues = measured.filter((t, i) => !i || t - measured[i - 1] > 200);
  expect(cues).toHaveLength(2);
  const drifts = cues.map((t, i) => Math.abs(t - [1350, 3350][i]));
  expect(drifts.every(ms => ms <= 100), `Measured cues ${cues}; drift ${drifts} ms`).toBe(true);
  console.log('Synthetic replay beep drift (ms):', JSON.stringify({ measuredMs: cues, driftMs: drifts }));
  await test.info().attach('beep-drift', { body: JSON.stringify({ offsetMs: 350, expectedMs: [1350, 3350], measuredMs: cues, driftMs: drifts }), contentType: 'application/json' });
});
test('M8 T6 an uncertain retained audio gap is detected before replay instead of drifting silently', async ({ page }) => {
  const { panel } = await authorReplayCase(page, 'gap');
  await panel.getByRole('button', { name: 'Start exact replay' }).click();
  await expect(panel.getByRole('alert')).toContainText('Audio gap detected');
  expect((await replayState(page))!.elapsedMs).toBe(0);
});
