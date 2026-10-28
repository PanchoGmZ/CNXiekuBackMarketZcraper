import { createRequire } from 'node:module';

import type { CheerioCrawlingContext } from '@crawlee/cheerio';

import { isRecord } from '../product.js';
import type { SearchCandidate } from '../search.js';
import { PolicyError } from '../url-policy.js';
import { sourceId, sourceNumber, sourceText } from './values.js';

const crawlerRequire = createRequire(import.meta.resolve('@crawlee/cheerio'));
const { load } = crawlerRequire('cheerio') as { load(html: string): CheerioCrawlingContext['$'] };

/** Same observed Nuxt index-table representation as the product parser, limited to page identity and CDN base. */
export function analyzeCnxiekuSearchPage(html: string, pageUrl: string): { storageUrl: string | null } {
    const $ = load(html);
    const scripts = $('script#__NUXT_DATA__[type="application/json"][data-nuxt-data="nuxt-app"]');
    if (scripts.length !== 1)
        throw new PolicyError('SEARCH_PAGE_STRUCTURE_CHANGED', 'La página no contiene el estado Nuxt esperado.');
    let pool: unknown;
    try {
        pool = JSON.parse(scripts.text());
    } catch {
        throw new PolicyError('INVALID_SEARCH_STATE', 'El estado Nuxt de búsqueda es inválido.');
    }
    if (!Array.isArray(pool))
        throw new PolicyError('INVALID_SEARCH_STATE', 'El estado Nuxt no es una tabla de índices.');
    const node = (index: unknown, depth = 0): unknown => {
        if (depth > 8 || typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
        const value = pool[index];
        return Array.isArray(value) && value[0] === 'ShallowReactive' ? node(value[1], depth + 1) : value;
    };
    const field = (value: unknown, key: string): unknown =>
        isRecord(value) && Object.hasOwn(value, key) ? node(value[key]) : undefined;
    const root = node(0);
    const path = field(root, 'path');
    const expected = new URL(pageUrl);
    const actual = typeof path === 'string' ? new URL(path, expected.origin) : null;
    if (
        !actual ||
        actual.origin !== expected.origin ||
        actual.pathname !== '/search/' ||
        actual.searchParams.get('keyword') !== expected.searchParams.get('keyword') ||
        actual.searchParams.get('searchType') !== '1'
    )
        throw new PolicyError('SEARCH_PAGE_MISMATCH', 'El estado Nuxt no corresponde a la búsqueda solicitada.');
    const base = sourceText(field(field(field(root, 'pinia'), 'common'), 'storageUrl'));
    try {
        const url = base ? new URL(base) : null;
        return { storageUrl: url?.protocol === 'https:' && !url.username && !url.password ? url.href : null };
    } catch {
        return { storageUrl: null };
    }
}

/** Observed GET response: code=0, data.records, data.total. No unrelated arrays or embedded scripts. */
export function analyzeCnxiekuSearchData(
    raw: unknown,
    maxResults: number,
    storageUrl: string | null,
): {
    results: SearchCandidate[];
    skippedRows: number;
} {
    if (
        !isRecord(raw) ||
        raw.code !== 0 ||
        !isRecord(raw.data) ||
        !Array.isArray(raw.data.records) ||
        raw.data.records.length > 1000 ||
        !Number.isSafeInteger(raw.data.total) ||
        Number(raw.data.total) < 0
    )
        throw new PolicyError('INVALID_SEARCH_DATA', 'La respuesta no contiene el listado oficial esperado.');
    const results: SearchCandidate[] = [];
    const seen = new Set<string>();
    let skippedRows = 0;
    for (const row of raw.data.records) {
        if (!isRecord(row)) {
            skippedRows++;
            continue;
        }
        const id = sourceId(row.productId);
        const title = sourceText(row.productName);
        if (!id || !/^[1-9]\d{0,19}$/.test(id) || !title) {
            skippedRows++;
            continue;
        }
        // ProductCard's observed navigation is /item/${productId}; no URLs from untrusted fields are followed.
        const url = `https://www.cnxieku.com/item/${id}`;
        if (seen.has(url)) continue;
        seen.add(url);
        let image: string | null = null;
        const picture = sourceText(row.picThumb) ?? sourceText(row.picUrl);
        if (picture) {
            try {
                const resolved = storageUrl ? new URL(picture, storageUrl) : new URL(picture);
                if (
                    resolved.protocol === 'https:' &&
                    !resolved.username &&
                    !resolved.password &&
                    !/\s/.test(resolved.href)
                )
                    image = resolved.href;
            } catch {
                /* Optional image remains null. */
            }
        }
        const amount = sourceNumber(row.productPrice);
        results.push({
            productId: id,
            title,
            url,
            price: amount === null ? null : { amount, currency: null },
            image,
            source: 'cnxieku',
        });
        if (results.length >= maxResults) break;
    }
    if ((!results.length && raw.data.records.length) || (!raw.data.records.length && Number(raw.data.total) > 0))
        throw new PolicyError(
            'INVALID_SEARCH_DATA',
            'El listado no contiene candidatos verificables; no se interpreta como una búsqueda vacía.',
        );
    return { results, skippedRows };
}
