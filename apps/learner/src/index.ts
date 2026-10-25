export { LearnerApp, type LearnerAppProps } from "./LearnerApp";
export { CourseRoadmap } from "./components/CourseRoadmap";
export { LessonFlow } from "./components/LessonFlow";
export { Companion } from "./components/Companion";
export { ProfileEditor } from "./components/ProfileEditor";
export { PlacementEntry } from "./components/PlacementEntry";
export type * from "./domain/types";
export { VisualBlock, type VisualBlockProps } from "./components/VisualBlock";
export {
  ReviewedMedia,
  type ReviewedMediaProps,
} from "./components/ReviewedMedia";
export { SourceLinks, type SourceLinksProps } from "./components/SourceLinks";
export {
  ConnectedCompanion,
  type ConnectedCompanionProps,
} from "./components/ConnectedCompanion";
export {
  CompanionDock,
  type CompanionDockProps,
} from "./components/CompanionDock";
export {
  createCompanionClient,
  companionJobLabel,
  companionCouldNotAnswer,
  companionReplyStalled,
  companionReplyUnavailable,
  type ContextualCompanionClient,
  type CompanionContext,
  type CompanionMessage,
  type CompanionReceipt,
} from "./client/companionClient";
export {
  createCourseApi,
  CourseApiError,
  type CourseApi,
  type ServerSnapshot,
  type Challenge,
  type Question,
} from "./client/apiClient";
export {
  safeHttpsUrl,
  youtubeVideoId,
  mediaAvailability,
} from "./connected/resources";

export { ConnectedHost, type ConnectedHostProps } from "./ConnectedHost";
export { SupervisionPanel } from './components/SupervisionPanel';
export { createSupervisionClient, type SupervisionClient, type SupervisorToolCall, type SupervisionPermission } from './client/supervisionClient';

export { CodeEditor, type CodeEditorProps } from "./components/CodeEditor";
export {
  MAX_CODE_BYTES,
  codeSubmissionError,
  utf8Bytes,
  type CodeQuestion,
} from "./connected/code";

export {
  EnrollmentPreview,
  type EnrollmentPreviewProps,
} from "./components/EnrollmentPreview";
export { ClosureSummary } from "./components/ClosureSummary";
export {
  createPolicyClient,
  createContinuationClient,
  parseContinuation,
  type ContinuationView,
  type PolicyBinding,
  type PolicyLevel,
  type EnrollmentPolicy,
  type ExtensionOffer,
  type ClosureReport,
  type CatalogCourse,
  type Enrollment,
} from "./client/policyClient";
