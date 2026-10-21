/**
 * Text of the first-run screen for an owner or administrator with no course yet, in the shape
 * of the i18n foundation's catalogs (namespace `firstRun`). See ./aiServices.ts for the format.
 */
import { formatMessage, type AiLocale, type MessageArgs } from "./aiServices";

const en = {
  title: "Welcome to Course Core",
  intro: "Two things to set up. You can do them in either order.",
  workspace: "Workspace: {name}",
  "course.title": "Install a course",
  "course.body": "Add a course from a course-package file or a public release.",
  "course.button": "Install a course",
  "ai.title": "Connect AI services",
  "ai.body":
    "Connect your AI service, choose models and set spending limits for the learner tutor and lesson planner.",
  "ai.button": "Set up AI services",
  back: "Back to welcome",
  noAccessTitle: "No course access",
  noAccessBody:
    "Your account has no courses available. Ask an administrator to check your assignments.",
} as const;
export type FirstRunKey = keyof typeof en;
const he: Record<FirstRunKey, string> = {
  title: "ברוכים הבאים ל-Course Core",
  intro: "יש שני דברים להגדיר. אפשר לעשות אותם בכל סדר.",
  workspace: "סביבת עבודה: {name}",
  "course.title": "התקנת קורס",
  "course.body": "הוסיפו קורס מקובץ חבילת קורס או מגרסה ציבורית.",
  "course.button": "התקנת קורס",
  "ai.title": "חיבור שירותי AI",
  "ai.body": "חברו את שירות ה-AI שלכם, בחרו מודלים והגדירו מגבלות הוצאה למורה הפרטי ולמתכנן השיעורים.",
  "ai.button": "הגדרת שירותי AI",
  back: "חזרה למסך הפתיחה",
  noAccessTitle: "אין גישה לקורסים",
  noAccessBody: "לחשבון שלכם אין קורסים זמינים. בקשו ממנהל לבדוק את ההרשאות שלכם.",
};
export const firstRunMessages: Record<AiLocale, Record<FirstRunKey, string>> = { en, he };
export const firstRunText = (locale: AiLocale) => (key: FirstRunKey, args?: MessageArgs) =>
  formatMessage(locale, firstRunMessages[locale][key] ?? en[key], args);
