import React from "react";
import type { SourceLinksProps } from "./SourceLinks";
import { safeHttpsUrl } from "../connected/resources";
export function SourceLinks({ sources, sourceIds }: SourceLinksProps) {
  const selected = sourceIds
    ? sources.filter((source) => sourceIds.includes(source.id))
    : sources;
  if (!selected.length) return null;
  return (
    <aside className="connected-sources" aria-label="Sources">
      <p>Sources</p>
      <ul>
        {selected.map((source) => {
          const href = safeHttpsUrl(source.url);
          return (
            <li key={source.id}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {source.title}
                  <span className="connected-sr"> (opens a new tab)</span>
                </a>
              ) : (
                <span>{source.title}</span>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
