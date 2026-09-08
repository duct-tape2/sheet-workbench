export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const unavailable = (
  message = "The server database is not configured.",
) => new HttpError(503, "DATABASE_UNAVAILABLE", message);

export const setupNeeded = (message: string) =>
  new HttpError(503, "CONFIGURATION_REQUIRED", message);

export const forbidden = (
  message = "You do not have permission to perform this action.",
) => new HttpError(403, "FORBIDDEN", message);

export const unauthorized = () =>
  new HttpError(401, "UNAUTHENTICATED", "Sign in is required.");

export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, "CONFLICT", message, details);
