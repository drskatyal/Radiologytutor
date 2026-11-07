import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adoptParkedVoice,
  hasParkedVoice,
  parkVoice,
  PARKED_REPLAY_MAX,
  stopParkedVoice,
  type VoiceSink,
  type VoiceSinkBox,
} from "../packages/viewer-core/src/voiceHandoff";
import type { VoiceAction } from "../packages/viewer-core/src/voiceCommands";
import type { VoiceState } from "../packages/viewer-core/src/voiceSession";

// A fake session whose callbacks go through the box, like startVoice's.
function fakeSession(box: VoiceSinkBox) {
  const s = {
    stopped: 0,
    stop() {
      s.stopped += 1;
      box.current.onState("off");
    },
    hear(action: VoiceAction, heard: string) {
      box.current.onAction(action, heard);
    },
  };
  return s;
}

function recordingSink() {
  const actions: string[] = [];
  const states: VoiceState[] = [];
  const sink: VoiceSink = {
    onAction: (_a, heard) => actions.push(heard),
    onUnrecognized: () => undefined,
    onProgress: () => undefined,
    onState: (state) => states.push(state),
  };
  return { sink, actions, states };
}

const zoomIn: VoiceAction = { type: "zoom", factor: 1.25 };

test("voice handoff: the next series' viewer adopts the live session, gets what was heard in between, and owns its callbacks", () => {
  const first = recordingSink();
  const box: VoiceSinkBox = { current: first.sink };
  const session = fakeSession(box);
  parkVoice(session, box, 60_000);
  assert.ok(hasParkedVoice());
  session.hear(zoomIn, "zoom in"); // said while no viewer is mounted
  assert.deepEqual(first.actions, [], "the unmounted viewer gets nothing");

  const next = recordingSink();
  const adopted = adoptParkedVoice(next.sink);
  assert.ok(adopted);
  assert.equal(adopted.session, session, "the same session: no restart, no deaf gap");
  assert.deepEqual(adopted.heard.map((h) => h.heard), ["zoom in"]);
  assert.equal(hasParkedVoice(), false);

  session.hear(zoomIn, "zoom in");
  assert.deepEqual(next.actions, ["zoom in"], "later commands go to the adopting viewer");
  session.stop();
  assert.deepEqual(next.states, ["off"]);
  assert.equal(session.stopped, 1);
});

test("voice handoff: an unadopted session is stopped after the grace period, and the host can stop it at once", async () => {
  const a = recordingSink();
  const boxA: VoiceSinkBox = { current: a.sink };
  const sessionA = fakeSession(boxA);
  parkVoice(sessionA, boxA, 20);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sessionA.stopped, 1, "the microphone is released");
  assert.equal(hasParkedVoice(), false);
  assert.equal(adoptParkedVoice(recordingSink().sink), null);

  const boxB: VoiceSinkBox = { current: recordingSink().sink };
  const sessionB = fakeSession(boxB);
  parkVoice(sessionB, boxB, 60_000);
  stopParkedVoice();
  assert.equal(sessionB.stopped, 1);
  assert.equal(hasParkedVoice(), false);
});

test("voice handoff: never two sessions, a parked session that ends is forgotten, and the replay is bounded", () => {
  const box1: VoiceSinkBox = { current: recordingSink().sink };
  const s1 = fakeSession(box1);
  parkVoice(s1, box1, 60_000);
  const box2: VoiceSinkBox = { current: recordingSink().sink };
  const s2 = fakeSession(box2);
  parkVoice(s2, box2, 60_000);
  assert.equal(s1.stopped, 1, "parking a second session stops the first");

  for (let i = 0; i < PARKED_REPLAY_MAX + 3; i++) s2.hear(zoomIn, `zoom ${i}`);
  box2.current.onState("error"); // mic unplugged while parked
  assert.equal(hasParkedVoice(), false, "nothing left to adopt");

  const box3: VoiceSinkBox = { current: recordingSink().sink };
  const s3 = fakeSession(box3);
  parkVoice(s3, box3, 60_000);
  for (let i = 0; i < PARKED_REPLAY_MAX + 3; i++) s3.hear(zoomIn, `zoom ${i}`);
  const adopted = adoptParkedVoice(recordingSink().sink);
  assert.equal(adopted?.heard.length, PARKED_REPLAY_MAX);
  assert.equal(adopted?.heard[0].heard, "zoom 0", "in the order spoken");
});
