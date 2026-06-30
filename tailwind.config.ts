import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "sans-serif"],
      },
      colors: {
        surface: {
          DEFAULT: "#0a0a0f",
          card: "#111118",
          elevated: "#16161f",
          border: "#1e1e2e",
          hover: "#1a1a28",
        },
        accent: {
          primary: "#6366f1",
          glow: "#818cf8",
          emerald: "#10b981",
          amber: "#f59e0b",
          red: "#ef4444",
          violet: "#8b5cf6",
        },
        text: {
          primary: "#f1f5f9",
          secondary: "#94a3b8",
          muted: "#475569",
        },
      },
    },
  },
  plugins: [],
};
export default config;
