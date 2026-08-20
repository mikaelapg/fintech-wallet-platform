/**
 * Domain errors are mapped to RFC 9457 "problem details" responses by the
 * global error handler, so every failure has a stable machine-readable code.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  validation: (details: unknown) =>
    new AppError("VALIDATION_ERROR", "Request validation failed", 400, details),
  unauthorized: () => new AppError("UNAUTHORIZED", "Authentication required", 401),
  invalidCredentials: () => new AppError("INVALID_CREDENTIALS", "Invalid email or password", 401),
  notFound: (resource: string) => new AppError("NOT_FOUND", `${resource} not found`, 404),
  emailTaken: () => new AppError("EMAIL_TAKEN", "Email is already registered", 409),
  insufficientFunds: () => new AppError("INSUFFICIENT_FUNDS", "Insufficient balance", 422),
  selfTransfer: () => new AppError("SELF_TRANSFER", "Cannot transfer to your own account", 422),
  idempotencyKeyRequired: () =>
    new AppError("IDEMPOTENCY_KEY_REQUIRED", "Header Idempotency-Key (UUID) is required", 400),
  idempotencyConflict: () =>
    new AppError(
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency-Key was already used with a different payload",
      422,
    ),
  requestInProgress: () =>
    new AppError("REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is in progress", 409),
};
