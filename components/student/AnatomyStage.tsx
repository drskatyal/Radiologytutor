"use client";

// Organ scene for one de-identified study. Meshes carry baked PBR maps.
// Opening the panel plays the slice forward into the volume, then eases
// the camera out. Rotation keeps a little inertia. Explode is a spring.

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Environment, Html, Lightformer, Line, OrbitControls, useGLTF } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Box3,
  Color,
  DoubleSide,
  Mesh,
  MeshPhysicalMaterial,
  TextureLoader,
  Vector3,
  type Group,
} from "three";
import type { AnatomyManifest, AnatomyStructure } from "@/lib/anatomyCatalog";

type OrbitHandle = {
  target: Vector3;
  update: () => void;
  enableDamping: boolean;
  dampingFactor: number;
};

export default function AnatomyStage({
  manifest,
  selected,
  onSelect,
  exploded,
  sliceImage,
}: {
  manifest: AnatomyManifest;
  selected: string;
  onSelect: (id: string) => void;
  exploded: boolean;
  sliceImage?: string | null;
}) {
  const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 820px)").matches;
  const [loop, setLoop] = useState<"always" | "demand">("always");
  useEffect(() => {
    const timer = window.setTimeout(() => setLoop("demand"), 4200);
    return () => window.clearTimeout(timer);
  }, [selected, exploded, sliceImage]);
  const home = manifest.structures[0]?.camera ?? [0, 40, 400];
  return (
    <Canvas
      shadows
      dpr={narrow ? [1, 1.15] : [1, 1.5]}
      frameloop={loop}
      camera={{ position: home, fov: 34, near: 1, far: 5000 }}
      gl={{ antialias: !narrow, alpha: false, powerPreference: "low-power" }}
      onPointerMissed={() => setLoop("always")}
    >
      <Suspense fallback={null}>
        <Scene
          manifest={manifest}
          selected={selected}
          onSelect={onSelect}
          exploded={exploded}
          sliceImage={sliceImage ?? null}
          onActivity={() => setLoop("always")}
        />
      </Suspense>
    </Canvas>
  );
}

