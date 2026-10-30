/**
 * Writes public/anatomy/generic-schematic.glb from the catalog.
 * Original low-poly schematic. CC0. Not a patient segmentation.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GENERIC_STRUCTURES } from "../lib/anatomyCatalog";

type Vec3 = [number, number, number];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function icosphere(subdiv: number): { positions: Float32Array; indices: Uint16Array } {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts: Vec3[] = (
    [
      [-1, t, 0],
      [1, t, 0],
      [-1, -t, 0],
      [1, -t, 0],
      [0, -1, t],
      [0, 1, t],
      [0, -1, -t],
      [0, 1, -t],
      [t, 0, -1],
      [t, 0, 1],
      [-t, 0, -1],
      [-t, 0, 1],
    ] as Vec3[]
  ).map(normalize);
  let faces: Array<[number, number, number]> = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let level = 0; level < subdiv; level++) {
    const cache = new Map<string, number>();
    const next: Array<[number, number, number]> = [];
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = cache.get(key);
      if (hit != null) return hit;
      const va = verts[a]!;
      const vb = verts[b]!;
      const idx = verts.length;
      verts.push(normalize([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]));
      cache.set(key, idx);
      return idx;
    };
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => {
    positions[i * 3] = v[0];
    positions[i * 3 + 1] = v[1];
    positions[i * 3 + 2] = v[2];
  });
  const indices = new Uint16Array(faces.length * 3);
  faces.forEach((face, i) => {
    indices[i * 3] = face[0];
    indices[i * 3 + 1] = face[1];
    indices[i * 3 + 2] = face[2];
  });
  return { positions, indices };
}

function hexToFactor(hex: string): [number, number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

function pad(length: number, align: number): number {
  return (align - (length % align)) % align;
}

function build(): Buffer {
  const { positions, indices } = icosphere(2);
  const posBytes = Buffer.from(positions.buffer);
  const norBytes = Buffer.from(positions.buffer); // unit sphere: normal = position
  const idxBytes = Buffer.from(indices.buffer);
  const bin = Buffer.concat([
    posBytes,
    Buffer.alloc(pad(posBytes.length, 4)),
    norBytes,
    Buffer.alloc(pad(norBytes.length, 4)),
    idxBytes,
  ]);
  const posView = 0;
  const posLen = posBytes.length;
  const norOffset = posLen + pad(posLen, 4);
  const norLen = norBytes.length;
  const idxOffset = norOffset + norLen + pad(norLen, 4);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  const json = {
    asset: {
      version: "2.0",
      generator: "radlearn-schematic",
      copyright: "CC0-1.0. Generic schematic anatomy. Not a patient CT.",
    },
    scene: 0,
    scenes: [{ nodes: GENERIC_STRUCTURES.map((_, index) => index) }],
    nodes: GENERIC_STRUCTURES.map((item, index) => ({
      name: item.node,
      mesh: index,
      translation: item.position,
      scale: item.scale,
    })),
    meshes: GENERIC_STRUCTURES.map((item, index) => ({
      name: item.node,
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
          material: index,
        },
      ],
    })),
    materials: GENERIC_STRUCTURES.map((item) => ({
      name: item.node,
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: hexToFactor(item.color),
        metallicFactor: 0.04,
        roughnessFactor: 0.62,
      },
    })),
    accessors: [
      {
        bufferView: posView,
        componentType: 5126,
        count: positions.length / 3,
        type: "VEC3",
        min,
        max,
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: positions.length / 3,
        type: "VEC3",
      },
      {
        bufferView: 2,
        componentType: 5123,
        count: indices.length,
        type: "SCALAR",
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posLen, target: 34962 },
      { buffer: 0, byteOffset: norOffset, byteLength: norLen, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = Buffer.alloc(pad(jsonBuf.length, 4), 0x20);
  const binPad = Buffer.alloc(pad(bin.length, 4), 0);
  const jsonChunk = jsonBuf.length + jsonPad.length;
  const binChunk = bin.length + binPad.length;
  const total = 12 + 8 + jsonChunk + 8 + binChunk;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let offset = 12;
  out.writeUInt32LE(jsonChunk, offset);
  offset += 4;
  out.writeUInt32LE(0x4e4f534a, offset);
  offset += 4;
  jsonBuf.copy(out, offset);
  offset += jsonBuf.length;
  jsonPad.copy(out, offset);
  offset += jsonPad.length;
  out.writeUInt32LE(binChunk, offset);
  offset += 4;
  out.writeUInt32LE(0x004e4942, offset);
  offset += 4;
  bin.copy(out, offset);
  return out;
}

const target = join(process.cwd(), "public/anatomy/generic-schematic.glb");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, build());
console.log(`wrote ${target}`);
