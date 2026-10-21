import type { AdminTranslator, MessageKey } from "../i18n";

/** A release check as the server sends it: a code (services/api/src/admin-routes.ts
 * `validation`), or the label and detail of a demo or older check. */
export interface ReleaseCheckLike {
  code?: string | undefined;
  params?: Record<string, string> | undefined;
  label?: string | undefined;
  detail?: string | undefined;
}

/** The check's title and explanation in the reader's language. */
export function releaseCheckText(
  i18n: Pick<AdminTranslator, "t" | "has">,
  check: ReleaseCheckLike,
) {
  const text = (part: "label" | "detail") => {
    const key =
      `releaseChecks.code.${[check.code ?? "", part].join(".")}` as MessageKey;
    if (check.code && i18n.has(key)) return i18n.t(key, check.params);
    return (
      check[part] ??
      (part === "label"
        ? i18n.t("releaseChecks.unknown.label", { code: check.code ?? "" })
        : "")
    );
  };
  return { label: text("label"), detail: text("detail") };
}
