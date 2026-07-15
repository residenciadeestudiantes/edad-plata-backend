# Documentación del software de análisis científico

Este documento describe las herramientas de análisis textual y estadístico
construidas para el estudio del corpus de revistas de la Edad de Plata
española: qué calcula cada una, con qué metodología, sobre qué datos, y
cómo consumirlas desde la API.

Todo el código vive en `src/api/analisis/` (controlador `analisis.ts` y
servicio `bigramas.ts`) y, para la búsqueda de texto libre, en
`src/api/buscar/`. Los procesos que generan las clasificaciones que estos
análisis consumen (sección 5) son scripts aparte, en `scripts/` y en la
raíz de `backend/`.

## 1. Estado del software: prototipo, no producto final

Todos los algoritmos están implementados en **Node.js/TypeScript dentro de
Strapi**, como prototipo de validación. El propio código lo señala
explícitamente:

> PROTOTIPO: cálculo TF-IDF implementado en Node.js para validación. En
> producción, este endpoint delegará en un microservicio FastAPI +
> scikit-learn que expone la misma interfaz JSON. El frontend no requerirá
> cambios.

Implicaciones prácticas:

- **Correctud sobre rendimiento.** Los algoritmos (TF-IDF, similitud de
  coseno, entropía de Shannon, n-gramas) son los estándar de la
  bibliografía, pero la implementación no está optimizada para corpus
  grandes (todo se calcula en memoria, en el proceso de Strapi).
- **Migración prevista, no realizada.** Si el corpus crece mucho o se
  necesita más rigor estadístico (smoothing distinto, lematización real en
  vez de stemming, TF-IDF con scikit-learn), el plan ya contemplado es
  mover este cálculo a un microservicio Python, manteniendo el mismo
  contrato JSON para no tocar el frontend.
- **Caché en memoria, no persistente.** El índice de bigramas (ver
  más abajo) se pierde al reiniciar Strapi y se reconstruye a demanda.

## 2. Reglas comunes a todos los análisis

Estas reglas se aplican de forma consistente en los 11 endpoints (con la
única excepción anotada en cada caso):

1. **Solo artículos en español** (`idioma = 'Español'`). Un artículo en
   francés, inglés, etc. nunca entra en ningún cálculo de análisis o
   búsqueda morfológica. Si se compara contra un autor que no tiene ningún
   artículo en español, la API lo señala explícitamente en vez de fallar
   con un mensaje genérico (ver estilométrico/innovación/cadenas léxicas
   más abajo).
2. **Los anuncios quedan fuera de los análisis "literarios"**
   (`es_anuncio = false` o vacío). Un artículo marcado como anuncio
   (`es_anuncio = true`) no cuenta en concordancias, estilométrico,
   innovación, nube de palabras, cadenas léxicas ni búsqueda morfológica
   "normales". Sí se cuenta en su propio bloque de análisis, el de
   **Publicidad** (sección 4), que usa el texto OCR del anuncio
   (`texto_ocr_anuncios`) en vez del cuerpo del artículo (`texto`).
3. **Solo contenido publicado** (`published_at` no nulo), tanto del
   artículo como de su número y revista.
4. **Limpieza de HTML.** El texto de los artículos está en HTML (el editor
   de Strapi); antes de tokenizar se elimina todo el marcado y se
   normalizan entidades (`&nbsp;`, `&amp;`...). Cada módulo tiene su propia
   función de limpieza (`htmlToPlainText` en el controlador,
   `limpiarHtml` en `bigramas.ts`) con reglas ligeramente distintas según
   si necesita conservar los desplazamientos de carácter (concordancias,
   para extraer el fragmento de contexto) o no.

## 3. Infraestructura compartida

### 3.1. Stopwords (`services/stopwords.ts`)

