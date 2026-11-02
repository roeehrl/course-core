import { useState } from "react";
import { Badge } from "../components/ui";
import "./contentViews.css";

/** Long course text as body text: three lines, then a toggle for the rest. */
export function ClampedText({
  text,
  more,
  less,
  limit = 260,
}: {
  text: string;
  more: string;
  less: string;
  /** Shorter text is shown whole, without a toggle. */
  limit?: number;
}) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit || text.split("\n").length > 3;
  return (
    <>
      <p className={`cv-prose ${long && !open ? "cv-clamped" : ""}`} dir="auto">
        {text}
      </p>
      {long && (
        <button
          type="button"
          className="cv-link-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? less : more}
        </button>
      )}
    </>
  );
}

/**
 * A short title for long course text: the first line's heading ("Chapter 9 lab: tiled matrix
 * multiplication simulator"), else its first sentence, else its first words. The whole text is
 * shown elsewhere.
 */
export function shortTitle(text: string, max = 90) {
  const first = text.trim().split(/\r?\n/)[0]!.trim();
  // A run-on heading: "Name: a few words" followed by a capitalised sentence.
  const heading = /^([^\n:]{3,40}:\s+[^.\n]{8,}?)\s+(?=[A-Z][a-z]+\s)/.exec(
    first,
  );
  if (heading && heading[1]!.length <= max) return heading[1]!;
  const sentence = /^(.{12,}?[.?!])(?:\s|$)/.exec(first);
  if (sentence && sentence[1]!.length <= max) return sentence[1]!;
  if (first.length <= max) return first;
  return first.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/** A lower-case search query or code as a display name: its first letter capitalised. */
export function sentenceCase(text: string) {
  const trimmed = text.trim();
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1);
}

/** A review queue's heading, the same for every queue on the page, with how many are waiting. */
export function QueueHeading({
  id,
  title,
  count,
}: {
  id: string;
  title: string;
  count?: number | undefined;
}) {
  return (
    <div className="cv-queue-head">
      <h2 id={id}>{title}</h2>
      {count !== undefined && count > 0 && <Badge tone="gold">{count}</Badge>}
    </div>
  );
}
