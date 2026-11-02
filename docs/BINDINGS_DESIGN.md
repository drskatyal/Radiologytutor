# Customisable mouse and keyboard bindings

Status: built (2026-11-02), desktop app and free web viewer, one shared engine.
Draft PR stacked on #137 (whose single gesture table it grows out of).

## One engine, one map per surface

```
packages/viewer-core/src/bindings/        (@flowrad/viewer-core/bindings — no app imports)
  inputs.ts    input specs for ANY key / mouse button / wheel; labels; key capture
  map.ts       command table ⊕ overrides → effective inputs; conflicts; assign / swap / clear / reset
  mouse.ts     shared mouse rows + RADIANT_PRESET; drag / wheel rules; button → tool
  gesture.ts   click vs drag (4 px); InputCapture ("press the button you want to bind")
  storage.ts   versioned JSON (settings file, localStorage, account, import / export); migration
  live.ts      the live binding set every viewport, tooltip and sheet reads
  dom.ts       mouse-button clicks and wheel tilt → commands (scoped; defaults suppressed only when bound)
components/bindings/BindingsPanel.tsx      Settings › Mouse & Keyboard (shared React panel, lazy chunk)
desktop/src/shortcuts.ts                   DESKTOP_COMMANDS: the desktop keyboard preset (RadiAnt keys)
desktop/src/viewer/mouseBindings.ts        thin adapter: live drag / wheel rules for native + JS viewports
lib/viewerHotkeys.ts                       WEB_COMMANDS: the web keyboard preset
lib/viewerMouseBindings.ts                 web: drag / wheel rules → Cornerstone tool-group bindings
components/viewer/useViewerBindings.ts     web persistence: localStorage + account
app/api/me/prefs/route.ts                  account copy (org-scoped, `userPrefs` collection via lib/cases.ts)
```

### Input specs

One string grammar for everything the OS can send:

| Spec | What |
|---|---|
| `R`, `Shift+R`, `Mod+Alt+K`, `F13` … `F24`, `ArrowUp`, `]` | keys (`Mod` = ⌘ on macOS, Ctrl elsewhere) |
| `MouseN` | a click of `PointerEvent.button` N — 1 middle, 3 back, 4 forward, 5+ extra buttons |
| `MouseNDrag` | press-and-drag with button N (any modifiers) |
| `Wheel` (+ modifiers) | the vertical wheel as an axis (scroll / zoom / slab) |
| `WheelLeft`, `WheelRight` | horizontal wheel / tilt notches |

Labels name what the reader pressed: "Mouse 4 (back)", "Mouse button 6", "Ctrl+Right drag",
"Wheel tilt left", "F13".

### Commands and kinds

Each surface has a command table (`DESKTOP_COMMANDS`, `WEB_COMMANDS`): id, label, group, kind,
default inputs. Kinds decide what can drive a command:

- **action** (one-shot): keys, mouse clicks (any button but left = tool and right click = menu),
  tilt notches;
- **drag**: `drag.windowLevel`, `drag.pan`, `drag.zoom`, `drag.scroll` — any button but the left;
- **wheel**: `wheel.scroll`, `wheel.slab` (zoom on a plain image), `wheel.zoom`.

Command ids are the existing desktop binding ids (`tool.w`, `rotate`, `flip.h`, `series.next`, …),
so ≤ 0.8.1 overrides migrate unchanged.

### Defaults (RadiAnt preset)

Mouse (shared, `RADIANT_PRESET`): right drag W/L · Ctrl+right drag zoom · middle drag pan ·
wheel scroll · Ctrl+wheel slab thickness (zoom on a plain image) · Mouse 4 / 5 previous / next series.

