"use client";

// The study's organs in 3D, lit like a studio product shot.
//
// Meshes are TotalSegmentator surfaces from this CT, stored in patient RAS
// millimetres. One matrix turns RAS into the scene (superior up, anterior
// toward the camera, patient left on screen right — the radiological view).
// Lungs are frosted glass (physical transmission), so the heart, airway and
// the finding read through them. The finding is an HDR core that blooms, with
// a pulse ring and an ink-leader label. Lighting is image-based from soft
// Lightformers, with ACES tone mapping. Nothing is fetched besides the GLB.

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Billboard, Environment, Html, Lightformer, OrbitControls, useGLTF } from "@react-three/drei";
import { Bloom, EffectComposer, ToneMapping, Vignette } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  NoToneMapping,
  SRGBColorSpace,
  Vector3,
  type Group,
  type Material,
  type MeshStandardMaterial,
  type Sprite,
} from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AnatomyManifest } from "@/lib/anatomyCatalog";
import { brushOutline, INK, inkSeed, outlinePath, squiggleStroke } from "@/lib/inkStroke";

type OrbitHandle = {
  target: Vector3;
  update: () => void;
  autoRotate: boolean;
};

/** RAS (x right, y anterior, z superior) → scene (x = patient left, y up, z toward viewer). */
const RAS_TO_SCENE = new Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
/** The schematic is authored Y-up in metres. */
const SCHEMATIC_TO_SCENE = new Matrix4().makeScale(100, 100, 100);

type Tissue = "glass" | "heart" | "vessel" | "airway" | "liver" | "kidney" | "bone";

function tissueFor(name: string): Tissue {
  const id = name.toLowerCase();
  if (id.includes("lung")) return "glass";
  if (id.includes("heart")) return "heart";
  if (id.includes("aorta") || id.includes("vessel")) return "vessel";
  if (id.includes("trachea") || id.includes("airway")) return "airway";
  if (id.includes("liver")) return "liver";
  if (id.includes("kidney")) return "kidney";
  return "bone";
}

/** Physically based tissue. Wet organs get a clear coat; lungs are frosted glass. */
function tissueMaterial(tissue: Tissue, source?: MeshStandardMaterial): MeshPhysicalMaterial {
  if (tissue === "glass") {
    return new MeshPhysicalMaterial({
      // Milky, not clear: some diffuse body so the glass reads on black,
      // rough transmission so what is inside is softened, a crisp clear coat.
      color: new Color("#f7e6e9"),
      roughness: 0.5,
      metalness: 0,
      transmission: 0.86,
      thickness: 34,
      ior: 1.3,
      attenuationColor: new Color("#ffd3da"),
      attenuationDistance: 260,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      specularIntensity: 1,
      sheen: 1,
      sheenRoughness: 0.4,
      sheenColor: new Color("#ffe6ea"),
      envMapIntensity: 1.6,
      side: DoubleSide,
    });
  }
  const look: Record<Exclude<Tissue, "glass">, { color: string; roughness: number; clearcoat: number }> = {
    heart: { color: "#8c3a33", roughness: 0.5, clearcoat: 0.55 },
    vessel: { color: "#9c3b32", roughness: 0.44, clearcoat: 0.6 },
    airway: { color: "#e3d4bd", roughness: 0.52, clearcoat: 0.3 },
    liver: { color: "#7b3a2c", roughness: 0.5, clearcoat: 0.45 },
    kidney: { color: "#8d4434", roughness: 0.48, clearcoat: 0.45 },
    bone: { color: "#e9e0cf", roughness: 0.66, clearcoat: 0.12 },
  };
  const spec = look[tissue];
  const material = new MeshPhysicalMaterial({
    color: new Color(spec.color),
    roughness: spec.roughness,
    metalness: 0,
    clearcoat: spec.clearcoat,
    clearcoatRoughness: 0.32,
    sheen: 0.25,
    sheenRoughness: 0.6,
    sheenColor: new Color("#ffd9d2"),
    envMapIntensity: 1,
  });
  // The baked tissue maps ride on UV seams that split the surface into
  // facets. Smooth shading from welded vertices reads far more like tissue.
  void source;
  return material;
}

/**
 * Positions only, as plain floats. Meshopt hands back interleaved,
 * quantized attributes that the welder cannot rewrite.
 */
