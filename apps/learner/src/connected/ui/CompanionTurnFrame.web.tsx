import React, { useId } from "react";
import { Icon } from "../../components/icons/Icon.web";
import { useT } from "../../i18n";

export type TurnAuthor = "learner" | "companion" | "course";

/**
 * One turn of a companion conversation: an `<article>` named by a hidden `<h3>` ("You said",
 * "Companion said", "Course note"; A11Y-7), with the companion's label line (the glyph and
 * "Companion") above its replies when `label` is set.
 */
export function CompanionTurnFrame({
  author,
  label = false,
  id,
  className,
  children,
  ...data
}: {
  author: TurnAuthor;
  label?: boolean;
  id?: string;
  className?: string;
  children: React.ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
  const t = useT();
  const heading = useId();
  return (
    <article id={id} aria-labelledby={heading} className={["cc-ui-turn", `is-${author}`, className].filter(Boolean).join(" ")} {...data}>
      <h3 id={heading} className="cc-ui-sr-only">
        {author === "learner"
          ? t("companionTurnFrame.heading.learner")
          : author === "companion"
            ? t("companionTurnFrame.heading.companion")
            : t("companionTurnFrame.heading.course")}
      </h3>
      {label && author === "companion" && (
        <div className="cc-ui-turn-label" aria-hidden="true">
          <Icon name="sparkle" size={16} />
          <span>{t("companionTurnFrame.label")}</span>
        </div>
      )}
      {children}
    </article>
  );
}
