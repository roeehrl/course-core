import type { ServerSnapshot } from "../../client/apiClient";

/** The id the credit line renders with, for the composer's `aria-describedby`. */
export const CREDIT_LINE_ID = "cc-credit-line";

/** Whether the next message keeps the open question counted, said by the composer. Not shown yet. */
export function CreditNotice(_props: { server?: ServerSnapshot; episodeId?: string; now: number; placement: "notice" | "meta" }): null {
  return null;
}
