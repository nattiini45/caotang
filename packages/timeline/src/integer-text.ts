/**
 * Whole numbers as a lens writes and reads them: the real minus sign (U+2212), digits grouped the way a locale groups them in
 * the long form, and no grouping in the short one. Reading is more generous than writing — a hyphen counts as a minus, the
 * locale's own digits and any common group separator are accepted — so a person can type a day, and a label a lens wrote
 * always reads back.
 */

const MINUS = '\u2212';

/** Group separators in real use: comma, full stop, apostrophes, space, no-break and narrow no-break space, thin space. */
const SEPARATORS = ",.'\u2019_ \u00a0\u202f\u2009";

function groupedPattern(extra: string): RegExp {
  const set = `${SEPARATORS}${extra}`.replace(/[\]\\^-]/g, '\\$&');
  return new RegExp(`^\\d{1,3}([${set}])\\d{3}(?:\\1\\d{3})*$`);
}

export interface IntegerCodec {
  /** `grouped` writes the locale's group separators; otherwise plain ASCII digits. A negative number takes the real minus. */
  format(value: number, grouped: boolean): string;
  /** A whole number written by {@link format} or typed by a person, or `null`. */
  parse(text: string): number | null;
}

export function createIntegerCodec(locale: string): IntegerCodec {
  const numbers = new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 0 });
  const plain = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 });
  const digitOf = new Map<string, string>();
  for (let digit = 0; digit <= 9; digit += 1) digitOf.set(plain.format(digit), String(digit));
  // The locale's own separator may be one the list above does not hold (Arabic writes U+066C).
  const grouping = groupedPattern(numbers.formatToParts(1_234_567).find((part) => part.type === 'group')?.value ?? '');

  const format = (value: number, grouped: boolean): string => {
    const magnitude = Math.abs(value);
    const text = grouped ? numbers.format(magnitude) : String(magnitude);
    return value < 0 ? `${MINUS}${text}` : text;
  };

  const parse = (text: string): number | null => {
    let body = text.trim();
    let negative = false;
    if (body.startsWith(MINUS) || body.startsWith('-')) {
      negative = true;
      body = body.slice(1);
    } else if (body.startsWith('+')) body = body.slice(1);
    if (body === '') return null;
    let ascii = '';
    for (const char of body) ascii += digitOf.get(char) ?? char;
    if (!/^\d+$/.test(ascii) && !grouping.test(ascii)) return null;
    const value = Number(ascii.replace(/\D/g, ''));
    if (!Number.isSafeInteger(value)) return null;
    return negative && value !== 0 ? -value : value;
  };

  return { format, parse };
}