Lista de palabras vacías del español (artículos, pronombres, preposiciones,
conjunciones, formas de *ser*/*estar*/*haber*, interrogativos con y sin
tilde) usada por la función `tokenize()` del controlador y por
`tokenizarParaBigramas()` en `bigramas.ts`. Se excluyen porque son palabras
gramaticales de uso casi universal sin valor temático ni estilístico
propio: sin filtrarlas, dominarían cualquier nube de palabras o ranking de
frecuencias por delante de las palabras realmente informativas.

> ⚠️ **Nota de consistencia.** El frontend tiene su **propia** lista de
> stopwords (`frontend/lib/stopwords.ts`), independiente de esta, usada
> solo por la nube de palabras de un artículo individual
> (`components/NubePalabras.tsx`), que se calcula enteramente en el
> navegador a partir del HTML ya cargado, sin pasar por el backend. Las
> dos listas son ampliamente coincidentes pero no están sincronizadas: un
> cambio en una no se refleja automáticamente en la otra.

### 3.2. Índice de bigramas (`services/bigramas.ts`)

Estructura central para todo lo relacionado con "qué palabra suele ir junto
a esta otra" (cadenas léxicas, tanto literarias como publicitarias).

- **Qué construye:** recorriendo todos los artículos válidos (español, no
  anuncio o anuncio según el corpus, publicados), tokeniza el texto y
  cuenta:
  - `frecuenciasCorpus`: frecuencia total de cada palabra.
  - `indiceCorpus` / `indicePredecesores`: para cada palabra, qué palabras
    le siguen / preceden y con qué frecuencia (bigramas en ambas
    direcciones).
  - `frecuenciasAutor`, `indiceAutores`, `indicePredecesoresAutores`: lo
    mismo pero desglosado por autor (solo para el corpus literario; el de
    publicidad no lo necesita, casi ningún anuncio tiene autor).
- **Dos corpus independientes**, cada uno con su propia caché:
  - `'literario'` (por defecto): artículos que no son anuncios, texto de
    `texto`.
  - `'publicidad'`: artículos marcados como anuncio, texto de
    `texto_ocr_anuncios`.
- **Tokenización propia** (`tokenizarParaBigramas`): minúsculas, conserva
  guiones internos de palabras compuestas ("anglo-americano"), descarta
  tokens de menos de 3 caracteres y las stopwords.
- **Caché en memoria bajo demanda**: la primera consulta a un corpus lo
  construye (paginado, 100 artículos por tanda) y lo guarda; las
  siguientes reutilizan el índice. Se puede forzar la reconstrucción con
  `reconstruir=true` (por ejemplo, tras importar artículos nuevos).
- **Entropía de Shannon** (`calcularEntropiaShannon`): mide cuán
  impredecible es la palabra que sigue/precede a otra. 0 bits = siempre la
  misma palabra (uso totalmente convencional); a más bits, más variedad de
  combinaciones. Se normaliza dividiendo por el máximo teórico
  (`log2(número de sucesores distintos)`) para obtener un valor 0-1
  comparable entre palabras con vocabularios de tamaños distintos.
- **Fiabilidad mínima:** con menos de `FRECUENCIA_MINIMA_FIABLE = 5`
  apariciones de la palabra, el resultado se marca `fiable: false` y se
  avisa de que la interpretación no es estadísticamente sólida.

### 3.3. TF-IDF y similitud de coseno

Usado por estilométrico, innovación y la comparación de vanguardia
(publicidad). Implementación clásica con suavizado tipo scikit-learn:

```
tf(palabra, doc)  = nº apariciones en doc / nº total de palabras del doc
idf(palabra)      = ln((1 + N) / (1 + df(palabra))) + 1
tfidf(palabra,doc) = tf × idf
```

`N` = número de documentos comparados, `df` = en cuántos de esos documentos
aparece la palabra. El "+1" en el numerador y denominador de la IDF (*smooth
idf*) evita que, cuando solo se comparan 2 documentos y una palabra aparece
en ambos, su IDF se anule a 0 (que haría que la similitud de coseno fuera
siempre 0 sin importar el resto del vocabulario compartido).

