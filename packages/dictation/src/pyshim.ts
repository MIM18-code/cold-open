// Small helpers that reproduce the Python string and Counter behaviour the
// formatting rules were written against, so the port can match it exactly.

/** Python's \w (Unicode letters, digits and underscore). JS \w is ASCII only. */
export const W = String.raw`[\p{L}\p{N}_]`;
/** Python's [^\W_]: a Unicode letter or digit. */
export const ALNUM = String.raw`[\p{L}\p{N}]`;
/** Python's \b before a word character. */
export const B_START = String.raw`(?<![\p{L}\p{N}_])`;
/** Python's \b after a word character. */
export const B_END = String.raw`(?![\p{L}\p{N}_])`;
/** Python's $ in search mode also matches just before a final newline. */
export const PY_END = String.raw`(?=\n?$)`;

export function strip(value: string, chars?: string): string {
  if (chars === undefined) return value.replace(/^\s+|\s+$/gu, "");
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start]!)) start++;
  while (end > start && chars.includes(value[end - 1]!)) end--;
  return value.slice(start, end);
}

export function rstrip(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1]!)) end--;
  return value.slice(0, end);
}

/** str.split() with no separator. */
export function split(value: string): string[] {
  const trimmed = strip(value);
  return trimmed ? trimmed.split(/\s+/u) : [];
}

/** value[:n] counted in code points. */
export function head(value: string, n: number): string {
  return Array.from(value).slice(0, n).join("");
}

/** value[0].upper() + value[1:], by code point. */
export function capitalizeFirst(value: string): string {
  const [first = "", ...rest] = Array.from(value);
  return first.toUpperCase() + rest.join("");
}

/** re.escape for a pattern compiled with the u flag (which rejects needless escapes). */
export function escape(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** collections.Counter with the operations the rules use, keeping insertion order. */
export class Counter {
  readonly counts = new Map<string, number>();

  constructor(items: Iterable<string> = []) {
    this.update(items);
  }

  update(items: Iterable<string> | Counter): this {
    if (items instanceof Counter) {
      for (const [key, count] of items.counts) this.counts.set(key, (this.counts.get(key) ?? 0) + count);
    } else {
      for (const key of items) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    }
    return this;
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** a - b: positive counts only, in a's order. */
  minus(other: Counter): Counter {
    const result = new Counter();
    for (const [key, count] of this.counts) {
      const left = count - other.get(key);
      if (left > 0) result.counts.set(key, left);
    }
    return result;
  }

  delete(key: string): void {
    this.counts.delete(key);
  }

  keys(): string[] {
    return [...this.counts.keys()];
  }

  total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  get size(): number {
    return this.counts.size;
  }

  toObject(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }
}

/** sorted() for strings: code point order. */
export function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
