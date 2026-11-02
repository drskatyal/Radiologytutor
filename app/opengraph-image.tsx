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
          background: "#F7F5F1",
          color: "#121212",
          padding: "80px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "64px",
              height: "64px",
              borderRadius: "12px",
              background: "#1C3AD6",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              padding: "12px",
              gap: "4px",
            }}
          >
            <div style={{ width: "22px", height: "4px", borderRadius: "2px", background: "#ffffff", opacity: 0.55 }} />
            <div style={{ width: "30px", height: "4px", borderRadius: "2px", background: "#ffffff", opacity: 0.8 }} />
            <div style={{ width: "40px", height: "4px", borderRadius: "2px", background: "#ffffff" }} />
          </div>
          <div style={{ display: "flex", fontSize: 36, letterSpacing: "-0.03em" }}>
            <span style={{ color: "#121212" }}>Rad</span>
            <span style={{ color: "#1C3AD6" }}>Learn</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", fontSize: 68, lineHeight: 1.05, letterSpacing: "-0.03em", maxWidth: 900 }}>
          <span style={{ color: "#000000" }}>Teach a case once.</span>
          <span style={{ color: "#666666" }}>The tutor replays it on the study.</span>
        </div>
      </div>
    ),
    size
  );
}
