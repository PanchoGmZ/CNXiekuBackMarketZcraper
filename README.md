# TU CUMPA — Product Scrapers

Actor de Apify para buscar productos CNXieku por palabra clave o código y extraer
una ficha por URL. Exporta datos canónicos o el JSON de referencia 1688. Usa
Node.js, TypeScript, Cheerio, Crawlee y Apify SDK.

CNXieku está validado con HTTPS público y con Docker, tanto en búsqueda como en
extracción. Back Market conserva su analizador y controles de redirección, pero
la integración pública está pendiente: su acceso devolvió `/testchallengepage`.
No se intenta superar esa protección.

## Requisitos e instalación

- Node.js 24 y npm; Git.
- Apify CLI para ejecutar el Actor localmente.
- Docker Desktop con contenedores Linux, si se usa Docker.
- OpenSSL para la prueba TLS local. En Windows se detecta el incluido con Git
  en `Program Files`; otra instalación puede indicarse con `OPENSSL_BIN`.

```powershell
git clone https://github.com/PanchoGmZ/CNXiekuBackMarketZcraper.git
cd CNXiekuBackMarketZcraper
npm ci
npm run build
```

## Configuración de acceso

El Actor bloquea las solicitudes públicas sin una declaración administrativa
por dominio. TU CUMPA comunicó autorización empresarial CNXieku; el acuerdo no se
ha revisado directamente. `config/` contiene modelos sin credenciales, no pruebas
de autorización. Cargarlos solo si el alcance está confirmado por la empresa:

```powershell
$env:TU_CUMPA_SOURCE_AUTHORIZATIONS = Get-Content ./config/cnxieku.example.json -Raw -Encoding UTF8
```

Este perfil comprende `www.cnxieku.com/item/ID`, `/search/` y el GET exacto
`/api/product/product/list`, con la excepción de robots declarada. No habilita
otros dominios. `config/back-market.example.json` conserva el alcance US previo;
no es necesario para CNXieku y no se carga automáticamente.

## Buscar y extraer

Búsqueda por código; para palabras clave usar el ejemplo `input.search.cnxieku.json`:

```powershell
apify run --no-purge --input-file examples/input.search.cnxieku-article.json
```

```json
{"mode":"search","source":"cnxieku","query":"1937","maxResults":10}
```

La salida es una lista de candidatos con `productId`, `title`, `url`, `price`,
`image` y `source`. `maxResults` admite 1–20, con 10 por defecto. No descarga las
fichas encontradas. Ejemplo real completo:
[búsqueda 1937](examples/cnxieku-search-article.docker-result.json).

Para extraer una ficha, ejecutar otra invocación con la URL elegida:

```powershell
apify run --no-purge --input-file examples/input.product.cnxieku-20354.json
```

```json
{"mode":"product","url":"https://www.cnxieku.com/item/20354","outputFormat":"reference1688"}
```

`reference1688` conserva once campos: `url`, `title`, `price`,
`productLadderPrices`, `moq`, `weight`, `dimensions`, `images`, `characteristics`,
`variations` y `productId`. `outputFormat: "canonical"` conserva el resultado con
estado y producto normalizado. Ejemplo real completo:
[producto 20354](examples/cnxieku-20354.docker.1688.json).

Los dos ejemplos son independientes: el producto 20354 no pertenece a la búsqueda
1937. La elección de una URL del listado siempre corresponde al consumidor.

## Resultados y errores

El dataset local queda en `storage/datasets/default/`. `RUN_STATE` y `TIMINGS`
se guardan en `storage/key_value_stores/default/`: contienen estado de negocio,
cantidad guardada, HTTP y tiempos. El almacenamiento local no se sincroniza a nube.
`--no-purge` conserva registros anteriores; respaldar INPUT antes de sustituirlo.

