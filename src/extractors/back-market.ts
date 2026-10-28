import type { Product } from '../product.js';
import { validateProductUrl } from '../url-policy.js';
import { analyzeStructuredHtml, type HtmlAnalysis } from './structured-html.js';

export function analyzeBackMarketHtml(html: string, url: string): HtmlAnalysis {
    const target = validateProductUrl(url);
    if (target.source !== 'back-market') throw new TypeError('Expected a Back Market URL for this offline parser.');
    return analyzeStructuredHtml(html, target);
}
export function extractBackMarketProduct(html: string, url: string): Product {
    return analyzeBackMarketHtml(html, url).product;
}
