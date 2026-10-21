import { contentAttributes } from "@course-core/i18n";

/**
 * The BCP 47 language a course is written in. The SDK this app pins (0.5.0)
 * declares none, so this is undefined and course content gets dir="auto".
 * SDK 0.6.0 adds a course `locale` (plus `locales`/`translations`); when Core
 * consumes it, return the language of the text actually served here.
 */
export function courseLanguage(_course?: unknown): string | undefined {
  return undefined;
}

/** `lang`/`dir` for a container of the course's own text (titles, lesson text, questions). */
export function courseContentAttributes(course?: unknown) {
  return contentAttributes(courseLanguage(course));
}
