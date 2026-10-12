import type { KeyValueStorage, RequestContext } from "../src/domain/types";
import { demoCourse, demoAnswers } from "../src/data/demoCourse";
import { createDemoClient } from "../src/client/demoClient";
export function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}
export function demo(storage = memoryStorage()) {
  return createDemoClient(
    demoCourse,
    {
      answers: demoAnswers,
      placement: { answer: "ascending", lessonId: "order" },
    },
    storage,
    "test-demo",
  );
}
let sequence = 0;
export const context = (revision = "0"): RequestContext => ({
  courseId: demoCourse.id,
  courseVersion: demoCourse.version,
  expectedRevision: revision,
  idempotencyKey: `test-${++sequence}`,
});