La **distancia de coseno** entre dos vectores TF-IDF (`1 - similitud de
coseno`) es la medida final: 0 = mismo vocabulario y estilo, 1 = vocabularios
completamente distintos. Se interpreta en 5 zonas (`interpretarDistancia`):

| Distancia | Interpretación |
|---|---|
| < 0.2 | muy similar |
| < 0.4 | similar |
| < 0.6 | moderadamente distinto |
| < 0.8 | distinto |
| ≥ 0.8 | muy distinto |

## 4. Catálogo de análisis

### 4.1. Concordancias — `GET /analisis/concordancias`

Busca una palabra suelta (con límites de palabra, `\bpalabraB`) en el
cuerpo y el título de los artículos, y devuelve cada ocurrencia con su
fragmento de contexto, más agregados por revista, autor y año (para los
gráficos de barras/burbujas del frontend).

- **Parámetros:** `palabra` (obligatorio), `revista`, `autor`, `año`
  (todos opcionales, para acotar el ámbito).
- **Metodología de búsqueda:** la palabra y el texto se normalizan
  quitando diacríticos (`stripDiacritics`, normalización NFD) antes de
  comparar, así que "PERIÓDICO" encuentra "periodico" y viceversa.
- **Salida:** `totalOcurrencias`, `totalArticulos`, desglose `porRevista`,
  `porAutor`, `porAño` (con ocurrencias y nº de artículos), y la lista
  `concordancias` con cada fragmento.

### 4.2. Búsqueda morfológica — `GET /analisis/morfologica`

Como concordancias, pero reduce cada palabra a su raíz morfológica
(`PorterStemmerEs` de la librería `natural`) antes de comparar, así que
encuentra conjugaciones y variantes de número de la palabra buscada, no
solo la forma literal escrita. También admite **búsqueda por proximidad**:
indicando una segunda palabra y una distancia máxima (en número de
palabras), busca artículos donde ambas raíces aparezcan separadas por como
mucho esa distancia.

- **Parámetros:** `palabra` (≥3 caracteres), `palabra2` + `distancia`
  (proximidad, opcional), `enTituloAutor` / `enTexto` (ámbitos, por
  defecto ambos activos), `revista`, `autor`, `desde`/`hasta` (rango de
  años), `page`/`pageSize`.
- **Diferencia clave con concordancias:** usa la raíz (stem), no
  coincidencia literal ni de sustring — es deliberadamente más permisiva.

### 4.3. Estilométrico — `GET /analisis/estilometria`

Calcula la distancia TF-IDF/coseno entre el corpus completo de dos
autores, e identifica las palabras más características de cada uno (mayor
diferencia de peso TF-IDF a su favor).

- **Parámetros:** `autor1`, `autor2` (obligatorios, slugs distintos),
  `incluirFuncionales` (si es `true`, no filtra stopwords — útil porque la
  frecuencia de palabras funcionales es en sí misma un rasgo de estilo).
- **Salida:** `distancia_coseno`, `similitud_coseno`, `interpretacion`
  (las 5 zonas de la tabla anterior), `palabras_caracteristicas` (top 10
  por autor) y `nube_palabras` (frecuencias para la nube comparativa).
