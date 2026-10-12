import type { Profile } from "./types";
export function validateProfile(profile: Profile): string | null {
  if (!profile.displayName.trim() || profile.displayName.trim().length > 60)
    return "Enter a name between 1 and 60 characters.";
  if (profile.goal.length > 280)
    return "Keep your learning goal to 280 characters.";
  if (!["gentle", "steady", "focused"].includes(profile.pace))
    return "Choose a learning pace.";
  return null;
}
