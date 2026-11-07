// The straightened curved-planar image, drawn into a canvas over the 3D pane.

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui/IconButton";
import { curvedMprToRgba, type CurvedMprImage } from "@flowrad/viewer-core";

export function CurvedMprView({
  image,
  ww,
  wc,
  stepMm,
  onClose,
}: {
  image: CurvedMprImage;
  ww: number;
  wc: number;
  stepMm: number;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.putImageData(new ImageData(curvedMprToRgba(image, ww, wc), image.width, image.height), 0, 0);
  }, [image, ww, wc]);

  return (
    <section aria-label="Curved MPR" className="absolute inset-0 z-10 flex flex-col bg-imaging">
      <header className="flex items-center gap-2 border-b border-subtle bg-surface/90 px-2 py-1 text-xs text-secondary">
        <span className="font-semibold text-primary">Curved MPR</span>
        <span className="tabular-nums">
          {Math.round(image.lengthMm)} mm along the curve · {Math.round(image.height * stepMm)} mm high · W {Math.round(ww)} · L{" "}
          {Math.round(wc)}
        </span>
        <IconButton aria-label="Close curved MPR" title="Close (Esc)" size="sm" className="ml-auto h-6 w-6 rounded-md" onClick={onClose}>
          <X />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2">
        {/* Pixels are mm (stepMm each way), so CSS scaling keeps the aspect right. */}
        <canvas ref={canvasRef} className="max-h-full max-w-full [image-rendering:auto]" />
      </div>
    </section>
  );
}