- **Aviso de datos insuficientes:** si un autor no tiene ningún artículo en
  español, la API responde `400` con el mensaje explícito
  `El autor "X" no tiene artículos en español` (en vez de un genérico "sin
  texto suficiente").

### 4.4. Nube de palabras de autor — `GET /analisis/nube-palabras-autor`

Frecuencia de palabras de todo el corpus de un autor (excluidos anuncios y
artículos no españoles), con la opción de acotar a una revista concreta
para comparar "todo el corpus" contra "su producción en esa revista".

- **Parámetros:** `autor` (obligatorio), `revista` (opcional).
- **Salida:** `corpus_completo` (frecuencias), y si se indicó `revista`,
  también `revista: { slug, titulo, num_articulos, palabras }`.

### 4.5. Nube de palabras de revista — `GET /analisis/nube-palabras-revista`

Igual que la de autor, pero a nivel de publicación: frecuencia de palabras
de todo el contenido publicado de una revista, con la opción de comparar
con **otra revista** distinta (no con un subconjunto de la misma).

- **Parámetros:** `revista` (obligatorio), `comparar` (opcional, slug de
  otra revista).
- **Salida:** `revista: { slug, titulo, num_articulos, palabras }` y
  `comparar` (mismo formato, o `null`).

### 4.6. Innovación estilística — `GET /analisis/innovacion`

Mide cuánto se aleja el estilo de cada autor solicitado de la "norma" del
corpus a lo largo del tiempo, para ver si su trayectoria converge hacia
esa norma o se aleja de ella (indicador de innovación).

- **Parámetros:** `autores` (1 a 4 slugs separados por comas).
- **Metodología:**
  1. La **norma** es el centroide TF-IDF de todos los autores del corpus
     (promedio de sus vectores), calculado sobre todo el corpus de
     referencia.
  2. Para cada autor solicitado, se agrupan sus artículos por año y se
     calcula, para cada año con texto suficiente, la distancia de coseno
     de ese año concreto al centroide. La serie de esos puntos en el
     tiempo es su `trayectoria`.
  3. Si la distancia decrece con el tiempo, el autor converge hacia la
     norma; si crece, se aleja de ella (esto lo interpreta el frontend,
     no el backend, con los umbrales `diferencia > 0.2` → innovador,
     `|diferencia| < 0.1` → estable, si no → convergente).
- **Avisos de fiabilidad:** si el corpus de referencia tiene menos de
  `UMBRAL_POCOS_AUTORES_NORMA = 5` autores, o un autor solicitado tiene
  menos de `UMBRAL_POCOS_ARTICULOS_AUTOR = 3` artículos, se incluye un
  `aviso_pocos_datos` explicando que los resultados pueden ser poco
  representativos/fiables. Si el autor no tiene **ningún** artículo en
  español, el aviso lo dice explícitamente.

### 4.7. Cadenas léxicas — `GET /analisis/cadenas-lexicas`

Sobre el índice de bigramas del corpus **literario**: dada una palabra,
qué palabras suelen ir antes/después de ella (con su probabilidad
condicional) y la entropía de esa distribución (variedad de uso). Permite
además comparar el uso de un autor concreto contra la norma del corpus
(con la "desviación": diferencia de probabilidad de cada sucesor entre el
autor y el corpus general).

- **Parámetros:** `palabra` (obligatorio), `autorSlug` (opcional),
  `reconstruir` (fuerza reconstruir el índice en caché).
- **Salida:** `corpus` (sucesores, predecesores, entropía, fiabilidad),
  `autor` (mismo desglose para ese autor, o `{ sinDatos: true }` si no
  tiene ocurrencias de esa palabra, o
  `{ sinDatos: true, sinArticulosEnEspanol: true }` si no tiene ningún
  artículo en español indexado), `metadatos` (fecha de construcción del
  índice, tamaño del corpus indexado).

### 4.8. Análisis de Publicidad

Cuatro endpoints bajo `/analisis/publicidad/*`, todos sobre artículos
marcados como anuncio (`es_anuncio = true`) y su texto OCR
(`texto_ocr_anuncios`), nunca mezclados con el corpus literario.

#### 4.8.1. Frecuencia y distribución — `GET /analisis/publicidad/frecuencia`

Qué se anuncia más, en qué revistas y en qué periodos: frecuencia de
palabras del texto OCR de los anuncios, más la distribución completa
(siempre sobre todo el corpus de anuncios, sin acotar) por revista y por
año.

- **Parámetros:** `revista`, `año` (opcionales; acotan solo las
  `palabras`, no la distribución).
- **Salida:** `total_anuncios`, `total_anuncios_filtrados`, `palabras`,
  `por_revista` (recuento por revista), `por_año` (recuento por año).

#### 4.8.2. Tendencias de producto en la publicidad — `GET /analisis/publicidad/tendencias`

Penetración de categorías de producto/servicio en la publicidad a lo largo
del tiempo. **Ya no usa coincidencia de palabras clave** (el método
original, con listas fijas como `CATEGORIAS_TECNOLOGICAS`, se sustituyó por
clasificación semántica por embeddings — metodología completa en §5.3, que
es exactamente la que usa este endpoint).

- **Parámetros:** `publicacion` (opcional, slug; acota a los anuncios de
  esa revista).
- **Categorías:** viven en la tabla `publicidad_categorias` (no en código),
  gestionables desde `/analisis/publicidad/categorias` (`GET`, listar),
  `/descubrir-categorias` (`POST`, sugiere categorías nuevas con LLM a
  partir de los títulos de anuncio del corpus), `/guardar-categorias`
  (`POST`, inserta las aceptadas) y `/toggle-categoria` (`POST`, activa o
  desactiva una sin borrarla — invalida su embedding cacheado). Semilla
  inicial: 12 categorías (Automóviles, Radio, Cinematógrafo, Teléfono,
  Electrodomésticos, Máquinas de escribir, Máquinas calculadoras,
  Fotografía, Libros y editoriales, Hoteles y turismo, Farmacia y
  laboratorios, Perfumería e higiene), pensada como punto de partida, no
  como lista cerrada.
- **Salida:** `total_anuncios` (con embedding disponible) y `categorias[]`
  con `serie` (nº de anuncios por año que superan el umbral de similitud
  con esa categoría).

#### 4.8.3. Lenguaje publicitario — `GET /analisis/publicidad/cadenas-lexicas`

Misma mecánica que las cadenas léxicas literarias (4.7), pero sobre el
índice de bigramas del corpus `'publicidad'` — qué palabras acompañan a un
término dentro de los anuncios (el adjetivo o reclamo con el que se suele
presentar). Sin desglose por autor (la inmensa mayoría de los anuncios no
tienen autor asociado).

- **Parámetros:** `palabra` (obligatorio), `reconstruir` (opcional).
- **Salida:** igual forma que el campo `corpus` de 4.7, más `metadatos`.

#### 4.8.4. Influencia de vanguardia — `GET /analisis/publicidad/vanguardia`

Hipótesis: ¿adoptó la publicidad el léxico de las vanguardias literarias
que convivían en las mismas páginas? Compara, con el mismo TF-IDF +
distancia de coseno que estilométrico (4.3), el corpus de anuncios contra
el corpus literario (no-anuncios) del mismo ámbito.

- **Parámetros:** `revista` (opcional), `numero_orden` (opcional, requiere
  `revista`). Sin parámetros, compara toda la colección.
- **Salida:** misma forma que `EstilometriaResponse` pero con las claves
  `anuncios`/`literatura` en vez de `autor1`/`autor2` (`num_articulos`,
  `distancia_coseno`, `similitud_coseno`, `palabras_caracteristicas`,
  `nube_palabras`, `interpretacion`) — deliberado, para reutilizar en el
  frontend los mismos componentes de gráfico (`NubePalabrasComparativa`,
  gráfico de barras de palabras características) sin duplicar UI.

## 5. Clasificación automática de artículos

A diferencia del resto del software (sección 4), que son análisis
estadísticos *bajo demanda* sobre texto ya clasificado, esta sección
describe los procesos que **generan** esa clasificación: qué campo
rellenan, con qué método, sobre qué corpus y cómo se corrige a mano el
resultado. Los tres corren como scripts batch (`backend/scripts/` o
`backend/*.js`), no como parte del ciclo normal de petición/respuesta de
la API — se ejecutan una vez por artículo (o por lote, tras una
importación), y el resultado queda persistido en la base de datos.

### 5.1. Clasificación estructural — `es_poema` / `es_obra_grafica`

**Heurística sobre el marcado HTML**, no sobre el contenido semántico del
texto. Los artículos importados conservan las clases CSS del documento de
origen (ver `CLASES_HTML.md`); estos scripts cuentan divs de ciertas
clases para inferir el tipo de contenido:

- **`scripts/populate_es_poema.js`** (`esPoema()`): cuenta divs
  `Estrofa*` frente a `Normal*` (tras descartar los saltos de página
  `<a class="page">` y los `Normal` vacíos). Si al menos la mitad de los
  bloques de texto son estrofas (`estrofas / total >= 0.5`), se marca
  `es_poema = true`.
- **`scripts/populate_es_obra_grafica.js`** (`esObraGrafica()`): se marca
  `es_obra_grafica = true` si el artículo tiene al menos un div `imgbox`
  (imagen) **y no** tiene ni `DescrI` (descripción/pie de obra) ni ningún
  div de texto real (`Normal`, `Estrofa` o `Cita`) — es decir, es
  contenido que consiste solo en imagen, sin prosa ni verso.
- **Alcance:** todos los artículos publicados (`published_at IS NOT
  NULL`); se ejecutan una vez sobre el histórico completo (backfill), no
  de forma incremental por artículo nuevo.
- **Por qué reglas y no un clasificador de texto:** la señal (estructura
  del documento original) es más fiable que el contenido para este caso
  concreto — un poema y su crítica pueden compartir vocabulario, pero no
  la proporción de estrofas frente a párrafos.

### 5.2. Clasificación temática — `temas` (`api::tema.tema`)

**Clasificación por LLM** (no heurística ni por embeddings). Asigna a
cada artículo una o dos categorías de un catálogo cerrado de 8 temas
(`seed-temas.js`): Ciencias y tecnología, Humanidades y filología, Artes
visuales y arquitectura, Ciencias sociales y política, Música y artes
escénicas, Literatura y creación, Filosofía y pensamiento, Historia.

- **Script:** `scripts/clasificar_temas_llm.js`. Modelo `gpt-4o-mini`,
  `temperature: 0`, `response_format: json_object`. Prompt: título +
  `texto_plano` (recortado a 12000 caracteres) + la lista de temas
  disponibles.
- **Categoría principal obligatoria, secundaria opcional.** El prompt
  pide explícitamente evitar una secundaria "de propina": solo debe
  aparecer si el artículo dedica una parte realmente sustancial a un
  segundo tema independiente. También instruye no usar "Historia" ni
  "Ciencias sociales y política" como cajón de sastre solo por la época,
  una fecha o una figura pública mencionada — deben ser el asunto
  central del artículo.
- **Alcance:** excluye poemas y obras gráficas (`es_poema = false`,
  `es_obra_grafica = false` — no son prosa de contenido temático).
  Filtrable por `--slugs=` o `--limit=` para pruebas parciales.
- **Idempotente:** al pasar por el corpus completo (sin `--slugs`), salta
  cualquier artículo que ya tenga algún tema asignado — no reclasifica ni
  gasta tokens de nuevo salvo que se le pidan slugs concretos.
- **Salida no determinista:** aunque `temperature: 0` reduce la
  variabilidad, sigue siendo un LLM — el mismo artículo podría recibir un
  tema distinto en dos ejecuciones si el texto es ambiguo entre dos
  categorías. Por eso existe la validación humana (§5.4).

### 5.3. Clasificación semántica — categorías de producto en anuncios

Comparte metodología con el endpoint de análisis `/analisis/publicidad/
tendencias` (§4.8.2): es la misma clasificación, documentada aquí en
detalle porque es el único caso del sistema que combina LLM (para
generar categorías) *y* embeddings (para aplicarlas).

- **Embeddings de anuncio:** cada artículo con `es_anuncio = true` tiene
  un embedding (`text-embedding-3-small`, 1536 dims, columna pgvector
  `embedding`) generado a partir de `texto_ocr_anuncios` (el texto OCR de
  la imagen del anuncio, no de `texto_plano` — ver nota de la sesión 18
  en `CONTEXTO.md`: en los anuncios ese campo está casi vacío).
- **Embeddings de categoría:** cada categoría es una frase conceptual
  corta (`concepto`, 8-15 palabras clave, p. ej. *"automóvil coche
  vehículo de motor gasolina neumático carrocería..."*), no una lista de
  keywords a buscar literalmente. Se embebe una vez y se cachea en
  memoria por nombre de categoría (`_cacheCatEmbeddings`); el caché se
  invalida al activar/desactivar una categoría o al reiniciar Strapi.
- **Clasificación = similitud de coseno por categoría, no una etiqueta
  única.** Para cada anuncio y cada categoría activa se calcula la
  similitud coseno entre sus dos embeddings; si supera
  `UMBRAL = 0.28`, ese anuncio "pertenece" a esa categoría **para esa
  serie temporal concreta**. Un mismo anuncio puede superar el umbral en
  varias categorías a la vez (multi-etiqueta, no una clasificación
  mutuamente excluyente).
- **Categorías generadas por LLM, no solo curadas a mano:**
  `descubrirCategorias` (`POST /analisis/publicidad/descubrir-categorias`)
  envía a `gpt-4o-mini` hasta 250 títulos de anuncio distintos del corpus
  junto con las categorías ya existentes, y le pide entre 5 y 10
  categorías nuevas no cubiertas todavía (nombre + concepto). Un humano
  revisa las sugerencias y las acepta con `guardarCategorias`
  (`POST /guardar-categorias`), que las inserta en `publicidad_categorias`
  evitando duplicados por nombre. `toggleCategoria` permite desactivar una
  categoría sin borrar su histórico.
- **Por qué embeddings y no palabras clave:** el método anterior
  (`CATEGORIAS_TECNOLOGICAS`, listas de keywords) fallaba con vocabulario
  indirecto y variantes morfológicas (p. ej. "HUDSON, 7 plazas,
  neumáticos cord" no se detectaba como automóvil sin la palabra literal
  "automóvil"/"coche"). La similitud semántica generaliza mejor a partir
  del concepto en vez de la coincidencia exacta de cadena.

### 5.4. Validación humana de las clasificaciones automáticas

Ninguna de las clasificaciones anteriores se trata como definitiva sin
revisión: hay endpoints dedicados a corregirlas a mano.

- **`GET /analisis/validador/articulos`** (parámetro `revista`) +
  **`POST /analisis/validador/guardar`**: lista todos los artículos
  publicados de una revista con sus valores actuales de `es_poema` /
  `es_obra_grafica` para que un humano los corrija en bloque.
- **`GET /analisis/validador-temas/articulos`** +
  **`POST /analisis/validador-temas/guardar`**: **no** lista todos los
  artículos clasificados, solo los "dudosos" — aquellos a los que el LLM
  asignó **más de un** tema (`temas.length > 1`), es decir, los casos en
  que el propio modelo detectó ambigüedad entre dos categorías. Es la
  forma de acotar la revisión humana a los pocos casos donde de verdad
  hace falta, en vez de revisar los ~2800 artículos uno a uno.

## 6. Búsqueda de texto — `GET /buscar/texto`

No es un análisis estadístico, pero comparte motor de texto con
concordancias: búsqueda exacta de hasta 3 términos encadenados con
operadores booleanos Y/O/NO (evaluados de izquierda a derecha, sin
precedencia), en el cuerpo y/o título/autor de los artículos. Excluye
anuncios igual que los análisis (regla 2), pero **no** está restringido a
artículos en español (regla 1): a diferencia de `/analisis/*`, el
buscador admite encontrar coincidencias en cualquier idioma.

## 7. Referencia rápida de endpoints

| Endpoint | Qué responde | Parámetro clave |
|---|---|---|
| `GET /analisis/concordancias` | Ocurrencias de una palabra + agregados | `palabra` |
| `GET /analisis/morfologica` | Como concordancias, con stemming y proximidad | `palabra` |
| `GET /analisis/estilometria` | Distancia TF-IDF entre 2 autores | `autor1`, `autor2` |
| `GET /analisis/nube-palabras-autor` | Frecuencias del corpus de un autor | `autor` |
| `GET /analisis/nube-palabras-revista` | Frecuencias del corpus de una revista | `revista` |
| `GET /analisis/innovacion` | Deriva estilística de hasta 4 autores en el tiempo | `autores` |
| `GET /analisis/cadenas-lexicas` | Sucesores/predecesores + entropía (literario) | `palabra` |
| `GET /analisis/publicidad/frecuencia` | Frecuencias y distribución de anuncios | — |
| `GET /analisis/publicidad/tendencias` | Penetración de categorías de producto por embeddings | `publicacion` |
| `GET /analisis/publicidad/categorias` | Lista las categorías de producto (activas e inactivas) | — |
| `POST /analisis/publicidad/descubrir-categorias` | LLM sugiere categorías nuevas a partir de títulos | — |
| `POST /analisis/publicidad/guardar-categorias` | Inserta las categorías sugeridas aceptadas | — |
| `POST /analisis/publicidad/toggle-categoria` | Activa/desactiva una categoría | `id` |
| `GET /analisis/publicidad/cadenas-lexicas` | Sucesores/predecesores + entropía (anuncios) | `palabra` |
| `GET /analisis/publicidad/vanguardia` | Distancia TF-IDF anuncios vs. literatura | — |
| `GET /analisis/validador/articulos` | Lista `es_poema`/`es_obra_grafica` de una revista para corregir | `revista` |
| `POST /analisis/validador/guardar` | Guarda correcciones de `es_poema`/`es_obra_grafica` | — |
| `GET /analisis/validador-temas/articulos` | Lista artículos con tema ambiguo (LLM asignó >1) | — |
| `POST /analisis/validador-temas/guardar` | Guarda la corrección humana de temas | — |
| `GET /buscar/texto` | Búsqueda booleana de texto literal | `q` |

## 8. Limitaciones conocidas

- **Estadística simple, no modelos de lenguaje — solo en los análisis de
  la sección 4.** Concordancias, morfológica, estilométrico, nubes de
  palabras, innovación y cadenas léxicas se basan en frecuencias, TF-IDF
  y bigramas, sin embeddings ni modelos preentrenados (deliberado, por
  interpretabilidad y reproducibilidad) — lo que limita su sensibilidad a
  sinónimos, ironía, ambigüedad, etc. Esto **no** aplica a las
  clasificaciones automáticas de la sección 5: la temática usa un LLM
  (`gpt-4o-mini`) y la de categorías de producto usa embeddings
  (`text-embedding-3-small`) precisamente para superar esa limitación en
  esos dos casos.
- **Stemming, no lematización.** `PorterStemmerEs` reduce a una raíz
  heurística, no a la forma canónica de diccionario; puede agrupar o
  separar palabras de forma poco intuitiva en casos límite.
- **Sin desambiguación de sentido.** "Banco" (asiento/entidad financiera)
  se trata como una sola palabra.
- **Clasificación por LLM, no determinista.** La clasificación temática
  (§5.2) puede variar entre ejecuciones en artículos ambiguos aunque use
  `temperature: 0`; se mitiga con la validación humana de casos
  multi-tema (§5.4), no eliminando la variabilidad de raíz.
- **Categorías de producto y stopwords sin validación estadística
  formal.** Las categorías de publicidad ya no son enteramente manuales
  (se pueden descubrir con LLM, §5.3), pero ni ellas ni las stopwords se
  han validado con una métrica cuantitativa (precisión/recall sobre un
  gold standard) — son un punto de partida razonable, no una taxonomía
  cerrada ni verificada.
- **Caché en memoria, sin invalidación automática.** Si se importan
  artículos nuevos, los endpoints de cadenas léxicas (literarias y de
  publicidad) seguirán devolviendo el índice antiguo hasta que se llame
  con `reconstruir=true` o se reinicie Strapi.
- **Corpus pequeño en esta fase del proyecto.** Con pocas revistas
  importadas, los resultados (sobre todo de Publicidad e Innovación) son
  ilustrativos del funcionamiento de la herramienta, no todavía
  representativos del corpus completo de la Edad de Plata.
