import type { ReactNode } from "react";
import { WandSparkles } from "lucide-react";
import { useI18n, type MessageKey } from "../../i18n";
import type {
  KeyCharAnalysis,
  KeyCharProblem,
} from "../../domain/keyCharacters";
import { Ltr, useAiText } from "./shared";

/** How many offending characters are named one by one; the rest are counted. */
export const KEY_CHARS_SHOWN = 3;

const tags = {
  char: (children: ReactNode, key: string | number) => (
    <Ltr key={key} className="ai-key-char">
      {children}
    </Ltr>
  ),
  code: (children: ReactNode, key: string | number) => (
    <code key={key} dir="ltr">
      {children}
    </code>
  ),
};

function ProblemLine({ problem }: { problem: KeyCharProblem }) {
  const i18n = useI18n();
  const name = problem.name
    ? i18n.t(`aiServices.keyChars.name.${problem.name}` as MessageKey)
    : "";
  const args = {
    position: problem.position,
    shown: problem.char,
    plain: problem.replacement ?? "",
    codePoint: problem.codePoint,
    name,
  };
  const key: MessageKey = `aiServices.keyChars.${problem.kind}`;
  return <>{i18n.rich(key, args, tags)}</>;
}

/**
 * Names each character of a pasted key that a key can't contain: where it is, what it looks
 * like and what it probably was. Offers to fix look-alikes and invisible characters (never
 * silently), and always suggests copying the key again.
 */
export function KeyCharacters({
  id,
  analysis,
  kind,
  onFix,
}: {
  id: string;
  analysis: KeyCharAnalysis;
  kind?: string;
  onFix?: () => void;
}) {
  const { t } = useAiText();
  const { problems, fixable } = analysis;
  const more = problems.length - KEY_CHARS_SHOWN;
  return (
    <div id={id} className="ai-key-chars">
      <ul>
        {problems.slice(0, KEY_CHARS_SHOWN).map((problem) => (
          <li key={problem.position}>
            <ProblemLine problem={problem} />
          </li>
        ))}
      </ul>
      {more > 0 && <p>{t("aiServices.keyChars.more", { count: more })}</p>}
      {onFix && fixable > 0 && (
        <div className="ai-key-fix">
          <button type="button" className="button secondary" onClick={onFix}>
            <WandSparkles size={16} aria-hidden="true" />
            {t("aiServices.keyChars.fix", { count: fixable })}
          </button>
          <small className="ai-hint">
            {t("aiServices.keyChars.fixHint")}{" "}
            {fixable < problems.length &&
              t("aiServices.keyChars.fixPartial", {
                count: problems.length - fixable,
              })}
          </small>
        </div>
      )}
      <p>
        {t(
          kind === "google"
            ? "aiServices.keyChars.recopy.google"
            : kind === "anthropic"
              ? "aiServices.keyChars.recopy.anthropic"
              : "aiServices.keyChars.recopy.other",
        )}
      </p>
    </div>
  );
}
