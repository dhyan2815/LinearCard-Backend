import { HttpException, HttpStatus } from '@nestjs/common';
import type { EnrollmentField } from '../types';

/** A seat number is short; this only exists to stop an essay on a pass. */
export const MAX_ENROLLMENT_VALUE_LENGTH = 120;

/**
 * Phase 6 — validates member-supplied enrollment values against what the
 * program actually declared.
 *
 * This is a **trust boundary**: the values arrive from the public enrollment
 * page and end up rendered on a Google Wallet pass. Anything the program did
 * not declare is dropped rather than rejected, so a stale client cannot brick
 * enrollment, but nothing undeclared can ever reach the pass.
 */
export function sanitizeEnrollmentFields(
  declared: EnrollmentField[] | null | undefined,
  input: unknown,
): Record<string, string> {
  const fields = Array.isArray(declared) ? declared : [];
  if (fields.length === 0) return {};

  const raw =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const clean: Record<string, string> = {};
  for (const field of fields) {
    const value = raw[field.key];
    const text =
      value === undefined || value === null ? '' : String(value).trim();

    if (!text) {
      if (field.required) {
        throw new HttpException(
          `${field.label} is required.`,
          HttpStatus.BAD_REQUEST,
        );
      }
      // Declared but not supplied: keep the key so its `{{token}}` renders
      // empty rather than showing raw braces on the card.
      clean[field.key] = '';
      continue;
    }

    if (text.length > MAX_ENROLLMENT_VALUE_LENGTH) {
      throw new HttpException(
        `${field.label} must be ${MAX_ENROLLMENT_VALUE_LENGTH} characters or fewer.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (field.type === 'number' && !Number.isFinite(Number(text))) {
      throw new HttpException(
        `${field.label} must be a number.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (field.type === 'date' && Number.isNaN(Date.parse(text))) {
      throw new HttpException(
        `${field.label} must be a valid date.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    clean[field.key] = text;
  }

  return clean;
}
