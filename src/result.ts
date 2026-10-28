import type { Mode } from './input.js';
import { isRecord, normalizeProduct, type Product } from './product.js';
import { export1688Product, type Reference1688Product } from './reference-1688.js';
import type { Source } from './url-policy.js';

export const resultStatuses = [
    'success',
    'partial',
    'blocked',
    'not_found',
    'timeout',
    'unsupported',
    'error',
] as const;
export type ResultStatus = (typeof resultStatuses)[number];
export interface ProductResult {
    requestedUrl: string | null;
    source: Source | null;
    mode: Mode | null;
    status: ResultStatus;
    httpStatus: number | null;
    product: Product;
    missingFields: string[];
    error: { code: string; message: string; retryAfter: string | null } | null;
}
/** Keep canonical callers and all failures unchanged; only format extracted products. */
export function toDatasetItem(result: ProductResult, input: unknown): ProductResult | Reference1688Product {
    if (
        !isRecord(input) ||
        input.outputFormat !== 'reference1688' ||
        (result.status !== 'success' && result.status !== 'partial')
    )
        return result;
    if (!Object.entries(result.product).some(([key, value]) => key !== 'url' && value !== null)) {
        return {
            ...result,
            status: 'error',
            error: {
                code: 'NO_PRODUCT_DATA',
                message: 'El HTML no contiene datos verificados del producto solicitado.',
                retryAfter: null,
            },
        };
    }
    return export1688Product(result.product);
}
/** Empty arrays mean explicitly empty; nulls, including nested ones, mean missing. */
export function missingProductFields(product: Product): string[] {
    const missing: string[] = [];
    const visit = (value: unknown, path: string): void => {
        if (value === null) missing.push(path);
        else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
        else if (typeof value === 'object') {
            for (const [key, member] of Object.entries(value as object)) visit(member, path ? `${path}.${key}` : key);
        }
    };
    visit(product, '');
    return missing;
}
export function emptyResult(): ProductResult {
    const product = normalizeProduct({});
    return {
        requestedUrl: null,
        source: null,
        mode: null,
        status: 'error',
        httpStatus: null,
        product,
        missingFields: missingProductFields(product),
        error: null,
    };
}
