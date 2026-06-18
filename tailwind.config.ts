import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * FlowRad Learn design tokens.
 *
 * Colors are wired to CSS variables defined in `app/globals.css` so the whole
 * app themes from one place. The palette is a bespoke dark "reading room" theme
 * with a single decisive signature accent (electric clinical cyan). Imaging
 * surfaces stay pure black regardless of theme (`bg-imaging`).
 *
 * Both our semantic token names and shadcn/ui's token names point at the same
 * CSS variables, so primitives layered on Radix/shadcn theme identically.
 */
const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Surfaces
        canvas: "rgb(var(--canvas) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        overlay: "rgb(var(--overlay) / <alpha-value>)",
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
          bright: "rgb(var(--accent-bright) / <alpha-value>)",
        },
        // Semantic
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",

        // shadcn/ui aliases — same palette, their vocabulary. Lets shadcn-derived
        // primitives (and `bg-background`, `text-foreground`, etc.) just work.
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
      // Map Tailwind's border/text/bg default to token-aware values where it
      // helps, while keeping explicit token utilities (border-subtle, etc.).
      borderColor: {
        DEFAULT: "rgb(var(--border-subtle) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: [
          "var(--font-display)",
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
      },
      letterSpacing: {
        tightest: "-0.03em",
      },
      borderRadius: {
        lg: "var(--radius)", // 10px — default for cards/controls
        xl: "0.875rem",
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
      boxShadow: {
        // Layered, soft elevation — used on floating/elevated surfaces. The
        // inset top hairline reads as a lit beveled edge.
        sm: "0 1px 2px 0 rgb(0 0 0 / 0.45), inset 0 1px 0 0 rgb(255 255 255 / 0.03)",
        md: "0 6px 16px -4px rgb(0 0 0 / 0.55), 0 2px 4px -2px rgb(0 0 0 / 0.4), inset 0 1px 0 0 rgb(255 255 255 / 0.04)",
        lg: "0 18px 44px -12px rgb(0 0 0 / 0.7), 0 4px 12px -4px rgb(0 0 0 / 0.5), inset 0 1px 0 0 rgb(255 255 255 / 0.05)",
        focus: "0 0 0 3px rgb(var(--accent) / 0.35)",
        glow: "0 0 0 1px rgb(var(--accent) / 0.45), 0 10px 36px -10px rgb(var(--accent) / 0.4)",
      },
      backgroundImage: {
        "accent-sheen":
          "linear-gradient(135deg, rgb(var(--accent-bright) / 0.95), rgb(var(--accent)) 55%, rgb(var(--accent) / 0.85))",
        "surface-fade":
          "linear-gradient(180deg, rgb(var(--elevated)), rgb(var(--surface)))",
        "grid-faint":
          "linear-gradient(rgb(var(--border-subtle) / 0.5) 1px, transparent 1px), linear-gradient(90deg, rgb(var(--border-subtle) / 0.5) 1px, transparent 1px)",
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
        "glow-breathe": {
          "0%, 100%": { opacity: "0.5" },
          "50%": { opacity: "1" },
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
        "glow-breathe": "glow-breathe 3s ease-in-out infinite",
      },
    },
  },
  plugins: [animate],
};

export default config;
