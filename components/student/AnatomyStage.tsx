"use client";

// Lazy 3D stage. Imported only after the learner opens "Show in 3D",
// so three.js is not on the path to the first DICOM pixel.

import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, OrbitControls, useGLTF } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef } from "react";
import { Vector3, type Mesh, type MeshStandardMaterial } from "three";
import { GENERIC_STRUCTURES, structureById } from "@/lib/anatomyCatalog";

type OrbitHandle = { target: Vector3; update: () => void };

useGLTF.preload("/anatomy/generic-schematic.glb");

function Schematic({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  const gltf = useGLTF("/anatomy/generic-schematic.glb");
  const controls = useRef<OrbitHandle>(null);
  const flying = useRef(true);
  const { camera } = useThree();
  const dest = useMemo(() => new Vector3(1.6, 0.9, 3.1), []);
  const look = useMemo(() => new Vector3(0, 0.4, 0), []);
  const structure = structureById(selected) ?? GENERIC_STRUCTURES[0]!;

  useEffect(() => {
    flying.current = true;
    dest.set(structure.camera[0], structure.camera[1], structure.camera[2]);
    look.set(structure.position[0], structure.position[1], structure.position[2]);
  }, [structure, dest, look]);

  useFrame(() => {
    if (!flying.current) return;
    camera.position.lerp(dest, 0.09);
    const orbit = controls.current;
    if (orbit) {
      orbit.target.lerp(look, 0.12);
      orbit.update();
    }
    if (camera.position.distanceTo(dest) < 0.03) flying.current = false;
  });

  useEffect(() => {
    gltf.scene.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const material = mesh.material as MeshStandardMaterial;
      if (!material?.emissive) return;
      material.emissive.set(mesh.name === structure.node ? "#5a3b16" : "#000000");
    });
  }, [gltf, structure]);

  return (
    <>
      <color attach="background" args={["#000000"]} />
      <ambientLight intensity={0.62} />
      <directionalLight position={[2.6, 3.4, 4.2]} intensity={1.35} />
      <directionalLight position={[-2.4, -1.2, -2]} intensity={0.4} />
      <primitive
        object={gltf.scene}
        onClick={(event: ThreeEvent<MouseEvent>) => {
          event.stopPropagation();
          const name = event.object.name || event.object.parent?.name || "";
          const found = structureById(name);
          if (found) onSelect(found.id);
        }}
      />
      {GENERIC_STRUCTURES.map((item) => (
        <Html key={item.id} position={item.position} center zIndexRange={[30, 0]}>
          <button
            type="button"
            className="pointer-events-auto whitespace-nowrap rounded-md bg-[#181818]/92 px-1.5 py-0.5 font-hand text-[13px] leading-none text-[#FFE14A] ring-1 ring-[#FFE14A]/70"
            onClick={(event) => {
              event.stopPropagation();
              onSelect(item.id);
            }}
          >
            {item.label}
          </button>
        </Html>
      ))}
      <OrbitControls
        ref={controls as never}
        enablePan
        makeDefault
        minDistance={1.15}
        maxDistance={8}
        onStart={() => {
          flying.current = false;
        }}
      />
    </>
  );
}

export default function AnatomyStage({
  selected,
  onSelect,
}: {
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <Canvas camera={{ position: [1.7, 0.85, 3.3], fov: 40 }} dpr={[1, 1.75]}>
      <Suspense fallback={null}>
        <Schematic selected={selected} onSelect={onSelect} />
      </Suspense>
    </Canvas>
  );
}
