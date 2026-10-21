import { z } from "zod";
import { englishTranslator, type MessageKey, type Translate } from "../i18n";

/**
 * Safe editing of a draft release: the structured chapter and lesson editor works on the
 * manifest in memory (pure functions below), the server checks a manifest before it is saved,
 * previews a draft as representative synthetic learners, and analyses who publishing affects.
 */
const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const shortId = z.string().max(200);
const kindCounts = z.object({ added: count, removed: count, changed: count });

export const manifestCheckSchema = z.object({
  valid: z.boolean(),
  issues: z
    .array(z.object({ code: z.string().max(80), path: z.string().max(300) }))
    .max(50),
  identityMatches: z.boolean().nullable(),
  summary: z
    .object({
      chapters: count,
      episodes: count,
      assessments: count,
      objectives: count,
    })
    .nullable(),
  digest: digest.nullable(),
  runtime: z
    .object({ ready: z.boolean(), code: z.string().max(80).nullable() })
    .nullable(),
  changes: z
    .object({
      identical: z.boolean(),
      changes: count,
      kinds: z.record(
        z.string(),
        z.object({
          added: z.array(shortId).max(2000),
          removed: z.array(shortId).max(2000),
          changed: z.array(shortId).max(2000),
          unchanged: count,
        }),
      ),
    })
    .nullable(),
});
export type ManifestCheck = z.infer<typeof manifestCheckSchema>;

export const PREVIEW_PROFILES = [
  "new_learner",
  "placed_out",
  "first_chapter_done",
  "nearly_finished",
] as const;
const previewBlockSchema = z.object({
  id: shortId,
  type: z.enum(["text", "assessment", "visual", "media", "activity"]),
  excerpt: z.string().max(400).nullable().optional(),
  truncated: z.boolean().optional(),
  assessmentId: shortId.optional(),
  itemType: z.string().max(40).nullable().optional(),
});
export const learnerPreviewSchema = z.object({
  source: z.enum(["saved", "unsaved"]),
  syntheticLearners: z.literal(true),
  course: z.object({
    id: shortId,
    version: z.string().max(100),
    title: z.string().max(400),
    locale: z.string().max(40),
  }),
  outline: z
    .array(
      z.object({
        id: shortId,
        title: z.string().max(400),
        episodes: z
          .array(
            z.object({
              id: shortId,
              title: z.string().max(400),
              requirement: z.enum(["required", "optional"]),
              gateId: shortId.nullable(),
              blocks: count,
            }),
          )
          .max(500),
      }),
    )
    .max(500),
  profiles: z
    .array(
      z.object({
        profile: z.enum(PREVIEW_PROFILES),
        complete: z.boolean(),
        counts: z.object({
          completed: count,
          placed: count,
          available: count,
          locked: count,
        }),
        lessons: z
          .array(
            z.object({
              episodeId: shortId,
              chapterId: shortId.nullable(),
              requirement: z.enum(["required", "optional"]),
              status: z.enum(["completed", "placed", "available", "locked"]),
            }),
          )
          .max(5000),
        next: z
          .object({
            episodeId: shortId,
            title: z.string().max(400),
            chapterId: shortId.nullable(),
            blocks: z.array(previewBlockSchema).max(500),
          })
          .nullable(),
      }),
    )
    .max(PREVIEW_PROFILES.length),
});
export type LearnerPreview = z.infer<typeof learnerPreviewSchema>;

const releaseRef = z.object({
  id: z.string().uuid(),
  version: z.string().max(100),
  digest: z.string().max(128),
});
export const publishImpactSchema = z.object({
  impact: z.object({
    from: releaseRef.nullable(),
    to: releaseRef,
    contentChanges: count.nullable(),
    kinds: z.record(z.string(), kindCounts).nullable(),
    changedOrRemovedEpisodes: z.array(shortId).max(200),
    changedOrRemovedItems: z.array(shortId).max(200),
    learnersPinnedToActive: count,
    learnersMidwayInChangedLessons: count,
    enrollmentsLast30Days: count,
    defectiveItemsFixed: z.array(shortId).max(2000),
    defectiveItemsCarriedOver: z.array(shortId).max(2000),
    newLearnersGet: z.string().max(100),
    existingLearnersMove: z.literal(false),
  }),
  impactDigest: digest,
  confirmationRequired: z.boolean(),
});
export type PublishImpact = z.infer<typeof publishImpactSchema>;

