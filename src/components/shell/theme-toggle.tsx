"use client";

import { useSyncExternalStore } from "react";
import { IconMoon, IconSun } from "@/components/ui/icons";

// Light/dark switch. The theme lives on <html data-theme> (set before first paint by the script in layout.tsx) and is
// remembered in localStorage; the button reads the attribute, so it always shows what the page really looks like.
const KEY = "ofa-theme";
const listeners = new Set<() => void>();

function current(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => void listeners.delete(callback);
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, current, () => "dark" as const);
  const next = theme === "light" ? "dark" : "light";

  function toggle() {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private mode: the choice lasts for this page view only.
    }
    listeners.forEach((l) => l());
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className="inline-flex size-8 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg"
    >
      {theme === "light" ? <IconMoon size={16} /> : <IconSun size={16} />}
    </button>
  );
}
