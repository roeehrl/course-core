// Starts the Course Core API in the Compose stack. Before the API's own startup it copies the
// course files the operator listed (code fixture registries, teaching verifiers) from the
// read-only host directory mounted at /course-files into a private in-memory directory, owner-only
// and owned by the API user as the API requires, and names the copies in CODE_FIXTURE_FILES and
// TEACHING_VERIFIER_FILES. Names are plain file names inside that directory, never paths.
import { constants } from 'node:fs';
import { chmod, mkdir, open, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 4 * 1024 * 1024;
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class CourseFilesError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

/** Parses a comma-separated list of course file names; empty means none. */
export function courseFileNames(value, variable) {
  const names = String(value ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (names.length > 20) throw new CourseFilesError('too_many_course_files', variable);
  for (const name of names) if (!FILE_NAME.test(name) || name === '.' || name === '..') throw new CourseFilesError('invalid_course_file_name', variable);
  if (new Set(names).size !== names.length) throw new CourseFilesError('duplicate_course_file_name', variable);
  return names;
}

/** Copies one listed file (a regular file, not a link, at most 4 MiB) into the private directory. */
async function copyPrivate(source, target, name) {
  let handle;
  try { handle = await open(path.join(source, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new CourseFilesError(error.code === 'ENOENT' ? 'course_file_missing' : error.code === 'ELOOP' ? 'course_file_is_a_link' : 'course_file_unreadable', name); }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new CourseFilesError('course_file_not_regular', name);
    if (info.size > MAX_BYTES) throw new CourseFilesError('course_file_too_large', name);
    const bytes = await handle.readFile();
    const file = path.join(target, name);
    // A copy left by an earlier start of this container is replaced, never written through.
    await rm(file, { force: true });
    await writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
    return file;
  } finally { await handle.close(); }
}

/** Prepares the listed course files and returns the API environment variables naming the copies. */
export async function prepareCourseFiles(env, { source = '/course-files', target = '/run/course-files' } = {}) {
  for (const raw of ['CODE_FIXTURE_FILES', 'TEACHING_VERIFIER_FILES'])
    if (env[raw]) throw new CourseFilesError('use_course_file_names', raw);
  const fixtures = courseFileNames(env.COURSE_CODE_FIXTURES, 'COURSE_CODE_FIXTURES');
  const verifiers = courseFileNames(env.COURSE_TEACHING_VERIFIERS, 'COURSE_TEACHING_VERIFIERS');
  if (fixtures.some(name => verifiers.includes(name))) throw new CourseFilesError('duplicate_course_file_name', 'COURSE_TEACHING_VERIFIERS');
  if (!fixtures.length && !verifiers.length) return {};
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  const result = {};
  if (fixtures.length) result.CODE_FIXTURE_FILES = JSON.stringify(await Promise.all(fixtures.map(name => copyPrivate(source, target, name))));
  if (verifiers.length) result.TEACHING_VERIFIER_FILES = JSON.stringify(await Promise.all(verifiers.map(name => copyPrivate(source, target, name))));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    Object.assign(process.env, await prepareCourseFiles(process.env));
  } catch (error) {
    // Fixed codes and the variable or file name only; never file contents.
    process.stderr.write(`${JSON.stringify({ event: 'startup.course_files_failed', code: error instanceof CourseFilesError ? error.code : 'course_files_failed', ...(error?.detail ? { name: error.detail } : {}) })}\n`);
    process.exit(78);
  }
  await import(pathToFileURL(process.env.COURSE_API_ENTRY ?? '/app/services/api/dist/main.js').href);
}
