import type { MetadataRoute } from "next";

// Web app manifest (served at /manifest.webmanifest). Icons are the FlowRad
// "Owl Scan" mark, the same mark for every FlowRad product.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FlowRad Viewer",
    short_name: "FlowRad Viewer",
    description: "A free DICOM viewer. Open a study in your browser; nothing is uploaded.",
    start_url: "/viewer",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#0F4D3A",
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
