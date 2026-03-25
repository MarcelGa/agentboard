"use client";

import { useState } from "react";

type State = "idle" | "loading" | "ok" | "error";

export function HotReloadButton() {
  const [state, setState] = useState<State>("idle");

  async function handleClick() {
    if (state === "loading") return;
    setState("loading");
    try {
      const res = await fetch("/api/reload", { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
      setState("ok");
      // Brief success flash, then reset
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setState("error");
      setTimeout(() => setState("idle"), 2000);
    }
  }

  const label =
    state === "loading"
      ? "Reloading config…"
      : state === "ok"
        ? "Config reloaded"
        : state === "error"
          ? "Reload failed"
          : "Reload config";

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === "loading"}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-[6px] border border-[var(--color-border-default)] text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:opacity-50"
    >
      <svg
        className={`h-3.5 w-3.5 ${state === "loading" ? "animate-spin" : ""} ${state === "ok" ? "text-[var(--color-status-success)]" : ""} ${state === "error" ? "text-[var(--color-status-error)]" : ""}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        {state === "ok" ? (
          /* Checkmark */
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        ) : state === "error" ? (
          /* X mark */
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        ) : (
          /* Refresh/reload arrows */
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        )}
      </svg>
    </button>
  );
}
