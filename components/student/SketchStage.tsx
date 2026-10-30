"use client";

// Transparent Three.js layer over the DICOM viewport. Markers are image
// fractions projected every camera frame, so they stay on the anatomy.
// three.js is loaded only when a mark exists.

import { Canvas, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Group, OrthographicCamera, Quaternion, Vector3 } from "three";
import { placeCardBox, cardPixelSize, type SketchFrame } from "@/lib/sketchProjection";
import { SKETCH_STROKE, type SketchMark } from "@/lib/sketchMarks";
import { roughPaths, sketchSeed } from "@/lib/roughStroke";

export default function SketchStage({
  marks,
  frame,
}: {
  marks: readonly SketchMark[];
  frame: SketchFrame;
}) {
  const narrow = frame.width < 820;
  const [loop, setLoop] = useState<"always" | "demand">("always");
  const token = `${frame.sliceIndex}:${frame.width}:${frame.height}:${marks.map((mark) => mark.id).join(",")}`;

  useEffect(() => {
    setLoop("always");
    const timer = window.setTimeout(() => setLoop("demand"), 1800);
    const onHide = () => setLoop(document.hidden ? "demand" : "always");
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [token]);

  return (
    <div className="absolute inset-0" data-testid="sketch-stage" data-image-x={marks.find((mark) => mark.kind === "circle" || mark.kind === "ellipse")?.anchor.x_pct}>
      <Canvas
        orthographic
        dpr={narrow ? [1, 1.25] : [1, 1.5]}
        frameloop={loop}
        gl={{ alpha: true, antialias: !narrow, powerPreference: "low-power" }}
        className="pointer-events-none h-full w-full"
      >
        <ambientLight intensity={0.55} />
        <directionalLight position={[40, 80, 120]} intensity={1.15} color="#fff6ea" />
        <directionalLight position={[-30, -20, 40]} intensity={0.35} color="#d5e6ff" />
        <Fit />
        <Wake token={token} />
        <Marks marks={marks} frame={frame} />
      </Canvas>
    </div>
  );
}

function Fit() {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  useLayoutEffect(() => {
    const cam = camera as OrthographicCamera;
    cam.left = -size.width / 2;
    cam.right = size.width / 2;
    cam.top = size.height / 2;
    cam.bottom = -size.height / 2;
    cam.near = -400;
    cam.far = 400;
    cam.position.set(0, 0, 200);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    invalidate();
  }, [camera, size, invalidate]);
  return null;
}

function Wake({ token }: { token: string }) {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
  }, [token, invalidate]);
  return null;
}

function toWorld(frame: SketchFrame, x: number, y: number, width: number, height: number): Vector3 | null {
  const projected = frame.project(x, y);
  if (!projected) return null;
  const sx = (projected.x / Math.max(1, frame.width)) * width;
  const sy = (projected.y / Math.max(1, frame.height)) * height;
  return new Vector3(sx - width / 2, height / 2 - sy, 0);
}

function Marks({ marks, frame }: { marks: readonly SketchMark[]; frame: SketchFrame }) {
  const size = useThree((state) => state.size);
  return (
    <>
      {marks.map((mark) => (
        <Mark key={mark.id} mark={mark} frame={frame} width={size.width} height={size.height} />
      ))}
    </>
  );
}

function Mark({
  mark,
  frame,
  width,
  height,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  width: number;
  height: number;
}) {
  if (mark.kind === "circle" || mark.kind === "ellipse") {
    return <Ring mark={mark} frame={frame} width={width} height={height} />;
  }
  if (mark.kind === "arrow" && mark.from && mark.to) {
    return <Arrow mark={mark} frame={frame} width={width} height={height} />;
  }
  if (mark.kind === "card" && mark.card) {
    return <FloatingCard mark={mark} frame={frame} width={width} height={height} />;
  }
  return null;
}

