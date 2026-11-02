import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/** `again`: a sentence the learner caused once more ("Copied" for a second reply) is said again. */
type Announce = (message: string, options?: { again?: boolean }) => void;
const AnnounceContext = createContext<Announce>(() => {});

/**
 * One hidden live region per AI surface, present from the first render (a region added together
 * with its text is often not read). `useAnnounce()` inside it says a sentence once: the same
 * sentence again is not repeated until a different one was said, unless it is asked for `again`.
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
  const repeat = useRef(false);
  const announce = useCallback<Announce>((next, options) => {
    if (next === last.current && !options?.again) return;
    // The same sentence again changes the region's text by a no-break space, so it is read again.
    repeat.current = next === last.current ? !repeat.current : false;
    last.current = next;
    setMessage(repeat.current ? `${next}\u00a0` : next);
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

