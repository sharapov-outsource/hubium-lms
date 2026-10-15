import { errorText, isMsg, type Msg, msg, renderMsg } from '@hubium/module-sdk';

/**
 * What an error says to people: a message (a key in the language packs, put in their
 * language where the error reaches them) or, until a text is given a key, English text.
 */
export type MsgOrText = string | Msg;

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

/**
 * An error for people. `message` and `fieldErrors` read in English (logs, API answers);
 * `in(locale)` gives them in a language.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details?: unknown;
  /** The message for people, when it has a key. */
  readonly msg?: Msg;
  /** Errors by field, as thrown. */
  readonly fieldMessages?: Record<string, MsgOrText[]>;

  constructor(
    code: AppErrorCode,
    message: MsgOrText,
    opts: {
      fieldErrors?: Record<string, MsgOrText[]>;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(String(message), { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.msg = isMsg(message) ? message : undefined;
    this.fieldMessages = opts.fieldErrors;
    this.details = opts.details;
  }

  get status(): number {
    return HTTP_STATUS[this.code];
  }

  /** Errors by field, in English. */
  get fieldErrors(): Record<string, string[]> | undefined {
    return this.fieldMessages && fieldsIn(this.fieldMessages, 'en');
  }

  /** The message and the errors by field in a language. */
  in(locale: string): { message: string; fieldErrors?: Record<string, string[]> } {
    return {
      message: renderMsg(this.msg ?? this.message, locale),
      fieldErrors: this.fieldMessages && fieldsIn(this.fieldMessages, locale),
    };
  }
}

function fieldsIn(fields: Record<string, MsgOrText[]>, locale: string) {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v.map((m) => renderMsg(m, locale))]),
  );
}

export class ForbiddenError extends AppError {
  constructor(message: MsgOrText = msg('errors.FORBIDDEN'), details?: unknown) {
    super('FORBIDDEN', message, { details });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  /** `what` names it in the English message (logs, API); people read "Not found". */
  constructor(what = 'Resource') {
    super('NOT_FOUND', `${what} not found`);
    this.name = 'NotFoundError';
  }

  override in(locale: string) {
    return { message: renderMsg(msg('errors.NOT_FOUND'), locale) };
  }
}

export class ValidationError extends AppError {
  constructor(fieldErrors: Record<string, MsgOrText[]>, message: MsgOrText = 'Validation failed') {
    super('VALIDATION', message, { fieldErrors });
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(message: MsgOrText) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

/** A service the request depends on (e.g. the virus scanner) cannot be reached. */
export class UnavailableError extends AppError {
  constructor(message: MsgOrText, cause?: unknown) {
    super('UNAVAILABLE', message, { cause });
    this.name = 'UnavailableError';
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * What an error says in a language, for a report people read later (an import, a task that
 * failed): an error for people translated, with its fields' errors when it has them; any
 * other error's own text, which tells an administrator what broke.
 */
export function describeError(e: unknown, locale: string): string {
  if (e instanceof AppError) {
    const r = e.in(locale);
    return r.fieldErrors ? Object.values(r.fieldErrors).flat().join('; ') : r.message;
  }
  return errorText(e, locale);
}
