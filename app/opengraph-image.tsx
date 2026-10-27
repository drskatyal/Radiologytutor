import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "RadLearn. Teach a case once. The tutor replays it on the study.";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#000000",
          color: "#ffffff",
          padding: "80px",
        }}
      >
        <div style={{ display: "flex", fontSize: 28, letterSpacing: "-0.02em" }}>RadLearn</div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 68, lineHeight: 1.05, letterSpacing: "-0.03em", maxWidth: 900 }}>
          <span>Teach a case once.</span>
          <span style={{ color: "#9B9B9B" }}>The tutor replays it on the study.</span>
        </div>
      </div>
    ),
    size
  );
}
