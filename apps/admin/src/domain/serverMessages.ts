import { z } from "zod";
import type { AdminTranslator, MessageKey } from "../i18n";

/**
 * What a staff command did. The server sends a code and parameters
 * (services/api/src/staff-messages.ts); receipts stored before that hold an English sentence.
 */
export const serverMessageSchema = z.union([
  z.string().max(12000),
  z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
    params: z
      .record(z.string(), z.union([z.string().max(2000), z.number()]))
      .optional(),
  }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

/** The message in the reader's language. An unknown code reads as a plain "Done." with its code. */
export function serverMessageText(
  i18n: Pick<AdminTranslator, "t" | "has">,
  message: ServerMessage,
) {
  if (typeof message === "string") return message;
  const key = `serverMessages.code.${message.code}` as MessageKey;
  return i18n.has(key)
    ? i18n.t(key, message.params)
    : i18n.t("serverMessages.unknown", { code: message.code });
}
