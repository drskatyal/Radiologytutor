/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fly.io / Docker: minimal Node server image.
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
};

export default nextConfig;