function plainPositions(source: BufferGeometry): BufferGeometry {
  const position = source.getAttribute("position");
  const out = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    out[i * 3] = position.getX(i);
    out[i * 3 + 1] = position.getY(i);
    out[i * 3 + 2] = position.getZ(i);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(out, 3));
  const index = source.getIndex();
  const order = index
    ? Array.from({ length: index.count }, (_, i) => index.getX(i))
    : Array.from({ length: position.count }, (_, i) => i);
  // Marching cubes leaves a few sliver triangles that shoot out of the
  // apices. Any edge longer than a ninth of the organ is one of them.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < position.count; i++) {
    minX = Math.min(minX, out[i * 3]!); maxX = Math.max(maxX, out[i * 3]!);
    minY = Math.min(minY, out[i * 3 + 1]!); maxY = Math.max(maxY, out[i * 3 + 1]!);
    minZ = Math.min(minZ, out[i * 3 + 2]!); maxZ = Math.max(maxZ, out[i * 3 + 2]!);
  }
  const limit = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 0.11;
  const edge = (a: number, b: number) =>
    Math.hypot(out[a * 3]! - out[b * 3]!, out[a * 3 + 1]! - out[b * 3 + 1]!, out[a * 3 + 2]! - out[b * 3 + 2]!);
  const kept: number[] = [];
  for (let t = 0; t + 2 < order.length; t += 3) {
    const [a, b, c] = [order[t]!, order[t + 1]!, order[t + 2]!];
    if (edge(a, b) > limit || edge(b, c) > limit || edge(c, a) > limit) continue;
    kept.push(a, b, c);
  }
  geometry.setIndex(kept);
  return geometry;
}

function structureId(name: string): string {
  return name.replace(/__lod\d$/, "");
}

class StageBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function AnatomyStage({
  manifest,
  exploded,
  resetToken,
  findingLabel,
  onHover,
  onError,
}: {
  manifest: AnatomyManifest;
  exploded: boolean;
  resetToken: number;
  findingLabel?: string;
  onHover: (id: string | null) => void;
  onError: () => void;
}) {
  const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
  return (
    <div className="h-full w-full bg-[radial-gradient(ellipse_at_50%_42%,#17181c_0%,#060607_55%,#000_80%)]">
      <StageBoundary onError={onError}>
        <Canvas
          dpr={narrow ? [1, 1.5] : [1, 2]}
          camera={{ position: [0, 0, 900], fov: 30, near: 2, far: 6000 }}
          gl={{ antialias: false, alpha: true, powerPreference: "high-performance", toneMapping: NoToneMapping }}
          onCreated={({ gl }) => {
            gl.setClearColor(0x000000, 0);
          }}
        >
          <Suspense fallback={null}>
            <Scene
              manifest={manifest}
              exploded={exploded}
              resetToken={resetToken}
              findingLabel={findingLabel}
              onHover={onHover}
              narrow={narrow}
            />
          </Suspense>
        </Canvas>
      </StageBoundary>
    </div>
  );
}

