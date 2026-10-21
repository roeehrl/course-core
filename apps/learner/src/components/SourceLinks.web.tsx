import React from "react";
import type { SourceLinksProps } from "./SourceLinks";
import { safeHttpsUrl } from "../connected/resources";
import { useT } from "../i18n";
export function SourceLinks({ sources, sourceIds }: SourceLinksProps) {
  const t = useT();
  const selected = sourceIds
    ? sources.filter((source) => sourceIds.includes(source.id))
    : sources;
  if (!selected.length) return null;
  return (
    <aside className="connected-sources" aria-label={t("sourceLinks.title")}>
      <p>{t("sourceLinks.title")}</p>
      <ul>
        {selected.map((source) => {
          const href = safeHttpsUrl(source.url);
          return (
            <li key={source.id} dir="auto">
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {source.title}
                  <span className="connected-sr">{t("sourceLinks.newTab")}</span>
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
