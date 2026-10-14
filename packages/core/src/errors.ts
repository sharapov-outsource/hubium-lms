export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const HTTP_STATUS: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  readonly details?: unknown;

  constructor(
    code: AppErrorCode,
    message: string,
    opts: { fieldErrors?: Record<string, string[]>; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.fieldErrors = opts.fieldErrors;
    this.details = opts.details;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: unknown) {
    super('FORBIDDEN', message, { details });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Resource') {
    super('NOT_FOUND', `${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(fieldErrors: Record<string, string[]>, message = 'Validation failed') {
    super('VALIDATION', message, { fieldErrors });
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

/** A service the request depends on (e.g. the virus scanner) cannot be reached. */
export class UnavailableError extends AppError {
  constructor(message: string, cause?: unknown) {
    super('UNAVAILABLE', message, { cause });
    this.name = 'UnavailableError';
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
