import { sourceId, sourceNumber, sourceText } from './extractors/values.js';
import { isRecord, normalizeProduct, type Product } from './product.js';

/** The engineer's eleven-key product, emitted only after a successful/partial extraction. */
export interface Reference1688Product {
    url: string | null;
    title: string | null;
    price: string | null;
    productLadderPrices: [];
    moq: number | null;
    weight: Product['weight'];
    dimensions: Product['dimensions'];
    images: Product['images'];
    characteristics: { attrName: string | null; attrValue: string | null }[] | null;
    variations:
        | {
              name: 'Variación';
              variants: { name: string | null; price: number | null; image: string | null }[];
          }[]
        | null;
    productId: number | string | null;
}

/** No parent-price fallback, invented units, currency conversion or unobserved price tiers. */
export function export1688Product(product: Product): Reference1688Product {
    const id = product.productId;
    const numericId = id !== null && /^(0|[1-9]\d*)$/.test(id) ? Number(id) : null;
    let variations: Reference1688Product['variations'] = null;
    if (product.variations) {
        variations = product.variations.length
            ? [
                  {
                      name: 'Variación',
                      variants: product.variations.map((entry) => ({
                          name: entry?.title ?? null,
                          price: entry?.price?.amount ?? null,
                          image: entry?.images?.[0] ?? null,
                      })),
                  },
              ]
            : [];
    }
    return {
        url: product.url,
        title: product.title,
        price: product.price?.amount?.toString() ?? null,
        // No tiers have been extracted. [] is the reference's empty export list, not a source claim.
        productLadderPrices: [],
        moq: product.moq,
        weight: product.weight?.value === 0 ? null : product.weight,
        dimensions: product.dimensions,
        images: product.images,
        characteristics:
            product.characteristics?.map((entry) => ({
                attrName: entry?.name ?? null,
                attrValue: entry?.value ?? null,
            })) ?? null,
        variations,
        productId: numericId !== null && Number.isSafeInteger(numericId) ? numericId : id,
    };
}

export interface ReferenceImport {
    product: Product;
    compatibility: {
        productLadderPrices: unknown;
        variationGroups: { name: string | null; variantIndexes: number[] }[] | null;
    };
    warnings: string[];
}
/** Offline adapter. Does not change Product or enable 1688 as a network source. */
export function adapt1688Reference(raw: unknown): ReferenceImport {
    if (!isRecord(raw)) throw new TypeError('The 1688 reference must be a JSON object.');
    const warnings: string[] = ['CURRENCY_NOT_PRESENT_IN_REFERENCE'];
    const variations: Record<string, unknown>[] = [];
    const groups: ReferenceImport['compatibility']['variationGroups'] = Array.isArray(raw.variations) ? [] : null;
    if (Array.isArray(raw.variations)) {
        for (const group of raw.variations) {
            if (!isRecord(group) || !Array.isArray(group.variants)) {
                warnings.push('INVALID_VARIATION_GROUP');
                continue;
            }
            const name = sourceText(group.name);
            const variantIndexes: number[] = [];
            for (const variant of group.variants) {
                if (!isRecord(variant)) {
                    warnings.push('INVALID_VARIANT');
                    continue;
                }
                variantIndexes.push(variations.length);
                const amount = sourceNumber(variant.price);
                variations.push({
                    productId: sourceId(variant.productId),
                    title: sourceText(variant.name),
                    price: amount === null ? null : { amount, currency: null },
                    images: variant.image === null || variant.image === undefined ? null : [variant.image],
                    characteristics:
                        name && sourceText(variant.name) ? [{ name, value: sourceText(variant.name) }] : null,
                });
            }
            groups?.push({ name, variantIndexes });
        }
    }
    const amount = sourceNumber(raw.price);
    // Preserve unverified tier payload only in the offline compatibility sidecar, never in Actor output.
    const ladder = raw.productLadderPrices === undefined ? null : structuredClone(raw.productLadderPrices);
    if (ladder !== null && (!Array.isArray(ladder) || ladder.length))
        warnings.push('LADDER_PRICE_STRUCTURE_UNVERIFIED');
    const product = normalizeProduct({
        ...raw,
        price: amount === null ? null : { amount, currency: null },
        productId: sourceId(raw.productId),
        characteristics: Array.isArray(raw.characteristics)
            ? raw.characteristics.map((entry) =>
                  isRecord(entry) ? { name: sourceText(entry.attrName), value: sourceText(entry.attrValue) } : null,
              )
            : null,
        variations: Array.isArray(raw.variations) ? variations : null,
    });
    return { product, compatibility: { productLadderPrices: ladder, variationGroups: groups }, warnings };
}
