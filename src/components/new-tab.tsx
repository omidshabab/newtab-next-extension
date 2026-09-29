"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

// Where the search box sends you. Swap this for any endpoint you like.
const SEARCH_ENDPOINT = "https://www.google.com/search";

export default function NewTab() {
  const [now, setNow] = useState<Date | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Focus the search box on load, and let "/" jump back to it from anywhere.
  useEffect(() => {
    inputRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === "/" && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("q");
    const trimmed = typeof query === "string" ? query.trim() : "";
    if (trimmed) {
      // A full page navigation is what we want here: this leaves the extension
      // page for an external site. The Next.js router cannot express that.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(trimmed)}`);
    }
  };

  // Rendered only after mount so the server and client markup never disagree.
  const time = now
    ? now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;
  const date = now
    ? now.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      })
    : null;

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center gap-12 px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(60rem 40rem at 50% -10%, color-mix(in oklab, var(--accent) 22%, transparent), transparent)",
        }}
      />

      <div className="relative flex flex-col items-center gap-3 text-center">
        <h1 className="font-mono text-7xl leading-none font-medium tracking-tight tabular-nums sm:text-8xl">
          {time ?? "--:--"}
        </h1>
        <p className="text-lg text-muted">{date ?? " "}</p>
      </div>

      <form onSubmit={onSubmit} role="search" className="relative w-full max-w-xl">
        <input
          ref={inputRef}
          type="search"
          name="q"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search the web…"
          aria-label="Search the web"
          className="w-full rounded-2xl border border-black/10 bg-white/70 px-5 py-4 text-base text-foreground shadow-sm outline-none backdrop-blur-md transition placeholder:text-muted focus:border-accent focus:ring-4 focus:ring-accent/20 dark:border-white/10 dark:bg-white/5"
        />
        <p className="mt-3 text-center text-xs text-muted">
          Press <kbd className="font-mono">/</kbd> to jump back here
        </p>
      </form>
    </main>
  );
}