function Studio() {
  // Soft boxes into an environment map: a warm key above-front, cool rims
  // behind, a low fill. Reflections in the clear coat come from these.
  return (
    <>
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={3.2} color="#fff1e2" position={[0, 4, 6]} scale={[10, 5, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={2.4} color="#cddcff" position={[-7, 2, -4]} scale={[3, 8, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={1.8} color="#ffd6cc" position={[7, 1, -3]} scale={[3, 7, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={0.6} color="#ffffff" position={[0, -5, 2]} scale={[8, 2, 1]} target={[0, 0, 0]} />
        <Lightformer form="ring" intensity={1.4} color="#ffffff" position={[0, 0, 9]} scale={3} />
      </Environment>
      <hemisphereLight args={["#fff4ea", "#1b1210", 0.35]} />
      <directionalLight position={[260, 420, 520]} intensity={2.1} color="#fff2e4" />
      <directionalLight position={[-420, 120, -380]} intensity={1.1} color="#c8d8ff" />
    </>
  );
}

function Scene({
  manifest,
  exploded,
  resetToken,
  findingLabel,
  onHover,
  narrow,
}: {
  manifest: AnatomyManifest;
  exploded: boolean;
  resetToken: number;
  findingLabel?: string;
  onHover: (id: string | null) => void;
  narrow: boolean;
}) {
  const gltf = useGLTF(manifest.glb, false, true);
  const patient = manifest.source === "totalsegmentator";
  const toScene = patient ? RAS_TO_SCENE : SCHEMATIC_TO_SCENE;
  const organs = useRef<Group>(null);
  const controls = useRef<OrbitHandle>(null);
  const { camera } = useThree();
  const finding = manifest.findings.find((item) => item.findingId === manifest.activeFindingId);
  const explode = useRef(0);
  const explodeVel = useRef(0);
  const intro = useRef(0);
  const hovered = useRef<string | null>(null);

  // Materials, normals, and the explode rest pose, once per GLB.
  const meshes = useMemo(() => {
    const list: Mesh[] = [];
    gltf.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const name = structureId(mesh.name || mesh.parent?.name || "");
      if (/__lod\d$/.test(mesh.name) || /__lod\d$/.test(mesh.parent?.name ?? "")) {
        mesh.visible = false;
        return;
      }
      // The GLB ships no normals and splits vertices at UV seams. Weld by
      // position, then smooth, so the organs are not faceted.
      mesh.geometry = mergeVertices(plainPositions(mesh.geometry), 1e-4);
      mesh.geometry.computeVertexNormals();
      const raw = mesh.material as Material | Material[];
      const source = (Array.isArray(raw) ? raw[0] : raw) as MeshStandardMaterial | undefined;
      const tissue = tissueFor(name);
      mesh.material = tissueMaterial(tissue, source);
      mesh.userData.structure = name;
      mesh.userData.tissue = tissue;
      // Glass draws after the opaque organs so transmission sees them.
      mesh.renderOrder = tissue === "glass" ? 2 : 0;
      list.push(mesh);
    });
    const all = new Box3();
    for (const mesh of list) all.expandByObject(mesh);
    const centre = all.getCenter(new Vector3());
    for (const mesh of list) {
      const box = new Box3().setFromObject(mesh);
      const c = box.getCenter(new Vector3());
      // Peel outward in the axial plane; superior/inferior stays put.
      const dir = patient ? new Vector3(c.x - centre.x, c.y - centre.y, 0) : new Vector3(c.x - centre.x, 0, c.z - centre.z);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      mesh.userData.rest = mesh.position.clone();
      mesh.userData.dir = dir.normalize();
    }
    return list;
  }, [gltf, patient]);

  // Frame the lungs (or everything) and remember where "home" is.
  const frame = useMemo(() => {
    const box = new Box3();
    const lungs = meshes.filter((mesh) => mesh.userData.tissue === "glass");
    for (const mesh of lungs.length ? lungs : meshes) {
      const local = new Box3().setFromObject(mesh);
      box.union(local.applyMatrix4(toScene));
    }
    const centre = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.5 || 150;
    const findingAt = finding ? new Vector3(...finding.position).applyMatrix4(toScene) : null;
    // A three-quarter view from the patient's left front, so a left-sided
    // finding faces the camera. Distance fits the lungs in a 30° lens.
    const fit = (radius / Math.sin((15 * Math.PI) / 180)) * (narrow ? 1.9 : 1.45);
    const dir = new Vector3(findingAt && findingAt.x < centre.x ? -0.42 : 0.42, 0.16, 1).normalize();
    const home = centre.clone().addScaledVector(dir, fit);
    const near = findingAt ? findingAt.clone().addScaledVector(dir, fit * 0.32) : home.clone().addScaledVector(dir, -fit * 0.4);
    return { centre, home, near, findingAt };
  }, [meshes, toScene, finding, narrow]);

  // Fly in from the finding, ease out to home. Reset replays it.
  useLayoutEffect(() => {
    intro.current = 0;
    camera.position.copy(frame.near);
    const orbit = controls.current;
    if (orbit) {
      orbit.target.copy(frame.findingAt ?? frame.centre);
      orbit.autoRotate = false;
      orbit.update();
    }
  }, [camera, frame, resetToken]);

  useFrame((_, delta) => {
    const orbit = controls.current;
    if (intro.current < 1 && orbit) {
      intro.current = Math.min(1, intro.current + delta / 2.4);
      const t = intro.current;
      const ease = 1 - Math.pow(1 - t, 3);
      camera.position.lerpVectors(frame.near, frame.home, ease);
      orbit.target.lerpVectors(frame.findingAt ?? frame.centre, frame.centre, ease);
      if (t >= 1) orbit.autoRotate = true;
      orbit.update();
    }
    // Spring for the exploded view.
    const goal = exploded ? 1 : 0;
    const accel = (goal - explode.current) * 60 - explodeVel.current * 12;
    explodeVel.current += accel * delta;
    explode.current += explodeVel.current * delta;
    for (const mesh of meshes) {
      const rest = mesh.userData.rest as Vector3;
      const dir = mesh.userData.dir as Vector3;
      mesh.position.copy(rest).addScaledVector(dir, explode.current * (patient ? 85 : 0.85));
    }
  });

  const setHover = (id: string | null) => {
    if (hovered.current === id) return;
    for (const mesh of meshes) {
      const material = mesh.material as MeshPhysicalMaterial;
      const on = id != null && mesh.userData.structure === id && mesh.userData.tissue !== "glass";
      material.emissive.set(on ? "#3a2614" : "#000000");
    }
    hovered.current = id;
    onHover(id);
  };

  return (
    <>
      <Studio />
      <group matrixAutoUpdate={false} matrix={toScene}>
        <group
          ref={organs}
          onPointerMove={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            const id = (event.object.userData.structure as string | undefined) ?? null;
            const found = manifest.structures.find((item) => item.node === id || item.id === id);
            setHover(found?.id ?? id);
          }}
          onPointerOut={() => setHover(null)}
        >
          <primitive object={gltf.scene} />
        </group>
        {finding ? <FindingGlow position={finding.position} label={findingLabel ?? finding.label} /> : null}
      </group>
      <OrbitControls
        ref={controls as never}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        autoRotateSpeed={0.45}
        enablePan={false}
        minDistance={60}
        maxDistance={2400}
        onStart={() => {
          intro.current = 1;
          if (controls.current) controls.current.autoRotate = false;
        }}
      />
      <EffectComposer multisampling={narrow ? 0 : 4} enableNormalPass={false}>
        <Bloom mipmapBlur luminanceThreshold={1} luminanceSmoothing={0.15} intensity={1.15} radius={0.72} />
        <Vignette offset={0.28} darkness={0.6} />
        <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      </EffectComposer>
    </>
  );
}

function useGlowTexture() {
  return useMemo(() => {
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,240,200,1)");
    gradient.addColorStop(0.18, "rgba(255,212,71,0.75)");
    gradient.addColorStop(0.45, "rgba(255,170,40,0.22)");
    gradient.addColorStop(1, "rgba(255,150,30,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }, []);
}

/** The finding: an HDR core that blooms, a soft halo, and a slow pulse ring. */
function FindingGlow({ position, label }: { position: [number, number, number]; label?: string }) {
  const halo = useRef<Sprite>(null);
  const ring = useRef<Mesh>(null);
  const glow = useGlowTexture();
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    if (halo.current) {
      const s = 30 + Math.sin(t * 2.2) * 3;
      halo.current.scale.set(s, s, 1);
    }
    if (ring.current) {
      const phase = (t * 0.6) % 1;
      ring.current.scale.setScalar(1 + phase * 1.8);
      (ring.current.material as MeshStandardMaterial).opacity = 0.75 * (1 - phase);
    }
  });
  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[3.4, 32, 32]} />
        <meshBasicMaterial color={[7, 5.4, 1.6]} toneMapped={false} />
      </mesh>
      <sprite ref={halo} renderOrder={10}>
        <spriteMaterial
          map={glow}
          transparent
          depthTest={false}
          depthWrite={false}
          blending={AdditiveBlending}
          toneMapped={false}
        />
      </sprite>
      <Billboard>
        <mesh ref={ring} renderOrder={11}>
          <ringGeometry args={[7.2, 8, 64]} />
          <meshBasicMaterial color={[3, 2.3, 0.7]} transparent depthTest={false} depthWrite={false} toneMapped={false} />
        </mesh>
      </Billboard>
      {label ? <FindingLabel text={label} /> : null}
    </group>
  );
}

/** Same language as the 2D card: solid near-black, white type, an ink leader. */
function FindingLabel({ text }: { text: string }) {
  const leader = useMemo(() => {
    const line = squiggleStroke({ x: 6, y: 58 }, { x: 70, y: 8 }, inkSeed(text));
    return outlinePath(brushOutline(line, { size: 2.6 }));
  }, [text]);
  return (
    <Html zIndexRange={[20, 0]} className="pointer-events-none">
      <div className="relative -translate-y-[62px]" data-testid="anatomy-finding-label">
        <svg className="absolute left-0 top-0 overflow-visible" width="76" height="62" aria-hidden="true">
          <path d={leader} fill={INK.authored} />
        </svg>
        <div className="ml-[72px] w-max max-w-[15rem] rounded-xl bg-annotation px-3 py-2 shadow-annotation">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink">Finding</p>
          <p className="mt-0.5 text-sm font-semibold leading-snug text-white">{text}</p>
        </div>
      </div>
    </Html>
  );
}
