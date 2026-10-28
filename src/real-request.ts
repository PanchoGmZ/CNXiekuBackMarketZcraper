import { lookup } from 'node:dns';

import { getConnector } from './connectors/index.js';
import { HttpTransportError } from './http-error.js';
import { createHttpsTransport } from './https-transport.js';
import { isRecord } from './product.js';
import type { RequestDependencies } from './request.js';
import {
    PolicyError,
    type ProductTarget,
    type ResolvedAddress,
    validateBackMarketRedirect,
    validateResolvedAddresses,
} from './url-policy.js';

export async function resolvePublicHostname(
    hostname: string,
    signal: AbortSignal,
    lookupFn: typeof lookup = lookup,
): Promise<ResolvedAddress[]> {
    if (signal.aborted) return Promise.reject(new PolicyError('RUN_ABORTED', 'La ejecución fue detenida.'));
    return new Promise((resolve, reject) => {
        let settled = false;
        const abort = (): void => {
            if (settled) return;
            settled = true;
            reject(new PolicyError('RUN_ABORTED', 'La ejecución fue detenida.'));
        };
        signal.addEventListener('abort', abort, { once: true });
        lookupFn(hostname, { all: true, verbatim: true }, (error, addresses) => {
            signal.removeEventListener('abort', abort);
            if (settled) return; // getaddrinfo cannot be cancelled; late results never open a socket.
            settled = true;
            if (error) {
                reject(new HttpTransportError('DNS_ERROR', 'No se pudo resolver el dominio.'));
                return;
            }
            try {
                const checked = addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
                validateResolvedAddresses(checked);
                resolve(checked);
            } catch (cause) {
                reject(cause);
            }
        });
    });
}
function requirePermission(target: ProductTarget): void {
    const connector = getConnector(target.source);
    if (connector.status === 'authorized') return;
    // Administrative config, exact domains only. This declaration is not a reviewed agreement.
    // Back Market's US scope is independent; it does not change CNXieku's grant or path rules.
    if (target.source === 'back-market' && process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS) {
        let declarations: unknown;
        try {
            declarations = JSON.parse(process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS);
        } catch {
            throw new PolicyError(
                'INVALID_SOURCE_AUTHORIZATION',
                'La configuración de autorización por dominio no es JSON válido.',
            );
        }
        const declaration =
            isRecord(declarations) && Object.hasOwn(declarations, target.hostname)
                ? declarations[target.hostname]
                : undefined;
        if (
            isRecord(declaration) &&
            declaration.permissionBasis === 'project-declared' &&
            declaration.allowProductGet === true
        ) {
            if (
                target.hostname !== 'www.backmarket.com' ||
                declaration.region !== 'US' ||
                declaration.locale !== 'en-us'
            )
                throw new PolicyError(
                    'SOURCE_NOT_AUTHORIZED',
                    'La autorización declarada de Back Market debe identificar el dominio www.backmarket.com, región US y locale en-us.',
                );
            if (declaration.robotsException !== true)
                throw new PolicyError(
                    'ROBOTS_EXCEPTION_REQUIRED',
                    'La autorización declarada debe cubrir explícitamente la excepción de robots para este dominio.',
                );
            if (
                !/^\/en-us\/p\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                    new URL(target.url).pathname,
                )
            )
                throw new PolicyError(
                    'PRODUCT_URL_REQUIRED',
                    'La autorización declarada cubre únicamente fichas Back Market US /en-us/p/slug/UUID.',
                );
            return;
        }
    }
    if (target.source === 'cnxieku' && process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS) {
        let declarations: unknown;
        try {
            declarations = JSON.parse(process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS);
        } catch {
            throw new PolicyError(
                'INVALID_SOURCE_AUTHORIZATION',
                'La configuración de autorización por dominio no es JSON válido.',
            );
        }
        const declaration =
            isRecord(declarations) && Object.hasOwn(declarations, target.hostname)
                ? declarations[target.hostname]
                : undefined;
        if (
            isRecord(declaration) &&
            declaration.permissionBasis === 'project-declared' &&
            declaration.allowProductGet === true
        ) {
            if (declaration.robotsException !== true)
                throw new PolicyError(
                    'ROBOTS_EXCEPTION_REQUIRED',
                    'La autorización declarada debe cubrir explícitamente la excepción de robots para este dominio.',
                );
            if (!/^\/item\/\d+$/.test(new URL(target.url).pathname))
                throw new PolicyError(
                    'PRODUCT_URL_REQUIRED',
                    'La autorización declarada cubre únicamente fichas CNXieku /item/ID.',
                );
            return;
        }
    }
    throw new PolicyError('SOURCE_NOT_AUTHORIZED', connector.reason);
}
/** Exact-domain, source-specific declarations. Injected I/O never bypasses this gate. */
export function createAuthorizedRequestDependencies(
    target: ProductTarget,
    controlledDependencies?: RequestDependencies,
): RequestDependencies {
    requirePermission(target);
    const transport = createHttpsTransport();
    return {
        async resolve(hostname, signal) {
            requirePermission(target);
            if (hostname !== target.hostname)
                throw new PolicyError('UNSUPPORTED_DOMAIN', 'El dominio no corresponde a la URL autorizada.');
            return controlledDependencies
                ? controlledDependencies.resolve(hostname, signal)
                : resolvePublicHostname(hostname, signal);
        },
        async transport(request) {
            requirePermission(target);
            if (request.url !== target.url) {
                if (target.source !== 'back-market')
                    throw new PolicyError('UNSUPPORTED_DOMAIN', 'La solicitud no corresponde al producto autorizado.');
                requirePermission(validateBackMarketRedirect(request.url, target, target));
            }
            return controlledDependencies ? controlledDependencies.transport(request) : transport(request);
        },
    };
}
