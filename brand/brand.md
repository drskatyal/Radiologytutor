# FlowRad brand: "Owl Scan"

One mark for the whole FlowRad family. A forest-green tile holds a white owl:
ear tufts, a shield face that tapers to a pointed chin, two large **CT-gantry
eyes** (outer ring, gap ring, inner ring, pupil, with reticle ticks) and a small
diamond beak. It reads as an owl (patience, close looking, teaching) and as a
scanner bore with a crosshair (radiology). The owl is one hand-built `evenodd`
compound path. Every green detail is a true cut-out, so the mark works on any
background without masks.

## Colours

| Role | Hex | Use |
| --- | --- | --- |
| Forest green (primary) | `#0F4D3A` | The tile, the green mark, brand surfaces |
| Text green | `#0B3A2C` | The wordmark and headings on light backgrounds |
| White | `#FFFFFF` | The mark on the tile; the wordmark on dark backgrounds |
| Green tint | `#E8F1ED` | Light brand backgrounds, badges, selected states |

The mark itself is always flat. At 128 px and above, the tile may carry a very
subtle `#126046` to `#0F4D3A` gradient (the NSIS sidebar uses it). Never put a
gradient on the owl.

## Product naming

The same tile and the same colour for every product. Only the name changes:

- **FlowRad Viewer**: desktop DICOM viewer
- **FlowRad Learn**: the web teaching platform (formerly RadLearn)
- **FlowRad Canvas**
- **FlowRad Reporter**
- **FlowRad Copilot**

Write "FlowRad" as one word with a capital F and a capital R. The product name
follows after a space and is never set inside the tile.

## Lockup

The tile sits on the left and the wordmark "FlowRad" on the right, set in Inter
Display SemiBold. The wordmark is outlined to paths, so no font is needed.

- Cap height = 0.42 × tile height. The caps are optically centred on the tile.
- Gap between tile and wordmark = ¼ tile height.
- Light backgrounds: `flowrad-lockup.svg` (text `#0B3A2C`).
- Dark backgrounds: `flowrad-lockup-dark.svg` (white text, same green tile).

## Clear space

Keep clear space equal to **the height of one eye** (the outer gantry ring
diameter, about 30% of the tile) on all sides of the tile or the lockup. No
text, edges or other marks go inside it.

## Minimum sizes

- **Icon:** 16 px. Below 64 px, always use the pixel-hinted masters in
  `icon-src/` (16, 20, 24, 32, 40, 48), never a downscale of the 1024 master.
  At 16 and 20 px each eye simplifies to one ring and a pupil, and the ticks are
  dropped. The tufts, both eyes and the beak always stay.
- **Lockup:** 120 px wide. Below that, use the icon alone.

## Do

- Use the supplied files as they are, at their own proportions.
- Use the white mark (`owl-scan-mark-white.svg`) on forest green or dark
  surfaces, and the green mark (`owl-scan-mark-green.svg`) on light surfaces.
- Pick the hinted master that matches the exact pixel size.

## Don't

- Recolour the tile or the mark per product. Every product is forest green.
- Stretch, skew, rotate or re-proportion the mark or the lockup.
- Add shadows, glows, outlines, bevels or gradients to the mark.
- Redraw the eyes, change the ring count at 24 px and above, or remove the beak.
- Set the wordmark in another typeface or retype it. Use the outlined files.
- Put the mark on busy imagery without the tile.

## File index

| File | What it is |
| --- | --- |
| `owl-scan.svg` | Master app icon: 1024 tile with the white owl |
| `owl-scan-mark-white.svg` | Mark only, white, transparent (for dark or green grounds) |
| `owl-scan-mark-green.svg` | Mark only, `#0F4D3A`, transparent (for light grounds) |
| `flowrad-lockup.svg` | Horizontal lockup for light backgrounds |
| `flowrad-lockup-dark.svg` | Horizontal lockup for dark backgrounds (white wordmark) |
| `icon-src/owl-{16,20,24,32,40,48}.svg` | Pixel-hinted masters on integer pixels. Render each at exactly its own size |
| `png/owl-scan-{16,24,32,48}.png` | Rendered from the hinted masters |
| `png/owl-scan-{64,128,256,512,1024}.png` | Rendered from the 1024 master |
| `png/flowrad-lockup.png`, `png/flowrad-lockup-dark.png` | Lockups at 1200 px wide, transparent background |

### Where the mark is deployed

- **Desktop (FlowRad Viewer):** `desktop/app-icon.svg` and `.png`,
  `desktop/icon-src/`, `desktop/src-tauri/icons/` (`.ico` hinted at 48 px and
  below, `.icns` 16 to 1024, Store logos, `linux/`), the NSIS installer
  bitmaps in `icons/installer/`, and the splash mark in
  `desktop/public/brand/splash-mark.svg`, inlined in `desktop/index.html`.
- **Web (FlowRad Learn):** `public/favicon.ico` and `.svg`, `app/icon.svg`,
  `public/apple-touch-icon.png`, `public/icon-{192,512}.png`,
  `public/icon-maskable-512.png` and `app/manifest.ts`.
