# Accessibility checks

What the automated browser tests prove about the learner app, what they do not, and the manual
screen-reader traversal to run before a release. Automated checks never replace a person using
a real screen reader.

## Automated checks

All in `apps/learner/tests/connected-web/` against the real API and database
(`npm run test:connected` in `apps/learner`, desktop 1440×960, phone 390×844 and tablet 834×1112).

| Check | Spec | What it proves | What it does not |
| --- | --- | --- | --- |
| WCAG 2.2 AA scan | `accessibility.spec.ts`, most other specs | axe finds no violations in the lesson, check, companion, menus and dialogs it opens | Reading order, meaningful names, how a screen reader announces changes |
| Browser zoom 200% and 400% | `accessibility.spec.ts` ("browser zoom") | The page lays out as Chromium does at that zoom: devicePixelRatio 2 or 4 on a 1280 px window, 640 or 320 CSS px wide. No horizontal page scroll, the answer actions, menu and companion stay reachable, a focused option is not hidden behind sticky actions, and axe passes | Text-only zoom (Firefox "Zoom text only", Safari text size), OS magnifiers, Safari and Firefox page zoom |
| 44 px targets | `accessibility.spec.ts` | Every control in the lesson, header, companion and menu is at least 44×44 CSS px (inline links exempt) | Touch accuracy on a real device |
| Forced colours | `accessibility.spec.ts` | Every control keeps a border and the current step a 3 px outline in Windows high-contrast emulation | Every Windows contrast theme |
| On-screen keyboard | `accessibility.spec.ts`, `keyboard-layout.spec.ts` | The answer actions stay above a simulated keyboard (a shrunk `visualViewport`) | A physical device keyboard |
| Line length | `accessibility.spec.ts` ("readable line length") | Lesson prose is at most about 70 characters per line on desktop and uses the card width on phone and tablet | Long words or unusual fonts in a course's own language |
| IME composition | `apps/admin/tests/web/ime.spec.ts`, `apps/{learner,admin}/tests/imeGuard.test.tsx` | An Enter that commits IME composition never submits a form (a real Chromium composition through the DevTools protocol) | Every OS input method |
| Screen-reader order and focus (S12) | `screen-reader.spec.ts` | The accessibility tree a reader's browse mode follows, through a whole lesson: banner and main landmarks; each course an article with its heading before its button; focus on the lesson's level-1 heading on entry; the current step marked; the reading part an article named "Reading part 1" with no TeX source; every control named; after "Mark this part read" and after "Check answer" focus moves to what comes next (never to the page); the answer's result in a live region; Tab stops in reading order, all visible and named | How VoiceOver or NVDA actually voices each item, verbosity, rotor and gesture behaviour: run the manual script below |
| Slow and interrupted network | `offline.spec.ts`, `apps/admin/tests/real/course-packages.real.spec.ts` | A slow answer says the server is slow and is recorded once; a stalled read ends with a clear message; an interrupted package upload installs nothing and is retried with the same file; an unconfirmed install is retried without installing twice | Real mobile networks |

Browser zoom is emulated faithfully only in Chromium: Chromium's page zoom is a device-scale
change, so a context with `deviceScaleFactor` equal to the zoom and a viewport of the window
divided by it is the same state the page sees after Ctrl/Cmd +. The test checks that the page
reports that devicePixelRatio, width and resolution media query, and that the screenshot keeps
the window's physical width.

## Manual screen-reader traversal

Run before a release that changes the lesson, check, gate or companion, with both readers
below. Use the bundled sample course (or any course with a reading part, a visual, a check and
a gate) and a fresh learner account. Record the build, browser, reader version and every
deviation from the expected announcement on the release checklist.

| Reader | Platform | Browser | Start | Read next / previous | Next heading | Landmarks | Activate |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VoiceOver | macOS | Safari | Cmd+F5 | VO+Right / VO+Left | VO+Cmd+H | VO+U, Landmarks | VO+Space |
| NVDA | Windows | Firefox or Chrome | Ctrl+Alt+N | Down / Up (browse mode) | H | D | Enter (focus mode switches automatically in forms) |

Also run once with VoiceOver on iOS Safari (swipe right / left, double tap) for the phone layout.

### Script

Do each step with the screen reader only: no mouse, screen off or not looked at where practical.

1. **Sign in.** Open the learner app signed out. Expect the page title, then the sign-in form
   announced as a form with "Username" and "Password" edit fields and a "Sign in" button. A
   wrong password announces "The username or password is incorrect." without moving focus away
   from the form.
2. **Course list.** After signing in, move by heading. Expect each course as a heading inside an
   article, followed by its "Open course" button. Landmarks list the banner and main region.
3. **Enrol.** Open a course. Expect the course preview (dates, limits) as text before the
   "Start course" button. Activate it; expect the course page with "Continue learning →".
4. **Lesson heading.** Activate "Continue learning →". Focus moves to the lesson's level-1
   heading, which is announced. The step list is announced as a list, and the current step as
   "current step".
5. **Reading part.** Read on. Expect "Reading part 1" (an article), the "PART 1 OF N" label,
   then the prose in reading order. Math is read as words (for example "x squared"), never as
   TeX. A code example is a scrollable region named "Example in python" (or its language) and
   its lines are read as text. Source links are announced as links with their titles.
6. **Visual.** If the part has a visual: its title and description are read, then the controls
   (Play, the timeline slider with its time and cue, Reset, each state control with its label).
   Arrow keys move a draggable handle, and its new value is announced. The "Text equivalent"
   disclosure expands to the full description. With reduced motion on, "Still mode" is
   announced and Play is unavailable.
7. **Mark read.** Activate "Mark this part read". Expect the part to be announced as read
   ("Read") without focus jumping elsewhere.
8. **Check.** Activate "Start the next check →". Expect the question text, then a radio group
   with each option and its position ("1 of 3"). Choose an option with the arrow keys and
   activate "Check answer". Expect the feedback to be announced once (polite), and focus to stay
   on or near the answer, not at the top of the page.
9. **Slow or offline.** Turn the network off and submit again. Expect "You're offline." and
   "Not recorded yet: your answer is saved on this device…" announced as status. Turn it back
   on; expect the recovery message once.
10. **Gate.** Continue until a checkpoint. Expect its status and what is still needed to be read
    as text, and every action as a button with a full name.
11. **Companion.** Open the companion (the "Companion" button, or the side pane on desktop).
    Expect a dialog named "Your companion" on phone, with focus inside it. Type a question and
    send it with Enter; with an IME (for example Japanese), the Enter that commits the text must
    not send the message. The reply is announced when it is complete, not word by word. Escape
    closes the dialog and returns focus to the button that opened it.
12. **Menu and sign out.** Open the "Your course" menu: expect a menu with menu items, arrow-key
    navigation and Escape to close. Sign out; expect the sign-in form again.

A step fails if something is silent, announced twice, read out of visual order, named only by
an icon, or if focus is lost (moves to the page top or to nothing).
