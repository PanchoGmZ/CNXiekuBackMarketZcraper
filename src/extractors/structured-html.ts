import { createRequire } from 'node:module';

import type { CheerioCrawlingContext } from '@crawlee/cheerio';

import { isRecord, normalizeProduct, type Product } from '../product.js';
import type { ProductTarget } from '../url-policy.js';
import { sourceCurrency, sourceId, sourceNumber, sourceText } from './values.js';

// Reuse the HTML parser explicitly declared by the installed Crawlee package; no new dependency.
const crawlerRequire = createRequire(import.meta.resolve('@crawlee/cheerio'));
const { load } = crawlerRequire('cheerio') as { load(html: string): CheerioCrawlingContext['$'] };
export interface HtmlAnalysis {
    product: Product;
    evidence: { field: string; path: string }[];
    warnings: string[];
}
type Node = Record<string, unknown>;
function hasType(node: Node, type: string): boolean {
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    return types.some(
        (value) => value === type || value === `https://schema.org/${type}` || value === `http://schema.org/${type}`,
    );
}
function absoluteUrl(value: unknown, base: string): string | null {
    const text = sourceText(value);
    if (!text) return null;
    try {
        const url = new URL(text, base);
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}
function imageList(raw: unknown, base: string): (string | null)[] | null {
    if (raw === undefined || raw === null) return null;
    const entries = Array.isArray(raw) ? raw : [raw];
    return entries.map((entry) => absoluteUrl(isRecord(entry) ? (entry.contentUrl ?? entry.url) : entry, base));
}
function quantity(raw: unknown): { value: number | null; unit: string | null } | null {
    if (!isRecord(raw)) return null;
    const value = sourceNumber(raw.value);
    const unit = sourceText(raw.unitText) ?? sourceText(raw.unitCode);
    return value === null && unit === null ? null : { value, unit };
}
function characteristics(raw: unknown): unknown[] | null {
    if (raw === undefined || raw === null) return null;
    return (Array.isArray(raw) ? raw : [raw]).map((entry) => {
        if (!isRecord(entry)) return null;
        const value =
            (typeof entry.value === 'number' && Number.isFinite(entry.value)) || typeof entry.value === 'boolean'
                ? String(entry.value)
                : sourceText(entry.value);
        return { name: sourceText(entry.name), value };
    });
}
function offer(node: Node, warnings: string[]): Node | null {
    const raw = node.offers;
    let offers: unknown[] = [];
    if (Array.isArray(raw)) offers = raw;
    else if (raw !== undefined) offers = [raw];
    if (offers.length > 1) {
        warnings.push('AMBIGUOUS_OFFERS');
        return null;
    }
    const selected = offers[0];
    if (!isRecord(selected)) return null;
    if (hasType(selected, 'AggregateOffer')) {
        warnings.push('AGGREGATE_PRICE_NOT_A_UNIT_PRICE');
        return null;
    }
    return hasType(selected, 'Offer') ? selected : null;
}
function productFields(node: Node, target: ProductTarget, warnings: string[]): Record<string, unknown> {
    const selectedOffer = offer(node, warnings);
    const amount = sourceNumber(selectedOffer?.price);
    const currency = sourceCurrency(selectedOffer?.priceCurrency);
    const eligible = selectedOffer?.eligibleQuantity;
    const minimum = isRecord(eligible) ? sourceNumber(eligible.minValue) : null;
    const width = quantity(node.width);
    const height = quantity(node.height);
    let dimensions: Product['dimensions'] = null;
    const measures = [width, height].filter((value) => value !== null);
    if (measures.length) {
        if (new Set(measures.map((value) => value.unit)).size > 1) warnings.push('INCOMPATIBLE_DIMENSION_UNITS');
        else
            dimensions = {
                length: null,
                width: width?.value ?? null,
                height: height?.value ?? null,
                unit: measures[0].unit,
            };
    }
    // depth is not silently relabelled as length; the approved contract has no depth axis.
    if (node.depth !== undefined) warnings.push('DEPTH_HAS_NO_APPROVED_LENGTH_MAPPING');
    return {
        title: sourceText(node.name),
        price: amount === null && currency === null ? null : { amount, currency },
        productId: sourceId(node.productID) ?? sourceId(node.sku),
        moq: minimum !== null && Number.isInteger(minimum) && minimum >= 1 ? minimum : null,
        images: imageList(node.image, target.url),
        weight: quantity(node.weight),
        dimensions,
        characteristics: characteristics(node.additionalProperty),
    };
}
/** Only local JSON-LD and standard metadata. Never evaluates scripts, loads contexts or follows links. */
export function analyzeStructuredHtml(html: string, target: ProductTarget): HtmlAnalysis {
    if (typeof html !== 'string') throw new TypeError('HTML must be a string.');
    if (Buffer.byteLength(html, 'utf8') > 2 * 1024 * 1024)
        throw new RangeError('Offline HTML exceeds the 2 MiB safety limit.');
    const $ = load(html);
    const warnings: string[] = [];
    const evidence: HtmlAnalysis['evidence'] = [{ field: 'url', path: 'validated request.url' }];
    const nodes: Node[] = [];
    const add = (value: unknown, depth = 0): void => {
        if (depth > 8 || nodes.length >= 1000) {
            warnings.push('JSONLD_LIMIT');
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((entry) => add(entry, depth + 1));
            return;
        }
        if (!isRecord(value)) return;
        nodes.push(value);
        if (value['@graph'] !== undefined) add(value['@graph'], depth + 1);
        if (hasType(value, 'WebPage') && isRecord(value.mainEntity)) add(value.mainEntity, depth + 1);
    };
    const scripts = $('script[type="application/ld+json"]');
    scripts.slice(0, 32).each((_index, element) => {
        try {
            add(JSON.parse($(element).text()));
        } catch {
            warnings.push('INVALID_JSONLD');
        }
    });
    if (scripts.length > 32) warnings.push('JSONLD_LIMIT');
    const candidates = nodes.filter((node) => hasType(node, 'Product') || hasType(node, 'ProductGroup'));
    const matchesUrl = (value: unknown): boolean => {
        const candidate = absoluteUrl(value, target.url);
        if (!candidate) return false;
        const url = new URL(candidate);
        url.hash = '';
        return url.href === target.url;
    };
    const explicitMatches = candidates.filter((node) => matchesUrl(node.url));
    const matches = explicitMatches.length ? explicitMatches : candidates.filter((node) => matchesUrl(node['@id']));
    let selected: Node | undefined;
    if (matches.length === 1) [selected] = matches;
    else if (!matches.length && candidates.length === 1) {
        const candidate = candidates[0];
        if (candidate.url === undefined && candidate['@id'] === undefined) selected = candidate;
        else warnings.push('PRODUCT_URL_MISMATCH');
    } else if (candidates.length) warnings.push('AMBIGUOUS_PRODUCT');

    const raw: Record<string, unknown> = { url: target.url };
    if (selected) {
        Object.assign(raw, productFields(selected, target, warnings));
        const paths: Record<string, string> = {
            title: 'name',
            price: 'offers[one].price / priceCurrency',
            productId: 'productID or sku',
            moq: 'offers[one].eligibleQuantity.minValue',
            images: 'image',
            weight: 'weight',
            dimensions: 'width / height',
            characteristics: 'additionalProperty',
        };
        for (const [key, value] of Object.entries(raw)) {
            if (value !== null && paths[key])
                evidence.push({ field: key, path: `JSON-LD selected Product.${paths[key]}` });
        }
        if (selected.hasVariant !== undefined) {
            const variants = Array.isArray(selected.hasVariant) ? selected.hasVariant : [selected.hasVariant];
            raw.variations = variants.slice(0, 100).map((entry) => {
                // Local @id references only; external documents are never requested.
                const local =
                    isRecord(entry) && entry['@id'] && Object.keys(entry).length === 1
                        ? nodes.find((node) => node['@id'] === entry['@id'])
                        : entry;
                if (!isRecord(local) || !hasType(local, 'Product')) {
                    warnings.push('UNRESOLVED_VARIANT');
                    return null;
                }
                return productFields(local, target, warnings);
            });
            evidence.push({ field: 'variations', path: 'JSON-LD selected Product.hasVariant' });
            if (variants.length > 100) warnings.push('VARIANT_LIMIT');
        }
    }
    const meta = (name: string): string | null => {
        const values = $('meta[property]')
            .toArray()
            .filter((element) => $(element).attr('property') === name)
            .map((element) => sourceText($(element).attr('content')))
            .filter((value) => value !== null);
        const unique = [...new Set(values)];
        return unique.length === 1 ? unique[0] : null;
    };
    // A generic page title is not evidence that the page is a product.
    const productPage = !!selected || (!candidates.length && meta('og:type') === 'product');
    if (productPage && !raw.title) {
        raw.title = meta('og:title');
        if (raw.title) evidence.push({ field: 'title', path: 'meta[property="og:title"]@content' });
    }
    if (productPage && (raw.images === undefined || raw.images === null)) {
        const images = $('meta[property="og:image"]')
            .toArray()
            .map((element) => absoluteUrl($(element).attr('content'), target.url));
        if (images.length) {
            raw.images = images;
            evidence.push({ field: 'images', path: 'meta[property="og:image"]@content' });
        }
    }
    if ($('script[type="application/json"]').length) warnings.push('APPLICATION_STATE_NOT_MAPPED');
    if (!selected) warnings.push('NO_VERIFIED_STRUCTURED_PRODUCT');
    const product = normalizeProduct(raw);
    return { product, evidence, warnings: [...new Set(warnings)] };
}
