// 0.8.3 UX: multi-monitor UI only with two monitors; voice commands listed;
// voice switches on quietly after the first time. Run: npm --prefix desktop test
import { test } from "node:test";
import assert from "node:assert/strict";
import { VOICE_COMMANDS, voiceGrammar, type MonitorInfo } from "@flowrad/viewer-core";
import { BINDINGS, MULTI_MONITOR_COMMANDS, shortcutSheet } from "./shortcuts";
import { MONITOR_POLL_MS, hasMultipleMonitors, sameMonitors, screenChangeEventSupported, shouldPollMonitors } from "./monitorWatch";
import { VOICE_GROUP_ORDER, VOICE_PROGRESS_DELAY_MS, stopPhrase, voiceCommandRows, voiceStatusShown, voiceTriggerText } from "./voiceUi";

const mon = (name: string, x = 0, scale = 1): MonitorInfo => ({ name, x, y: 0, width: 1920, height: 1080, scale });

test("multi-monitor UI is offered only with two or more monitors", () => {
  assert.equal(hasMultipleMonitors([]), false);
  assert.equal(hasMultipleMonitors([mon("A")]), false);
  assert.equal(hasMultipleMonitors([mon("A"), mon("B", 1920)]), true);
});

test("an unchanged desk is the same (no re-render); a plugged / moved / rescaled monitor is not", () => {
  const desk = [mon("A"), mon("B", 1920)];
  assert.ok(sameMonitors(desk, desk.map((m) => ({ ...m }))));
  assert.ok(!sameMonitors(desk, [mon("A")]), "unplugged");
  assert.ok(!sameMonitors([mon("A")], desk), "plugged in");
  assert.ok(!sameMonitors(desk, [mon("A"), mon("B", 2560)]), "moved");
  assert.ok(!sameMonitors(desk, [mon("A"), mon("B", 1920, 1.5)]), "rescaled");
  assert.ok(!sameMonitors(desk, [mon("B", 1920), mon("A")]), "re-ordered");
});

test("monitor fallback poll runs only without a screen-change event, while visible, with a study open", () => {
  assert.equal(shouldPollMonitors({ eventSupported: false, visible: true, active: true }), true);
  assert.equal(shouldPollMonitors({ eventSupported: true, visible: true, active: true }), false, "WebView2: the event is enough");
  assert.equal(shouldPollMonitors({ eventSupported: false, visible: false, active: true }), false, "hidden / minimised");
  assert.equal(shouldPollMonitors({ eventSupported: false, visible: true, active: false }), false, "start screen");
  assert.ok(MONITOR_POLL_MS >= 2_000, "slow, cheap poll");
});

test("screen change event: detected from the screen object", () => {
  const withEvent = Object.assign(new EventTarget(), { onchange: null });
  assert.equal(screenChangeEventSupported(withEvent), true);
  assert.equal(screenChangeEventSupported(new EventTarget()), false);
  assert.equal(screenChangeEventSupported(undefined), false);
});

test("multi-monitor shortcuts exist and leave the sheet on a single display", () => {
  const ids = new Set(BINDINGS.map((b) => b.id));
  for (const id of MULTI_MONITOR_COMMANDS) assert.ok(ids.has(id), id);
  const all = shortcutSheet(false, {});
  const single = shortcutSheet(false, {}, MULTI_MONITOR_COMMANDS);
  assert.ok(all.some((r) => /next monitor/.test(r.does)));
  assert.ok(!single.some((r) => /next monitor/.test(r.does)), "hidden on one monitor");
  assert.equal(all.length - single.length, MULTI_MONITOR_COMMANDS.size);
});

test("voice command list: every command once, every recognised phrase shown, grouped in order", () => {
  const rows = voiceCommandRows();
  assert.equal(rows.length, VOICE_COMMANDS.length);
  assert.deepEqual(new Set(rows.map((r) => r.label)), new Set(VOICE_COMMANDS.map((c) => c.label)));
  const shown = new Set(rows.flatMap((r) => r.phrases));
  for (const p of voiceGrammar().filter((p) => p !== "[unk]")) assert.ok(shown.has(p), `“${p}” is listed`);
  const order = rows.map((r) => VOICE_GROUP_ORDER.indexOf(r.group));
  assert.ok(order.every((g, i) => g >= 0 && (i === 0 || g >= order[i - 1]!)), "grouped in order");
});

test("voice trigger: names the mic, the key, toggle (not push-to-talk) and the stop phrase", () => {
  const text = voiceTriggerText("Ctrl+Shift+V");
  assert.match(text, /mic button/);
  assert.match(text, /Ctrl\+Shift\+V/);
  assert.match(text, /toggle, not push-to-talk/);
  assert.ok(text.includes(stopPhrase()));
  assert.equal(stopPhrase(), "stop listening");
  assert.doesNotMatch(voiceTriggerText(undefined), /undefined/);
});

test("voice loading card: first time and slow only; never again once prepared; errors always", () => {
  const show = (state: "off" | "loading" | "listening" | "error", slow: boolean, firstLoad: boolean, stage?: "permission" | "download" | "starting") =>
    voiceStatusShown({ state, slow, firstLoad, stage });
  assert.equal(show("loading", false, true), false, "a load under a second shows nothing");
  assert.equal(show("loading", true, true, "download"), true, "first time, slow: progress");
  assert.equal(show("loading", true, false, "download"), false, "prepared before: no size notice");
  assert.equal(show("loading", true, false, "starting"), false);
  assert.equal(show("loading", true, false, "permission"), true, "waiting on the microphone prompt is said");
  assert.equal(show("error", false, false), true, "errors (with Retry) always");
  assert.equal(show("listening", true, true), false);
  assert.equal(show("off", true, true), false);
  assert.equal(VOICE_PROGRESS_DELAY_MS, 1_000);
});