function Scene({
  manifest,
  selected,
  onSelect,
  exploded,
  sliceImage,
  onActivity,
}: {
  manifest: AnatomyManifest;
  selected: string;
  onSelect: (id: string) => void;
  exploded: boolean;
  sliceImage: string | null;
  onActivity: () => void;
}) {
  const gltf = useGLTF(manifest.glb, false, true);
  const controls = useRef<OrbitHandle>(null);
  const dragging = useRef(false);
  const spin = useRef(0);
  const intro = useRef(0);
  const explode = useRef(0);
  const explodeVel = useRef(0);
  const { camera } = useThree();
  const structure = manifest.structures.find((item) => item.id === selected) ?? manifest.structures[0];
  const finding = manifest.findings.find((item) => item.findingId === manifest.activeFindingId) ?? manifest.findings[0];
  const sliceTexture = useMemo(() => (sliceImage ? new TextureLoader().load(sliceImage) : null), [sliceImage]);

  useEffect(() => {
    gltf.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const name = mesh.name || mesh.parent?.name || "";
      const raw = mesh.material;
      const material = (Array.isArray(raw) ? raw[0] : raw) as MeshPhysicalMaterial | undefined;
      if (!material) return;
      if (material.normalScale) material.normalScale.set(0.28, 0.28);
      if ("emissive" in material) {
        const lit = name === structure?.node || name.startsWith(`${structure?.node}__`);
        material.emissive = new Color(lit ? "#4a3014" : "#000000");
        material.emissiveIntensity = lit ? 0.12 : 0;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = !name.includes("lung");
      if (name.includes("lung")) {
        material.transparent = true;
        material.opacity = 0.38;
        material.depthWrite = false;
        material.color = new Color("#f3d5dc");
        material.roughness = 0.72;
        mesh.renderOrder = 2;
      }
      if (!mesh.userData.ready) {
        const box = new Box3().setFromObject(mesh);
        const center = box.getCenter(new Vector3());
        // The camera sits on +Y. Drop that axis so organs peel sideways
        // instead of flying into the lens.
        const dir = new Vector3(center.x, 0, center.z);
        if (dir.lengthSq() < 1) dir.set(center.x, 0, 1);
        dir.normalize();
        mesh.userData.ready = true;
        mesh.userData.rest = mesh.position.clone();
        mesh.userData.dir = dir;
      }
    });
  }, [gltf, structure]);

  useFrame((_, delta) => {
    const orbit = controls.current;
    if (!orbit || !structure) return;
    intro.current = Math.min(1, intro.current + delta * 1.15);
    const ease = intro.current * intro.current * (3 - 2 * intro.current);
    const target = exploded ? 1 : 0;
    const accel = (target - explode.current) * 16 - explodeVel.current * 6.5;
    explodeVel.current += accel * delta;
    explode.current += explodeVel.current * delta;
    gltf.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      const rest = mesh.userData.rest as Vector3 | undefined;
      const dir = mesh.userData.dir as Vector3 | undefined;
      if (!rest || !dir || !mesh.isMesh) return;
      mesh.position.copy(rest).addScaledVector(dir, explode.current * 140);
    });
    const distance = camera.position.distanceTo(orbit.target);
    const level = distance > 980 ? 2 : distance > 720 ? 1 : 0;
    gltf.scene.traverse((obj) => {
      if (!obj.name) return;
      if (obj.name.endsWith("__lod2")) obj.visible = level === 2;
      else if (obj.name.endsWith("__lod1")) obj.visible = level === 1;
      else if (manifest.structures.some((item) => item.node === obj.name)) obj.visible = level === 0;
    });
    const look = new Vector3(structure.position[0] * 0.35, structure.position[1] * 0.35, structure.position[2] * 0.2);
    const far = look.clone().add(new Vector3(40, 860, 60));
    const sliceZ = finding ? finding.position[2] : 0;
    const close = new Vector3(finding?.position[0] ?? 0, (finding?.position[1] ?? 0) + 30, sliceZ + 720);
    if (ease < 1 && !dragging.current) {
      camera.position.lerpVectors(close, far, ease);
      orbit.target.lerpVectors(new Vector3(close.x, close.y, sliceZ), look, ease);
    } else if (!dragging.current) {
      spin.current *= Math.exp(-delta * 0.35);
      const offset = camera.position.clone().sub(orbit.target);
      const angle = delta * (0.12 + spin.current);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      camera.position.set(
        orbit.target.x + offset.x * cos - offset.z * sin,
        camera.position.y,
        orbit.target.z + offset.x * sin + offset.z * cos
      );
    }
    camera.lookAt(orbit.target);
    orbit.update();
  });

  const floor = useMemo(() => new Box3().setFromObject(gltf.scene).min.y, [gltf]);
  const sliceZ = finding?.position[2] ?? 0;

  return (
    <>
      <color attach="background" args={["#000000"]} />
      <ambientLight intensity={0.18} />
      <directionalLight position={[140, 220, 90]} intensity={1.5} castShadow color="#fff4ea" />
      <directionalLight position={[-160, 30, -40]} intensity={0.32} color="#c9d8ff" />
      <Environment resolution={64}>
        <Lightformer form="rect" intensity={3.2} position={[0, 4, 6]} scale={[9, 4, 1]} color="#fff1e4" />
        <Lightformer form="rect" intensity={1.2} position={[-6, 1, -2]} scale={[4, 3, 1]} color="#c5d4ff" />
        <Lightformer form="rect" intensity={0.7} position={[5, -1, 2]} scale={[3, 2, 1]} color="#ffcfc4" />
      </Environment>
      <group
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation();
          const name = (event.object.name || event.object.parent?.name || "").replace(/__lod[12]$/, "");
          const found = manifest.structures.find((item) => item.node === name || item.id === name);
          if (found) onSelect(found.id);
        }}
      >
        <primitive object={gltf.scene} />
      </group>
      <mesh position={[0, 0, sliceZ]} renderOrder={2}>
        <planeGeometry args={[390, 390]} />
        <meshBasicMaterial
          map={sliceTexture ?? undefined}
          color={sliceTexture ? "#ffffff" : "#1a1a1a"}
          transparent
          opacity={sliceTexture ? 0.88 : 0.35}
          side={DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {structure ? <StructureLabel item={structure} onSelect={onSelect} /> : null}
      {finding ? <FindingMark position={finding.position} /> : null}
      <ContactShadows position={[0, floor, 0]} opacity={0.42} scale={760} blur={2.6} far={420} color="#000" />
      <OrbitControls
        ref={controls as never}
        enablePan
        enableDamping
        dampingFactor={0.08}
        makeDefault
        minDistance={70}
        maxDistance={980}
        onStart={() => {
          dragging.current = true;
          onActivity();
        }}
        onEnd={() => {
          dragging.current = false;
          spin.current = 0.55;
        }}
      />
    </>
  );
}

function StructureLabel({ item, onSelect }: { item: AnatomyStructure; onSelect: (id: string) => void }) {
  const anchor = item.position;
  const label: [number, number, number] = [anchor[0] + 24, anchor[1] + 96, anchor[2]];
  return (
    <group>
      <Line points={[anchor, label]} color="#FFE14A" lineWidth={1.2} transparent opacity={0.85} />
      <Html position={label} center zIndexRange={[20, 0]}>
        <button
          type="button"
          className="pointer-events-auto whitespace-nowrap rounded-full bg-[#14110e]/88 px-2 py-0.5 font-hand text-[13px] tracking-tight text-[#FFE14A] shadow-[0_8px_18px_rgba(0,0,0,0.5)] ring-1 ring-[#FFE14A]/45"
          onClick={(event) => {
            event.stopPropagation();
            onSelect(item.id);
          }}
        >
          {item.label}
        </button>
      </Html>
    </group>
  );
}

function FindingMark({ position }: { position: [number, number, number] }) {
  const group = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const pulse = 1 + Math.sin(clock.elapsedTime * 3) * 0.05;
    group.current.scale.setScalar(pulse);
  });
  return (
    <group position={position}>
      <group ref={group}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[11, 1.15, 12, 48]} />
          <meshStandardMaterial color="#FFE14A" emissive="#FFE14A" emissiveIntensity={1.1} roughness={0.28} />
        </mesh>
      </group>
    </group>
  );
}
