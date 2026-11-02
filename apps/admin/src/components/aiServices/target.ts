import type { SectionId } from "../../domain/aiServices";

/**
 * A section of AI services another page links to ("add the YouTube key in AI services"): the
 * link records it, opens the page, and the page scrolls to that section (unfolding Advanced) once
 * it has loaded. Read once, so a later visit opens at the top as usual.
 */
let pending: SectionId | "advanced" | undefined;
export function setAiServicesTarget(section: SectionId | "advanced") {
  pending = section;
}
export function takeAiServicesTarget() {
  const section = pending;
  pending = undefined;
  return section;
}
