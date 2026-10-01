import {
  hasTokens,
  interpolateRows,
  interpolateTemplateRow,
  maskPhone,
} from './template-interpolator';

const CTX = {
  balance: '450 Pts',
  tier: 'Gold',
  name: 'Asha Menon',
  phone: '+919876543210',
  memberId: 'pass-1',
};

describe('interpolateTemplateRow', () => {
  it.each([
    ['{{balance}}', '450 Pts'],
    ['{{tier}}', 'Gold'],
    ['{{name}}', 'Asha Menon'],
    ['{{memberName}}', 'Asha Menon'],
    ['{{memberId}}', 'pass-1'],
  ])('resolves %s', (body, expected) => {
    expect(interpolateTemplateRow(body, CTX)).toBe(expected);
  });

  it('substitutes a token embedded in surrounding text', () => {
    expect(interpolateTemplateRow('You have {{balance}} left!', CTX)).toBe(
      'You have 450 Pts left!',
    );
  });

  it('substitutes several tokens in one body', () => {
    expect(
      interpolateTemplateRow('{{name}} — {{tier}} ({{balance}})', CTX),
    ).toBe('Asha Menon — Gold (450 Pts)');
  });

  it('tolerates whitespace and casing', () => {
    expect(interpolateTemplateRow('{{ Balance }}', CTX)).toBe('450 Pts');
  });

  it('masks the phone number rather than printing it on the card', () => {
    expect(interpolateTemplateRow('{{phone}}', CTX)).toBe('••••••••3210');
  });

  it('renders a known token with no value as empty, not as literal text', () => {
    expect(interpolateTemplateRow('{{tier}}', { balance: 0 })).toBe('');
  });

  it('renders a zero balance as "0", never as empty', () => {
    expect(interpolateTemplateRow('{{balance}}', { balance: 0 })).toBe('0');
  });

  // Blanking a typo silently would make it undebuggable for the designer.
  it('leaves an unknown token untouched', () => {
    expect(interpolateTemplateRow('{{nope}}', CTX)).toBe('{{nope}}');
  });

  it('leaves a body with no tokens alone', () => {
    expect(interpolateTemplateRow('Member since 2024', CTX)).toBe(
      'Member since 2024',
    );
  });
});

describe('maskPhone', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhone('+91 98765 43210')).toBe('••••••••3210');
  });

  it('does not mask a value too short to have anything to hide', () => {
    expect(maskPhone('3210')).toBe('3210');
  });
});

describe('hasTokens', () => {
  it.each([
    ['{{balance}} Pts', true],
    ['plain text', false],
    ['{ balance }', false],
  ])('%s → %s', (body, expected) => {
    expect(hasTokens(body)).toBe(expected);
  });

  // The regex is module-level with /g; a stale lastIndex would make repeated
  // calls alternate between true and false.
  it('is not affected by a previous call', () => {
    expect(hasTokens('{{balance}}')).toBe(true);
    expect(hasTokens('{{balance}}')).toBe(true);
  });

  it('is false for a non-string body', () => {
    expect(hasTokens(undefined)).toBe(false);
    expect(hasTokens(42)).toBe(false);
  });
});

describe('interpolateRows', () => {
  it('rewrites only the columns that carry a token', () => {
    const rows = [
      {
        id: 'row1',
        columns: [
          { key: 'a', header: 'Balance', body: '{{balance}} left' },
          { key: 'b', header: 'Static', body: 'Since 2024' },
        ],
      },
    ];
    const out = interpolateRows(rows, CTX);
    expect(out[0].columns[0].body).toBe('450 Pts left');
    expect(out[0].columns[1].body).toBe('Since 2024');
  });

  it('returns the very same array when nothing needs substituting', () => {
    const rows = [
      { id: 'row1', columns: [{ key: 'a', header: 'H', body: 'Static' }] },
    ];
    expect(interpolateRows(rows, CTX)).toBe(rows);
  });

  it('does not mutate the template it was given', () => {
    const rows = [
      { id: 'row1', columns: [{ key: 'a', header: 'H', body: '{{tier}}' }] },
    ];
    interpolateRows(rows, CTX);
    expect(rows[0].columns[0].body).toBe('{{tier}}');
  });
});

/** Phase 6 — the member's own enrollment answers. */
describe('interpolateTemplateRow — custom attributes', () => {
  const ctx = {
    balance: '0 Pts',
    tier: 'Standard',
    custom: { seat: '12A', student_id: 'CS-2291', gate: '' },
  };

  it('resolves a custom key', () => {
    expect(interpolateTemplateRow('{{seat}}', ctx)).toBe('12A');
  });

  it('resolves a custom key containing an underscore and digits', () => {
    expect(interpolateTemplateRow('{{student_id}}', ctx)).toBe('CS-2291');
  });

  it('renders a declared-but-empty custom key as empty, not as braces', () => {
    expect(interpolateTemplateRow('{{gate}}', ctx)).toBe('');
  });

  // A program must not be able to shadow the real balance/tier with a
  // custom field of the same name.
  it('never lets a custom key shadow a reserved one', () => {
    expect(
      interpolateTemplateRow('{{balance}} / {{tier}}', {
        ...ctx,
        custom: { ...ctx.custom, balance: 'HACKED', tier: 'Platinum' },
      }),
    ).toBe('0 Pts / Standard');
  });

  it('still leaves a genuinely unknown key visible', () => {
    expect(interpolateTemplateRow('{{nothere}}', ctx)).toBe('{{nothere}}');
  });

  it('interpolates custom keys through interpolateRows', () => {
    const rows = [
      {
        id: 'row1',
        columns: [{ key: 'seat', header: 'Seat', body: '{{seat}}' }],
      },
    ];
    expect(interpolateRows(rows, ctx)[0].columns[0].body).toBe('12A');
  });
});
