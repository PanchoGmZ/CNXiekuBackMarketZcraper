# Mantenimiento

## Módulos

| Área | Archivos |
| --- | --- |
| Apify y persistencia | `src/main.ts`, `src/run.ts` |
| Entrada y permisos | `src/input.ts`, `src/url-policy.ts`, `src/real-request.ts` |
| Búsqueda CNXieku | `src/search.ts`, `src/cnxieku-search-request.ts`, `src/extractors/cnxieku-search.ts` |
| Ficha y analizadores | `src/process-product.ts`, `src/connectors/`, `src/extractors/` |
| HTTPS y límites | `src/https-transport.ts`, `src/request.ts`, `src/limits.ts` |
| Normalización y formato | `src/product.ts`, `src/result.ts`, `src/reference-1688.ts` |

Back Market usa el mismo transporte y analizador estructurado, sin dependencias
adicionales propias. Sus redirecciones admiten hasta dos saltos al mismo UUID,
dominio `www.backmarket.com` y región `en-us`, con validación por salto y sin ciclos.
`/testchallengepage` queda fuera de la ficha autorizada. No se ha resuelto ni
reintentado ese desafío. Se conserva el módulo, no una integración pública aprobada.

## Límites de operación

- Una ficha por invocación. Search: página oficial y una API de primera página,
  como máximo dos GET secuenciales, 20 candidatos y ninguna descarga de fichas.
- Timeout total 30 s por defecto, configurable 1–60; 2 MiB por respuesta
  descargada/descomprimida. Sin reintentos automáticos ni proxies de evasión.
- Dominios exactos, HTTPS, DNS público validado, dirección fijada, TLS e IP remota
  verificados. La configuración de ejemplo no amplía permisos automáticamente.
- 403, 429 y protecciones detienen el acceso. No se fabrican productos vacíos
  cuando falla el HTTP, la API o el análisis.
- `RUN_STATE` y `TIMINGS` distinguen rechazo previo a red, descarga, análisis y
  exportación; search conserva el HTTP y tiempo de cada GET.

## Dependencias

La auditoría guardada del 28 de octubre de 2026 y la instalación de la imagen
anterior registraron cinco entradas altas transitivas, cero críticas:

```text
apify-client → proxy-agent → pac-proxy-agent → get-uri → basic-ftp 5.3.1
```

La causa común es [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r),
consumo excesivo de CPU al analizar listados FTP. Se corrige desde `basic-ftp 6.2.1`,
pero el padre instalado exige `^5.0.2`. La revisión anterior no encontró una
actualización compatible hacia delante que solucionara esa cadena. El flujo
CNXieku utiliza HTTPS; la dependencia vulnerable sigue instalada. No se deben
ocultar las alertas ni forzar downgrades/overrides sin revisión y verificación.
No se modificaron versiones o lockfile ni se repitió la auditoría para esta limpieza.

Los paquetes de desarrollo heredados que no intervienen en los comandos actuales
se mantienen para no modificar dependencias sin aprobación. Las pruebas usan
`node:test`, no Vitest; `start:dev` sí usa tsx. Cualquier poda posterior debe
actualizar el lockfile de forma controlada.

## Construcción y publicación

Dockerfile y referencias de `.actor/actor.json` se conservan. La construcción
actual usa una base mutable, `npm install` y copia `.npmrc` después de instalar.
Funciona en la versión validada, pero no garantiza instalación congelada.
Fijar digest, usar `npm ci` y adelantar `.npmrc` requiere un cambio aprobado del
Dockerfile y nueva validación. La imagen de esta rama limpia no se ha reconstruido.

Antes de publicar: elegir visibilidad, revisar permisos de las muestras y licencia,
tratar el riesgo de dependencias y aprobar el despliegue correspondiente.
