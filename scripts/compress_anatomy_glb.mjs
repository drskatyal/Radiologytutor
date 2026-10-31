/**
 * Compress the anatomy glTF.
 *
 * Default codec is EXT_meshopt_compression (decoder ships with three.js).
 * Pass --codec draco to use KHR_draco_mesh_compression instead.
 * Textures become WebP. If `toktx` is on PATH, a second pass writes KTX2
 * (KHR_texture_basisu) — Basis Universal needs the Khronos toktx CLI.
 */
import { spawnSync } from "node:child_process";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, draco, meshopt, prune, textureCompress, weld } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

const input = process.argv[2] || "public/anatomy/lidc-organs.glb";
const codec = process.argv.includes("--codec")
  ? process.argv[process.argv.indexOf("--codec") + 1]
  : "meshopt";

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    "draco3d.encoder": await draco3d.createEncoderModule(),
    "draco3d.decoder": await draco3d.createDecoderModule(),
    "meshopt.encoder": MeshoptEncoder,
  });

const document = await io.read(input);
const transforms = [
  prune(),
  dedup(),
  weld(),
  textureCompress({
    encoder: sharp,
    targetFormat: "webp",
    slots: /^(?!normalTexture).*$/,
    quality: 78,
  }),
  textureCompress({
    encoder: sharp,
    targetFormat: "webp",
    slots: /^normalTexture$/,
    quality: 90,
    lossless: false,
  }),
];
if (codec === "draco") {
  transforms.push(draco({ method: "edgebreaker" }));
} else {
  transforms.push(meshopt({ encoder: MeshoptEncoder, level: "medium" }));
}
await document.transform(...transforms);
await io.write(input, document);
console.log(`compressed ${input} with ${codec}`);

if (spawnSync("toktx", ["--version"], { encoding: "utf8" }).status === 0) {
  const ktx = input.replace(/\.glb$/, ".ktx2.glb");
  const result = spawnSync(
    "npx",
    ["--yes", "@gltf-transform/cli", "ktx2", input, ktx, "--format", "etc1s"],
    { stdio: "inherit" }
  );
  if (result.status === 0) console.log(`ktx2 ${ktx}`);
} else {
  console.log("toktx not installed — textures stayed WebP. Install KTX-Software for the KTX2 pass.");
}
