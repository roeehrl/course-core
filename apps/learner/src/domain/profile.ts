import type { Profile } from "./types";
import { englishTranslator, type Translate } from "../i18n";
export const PROFILE_NAME_MAX = 60;
export const PROFILE_GOAL_MAX = 280;
export function validateProfile(profile: Profile, t: Translate = englishTranslator().t): string | null {
  if (!profile.displayName.trim() || profile.displayName.trim().length > PROFILE_NAME_MAX)
    return t("profile.error.name", { max: PROFILE_NAME_MAX });
  if (profile.goal.length > PROFILE_GOAL_MAX)
    return t("profile.error.goal", { max: PROFILE_GOAL_MAX });
  if (!["gentle", "steady", "focused"].includes(profile.pace))
    return t("profile.error.pace");
  return null;
}
