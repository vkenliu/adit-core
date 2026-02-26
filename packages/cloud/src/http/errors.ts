/**
 * Typed error classes for cloud API operations.
 */

/** Authentication failure (401, expired token, revoked) */
export class CloudAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudAuthError";
  }
}

/** Network-level failure (timeout, DNS, connection refused) */
export class CloudNetworkError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "CloudNetworkError";
    this.cause = cause;
  }
}

/** Server returned a non-2xx response */
export class CloudApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "CloudApiError";
    this.status = status;
    this.body = body;
  }
}