export interface ReleaseEditingPort {
  /** Validates a manifest as saving would, without saving it. */
  check(
    courseId: string,
    releaseId: string,
    manifest: unknown,
    signal?: AbortSignal,
  ): Promise<ManifestCheck>;
  /** The saved release, or an unsaved manifest, as synthetic representative learners see it. */
  preview(
    courseId: string,
    releaseId: string,
    manifest?: unknown,
    signal?: AbortSignal,
  ): Promise<LearnerPreview>;
  /** Who publishing this approved draft affects, with the digest to confirm. */
  publishImpact(
    courseId: string,
    releaseId: string,
    signal?: AbortSignal,
  ): Promise<PublishImpact>;
}
export class ReleaseEditingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReleaseEditingError";
  }
}
const ERROR_CODES = new Set([
  "FORBIDDEN",
  "INVALID_REQUEST",
  "INVALID_COURSE",
  "COURSE_IDENTITY_MISMATCH",
  "PUBLISHED_RELEASE_IMMUTABLE",
  "RELEASE_NOT_FOUND",
]);
export const releaseEditingErrorMessage = (
  error: unknown,
  t: Translate = englishTranslator().t,
) => {
  const code = error instanceof ReleaseEditingError ? error.code : "";
  return ERROR_CODES.has(code)
    ? t(`releaseEditing.error.${code}` as MessageKey)
    : t("releaseEditing.error.unknown");
};

// ---------------------------------------------------------------- structured editing

export interface EditableBlock {
  id: string;
  type: string;
  markdown?: string;
  [key: string]: unknown;
}
export interface EditableEpisode {
  id: string;
  title: string;
  objectiveIds: string[];
  blocks: EditableBlock[];
  requirement?: "required" | "optional";
  gateId?: string;
  [key: string]: unknown;
}
export interface EditableChapter {
  id: string;
  title: string;
  summary?: string;
  episodes: EditableEpisode[];
  [key: string]: unknown;
}
export interface EditableManifest {
  chapters: EditableChapter[];
  objectives: { id: string; description: string }[];
  [key: string]: unknown;
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** The manifest when it has the chapter and lesson shape the editor needs; otherwise null and
 * staff edit the whole file instead. */
export function asEditable(manifest: unknown): EditableManifest | null {
  if (!isObject(manifest) || !Array.isArray(manifest.chapters)) return null;
  if (!Array.isArray(manifest.objectives)) return null;
  const ok = manifest.chapters.every(
    (chapter) =>
      isObject(chapter) &&
      typeof chapter.id === "string" &&
      typeof chapter.title === "string" &&
      Array.isArray(chapter.episodes) &&
      chapter.episodes.every(
        (episode) =>
          isObject(episode) &&
          typeof episode.id === "string" &&
          typeof episode.title === "string" &&
          Array.isArray(episode.objectiveIds) &&
          Array.isArray(episode.blocks) &&
          episode.blocks.every(
            (block) =>
              isObject(block) &&
              typeof block.id === "string" &&
              typeof block.type === "string",
          ),
      ),
  );
  return ok ? (manifest as EditableManifest) : null;
}
/** Every id the manifest already uses at any depth, so a new one never collides. */
function usedIds(manifest: EditableManifest) {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (isObject(value)) {
      if (typeof value.id === "string") ids.add(value.id);
      Object.values(value).forEach(walk);
    }
  };
  walk(manifest);
  return ids;
}
/** A course id (lowercase letter first, then letters, digits, dot, colon, dash or underscore)
 * from a title; titles in other scripts fall back to `fallback`. */
export function newId(
  title: string,
  fallback: string,
  manifest: EditableManifest,
) {
  const taken = usedIds(manifest);
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const base = /^[a-z]/.test(slug) ? slug : fallback;
  let id = base,
    n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}
const clone = (manifest: EditableManifest): EditableManifest =>
  structuredClone(manifest);
