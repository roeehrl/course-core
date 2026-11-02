import type { FastifyInstance } from "fastify";
import type { Database } from "../../src/database.js";
import type { issueLoginCode } from "../../src/auth.js";
import type { notifyUser } from "../../src/notifications.js";
import type { replyDrafts } from "../../src/reply-drafts.js";
import { register as registerShell } from "./shell.js";
import { register as registerConversation } from "./conversation.js";
import { register as registerActions } from "./actions.js";
import { register as registerCredit } from "./credit.js";
import { register as registerChecks } from "./checks.js";
import { register as registerAsk } from "./ask.js";
import { register as registerContent } from "./content.js";
import { register as registerProfile } from "./profile.js";
import { register as registerNotify } from "./notify.js";
import { register as registerTheme } from "./theme.js";

/** Headers of a signed-in browser session for `app.inject` (cookie, CSRF token, origin). */
export type SessionHeaders = { origin: string; cookie: string; "x-csrf-token": string };

/**
 * What the browser test host (start.ts) gives the learner AI fixtures: the app before it listens,
 * the disposable database, the seeded workspaces and releases, and helpers. Each part of the
 * learner AI work registers its own `/test/<part>-…` routes in its own module, so no two of them
 * edit start.ts.
 */
export interface FixtureContext {
  app: FastifyInstance;
  db: Database;
  hostOrigin: string;
  issueLoginCode: typeof issueLoginCode;
  replyDrafts: typeof replyDrafts;
  notifyUser: typeof notifyUser;
  /** Enrollments whose companion reports "not_set_up". */
  companionOff: Set<string>;
  /** The ordering course ("Ordering values") and its workspace. */
  workspaceId: string;
  releaseId: string;
  /** The companion-context course and its workspace. */
  contextReleaseId: string;
  contextWorkspaceId: string;
  /** The Hebrew reading course and its workspace. */
  hebrewReleaseId: string;
  hebrewWorkspaceId: string;
  /** Signs a user in on the host: headers for `app.inject` requests as them. */
  signIn(userId: string): Promise<SessionHeaders>;
}

/** Registers every part's fixtures, once, before the host listens. */
export async function registerFixtures(ctx: FixtureContext) {
  for (const register of [registerShell, registerConversation, registerActions, registerCredit, registerChecks, registerAsk, registerContent, registerProfile, registerNotify, registerTheme])
    await register(ctx);
}
