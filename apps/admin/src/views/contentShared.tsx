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

const leadSentence = (text: string) =>
  /^\s*([^\n.?!:]{2,60}[.:])\s+\S/.exec(text)?.[1];
/**
 * Short opening sentences many questions share ("Independent check."): they name a kind of
 * question, not the question, so a list row skips them. A lead counts when at least three of
 * the texts start with it.
 */
export function sharedLeads(texts: string[], min = 3) {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const lead = leadSentence(text);
    if (lead) counts.set(lead, (counts.get(lead) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= min).map(([lead]) => lead));
}
/** A question's text for a one-line list row: without a shared lead-in, on one line (the row
 * ellipsizes it). */
export function questionLine(text: string, leads: Set<string>) {
  const lead = leadSentence(text);
  const rest = lead && leads.has(lead) ? text.trim().slice(lead.length) : text;
  return rest.replace(/\s+/g, " ").trim();
}

/** Well-known sites by their hosts, named the way people know them. */
const SITE_NAMES: [RegExp, string][] = [
  [
    /^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/,
    "YouTube",
  ],
  [/^(?:[a-z]{2,3}\.)?(?:m\.)?wikipedia\.org$/, "Wikipedia"],
  [/^(?:www\.)?github\.com$/, "GitHub"],
];
/** Allowed hosts as site names: one "YouTube" for its three hosts, others without "www.". */
export function siteNames(hosts: string[]) {
  const names = hosts.map((host) => {
    const h = host.trim().toLowerCase();
    return (
      SITE_NAMES.find(([re]) => re.test(h))?.[1] ?? h.replace(/^www\./, "")
    );
  });
  return [...new Set(names)];
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
