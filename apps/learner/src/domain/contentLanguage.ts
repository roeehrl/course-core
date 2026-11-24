import { contentAttributes } from "@course-core/i18n";

/**
 * The BCP 47 language of the course text served here. Courses declare a source `locale`
 * (and, since SDK 0.6, `locales`/`translations`), but Core does not serve translations
 * yet, so this stays undefined and course content gets dir="auto".
 */
export function courseLanguage(_course?: unknown): string | undefined {
  return undefined;
}

/** `lang`/`dir` for a container of the course's own text (titles, lesson text, questions). */
export function courseContentAttributes(course?: unknown) {
  return contentAttributes(courseLanguage(course));
}
