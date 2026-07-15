# Documentación del software de análisis científico

Este documento describe las herramientas de análisis textual y estadístico
construidas para el estudio del corpus de revistas de la Edad de Plata
española: qué calcula cada una, con qué metodología, sobre qué datos, y
cómo consumirlas desde la API.

Todo el código vive en `src/api/analisis/` (controlador `analisis.ts` y
servicio `bigramas.ts`) y, para la búsqueda de texto libre, en
`src/api/buscar/`. La clasificación previa de cada artículo (sección 6) es
código aparte: `src/api/article/content-types/article/lifecycles.ts` (tipo
de artículo, por reglas) y `scripts/clasificar_temas_llm.js` (tema, por
LLM).

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

#### 4.8.2. Evolución tecnológica — `GET /analisis/publicidad/tecnologia`

Penetración de tecnologías concretas en la publicidad a lo largo del
tiempo, sobre 5 categorías curadas a mano (con sus listas de palabras
clave, sin tildes, en `CATEGORIAS_TECNOLOGICAS`): Automóviles, Radio,
Cinematógrafo, Teléfono, Electrodomésticos.

- **Metodología:** para cada anuncio y categoría, se comprueba si el texto
  contiene **al menos una** palabra clave de esa categoría (no cuenta
  ocurrencias repetidas dentro del mismo anuncio, para no sobreponderar un
  anuncio que repite la palabra varias veces); se cuenta 1 anuncio por
  categoría y año si la menciona.
- **Sin parámetros.** Devuelve las 5 series completas a la vez.
- **Ampliar categorías:** añadir una entrada a `CATEGORIAS_TECNOLOGICAS`
  en `analisis.ts` (categoría + lista de palabras clave sin diacríticos).

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

## 5. Búsqueda de texto — `GET /buscar/texto`

No es un análisis estadístico, pero comparte motor de texto con
concordancias: búsqueda exacta de hasta 3 términos encadenados con
operadores booleanos Y/O/NO (evaluados de izquierda a derecha, sin
precedencia), en el cuerpo y/o título/autor de los artículos. Excluye
anuncios igual que los análisis (regla 2), pero **no** está restringido a
artículos en español (regla 1): a diferencia de `/analisis/*`, el
buscador admite encontrar coincidencias en cualquier idioma.

## 6. Clasificación de artículos (tipo y tema)

Antes de llegar a cualquiera de los análisis de la sección 4, cada artículo
pasa por dos clasificaciones automáticas independientes, que no viven en
`analisis.ts`/`bigramas.ts` sino en el lifecycle del content-type y en un
script aparte. El resultado de ambas es lo que luego filtran las reglas
comunes de la sección 2 (`es_poema`, `es_obra_grafica`, `temas`).

### 6.1. Tipo de artículo (Poema / Obra gráfica / Prosa) — heurística por reglas

Código: `src/api/article/content-types/article/lifecycles.ts`. Se ejecuta en
`beforeCreate`/`beforeUpdate`, sobre el HTML del editor, sin LLM ni llamada
externa — determinista y gratis.

- **`esPoema`**: clasifica como poema si al menos la mitad de los bloques de
  párrafo/verso son de tipo `Estrofa` (proporción `estrofas / (estrofas +
  normales) >= 0.5`, no simple presencia), para no marcar como poema una
  prosa que solo cita un fragmento de verso.
- **`esObraGrafica`**: lámina, retrato u óleo — el artículo es solo uno o
  más bloques `imgbox` con `AutorI`/`TituloI` y sin ningún bloque de texto
  real (`Normal`/`Estrofa`/`Cita`). La presencia de `DescrI` descarta la
  clasificación, porque así se distingue de un anuncio (también `imgbox`
  sin texto, pero describe la imagen con `DescrI` en vez de `AutorI`/
  `TituloI`).
- Antes de clasificar, el HTML se pasa por `balancearDivs` (corrige `<div>`
  desbalanceados del OCR: cierres sobrantes, `imgbox` sin cerrar, aperturas
  sueltas) para que las dos heurísticas anteriores no fallen por marcado
  roto.
- **Corrección manual:** `/analisis/validador` (**Validador de tipo de
  artículo**), por revista — corrige falsos positivos/negativos de ambos
  clasificadores a mano, con checkboxes. Endpoints: `GET
  /analisis/validador/articulos?revista=` y `POST
  /analisis/validador/guardar` (`{ cambios: [{ documentId, es_poema,
  es_obra_grafica }] }`).

### 6.2. Tema/categoría del artículo — clasificador LLM

