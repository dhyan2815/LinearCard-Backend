/**
 * Phase 3 — `{{token}}` substitution for custom template columns.
 *
 * The reserved field keys (`balance`/`points`, `tier`, `memberName`,
 * `memberId`) already get live values pushed into them by key. Every *other*
 * column rendered its configured `body` verbatim, so a designer who wrote
 * "{{balance}} Pts" shipped that literal string to the member's card. These
 * tokens make any column live.
 */

export interface PassContext {
  balance?: string | number | null;
  tier?: string | null;
  name?: string | null;
  phone?: string | null;
  memberId?: string | null;
  /**
   * Phase 6 — the member's own enrollment answers (`Pass.customAttributes`),
   * keyed as the program declared them. Resolved *under* the reserved names
   * above, so a custom field called "tier" can never shadow the real tier.
   */
  custom?: Record<string, string> | null;
}

/**
 * `{{balance}}`, `{{ Balance }}`, `{{student_id}}` — whitespace and case are
 * both tolerated; custom keys may carry underscores and digits.
 */
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** All but the last 4 digits. A pass face is read over a counter. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return digits;
  return '•'.repeat(digits.length - 4) + digits.slice(-4);
}

export function hasTokens(body: unknown): body is string {
  if (typeof body !== 'string') return false;
  TOKEN_PATTERN.lastIndex = 0;
  return TOKEN_PATTERN.test(body);
}

/**
 * Substitutes every known token in `body`.
 *
 * A known token with no value resolves to an empty string (`{{tier}}` on a
 * tier-less program should render nothing). An *unknown* token is left
 * untouched on purpose: silently blanking a typo makes it undebuggable, and
 * a body may legitimately contain braces.
 */
export function interpolateTemplateRow(
  body: string,
  context: PassContext,
): string {
  if (typeof body !== 'string') return body;

  const values: Record<string, string | undefined> = {};
  // Custom keys first, so a reserved name always wins the collision.
  for (const [key, value] of Object.entries(context.custom || {})) {
    values[key.toLowerCase()] = value ?? '';
  }
  Object.assign(values, {
    balance:
      context.balance === null || context.balance === undefined
        ? ''
        : String(context.balance),
    tier: context.tier ?? '',
    name: context.name ?? '',
    membername: context.name ?? '',
    memberid: context.memberId ?? '',
    phone: context.phone ? maskPhone(context.phone) : '',
  });

  return body.replace(TOKEN_PATTERN, (match, token: string) => {
    const resolved = values[token.toLowerCase()];
    return resolved === undefined ? match : resolved;
  });
}

/**
 * Applies `interpolateTemplateRow` to every column body of every row.
 * Returns the input untouched when no column holds a token, so a template
 * without tokens costs nothing and keeps its identity.
 */
export function interpolateRows(rows: any[], context: PassContext): any[] {
  if (!Array.isArray(rows)) return rows;
  const needsWork = rows.some((row) =>
    (row?.columns || []).some((col: any) => hasTokens(col?.body)),
  );
  if (!needsWork) return rows;

  return rows.map((row) => ({
    ...row,
    columns: (row?.columns || []).map((col: any) =>
      hasTokens(col?.body)
        ? { ...col, body: interpolateTemplateRow(col.body, context) }
        : col,
    ),
  }));
}
