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
  - the same for people the text talks about. "Someone changed this draft" is "הטיוטה השתנתה
    מאז שנפתחה", not "מישהו שינה"; "a staff member will reply" is "צוות הקורס יענה"; "nobody is
    moved" is "אין העברה של לומדים". A person's role takes the slash form or the plural
    ("כותב/ת הקורס", "כותבי קורסים", "מפעיל/ת השרת"). Where a noun reads as well, a pronoun does
    not stand for a person or for the tutor: "ההנחיה האישית של ה-AI", not "ההנחיה האישית שלו".
- **Product name** "Course Core" stays in Latin letters, left to right (`lang="en" dir="ltr"`).
- **Digits** are Western (0–9). Formatting comes from `Intl` for `he`.
- **Punctuation**: Hebrew maqaf is written as a hyphen-minus (`חד-פעמי`); quotation marks are
  straight double quotes or the typographic “ ” already used in English strings; the ellipsis is
  `…`. Apostrophe as geresh is fine (צ'אט) and needs no escaping.
- **Abbreviations** such as AI, API, URL, JSON, CSV, HTTP stay in Latin letters.
- **Tone** matches English: calm, factual, no exclamation marks, no blame ("הסיסמה שגויה", not
  "הקלדת סיסמה שגויה").

## Lint

`node scripts/i18n-check.mjs` fails when a catalog message uses a forbidden synonym listed in
[`scripts/i18n-glossary.json`](../scripts/i18n-glossary.json): for example מלווה (use המנחה) in
any Hebrew catalog, המפקח in the learner app, דולג for placed out, ניפוי באגים for the debug
inspector. A rule names its locale, optionally its surfaces (`admin`, `learner`), the forbidden
words (plain substrings, so prefixed forms such as למלווה are caught), the term to use and why.
A genuine exception names the rule and the message (`admin:policySettingsCard.windowDisambiguation.hint`)
with a reason; an exception that no longer matches anything fails, so the list stays current.
When the owner changes a term, update the table below and the rules together.

Some words are right in one role and wrong in another: המנחה is the tutor and must not name the
supervisor. A rule can then read the message's English source (`whenSource`, `unlessSource`) and
judge only the messages where the English decides the role:

- **Admin, `supervisor-is-not-the-tutor`.** Where the English names a supervisor or supervision
  and no companion or tutor, any form of מנחה fails: מנחה, המנחה, למנחה, מנחים, המנחים, מנחי,
  מנחות. Use המפקח (plural המפקחים) or פיקוח.
- **Admin, `tutor-is-not-the-supervisor`.** Where the English names the companion or tutor and no
  supervisor, any form of מפקח fails.
- **Gendered references to people, `gendered-someone` and `gendered-role-noun`.** מישהו and
  מישהי always name a person by gender. Before הקורס or השרת, כותב and מפעיל can only be the
  role noun, so כותב הקורס and מפעיל השרת (and the feminine-only forms) fail; use the slash form.
  Most other gendered forms cannot be told from the text alone, so the lint leaves them to review:
  a pronoun (שלו, הוא, אותו) agrees with any noun of its gender, a person or a thing ("ההגדרות
  שלו" of a chapter); a second-person future such as תגיע is spelled like the third-person
  feminine ("התוצאה תגיע"); a singular imperative such as בחר is spelled like the past ("צוות
  הקורס בחר"); אף אחד and כל אחד also count things ("יתרה לכל אחד"); and unslashed לומד, בודק
  or מנהל are also verbs.
- **Where it cannot be decided.** A message whose English names both roles ("the companion and
  the supervisor") may use either word, so neither rule judges it. In the learner app the English
  does not decide either: learners see one helper, so "your supervisor made this for you" is
  rightly המנחה, while a message about stopping supervision work names the work instead
  (ההנחיה האישית של ה-AI). Whether a learner message names the helper or its work is an
  editorial choice, so the learner app only forbids המפקח (`supervisor-in-learner-app`).

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
| companion / tutor (the learner-facing AI tutor) | המנחה | owner-approved 2026-10-24; plural המנחים. Construct forms: מנחה ה-AI where the AI nature matters, מנחה הלומדים for the companion job in admin (AI services). Learners see one helper: the companion and the supervisor are both המנחה ("המנחה לא משתמש בתוצאה הזו", never "המלווה והמנחה"); personal AI supervision → ההנחיה האישית של ה-AI, also where a learner message is about supervision work rather than the helper ("עוצרים את ההנחיה האישית של ה-AI בקורס לפני המחיקה…", never "עוצרים את המנחים"). Never מלווה |
| you (the learner's own messages in the conversation with the tutor) | השאלה שלך | heading of the learner's own message and of their lines in "context used"; never the slash form את/ה |
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
| server operator | מפעיל/ת השרת | the person who runs the server; plural מפעילי השרת |
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
