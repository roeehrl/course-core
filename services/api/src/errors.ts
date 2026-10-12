export class ApiError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string = code) {
    super(message);
  }
}
export function requireCondition(value: unknown, code: string, status = 400): asserts value {
  if (!value) throw new ApiError(status, code);
}
