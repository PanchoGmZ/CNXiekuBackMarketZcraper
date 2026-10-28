import { extractBackMarketProduct } from '../extractors/back-market.js';
import type { ProductConnector } from './types.js';

export const backMarketConnector: ProductConnector = {
    source: 'back-market',
    status: 'blocked',
    reason: 'Back Market requiere configurar la autorización empresarial declarada para www.backmarket.com, región US, locale en-us y su excepción de robots; el acuerdo no se ha revisado directamente.',
    parseHtml: extractBackMarketProduct,
    extractProduct() {
        throw new Error(backMarketConnector.reason);
    },
};
