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
| Browser zoom 200% and 400% | `accessibility.spec.ts` ("browser zoom") | The page lays out as Chromium does at that zoom: devicePixelRatio 2 or 4 on a 1280 px window, 640 or 320 CSS px wide. No horizontal page scroll and no box that scrolls sideways outside code, tables and math, on the course page, the lesson with its check and the companion; the answer actions, menu and companion controls stay reachable, a focused option is not hidden behind sticky actions, and axe passes | Text-only zoom (Firefox "Zoom text only", Safari text size), OS magnifiers, Safari and Firefox page zoom |
| Control targets | `accessibility.spec.ts` ("control targets") | Every control in the lesson, header, companion and menu is at least 24×24 CSS px with a fine pointer and 44×44 with a coarse one (the phone and tablet projects emulate touch; inline links exempt); under a coarse pointer the companion's Send and Stop, Close, Expand, sheet handle, Jump to latest and height buttons are 44×44 at least | Touch accuracy on a real device |
| Forced colours | `accessibility.spec.ts` | In Windows high-contrast emulation, on the course page, the lesson, the check and the companion, every control keeps a border; the base app's cards, notices and menus keep a CanvasText edge once fills are gone; the current step keeps a 3 px outline and keyboard focus the system highlight outline | Every Windows contrast theme |
| Focus ring | `apps/learner/tests/themeBase.test.ts` (stylesheets) | Every `:focus-visible` rule of the app draws a 2 px `--focus` outline (never a box-shadow alone, so forced colours keep it), and the system highlight in forced colours; the token follows the light and the dark theme | How visible the ring is in a browser: the forced-colours row checks it there |
| Dark theme | `dark-theme.spec.ts` (desktop, phone and tablet, en and he) | Under `prefers-color-scheme: dark` the course page, a lesson with its check, the account menu and the companion with a saved conversation (docked or as a sheet) keep no light fill, every text keeps its contrast against the background it is drawn on, and axe passes; files still coloured by literals are named in the test's "pending dark theme" annotation (none) | A course's own images and visuals in the dark theme |
| On-screen keyboard | `accessibility.spec.ts`, `keyboard-layout.spec.ts`, `companion-sheet.spec.ts` | The answer actions stay above a simulated keyboard (a shrunk `visualViewport`); the companion sheet keeps its message box above it and leaves a 48 px strip of lesson | A physical device keyboard |
| Companion frame | `companion-panel.spec.ts`, `companion-sheet.spec.ts`, `companion-focus-view.spec.ts`, `companion-responsive.spec.ts`, `layout-room.spec.ts` | The companion is a complementary region named "Your companion" at every size, never a dialog, with nothing behind it inert; the panel's separator follows the WAI-ARIA window splitter pattern (←/→ 16 px, Shift 64, Home/End, Enter 400 ↔ 560, arrows in screen direction in Hebrew); the sheet's handle takes ↑/↓; Escape stops a reply, then leaves focus view, then closes, and focus returns to the trigger; axe passes at every sheet height, in English and Hebrew | How a reader voices a region that appears beside or below the lesson; a real touch drag |
| Asking about a selection | `ask-from-lesson.spec.ts`, `companion-shortcut.spec.ts` | Nothing selected is attached until the learner asks; a keyboard selection names the shortcut once in a status region; Tab from the selection reaches the floating "Ask companion" button and Tab from it carries on after the selection; Escape hides it and returns focus; the shortcut attaches lesson text through the companion's bridge and code lines inside the code field; on a touch screen the sheet opens at Half without raising the keyboard; axe passes | How a reader voices the status line and the button that appears after a selection; selecting with a reader's own selection commands |
| Line length | `accessibility.spec.ts` ("readable line length") | Lesson prose is at most about 70 characters per line on desktop and uses the card width on phone and tablet | Long words or unusual fonts in a course's own language |
| IME composition | `apps/admin/tests/web/ime.spec.ts`, `apps/{learner,admin}/tests/imeGuard.test.tsx` | An Enter that commits IME composition never submits a form (a real Chromium composition through the DevTools protocol) | Every OS input method |
| Screen-reader order and focus (S12) | `screen-reader.spec.ts` | The accessibility tree a reader's browse mode follows, through a whole lesson: banner and main landmarks; each course an article with its heading before its button; focus on the lesson's level-1 heading on entry; the current step marked; the reading part an article named "Reading part 1" with no TeX source; every control named; after "Mark this part read" and after "Check" focus moves to what comes next (never to the page); the answer's result in a live region; Tab stops in reading order, all visible and named | How VoiceOver or NVDA actually voices each item, verbosity, rotor and gesture behaviour: run the manual script below |
| No layout shift from status | `apps/learner/tests/web/connection-status.spec.ts` (fixtures, desktop and phone, en and he) | The offline and slow-server status floats at the bottom of the window: nothing on the page moves when it appears or goes, it stays inside the window, and axe passes. The "Your course" menu marks the current view with `aria-current` and a drawn marker, no generated text in any language | How a reader announces a status that appears while it is reading something else |
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
   activate "Check". Expect the feedback to be announced once (polite), and focus to stay
   on or near the answer, not at the top of the page.
