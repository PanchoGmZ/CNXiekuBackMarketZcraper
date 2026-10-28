import { json } from './helpers.js';

export const savedProductUrl = 'https://www.cnxieku.com/item/20274';
export function productHtml(pool: unknown[] = json('test/fixtures/cnxieku-20274.nuxt.json')): string {
    // Commercial data is authentic; this script envelope is synthetic and never executed.
    return '<script id="__NUXT_DATA__" type="application/json" data-nuxt-data="nuxt-app">' +
        JSON.stringify(pool).replace(/</g, '\\u003c') + '</script>';
}
export function searchPage(query: string): string {
    const url = new URL('https://www.cnxieku.com/search/');
    url.searchParams.set('keyword', query);
    url.searchParams.set('searchType', '1');
    return productHtml([{ pinia: 1, path: 4 }, { common: 2 }, { storageUrl: 3 },
        'https://oss.cnxieku.com/', url.pathname + url.search]);
}
