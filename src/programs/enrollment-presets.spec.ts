import { PROGRAM_PRESETS } from './presets';

/**
 * Phase 6 — a declared enrollment field is only useful if the template has a
 * column whose body is its `{{token}}`. Without that pairing the value is
 * captured and stored but never appears on the pass, which is exactly the
 * silent failure this phase exists to fix.
 */
describe('preset enrollment fields', () => {
  const withFields = PROGRAM_PRESETS.filter((p) => p.enrollmentFields?.length);

  it('declares fields on the presets that carry per-member data', () => {
    expect(withFields.map((p) => p.id).sort()).toEqual([
      'event_ticket',
      'student_id',
      'travel_ticket',
    ]);
  });

  it.each(withFields.map((p) => [p.id, p] as const))(
    '%s renders every declared field via a matching token column',
    (_id, preset) => {
      const bodyByKey = new Map<string, string>();
      for (const row of preset.fieldRows) {
        for (const col of row.columns) bodyByKey.set(col.key, col.body);
      }

      for (const field of preset.enrollmentFields!) {
        expect(bodyByKey.get(field.key)).toBe(`{{${field.key}}}`);
      }
    },
  );

  it.each(withFields.map((p) => [p.id, p] as const))(
    '%s gives every field a label and a supported type',
    (_id, preset) => {
      for (const field of preset.enrollmentFields!) {
        expect(field.label).toBeTruthy();
        expect(['text', 'number', 'date']).toContain(field.type);
      }
    },
  );

  // A loyalty card is the same design for everyone; only the balance and
  // tier differ, and those are already live fields.
  it('declares none on loyalty and coupon presets', () => {
    for (const preset of PROGRAM_PRESETS) {
      if (preset.kind === 'loyalty' || preset.kind === 'coupon') {
        expect(preset.enrollmentFields ?? []).toEqual([]);
      }
    }
  });
});
