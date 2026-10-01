import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Phase 6.2 — one stable error vocabulary for the wallet and notify paths
 * (the Passlet/Passmint "typed errors with a stable `.code`" pattern, Part 4).
 *
 * Before this, a failed Google call surfaced in the UI and in
 * `NotificationLog.error` as whatever string the HTTP client happened to
 * produce — `Request failed with status code 403`. That is not a cause, and
 * it is not something a dashboard can branch on. A `ServiceError` carries a
 * code that never changes and a one-line cause a human can act on.
 */
export type ErrorCode =
  | 'WALLET_CREDENTIALS_MISSING'
  | 'WALLET_CALLBACK_UNSAFE'
  | 'WALLET_PERMISSION_DENIED'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_CLASS_CONFLICT'
  | 'WALLET_RATE_LIMITED'
  | 'WALLET_REJECTED'
  | 'WALLET_UNAVAILABLE'
  | 'WHATSAPP_NOT_CONFIGURED'
  | 'WHATSAPP_SEND_FAILED'
  | 'WHATSAPP_NUMBER_INVALID'
  | 'TEMPLATE_INVALID';

/** HTTP status each code maps to when it reaches a controller boundary. */
const STATUS: Record<ErrorCode, number> = {
  WALLET_CREDENTIALS_MISSING: HttpStatus.INTERNAL_SERVER_ERROR,
  WALLET_CALLBACK_UNSAFE: HttpStatus.BAD_REQUEST,
  WALLET_PERMISSION_DENIED: HttpStatus.BAD_GATEWAY,
  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  WALLET_CLASS_CONFLICT: HttpStatus.CONFLICT,
  WALLET_RATE_LIMITED: HttpStatus.SERVICE_UNAVAILABLE,
  WALLET_REJECTED: HttpStatus.BAD_GATEWAY,
  WALLET_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  WHATSAPP_NOT_CONFIGURED: HttpStatus.SERVICE_UNAVAILABLE,
  WHATSAPP_SEND_FAILED: HttpStatus.BAD_GATEWAY,
  WHATSAPP_NUMBER_INVALID: HttpStatus.BAD_REQUEST,
  TEMPLATE_INVALID: HttpStatus.BAD_REQUEST,
};

/**
 * Deliberately an HttpException: every controller in this codebase already
 * ends its catch with `if (error instanceof HttpException) throw error;`, so
 * extending it means a typed error reaches the client with its own code and
 * status through paths that would otherwise flatten it into a bare 500 —
 * without editing a single one of those catch blocks, and without a filter.
 */
export class ServiceError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    /** One line, written for the admin reading it — not for a log grep. */
    message: string,
    /** The original failure, kept for the server log only. */
    readonly sourceError?: unknown,
  ) {
    super(
      { success: false, code, error: message, message },
      STATUS[code] ?? HttpStatus.INTERNAL_SERVER_ERROR,
    );
    this.name = 'ServiceError';
    this.message = message;
  }
}

/**
 * Turns whatever the Google Wallet REST client threw into a typed error.
 * Already-typed errors pass straight through, so wrapping twice is safe.
 */
export function walletError(err: any, context: string): ServiceError {
  if (err instanceof ServiceError) return err;

  const status: number | undefined = err?.response?.status;
  const detail =
    err?.response?.data?.error?.message || err?.message || String(err);

  if (status === 401 || status === 403)
    return new ServiceError(
      'WALLET_PERMISSION_DENIED',
      `Google Wallet rejected these credentials (${context}). Check the service account's issuer permissions.`,
      err,
    );
  if (status === 404)
    return new ServiceError(
      'WALLET_NOT_FOUND',
      `Google Wallet has no such class or object (${context}).`,
      err,
    );
  if (status === 409)
    return new ServiceError(
      'WALLET_CLASS_CONFLICT',
      `Google Wallet already has this class and it could not be updated (${context}).`,
      err,
    );
  if (status === 429)
    return new ServiceError(
      'WALLET_RATE_LIMITED',
      `Google Wallet is rate-limiting this issuer (${context}). Retry shortly.`,
      err,
    );
  if (status && status >= 500)
    return new ServiceError(
      'WALLET_UNAVAILABLE',
      `Google Wallet is unavailable (${context}).`,
      err,
    );
  if (status && status >= 400)
    return new ServiceError(
      'WALLET_REJECTED',
      `Google Wallet rejected the request (${context}): ${detail}`,
      err,
    );

  // No HTTP status at all — DNS, TLS, socket, timeout.
  return new ServiceError(
    'WALLET_UNAVAILABLE',
    `Could not reach Google Wallet (${context}): ${detail}`,
    err,
  );
}

/**
 * The string that goes into `NotificationLog.error` and any UI that shows a
 * failure. Always `CODE: cause`, so a delivery report can group by cause
 * (Phase 2.5) instead of showing 40 variants of one network message.
 */
export function describeError(err: unknown): string {
  if (err instanceof ServiceError) return `${err.code}: ${err.message}`;
  const message = err instanceof Error ? err.message : String(err);
  return `UNKNOWN: ${message}`;
}
