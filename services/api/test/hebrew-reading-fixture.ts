import type { CourseManifest } from '@course-core/sdk';
import { parseScene, RENDERER_ID, toVisualExperience } from '@course-core/visuals/headless';
import { fixture } from './fixture.js';

/** Synthetic Hebrew lesson text: paragraphs long enough to reflow when the companion pane opens
 * beside them, with English terms, signed numbers ("-2." ends a sentence) and inline formulas. */
export const HEBREW_READING_PARAGRAPHS = [
  'בשיעור הזה מחפשים את הערך הקטן ביותר ברשימה. הערך הזה נקרא minimum, והוא אינו גדול מאף איבר אחר ברשימה. כדי למצוא אותו עוברים על האיברים אחד אחרי השני, ושומרים בכל שלב את הקטן ביותר שנמצא עד עכשיו.',
  'ברשימה 3, 7, -2, 5 הערך הקטן ביותר הוא -2. שימו לב שמספר שלילי קטן מכל מספר חיובי, ולכן הוא יכול להיות המינימום גם כשהוא מופיע באמצע הרשימה ולא בתחילתה.',
  'אפשר לכתוב את הכלל גם כנוסחה: $m \\le x$ לכל $x$ ברשימה. כש-$m = -2$, הכלל מתקיים גם עבור $x = -2$, כי ערך אינו גדול מעצמו. כך רואים שהמינימום יכול להיות שווה לאיבר אחר, ולא רק קטן ממנו.',
  'בהשוואה בין שני ערכים שליליים, למשל בין -8 לבין -3, הערך הקטן הוא -8. מי שמתבלבלים כאן חושבים לפעמים על המרחק מאפס במקום על המיקום על ציר המספרים. המרחק של -8 מאפס גדול יותר, אבל המיקום שלו על הציר נמוך יותר.',
  'בתוכנית מחשב אפשר להשתמש בפונקציה min, שמחזירה את הערך הקטן ביותר. למשל, min([4, -1, 9]) מחזירה -1. עדיין כדאי להבין מה הפונקציה עושה, כי כך קל יותר לבדוק שהתשובה שלה הגיונית.',
  'כשהרשימה ריקה אין מינימום בכלל, ולכן צריך להחליט מראש מה לעשות במקרה כזה. אפשר להחזיר ערך מיוחד, או לעצור עם הודעת שגיאה ברורה. כל בחירה טובה כל עוד היא עקבית ומתועדת.',
  'לסיכום: המינימום הוא הערך הנמוך ביותר על ציר המספרים, הוא יכול להיות שלילי, והוא יכול להופיע יותר מפעם אחת. בשלב הבא בודקים את ההבנה בשאלה קצרה.',
];

/** A Hebrew question with English in it ("Context used" quotes it), and its Hebrew answer, which
 * ends on a negative number. */
export const HEBREW_QUESTION = 'מה זה minimum value? כתבתי min([3, 7, -2, 5]) וקיבלתי -2.';
export const HEBREW_ANSWER = 'המינימום של הרשימה הוא -2. הוא אינו גדול מאף איבר אחר, ולכן min([3, 7, -2, 5]) מחזירה -2.';

/** A Hebrew scene: a heading drawn at the canvas's left edge, a shelf, and a slider that moves a
 * marker along the shelf from left (0) to right (10), as the scene's own coordinates run. */
export function shelfScene() {
  return {
    version: 1,
    id: 'shelf-he',
    title: 'ערכים על מדף',
    description: 'אפשר להזיז את הסמן לאורך המדף ולראות את המיקום שלו.',
    state: { position: { kind: 'number', label: 'מיקום על המדף', initial: 2, min: 0, max: 10, step: 1 } },
    controls: ['position'],
    nodes: [
      { kind: 'text', id: 'heading', text: 'מדף 4', x: 20, y: 36, fontSize: 22, weight: 'bold', fill: '#263655' },
      { kind: 'rect', id: 'shelf', x: 20, y: 200, width: 600, height: 10, fill: '#8a6d3b' },
      { kind: 'circle', id: 'marker', x: { op: 'add', args: [20, { op: 'mul', args: [{ state: 'position' }, 60] }] }, y: 186, radius: 12, fill: '#263655' },
    ],
    layouts: { compact: { width: 640, height: 260 }, expanded: { width: 640, height: 260 } },
    timeline: { durationMs: 1000, tracks: [], cues: [] },
    accessibility: {
      text: 'מדף אופקי וסמן עליו. המיקום 0 בקצה השמאלי של המדף, והמיקום 10 בקצה הימני.',
      reducedMotion: { atMs: 0, description: 'המדף מוצג במצב מנוחה.' },
    },
  };
}

/** The ordering course written in Hebrew, without placement: a long reading in the first lesson
 * and a Hebrew scene drawn by the installed renderer. */
export function hebrewReadingFixture(renderer: { version: string; integrity: string }): CourseManifest {
  const course = fixture() as CourseManifest;
  course.id = 'hebrew-reading';
  course.title = 'קריאה בעברית';
  course.summary = 'השוואת ערכים, בעברית.';
  course.locale = 'he';
  course.placement = { ...course.placement!, enabled: false };
  course.objectives[0]!.description = 'מציאת מינימום.';
  course.objectives[1]!.description = 'מציאת מקסימום.';
  course.chapters[0]!.title = 'סדר';
  const [episode, next] = course.chapters[0]!.episodes;
  episode!.title = 'מינימום';
  next!.title = 'מקסימום';
  next!.blocks = [{ id: 'max-text', type: 'text', markdown: 'המקסימום אינו קטן מאף איבר אחר ברשימה.' }];
  const choice = course.assessments.find((item) => item.id === 'min-a')!;
  Object.assign(choice, { prompt: 'איזה ערך קטן יותר?', grading: { correctOptionId: 'two', explanation: '2 קטן מ-5.' } });
  const visual = toVisualExperience(parseScene(shelfScene()));
  course.visuals.push(visual);
  // One long reading part (it reflows when the companion pane opens beside it), the scene, then
  // the rest of the reading.
  episode!.blocks = [
    { id: 'he-reading', type: 'text', markdown: HEBREW_READING_PARAGRAPHS.slice(0, 5).join('\n\n') },
    { id: 'he-shelf', type: 'visual', visualId: visual.id },
    { id: 'he-summary', type: 'text', markdown: HEBREW_READING_PARAGRAPHS.slice(5).join('\n\n') },
    { id: 'min-check', type: 'assessment', assessmentId: 'min-a' },
  ];
  course.extensions.push({ id: RENDERER_ID, version: renderer.version, integrity: renderer.integrity, execution: 'declarative', entrypoint: 'renderers/svg-v1.js',
    platforms: ['web'], capabilities: ['visual.render'], accessibility: { keyboard: true, reducedMotion: true, textAlternative: 'Scenes with text equivalents.' } });
  return course;
}