const move = <T>(list: T[], index: number, delta: number) => {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  return next;
};
function findEpisode(manifest: EditableManifest, episodeId: string) {
  for (const chapter of manifest.chapters) {
    const index = chapter.episodes.findIndex((e) => e.id === episodeId);
    if (index >= 0)
      return { chapter, index, episode: chapter.episodes[index]! };
  }
  return null;
}
type Edit = (manifest: EditableManifest) => void;
const edit = (manifest: EditableManifest, change: Edit) => {
  const next = clone(manifest);
  change(next);
  return next;
};
/** A new lesson: required, on the course's first objective, with one empty text block. */
function newEpisode(
  manifest: EditableManifest,
  title: string,
  objectiveId?: string,
): EditableEpisode {
  const id = newId(title, "lesson", manifest);
  return {
    id,
    title,
    objectiveIds: [objectiveId ?? manifest.objectives[0]?.id ?? ""].filter(
      Boolean,
    ),
    blocks: [{ id: `${id}-text`, type: "text", markdown: "" }],
  };
}
export const chapterEdits = {
  add: (manifest: EditableManifest, title: string, lessonTitle: string) =>
    edit(manifest, (m) => {
      const id = newId(title, "chapter", m);
      const placeholder: EditableChapter = { id, title, episodes: [] };
      m.chapters.push(placeholder);
      placeholder.episodes.push(newEpisode(m, lessonTitle));
    }),
  rename: (manifest: EditableManifest, chapterId: string, title: string) =>
    edit(manifest, (m) => {
      const chapter = m.chapters.find((c) => c.id === chapterId);
      if (chapter) chapter.title = title;
    }),
  summary: (manifest: EditableManifest, chapterId: string, summary: string) =>
    edit(manifest, (m) => {
      const chapter = m.chapters.find((c) => c.id === chapterId);
      if (!chapter) return;
      if (summary.trim()) chapter.summary = summary;
      else delete chapter.summary;
    }),
  move: (manifest: EditableManifest, chapterId: string, delta: number) =>
    edit(manifest, (m) => {
      m.chapters = move(
        m.chapters,
        m.chapters.findIndex((c) => c.id === chapterId),
        delta,
      );
    }),
  remove: (manifest: EditableManifest, chapterId: string) =>
    edit(manifest, (m) => {
      m.chapters = m.chapters.filter((c) => c.id !== chapterId);
    }),
};
export const episodeEdits = {
  add: (manifest: EditableManifest, chapterId: string, title: string) =>
    edit(manifest, (m) => {
      m.chapters
        .find((c) => c.id === chapterId)
        ?.episodes.push(newEpisode(m, title));
    }),
  rename: (manifest: EditableManifest, episodeId: string, title: string) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (found) found.episode.title = title;
    }),
  requirement: (
    manifest: EditableManifest,
    episodeId: string,
    requirement: "required" | "optional",
  ) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (!found) return;
      // Omission means required, so a required lesson keeps the author's file unchanged.
      if (requirement === "optional") found.episode.requirement = "optional";
      else delete found.episode.requirement;
    }),
  objectives: (
    manifest: EditableManifest,
    episodeId: string,
    objectiveIds: string[],
  ) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (found) found.episode.objectiveIds = [...objectiveIds];
    }),
  move: (manifest: EditableManifest, episodeId: string, delta: number) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (found)
        found.chapter.episodes = move(
          found.chapter.episodes,
          found.index,
          delta,
        );
    }),
  /** Moves a lesson to the end of another chapter. */
  toChapter: (
    manifest: EditableManifest,
    episodeId: string,
    chapterId: string,
  ) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId),
        target = m.chapters.find((c) => c.id === chapterId);
      if (!found || !target || found.chapter === target) return;
      found.chapter.episodes.splice(found.index, 1);
      target.episodes.push(found.episode);
    }),
  remove: (manifest: EditableManifest, episodeId: string) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (found) found.chapter.episodes.splice(found.index, 1);
    }),
};
export const blockEdits = {
  text: (
    manifest: EditableManifest,
    episodeId: string,
    blockId: string,
    markdown: string,
  ) =>
    edit(manifest, (m) => {
      const block = findEpisode(m, episodeId)?.episode.blocks.find(
        (b) => b.id === blockId,
      );
      if (block?.type === "text") block.markdown = markdown;
    }),
  addText: (manifest: EditableManifest, episodeId: string) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (!found) return;
      found.episode.blocks.push({
        id: newId(`${episodeId}-text`, "text", m),
        type: "text",
        markdown: "",
      });
    }),
  move: (
    manifest: EditableManifest,
    episodeId: string,
    blockId: string,
    delta: number,
  ) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (!found) return;
      found.episode.blocks = move(
        found.episode.blocks,
        found.episode.blocks.findIndex((b) => b.id === blockId),
        delta,
      );
    }),
  remove: (manifest: EditableManifest, episodeId: string, blockId: string) =>
    edit(manifest, (m) => {
      const found = findEpisode(m, episodeId);
      if (found)
        found.episode.blocks = found.episode.blocks.filter(
          (b) => b.id !== blockId,
        );
    }),
};
/** Problems the editor can name before asking the server: an empty title, a chapter without
 * lessons, a lesson without an objective or content. The server check covers everything else. */
export function localProblems(manifest: EditableManifest) {
  const problems: { code: string; id: string }[] = [];
  for (const chapter of manifest.chapters) {
    if (!chapter.title.trim())
      problems.push({ code: "chapter_title", id: chapter.id });
    if (!chapter.episodes.length)
      problems.push({ code: "chapter_empty", id: chapter.id });
    for (const episode of chapter.episodes) {
      if (!episode.title.trim())
        problems.push({ code: "lesson_title", id: episode.id });
      if (!episode.objectiveIds.length)
        problems.push({ code: "lesson_objective", id: episode.id });
      if (!episode.blocks.length)
        problems.push({ code: "lesson_empty", id: episode.id });
    }
  }
  if (!manifest.chapters.length)
    problems.push({ code: "course_empty", id: "" });
  return problems;
}
