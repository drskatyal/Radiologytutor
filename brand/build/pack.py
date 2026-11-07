"""Pack the rendered Owl Scan PNGs into favicon.ico and the NSIS 24-bit BMPs.

Every bitmap is a Chromium rendering of brand/owlscan.svg (build.mjs); this
script only changes the container, never the pixels.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "brand/build/out"


def main() -> None:
    frames = [Image.open(OUT / f"favicon-{s}.png").convert("RGBA") for s in (48, 32, 16)]
    frames[0].save(
        ROOT / "public/favicon.ico",
        format="ICO",
        sizes=[(48, 48), (32, 32), (16, 16)],
        append_images=frames[1:],
    )
    for name in ("nsis-header", "nsis-sidebar"):
        Image.open(OUT / f"{name}.png").convert("RGB").save(ROOT / f"desktop/src-tauri/icons/installer/{name}.bmp", format="BMP")
    print("packed favicon.ico (16/32/48) and NSIS bitmaps")


if __name__ == "__main__":
    main()
