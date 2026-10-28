/** Explicit typed source fields only; never scrape numbers out of display strings. */
export function sourceText(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
export function sourceNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}
export function sourceId(value: unknown): string | null {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
    return sourceText(value);
}
export function sourceCurrency(value: unknown): string | null {
    const text = sourceText(value);
    return text && /^[A-Z]{3}$/.test(text) ? text : null;
}