Keys: the desktop keeps its RadiAnt keys (R / Shift+R rotate, H / V flip, S rectangle, B browse,
W window, …). The web keeps its keys, because the student session owns C N P R T F [ Space ? on
`window`; R rotates only in the standalone viewer.

### Overrides = deltas

A command in the overrides uses exactly those inputs (`[]` = unbound); every other command keeps its
preset inputs minus any input an override has claimed. An override equal to the preset is dropped,
so new defaults still reach readers who customised other rows.

### Single source of truth

Handlers (desktop `resolveShortcut` / `resolveInput`, web `resolveViewerHotkey` / `resolveViewerInput`),
native and JS drag / wheel handling, Cornerstone tool-group bindings, toolbar tooltips and menu
labels (`keysForAction`, `toolKeyLabel`, `mouseHintFor`, `shortcutForTool`), the F1 / ? sheets and
`aria-keyshortcuts` (`ariaKeysForAction`) all read the effective bindings (live). No component
types a key: the desktop test fails on a hard-coded tool key in `Toolbar.tsx`.

### Conflicts

`findConflict` names the holder; the panel asks "R is already Rotate 90° clockwise — swap or
cancel?". Swap gives the holder the command's previous inputs of the right kind. Ranges outside the
table (presets 1 … 9, layouts Shift+1 … 7) still claim their keys.

## Any mouse — capture, not vendor SDKs

Works with any programmable or gaming mouse (Razer, Logitech, Corsair, SteelSeries, generic
multi-button). Binding is **"press the button or key you want to bind"**: `InputCapture` records
whatever arrives and the panel shows it ("Received Mouse button 6 for Rotate 90° clockwise") before
saving.

| The OS sends | Captured from | Stored as |
|---|---|---|
| Buttons 1–4 (middle, right, back, forward) | `pointerdown` / `pointerup` / `auxclick` `.button` (WebView2 forwards `WM_XBUTTON1/2` as 3 / 4) | `Mouse1` … `Mouse4`, `…Drag` |
| Buttons 5 and higher | the same events, any button number the browser reports | `Mouse5`, `Mouse6`, … |
| Horizontal wheel / tilt | `wheel.deltaX` | `WheelLeft` / `WheelRight` |
| Keys or macros from mouse software | `keydown` `key` / `code` (F13–F24 via `code` when `key` is "Unidentified") | `F13`, `Mod+Alt+K`, … |

- Click vs drag: under 4 px of movement is a click (`DRAG_THRESHOLD_PX`).
- Browser defaults (back / forward on buttons 4 / 5, middle-click autoscroll, horizontal scroll) are
  suppressed only inside the viewer and only for bound inputs (`attachMouseCommands`).
- A bound extra button no longer drags the left tool on desktop native viewports (`dragModeFor`
  returns no drag for an unbound non-left button), so its click is free for its command.
- The JS engines (Cornerstone) bind drags to buttons 1–4 only; a drag on button 5+ works on the
  desktop's native viewports; any button's click works everywhere.
- **Deferred: Windows raw input** (`RegisterRawInputDevices`) for buttons beyond XBUTTON2 that
  WebView2 never forwards. Windows has no standard message for them; mice that have them map them
  to keys in their own software (F13–F24, combos), which binds today. A raw-input hook needs a
  window subclass in the Tauri shell and per-device HID parsing; it is left for a follow-up and
  would be enabled only while a binding uses such a button.
- Shift+tilt is indistinguishable from Shift+wheel in browsers, so it is not offered.

## Persistence

| Where | Copy |
|---|---|
| Desktop | `settings.json` → `bindings` (the app config file); ≤ 0.8.1 `settings.shortcuts` migrate once, then clear |
| Web, signed out | `localStorage["flowrad.bindings"]` (try / catch; private windows fall back to the preset) |
| Web, signed in | `GET / PUT /api/me/prefs` → `userPrefs` collection via `lib/cases.ts` (`orgId`-scoped, `getUserPrefs` / `saveUserBindings`); the newest copy wins (`updatedAt`) |
| Import / Export | the same JSON file, validated against the command table; unknown ids / invalid inputs are dropped and listed |

```json
{ "format": "flowrad-bindings", "version": 1, "surface": "web", "updatedAt": "…",
  "overrides": { "drag.zoom": ["Mouse2Drag"], "flip.h": ["F13"], "rotate.cw": ["R", "Mouse5"] } }
```

The free viewer's privacy gate allows no request after a study is dropped, so the web fetches the
account copy only from the page shell (before a study opens) and when the reader opens the panel.

## UI — Settings › Mouse & Keyboard

Lazy-loaded (`lazy(() => import("@/components/bindings/BindingsPanel"))`): its own chunk, nothing at
startup. Desktop: Settings → "Mouse & Keyboard…". Web: the ? sheet → "Customise".

- **Mouse** tab: a row per button × click / drag (middle, right, back, forward, any extra button
  already bound), wheel rows with modifiers, tilt rows — each with a command picker; "Add a mouse
  button…" captures any button.
- **Keyboard** tab: every command, searchable (by name, group or key); Change / add another input /
  restore default per row; conflict prompt with Swap.
- Footer: Reset all, Import, Export, "Preset: RadiAnt standard".
- Built from `components/ui` (Button, IconButton, Input, Select, Kbd, Tabs, FilePickerButton).

## Tests

- Unit (`lib/bindings.test.ts`): specs, labels, preset, override layering, conflicts / swap / add /
  clear / reset, kinds, drag + wheel resolution, click vs drag, capture (button 5, button 7 via
  auxclick, F13, tilt), JSON round trip + validation, storage, migration.
- Desktop unit (`desktop/src/desktop.test.ts`): right drag → zoom across native drags, engine table,
  tooltips and sheet; button 5 + F13 fire commands and appear in the F1 sheet; swap; migration.
- e2e web (`e2e/visual/bindings.spec.ts`) and desktop (`desktop/scripts/e2e-ui.mjs`, group
  `bindings`, in desktop-ci's main UI run): rebind right drag to zoom and a key, bind mouse button 5
  and F13, reload, and check all still apply and show in the sheet.
- Perf: the panel is a separate chunk; startup bundle sizes before / after are in the PR.
