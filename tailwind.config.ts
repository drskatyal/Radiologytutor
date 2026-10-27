import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * RadLearn design tokens.
 *
 * Paper canvas, white surfaces, cobalt signal. Imaging stays pure black
 * (`bg-imaging`). `ease-draw` is cubic-bezier(0.22, 1, 0.36, 1).
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
        display: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
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
        sm: "0 1px 2px 0 rgb(18 18 18 / 0.06)",
        md: "0 8px 24px -8px rgb(18 18 18 / 0.12)",
        lg: "0 24px 48px -16px rgb(18 18 18 / 0.16)",
        focus: "0 0 0 3px rgb(var(--accent) / 0.3)",
        glow: "0 0 0 1px rgb(var(--accent) / 0.4)",
      },
      backgroundImage: {},
      transitionTimingFunction: {
        draw: "cubic-bezier(0.22, 1, 0.36, 1)",
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
        "slice-drift": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
        "voice-level": {
          "0%, 100%": { transform: "scaleY(0.4)" },
          "50%": { transform: "scaleY(1)" },
        },
      },
      animation: {
        "marker-pulse": "marker-pulse 1.6s infinite",
        "fade-in": "fade-in 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
        "fade-up": "fade-up 0.6s cubic-bezier(0.22, 1, 0.36, 1)",
        "mic-pulse": "mic-pulse 1.5s infinite",
        "overlay-in": "overlay-in 0.3s cubic-bezier(0.22, 1, 0.36, 1)",
        "modal-in": "modal-in 0.5s cubic-bezier(0.22, 1, 0.36, 1)",
        shimmer: "shimmer 1.6s infinite",
        "slice-drift": "slice-drift 4.8s cubic-bezier(0.22, 1, 0.36, 1) infinite",
        "voice-level": "voice-level 1.2s cubic-bezier(0.22, 1, 0.36, 1) infinite",
      },
    },
  },
  plugins: [animate],
};

export default config;
