import { useEffect, useState } from "react";

const THEME_KEY = "alpha-scout-theme";
// Cycle order for the single toggle button: light -> dark -> system -> light.
const PREFERENCES = ["light", "dark", "system"];

function getSystemTheme() {
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialPreference() {
  const saved = localStorage.getItem(THEME_KEY);
  return PREFERENCES.includes(saved) ? saved : "system";
}

// Three-way theme preference (light/dark/system), persisted to localStorage.
// "system" tracks the OS setting live via a matchMedia listener rather than
// reading it once at mount, so flipping the OS theme while the app is open
// takes effect immediately, same as picking light/dark explicitly would.
export function useTheme() {
  const [preference, setPreference] = useState(getInitialPreference);
  const [theme, setTheme] = useState(() => (getInitialPreference() === "system" ? getSystemTheme() : getInitialPreference()));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, preference);
    if (preference !== "system") {
      setTheme(preference);
      return;
    }
    setTheme(getSystemTheme());
    const mql = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(getSystemTheme());
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [preference]);

  const cycle = () => setPreference((p) => PREFERENCES[(PREFERENCES.indexOf(p) + 1) % PREFERENCES.length]);

  return { theme, preference, cycle };
}
