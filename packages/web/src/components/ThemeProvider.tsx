"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Theme = "dark" | "light";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  toggleTheme: () => {},
});

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem("theme") as Theme | null;
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Read the effective theme from a <nextjs-portal> host element's class list. */
function readDevtoolsTheme(el: Element): Theme | null {
  if (el.classList.contains("dark")) return "dark";
  if (el.classList.contains("light")) return "light";
  // "system" — no explicit class — resolve via media query
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply the app theme to the <nextjs-portal> element so the devtools panel
 *  visually matches the rest of the app. */
function syncDevtoolsElement(el: Element, theme: Theme) {
  el.classList.toggle("dark", theme === "dark");
  el.classList.toggle("light", theme === "light");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("dark");
  // Track whether a theme change originated from the devtools so we don't
  // create an observer feedback loop.
  const devtoolsSyncingRef = useRef(false);

  // Sync html class and localStorage whenever theme changes
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Initialise from localStorage / prefers-color-scheme on first mount
  useEffect(() => {
    setTheme(getInitialTheme());
  }, []);

  // Bridge: sync app theme → <nextjs-portal> when app theme changes
  useEffect(() => {
    if (devtoolsSyncingRef.current) return;
    const portal = document.querySelector("nextjs-portal");
    if (portal) {
      syncDevtoolsElement(portal, theme);
    }
  }, [theme]);

  // Bridge: watch for <nextjs-portal> appearing and observe its class changes
  useEffect(() => {
    let portalObserver: MutationObserver | null = null;

    function attachPortalObserver(portal: Element) {
      // Initial sync: app → devtools
      syncDevtoolsElement(portal, theme);

      portalObserver = new MutationObserver(() => {
        const newTheme = readDevtoolsTheme(portal);
        if (newTheme) {
          devtoolsSyncingRef.current = true;
          setTheme(newTheme);
          // Reset flag after React re-render to avoid suppressing the next
          // app-originated sync.
          requestAnimationFrame(() => {
            devtoolsSyncingRef.current = false;
          });
        }
      });

      portalObserver.observe(portal, { attributes: true, attributeFilter: ["class"] });
    }

    // The <nextjs-portal> is injected by Next.js after hydration in dev mode.
    // Watch document.body for it to appear.
    const existing = document.querySelector("nextjs-portal");
    if (existing) {
      attachPortalObserver(existing);
    } else {
      const bodyObserver = new MutationObserver((_, obs) => {
        const portal = document.querySelector("nextjs-portal");
        if (portal) {
          obs.disconnect();
          attachPortalObserver(portal);
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });

      return () => {
        bodyObserver.disconnect();
        portalObserver?.disconnect();
      };
    }

    return () => {
      portalObserver?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}
