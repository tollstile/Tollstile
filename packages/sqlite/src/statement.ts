/** A value bound to a `?` placeholder. Money is bound as decimal text and cast in SQL. */
export type SqliteValue = string | number | null;

/** SQL with anonymous `?` placeholders and the values bound to them, in order. */
export type SqliteStatement = { readonly sql: string; readonly params: readonly SqliteValue[] };

/**
 * Builds a statement from a template: interpolated values become `?` parameters and interpolated
 * statements are spliced in with their parameters. Only anonymous placeholders are produced
 * because every driver supports them.
 */
export function sql(strings: TemplateStringsArray, ...values: readonly (SqliteValue | SqliteStatement)[]): SqliteStatement {
  let text = strings[0] ?? '';
  const params: SqliteValue[] = [];
  values.forEach((value, index) => {
    if (value !== null && typeof value === 'object') {
      text += value.sql;
      params.push(...value.params);
    } else {
      text += '?';
      params.push(value);
    }
    text += strings[index + 1] ?? '';
  });
  return { sql: text, params };
}

/** Trusted SQL text: identifiers and literals derived from configuration or core's state lists, never input. */
export function raw(text: string): SqliteStatement {
  return { sql: text, params: [] };
}

export function join(parts: readonly SqliteStatement[], separator: string): SqliteStatement {
  return { sql: parts.map((part) => part.sql).join(separator), params: parts.flatMap((part) => part.params) };
}