Los estados incluyen `success`, `partial`, `not_found`, `blocked`, `timeout` y
`error`; entradas no soportadas pueden producir `unsupported`. Un exit 0 puede
acompañar un rechazo de negocio: revisar el JSON y RUN_STATE. Los campos ausentes
quedan `null`. Un precio de búsqueda no confirma un SKU de la ficha; no se infiere
moneda ISO, MOQ, peso o dimensiones.

## Docker

```powershell
docker build --progress=plain --tag tucumpa-products:local .
```

Con esa imagen, usar almacenamiento nuevo y un archivo de entorno para preservar
las comillas del JSON en Windows:

```powershell
$actorStorage = Join-Path (Get-Location).Path ('docker-storage/run-' + [guid]::NewGuid().ToString('N'))
$kv = Join-Path $actorStorage 'key_value_stores/default'
New-Item -ItemType Directory -Force -Path $kv | Out-Null
Copy-Item ./examples/input.search.cnxieku-article.json (Join-Path $kv 'INPUT.json')
$authorization = Get-Content ./config/cnxieku.example.json -Raw -Encoding UTF8 | ConvertFrom-Json | ConvertTo-Json -Depth 12 -Compress
$environmentFile = Join-Path $actorStorage 'runtime.env'
$text = "APIFY_IS_AT_HOME=`nAPIFY_TOKEN=`nCRAWLEE_STORAGE_DIR=/usr/src/app/storage`nTU_CUMPA_SOURCE_AUTHORIZATIONS=$authorization`n"
[System.IO.File]::WriteAllText($environmentFile, $text, [System.Text.UTF8Encoding]::new($false))
docker run --rm --env-file $environmentFile --mount "type=bind,source=$actorStorage,target=/usr/src/app/storage" tucumpa-products:local
```

Para producto, cambiar únicamente el ejemplo de INPUT antes de un nuevo run.
En Docker local, `APIFY_IS_AT_HOME` debe quedar vacío; `0` y `false` son cadenas
no vacías para el SDK. No se necesita token Apify. El CMD es `node dist/main.js`;
no usar `npm start` en la etapa final, que no incluye TypeScript de desarrollo.

La versión funcional anterior se validó en Docker con producto 20354 (HTTP 200,
`partial`, 7,24 s) y búsqueda 1937 (página/API 200, `success`, 6,76 s). Esta limpieza
conserva los extractores y Dockerfile; no se construyó una imagen nueva.

## Desarrollo y comprobaciones

```powershell
npm test
npm run lint
npm run verify:offline
apify validate-schema
npm run check:actor
```

Las pruebas y `verify:offline` bloquean la red pública. Usan proyecciones
comerciales guardadas y envolturas Nuxt sintéticas identificadas como tales.
La prueba TLS genera una clave y certificado temporales con OpenSSL, usa solo
loopback y los elimina al terminar. No se distribuyen claves fijas ni HTML privado.
`verify:local` valida offline el último registro de una ejecución real, con su
input: `npm run verify:local -- examples/input.product.cnxieku-20354.json`.

`html` y `mock` permanecen disponibles para mantenimiento local; `prepare:html`
prepara un INPUT desde un archivo legítimamente suministrado. El Actor no admite
rutas de archivos en su entrada pública.

## Mantenimiento y pendientes

[docs/maintenance.md](docs/maintenance.md) describe módulos, límites y las cinco
alertas altas transitivas conocidas. No se aplicaron cambios de dependencias ni
de Dockerfile. Antes de producción faltan tratar esas alertas, endurecer la
reproducibilidad de la construcción y revisar directamente el acuerdo empresarial.
No se ha validado un run en Apify Cloud. El despliegue y los servicios de pago
requieren autorización; esta entrega no hace push ni despliegue.

La declaración de licencia ISC de `package.json` se conserva. El proyecto parte
de la plantilla Apify `ts-crawlee-cheerio`; se conservan sus metadatos y las
licencias de las dependencias. Confirmar titularidad y archivo LICENSE antes de
publicarlo como repositorio público.
