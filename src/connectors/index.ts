import type { Source } from '../url-policy.js';
import { backMarketConnector } from './back-market.js';
import { cnxiekuConnector } from './cnxieku.js';
import type { ProductConnector } from './types.js';

const connectors: Record<Source, ProductConnector> = {
    cnxieku: cnxiekuConnector,
    'back-market': backMarketConnector,
};
export function getConnector(source: Source): ProductConnector {
    return connectors[source];
}
