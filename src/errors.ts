export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function invariant(condition: unknown, error: AppError): asserts condition {
  if (!condition) throw error;
}
