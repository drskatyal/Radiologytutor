import type { Config } from "tailwindcss";

/**
 * FlowRad Learn design tokens.
 *
 * Colors are wired to CSS variables defined in `app/globals.css` so the whole
 * app themes from one place. The palette is a calm, clinical dark "reading
 * room" theme with a single decisive accent. Imaging surfaces stay pure black
 * regardless of theme (`bg-imaging`).
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surfaces
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        imaging: "#000000",
        // Text
        primary: "rgb(var(--text-primary) / <alpha-value>)",
        secondary: "rgb(var(--text-secondary) / <alpha-value>)",
        muted: "rgb(var(--text-muted) / <alpha-value>)",
        // Borders
        subtle: "rgb(var(--border-subtle) / <alpha-value>)",
        strong: "rgb(var(--border-strong) / <alpha-value>)",
        // Accent
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          foreground: "rgb(var(--accent-foreground) / <alpha-value>)",
          muted: "rgb(var(--accent-muted) / <alpha-value>)",
        },
        // Semantic
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
      },
      // Map Tailwind's border/text/bg default to token-aware values where it
      // helps, while keeping explicit token utilities (border-subtle, etc.).
      borderColor: {
        DEFAULT: "rgb(var(--border-subtle) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        lg: "0.625rem", // 10px — default for cards/controls
        xl: "0.875rem",
        "2xl": "1.125rem",
      },
      boxShadow: {
        // Soft, subtle elevation — used only on floating/elevated surfaces.
        sm: "0 1px 2px 0 rgb(0 0 0 / 0.4)",
        md: "0 4px 12px -2px rgb(0 0 0 / 0.5)",
        lg: "0 12px 32px -8px rgb(0 0 0 / 0.6)",
        focus: "0 0 0 3px rgb(var(--accent) / 0.35)",
      },
      keyframes: {
        "marker-pulse": {
          "0%": { boxShadow: "0 0 0 0 rgb(var(--accent) / 0.6)" },
          "70%": { boxShadow: "0 0 0 16px rgb(var(--accent) / 0)" },
          "100%": { boxShadow: "0 0 0 0 rgb(var(--accent) / 0)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "scale(0.6)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "mic-pulse": {
          "0%": { boxShadow: "0 0 0 0 rgb(var(--danger) / 0.55)" },
          "70%": { boxShadow: "0 0 0 14px rgb(var(--danger) / 0)" },
          "100%": { boxShadow: "0 0 0 0 rgb(var(--danger) / 0)" },
        },
        "overlay-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "modal-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        spin: {
          to: { transform: "rotate(360deg)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "marker-pulse": "marker-pulse 1.6s infinite",
        "fade-in": "fade-in 0.4s ease-out",
        "fade-up": "fade-up 0.25s ease-out",
        "mic-pulse": "mic-pulse 1.5s infinite",
        "overlay-in": "overlay-in 0.15s ease-out",
        "modal-in": "modal-in 0.18s cubic-bezier(0.16, 1, 0.3, 1)",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
