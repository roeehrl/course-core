/** Presentation contracts. A production adapter must map the released SDK into these
 * view models; components never import a course bundle or decide credited progress. */
export type Requirement = "required" | "optional";
export type Step = {
  id: string;
  title: string;
  requirement: Requirement;
  eyebrow: string;
  heading: string;
  body: string;
  companion: { idea: string; hint: string };
} & (
  | {
      kind: "reading";
      diagram?: { label: string; values: number[]; caption: string };
    }
  | { kind: "choice"; options: { id: string; label: string }[] }
  | { kind: "reflection"; prompt: string; placeholder: string }
);
export interface Lesson {
  id: string;
  title: string;
  description: string;
  minutes: number;
  requirement: Requirement;
  /** Added to this learner's course only, after the lesson it remediates. */
  personal?: boolean;
  steps: Step[];
}
export interface Course {
  id: string;
  version: string;
  title: string;
  /** Author-provided tagline; hosts never invent one. */
  subtitle?: string;
  description: string;
  /** Optional roadmap stages (SDK `stages`) that group sections. */
  stages?: { id: string; title: string; summary?: string }[];
  sections: {
    id: string;
    title: string;
    description: string;
    /** SDK chapter roadmap metadata; none of it is hard-coded by the host. */
    stageId?: string;
    subtitle?: string;
    iconAsset?: string;
    lessonIds: string[];
  }[];
  lessons: Lesson[];
  placement?: {
    title: string;
    description: string;
    question: string;
    options: { id: string; label: string }[];
  };
}
export type LessonStatus = "available" | "locked" | "completed" | "placed";
export interface LessonProgress {
  status: LessonStatus;
  /** The lesson's checkpoint is waiting for a staff review. */
  underReview?: boolean;
  reason?: string;
  completedStepIds: string[];
}
export interface Profile {
  displayName: string;
  goal: string;
  pace: "gentle" | "steady" | "focused";
}
export interface LearnerSnapshot {
  revision: string;
  mode: "demo" | "connected";
  profile: Profile;
  lessons: Record<string, LessonProgress>;
}
export interface RequestContext {
  courseId: string;
  courseVersion: string;
  expectedRevision: string;
  idempotencyKey: string;
}
export interface MutationResult {
  snapshot: LearnerSnapshot;
  feedback: { outcome: "accepted" | "retry"; message: string };
  receipt: { id: string; authority: "demo" | "server" };
}
/** All gate/credit decisions come back from the adapter. Server implementations
 * must authenticate, validate evidence/version/revision and deduplicate retries. */
export interface LearnerClient {
  load(): Promise<LearnerSnapshot>;
  submitStep(
    request: RequestContext & {
      lessonId: string;
      stepId: string;
      answer?: string;
    },
  ): Promise<MutationResult>;
  requestPlacement(
    request: RequestContext & { answer: string },
  ): Promise<MutationResult>;
  saveProfile(
    request: RequestContext & { profile: Profile },
  ): Promise<MutationResult>;
}
export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
export type Route =
  | { screen: "roadmap" }
  | { screen: "lesson"; lessonId: string; stepId: string };
export interface LocalSession {
  schema: 1;
  route: Route;
  drafts: Record<string, string>;
  notes: Record<string, string>;
}
