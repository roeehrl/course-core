import type { AdminTranslator, MessageKey } from "../i18n";
import type { CodedText, SupervisorRun } from "./contracts";

type I18n = Pick<AdminTranslator, "t" | "has">;
const has = (i18n: I18n, key: string) => i18n.has(key as MessageKey);

/** The agent role in plain words (the AI services job name), or the code itself. */
export function roleName(i18n: I18n, role: string) {
  const key = `aiServices.role.${role}.name` as MessageKey;
  return i18n.has(key) ? i18n.t(key) : role;
}

/** A run's name: "Lesson planner run". Older servers sent an English label. */
export function runName(
  i18n: I18n,
  run: { id: string; role?: string | undefined; label?: string | undefined },
) {
  if (run.role) return i18n.t("runText.run", { job: roleName(i18n, run.role) });
  return run.label ?? run.id;
}

/** The sentences that summarize how the run ended, in order. */
export function runOutcomeSentences(i18n: I18n, run: SupervisorRun) {
  if (!run.outcome) return run.summary ? [run.summary] : [];
  const { runtimeReason, refusal, refusalBy } = run.outcome;
  return [
    ...(runtimeReason
      ? [i18n.t("runText.outcome.runtimeReason", { reason: runtimeReason })]
      : []),
    ...(refusal
      ? [
          refusalBy === "host"
            ? i18n.t("runText.outcome.refusal.host", { reason: refusal })
            : i18n.t("runText.outcome.refusal.core", { reason: refusal }),
        ]
      : []),
    i18n.t("runText.outcome.metadataOnly"),
  ];
}

/** A decision's explanation or input summary from its code; older servers' English as is. */
export function decisionText(i18n: I18n, value: CodedText) {
  if (typeof value === "string") return value;
  const key = `runText.decision.${value.code}`;
  return has(i18n, key)
    ? i18n.t(key as MessageKey, value.params)
    : value.code.replaceAll("_", " ");
}

/** A reference the run used, worded from its kind and facts. */
export function contextText(
  i18n: I18n,
  item: SupervisorRun["context"][number],
) {
  if (!item.kind)
    return {
      label: item.label ?? item.id,
      version: item.version ?? "",
      source: item.source ?? "",
      visibility: item.visibility ?? "",
    };
  const facts = item.facts ?? {};
  const part = (name: "label" | "version" | "source" | "visibility") =>
    i18n.t(
      `runText.context.${[item.kind, name].join(".")}` as MessageKey,
      facts,
    );
  return {
    label: part("label"),
    version:
      item.kind === "checkpoint_input" && facts.profileRevision === undefined
        ? i18n.t("runText.context.checkpoint_input.noFence")
        : part("version"),
    source: part("source"),
    visibility: part("visibility"),
  };
}

/** An artifact's name with its ID. */
export function artifactName(
  i18n: I18n,
  artifact: SupervisorRun["artifacts"][number],
) {
  return artifact.nameCode
    ? i18n.t(`runText.artifact.${artifact.nameCode}` as MessageKey, {
        id: artifact.id,
      })
    : (artifact.name ?? artifact.id);
}
