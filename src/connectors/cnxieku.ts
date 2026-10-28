import { extractCnxiekuProduct } from '../extractors/cnxieku.js';
import type { ProductConnector } from './types.js';

export const cnxiekuConnector: ProductConnector = {
    source: 'cnxieku',
    // Public GET /robots.txt checked on 2026-10-28: HTTP 200, User-agent: *, Disallow: /.
    // Default stays blocked; real-request.ts accepts an explicit per-domain business declaration
    // covering both GET and the robots exception. The agreement itself has not been reviewed.
    status: 'blocked',
    reason: 'CNXieku: robots.txt respondió HTTP 200 con User-agent: * y Disallow: /. Falta configurar la autorización empresarial declarada para este dominio y su excepción de robots; no se consultó la ficha.',
    parseHtml: extractCnxiekuProduct,
    extractProduct() {
        throw new Error(cnxiekuConnector.reason);
    },
};
