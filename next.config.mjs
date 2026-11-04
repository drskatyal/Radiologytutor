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
  // Offline voice commands: the ~40 MB model and the recognizer worker change
  // only with scripts/voice-model.sha256 / vosk-browser. Cache them, so a
  // second "mic on" (or a hover warm-up) reads them from disk, not the network.
  async redirects() {
    return [{ source: "/viewer/local", destination: "/viewer", permanent: true }];
  },
  async headers() {
    return [
      // Framing: only /embed/<token> may be put in another site's iframe.
      // Everything else (sign-in, library, share management) refuses framing,
      // so it cannot be clickjacked.
      {
        source: "/:path((?!embed/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        source: "/embed/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Share tokens are in the URL: never leak them to the embedding page's links.
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/voice/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=604800, stale-while-revalidate=86400" }],
      },
    ];
  },
  webpack: (config) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    config.module.rules.push({ test: /\.wasm/, type: "asset/resource" });
    return config;
  },
  // Keep Node-only SDKs out of the webpack graph (R2 / Mongo).
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],
  experimental: {
    serverComponentsExternalPackages: [
      "@aws-sdk/client-s3",
      "@aws-sdk/s3-request-presigner",
      "mongodb",
      "dicom-parser",
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
