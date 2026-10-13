export class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string = code,
    /** Learner-safe facts about what is missing; never answers, keys or private data. */
    public readonly details?: Record<string, unknown>) {
    super(message);
  }
}
export function requireCondition(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new ApiError(status, code);
}
