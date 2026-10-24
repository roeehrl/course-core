# Translation glossary

Core terms and their Hebrew renderings. Every Hebrew string in the catalogs uses these terms;
propose a change or a new term to the i18n coordinator rather than choosing a different word in
one view. See [i18n.md](i18n.md) for how catalogs work.

## Style

- **Natural, not literal.** Write what a Hebrew product would say. Short labels, active voice,
  no calques ("לחץ כאן" → a meaningful link text).
- **Gender-neutral by default.** Prefer forms that avoid addressing a gender:
  - impersonal and plural verbs for instructions and status: "נכנסים עם שם משתמש וסיסמה",
    "שומרים…", "אפשר לנסות שוב", "יש לבחור סיסמה";
  - verbal nouns for buttons and menu items: "שמירה", "ביטול", "יציאה", "שינוי סיסמה";
  - "שלך" and "לך" are neutral: "הקורסים שלך", "הוגדרה לך סיסמה זמנית";
  - when a role noun or adjective must address the person, use the slash form: "לומד/ת",
    "מחובר/ת", "מנהל/ת". Use it sparingly; rephrase first.
- **Product name** "Course Core" stays in Latin letters, left to right (`lang="en" dir="ltr"`).
- **Digits** are Western (0–9). Formatting comes from `Intl` for `he`.
- **Punctuation**: Hebrew maqaf is written as a hyphen-minus (`חד-פעמי`); quotation marks are
  straight double quotes or the typographic “ ” already used in English strings; the ellipsis is
  `…`. Apostrophe as geresh is fine (צ'אט) and needs no escaping.
- **Abbreviations** such as AI, API, URL, JSON, CSV, HTTP stay in Latin letters.
- **Tone** matches English: calm, factual, no exclamation marks, no blame ("הסיסמה שגויה", not
  "הקלדת סיסמה שגויה").

## Terms

| English | Hebrew | Notes |
| --- | --- | --- |
| course | קורס | plural קורסים |
| chapter | פרק | course structure level above episodes |
| lesson | שיעור | |
| episode | יחידת לימוד | short form יחידה when the context is clear; plural יחידות לימוד |
| block (reading block) | קטע | |
| step | שלב | |
| learning path / roadmap | מסלול הלמידה / מפת הקורס | |
| objective | מטרת למידה | |
| concept | מושג | concept mappings → מיפויי מושגים |
| gate | נקודת בקרה | plural נקודות בקרה; a checkpoint that controls progression |
| gate decision | החלטת נקודת הבקרה | |
| mastery | שליטה | "level of mastery" → רמת שליטה |
| evidence | ראיות | evidence of learning; singular ראיה |
| assessment / check | בדיקה | an independent check → בדיקה עצמאית |
| answer | תשובה | |
| attempt | ניסיון | |
| practice | תרגול | |
| hint | רמז | |
| feedback | משוב | |
| review (staff review of an answer or decision) | בדיקה | answer reviews → בדיקת תשובות; to request a review → לבקש בדיקה חוזרת |
| reviewer | בודק/ת | |
| rubric | מחוון | |
| grade / grader | ציון / מערכת הבדיקה | |
| regrade | בדיקה מחדש | |
| appeal / dispute | ערעור | evidence dispute → ערעור על ראיה |
| companion | מלווה הלמידה | short form המלווה |
| tutor (the AI supervisor as learners see it) | המנחה | owner-approved 2026-10-24; plural המנחים. In the learner app every "supervisor" or "tutor" is המנחה; personal AI supervision → ההנחיה האישית של ה-AI |
| supervisor (AI agent, staff-facing) | המפקח | admin only, next to פיקוח AI; learners never see המפקח |
| supervision | פיקוח | AI supervision → פיקוח AI |
| teaching hypothesis | השערת הוראה | |
| learner memory | זיכרון הלמידה | |
| learning record | תיעוד הלמידה | |
| profile | פרופיל | |
| placement | שיבוץ | placement check → בדיקת שיבוץ |
| placed out | פטור בזכות השיבוץ | owner-approved 2026-10-24; counts → "{n} עם פטור בזכות השיבוץ"; never "דולג" |
| exemption | פטור | owner-approved 2026-10-24; plural פטורים |
| workspace | סביבת עבודה | plural סביבות עבודה |
| owner | בעלים | role label; same in singular and plural |
| admin / administrator | מנהל/ת | the admin app → אזור הניהול |
| author | כותב/ת | |
| instructor | מדריך/ה | |
| observer | צופה | |
| member | חבר/ה | |
| learner | לומד/ת | plural לומדים; in general statements prefer "לומדים" |
| course team / staff | צוות הקורס | |
| role | תפקיד | people & roles → אנשים ותפקידים |
| permission | הרשאה | |
| enrollment | הרשמה | plural הרשמות; enrolled learners → לומדים רשומים |
| enrollment states | פעיל / מושהה / סגור / הושלם | owner-approved 2026-10-24; active / paused / closed / completed, as standalone status labels |
| cohort | מחזור | owner-approved 2026-10-24 |
| release (a published course version) | גרסה | course & releases → קורס וגרסאות |
| version | גרסה | version numbers stay LTR |
| draft | טיוטה | |
| publish / published | פרסום / פורסם | |
| archive / archived | העברה לארכיון / בארכיון | |
| revision (record revision number) | מהדורה | "revision 3" → מהדורה 3 |
| digest (hash) | גיבוב | shown LTR, e.g. sha256 values |
| policy | מדיניות | |
| scope (policy scope) | תחום | owner-approved 2026-10-24; ancestor scope → תחום-על; never היקף or רמה for a scope |
| ledger | פנקס | owner-approved 2026-10-24 |
| remediation | חיזוק | owner-approved 2026-10-24; remediation cycles → סבבי חיזוק |
| extension (more time or work) | הארכה | extension offer → הצעת הארכה |
| deadline | מועד אחרון | |
| learning window | חלון הלמידה | |
| allowance / quota | מכסה | |
| accommodation | התאמה | |
| study (research study) | מחקר | studies → מחקרים |
| study arm | זרוע | owner-approved 2026-10-24; plural זרועות |
| consent | הסכמה | |
| research sources | מקורות מחקר | |
| generated media | מדיה שנוצרה | |
| provider (AI model provider) | ספק AI | providers → ספקי AI |
| model | מודל | |
| run (an agent run) | הרצה | run inspector → בודק ההרצות |
| rerun / retry a run | הרצה מחדש | owner-approved 2026-10-24; "retried" → הורצה מחדש. Generic retry buttons stay ניסיון נוסף |
| replay (sandboxed replay, visual replay) | הפעלה חוזרת | owner-approved 2026-10-24; "replaying…" → מפעילים מחדש… |
| debug inspector | כלי דיבוג | owner-approved 2026-10-24; definite כלי הדיבוג |
| receipt | אישור | owner-approved 2026-10-24; plural אישורים (not אישור רישום) |
| artifact (run output) | תוצר | owner-approved 2026-10-24; plural תוצרים |
| quarantined | בהסגר | owner-approved 2026-10-24 |
| inspection (source or release scan) | סריקה | owner-approved 2026-10-24 |
| audit log | יומן ביקורת | |
| overview | סקירה כללית | |
| dashboard | לוח בקרה | |
| sign in / sign out | כניסה / יציאה | buttons; verbs: להיכנס / לצאת |
| username / password | שם משתמש / סיסמה | |
| passkey | מפתח גישה | plural מפתחות גישה |
| one-time code / link | קוד חד-פעמי / קישור חד-פעמי | |
| session | סשן | |
| language | שפה | the switcher label |
| settings | הגדרות | |
| save / cancel / close / retry | שמירה / ביטול / סגירה / ניסיון נוסף | |
| refresh | רענון | |
| loading… | טוענים… | "Loading X…" → "טוענים את X…" |
| demo | הדגמה | |
| error | שגיאה | |
| offline / online | אין חיבור / מחובר | connection status |
