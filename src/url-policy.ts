import { isIP } from 'node:net';

export const supportedHosts = Object.freeze({
    'cnxieku.com': 'cnxieku',
    'www.cnxieku.com': 'cnxieku',
    'backmarket.com': 'back-market',
    'www.backmarket.com': 'back-market',
    'backmarket.es': 'back-market',
    'www.backmarket.es': 'back-market',
} as const);
export type Source = (typeof supportedHosts)[keyof typeof supportedHosts];
export interface ProductTarget {
    url: string;
    hostname: string;
    source: Source;
}
export class PolicyError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'PolicyError';
    }
}
function hasUnsafeCharacters(value: string): boolean {
    return (
        /[\s\\]/.test(value) ||
        Array.from(value).some((character) => {
            const code = character.charCodeAt(0);
            return code <= 31 || code === 127;
        })
    );
}
/** Exact hostname matching; recognition never implies permission to scrape. */
export function validateProductUrl(raw: unknown): ProductTarget {
    if (typeof raw !== 'string' || !raw || !/^https:\/\//i.test(raw) || hasUnsafeCharacters(raw)) {
        throw new PolicyError('UNSAFE_URL', 'Se requiere una URL HTTPS absoluta y sin caracteres ambiguos.');
    }
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new PolicyError('INVALID_URL', 'La URL no es válida.');
    }
    const authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/)[0];
    if (
        parsed.username ||
        parsed.password ||
        authority.includes('@') ||
        raw.includes('#') ||
        (parsed.port && parsed.port !== '443')
    ) {
        throw new PolicyError('UNSAFE_URL', 'No se admiten credenciales, fragmentos ni puertos alternativos.');
    }
    const hostname = parsed.hostname.toLowerCase();
    if (isIP(hostname.replace(/^\[|\]$/g, '')) || !Object.hasOwn(supportedHosts, hostname)) {
        throw new PolicyError(
            'UNSUPPORTED_DOMAIN',
            'El dominio no está admitido; no se permiten IPs o direcciones internas.',
        );
    }
    if (parsed.pathname === '/') {
        throw new PolicyError('PRODUCT_URL_REQUIRED', 'Se requiere la URL de un producto, no la portada del sitio.');
    }
    return Object.freeze({
        url: parsed.href,
        hostname,
        source: supportedHosts[hostname as keyof typeof supportedHosts],
    });
}
/** Conservatively reject private, local, multicast, documentation and transition ranges. */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
            (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
            (a === 203 && b === 0 && c === 113)
        );
    }
    if (family !== 6 || address.includes('%')) return false;
    const [first, second = '0'] = address.toLowerCase().split(':');
    const prefix = Number.parseInt(first, 16);
    const subnet = Number.parseInt(second || '0', 16);
    return (
        prefix >= 0x2000 &&
        prefix <= 0x3fff &&
        !(prefix === 0x2001 && (subnet <= 0x01ff || subnet === 0x0db8)) &&
        prefix !== 0x2002 &&
        !(prefix === 0x3fff && subnet <= 0x0fff)
    );
}
export interface ResolvedAddress {
    address: string;
    family: 4 | 6;
}
export function validateResolvedAddresses(addresses: ResolvedAddress[]): ResolvedAddress {
    if (
        !Array.isArray(addresses) ||
        !addresses.length ||
        addresses.some((entry) => !entry || isIP(entry.address) !== entry.family || !isPublicAddress(entry.address))
    ) {
        throw new PolicyError('UNSAFE_ADDRESS', 'La resolución contiene una dirección no pública o inválida.');
    }
    return addresses[0];
}
/** Back Market redirects may change the slug/query, never the product UUID, host or locale. */
export function backMarketProductId(target: ProductTarget): string | null {
    if (target.source !== 'back-market' || target.hostname !== 'www.backmarket.com') return null;
    return (
        /^\/en-us\/p\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
            .exec(new URL(target.url).pathname)?.[1]
            .toLowerCase() ?? null
    );
}
export function validateBackMarketRedirect(
    location: unknown,
    current: ProductTarget,
    original: ProductTarget,
): ProductTarget {
    if (typeof location !== 'string' || !location || hasUnsafeCharacters(location))
        throw new PolicyError('UNAUTHORIZED_REDIRECT', 'Redirección sin destino seguro.');
    try {
        const next = validateProductUrl(new URL(location, current.url).href);
        const id = backMarketProductId(original);
        if (!id || backMarketProductId(next) !== id)
            throw new Error('Redirect is outside the authorized product route or identity');
        return next;
    } catch {
        throw new PolicyError(
            'UNAUTHORIZED_REDIRECT',
            'El destino debe ser la misma ficha UUID en www.backmarket.com, ruta /en-us/p/slug/UUID; no se siguen desafíos ni rutas ajenas al producto.',
        );
    }
}
/** CNXieku and other scopes retain the original zero-redirect policy. */
export function rejectRedirect(location: unknown, target: ProductTarget): never {
    if (typeof location !== 'string' || !location || hasUnsafeCharacters(location)) {
        throw new PolicyError('UNAUTHORIZED_REDIRECT', 'Redirección sin destino seguro.');
    }
    try {
        const next = validateProductUrl(new URL(location, target.url).href);
        if (next.hostname !== target.hostname) throw new Error('Host change');
    } catch {
        throw new PolicyError('UNAUTHORIZED_REDIRECT', 'Redirección a un destino no autorizado.');
    }
    throw new PolicyError('REDIRECT_LIMIT', 'No se siguen redirecciones: el límite es una solicitud por producto.');
}
