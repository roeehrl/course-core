/**
 * Text of the "AI services" page, in the shape of the i18n foundation's message catalogs
 * (namespace `aiServices`): flat dotted keys, ICU-style `{name}` arguments and
 * `{count, plural, one {…} two {…} other {…}}` plurals. When `@course-core/i18n` lands, each
 * object becomes `messages/<locale>/aiServices.json` unchanged and `aiTranslator` is replaced by
 * the app's `useT()`. Internal terms (adapter, slot, digest, revision, metadata) appear only in
 * the `advanced.*` keys.
 */
export type AiLocale = "en" | "he";

const en = {
  "page.title": "AI services",
  "page.intro":
    "Connect an AI service with your own API key, choose a model for each job, add prices and set spending limits. Each part is saved on its own.",
  "page.loading": "Loading AI services…",
  "page.loadFailed":
    "AI services couldn't be loaded. Check your connection and try again.",
  "page.retry": "Try again",
  "page.reload": "Reload",
  "page.sections": "Sections",

  "status.on": "AI services are on.",
  "status.onDetail":
    "The jobs your course needs have a working connection, a model, prices and spending limits.",
  "status.off": "AI services are off:",
  "status.unsaved": "Unsaved changes in: {sections}",
  "issue.connect": "connect an AI service",
  "issue.keyProblem":
    "{count, plural, one {# connection has a key problem} other {# connections have a key problem}}",
  "issue.models":
    "{count, plural, one {# job needs a model} two {# jobs need a model} other {# jobs need a model}}",
  "issue.check":
    "{count, plural, one {# model is waiting for a quality check} two {# models are waiting for a quality check} other {# models are waiting for a quality check}}",
  "issue.notOn": "your model choices aren't turned on yet",
  "issue.prices":
    "{count, plural, one {# model needs a price} two {# models need a price} other {# models need a price}}",
  "issue.spending": "spending is off",
  "issue.learnerLimit": "learners have no spending limit",

  "pill.working": "Working",
  "pill.done": "Done",
  "pill.notConnected": "Not connected",
  "pill.keyProblem": "Key problem",
  "pill.notTested": "Not tested",
  "pill.modelNeeded": "Model needed",
  "pill.waitingCheck": "Waiting for check",
  "pill.notOn": "Not turned on",
  "pill.priceNeeded": "Price needed",
  "pill.nothingYet": "Nothing to do yet",
  "pill.spendingOff": "Spending is off",
  "pill.learnerLimitNeeded": "Learner limit needed",
  "pill.unsaved": "Unsaved changes",
  "pill.optional": "Optional",

  "section.connections": "Connections",
  "section.models": "Models for each job",
  "section.prices": "Prices",
  "section.spending": "Spending limits",
  "section.check": "Quality check",
  "section.advanced": "Advanced (for developers)",

  "kind.google": "Google Gemini",
  "kind.anthropic": "Anthropic Claude",
  "service.google": "Google",
  "service.anthropic": "Anthropic",

  "connect.title": "Connect an AI service",
  "connect.intro":
    "Course Core uses your own API key. It is stored encrypted on this server and is never shown again.",
  "connect.serviceLabel": "Service",
  "connect.keyLabel": "API key",
  "connect.showKey": "Show key",
  "connect.hideKey": "Hide key",
  "connect.keyHelp.google": "Create a key in Google AI Studio",
  "connect.keyHelp.anthropic": "Create a key in the Anthropic Console",
  "connect.newTab": "(opens in a new tab)",
  "connect.testing": "Checking the key with {service}…",
  "connect.testOk":
    "Key works. {service} offers {count, plural, one {# model} two {# models} other {# models}} to this key.",
  "connect.test": "Check key",
  "connect.nameLabel": "Name (optional)",
  "connect.nameHint":
    "Helps you tell connections apart, for example “Google – school account”.",
  "connect.save": "Save connection",
  "connect.saving": "Saving…",
  "connect.saved": "Connection saved. Key ending {ending}.",
  "connect.savedNoEnding": "Connection saved.",
  "connect.errEmpty": "Enter your {service} API key",
  "connect.errRejected":
    "{service} rejected this key. Check that you copied the whole key, or create a new one.",
  "connect.errForbidden":
    "This key works but isn't allowed to use the {service} API. Turn the API on for the key's project, then try again.",
  "connect.errQuota":
    "{service} says this key has no remaining quota or billing isn't set up. Check billing in your {service} account.",
  "connect.errUnreachable":
    "This server couldn't reach {service}. Check its internet access or proxy settings, then try again.",
  "connect.errRateLimited":
    "Too many key checks in the last hour. Try again in {minutes, plural, one {# minute} two {# minutes} other {# minutes}}.",
  "connect.errMalformed":
    "This doesn't look like an API key. It contains spaces or characters a key can't have.",
  "connect.errUnexpected":
    "The key check didn't finish. Try again; nothing was saved.",
  "connect.unreachableQuestion": "Can't reach {service} from this server?",
  "connect.saveUntested": "Save without testing",
  "connect.saveUntestedWarn":
    "The key will be saved untested. AI help will fail until it works.",
  "connect.technical": "Technical details",
  "connect.technicalCode": "Reason code",
  "connect.addAnother": "Add another connection",
  "connect.cancel": "Cancel",
  "connect.none": "No AI service is connected yet.",

  "row.keyEnding": "Key ending {ending}",
  "row.keySaved": "Key saved",
  "row.keyMissing": "No key saved",
  "row.tested": "Tested {when}",
  "row.notTested": "Not tested yet",
  "row.working": "Working",
  "row.rejected": "Key rejected",
  "row.unreachable": "Couldn't reach {service}",
  "row.testAgain": "Test again",
  "row.testing": "Testing…",
  "row.replaceKey": "Replace key",
  "row.remove": "Remove",
  "row.newKeyLabel": "New API key for {name}",
  "row.replaceNote":
    "The new key replaces the old one for every model using this connection. Jobs already running finish with the old key.",
  "row.replaceSave": "Save new key",
  "row.replaced": "New key saved. Key ending {ending}.",
  "row.replacedNoEnding": "New key saved.",
  "row.removeTitle": "Remove this connection?",
  "row.removeBody":
    "{name} and its key are deleted from this server. This can't be undone.",
  "row.removeConfirm": "Remove connection",
  "row.removed": "Connection removed.",
  "row.inUse":
    "{jobs} use this connection. Choose other models for them first.",
  "row.usedBy": "Used by {jobs}",
  "row.notUsed": "Not used by any job",
  "row.testResult.ok": "Key works.",
  "row.connectionName": "{service} · {name}",

  "role.companion.name": "Learner tutor",
  "role.companion.purpose": "Chats with learners about the lesson.",
  "role.supervisor.name": "Lesson planner",
  "role.supervisor.purpose":
    "Decides what each learner does next and when to review.",
  "role.research.name": "Source finder",
  "role.research.purpose":
    "Finds and summarises outside sources for staff to approve.",
  "role.reviewer.name": "Answer review drafts",
  "role.reviewer.purpose":
    "Drafts feedback on written answers for staff to review.",
  "role.media.name": "Images and video",
  "role.media.purpose":
    "Makes illustrations or short clips for staff to review.",

  "models.intro":
    "We picked a suggestion for each job your course uses. You can change them later.",
  "models.basis":
    "Suggestions are based on the model list your service reports. The quality check below tries them out.",
  "models.needConnection": "Connect an AI service first.",
  "models.needed": "Needed by your course",
  "models.optional":
    "{count, plural, one {Optional job (#)} two {Optional jobs (#)} other {Optional jobs (#)}}",
  "models.suggested": "Suggested",
  "models.off": "Off",
  "models.chooseModel": "Choose a model",
  "models.showAll": "Show all models",
  "models.mayNotWork": "May not work for this job",
  "models.modelFor": "Model for {job}",
  "models.loading": "Loading the model list…",
  "models.listFailed": "The model list couldn't be loaded.",
  "models.notOffered": "{service} doesn't offer this job.",
  "models.mediaKind": "Kind",
  "models.image": "Image",
  "models.video": "Short video",
  "models.videoDuration": "Length in seconds",
  "models.videoAspect": "Aspect ratio",
  "models.videoResolution": "Resolution",
  "models.videoHosts": "Allowed download hosts (comma-separated)",
  "models.videoNote": "Check these against the model's documentation.",
  "models.save": "Save models",
  "models.saving": "Saving…",
  "models.saved": "Models saved and turned on.",
  "models.savedWaiting":
    "Models saved. {count, plural, one {# model needs} two {# models need} other {# models need}} a quality check before it turns on. See Quality check below.",
  "models.pending":
    "Your new choices are saved but not on yet. Learners still get the models that are on now.",
  "models.discard": "Discard these choices",
  "models.discarded": "Choices discarded.",
  "models.turnOn": "Turn on these models",
  "models.errNeeded": "Choose a model for {job}",
  "models.errVideo": "Fill in the video settings, or choose Image.",

  "prices.intro":
    "Course Core doesn't include {service}'s prices, because they change. Copy them from {service}'s pricing page.",
  "prices.openPricing": "Open {service}'s pricing page",
  "prices.usedBy": "used by {roles}",
  "prices.input": "Input, per 1M tokens",
  "prices.output": "Output, per 1M tokens",
  "prices.more": "More price types",
  "prices.cached": "Cached input, per 1M tokens",
  "prices.perRequest": "Per request",
  "prices.perSearch": "Per web search",
  "prices.perVideoSecond": "Per second of video",
  "prices.source": "Source",
  "prices.sourceDefault": "{service} pricing page, read {date}",
  "prices.current": "Current price from {date}",
  "prices.nothing": "Prices appear here after you choose models.",
  "prices.save": "Save prices",
  "prices.saving": "Saving…",
  "prices.saved": "Prices saved.",
  "prices.missingNote": "Until you add prices, these jobs stay off.",
  "prices.errBoth": "Enter the input price, or leave both prices empty",
  "prices.errAmount": "Enter an amount like 0.30",
  "prices.errSource": "Say where the prices come from",

  "spending.total": "Total for this workspace",
  "spending.perLearner": "For each learner",
  "spending.perLearnerHint":
    "Applies to every learner who doesn't have their own limit.",
  "spending.perRequest": "For each request",
  "spending.perRequestSummary":
    "{amount} · up to {minutes, plural, one {# minute} two {# minutes} other {# minutes}}",
  "spending.change": "Change in Advanced",
  "spending.note":
    "When a limit is reached, AI help pauses for that workspace or learner until you raise it. {service}'s own billing is separate.",
  "spending.noteGeneric":
    "When a limit is reached, AI help pauses for that workspace or learner until you raise it. Your AI service's own billing is separate.",
  "spending.used": "{used} of {limit} used",
  "spending.allow": "Allow spending up to {amount}",
  "spending.noSpend": "Turn spending off",
  "spending.saving": "Saving…",
  "spending.saved": "Spending limits saved.",
  "spending.savedOff": "Spending is off.",
  "spending.consent":
    "Pressing the button records your consent to spend up to this amount on AI calls.",
  "spending.errAmount": "Enter an amount like 25.00",
  "spending.errLearnerMore":
    "The limit for each learner can't be more than the total",
  "spending.errBelowUsage":
    "This is less than what's already been used ({used}).",
  "spending.errMax": "The most you can set here is {amount}.",

  "history.title": "Spending so far",
  "history.period": "Group by",
  "history.day": "Day",
  "history.month": "Month",
  "history.charged": "Charged now",
  "history.actual": "Actual cost of priced calls",
  "history.held": "Held for calls in flight",
  "history.calls": "Calls",
  "history.job": "Job",
  "history.when": "Period",
  "history.byJob": "By job",
  "history.byPeriod": "By period",
  "history.note":
    "Course Core's own records, not an invoice. Periods are in UTC.",
  "history.empty": "Nothing has been spent yet.",
  "history.loading": "Loading spending…",
  "check.notChecked":
    "{count, plural, one {This model hasn't been checked yet:} two {These models haven't been checked yet:} other {These models haven't been checked yet:}}",
  "check.item": "{job} — {model}",
  "check.nothingWaiting": "No model is waiting for a check.",
  "check.explain":
    "The quality check runs {dialogues, plural, one {# practice conversation} two {# practice conversations} other {# practice conversations}} with your models and checks that replies follow the teaching rules. It uses your key and budget.",
  "check.notHere":
    "Running the check from this page isn't available yet. A developer can run it from the command line and upload the result (see Advanced), or an owner can approve the models without checking.",
  "check.approveTitle": "Approve without checking",
  "check.approveOwnersOnly":
    "Only an owner can approve without checking. Ask an owner, or run the check.",
  "check.reasonLabel": "Why are you skipping the check?",
  "check.reasonHint":
    "At least 20 characters. Saved in the audit log with your name.",
  "check.reasonCount": "{count} of at least 20 characters",
  "check.approve": "Approve and turn on",
  "check.approving": "Approving…",
  "check.approved": "Approved and turned on.",
  "check.errReason":
    "Write at least 20 characters about why you're skipping the check.",
  "check.disclaimer":
    "The check is a set of rules, not proof of teaching quality.",
  "check.onTitle": "Jobs that are on",
  "check.state.passed": "Checked",
  "check.state.override": "Approved without checking",
  "check.state.not_covered": "No check for this job yet — ready",
  "check.state.not_evaluated": "Not checked (on since before checks)",
  "check.state.failed": "Didn't pass",
  "check.state.stale": "Needs a new check",
  "check.noneOn": "No job is on yet.",

  "confirm.title": "Stop unfinished jobs?",
  "confirm.body":
    "Turning this on stops {count, plural, one {# unfinished job} two {# unfinished jobs} other {# unfinished jobs}}. Calls already sent may still finish and be charged.",
  "confirm.go": "Turn on and stop them",
  "confirm.cancel": "Cancel",

  "advanced.summary": "Advanced (for developers)",
  "advanced.intro":
    "For developers and unusual setups. Changes here skip the guided checks above, but the server still enforces the quality check and spending limits.",
  "advanced.configTitle": "Configuration (read-only)",
  "advanced.configNote":
    "Each connection stores its key in its own encrypted slot on the server (shown here as COURSE_PROVIDER_…_API_KEY). You never need to type this name. No key is ever part of this configuration.",
  "advanced.roleIds":
    "Job ids: companion (Learner tutor), supervisor (Lesson planner), research (Source finder), reviewer (Answer review drafts), media (Images and video). Setup version {revision}.",
  "advanced.copy": "Copy",
  "advanced.copied": "Copied.",
  "advanced.editJson": "Edit as JSON",
  "advanced.jsonLabel": "Configuration JSON",
  "advanced.saveJson": "Save JSON",
  "advanced.jsonInvalid": "This isn't valid JSON: {message}",
  "advanced.jsonPosition": "line {line}, column {column}",
  "advanced.jsonSaved": "Configuration saved and turned on.",
  "advanced.jsonWaiting":
    "Configuration saved as a draft. It turns on after the quality check (see Quality check).",
  "advanced.limitsTitle": "Limits for each request",
  "advanced.limitCost": "Cost per request (USD)",
  "advanced.limitTokens": "Tokens per request",
  "advanced.limitDeadline": "Deadline (minutes)",
  "advanced.limitTimeout": "Time limit for each call (seconds)",
  "advanced.limitAttempts": "Attempts",
  "advanced.saveLimits": "Save limits",
  "advanced.limitsSaved": "Limits saved.",
  "advanced.limitsInvalid": "Enter whole numbers within the allowed range.",
  "advanced.fallbackTitle": "Subscription fallback",
  "advanced.fallbackNone": "No subscription connection is configured.",
  "advanced.fallbackLabel":
    "If the subscription {name} runs out, use an API key instead",
  "advanced.fallbackKey": "API key to use",
  "advanced.fallbackChoose": "Choose a connection",
  "advanced.saveFallback": "Save fallback",
  "advanced.serviceKeysTitle": "Other service keys",
  "advanced.youtube": "YouTube search key",
  "advanced.youtubeHint": "Lets staff search YouTube for course sources.",
  "advanced.serviceSaved": "Key saved",
  "advanced.serviceNotSaved": "Not set",
  "advanced.saveServiceKey": "Save key",
  "advanced.removeServiceKey": "Remove key",
  "advanced.serviceKeyStored": "Key saved.",
  "advanced.serviceKeyRemoved": "Key removed.",
  "advanced.pricingRuleTitle": "Models without a price",
  "advanced.requirePricing": "Refuse paid work for models without a price",
  "advanced.requirePricingAck":
    "I understand that without a price each call is charged at its full per-request limit.",
  "advanced.saveRule": "Save rule",
  "advanced.ruleSaved": "Rule saved.",
  "advanced.historyTitle": "Setup history",
  "advanced.historyEmpty": "No quality-check results or approvals yet.",
  "advanced.historyResult": "{job}: check {outcome} on {date}",
  "advanced.historyOverride": "{job}: approved without checking on {date}",
  "advanced.historyReason": "Reason: {reason}",
  "advanced.fingerprint": "Version fingerprint",
  "advanced.cli":
    "Run the check from the command line with npm run eval:agents in services/api, then upload the report with POST …/provider-evals/results.",
  "advanced.outcome.passed": "passed",
  "advanced.outcome.failed": "failed",

  "err.stale":
    "Someone else changed AI services since you opened this page. Reload to see their changes; your choices in this section are kept.",
  "err.forbidden":
    "You don't have permission to change AI services. Ask a workspace owner.",
  "err.unavailable":
    "The server couldn't be reached. Your changes are still here. Try again.",
  "err.generic": "That didn't work. Try again; nothing was changed.",
  "err.evalRequired":
    "These models need a quality check or an owner's approval before they turn on.",
  "err.connectionInUse":
    "{jobs} use this connection. Choose other models for them first.",
  "err.budgetBelowUsage":
    "A limit can't be lower than what's already been used.",
  "err.consent": "Press the spending button to give consent.",
  "err.tooSmall":
    "The limit for each request is too small for these models. Raise it in Advanced.",
  "err.modelUnavailable":
    "That model isn't in the service's model list any more. Choose another one.",
  "err.contextTooSmall":
    "This model can't take enough text for the lesson planner. Choose a model with a larger input limit.",
  "err.configInvalid": "The configuration isn't valid. Check it and try again.",
  "err.secretField":
    "The configuration contains a field that looks like a key or password. Keys go in Connections, never in the configuration.",
  "err.summary": "There is a problem",

  "readonly.body":
    "Only workspace owners and administrators can change AI services. Ask one of them if something needs to change.",
  "readonly.demo":
    "This is the demo. AI services are set up on a connected server.",
  "readonly.status.configured": "Set up",
  "readonly.status.absent": "Not set up",
  "readonly.status.pending_review": "Waiting for review",
} as const;