Código: `scripts/clasificar_temas_llm.js`, script standalone (no lifecycle;
se ejecuta a mano con `docker compose exec backend node
scripts/clasificar_temas_llm.js`, con `--slugs=` o `--limit=` opcionales).

- Modelo **gpt-4o-mini**, `temperature: 0`, `response_format: json_object`.
  Recorta el texto a los primeros 12000 caracteres de `texto_plano`.
- Excluye artículos ya marcados `es_poema` o `es_obra_grafica` (no son prosa
  temática) — por eso `lifecycles.ts` asigna automáticamente el tema fijo
  "Literatura y creación" (documentId `i6lv2b3ern6qf4432696c0kw`) a todo
  poema nuevo sin temas: los poemas nunca pasan por este clasificador, así
  que sin esa regla quedarían siempre sin clasificar.
- Pide una categoría **principal** obligatoria y una **secundaria**
  opcional (solo si el artículo dedica una parte realmente sustancial a un
  segundo tema independiente); el prompt indica explícitamente no usar
  "Historia" ni "Ciencias sociales y política" por defecto solo porque el
  texto sea antiguo o mencione una institución o figura pública, para
  reducir el sesgo del modelo hacia esas dos categorías.
- **Idempotente:** sin `--slugs=`, salta los artículos que ya tienen algún
  tema asignado.
- **Corrección manual:** `/analisis/validador-temas` (**Validador de temas
  dudosos**) — muestra solo los artículos a los que el LLM asignó *más de
  un tema* (los casos en que el propio modelo detectó ambigüedad), con
  checkboxes multi-selección para marcar/desmarcar temas. Endpoints: `GET
  /analisis/validador-temas/articulos` y `POST
  /analisis/validador-temas/guardar` (`{ cambios: [{ documentId, temaIds[]
  }] }`).

Ambas páginas de validación son herramientas internas: no están enlazadas
en la navegación ni el subnav de Análisis (solo accesibles con la URL
directa), protegidas igualmente por el `AnalisisGate` del layout de
`/analisis` (contraseña "revistas").

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
| `GET /analisis/publicidad/tecnologia` | Penetración de 5 categorías tecnológicas | — |
| `GET /analisis/publicidad/cadenas-lexicas` | Sucesores/predecesores + entropía (anuncios) | `palabra` |
| `GET /analisis/publicidad/vanguardia` | Distancia TF-IDF anuncios vs. literatura | — |
| `GET /buscar/texto` | Búsqueda booleana de texto literal | `q` |
| `GET /analisis/validador/articulos` | Artículos de una revista para corregir tipo (poema/obra gráfica) | `revista` |
| `POST /analisis/validador/guardar` | Guarda correcciones manuales de tipo | `cambios[]` |
| `GET /analisis/validador-temas/articulos` | Artículos con más de un tema (ambigüedad del LLM) | — |
| `POST /analisis/validador-temas/guardar` | Guarda correcciones manuales de temas | `cambios[]` |

## 8. Limitaciones conocidas

- **Estadística simple, no modelos de lenguaje — en los análisis (sección
  4), no en la clasificación (sección 6).** Concordancias, morfológica,
  estilométrico, innovación, nubes de palabras y cadenas léxicas se basan
  en frecuencias, TF-IDF y bigramas; no hay embeddings ni modelos
  preentrenados. Es deliberado (interpretabilidad y reproducibilidad), pero
  limita la sensibilidad a sinónimos, ironía, ambigüedad, etc. La
  clasificación por tema sí usa un LLM (gpt-4o-mini, sección 6.2), pero es
  un paso previo de etiquetado, no uno de los análisis servidos por la API.
- **Stemming, no lematización.** `PorterStemmerEs` reduce a una raíz
  heurística, no a la forma canónica de diccionario; puede agrupar o
  separar palabras de forma poco intuitiva en casos límite.
- **Sin desambiguación de sentido.** "Banco" (asiento/entidad financiera)
  se trata como una sola palabra.
- **Categorías tecnológicas y stopwords curadas a mano**, no generadas ni
  validadas estadísticamente — son un punto de partida razonable, no una
  taxonomía cerrada.
- **Caché en memoria, sin invalidación automática.** Si se importan
  artículos nuevos, los endpoints de cadenas léxicas (literarias y de
  publicidad) seguirán devolviendo el índice antiguo hasta que se llame
  con `reconstruir=true` o se reinicie Strapi.
- **Corpus pequeño en esta fase del proyecto.** Con pocas revistas
  importadas, los resultados (sobre todo de Publicidad e Innovación) son
  ilustrativos del funcionamiento de la herramienta, no todavía
  representativos del corpus completo de la Edad de Plata.
