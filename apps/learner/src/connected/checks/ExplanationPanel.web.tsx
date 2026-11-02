import React from "react";
import { MarkdownContent } from "../../components/MarkdownContent";
import { courseContentAttributes } from "../../domain/contentLanguage";
import { useT } from "../../i18n";
import { Tag } from "../ui/Tag.web";

/**
 * The question's explanation, opened from the help row: in place under the feedback (M17), the
 * author's Markdown (math renders), never in the page notice. "Hide explanation" in the help row
 * folds it again (the button names it with `aria-controls`).
 */
export function ExplanationPanel({ id, explanation, course }: { id: string; explanation: string; course?: unknown }) {
  const t = useT();
  return (
    <section id={id} className="cc-check-explanation-panel" aria-label={t("explanationPanel.label")}>
      <div {...courseContentAttributes(course)}>
        <MarkdownContent markdown={explanation} />
      </div>
    </section>
  );
}

/** A neutral tag on a question whose explanation was opened: what the record now says. */
export function SolutionViewed() {
  const t = useT();
  return <Tag className="cc-check-solution-viewed" variant="muted" label={t("explanationPanel.solutionViewed")} />;
}