export type AiKey = keyof typeof en;

const he: Record<AiKey, string> = {
  "page.title": "שירותי AI",
  "page.intro":
    "חברו שירות AI עם מפתח API משלכם, בחרו מודל לכל משימה, הזינו מחירים והגדירו מגבלות הוצאה. כל חלק נשמר בנפרד.",
  "page.loading": "טוען את שירותי ה-AI…",
  "page.loadFailed":
    "לא ניתן היה לטעון את שירותי ה-AI. בדקו את החיבור ונסו שוב.",
  "page.retry": "נסו שוב",
  "page.reload": "טעינה מחדש",
  "page.sections": "חלקים",

  "status.on": "שירותי ה-AI פועלים.",
  "status.onDetail":
    "למשימות שהקורס שלכם צריך יש חיבור תקין, מודל, מחירים ומגבלות הוצאה.",
  "status.off": "שירותי ה-AI כבויים:",
  "status.unsaved": "שינויים שלא נשמרו ב: {sections}",
  "issue.connect": "צריך לחבר שירות AI",
  "issue.keyProblem":
    "{count, plural, one {בחיבור אחד יש בעיה במפתח} two {בשני חיבורים יש בעיה במפתח} other {ב-# חיבורים יש בעיה במפתח}}",
  "issue.models":
    "{count, plural, one {משימה אחת צריכה מודל} two {שתי משימות צריכות מודל} other {# משימות צריכות מודל}}",
  "issue.check":
    "{count, plural, one {מודל אחד ממתין לבדיקת איכות} two {שני מודלים ממתינים לבדיקת איכות} other {# מודלים ממתינים לבדיקת איכות}}",
  "issue.notOn": "בחירת המודלים שלכם עדיין לא הופעלה",
  "issue.prices":
    "{count, plural, one {מודל אחד צריך מחיר} two {שני מודלים צריכים מחיר} other {# מודלים צריכים מחיר}}",
  "issue.spending": "ההוצאה כבויה",
  "issue.learnerLimit": "ללומדים אין מגבלת הוצאה",

  "pill.working": "פועל",
  "pill.done": "הושלם",
  "pill.notConnected": "לא מחובר",
  "pill.keyProblem": "בעיה במפתח",
  "pill.notTested": "לא נבדק",
  "pill.modelNeeded": "צריך מודל",
  "pill.waitingCheck": "ממתין לבדיקה",
  "pill.notOn": "לא הופעל",
  "pill.priceNeeded": "צריך מחיר",
  "pill.nothingYet": "אין עדיין מה לעשות",
  "pill.spendingOff": "ההוצאה כבויה",
  "pill.learnerLimitNeeded": "צריך מגבלה ללומד",
  "pill.unsaved": "שינויים שלא נשמרו",
  "pill.optional": "רשות",

  "section.connections": "חיבורים",
  "section.models": "מודל לכל משימה",
  "section.prices": "מחירים",
  "section.spending": "מגבלות הוצאה",
  "section.check": "בדיקת איכות",
  "section.advanced": "מתקדם (למפתחים)",

  "kind.google": "Google Gemini",
  "kind.anthropic": "Anthropic Claude",
  "service.google": "Google",
  "service.anthropic": "Anthropic",

  "connect.title": "חיבור שירות AI",
  "connect.intro":
    "‏Course Core משתמש במפתח ה-API שלכם. הוא נשמר מוצפן בשרת הזה ולא מוצג שוב לעולם.",
  "connect.serviceLabel": "שירות",
  "connect.keyLabel": "מפתח API",
  "connect.showKey": "הצגת המפתח",
  "connect.hideKey": "הסתרת המפתח",
  "connect.keyHelp.google": "יצירת מפתח ב-Google AI Studio",
  "connect.keyHelp.anthropic": "יצירת מפתח ב-Anthropic Console",
  "connect.newTab": "(נפתח בכרטיסייה חדשה)",
  "connect.testing": "בודקים את המפתח מול {service}…",
  "connect.testOk":
    "המפתח תקין. {service} מציעה {count, plural, one {מודל אחד} two {שני מודלים} other {# מודלים}} למפתח הזה.",
  "connect.test": "בדיקת המפתח",
  "connect.nameLabel": "שם (רשות)",
  "connect.nameHint":
    "עוזר להבדיל בין חיבורים, למשל „Google – חשבון בית הספר”.",
  "connect.save": "שמירת החיבור",
  "connect.saving": "שומרים…",
  "connect.saved": "החיבור נשמר. המפתח מסתיים ב-{ending}.",
  "connect.savedNoEnding": "החיבור נשמר.",
  "connect.errEmpty": "הזינו את מפתח ה-API של {service}",
  "connect.errRejected":
    "‏{service} דחתה את המפתח. ודאו שהעתקתם את המפתח כולו, או צרו מפתח חדש.",
  "connect.errForbidden":
    "המפתח תקין, אבל אין לו הרשאה להשתמש ב-API של {service}. הפעילו את ה-API בפרויקט של המפתח ונסו שוב.",
  "connect.errQuota":
    "‏{service} מדווחת שלמפתח אין מכסה פנויה או שהחיוב לא הוגדר. בדקו את החיוב בחשבון {service} שלכם.",
  "connect.errUnreachable":
    "השרת לא הצליח להגיע אל {service}. בדקו את הגישה שלו לאינטרנט או את הגדרות ה-proxy, ונסו שוב.",
  "connect.errRateLimited":
    "יותר מדי בדיקות מפתח בשעה האחרונה. נסו שוב בעוד {minutes, plural, one {דקה} two {שתי דקות} other {# דקות}}.",
  "connect.errMalformed":
    "זה לא נראה כמו מפתח API. יש בו רווחים או תווים שלא יכולים להופיע במפתח.",
  "connect.errUnexpected": "בדיקת המפתח לא הסתיימה. נסו שוב; שום דבר לא נשמר.",
  "connect.unreachableQuestion": "השרת לא מצליח להגיע אל {service}?",
  "connect.saveUntested": "שמירה בלי בדיקה",
  "connect.saveUntestedWarn":
    "המפתח יישמר בלי בדיקה. עזרת ה-AI לא תעבוד עד שהמפתח יעבוד.",
  "connect.technical": "פרטים טכניים",
  "connect.technicalCode": "קוד הסיבה",
  "connect.addAnother": "הוספת חיבור נוסף",
  "connect.cancel": "ביטול",
  "connect.none": "עדיין לא חובר שירות AI.",

  "row.keyEnding": "המפתח מסתיים ב-{ending}",
  "row.keySaved": "המפתח שמור",
  "row.keyMissing": "לא נשמר מפתח",
  "row.tested": "נבדק {when}",
  "row.notTested": "עדיין לא נבדק",
  "row.working": "פועל",
  "row.rejected": "המפתח נדחה",
  "row.unreachable": "אין גישה אל {service}",
  "row.testAgain": "בדיקה חוזרת",
  "row.testing": "בודקים…",
  "row.replaceKey": "החלפת המפתח",
  "row.remove": "הסרה",
  "row.newKeyLabel": "מפתח API חדש עבור {name}",
  "row.replaceNote":
    "המפתח החדש מחליף את הישן בכל המודלים שמשתמשים בחיבור הזה. משימות שכבר רצות יסתיימו עם המפתח הישן.",
  "row.replaceSave": "שמירת המפתח החדש",
  "row.replaced": "המפתח החדש נשמר. הוא מסתיים ב-{ending}.",
  "row.replacedNoEnding": "המפתח החדש נשמר.",
  "row.removeTitle": "להסיר את החיבור?",
  "row.removeBody": "‏{name} והמפתח שלו יימחקו מהשרת. אי אפשר לבטל את הפעולה.",
  "row.removeConfirm": "הסרת החיבור",
  "row.removed": "החיבור הוסר.",
  "row.inUse": "‏{jobs} משתמשים בחיבור הזה. בחרו להם מודלים אחרים קודם.",
  "row.usedBy": "בשימוש של {jobs}",
  "row.notUsed": "אף משימה לא משתמשת בו",
  "row.testResult.ok": "המפתח תקין.",
  "row.connectionName": "{service} · {name}",

  "role.companion.name": "מורה פרטי ללומדים",
  "role.companion.purpose": "משוחח עם הלומדים על השיעור.",
  "role.supervisor.name": "מתכנן השיעורים",
  "role.supervisor.purpose": "מחליט מה כל לומד עושה עכשיו ומתי לחזור על חומר.",
  "role.research.name": "מאתר מקורות",
  "role.research.purpose": "מוצא ומסכם מקורות חיצוניים לאישור הצוות.",
  "role.reviewer.name": "טיוטות משוב לתשובות",
  "role.reviewer.purpose": "מנסח טיוטות משוב על תשובות כתובות לבדיקת הצוות.",
  "role.media.name": "תמונות ווידאו",
  "role.media.purpose": "יוצר איורים או סרטונים קצרים לבדיקת הצוות.",

  "models.intro":
    "בחרנו הצעה לכל משימה שהקורס שלכם משתמש בה. אפשר לשנות אותן בהמשך.",
  "models.basis":
    "ההצעות מבוססות על רשימת המודלים שהשירות שלכם מדווח. בדיקת האיכות שלמטה מנסה אותן.",
  "models.needConnection": "חברו קודם שירות AI.",
  "models.needed": "נדרש לקורס שלכם",
  "models.optional":
    "{count, plural, one {משימת רשות (#)} two {משימות רשות (#)} other {משימות רשות (#)}}",
  "models.suggested": "מומלץ",
  "models.off": "כבוי",
  "models.chooseModel": "בחרו מודל",
  "models.showAll": "הצגת כל המודלים",
  "models.mayNotWork": "ייתכן שלא יעבוד למשימה הזו",
  "models.modelFor": "מודל עבור {job}",
  "models.loading": "טוען את רשימת המודלים…",
  "models.listFailed": "לא ניתן היה לטעון את רשימת המודלים.",
  "models.notOffered": "‏{service} לא מציעה את המשימה הזו.",
  "models.mediaKind": "סוג",
  "models.image": "תמונה",
  "models.video": "סרטון קצר",
  "models.videoDuration": "אורך בשניות",
  "models.videoAspect": "יחס גובה-רוחב",
  "models.videoResolution": "רזולוציה",
  "models.videoHosts": "שרתי הורדה מותרים (מופרדים בפסיקים)",
  "models.videoNote": "בדקו את הערכים האלה מול התיעוד של המודל.",
  "models.save": "שמירת המודלים",
  "models.saving": "שומרים…",
  "models.saved": "המודלים נשמרו והופעלו.",
  "models.savedWaiting":
    "המודלים נשמרו. {count, plural, one {מודל אחד צריך} two {שני מודלים צריכים} other {# מודלים צריכים}} בדיקת איכות לפני ההפעלה. ראו „בדיקת איכות” למטה.",
  "models.pending":
    "הבחירות החדשות שלכם נשמרו אבל עדיין לא הופעלו. הלומדים ממשיכים לקבל את המודלים שפועלים עכשיו.",
  "models.discard": "ביטול הבחירות האלה",
  "models.discarded": "הבחירות בוטלו.",
  "models.turnOn": "הפעלת המודלים האלה",
  "models.errNeeded": "בחרו מודל עבור {job}",
  "models.errVideo": "מלאו את הגדרות הווידאו, או בחרו „תמונה”.",

  "prices.intro":
    "‏Course Core לא כולל את המחירים של {service}, כי הם משתנים. העתיקו אותם מדף המחירים של {service}.",
  "prices.openPricing": "פתיחת דף המחירים של {service}",
  "prices.usedBy": "בשימוש של {roles}",
  "prices.input": "קלט, לכל מיליון טוקנים",
  "prices.output": "פלט, לכל מיליון טוקנים",
  "prices.more": "סוגי מחיר נוספים",
  "prices.cached": "קלט מהמטמון, לכל מיליון טוקנים",
  "prices.perRequest": "לכל בקשה",
  "prices.perSearch": "לכל חיפוש ברשת",
  "prices.perVideoSecond": "לכל שנייה של וידאו",
  "prices.source": "מקור",
  "prices.sourceDefault": "דף המחירים של {service}, נקרא ב-{date}",
  "prices.current": "המחיר הנוכחי מ-{date}",
  "prices.nothing": "המחירים יופיעו כאן אחרי שתבחרו מודלים.",
  "prices.save": "שמירת המחירים",
  "prices.saving": "שומרים…",
  "prices.saved": "המחירים נשמרו.",
  "prices.missingNote": "עד שתזינו מחירים, המשימות האלה נשארות כבויות.",
  "prices.errBoth": "הזינו את מחיר הקלט, או השאירו את שני המחירים ריקים",
  "prices.errAmount": "הזינו סכום כמו 0.30",
  "prices.errSource": "ציינו מאיפה המחירים",

  "spending.total": "סך הכול לסביבת העבודה",
  "spending.perLearner": "לכל לומד",
  "spending.perLearnerHint": "חל על כל לומד שאין לו מגבלה משלו.",
  "spending.perRequest": "לכל בקשה",
  "spending.perRequestSummary":
    "{amount} · עד {minutes, plural, one {דקה} two {שתי דקות} other {# דקות}}",
  "spending.change": "שינוי בחלק „מתקדם”",
  "spending.note":
    "כשמגיעים למגבלה, עזרת ה-AI נעצרת עבור סביבת העבודה או הלומד עד שתעלו אותה. החיוב של {service} עצמה נפרד.",
  "spending.noteGeneric":
    "כשמגיעים למגבלה, עזרת ה-AI נעצרת עבור סביבת העבודה או הלומד עד שתעלו אותה. החיוב של שירות ה-AI עצמו נפרד.",
  "spending.used": "נוצלו {used} מתוך {limit}",
  "spending.allow": "אישור הוצאה של עד {amount}",
  "spending.noSpend": "כיבוי ההוצאה",
  "spending.saving": "שומרים…",
  "spending.saved": "מגבלות ההוצאה נשמרו.",
  "spending.savedOff": "ההוצאה כבויה.",
  "spending.consent":
    "לחיצה על הכפתור מתעדת את הסכמתכם להוציא עד הסכום הזה על קריאות AI.",
  "spending.errAmount": "הזינו סכום כמו 25.00",
  "spending.errLearnerMore": "המגבלה לכל לומד לא יכולה להיות גבוהה מהסך הכול",
  "spending.errBelowUsage": "זה פחות ממה שכבר נוצל ({used}).",
  "spending.errMax": "הסכום הגבוה ביותר שאפשר להגדיר כאן הוא {amount}.",

  "history.title": "ההוצאה עד עכשיו",
  "history.period": "קיבוץ לפי",
  "history.day": "יום",
  "history.month": "חודש",
  "history.charged": "חויב עד עכשיו",
  "history.actual": "העלות בפועל של קריאות עם מחיר",
  "history.held": "מוחזק עבור קריאות שעדיין רצות",
  "history.calls": "קריאות",
  "history.job": "משימה",
  "history.when": "תקופה",
  "history.byJob": "לפי משימה",
  "history.byPeriod": "לפי תקופה",
  "history.note": "הרישומים של Course Core עצמו, לא חשבונית. התקופות לפי UTC.",
  "history.empty": "עדיין לא הוצא כסף.",
  "history.loading": "טוען את ההוצאה…",
  "check.notChecked":
    "{count, plural, one {המודל הזה עדיין לא נבדק:} two {שני המודלים האלה עדיין לא נבדקו:} other {המודלים האלה עדיין לא נבדקו:}}",
  "check.item": "{job} — {model}",
  "check.nothingWaiting": "אין מודל שממתין לבדיקה.",
  "check.explain":
    "בדיקת האיכות מריצה {dialogues, plural, one {שיחת תרגול אחת} two {שתי שיחות תרגול} other {# שיחות תרגול}} עם המודלים שלכם ובודקת שהתשובות עומדות בכללי ההוראה. היא משתמשת במפתח ובתקציב שלכם.",
  "check.notHere":
    "עדיין אי אפשר להריץ את הבדיקה מהדף הזה. מפתח יכול להריץ אותה משורת הפקודה ולהעלות את התוצאה (ראו „מתקדם”), או שבעלים יכולים לאשר את המודלים בלי בדיקה.",
  "check.approveTitle": "אישור בלי בדיקה",
  "check.approveOwnersOnly":
    "רק בעלים יכולים לאשר בלי בדיקה. פנו לבעלים, או הריצו את הבדיקה.",
  "check.reasonLabel": "למה אתם מדלגים על הבדיקה?",
  "check.reasonHint": "לפחות 20 תווים. נשמר ביומן הביקורת יחד עם השם שלכם.",
  "check.reasonCount": "{count} מתוך 20 תווים לפחות",
  "check.approve": "אישור והפעלה",
  "check.approving": "מאשרים…",
  "check.approved": "אושר והופעל.",
  "check.errReason": "כתבו לפחות 20 תווים על הסיבה לדילוג על הבדיקה.",
  "check.disclaimer": "הבדיקה היא אוסף כללים, לא הוכחה לאיכות ההוראה.",
  "check.onTitle": "משימות פועלות",
  "check.state.passed": "נבדק",
  "check.state.override": "אושר בלי בדיקה",
  "check.state.not_covered": "אין עדיין בדיקה למשימה הזו — מוכן",
  "check.state.not_evaluated": "לא נבדק (פועל מלפני שהיו בדיקות)",
  "check.state.failed": "לא עבר",
  "check.state.stale": "צריך בדיקה חדשה",
  "check.noneOn": "אף משימה עדיין לא פועלת.",

  "confirm.title": "לעצור משימות שלא הסתיימו?",
  "confirm.body":
    "ההפעלה תעצור {count, plural, one {משימה אחת שלא הסתיימה} two {שתי משימות שלא הסתיימו} other {# משימות שלא הסתיימו}}. קריאות שכבר נשלחו עשויות להסתיים ולחויב עליהן.",
  "confirm.go": "הפעלה ועצירת המשימות",
  "confirm.cancel": "ביטול",

  "advanced.summary": "מתקדם (למפתחים)",
  "advanced.intro":
    "למפתחים ולהגדרות חריגות. שינויים כאן עוקפים את הבדיקות המודרכות שלמעלה, אבל השרת עדיין אוכף את בדיקת האיכות ואת מגבלות ההוצאה.",
  "advanced.configTitle": "הגדרות (קריאה בלבד)",
  "advanced.configNote":
    "כל חיבור שומר את המפתח שלו בתא מוצפן משלו בשרת (מוצג כאן כ-COURSE_PROVIDER_…_API_KEY). אין צורך להקליד את השם הזה אף פעם. מפתח אף פעם אינו חלק מההגדרות.",
  "advanced.roleIds":
    "מזהי משימות: companion (מורה פרטי ללומדים), supervisor (מתכנן השיעורים), research (מאתר מקורות), reviewer (טיוטות משוב לתשובות), media (תמונות ווידאו). גרסת הגדרות {revision}.",
  "advanced.copy": "העתקה",
  "advanced.copied": "הועתק.",
  "advanced.editJson": "עריכה כ-JSON",
  "advanced.jsonLabel": "הגדרות ב-JSON",
  "advanced.saveJson": "שמירת ה-JSON",
  "advanced.jsonInvalid": "זה לא JSON תקין: {message}",
  "advanced.jsonPosition": "שורה {line}, עמודה {column}",
  "advanced.jsonSaved": "ההגדרות נשמרו והופעלו.",
  "advanced.jsonWaiting":
    "ההגדרות נשמרו כטיוטה. הן יופעלו אחרי בדיקת האיכות (ראו „בדיקת איכות”).",
  "advanced.limitsTitle": "מגבלות לכל בקשה",
  "advanced.limitCost": "עלות לכל בקשה (USD)",
  "advanced.limitTokens": "טוקנים לכל בקשה",
  "advanced.limitDeadline": "מועד אחרון (דקות)",
  "advanced.limitTimeout": "מגבלת זמן לכל קריאה (שניות)",
  "advanced.limitAttempts": "ניסיונות",
  "advanced.saveLimits": "שמירת המגבלות",
  "advanced.limitsSaved": "המגבלות נשמרו.",
  "advanced.limitsInvalid": "הזינו מספרים שלמים בטווח המותר.",
  "advanced.fallbackTitle": "גיבוי למנוי",
  "advanced.fallbackNone": "לא הוגדר חיבור מנוי.",
  "advanced.fallbackLabel": "אם המנוי {name} נגמר, להשתמש במפתח API במקומו",
  "advanced.fallbackKey": "מפתח ה-API לשימוש",
  "advanced.fallbackChoose": "בחרו חיבור",
  "advanced.saveFallback": "שמירת הגיבוי",
  "advanced.serviceKeysTitle": "מפתחות לשירותים אחרים",
  "advanced.youtube": "מפתח לחיפוש ב-YouTube",
  "advanced.youtubeHint": "מאפשר לצוות לחפש ב-YouTube מקורות לקורס.",
  "advanced.serviceSaved": "המפתח שמור",
  "advanced.serviceNotSaved": "לא הוגדר",
  "advanced.saveServiceKey": "שמירת המפתח",
  "advanced.removeServiceKey": "הסרת המפתח",
  "advanced.serviceKeyStored": "המפתח נשמר.",
  "advanced.serviceKeyRemoved": "המפתח הוסר.",
  "advanced.pricingRuleTitle": "מודלים בלי מחיר",
  "advanced.requirePricing": "לסרב לעבודה בתשלום עבור מודלים בלי מחיר",
  "advanced.requirePricingAck":
    "ידוע לי שבלי מחיר, כל קריאה מחויבת במלוא המגבלה לבקשה.",
  "advanced.saveRule": "שמירת הכלל",
  "advanced.ruleSaved": "הכלל נשמר.",
  "advanced.historyTitle": "היסטוריית ההגדרות",
  "advanced.historyEmpty": "עדיין אין תוצאות של בדיקות איכות או אישורים.",
  "advanced.historyResult": "{job}: הבדיקה {outcome} ב-{date}",
  "advanced.historyOverride": "{job}: אושר בלי בדיקה ב-{date}",
  "advanced.historyReason": "סיבה: {reason}",
  "advanced.fingerprint": "טביעת אצבע של הגרסה",
  "advanced.cli":
    "אפשר להריץ את הבדיקה משורת הפקודה עם npm run eval:agents בתיקייה services/api, ואז להעלות את הדוח עם POST …/provider-evals/results.",
  "advanced.outcome.passed": "עברה",
  "advanced.outcome.failed": "נכשלה",

  "err.stale":
    "מישהו אחר שינה את שירותי ה-AI מאז שפתחתם את הדף. טענו מחדש כדי לראות את השינויים שלו; הבחירות שלכם בחלק הזה נשמרות.",
  "err.forbidden":
    "אין לכם הרשאה לשנות את שירותי ה-AI. פנו לבעלים של סביבת העבודה.",
  "err.unavailable":
    "לא ניתן היה להגיע לשרת. השינויים שלכם עדיין כאן. נסו שוב.",
  "err.generic": "זה לא הצליח. נסו שוב; שום דבר לא השתנה.",
  "err.evalRequired":
    "המודלים האלה צריכים בדיקת איכות או אישור של הבעלים לפני ההפעלה.",
  "err.connectionInUse":
    "‏{jobs} משתמשים בחיבור הזה. בחרו להם מודלים אחרים קודם.",
  "err.budgetBelowUsage": "מגבלה לא יכולה להיות נמוכה ממה שכבר נוצל.",
  "err.consent": "לחצו על כפתור ההוצאה כדי לתת הסכמה.",
  "err.tooSmall":
    "המגבלה לכל בקשה קטנה מדי למודלים האלה. הגדילו אותה בחלק „מתקדם”.",
  "err.modelUnavailable":
    "המודל הזה כבר לא ברשימת המודלים של השירות. בחרו מודל אחר.",
  "err.contextTooSmall":
    "המודל הזה לא יכול לקבל מספיק טקסט עבור מתכנן השיעורים. בחרו מודל עם מגבלת קלט גדולה יותר.",
  "err.configInvalid": "ההגדרות לא תקינות. בדקו אותן ונסו שוב.",
  "err.secretField":
    "בהגדרות יש שדה שנראה כמו מפתח או סיסמה. מפתחות נשמרים בחלק „חיבורים”, אף פעם לא בהגדרות.",
  "err.summary": "יש בעיה",

  "readonly.body":
    "רק בעלים ומנהלים של סביבת העבודה יכולים לשנות את שירותי ה-AI. פנו לאחד מהם אם צריך לשנות משהו.",
  "readonly.demo": "זו גרסת ההדגמה. שירותי ה-AI מוגדרים בשרת מחובר.",
  "readonly.status.configured": "מוגדר",
  "readonly.status.absent": "לא מוגדר",
  "readonly.status.pending_review": "ממתין לבדיקה",
};

