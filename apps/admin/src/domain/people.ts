import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

export const roles = [
  "owner",
  "admin",
  "author",
  "instructor",
  "reviewer",
  "learner",
  "observer",
  "support_observer",
  "service",
  "course_scoped",
] as const;
export type Role = (typeof roles)[number];
/** The role's name in the active locale, in words ("Support observer", not the role code). */
export const roleLabel = (role: Role, t: Translate = englishTranslator().t) =>
  t(`people.role.${role}` as MessageKey);
export const roleDescription = (
  role: Role,
  t: Translate = englishTranslator().t,
) => t(`people.roleDescription.${role}` as MessageKey);
export const grantableRoles = [
  "author",
  "instructor",
  "reviewer",
  "observer",
  "support_observer",
] as const;
export type GrantableRole = (typeof grantableRoles)[number];
export const courseGrantSchema = z.object({
  grantId: z.string().uuid(),
  catalogId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(grantableRoles),
  reasonCode: z.string().max(64),
  createdAt: z.string().max(64),
  expiresAt: z.string().max(64),
  revokedAt: z.string().max(64).nullable(),
  revokeReasonCode: z.string().max(64).nullable(),
  state: z.enum(["active", "expired", "revoked"]),
});
export type CourseGrant = z.infer<typeof courseGrantSchema>;
export const courseGrantsSchema = z.object({
  grants: z.array(courseGrantSchema).max(1000),
});
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
  /** Course grants for course_scoped members. Absent on clients that do not support them. */
  grants?(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof courseGrantsSchema>>;
  grant?(
    workspaceId: string,
    input: {
      userId: string;
      catalogId: string;
      role: GrantableRole;
      expiresAt: string;
      reasonCode: string;
    },
    idempotencyKey: string,
  ): Promise<CourseGrant>;
  revokeGrant?(
    workspaceId: string,
    grantId: string,
    reasonCode: string,
    idempotencyKey: string,
  ): Promise<CourseGrant>;
}
/** Characters a username may contain besides letters and digits; not translated. */
export const LOGIN_NAME_SYMBOLS = ". _ @ + : -";
export class PeopleActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PeopleActionError";
  }
}
export function peopleErrorMessage(
  error: unknown,
  t: Translate = englishTranslator().t,
) {
  const code = error instanceof PeopleActionError ? error.code : "";
  const key = `people.error.${code}` as MessageKey;
  return code && englishTranslator().has(key)
    ? t(key, { symbols: LOGIN_NAME_SYMBOLS })
    : t("people.error.unavailable");
}
