import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./icons/Icon.web";
import { useT } from "../i18n";
import type { CodeBlockProps } from "./CodeBlock";

export type { CodeBlockProps } from "./CodeBlock";

/** How long the Copy button says "Copied" (final design §3.7). */
export const COPIED_MS = 2000;

/**
 * A fenced code block in lesson text or a companion reply (final design §3.3): `--surface-2`,
 * radius 12, a 32 px header with the language at the start and Copy at the end, the code left to
 * right in its own sideways scroller (a keyboard-reachable region, "{language} code, scrollable").
 */
export function CodeBlock({ language, code }: CodeBlockProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    // Not every page has a clipboard (an insecure origin, an embedded view): the code stays
    // selectable then.
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard) return;
    try {
      await clipboard.writeText(code);
    } catch {
      // Clipboard refused (permissions, an insecure page): the code stays selectable.
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }
  const label = language ? t("codeBlock.region", { language }) : t("codeBlock.exampleRegion");
  return (
    <div className="markdown-code" dir="ltr">
      <div className="markdown-code-head">
        <span className="markdown-code-language">{language || t("codeBlock.example")}</span>
        <button type="button" className="markdown-code-copy" onClick={() => void copy()} aria-label={copied ? t("codeBlock.copied") : t("codeBlock.copy")}>
          <Icon name={copied ? "check" : "copy"} size={16} />
          <span aria-hidden="true">{copied ? t("codeBlock.copied") : t("codeBlock.copyShort")}</span>
        </button>
      </div>
      {/* Wide code scrolls sideways; keyboard users reach the region to scroll it. */}
      <pre className="markdown-code-body" role="region" aria-label={label} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
