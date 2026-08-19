import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * FlowRad Learn design tokens.
 *
 * Clinical reading-room: warm charcoal, film-marker amber accent, no glow
 * washes. Imaging surfaces stay pure black (`bg-imaging`).
 */
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        overlay: "rgb(var(--overlay) / <alpha-value>)",
        imaging: "#000000",
        primary: "rgb(var(--text-primary) / <alpha-value>)",
        secondary: "rgb(var(--text-secondary) / <alpha-value>)",
        muted: "rgb(var(--text-muted) / <alpha-value>)",
        subtle: "rgb(var(--border-subtle) / <alpha-value>)",
        strong: "rgb(var(--border-strong) / <alpha-value>)",
        accent: {
          DEFAULT: "rgb(var(--accent) / <alpha-value>)",
          foreground: "rgb(var(--accent-foreground) / <alpha-value>)",
          muted: "rgb(var(--accent-muted) / <alpha-value>)",
          bright: "rgb(var(--accent-bright) / <alpha-value>)",
        },
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        card: {
          DEFAULT: "rgb(var(--card) / <alpha-value>)",
          foreground: "rgb(var(--card-foreground) / <alpha-value>)",
        },
        popover: {
          DEFAULT: "rgb(var(--popover) / <alpha-value>)",
          foreground: "rgb(var(--popover-foreground) / <alpha-value>)",
        },
        destructive: {
          DEFAULT: "rgb(var(--destructive) / <alpha-value>)",
          foreground: "rgb(var(--destructive-foreground) / <alpha-value>)",
        },
        border: "rgb(var(--border) / <alpha-value>)",
        input: "rgb(var(--input) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",
      },
      borderColor: {
        DEFAULT: "rgb(var(--border-subtle) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: [
          "var(--font-display)",
          "ui-serif",
          "Georgia",
          "Times New Roman",
          "serif",
        ],
      },
      letterSpacing: {
        tightest: "-0.02em",
      },
      borderRadius: {
        lg: "var(--radius)",
        xl: "0.75rem",
        "2xl": "1rem",
        "3xl": "1.25rem",
      },
      boxShadow: {
        sm: "0 1px 2px 0 rgb(0 0 0 / 0.35)",
        md: "0 4px 12px -2px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.3)",
        lg: "0 12px 28px -8px rgb(0 0 0 / 0.5), 0 4px 8px -4px rgb(0 0 0 / 0.35)",
        focus: "0 0 0 3px rgb(var(--accent) / 0.3)",
        glow: "0 0 0 1px rgb(var(--accent) / 0.4)",
      },
      backgroundImage: {
        "accent-sheen":
          "linear-gradient(180deg, rgb(var(--accent-bright)), rgb(var(--accent)))",
        "surface-fade":
          "linear-gradient(180deg, rgb(var(--elevated)), rgb(var(--surface)))",
        "grid-faint":
          "linear-gradient(rgb(var(--border-subtle) / 0.45) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--border-subtle) / 0.45) 1px, transparent 1px)",
      },
      keyframes: {
        "marker-pulse": {
          "0%": { boxShadow: "0 0 0 0 rgb(var(--accent) / 0.45)" },
          "70%": { boxShadow: "0 0 0 12px rgb(var(--accent) / 0)" },
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
          "0%": { boxShadow: "0 0 0 0 rgb(var(--danger) / 0.45)" },
          "70%": { boxShadow: "0 0 0 12px rgb(var(--danger) / 0)" },
          "100%": { boxShadow: "0 0 0 0 rgb(var(--danger) / 0)" },
        },
        "overlay-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "overlay-out": {
          from: { opacity: "1" },
          to: { opacity: "0" },
        },
        "modal-in": {
          from: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        "modal-out": {
          from: { opacity: "1", transform: "translateY(0) scale(1)" },
          to: { opacity: "0", transform: "translateY(8px) scale(0.98)" },
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
  plugins: [animate],
};

export default config;
