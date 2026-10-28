/** Approved canonical contract. Legacy 1688 differences are handled by reference-1688.ts. */
export interface Price {
    amount: number | null;
    currency: string | null;
}
export interface Characteristic {
    name: string | null;
    value: string | null;
}
export interface Variation {
    productId: string | null;
    title: string | null;
    price: Price | null;
    images: (string | null)[] | null;
    characteristics: (Characteristic | null)[] | null;
}
export interface Product extends Variation {
    url: string | null;
    moq: number | null;
    weight: { value: number | null; unit: string | null } | null;
    dimensions: { length: number | null; width: number | null; height: number | null; unit: string | null } | null;
    variations: (Variation | null)[] | null;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function nonNegative(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function url(value: unknown): string | null {
    const candidate = text(value);
    if (!candidate || !/^https?:\/\//.test(candidate) || /\s/.test(candidate)) return null;
    try {
        const parsed = new URL(candidate);
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? candidate : null;
    } catch {
        return null;
    }
}
function nullableObject<T extends object>(value: T): T | null {
    return Object.values(value).every((field) => field === null) ? null : value;
}
function list<T>(value: unknown, normalize: (item: unknown) => T | null): (T | null)[] | null {
    return Array.isArray(value) ? Array.from(value, normalize) : null;
}
function price(value: unknown): Price | null {
    if (!isRecord(value)) return null;
    return nullableObject({ amount: nonNegative(value.amount), currency: text(value.currency) });
}
function characteristic(value: unknown): Characteristic | null {
    if (!isRecord(value)) return null;
    return nullableObject({ name: text(value.name), value: text(value.value) });
}
function variation(value: unknown): Variation | null {
    if (!isRecord(value)) return null;
    return nullableObject({
        productId: text(value.productId),
        title: text(value.title),
        price: price(value.price),
        images: list(value.images, url),
        characteristics: list(value.characteristics, characteristic),
    });
}
/** Never infer identifiers, units, currency, MOQ or values from another field. */
export function normalizeProduct(raw: unknown): Product {
    if (!isRecord(raw)) throw new TypeError('Each product must be a JSON object.');
    return {
        url: url(raw.url),
        title: text(raw.title),
        price: price(raw.price),
        moq: typeof raw.moq === 'number' && Number.isInteger(raw.moq) && raw.moq >= 1 ? raw.moq : null,
        weight: isRecord(raw.weight)
            ? nullableObject({ value: nonNegative(raw.weight.value), unit: text(raw.weight.unit) })
            : null,
        dimensions: isRecord(raw.dimensions)
            ? nullableObject({
                  length: nonNegative(raw.dimensions.length),
                  width: nonNegative(raw.dimensions.width),
                  height: nonNegative(raw.dimensions.height),
                  unit: text(raw.dimensions.unit),
              })
            : null,
        images: list(raw.images, url),
        characteristics: list(raw.characteristics, characteristic),
        variations: list(raw.variations, variation),
        productId: text(raw.productId),
    };
}
