import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

// Tests must remain offline even when the developer's shell has a real authorization profile.
delete process.env.TU_CUMPA_SOURCE_AUTHORIZATIONS;
function allowLoopback(hostname: unknown) {
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(hostname))) {
        throw new Error('Public network is disabled in tests; inject a saved response.');
    }
}
for (const module of [http, https]) {
    for (const method of ['request', 'get'] as const) {
        const original = module[method];
        module[method] = ((first: any, second: any, ...rest: any[]) => {
            const url = typeof first === 'string' || first instanceof URL ? new URL(first) : first;
            allowLoopback(second?.hostname ?? second?.host ?? url.hostname ?? url.host ?? 'localhost');
            return Reflect.apply(original, module, [first, second, ...rest]);
        }) as typeof module.request;
    }
}
const lookup = dns.lookup;
dns.lookup = ((hostname: string, ...args: any[]) => {
    allowLoopback(hostname);
    return Reflect.apply(lookup, dns, [hostname, ...args]);
}) as typeof lookup;
const promiseLookup = dns.promises.lookup;
dns.promises.lookup = ((hostname: string, ...args: any[]) => {
    allowLoopback(hostname);
    return Reflect.apply(promiseLookup, dns.promises, [hostname, ...args]);
}) as typeof promiseLookup;
syncBuiltinESMExports();