export const aiServicesMessages: Record<AiLocale, Record<AiKey, string>> = {
  en,
  he,
};

/** Unicode isolates for left-to-right text (ids, model names, key endings, money) in RTL text. */
const LRI = "⁦",
  PDI = "⁩";
export type MessageArgs = Record<string, string | number>;

/** Finds the matching closing brace of the `{` at `start`. */
function closing(text: string, start: number) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  throw new Error("Unbalanced message");
}
/** ICU subset: `{name}`, `{n, plural, =0 {…} one {…} two {…} other {…}}` with `#`. */
export function formatMessage(
  locale: AiLocale,
  message: string,
  args: MessageArgs = {},
): string {
  let out = "",
    i = 0;
  while (i < message.length) {
    const open = message.indexOf("{", i);
    if (open < 0) {
      out += message.slice(i);
      break;
    }
    out += message.slice(i, open);
    const end = closing(message, open),
      body = message.slice(open + 1, end),
      comma = body.indexOf(",");
    if (comma < 0) {
      const value = args[body.trim()];
      out += value === undefined ? `{${body}}` : String(value);
    } else {
      const name = body.slice(0, comma).trim(),
        rest = body.slice(comma + 1),
        type = rest.slice(0, rest.indexOf(",")).trim(),
        value = Number(args[name] ?? 0);
      if (type !== "plural") throw new Error("Unsupported message type");
      const branches = new Map<string, string>();
      let cursor = rest.indexOf(",") + 1;
      while (cursor < rest.length) {
        const brace = rest.indexOf("{", cursor);
        if (brace < 0) break;
        const selector = rest.slice(cursor, brace).trim(),
          stop = closing(rest, brace);
        branches.set(selector, rest.slice(brace + 1, stop));
        cursor = stop + 1;
      }
      const category = new Intl.PluralRules(locale).select(value),
        branch =
          branches.get(`=${value}`) ??
          branches.get(category) ??
          branches.get("other") ??
          "";
      out += formatMessage(
        locale,
        branch.replaceAll("#", new Intl.NumberFormat(locale).format(value)),
        args,
      );
    }
    i = end + 1;
  }
  return out;
}
export interface AiText {
  locale: AiLocale;
  dir: "ltr" | "rtl";
  t: (key: AiKey, args?: MessageArgs) => string;
  /** Wraps left-to-right text for use inside a translated sentence (only needed in RTL). */
  ltr: (value: string) => string;
  money: (microUsd: number) => string;
  date: (iso: string | Date) => string;
  list: (items: string[]) => string;
}
export function aiTranslator(locale: AiLocale): AiText {
  const messages = aiServicesMessages[locale];
  const dir = locale === "he" ? "rtl" : "ltr";
  const ltr = (value: string) => (dir === "rtl" ? LRI + value + PDI : value);
  return {
    locale,
    dir,
    ltr,
    t: (key, args) => formatMessage(locale, messages[key] ?? en[key], args),
    money: (microUsd) => {
      const usd = microUsd / 1000000,
        small = usd > 0 && usd < 0.01;
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: small ? 4 : 2,
        maximumFractionDigits: small ? 6 : 2,
      })
        .format(usd)
        .replace(/[‎‏]/g, "");
    },
    date: (value) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
        new Date(value),
      ),
    list: (items) =>
      new Intl.ListFormat(locale, {
        style: "long",
        type: "conjunction",
      }).format(items),
  };
}
/**
 * The page's locale until the admin app has the foundation's LocaleProvider: the document
 * language, or `?lang=he` for a preview.
 */
export function pageLocale(): AiLocale {
  if (typeof window === "undefined") return "en";
  const query = new URLSearchParams(window.location.search).get("lang");
  if (query === "he" || query === "en") return query;
  return document.documentElement.lang.toLowerCase().startsWith("he")
    ? "he"
    : "en";
}
