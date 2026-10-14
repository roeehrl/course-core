import { z } from "zod";

export const roles = [
  "owner",
  "admin",
  "author",
  "instructor",
  "reviewer",
  "learner",
  "observer",
] as const;
export type Role = (typeof roles)[number];
export const roleDescriptions: Record<Role, string> = {
  owner: "Everything, including other owners and admins",
  admin: "Course, policy, providers and non-privileged people",
  author: "Edits course drafts; no learner records",
  instructor: "Assigned learners' permitted evidence and extensions",
  reviewer: "Approves releases, content and evidence reviews",
  learner: "Studies enrolled courses only",
  observer: "Read-only course overview",
};
export const peopleSchema = z.object({
  actorRole: z.enum(roles),
  roles: z.array(z.enum(roles)),
  loginCodes: z.boolean().optional(),
  people: z
    .array(
      z.object({
        userId: z.string().uuid(),
        displayName: z.string().max(200),
        role: z.enum(roles),
        joinedAt: z.string().max(64),
        addedBy: z.string().max(200).nullable(),
        enrollments: z.number().int().nonnegative(),
        lastSignInAt: z.string().max(64).nullable(),
        self: z.boolean(),
        canChangeRole: z.boolean(),
        canRevoke: z.boolean(),
        canIssueSignIn: z.boolean(),
        loginName: z.string().max(128).nullable().optional(),
        hasPassword: z.boolean().optional(),
        mustChangePassword: z.boolean().optional(),
        canSetPassword: z.boolean().optional(),
      }),
    )
    .max(1000),
});
export type PeopleList = z.infer<typeof peopleSchema>;
export type Person = PeopleList["people"][number];
export const signInSchema = z.object({
  userId: z.string().uuid(),
  replayed: z.boolean(),
  signIn: z
    .object({
      code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      learnerUrl: z.string().max(2048),
      adminPath: z.string().max(100),
      expiresInMinutes: z.number().int().positive(),
    })
    .optional(),
  password: z
    .object({
      loginName: z.string().max(128),
      temporaryPassword: z.string().min(12).max(64),
      mustChangeOnNextSignIn: z.literal(true),
      adminPath: z.string().max(100),
      learnerUrl: z.string().max(2048),
    })
    .optional(),
});
export type SignInReceipt = z.infer<typeof signInSchema>;
export interface PeopleAdminPort {
  list(workspaceId: string, signal?: AbortSignal): Promise<PeopleList>;
  invite(
    workspaceId: string,
    input: { displayName: string; role: Role; loginName?: string },
    idempotencyKey: string,
  ): Promise<SignInReceipt>;
  setPassword(
    workspaceId: string,
    userId: string,
    input: { loginName?: string },
    idempotencyKey: string,
  ): Promise<SignInReceipt>;
  changeRole(
    workspaceId: string,
    userId: string,
    input: { role: Role; expectedRole: Role },
    idempotencyKey: string,
  ): Promise<unknown>;
  issueSignIn(
    workspaceId: string,
    userId: string,
    idempotencyKey: string,
  ): Promise<SignInReceipt>;
  revoke(
    workspaceId: string,
    userId: string,
    input: { expectedRole: Role; reason: string },
    idempotencyKey: string,
  ): Promise<unknown>;
}
const messages: Record<string, string> = {
  FORBIDDEN: "Only workspace owners and admins manage people.",
  ROLE_NOT_ASSIGNABLE:
    "Your role cannot make this change. Only owners manage owners and admins.",
  SELF_CHANGE_FORBIDDEN:
    "You cannot change or remove your own membership. Ask another owner.",
  STALE_ROLE:
    "This person's role changed since you loaded the list. Refresh and try again.",
  ROLE_UNCHANGED: "That is already their role.",
  SIGN_IN_NOT_ISSUABLE:
    "A sign-in code can only be issued for people invited into this workspace who have no other workspace access.",
  PASSWORD_NOT_SETTABLE:
    "A temporary password can only be set for people invited into this workspace who have no other workspace access.",
  LOGIN_NAME_REQUIRED: "Choose a username for this person.",
  LOGIN_NAME_TAKEN: "That username belongs to someone else. Choose another.",
  LOGIN_CODES_DISABLED: "One-time sign-in codes are turned off on this server.",
  MEMBER_NOT_FOUND: "This person is no longer a member. Refresh the list.",
  IDEMPOTENCY_CONFLICT:
    "A previous request with this retry key had different content. Refresh and try again.",
  INVALID_INPUT:
    "Check the name, username, role and reason, then try again. Usernames use 3–128 letters, digits and . _ @ + : -",
};
export class PeopleActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PeopleActionError";
  }
}
export function peopleErrorMessage(error: unknown) {
  const code = error instanceof PeopleActionError ? error.code : "";
  return (
    messages[code] ??
    "The people service is unavailable. No membership was changed."
  );
}
