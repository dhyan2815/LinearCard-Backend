import {
  MAX_ENROLLMENT_VALUE_LENGTH,
  sanitizeEnrollmentFields,
} from './enrollment-fields';
import type { EnrollmentField } from '../types';

const TICKET_FIELDS: EnrollmentField[] = [
  { key: 'seat', label: 'Seat', type: 'text', required: true },
  { key: 'gate', label: 'Gate', type: 'text', required: false },
];

describe('sanitizeEnrollmentFields', () => {
  it('keeps the declared values', () => {
    expect(
      sanitizeEnrollmentFields(TICKET_FIELDS, { seat: '12A', gate: 'B' }),
    ).toEqual({ seat: '12A', gate: 'B' });
  });

  // The trust boundary: these values render on a Google Wallet pass.
  it('drops anything the program did not declare', () => {
    expect(
      sanitizeEnrollmentFields(TICKET_FIELDS, {
        seat: '12A',
        balance: '999999',
        isAdmin: 'true',
      }),
    ).toEqual({ seat: '12A', gate: '' });
  });

  it('returns nothing at all when the program declares no fields', () => {
    expect(sanitizeEnrollmentFields([], { seat: '12A' })).toEqual({});
    expect(sanitizeEnrollmentFields(null, { seat: '12A' })).toEqual({});
    expect(sanitizeEnrollmentFields(undefined, { seat: '12A' })).toEqual({});
  });

  it('rejects a missing required field', () => {
    expect(() =>
      sanitizeEnrollmentFields(TICKET_FIELDS, { gate: 'B' }),
    ).toThrow(/Seat is required/);
  });

  it('rejects a required field that is only whitespace', () => {
    expect(() =>
      sanitizeEnrollmentFields(TICKET_FIELDS, { seat: '   ' }),
    ).toThrow(/Seat is required/);
  });

  // An empty key still resolves its {{token}} to nothing, rather than
  // leaving raw braces visible on the card.
  it('keeps an optional field as an empty string when omitted', () => {
    expect(sanitizeEnrollmentFields(TICKET_FIELDS, { seat: '12A' })).toEqual({
      seat: '12A',
      gate: '',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(
      sanitizeEnrollmentFields(TICKET_FIELDS, { seat: '  12A  ' }),
    ).toMatchObject({ seat: '12A' });
  });

  it('caps the length so a pass field cannot hold an essay', () => {
    expect(() =>
      sanitizeEnrollmentFields(TICKET_FIELDS, {
        seat: 'x'.repeat(MAX_ENROLLMENT_VALUE_LENGTH + 1),
      }),
    ).toThrow(/characters or fewer/);
  });

  it('survives a non-object payload instead of throwing', () => {
    expect(() => sanitizeEnrollmentFields(TICKET_FIELDS, 'nope')).toThrow(
      /Seat is required/,
    );
    expect(sanitizeEnrollmentFields([TICKET_FIELDS[1]], null)).toEqual({
      gate: '',
    });
  });

  it('validates a number field', () => {
    const fields: EnrollmentField[] = [
      { key: 'age', label: 'Age', type: 'number', required: true },
    ];
    expect(sanitizeEnrollmentFields(fields, { age: '21' })).toEqual({
      age: '21',
    });
    expect(() => sanitizeEnrollmentFields(fields, { age: 'old' })).toThrow(
      /must be a number/,
    );
  });

  it('validates a date field', () => {
    const fields: EnrollmentField[] = [
      {
        key: 'valid_until',
        label: 'Valid until',
        type: 'date',
        required: true,
      },
    ];
    expect(
      sanitizeEnrollmentFields(fields, { valid_until: '2027-06-30' }),
    ).toEqual({ valid_until: '2027-06-30' });
    expect(() =>
      sanitizeEnrollmentFields(fields, { valid_until: 'someday' }),
    ).toThrow(/must be a valid date/);
  });
});
