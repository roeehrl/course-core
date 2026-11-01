import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type Announce = (message: string) => void;
const AnnounceContext = createContext<Announce>(() => {});

/**
 * One hidden live region per AI surface, present from the first render (a region added together
 * with its text is often not read). `useAnnounce()` inside it says a sentence once: the same
 * sentence again is not repeated until a different one was said.
 */
export function Announcer({
  children,
  politeness = "polite",
  className,
}: {
  children?: React.ReactNode;
  politeness?: "polite" | "assertive";
  className?: string;
}) {
  const [message, setMessage] = useState("");
  const last = useRef("");
  const announce = useCallback<Announce>((next) => {
    if (next === last.current) return;
    last.current = next;
    setMessage(next);
  }, []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div
        className={["cc-ui-sr-only", className].filter(Boolean).join(" ")}
        role={politeness === "assertive" ? "alert" : "status"}
        aria-live={politeness}
        aria-atomic="true"
        data-cc-announcer=""
      >
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}

/** Says a sentence through the nearest `Announcer` (nothing outside one). */
export function useAnnounce(): Announce {
  return useContext(AnnounceContext);
}

/** Says `message` whenever it changes to a new, non-empty sentence. */
export function useAnnounceOnChange(message: string | null | undefined) {
  const announce = useAnnounce();
  useEffect(() => {
    if (message) announce(message);
  }, [announce, message]);
}

