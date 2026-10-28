import { createRequire } from 'node:module';

import type { CheerioCrawlingContext } from '@crawlee/cheerio';

import { isRecord, normalizeProduct, type Product } from '../product.js';
import { validateProductUrl } from '../url-policy.js';
import { analyzeStructuredHtml, type HtmlAnalysis } from './structured-html.js';
import { sourceId, sourceNumber, sourceText } from './values.js';

const crawlerRequire = createRequire(import.meta.resolve('@crawlee/cheerio'));
const { load } = crawlerRequire('cheerio') as { load(html: string): CheerioCrawlingContext['$'] };

export function analyzeCnxiekuHtml(html: string, url: string): HtmlAnalysis {
    const target = validateProductUrl(url);
    if (target.source !== 'cnxieku') throw new TypeError('Expected a CNXieku URL for this offline parser.');
    const analysis = analyzeStructuredHtml(html, target);
    const itemId = new URL(target.url).pathname.match(/^\/item\/(\d+)$/)?.[1];
    if (!itemId) return analysis;
    const scripts = load(html)('script#__NUXT_DATA__[type="application/json"][data-nuxt-data="nuxt-app"]');
    if (!scripts.length) return analysis;
    if (scripts.length !== 1) {
        analysis.warnings.push('AMBIGUOUS_CNXIEKU_STATE');
        return analysis;
    }
    let pool: unknown;
    try {
        pool = JSON.parse(scripts.text());
    } catch {
        analysis.warnings.push('INVALID_CNXIEKU_STATE');
        return analysis;
    }
    if (!Array.isArray(pool)) return analysis;
    // Observed Nuxt index table: resolve only the requested product and image base.
    // Never evaluate scripts or traverse user, shop, recommendation or session records.
    const values: unknown[] = pool;
    const node = (index: unknown, depth = 0): unknown => {
        if (depth > 8 || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
        const value = values[index];
        return Array.isArray(value) && value[0] === 'ShallowReactive' ? node(value[1], depth + 1) : value;
    };
    const field = (value: unknown, key: string): unknown =>
        isRecord(value) && Object.hasOwn(value, key) ? node(value[key]) : undefined;
    const entries = (value: unknown): unknown[] | null => (Array.isArray(value) ? value.map((i) => node(i)) : null);
    const root = node(0);
    const data = field(root, 'data');
    const product = field(data, `product-seo-${itemId}`);
    const item = field(product, 'item');
    if (field(root, 'path') !== new URL(target.url).pathname || sourceId(field(item, 'productId')) !== itemId) {
        analysis.warnings.push('CNXIEKU_PRODUCT_URL_MISMATCH');
        return analysis;
    }
    const common = field(field(root, 'pinia'), 'common');
    const storageUrl = sourceText(field(common, 'storageUrl'));
    const image = (value: unknown): string | null => {
        const path = sourceText(value);
        if (!path) return null;
        try {
            const resolved = storageUrl ? new URL(path, storageUrl) : new URL(path);
            return ['http:', 'https:'].includes(resolved.protocol) && !resolved.username && !resolved.password
                ? resolved.href
                : null;
        } catch {
            return null;
        }
    };
    const gallery = entries(field(product, 'picList'));
    const descriptions = entries(field(product, 'descArr'));
    const images = [
        image(field(item, 'picOriginal')),
        ...(gallery ?? []).map((pic) =>
            sourceId(field(pic, 'productId')) === itemId ? image(field(pic, 'picOriginal')) : null,
        ),
        ...(descriptions ?? []).map((pic) => (field(pic, 'type') === 'pic' ? image(field(pic, 'pic')) : null)),
    ].filter((value): value is string => value !== null);
    const characteristics: { name: string; value: string }[] = [];
    const normal = entries(field(field(product, 'attrList'), 'normal'));
    for (const group of normal ?? []) {
        for (const attr of entries(field(group, 'attrList')) ?? []) {
            if (sourceId(field(attr, 'productId')) !== itemId) continue;
            const name = sourceText(field(attr, 'attrName'));
            const rawValue = field(attr, 'attrValue');
            const value = Array.isArray(rawValue)
                ? (entries(rawValue) ?? [])
                      .map(sourceText)
                      .filter((v) => v !== null)
                      .join(', ')
                : sourceText(rawValue);
            if (name && value) characteristics.push({ name, value });
        }
    }
    const skus = entries(field(product, 'skuList'));
    const variations = skus?.map((sku) => {
        if (sourceId(field(sku, 'productId')) !== itemId) return null;
        const amount = sourceNumber(field(sku, 'skuPrice'));
        const picture = image(field(sku, 'productUrl'));
        return {
            productId: sourceId(field(sku, 'skuId')),
            title: sourceText(field(sku, 'skuValue')),
            price: amount === null ? null : { amount, currency: null },
            images: picture ? [picture] : null,
            characteristics: entries(field(sku, 'skuData'))?.map((attr) => ({
                name: sourceText(field(attr, 'name')),
                value: sourceText(field(attr, 'value')),
            })),
        };
    });
    const amount = sourceNumber(field(item, 'productPrice'));
    const weightText = sourceText(field(item, 'productWeight'));
    const weightMatch = weightText?.match(/^(\d+(?:\.\d+)?) kg$/);
    const weightValue = weightMatch ? sourceNumber(weightMatch[1]) : null;
    // Preserve the source placeholder, but never pass zero as a quotation weight.
    if (weightValue === 0 && weightText) characteristics.push({ name: 'productWeight', value: weightText });
    const minimum = sourceNumber(field(item, 'minNumber'));
    const extracted = normalizeProduct({
        url: target.url,
        productId: sourceId(field(item, 'productId')),
        title: sourceText(field(item, 'productName')),
        price: amount === null ? null : { amount, currency: null },
        moq: minimum,
        weight: weightValue !== null && weightValue > 0 ? { value: weightValue, unit: 'kg' } : null,
        dimensions: null,
        images: images.length ? [...new Set(images)] : null,
        characteristics: normal || characteristics.length ? characteristics : null,
        variations,
    });
    const prefix = `script#__NUXT_DATA__ → data[product-seo-${itemId}]`;
    const paths: Record<string, string> = {
        productId: 'item.productId',
        title: 'item.productName',
        price: 'item.productPrice (currency unknown)',
        moq: 'item.minNumber',
        weight: 'item.productWeight',
        images: 'item.picOriginal / picList[].picOriginal / descArr[type=pic].pic + pinia.common.storageUrl',
        characteristics: 'attrList.normal[].attrList[].attrName / attrValue (selected values only)',
        variations: 'skuList[].skuId / skuValue / skuPrice / productUrl / skuData',
    };
    return {
        product: extracted,
        evidence: [
            analysis.evidence[0],
            ...(weightValue === 0
                ? [
                      {
                          field: 'weight',
                          path: `${prefix}.item.productWeight=${JSON.stringify(weightText)}; quotation weight=null`,
                      },
                  ]
                : []),
            ...Object.entries(paths)
                .filter(([key]) => extracted[key as keyof Product] !== null)
                .map(([key, path]) => ({ field: key, path: `${prefix}.${path}` })),
        ],
        warnings: [
            'CURRENCY_ISO_NOT_PRESENT_SYMBOL_AMBIGUOUS',
            'PHYSICAL_DIMENSIONS_NOT_PRESENT_VOLUME_IS_NOT_DIMENSIONS',
            ...(weightValue === 0 ? ['ZERO_WEIGHT_REQUIRES_VERIFICATION'] : []),
            ...(extracted.images ? ['IMAGE_URLS_RESOLVED_NOT_FETCHED'] : []),
        ],
    };
}
export function extractCnxiekuProduct(html: string, url: string): Product {
    return analyzeCnxiekuHtml(html, url).product;
}
