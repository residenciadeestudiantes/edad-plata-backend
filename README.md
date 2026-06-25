# Edad de Plata — Hemeroteca digital (backend)

Backend en [Strapi 5](https://strapi.io) de la hemeroteca digital de
revistas culturales de la Edad de Plata española. Sirve el contenido
(revistas, números, artículos, autores) y los endpoints de análisis
filológico/estadístico al [frontend Next.js](https://github.com/residenciadeestudiantes/edad-plata-frontend)
del repo hermano.

## Puesta en marcha

```bash
npm install
cp .env.example .env   # y rellena los secretos (APP_KEYS, *_SECRET, *_SALT, ENCRYPTION_KEY)
npm run develop
```

Por defecto arranca en `http://localhost:1337` (admin en `/admin`), con
SQLite (`.tmp/data.db`).

## Estructura relevante

- `src/api/` — content-types (`publication`, `issue`, `article`, `author`,
  `materia`, `page`...) y los controladores con lógica propia:
  - `src/api/analisis/` — endpoints de análisis filológico/estadístico
    (concordancias, estilométrico, innovación, cadenas léxicas, nubes de
    palabras, análisis de publicidad...). Ver
    [`docs/analisis-cientifico.md`](./docs/analisis-cientifico.md) para la
    metodología completa.
  - `src/api/buscar/` — buscador de texto.
- `excels/` — excels de origen para importar contenido (revistas, números,
  artículos, autores). **No se versiona** (ver `.gitignore`); cada quien
  guarda ahí los excels que le pasen para importar.
- `seed-*.js`, `grant-*.js` — scripts de importación, pensados para
  ejecutarse una vez con `node nombre-del-script.js [argumentos]` contra la
  base de datos local (usan `@strapi/strapi` directamente, sin necesidad
  de que el servidor esté arrancado, aunque también funcionan con él
  arrancado). Dos grupos:
  - **Importación de datos reales** (genéricos, reutilizables,
    parametrizados por el nombre del excel en `excels/`):
    `seed-numeros-revista.js`, `seed-articulos-revista.js`,
    `seed-ficha-revista.js`, `seed-ids-autores.js`. Casi todos son
    **idempotentes**: si se reejecutan, detectan lo ya importado (por id
    legado) y lo omiten en vez de duplicarlo.
  - **Datos de prueba** (`seed-test-data.js`, `seed-gaceta-literaria*.js`,
    `seed-paginas.js`): crean entradas ficticias para verificación manual;
    sus propios comentarios indican que se pueden borrar tras probar.
  - `grant-page-permissions.js` / `grant-materia-permissions.js`: conceden
    al rol público los permisos `find`/`findOne` de un content-type nuevo
    (necesario tras crear uno, ya que Strapi no lo hace solo).

### Inspeccionar un excel antes de escribir/ajustar un script de importación

Es opcional (los scripts de importación en sí son Node), pero útil para
mirar rápido el contenido de un `.xlsx` recién llegado a `excels/`:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python3 -c "
import openpyxl
wb = openpyxl.load_workbook('excels/archivo.xlsx', data_only=True)
ws = wb.active
for row in ws.iter_rows(min_row=1, max_row=10, values_only=True):
    print(row)
"
```

## Flujo de ramas

Ver [GIT_FLOW.md](./GIT_FLOW.md). En resumen: `develop` es la rama de
integración (todo el trabajo nuevo parte de ahí y vuelve ahí), `main` es
siempre desplegable. El repo es público, así que cualquiera puede
contribuir abriendo un PR desde un fork contra `develop`.

## Documentación adicional

- [`docs/analisis-cientifico.md`](./docs/analisis-cientifico.md) — metodología
  de los análisis filológicos/estadísticos.
- [`docs/despliegue-produccion.md`](./docs/despliegue-produccion.md) — migración
  de SQLite a PostgreSQL, almacenamiento de ficheros, HTTPS y CORS para producción.
- [`GIT_FLOW.md`](./GIT_FLOW.md) — flujo de ramas.
