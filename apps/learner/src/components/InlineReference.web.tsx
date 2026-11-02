import React from "react";
import { safeHttpsUrl } from "../connected/resources";
import { colors } from "../theme/colors";
import type { InlineReferenceProps } from "./InlineReference";
export function InlineReference({ label, href }: InlineReferenceProps) {
  const safe = safeHttpsUrl(href);
  return safe ? (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: colors.accent,
        textDecoration: "underline",
        textUnderlineOffset: 3,
      }}
    >
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}