function useDraw(delayMs: number) {
  const group = useRef<Group>(null);
  useLayoutEffect(() => {
    const node = group.current;
    if (!node) return;
    const started = performance.now();
    let raf = 0;
    const tick = () => {
      const t = Math.max(0, Math.min(1, (performance.now() - started - delayMs) / 550));
      const ease = 1 - (1 - t) ** 3;
      node.scale.setScalar(0.2 + 0.8 * ease);
      node.visible = performance.now() - started > delayMs - 20;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [delayMs]);
  return group;
}

function Ring({
  mark,
  frame,
  width,
  height,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  width: number;
  height: number;
}) {
  const group = useDraw(mark.delayMs);
  const center = toWorld(frame, mark.anchor.x_pct, mark.anchor.y_pct, width, height);
  const east = toWorld(frame, mark.anchor.x_pct + (mark.rx ?? 0.055), mark.anchor.y_pct, width, height);
  if (!center || !east) return null;
  const radius = Math.max(34, center.distanceTo(east));
  const color = SKETCH_STROKE[mark.color];
  return (
    <group ref={group} position={center}>
      <mesh position={[0, 0, -2]}>
        <circleGeometry args={[radius * 0.78, 48]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.22} />
      </mesh>
      <mesh>
        <ringGeometry args={[radius - 5, radius, 64]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <mesh>
        <ringGeometry args={[radius + 3, radius + 6, 64, 1, 0, Math.PI * 1.7]} />
        <meshBasicMaterial color={color} transparent opacity={0.55} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Arrow({
  mark,
  frame,
  width,
  height,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  width: number;
  height: number;
}) {
  const group = useDraw(mark.delayMs);
  const from = toWorld(frame, mark.from!.x_pct, mark.from!.y_pct, width, height);
  const to = toWorld(frame, mark.to!.x_pct, mark.to!.y_pct, width, height);
  const pose = useMemo(() => {
    if (!from || !to) return null;
    const dir = to.clone().sub(from);
    const length = dir.length();
    if (length < 8) return null;
    const quat = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
    const mid = from.clone().lerp(to, 0.42);
    return { quat, mid, length, tip: to };
  }, [from, to]);
  if (!pose) return null;
  const color = SKETCH_STROKE[mark.color];
  return (
    <group ref={group}>
      <mesh position={pose.mid} quaternion={pose.quat}>
        <cylinderGeometry args={[2.4, 4.2, pose.length * 0.82, 12]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} roughness={0.4} />
      </mesh>
      <mesh position={pose.tip} quaternion={pose.quat}>
        <coneGeometry args={[8, 18, 14]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.7} roughness={0.32} />
      </mesh>
      <mesh position={[pose.tip.x, pose.tip.y, -6]}>
        <circleGeometry args={[14, 20]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.3} />
      </mesh>
    </group>
  );
}

function FloatingCard({
  mark,
  frame,
  width,
  height,
}: {
  mark: SketchMark;
  frame: SketchFrame;
  width: number;
  height: number;
}) {
  const card = mark.card;
  const anchor = toWorld(frame, mark.anchor.x_pct, mark.anchor.y_pct, width, height);
  const anchorPx = frame.project(mark.anchor.x_pct, mark.anchor.y_pct);
  const size = cardPixelSize(frame.width);
  const box = anchorPx ? placeCardBox(anchorPx, { width: frame.width, height: frame.height }, size) : null;
  const cardWorld = box
    ? new Vector3(
        ((box.x + size.width / 2) / frame.width) * width - width / 2,
        height / 2 - ((box.y + size.height / 2) / frame.height) * height,
        18
      )
    : null;
  const underline = useMemo(() => roughPaths("underline", sketchSeed(`${mark.id}-ink`))[0] ?? "", [mark.id]);
  if (!card || !anchor || !cardWorld) return null;
  const seed = sketchSeed(mark.id);
  const wobble: Vector3[] = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const point = anchor.clone().lerp(cardWorld, t);
    const bend = Math.sin(t * Math.PI) * (12 + (seed % 11));
    point.x += bend * (((seed >> i) & 1) === 0 ? 0.45 : -0.45);
    point.y += Math.cos(t * Math.PI) * bend * 0.15;
    point.z = 6;
    wobble.push(point);
  }
  return (
    <group>
      <Squiggle points={wobble} />
      <group position={cardWorld}>
      <Html center position={[0, 0, 0]} zIndexRange={[30, 0]} className="pointer-events-none">
        <div
          data-testid="sketch-card"
          className="w-[min(15.5rem,70vw)] rounded-2xl bg-[#16130f]/88 px-3.5 py-2.5 font-hand tracking-tight text-[#f6efe2] shadow-[0_16px_36px_rgba(0,0,0,0.55)] ring-1 ring-[#f6e7b8]/35 backdrop-blur-md"
          style={{
            animation: `sketch-card-in ${mark.durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) ${mark.delayMs}ms both`,
          }}
        >
          {mark.caption ? <p className="text-[12px] uppercase tracking-[0.16em] text-[#FF4DDE]">{mark.caption}</p> : null}
          <p className="text-[22px] font-medium leading-tight">{card.title}</p>
          <svg viewBox="0 0 100 24" className="mt-1 h-3 w-24" aria-hidden="true">
            <path d={underline} fill="none" stroke="#FFE14A" strokeWidth="3" strokeLinecap="round" />
          </svg>
          {card.lines.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {card.lines.map((line, index) => (
                <li key={`${index}-${line}`} className="line-clamp-3 text-[15px] font-medium leading-snug text-[#efe4cf]">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Html>
      </group>
    </group>
  );
}

function Squiggle({ points }: { points: Vector3[] }) {
  return (
    <group>
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1];
        if (!next) return null;
        const mid = point.clone().lerp(next, 0.5);
        const dir = next.clone().sub(point);
        const length = Math.max(0.5, dir.length());
        const quat = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
        return (
          <mesh key={index} position={mid} quaternion={quat}>
            <cylinderGeometry args={[1.15, 1.15, length, 5]} />
            <meshStandardMaterial color="#FFE14A" emissive="#FFE14A" emissiveIntensity={0.45} roughness={0.4} />
          </mesh>
        );
      })}
    </group>
  );
}
