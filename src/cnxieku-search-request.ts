import { request as httpsRequest } from 'node:https';

import { createHttpsTransport } from './https-transport.js';
import { isRecord } from './product.js';
import { resolvePublicHostname } from './real-request.js';
import type { RequestDependencies } from './request.js';
import { PolicyError, type ProductTarget, validateProductUrl } from './url-policy.js';

function validKeyword(value: string | null): boolean {
    return (
        !!value?.trim() &&
        Array.from(value).length <= 200 &&
        !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    );
}

/** Exact official search route. Product and Back Market permissions are unaffected. */
export function validateCnxiekuSearchUrl(raw: string): ProductTarget {
    const target = validateProductUrl(raw);
    const url = new URL(target.url);
    if (
        target.hostname !== 'www.cnxieku.com' ||
        url.pathname !== '/search/' ||
        url.searchParams.getAll('keyword').length !== 1 ||
        !validKeyword(url.searchParams.get('keyword')) ||
        url.searchParams.getAll('searchType').length !== 1 ||
        url.searchParams.get('searchType') !== '1' ||
        [...url.searchParams.keys()].some((key) => !['keyword', 'searchType'].includes(key))
    )
        throw new PolicyError(
            'UNAUTHORIZED_SEARCH_URL',
            'Solo se admite www.cnxieku.com/search/ con keyword y searchType=1.',
        );
    return target;
}
export function requireCnxiekuSearchPermission(target: ProductTarget): void {
    const dataRequest = new URL(target.url).pathname === '/api/product/product/list';
    if (dataRequest) validateCnxiekuSearchDataUrl(target.url);
    else validateCnxiekuSearchUrl(target.url);
    let declarations: unknown;
    try {
        declarations = JSON.parse(process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS ?? '{}');
    } catch {
        throw new PolicyError('INVALID_SOURCE_AUTHORIZATION', 'La autorización por dominio no es JSON válido.');
    }
    const declaration =
        isRecord(declarations) && Object.hasOwn(declarations, 'www.cnxieku.com')
            ? declarations['www.cnxieku.com']
            : undefined;
    const search = isRecord(declaration) ? declaration.search : undefined;
    if (
        !isRecord(declaration) ||
        declaration.permissionBasis !== 'project-declared' ||
        declaration.robotsException !== true ||
        !isRecord(search) ||
        search.allowGet !== true ||
        search.path !== '/search/' ||
        search.searchType !== '1'
    )
        throw new PolicyError(
            'SEARCH_SCOPE_NOT_AUTHORIZED',
            'Se requiere autorización declarada específica para GET www.cnxieku.com/search/ con searchType=1 y excepción de robots.',
        );
    if (dataRequest && (search.allowDataGet !== true || search.dataPath !== '/api/product/product/list'))
        throw new PolicyError(
            'SEARCH_DATA_NOT_AUTHORIZED',
            'La carga dinámica requiere permiso específico para GET /api/product/product/list.',
        );
}
export function buildCnxiekuSearchDataUrl(query: string, maxResults: number): ProductTarget {
    const url = new URL('https://www.cnxieku.com/api/product/product/list');
    for (const [key, value] of Object.entries({
        page: '1',
        size: String(maxResults),
        keyword: query,
        productType: '8',
        sortType: '1',
        shopId: '-1',
    }))
        url.searchParams.set(key, value);
    return validateCnxiekuSearchDataUrl(url.href);
}
export function validateCnxiekuSearchDataUrl(raw: string): ProductTarget {
    const target = validateProductUrl(raw);
    const url = new URL(target.url);
    const allowed = ['page', 'size', 'keyword', 'productType', 'sortType', 'shopId'];
    if (
        target.hostname !== 'www.cnxieku.com' ||
        url.pathname !== '/api/product/product/list' ||
        [...url.searchParams.keys()].some((key) => !allowed.includes(key)) ||
        allowed.some((key) => url.searchParams.getAll(key).length !== 1) ||
        url.searchParams.get('page') !== '1' ||
        url.searchParams.get('productType') !== '8' ||
        url.searchParams.get('sortType') !== '1' ||
        url.searchParams.get('shopId') !== '-1' ||
        !/^(?:[1-9]|1[0-9]|20)$/.test(url.searchParams.get('size') ?? '') ||
        !validKeyword(url.searchParams.get('keyword'))
    )
        throw new PolicyError(
            'UNAUTHORIZED_SEARCH_URL',
            'Solo se permite la primera página del listado oficial, máximo 20 candidatos y parámetros autorizados.',
        );
    return target;
}
export function createCnxiekuSearchDependencies(
    target: ProductTarget,
    controlled?: RequestDependencies,
): RequestDependencies {
    requireCnxiekuSearchPermission(target);
    const isData = new URL(target.url).pathname === '/api/product/product/list';
    const transport = isData
        ? createHttpsTransport(
              (url, options, callback) =>
                  httpsRequest(url, { ...options, headers: { ...options.headers, 'x-client-type': 'pc' } }, callback),
              'cnxieku-json',
          )
        : createHttpsTransport();
    return {
        async resolve(hostname, signal) {
            requireCnxiekuSearchPermission(target);
            if (hostname !== target.hostname)
                throw new PolicyError('UNSUPPORTED_DOMAIN', 'El dominio no corresponde a la búsqueda autorizada.');
            return controlled ? controlled.resolve(hostname, signal) : resolvePublicHostname(hostname, signal);
        },
        async transport(request) {
            requireCnxiekuSearchPermission(target);
            if (request.url !== target.url || request.hostname !== target.hostname)
                throw new PolicyError(
                    'UNAUTHORIZED_SEARCH_URL',
                    'La solicitud no corresponde a la búsqueda autorizada.',
                );
            return controlled ? controlled.transport(request) : transport(request);
        },
    };
}
