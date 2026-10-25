import { useT } from "../i18n";
import { Badge, Field } from "./ui";

/** One reviewer finding per rubric criterion. A met criterion needs an exact quotation from the
 * learner's own words; the server checks the same rule (checkFindings). */
export type Finding = { met: boolean; quote: string; note: string };
export interface Criterion {
  id: string;
  description: string;
  required: boolean;
}

export const emptyFindings = (
  rubric: readonly Criterion[],
): Record<string, Finding> =>
  Object.fromEntries(
    rubric.map((c) => [c.id, { met: false, quote: "", note: "" }]),
  );
export const requiredMet = (
  rubric: readonly Criterion[],
  findings: Record<string, Finding>,
) => rubric.filter((c) => c.required).every((c) => findings[c.id]!.met);
export const findingsPayload = (
  rubric: readonly Criterion[],
  findings: Record<string, Finding>,
) =>
  rubric.map((c) => {
    const f = findings[c.id]!;
    return {
      criterionId: c.id,
      met: f.met,
      ...(f.met && f.quote.trim() ? { quote: f.quote.trim() } : {}),
      ...(f.note.trim() ? { note: f.note.trim() } : {}),
    };
  });

export function RubricFindings({
  idPrefix,
  rubric,
  findings,
  words,
  disabled = false,
  onChange,
}: {
  idPrefix: string;
  rubric: readonly Criterion[];
  findings: Record<string, Finding>;
  /** The learner's own words the quotations must come from. */
  words: readonly string[];
  disabled?: boolean;
  onChange: (findings: Record<string, Finding>) => void;
}) {
  const t = useT();
  const update = (criterion: string, patch: Partial<Finding>) =>
    onChange({
      ...findings,
      [criterion]: { ...findings[criterion]!, ...patch },
    });
  return (
    <>
      {rubric.map((c) => {
        const f = findings[c.id]!;
        return (
          <fieldset key={c.id} className="review-criterion">
            <legend>
              <bdi>{c.description}</bdi>{" "}
              {c.required ? (
                <Badge>{t("rubricFindings.required")}</Badge>
              ) : (
                <Badge tone="gold">{t("rubricFindings.optional")}</Badge>
              )}
            </legend>
            <label className="check-label">
              <input
                type="checkbox"
                checked={f.met}
                disabled={disabled}
                onChange={(e) => update(c.id, { met: e.target.checked })}
              />
              {t("rubricFindings.met")}
            </label>
            {f.met && (
              <Field
                label={t("rubricFindings.quote.label")}
                htmlFor={`${idPrefix}-${c.id}-quote`}
                hint={
                  f.quote.trim().length >= 10 &&
                  words.some((w) => w.includes(f.quote.trim()))
                    ? undefined
                    : t("rubricFindings.quote.notFound")
                }
              >
                <textarea
                  id={`${idPrefix}-${c.id}-quote`}
                  rows={2}
                  maxLength={800}
                  value={f.quote}
                  disabled={disabled}
                  onChange={(e) => update(c.id, { quote: e.target.value })}
                />
              </Field>
            )}
          </fieldset>
        );
      })}
    </>
  );
}
