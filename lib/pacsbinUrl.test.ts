import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePacsbinUrl,
  extractState,
  parseBaseUrl,
  buildViewerUrl,
  decodeState,
  encodeState,
  summarizeState,
  PLAYBACK_CHROME,
} from "./pacsbinUrl.ts";

// A real Pacsbin 2.0 state blob (gzip(JSON) -> base64url) captured from the viewer.
const REAL_STATE =
  "H4sIAAAAAAAACrWQy27UQBBF_6XWlVZVP6v7C2BBlE3YjGbReGxk4bgtu5PREOXfUZsRCBBoNuyqpHOvrs4rvIz9-UM59ZDg8zqeAGHKl_JcIR0Y9RF3YClr3SAdXqFeloZuNXdfAGGrz6fL-xMk8MQ6eDJa-sESRT1kK5-GrkH9OvbbTyrYX6nOEiCM81bz3PX_4tq8oXR5eijjvE_UVgUnZJBVdEYYjVdOxITr8scF0uGOFDM7i-0wxhskFcUGc4Uepjz392V9yhOkA6ngmHWDvSd27SCyjo8I5zMkbgVw7iAJc9v90q8V0pCnrUdYS811LDMkQvhayhMkUsFIZIQlz60f6YgwTOPy7keqfR-v3xv-J82sb9Os_Z-aWUmUEPDOKa2jNSikSILIb55b4a4uhhh3dRxF9F9EEzNH3Bkve0quki1F912yJhuUu8UzKwrR-Zs9H9--AQzo7Ov_AgAA";

const URL_WITH_STATE = `https://pacsbin.com/viewer/case/WJUZ1VRmoL?header=true&caseData=true&an=true&overlay=true&title=true&state=${REAL_STATE}`;

test("parsePacsbinUrl extracts base, state and chrome flags", () => {
  const p = parsePacsbinUrl(URL_WITH_STATE);
  assert.equal(p.baseUrl, "https://pacsbin.com/viewer/case/WJUZ1VRmoL");
  assert.equal(p.state, REAL_STATE);
  assert.equal(p.chrome.header, true);
  assert.equal(p.chrome.an, true);
});

test("extractState returns the state blob verbatim", () => {
  assert.equal(extractState(URL_WITH_STATE), REAL_STATE);
});

test("extractState returns empty string when no state", () => {
  assert.equal(extractState("https://pacsbin.com/viewer/case/abc"), "");
});

test("parseBaseUrl strips the query", () => {
  assert.equal(parseBaseUrl(URL_WITH_STATE), "https://pacsbin.com/viewer/case/WJUZ1VRmoL");
});

test("buildViewerUrl emits the state verbatim with playback chrome", () => {
  const url = buildViewerUrl("https://pacsbin.com/viewer/case/WJUZ1VRmoL", REAL_STATE, PLAYBACK_CHROME);
  assert.ok(url.includes(`state=${REAL_STATE}`), "state passed through unmodified");
  assert.ok(url.includes("header=false"));
  assert.ok(url.includes("an=false"));
});

test("buildViewerUrl with no state yields just base+chrome", () => {
  const url = buildViewerUrl("https://pacsbin.com/viewer/case/x", "", PLAYBACK_CHROME);
  assert.ok(!url.includes("state="));
  assert.ok(url.includes("header=false"));
});

test("decodeState decodes the real blob into the 2.0 schema", async () => {
  const state = await decodeState(REAL_STATE);
  assert.equal(state.viewMode, "grid");
  assert.deepEqual(state.layout, [1, 2]);
  assert.equal(state.viewports.length, 2);
  assert.equal(state.viewports[0].ww, 1363);
  assert.equal(state.viewports[0].wc, 811);
  assert.equal(typeof state.viewports[0].seriesId, "string");
  assert.equal(typeof state.viewports[0].instanceId, "string");
});

test("encodeState -> decodeState round-trips the object", async () => {
  const original = await decodeState(REAL_STATE);
  const reencoded = await encodeState(original);
  const back = await decodeState(reencoded);
  assert.deepEqual(back, original);
});

test("summarizeState produces a human summary", async () => {
  const state = await decodeState(REAL_STATE);
  const s = summarizeState(state);
  assert.ok(s.includes("1x2"));
  assert.ok(s.toLowerCase().includes("pane"));
});
