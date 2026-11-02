// Same token system as the web app (tailwind.config.ts at the repo root); the
// desktop only widens `content` and sets dark reading-room values for the
// CSS variables in src/styles.css.
import base from "../tailwind.config";
import type { Config } from "tailwindcss";

const config: Config = {
  ...base,
  content: ["./index.html", "./src/**/*.{ts,tsx}", "../components/ui/**/*.{ts,tsx}", "../components/viewer/**/*.{ts,tsx}"],
};

export default config;