9. **Slow or offline.** Turn the network off and submit again. Expect "You're offline." and
   "Not recorded yet: your answer is saved on this device…" announced as status (it floats at
   the bottom of the window; the page does not move). Turn it back on; expect the recovery
   message once.
10. **Gate.** Continue until a checkpoint. Expect its status and what is still needed to be read
    as text, and every action as a button with a full name.
11. **Companion.** Open the companion with the "Companion" button in the header (on every
    size), or with Ctrl+Shift+. (⌘⇧. on a Mac) from anywhere outside a text field. Expect the
    button to be announced as expanded, and a complementary region named "Your companion"
    ("המנחה" in Hebrew), never a dialog: beside the lesson on desktop, a sheet over the lower part
    of the lesson on a phone or tablet, with focus moved into it. The lesson stays readable and
    reachable behind the sheet: browse back into it, and focus moved there lands in the visible
    strip above the sheet. Type a question and send it with Enter; with an IME (for example
    Japanese), the Enter that commits the text must not send the message. The reply is announced
    when it is complete, not word by word. On desktop, the "Resize companion" separator announces
    its width; ←/→ change it. On a sheet, the "Resize companion" handle changes its height with ↑/↓,
    and "Full height" / "Half height" name the height they go to. Escape closes the companion and
    returns focus to the "Companion" button (in focus view, the first Escape returns to the panel).
12. **Ask about a selection.** In the lesson text, select a few words with the keyboard (Shift
    with the arrow keys, as caret browsing does it). Expect the status region to say once "Ask
    companion is available: Ctrl+Shift+period" ("אפשר לשאול את המנחה: Ctrl+Shift+נקודה" in
    Hebrew), and nothing to be attached yet. Tab from the selection: expect the floating "Ask
    companion" button; Enter attaches the selection and opens the companion with focus in the
    message box and a "Selected: …" chip in it. Select again and press Escape on the button:
    expect it to go away and focus to return where it came from (the lesson heading, when focus
    was there since the lesson opened, so the next Tab starts from the heading), or, when it came
    from the page itself, to the paragraph that holds the selection. Ctrl+Shift+. (⌘⇧.) with the
    selection attaches it the same way. In a code field, select lines: the button is offered
    there too, and the shortcut works inside the field (the one place it does) and attaches the
    lines.
13. **Menu and sign out.** Open the "Your course" menu: expect an expanded button followed by
    grouped buttons (Tab or the arrow keys move between them), the view on screen announced as
    the current page, and Escape to close it. Choose
    "Change password": expect a dialog named "Change password" over the page, with focus inside
    it; Escape closes it and focus returns to the menu button. Sign out; expect the sign-in form
    again.

A step fails if something is silent, announced twice, read out of visual order, named only by
an icon, or if focus is lost (moves to the page top or to nothing).

## Keyboard shortcut collision check

The companion's shortcut is Ctrl+Shift+. on Windows and Linux and ⌘⇧. on macOS (final design §3.1,
Q8). It is matched on the physical key (`event.code` "Period"), so it is the same key on a Hebrew
or any other layout, it never includes Alt (Alt+Shift switches the keyboard layout on Windows), and
it does nothing while focus is in a text field, where the keys belong to the field
(`src/connected/companion/shortcut.ts`, `tests/shortcut.test.ts`, `companion-shortcut.spec.ts`).
The one exception is a code field with lines selected, where it attaches those lines
(`AskFromLesson.web.tsx`, with the same matcher, `isCompanionShortcut`). The
trigger announces it with `aria-keyshortcuts` and shows it in its tooltip.

| Where | Ctrl+Shift+. / ⌘⇧. already means | Result |
| --- | --- | --- |
| Chrome, Edge (Windows, Linux, ChromeOS) | nothing by default | free |
| Firefox (Windows, Linux) | nothing by default | free |
| Safari, Chrome, Firefox (macOS) | nothing in the browser; ⌘⇧. shows hidden files only in Finder's file dialogs, which are not open over a page | free |
| macOS system | ⌘⇧. has no system binding | free |
| Windows system | Ctrl+Shift alone switches the keyboard layout on some setups; with "." it is not a system shortcut | free (the layout switch fires on Ctrl+Shift without a third key) |
| ChromeOS | Ctrl+Shift+. has no default binding (the launcher and accessibility shortcuts use Search or Alt) | free |
| NVDA (Windows) | NVDA's own keys use the NVDA modifier (Insert or Caps Lock); none is Ctrl+Shift+. | free |
| JAWS (Windows) | JAWS uses the Insert modifier; none is Ctrl+Shift+. | free |
| Narrator (Windows) | Narrator uses Caps Lock or Insert; none is Ctrl+Shift+. | free |
| VoiceOver (macOS) | VoiceOver uses Control+Option; ⌘⇧. is not a VoiceOver command | free |
| Orca (Linux) | Orca uses Insert or Caps Lock; none is Ctrl+Shift+. | free |
| Hebrew layout | the period key types ץ; `event.code` is still "Period" | works |
| Inside a text field (the message box, an answer) | the field's own keys | the shortcut is not taken |

The check above is from each product's published shortcut lists and must be repeated on real
devices before the shortcut stops being provisional (Q8); a collision found there is reported to
the owner rather than worked around with Alt.
