# FlowRad brand: "Owl Scan"

One mark for the whole FlowRad family: a symmetric white owl on a forest-green
rounded square. Its eyes are CT-gantry rings with reticle ticks, it has ear
tufts and a small diamond beak.

**The master is `owlscan.svg`, kept byte for byte as approved.** Never redraw,
restyle, recolour or simplify it. Every PNG, `.ico`, `.icns`, favicon, PWA icon,
installer bitmap and splash is rendered from that one file by `build/build.sh`.

## Colours

| Role | Hex | Use |
| --- | --- | --- |
| Forest green | `#0F4D3A` | The tile, the wordmark on light backgrounds, brand surfaces. The same for every product |
| White | `#FFFFFF` | The owl; the wordmark on dark backgrounds |

## Products

The same icon and the same colour for every product. Only the name changes:
**FlowRad Viewer**, **FlowRad Learn**, **FlowRad Canvas**, **FlowRad Reporter**,
**FlowRad Copilot**. Write "FlowRad" as one word with a capital F and R.

## Lockup

The master tile on the left and the wordmark "FlowRad" on the right, set in a
geometric sans (Inter Display SemiBold, outlined, so no font is needed).

- `flowrad-lockup.svg`: wordmark in `#0F4D3A`, for light backgrounds.
- `flowrad-lockup-dark.svg`: white wordmark, for dark backgrounds.
- Gap between tile and wordmark: ¼ of the tile height.

## Clear space and minimum size

- **Clear space:** one eye's diameter (about 30 % of the tile) on every side of
  the tile or the lockup.
- **Icon minimum:** 16 px (favicon, tray, title bar).
- **Lockup minimum:** 120 px wide. Below that, use the icon alone.

## Don't

- Recolour per product, stretch, rotate, add effects, or redraw any part.
- Retype the wordmark. Use the outlined lockup files.

## Files

| File | What it is |
| --- | --- |
| `owlscan.svg` | **Master** (512 viewBox), the approved source |
| `png/owlscan-{16,24,32,48,64,128,256,512,1024}.png` | Renders of the master |
| `flowrad-lockup.svg`, `flowrad-lockup-dark.svg` | Lockups (the master nested unchanged + the wordmark) |
| `png/flowrad-lockup.png`, `png/flowrad-lockup-dark.png` | Lockups at 1200 px wide |
| `build/build.sh` | Regenerates everything below from the master |

### Where it is deployed

- **FlowRad Viewer (desktop):** `desktop/app-icon.svg` (master copy) and
  `desktop/app-icon.png` (1024 render). `desktop/src-tauri/icons/` comes from
  `tauri icon` on that 1024 PNG: `icon.ico` (16 to 256) for the exe, taskbar,
  Start menu, installer and uninstaller; `icon.icns`; Store logos; and `linux/`.
  Also the NSIS header and sidebar bitmaps in `icons/installer/`, and the splash
  (the master inlined in `desktop/index.html`).
- **FlowRad Learn (web):** `public/owlscan.svg`, `public/favicon.svg` and
  `app/icon.svg` (master copies); `public/favicon.ico` (16/32/48);
  `public/apple-touch-icon.png` (180, the master on full-bleed green);
  `public/icon-{192,512}.png`; `public/icon-maskable-512.png` (the owl at 80 %
  on full green); and `app/manifest.ts`.
