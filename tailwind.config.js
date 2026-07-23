/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      colors: {
        bg: "var(--c-bg)",
        panel: "var(--c-panel)",
        "panel-alt": "var(--c-panel-alt)",
        "panel-raised": "var(--c-panel-raised)",
        edge: "var(--c-border)",
        ink: "var(--c-text)",
        dim: "var(--c-dim)",
        position: {
          long: "var(--c-long)",
          short: "var(--c-short)",
        },
        accent: "var(--c-accent)",
        warn: "var(--c-warn)",
      },
      borderRadius: {
        card: "18px",
      },
      boxShadow: {
        card: "var(--c-shadow)",
      },
    },
  },
  plugins: [],
};
