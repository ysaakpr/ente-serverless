/**
 * Museum's error model, ported exactly (src: server/ente/errors.go +
 * pkg/utils/handler/handler.go).
 *
 * Two families:
 *  - ApiError: serialized as {"code","message"} with its own HTTP status.
 *  - Sentinel errors: mapped to a bare HTTP status with `{}` body.
 */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message = '',
  ) {
    super(message || code);
  }

  body(): { code: string; message: string } {
    return { code: this.code, message: this.code === this.message ? '' : this.message };
  }
}

/** Sentinel errors — museum returns bare `{}` with the mapped status. */
export class SentinelError extends Error {
  constructor(
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

// Sentinels (handler.go httpStatusCode mapping)
export const errNotFound = () => new SentinelError(404, 'not found');
export const errBadRequestSentinel = () => new SentinelError(400, 'bad request');
export const errTooManyBadRequest = () => new SentinelError(429, 'too many bad request');
export const errPermissionDenied = () => new SentinelError(403, 'insufficient permissions');
export const errIncorrectOTT = () => new SentinelError(401, 'incorrect OTT');
export const errInvalidPassword = () => new SentinelError(401, 'invalid password');
export const errAuthenticationRequired = () => new SentinelError(401, 'authentication required');
export const errExpiredOTT = () => new SentinelError(410, 'no active OTT');
export const errStorageLimitExceeded = () => new SentinelError(426, 'storage Limit exceeded');
export const errFileTooLarge = () => new SentinelError(413, 'file too large');
export const errBatchSizeTooLarge = () => new SentinelError(413, 'batch size greater than API limit');

// Structured ApiErrors (ente/errors.go)
export const badRequest = (message = 'BAD_REQUEST') => new ApiError('BAD_REQUEST', 400, message);
export const userAlreadyRegistered = () =>
  new ApiError('USER_ALREADY_REGISTERED', 409, 'User is already registered');
export const userNotRegistered = () =>
  new ApiError('USER_NOT_REGISTERED', 404, 'User is not registered');
export const userSignupIncomplete = () =>
  new ApiError('USER_SIGNUP_INCOMPLETE', 404, 'User signup is incomplete');
export const tooManyUnverifiedSessions = () =>
  new ApiError('TOO_MANY_UNVERIFIED_SESSIONS', 429);
export const sessionAlreadyVerified = () => new ApiError('SESSION_ALREADY_VERIFIED', 410);
export const tooManyWrongAttempts = () => new ApiError('TOO_MANY_WRONG_ATTEMPTS', 410);
export const notFoundError = (message = '') => new ApiError('NOT_FOUND', 404, message);
export const collectionNotEmpty = () =>
  new ApiError('COLLECTION_NOT_EMPTY', 409, 'The collection is not empty');
export const fileNotFoundInAlbum = () =>
  new ApiError('FILE_NOT_FOUND_IN_ALBUM', 404, 'File is either deleted or moved to different collection');
export const favoritesAlreadyExists = () =>
  new SentinelError(500, 'favorites collection already exists'); // museum: plain error -> 500
export const conflictError = (message: string) => new ApiError('CONFLICT', 409, message);
/**
 * srpUserID is claimed by another account. Museum leans on a UNIQUE constraint
 * on srp_users.srp_user_id and does not handle the violation, so the driver
 * error surfaces as a bare 500 — CAPTURED 2026-08-17, both on /users/srp/complete
 * and /users/srp/update (D38). Reproduced rather than "improved" to 409, same
 * call as `favoritesAlreadyExists` above: a legitimate client never sees it
 * (srpUserID is a fresh uuid4), so parity costs nothing and buys exactness.
 */
export const srpUserIdTaken = () => new SentinelError(500, 'srpUserID already registered');
/** Museum: /users/srp/complete is first-time-only; a configured account gets this. */
export const srpSetupAlreadyComplete = () => badRequest('SRP setup already complete');
