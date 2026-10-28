import type { Product } from '../product.js';
import type { Source } from '../url-policy.js';

export interface ProductConnector {
    readonly source: Source;
    /** authorized requires reviewed permission from the source, never just development approval. */
    readonly status: 'blocked' | 'authorized';
    readonly reason: string;
    parseHtml(html: string, url: string): Product;
    extractProduct(): never;
}
