import type { MetadataRoute } from "next";

// Web app manifest (served at /manifest.webmanifest and linked automatically by
// Next). Icons are the FlowRad "Owl Scan" mark, generated into public/ from the
// shared brand/ sources: the same mark for every FlowRad product.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FlowRad Learn",
    short_name: "FlowRad",
    description:
      "Teach radiology on the DICOM study. Record a case once. Registrars replay it with an AI tutor that drives scroll, window, and zoom.",
    start_url: "/",
    display: "standalone",
    background_color: "#F7F5F1",
    theme_color: "#0F4D3A",
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
