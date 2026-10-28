export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MIN_RESPONSE_BYTES = 1024;
export const MAX_HEADER_BYTES = 16 * 1024;

export function validResponseLimit(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_RESPONSE_BYTES &&
        value <= MAX_RESPONSE_BYTES
    );
}
