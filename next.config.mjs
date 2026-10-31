/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fly.io / Cloud Run: minimal Node server image. Cloud Run injects PORT.
  output: "standalone",
  // Cornerstone3D self-hosted viewer support (see components/CornerstoneViewer.tsx).
  // The @cornerstonejs/dicom-image-loader bundles its web workers + WASM codecs
  // internally (v2+), so the only webpack tweaks needed are:
  //   - fs:false  — one transitive dep references node's `fs`
  //   - .wasm as a static asset so the codec binaries resolve at runtime
  // NOTE: this only applies to the default webpack builder — do NOT run with --turbo.
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    config.module.rules.push({ test: /\.wasm/, type: "asset/resource" });
    return config;
  },
  // Keep Node-only SDKs out of the webpack graph (R2 / Mongo).
  experimental: {
    serverComponentsExternalPackages: [
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-request-presigner",
      "mongodb",
      "dicom-parser",
      "better-auth",
      "@better-auth/mongo-adapter",
      "@better-auth/memory-adapter",
      // Server-side HTJ2K / JPEG encoders for lib/dicomCdn (emscripten glue
      // finds its .wasm via __dirname, so it must not be bundled).
      "@cornerstonejs/codec-openjph",
      "@cornerstonejs/codec-libjpeg-turbo-8bit",
    ],
    // lib/dicomCdn/encode.ts requires the codecs at runtime by name, which
    // the standalone tracer cannot see. Ship them with every route that can
    // start a conversion (upload, first view via the manifest API).
    outputFileTracingIncludes: {
      "/api/upload": [
        "./node_modules/@cornerstonejs/codec-openjph/**/*",
        "./node_modules/@cornerstonejs/codec-libjpeg-turbo-8bit/**/*",
      ],
      "/api/dicom-cdn/manifest": [
        "./node_modules/@cornerstonejs/codec-openjph/**/*",
        "./node_modules/@cornerstonejs/codec-libjpeg-turbo-8bit/**/*",
      ],
    },
  },
};

export default nextConfig;
