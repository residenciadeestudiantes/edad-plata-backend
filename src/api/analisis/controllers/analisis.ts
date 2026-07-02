
// PROTOTIPO: cálculo TF-IDF implementado en Node.js para validación.
// En producción, este endpoint delegará en un microservicio FastAPI + scikit-learn
// que expone la misma interfaz JSON. El frontend no requerirá cambios.

import type { Context } from 'koa';
import { PorterStemmerEs } from 'natural';
import {
  construirIndice,
  obtenerIndice,
  obtenerFechaConstruccion,
  calcularProbabilidades,
  calcularEntropiaShannon,
  type ProbabilidadToken,
} from '../services/bigramas';
import { STOPWORDS } from '../services/stopwords';

interface ArticleRow {
  article_id: number;
  articulo_titulo: string;
  articulo_slug: string;
  texto: string | null;
  numero_orden: number | null;
  anio: number | null;
  revista_titulo: string;
  revista_slug: string;
}

interface AuthorRow {
  article_id: number;
  nombre: string;
  slug: string;
}

interface Concordancia {
  articuloTitulo: string;
  articuloSlug: string;
  autores: string[];
  revista: string;
  numeroOrden: number | null;
  año: number | null;
  fragmento: string;
  enTitulo: boolean;
}

const CONTEXT_CHARS = 50;

// Quita las marcas diacríticas (tildes, diéresis) tras una normalización NFD,
// preservando la longitud de caracteres del texto original carácter a carácter
// para las vocales acentuadas españolas habituales.
function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Convierte el HTML almacenado en `texto` a texto plano, conservando tildes y
// mayúsculas, para poder buscar coincidencias y extraer contexto legible.
function htmlToPlainText(html: string | null): string {
  if (!html) return '';

  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Para la búsqueda con expansión morfológica: reduce una palabra a su raíz
// (stemming en español). Cubre conjugaciones verbales y variantes de número
// (cantar/cantaba/cantando, libro/libros) porque comparten la misma raíz,
// pero NO familias derivativas con sufijos distintos sobre bases distintas
// (libre/libertad/liberación) — para eso haría falta un diccionario de
// sinónimos. Es la misma limitación que tendría el diccionario "spanish" de
// PostgreSQL, que internamente también usa stemming Snowball.
function raizMorfologica(palabra: string): string {
  return PorterStemmerEs.stem(palabra.toLowerCase());
}

const WORD_REGEX_MORFOLOGICA = /[\p{L}\p{N}]+/gu;

interface OcurrenciaMorfologica {
  wordIndex: number;
  charIndex: number;
  texto: string;
  raiz: string;
}

function recopilarOcurrencias(plainText: string): OcurrenciaMorfologica[] {
  const ocurrencias: OcurrenciaMorfologica[] = [];
  let wordIndex = 0;
  for (const match of plainText.matchAll(WORD_REGEX_MORFOLOGICA)) {
    ocurrencias.push({
      wordIndex,
      charIndex: match.index ?? 0,
      texto: match[0],
      raiz: raizMorfologica(match[0]),
    });
    wordIndex += 1;
  }
  return ocurrencias;
}

// Fragmento de contexto para una coincidencia de una sola palabra: idéntico
// al de concordancias/buscar, con la palabra encontrada entre **asteriscos**.
function construirFragmentoMorfologico(plainText: string, ocurrencia: OcurrenciaMorfologica): string {
  const start = Math.max(0, ocurrencia.charIndex - CONTEXT_CHARS);
  const end = Math.min(plainText.length, ocurrencia.charIndex + ocurrencia.texto.length + CONTEXT_CHARS);
  const antes = collapseWhitespace(plainText.slice(start, ocurrencia.charIndex));
  const despues = collapseWhitespace(
    plainText.slice(ocurrencia.charIndex + ocurrencia.texto.length, end)
  );
  return `${antes} **${ocurrencia.texto}** ${despues}`.trim();
}

// Fragmento de contexto para una coincidencia de proximidad entre dos
// palabras: abarca desde la primera ocurrencia (en orden de aparición en el
// texto) hasta la segunda, con ambas resaltadas entre **asteriscos**.
function construirFragmentoProximidad(
  plainText: string,
  ocurrenciaA: OcurrenciaMorfologica,
  ocurrenciaB: OcurrenciaMorfologica
): string {
  const primera = ocurrenciaA.charIndex <= ocurrenciaB.charIndex ? ocurrenciaA : ocurrenciaB;
  const segunda = ocurrenciaA.charIndex <= ocurrenciaB.charIndex ? ocurrenciaB : ocurrenciaA;

  const start = Math.max(0, primera.charIndex - CONTEXT_CHARS);
  const end = Math.min(plainText.length, segunda.charIndex + segunda.texto.length + CONTEXT_CHARS);

  const antes = collapseWhitespace(plainText.slice(start, primera.charIndex));
  const entre = collapseWhitespace(
    plainText.slice(primera.charIndex + primera.texto.length, segunda.charIndex)
  );
  const despues = collapseWhitespace(plainText.slice(segunda.charIndex + segunda.texto.length, end));

  return `${antes} **${primera.texto}** ${entre} **${segunda.texto}** ${despues}`.trim();
}

// Tokeniza un texto en minúsculas, sin puntuación (conservando tildes y
// letras Unicode), separado por espacios. Filtra stopwords salvo que se pida
// `incluirFuncionales` (el análisis estilométrico permite incluirlas, ya que
// la frecuencia de palabras funcionales es en sí misma un rasgo de estilo).
function tokenize(text: string, opciones: { incluirFuncionales?: boolean } = {}): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);

  return opciones.incluirFuncionales ? tokens : tokens.filter((token) => !STOPWORDS.has(token));
}

interface EstilometriaAuthorRow {
  slug: string;
  nombre: string;
}

interface EstilometriaArticleRow {
  texto: string | null;
}

type TfIdfVector = Map<string, number>;

function buildTfIdf(
  tokensByDoc: string[][],
  vocabulario: string[]
): TfIdfVector[] {
  const N = tokensByDoc.length;

  const documentFrequency = new Map<string, number>();
  for (const palabra of vocabulario) {
    let df = 0;
    for (const tokens of tokensByDoc) {
      if (tokens.includes(palabra)) df += 1;
    }
    documentFrequency.set(palabra, df);
  }

  return tokensByDoc.map((tokens) => {
    const vector: TfIdfVector = new Map();
    const totalPalabras = tokens.length;

    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    for (const palabra of vocabulario) {
      const count = counts.get(palabra) ?? 0;
      if (count === 0 || totalPalabras === 0) {
        vector.set(palabra, 0);
        continue;
      }
      const tf = count / totalPalabras;
      const df = documentFrequency.get(palabra) ?? 0;
      // IDF suavizado (igual que scikit-learn con smooth_idf=True):
      // ln((1+N)/(1+df)) + 1. Con N=2 documentos, la fórmula clásica
      // ln(N/df) anula a 0 cualquier palabra presente en ambos documentos
      // (df=2 → ln(1)=0), lo que hace que la similitud de coseno sea
      // siempre 0 sin importar el solapamiento real de vocabulario. La
      // suavización evita esa degeneración.
      const idf = Math.log((1 + N) / (1 + df)) + 1;
      vector.set(palabra, tf * idf);
    }

    return vector;
  });
}

function cosineSimilarity(a: TfIdfVector, b: TfIdfVector, vocabulario: string[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const palabra of vocabulario) {
    const valA = a.get(palabra) ?? 0;
    const valB = b.get(palabra) ?? 0;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function interpretarDistancia(distancia: number): string {
  if (distancia < 0.2) return 'muy similar';
  if (distancia < 0.4) return 'similar';
  if (distancia < 0.6) return 'moderadamente distinto';
  if (distancia < 0.8) return 'distinto';
  return 'muy distinto';
}

interface PalabraFrecuencia {
  text: string;
  value: number;
}

const TOP_PALABRAS_NUBE = 150;

// Cuenta frecuencias de tokens ya tokenizados y devuelve las más frecuentes
// en el formato {text, value} que espera react-d3-cloud en el frontend.
function contarFrecuencias(tokens: string[]): PalabraFrecuencia[] {
  const conteo = new Map<string, number>();
  for (const token of tokens) {
    conteo.set(token, (conteo.get(token) ?? 0) + 1);
  }
  return [...conteo.entries()]
    .map(([text, value]) => ({ text, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP_PALABRAS_NUBE);
}

const COLORES_INNOVACION = ['#2563eb', '#dc2626', '#16a34a', '#ca8a04'];
const UMBRAL_POCOS_AUTORES_NORMA = 5;
const UMBRAL_POCOS_ARTICULOS_AUTOR = 3;

const FRECUENCIA_MINIMA_FIABLE = 5;

// Categorías iniciales que se insertan en publicidad_categorias si la tabla está vacía.
const CATEGORIAS_INICIALES = [
  {
    nombre: 'Automóviles',
    concepto: 'automóvil coche vehículo de motor gasolina neumático carrocería conducción automovilismo garage',
  },
  {
    nombre: 'Radio',
    concepto: 'radio receptor radiofónico emisión radiofónica altavoz galena ondas radiofonía radiorreceptor',
  },
  {
    nombre: 'Cinematógrafo',
    concepto: 'cine cinematógrafo película proyección fotográfica cinematografía film cámara fotográfica',
  },
  {
    nombre: 'Teléfono',
    concepto: 'teléfono telefonía comunicación telefónica centralita aparato telefónico',
  },
  {
    nombre: 'Electrodomésticos',
    concepto: 'electrodoméstico nevera frigorífico lavadora aspiradora plancha aparato eléctrico del hogar ventilador',
  },
  {
    nombre: 'Máquinas de escribir',
    concepto: 'máquina de escribir mecanografía teclado continental mercedes typewriter oficina mecanógrafo',
  },
  {
    nombre: 'Máquinas calculadoras',
    concepto: 'máquina calculadora sumadora calculatriz máquina aritmética lipsia cálculo contabilidad',
  },
  {
    nombre: 'Fotografía',
    concepto: 'fotografía cámara fotográfica revelado material fotográfico objetivos instantánea retrato fotógrafo',
  },
  {
    nombre: 'Libros y editoriales',
    concepto: 'libro editorial publicación librería obras literarias volumen edición imprenta catálogo obras completas',
  },
  {
    nombre: 'Hoteles y turismo',
    concepto: 'hotel parador hostal alojamiento turismo viaje albergue hospedaje pensión restaurante',
  },
  {
    nombre: 'Farmacia y laboratorios',
    concepto: 'farmacia medicamento laboratorio farmacéutico producto biológico suero medicina remedio',
  },
  {
    nombre: 'Perfumería e higiene',
    concepto: 'perfumería jabón colonia higiene cosmética perfume belleza tocador aseo personal crema',
  },
];

// Cache de embeddings de categorías (clave: nombre de categoría)
const _cacheCatEmbeddings = new Map<string, number[]>();

// Auto-crea la tabla publicidad_categorias y la puebla con CATEGORIAS_INICIALES si está vacía.
let _categoriasTableReady = false;
async function initCategoriasTable(knex: any) {
  if (_categoriasTableReady) return;
  await knex.schema.createTableIfNotExists('publicidad_categorias', (table: any) => {
    table.increments('id');
    table.string('nombre', 200).notNullable();
    table.text('concepto').notNullable();
    table.boolean('activa').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
  const row = await knex('publicidad_categorias').count('id as n').first();
  if (Number(row?.n) === 0) {
    await knex('publicidad_categorias').insert(CATEGORIAS_INICIALES);
  }
  _categoriasTableReady = true;
}

type CategoriaRow = { id: number; nombre: string; concepto: string; activa: boolean; grupo: string };

async function readCategorias(knex: any): Promise<CategoriaRow[]> {
  await initCategoriasTable(knex);
  return knex('publicidad_categorias').where({ activa: true }).orderBy('id');
}

function cosineSimilitud(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getEmbeddingTecnologia(text: string, apiKey: string): Promise<number[]> {
  const https = await import('https');
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) });
    const req = https.default.request({
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString());
        if (json.error) return reject(new Error(json.error.message));
        resolve(json.data[0].embedding as number[]);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

interface InterpretacionEntropia {
  nivel: 'insuficiente' | 'convencional' | 'moderado' | 'variado' | 'innovador';
  texto: string;
  fiable: boolean;
}

// Interpreta la entropía normalizada (0-1) de la distribución de palabras
// sucesoras: a mayor entropía, mayor variedad/impredecibilidad de uso.
function interpretarEntropia(entropiaNormalizada: number, fiable: boolean): InterpretacionEntropia {
  if (!fiable) {
    return {
      nivel: 'insuficiente',
      texto: `Frecuencia insuficiente (menos de ${FRECUENCIA_MINIMA_FIABLE} apariciones) para una interpretación fiable.`,
      fiable: false,
    };
  }
  if (entropiaNormalizada < 0.25) {
    return { nivel: 'convencional', texto: 'Uso muy predecible: casi siempre va seguida de las mismas palabras.', fiable: true };
  }
  if (entropiaNormalizada < 0.5) {
    return { nivel: 'moderado', texto: 'Uso moderadamente variado.', fiable: true };
  }
  if (entropiaNormalizada < 0.75) {
    return { nivel: 'variado', texto: 'Uso variado: aparece en contextos diversos.', fiable: true };
  }
  return {
    nivel: 'innovador',
    texto: 'Uso muy variado e innovador: se combina con un amplio abanico de términos distintos.',
    fiable: true,
  };
}

interface CadenasLexicasAutorRespuesta {
  slug: string;
  sinDatos?: boolean;
  sinArticulosEnEspanol?: boolean;
  sucesores?: (ProbabilidadToken & { probabilidadCorpus: number; desviacion: number })[];
  predecesores?: ProbabilidadToken[];
  entropia?: number;
  desviacionEntropia?: number;
  frecuenciaTotal?: number;
  fiable?: boolean;
  frecuenciaMinima?: number;
  entropiaNormalizada?: number;
  entropiaMaxima?: number;
  interpretacion?: InterpretacionEntropia;
}

export default {
  async concordancias(ctx: Context) {
    const palabra = ctx.query.palabra;

    if (!palabra || typeof palabra !== 'string' || palabra.trim().length === 0) {
      return ctx.badRequest('El parámetro "palabra" es obligatorio.');
    }

    const knex = strapi.db.connection;

    // Ámbito de la búsqueda: todo el corpus (por defecto), o acotado a una
    // revista, a un autor o a un año concretos.
    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';
    const autorSlug = typeof ctx.query.autor === 'string' ? ctx.query.autor.trim() : '';
    const anioRaw = typeof ctx.query.año === 'string' ? ctx.query.año.trim() : '';
    const anio = anioRaw && /^\d+$/.test(anioRaw) ? Number(anioRaw) : null;

    let articlesQuery = knex('articles as a')
      .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
      .innerJoin('issues as i', 'i.id', 'ail.issue_id')
      .innerJoin('issues_publication_lnk as ipl', 'ipl.issue_id', 'i.id')
      .innerJoin('publications as p', 'p.id', 'ipl.publication_id')
      .where('a.published_at', 'is not', null)
      .andWhere('i.published_at', 'is not', null)
      .andWhere('p.published_at', 'is not', null)
      .whereIn('a.idioma', ['es', 'Español'])
      .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'));

    if (revistaSlug) {
      articlesQuery = articlesQuery.andWhere('p.slug', revistaSlug);
    }

    if (anio !== null) {
      // La columna real en SQLite es `ano` (Strapi normaliza la ñ del nombre del campo).
      articlesQuery = articlesQuery.andWhere('i.ano', anio);
    }

    if (autorSlug) {
      const authorArticleIds: number[] = await knex('articles_authors_lnk as aal')
        .innerJoin('authors as au', 'au.id', 'aal.author_id')
        .where('au.slug', autorSlug)
        .andWhere('au.published_at', 'is not', null)
        .pluck('aal.article_id');

      articlesQuery = articlesQuery.whereIn('a.id', authorArticleIds.length > 0 ? authorArticleIds : [-1]);
    }

    const articleRows: ArticleRow[] = await articlesQuery.select(
      'a.id as article_id',
      'a.titulo as articulo_titulo',
      'a.slug as articulo_slug',
      'a.texto as texto',
      'i.numero_orden as numero_orden',
      'i.ano as anio',
      'p.titulo as revista_titulo',
      'p.slug as revista_slug'
    );

    if (articleRows.length === 0) {
      return ctx.send({
        palabra,
        totalOcurrencias: 0,
        totalArticulos: 0,
        porRevista: [],
        porAutor: [],
        porAño: [],
        por_año: [],
        por_autor_burbuja: [],
        concordancias: [],
      });
    }

    const articleIds = articleRows.map((row) => row.article_id);

    const authorRows: AuthorRow[] = await knex('articles_authors_lnk as aal')
      .innerJoin('authors as au', 'au.id', 'aal.author_id')
      .whereIn('aal.article_id', articleIds)
      .andWhere('au.published_at', 'is not', null)
      .select('aal.article_id as article_id', 'au.nombre as nombre', 'au.slug as slug');

    const authorsByArticle = new Map<number, { nombre: string; slug: string }[]>();
    for (const row of authorRows) {
      const list = authorsByArticle.get(row.article_id) ?? [];
      list.push({ nombre: row.nombre, slug: row.slug });
      authorsByArticle.set(row.article_id, list);
    }

    const normalizedWord = stripDiacritics(palabra.trim()).toLowerCase();
    const escapedWord = escapeRegExp(normalizedWord);
    const wordRegex = new RegExp(`\\b${escapedWord}\\b`, 'g');

    let totalOcurrencias = 0;
    let totalArticulos = 0;

    const porRevistaMap = new Map<
      string,
      { revista: string; slug: string; ocurrencias: number; articuloIds: Set<number> }
    >();
    const porAutorMap = new Map<
      string,
      { autor: string; slug: string; ocurrencias: number; articuloIds: Set<number> }
    >();
    const porAñoMap = new Map<
      number,
      { año: number; ocurrencias: number; articuloIds: Set<number> }
    >();
    const concordancias: Concordancia[] = [];

    for (const row of articleRows) {
      const plainText = collapseHtmlButKeepOffsets(row.texto);
      const normalizedText = stripDiacritics(plainText).toLowerCase();
      const normalizedTitulo = stripDiacritics(row.articulo_titulo ?? '').toLowerCase();

      const textMatches = [...normalizedText.matchAll(wordRegex)];
      const tituloMatches = [...normalizedTitulo.matchAll(wordRegex)];
      const totalMatchesArticulo = textMatches.length + tituloMatches.length;
      if (totalMatchesArticulo === 0) continue;

      totalArticulos += 1;
      totalOcurrencias += totalMatchesArticulo;

      const authors = authorsByArticle.get(row.article_id) ?? [];
      const authorNames = authors.map((a) => a.nombre);

      const revistaKey = row.revista_slug;
      const revistaEntry = porRevistaMap.get(revistaKey) ?? {
        revista: row.revista_titulo,
        slug: row.revista_slug,
        ocurrencias: 0,
        articuloIds: new Set<number>(),
      };
      revistaEntry.ocurrencias += totalMatchesArticulo;
      revistaEntry.articuloIds.add(row.article_id);
      porRevistaMap.set(revistaKey, revistaEntry);

      if (row.anio !== null) {
        const añoEntry = porAñoMap.get(row.anio) ?? {
          año: row.anio,
          ocurrencias: 0,
          articuloIds: new Set<number>(),
        };
        añoEntry.ocurrencias += totalMatchesArticulo;
        añoEntry.articuloIds.add(row.article_id);
        porAñoMap.set(row.anio, añoEntry);
      }

      for (const author of authors) {
        const autorEntry = porAutorMap.get(author.slug) ?? {
          autor: author.nombre,
          slug: author.slug,
          ocurrencias: 0,
          articuloIds: new Set<number>(),
        };
        autorEntry.ocurrencias += totalMatchesArticulo;
        autorEntry.articuloIds.add(row.article_id);
        porAutorMap.set(author.slug, autorEntry);
      }

      if (tituloMatches.length > 0) {
        concordancias.push({
          articuloTitulo: row.articulo_titulo,
          articuloSlug: row.articulo_slug,
          autores: authorNames,
          revista: row.revista_titulo,
          numeroOrden: row.numero_orden,
          año: row.anio,
          fragmento: row.articulo_titulo,
          enTitulo: true,
        });
      }

      for (const match of textMatches) {
        const index = match.index ?? 0;
        const start = Math.max(0, index - CONTEXT_CHARS);
        const end = Math.min(plainText.length, index + match[0].length + CONTEXT_CHARS);
        const fragmento = collapseWhitespace(plainText.slice(start, end));

        concordancias.push({
          articuloTitulo: row.articulo_titulo,
          articuloSlug: row.articulo_slug,
          autores: authorNames,
          revista: row.revista_titulo,
          numeroOrden: row.numero_orden,
          año: row.anio,
          fragmento,
          enTitulo: false,
        });
      }
    }

    const porRevista = [...porRevistaMap.values()]
      .map((entry) => ({
        revista: entry.revista,
        slug: entry.slug,
        ocurrencias: entry.ocurrencias,
        articulos: entry.articuloIds.size,
      }))
      .sort((a, b) => b.ocurrencias - a.ocurrencias);

    const porAutor = [...porAutorMap.values()]
      .map((entry) => ({
        autor: entry.autor,
        slug: entry.slug,
        ocurrencias: entry.ocurrencias,
        articulos: entry.articuloIds.size,
      }))
      .sort((a, b) => b.ocurrencias - a.ocurrencias);

    const porAño = [...porAñoMap.values()]
      .map((entry) => ({
        año: entry.año,
        ocurrencias: entry.ocurrencias,
        articulos: entry.articuloIds.size,
      }))
      .sort((a, b) => b.ocurrencias - a.ocurrencias);

    // Para el gráfico de línea temporal: mismos datos que porAño, pero en
    // orden cronológico y sin el desglose de artículos (no lo necesita Plotly).
    const por_año = [...porAñoMap.values()]
      .map((entry) => ({
        año: entry.año,
        ocurrencias: entry.ocurrencias,
      }))
      .sort((a, b) => a.año - b.año);

    // Para el gráfico de burbujas: mismos datos que porAutor, con los nombres
    // de campo que espera el componente de Plotly del frontend.
    const por_autor_burbuja = porAutor.map((entry) => ({
      autor: entry.autor,
      autor_slug: entry.slug,
      ocurrencias: entry.ocurrencias,
      num_articulos: entry.articulos,
    }));

    return ctx.send({
      palabra,
      totalOcurrencias,
      totalArticulos,
      porRevista,
      porAutor,
      porAño,
      por_año,
      por_autor_burbuja,
      concordancias,
    });
  },

  async estilometria(ctx: Context) {
    const autor1Slug = typeof ctx.query.autor1 === 'string' ? ctx.query.autor1.trim() : '';
    const autor2Slug = typeof ctx.query.autor2 === 'string' ? ctx.query.autor2.trim() : '';

    if (!autor1Slug || !autor2Slug) {
      return ctx.badRequest('Los parámetros "autor1" y "autor2" son obligatorios.');
    }

    if (autor1Slug === autor2Slug) {
      return ctx.badRequest('"autor1" y "autor2" deben ser autores distintos.');
    }

    const incluirFuncionales = ctx.query.incluirFuncionales === 'true';

    const knex = strapi.db.connection;

    async function cargarAutor(slug: string) {
      const author: EstilometriaAuthorRow | undefined = await knex('authors as au')
        .where('au.slug', slug)
        .andWhere('au.published_at', 'is not', null)
        .select('au.slug as slug', 'au.nombre as nombre')
        .first();

      if (!author) return null;

      const articleRows: EstilometriaArticleRow[] = await knex('articles_authors_lnk as aal')
        .innerJoin('articles as a', 'a.id', 'aal.article_id')
        .innerJoin('authors as au', 'au.id', 'aal.author_id')
        .where('au.slug', slug)
        .andWhere('au.published_at', 'is not', null)
        .andWhere('a.published_at', 'is not', null)
        .whereIn('a.idioma', ['es', 'Español'])
        .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'))
        .select('a.texto as texto');

      return { author, articleRows };
    }

    const [autor1Data, autor2Data] = await Promise.all([
      cargarAutor(autor1Slug),
      cargarAutor(autor2Slug),
    ]);

    if (!autor1Data) {
      return ctx.notFound(`No se ha encontrado el autor "${autor1Slug}".`);
    }
    if (!autor2Data) {
      return ctx.notFound(`No se ha encontrado el autor "${autor2Slug}".`);
    }

    if (autor1Data.articleRows.length === 0) {
      return ctx.badRequest(`El autor "${autor1Data.author.nombre}" no tiene artículos en español.`);
    }
    if (autor2Data.articleRows.length === 0) {
      return ctx.badRequest(`El autor "${autor2Data.author.nombre}" no tiene artículos en español.`);
    }

    const texto1 = autor1Data.articleRows.map((row) => htmlToPlainText(row.texto)).join(' ');
    const texto2 = autor2Data.articleRows.map((row) => htmlToPlainText(row.texto)).join(' ');

    const tokens1 = tokenize(texto1, { incluirFuncionales });
    const tokens2 = tokenize(texto2, { incluirFuncionales });

    if (tokens1.length === 0) {
      return ctx.badRequest(`El autor "${autor1Data.author.nombre}" no tiene texto suficiente para el análisis.`);
    }
    if (tokens2.length === 0) {
      return ctx.badRequest(`El autor "${autor2Data.author.nombre}" no tiene texto suficiente para el análisis.`);
    }

    const vocabulario = [...new Set([...tokens1, ...tokens2])];

    const [vector1, vector2] = buildTfIdf([tokens1, tokens2], vocabulario);

    const similitudCoseno = cosineSimilarity(vector1, vector2, vocabulario);
    const distanciaCoseno = 1 - similitudCoseno;

    const diferencias = vocabulario.map((palabra) => {
      const peso1 = vector1.get(palabra) ?? 0;
      const peso2 = vector2.get(palabra) ?? 0;
      return { palabra, diferencia: peso1 - peso2, peso1, peso2 };
    });

    const palabrasAutor1 = [...diferencias]
      .sort((a, b) => b.diferencia - a.diferencia)
      .slice(0, 10)
      .map((entry) => ({ palabra: entry.palabra, peso: entry.peso1 }));

    const palabrasAutor2 = [...diferencias]
      .sort((a, b) => a.diferencia - b.diferencia)
      .slice(0, 10)
      .map((entry) => ({ palabra: entry.palabra, peso: entry.peso2 }));

    return ctx.send({
      autor1: {
        slug: autor1Data.author.slug,
        nombre: autor1Data.author.nombre,
        num_articulos: autor1Data.articleRows.length,
      },
      autor2: {
        slug: autor2Data.author.slug,
        nombre: autor2Data.author.nombre,
        num_articulos: autor2Data.articleRows.length,
      },
      distancia_coseno: distanciaCoseno,
      similitud_coseno: similitudCoseno,
      palabras_caracteristicas: {
        autor1: palabrasAutor1,
        autor2: palabrasAutor2,
      },
      nube_palabras: {
        autor1: contarFrecuencias(tokens1),
        autor2: contarFrecuencias(tokens2),
      },
      interpretacion: interpretarDistancia(distanciaCoseno),
    });
  },

  async nubePalabrasAutor(ctx: Context) {
    const autorSlug = typeof ctx.query.autor === 'string' ? ctx.query.autor.trim() : '';
    if (!autorSlug) {
      return ctx.badRequest('El parámetro "autor" es obligatorio.');
    }
    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';

    const knex = strapi.db.connection;

    const autorInfo: { slug: string; nombre: string } | undefined = await knex('authors')
      .where('slug', autorSlug)
      .andWhere('published_at', 'is not', null)
      .select('slug', 'nombre')
      .first();

    if (!autorInfo) {
      return ctx.notFound(`No se ha encontrado el autor "${autorSlug}".`);
    }

    const filas: { texto: string | null; revista_slug: string; revista_titulo: string }[] = await knex(
      'articles_authors_lnk as aal'
    )
      .innerJoin('authors as au', 'au.id', 'aal.author_id')
      .innerJoin('articles as a', 'a.id', 'aal.article_id')
      .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
      .innerJoin('issues as i', 'i.id', 'ail.issue_id')
      .innerJoin('issues_publication_lnk as ipl', 'ipl.issue_id', 'i.id')
      .innerJoin('publications as p', 'p.id', 'ipl.publication_id')
      .where('au.slug', autorSlug)
      .andWhere('au.published_at', 'is not', null)
      .andWhere('a.published_at', 'is not', null)
      .andWhere('i.published_at', 'is not', null)
      .andWhere('p.published_at', 'is not', null)
      .whereIn('a.idioma', ['es', 'Español'])
      .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'))
      .select('a.texto as texto', 'p.slug as revista_slug', 'p.titulo as revista_titulo');

    const corpusCompleto = contarFrecuencias(tokenize(filas.map((f) => htmlToPlainText(f.texto)).join(' ')));

    let revista: { slug: string; titulo: string; num_articulos: number; palabras: PalabraFrecuencia[] } | null =
      null;

    if (revistaSlug) {
      const publicacion: { titulo: string } | undefined = await knex('publications')
        .where('slug', revistaSlug)
        .andWhere('published_at', 'is not', null)
        .select('titulo')
        .first();

      if (publicacion) {
        const filasRevista = filas.filter((f) => f.revista_slug === revistaSlug);
        revista = {
          slug: revistaSlug,
          titulo: publicacion.titulo,
          num_articulos: filasRevista.length,
          palabras: contarFrecuencias(
            tokenize(filasRevista.map((f) => htmlToPlainText(f.texto)).join(' '))
          ),
        };
      }
    }

    return ctx.send({
      autor: { slug: autorInfo.slug, nombre: autorInfo.nombre, num_articulos: filas.length },
      corpus_completo: corpusCompleto,
      revista,
    });
  },

  // Nube de palabras de todo el contenido publicado de una revista, con la
  // opción de comparar con otra revista (misma lógica que nubePalabrasAutor,
  // pero a nivel de publicación en vez de autor).
  async nubePalabrasRevista(ctx: Context) {
    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';
    if (!revistaSlug) {
      return ctx.badRequest('El parámetro "revista" es obligatorio.');
    }
    const compararSlug = typeof ctx.query.comparar === 'string' ? ctx.query.comparar.trim() : '';

    const knex = strapi.db.connection;

    async function cargarRevista(slug: string) {
      const publicacion: { titulo: string } | undefined = await knex('publications')
        .where('slug', slug)
        .andWhere('published_at', 'is not', null)
        .select('titulo')
        .first();

      if (!publicacion) return null;

      const filas: { texto: string | null }[] = await knex('articles as a')
        .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
        .innerJoin('issues as i', 'i.id', 'ail.issue_id')
        .innerJoin('issues_publication_lnk as ipl', 'ipl.issue_id', 'i.id')
        .innerJoin('publications as p', 'p.id', 'ipl.publication_id')
        .where('p.slug', slug)
        .andWhere('a.published_at', 'is not', null)
        .andWhere('i.published_at', 'is not', null)
        .andWhere('p.published_at', 'is not', null)
        .whereIn('a.idioma', ['es', 'Español'])
        .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'))
        .select('a.texto as texto');

      return {
        slug,
        titulo: publicacion.titulo,
        num_articulos: filas.length,
        palabras: contarFrecuencias(tokenize(filas.map((f) => htmlToPlainText(f.texto)).join(' '))),
      };
    }

    const revista = await cargarRevista(revistaSlug);
    if (!revista) {
      return ctx.notFound(`No se ha encontrado la revista "${revistaSlug}".`);
    }

    let comparar: Awaited<ReturnType<typeof cargarRevista>> = null;
    if (compararSlug) {
      comparar = await cargarRevista(compararSlug);
      if (!comparar) {
        return ctx.notFound(`No se ha encontrado la revista "${compararSlug}".`);
      }
    }

    return ctx.send({ revista, comparar });
  },

  async innovacion(ctx: Context) {
    const autoresRaw = typeof ctx.query.autores === 'string' ? ctx.query.autores : '';
    const slugsSolicitados = [
      ...new Set(autoresRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)),
    ];

    if (slugsSolicitados.length === 0 || slugsSolicitados.length > 4) {
      return ctx.badRequest(
        'El parámetro "autores" debe incluir entre 1 y 4 slugs de autor separados por comas.'
      );
    }

    const modo: 'prosa' | 'poesia' = ctx.query.modo === 'poesia' ? 'poesia' : 'prosa';
    const etiqueta = modo === 'poesia' ? 'poema(s)' : 'artículo(s)';

    const knex = strapi.db.connection;

    const autoresInfo: { slug: string; nombre: string }[] = await knex('authors')
      .whereIn('slug', slugsSolicitados)
      .andWhere('published_at', 'is not', null)
      .select('slug', 'nombre');

    const autoresInfoPorSlug = new Map(autoresInfo.map((a) => [a.slug, a]));
    const slugFaltante = slugsSolicitados.find((slug) => !autoresInfoPorSlug.has(slug));
    if (slugFaltante) {
      return ctx.notFound(`No se ha encontrado el autor "${slugFaltante}".`);
    }

    // Filtra por tipo de texto según el modo seleccionado
    const filtroModo = (qb: ReturnType<typeof knex>) => {
      if (modo === 'poesia') {
        qb.where('a.es_poema', true);
      } else {
        qb.where((inner) => inner.where('a.es_poema', false).orWhereNull('a.es_poema'));
      }
    };

    // Corpus de referencia: todos los autores publicados con artículos del
    // tipo seleccionado, para calcular la norma (centroide TF-IDF).
    const filasReferencia: { autor_slug: string; texto: string | null }[] = await knex(
      'articles_authors_lnk as aal'
    )
      .innerJoin('authors as au', 'au.id', 'aal.author_id')
      .innerJoin('articles as a', 'a.id', 'aal.article_id')
      .where('au.published_at', 'is not', null)
      .andWhere('a.published_at', 'is not', null)
      .whereIn('a.idioma', ['es', 'Español'])
      .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'))
      .andWhere(filtroModo)
      .select('au.slug as autor_slug', 'a.texto as texto');

    const textosPorAutor = new Map<string, string[]>();
    for (const fila of filasReferencia) {
      const textos = textosPorAutor.get(fila.autor_slug) ?? [];
      textos.push(fila.texto ?? '');
      textosPorAutor.set(fila.autor_slug, textos);
    }

    const slugsReferencia: string[] = [];
    const tokensReferencia: string[][] = [];
    for (const [slug, textos] of textosPorAutor) {
      const tokens = tokenize(textos.map(htmlToPlainText).join(' '));
      if (tokens.length === 0) continue;
      slugsReferencia.push(slug);
      tokensReferencia.push(tokens);
    }

    if (slugsReferencia.length === 0) {
      return ctx.badRequest('No hay suficientes datos en el corpus para calcular la innovación estilística.');
    }

    // Artículos del mismo tipo por autor y año, para la trayectoria temporal.
    const filasPorAnio: {
      autor_slug: string;
      texto: string | null;
      anio: number | null;
      article_slug: string;
      article_titulo: string;
    }[] = await knex('articles_authors_lnk as aal')
      .innerJoin('authors as au', 'au.id', 'aal.author_id')
      .innerJoin('articles as a', 'a.id', 'aal.article_id')
      .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
      .innerJoin('issues as i', 'i.id', 'ail.issue_id')
      .whereIn('au.slug', slugsSolicitados)
      .andWhere('au.published_at', 'is not', null)
      .andWhere('a.published_at', 'is not', null)
      .andWhere('i.published_at', 'is not', null)
      .whereIn('a.idioma', ['es', 'Español'])
      .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'))
      .andWhere(filtroModo)
      .select(
        'au.slug as autor_slug',
        'a.texto as texto',
        'i.ano as anio',
        'a.slug as article_slug',
        'a.titulo as article_titulo',
      );

    const aniosPorAutor = new Map<string, Map<number, string[]>>();
    const articulosPorAutorAnio = new Map<string, Map<number, { slug: string; titulo: string }[]>>();
    const totalArticulosPorAutor = new Map<string, number>();
    for (const fila of filasPorAnio) {
      totalArticulosPorAutor.set(fila.autor_slug, (totalArticulosPorAutor.get(fila.autor_slug) ?? 0) + 1);
      if (fila.anio === null) continue;

      const porAnio = aniosPorAutor.get(fila.autor_slug) ?? new Map<number, string[]>();
      const textos = porAnio.get(fila.anio) ?? [];
      textos.push(fila.texto ?? '');
      porAnio.set(fila.anio, textos);
      aniosPorAutor.set(fila.autor_slug, porAnio);

      const porAnioArts = articulosPorAutorAnio.get(fila.autor_slug) ?? new Map<number, { slug: string; titulo: string }[]>();
      const arts = porAnioArts.get(fila.anio) ?? [];
      arts.push({ slug: fila.article_slug, titulo: fila.article_titulo });
      porAnioArts.set(fila.anio, arts);
      articulosPorAutorAnio.set(fila.autor_slug, porAnioArts);
    }

    const puntosTrayectoria: { autorSlug: string; anio: number }[] = [];
    const tokensPuntos: string[][] = [];
    for (const slug of slugsSolicitados) {
      const porAnio = aniosPorAutor.get(slug) ?? new Map<number, string[]>();
      for (const [anio, textos] of porAnio) {
        const tokens = tokenize(textos.map(htmlToPlainText).join(' '));
        if (tokens.length === 0) continue;
        puntosTrayectoria.push({ autorSlug: slug, anio });
        tokensPuntos.push(tokens);
      }
    }

    const tokensByDoc = [...tokensReferencia, ...tokensPuntos];
    const vocabulario = [...new Set(tokensByDoc.flat())];
    const vectores = buildTfIdf(tokensByDoc, vocabulario);

    const vectoresAutoresReferencia = vectores.slice(0, slugsReferencia.length);
    const vectoresPuntos = vectores.slice(slugsReferencia.length);

    const centroide: TfIdfVector = new Map();
    for (const palabra of vocabulario) {
      const suma = vectoresAutoresReferencia.reduce((acc, v) => acc + (v.get(palabra) ?? 0), 0);
      centroide.set(palabra, suma / vectoresAutoresReferencia.length);
    }

    // Distribución real de distancias de los autores de referencia al centroide,
    // para que el frontend pueda dibujar la zona de norma con datos estadísticos.
    const distanciasReferencia = vectoresAutoresReferencia.map(
      (v) => 1 - cosineSimilarity(v, centroide, vocabulario)
    );
    const mediaNorma =
      distanciasReferencia.reduce((a, b) => a + b, 0) / distanciasReferencia.length;
    const stdNorma = Math.sqrt(
      distanciasReferencia.reduce((a, b) => a + (b - mediaNorma) ** 2, 0) /
        distanciasReferencia.length
    );

    const norma = {
      num_autores: slugsReferencia.length,
      num_articulos: filasReferencia.length,
      media: mediaNorma,
      std: stdNorma,
      aviso_pocos_datos:
        slugsReferencia.length < UMBRAL_POCOS_AUTORES_NORMA
          ? `La norma se ha calculado con solo ${slugsReferencia.length} autores; los resultados pueden ser poco representativos.`
          : null,
    };

    const autores = slugsSolicitados.map((slug, indice) => {
      const info = autoresInfoPorSlug.get(slug)!;
      const numArticulos = totalArticulosPorAutor.get(slug) ?? 0;

      const trayectoria = puntosTrayectoria
        .map((punto, i) => ({ punto, vector: vectoresPuntos[i] }))
        .filter(({ punto }) => punto.autorSlug === slug)
        .map(({ punto, vector }) => ({
          año: punto.anio,
          distancia: stdNorma > 0
            ? (1 - cosineSimilarity(vector, centroide, vocabulario) - mediaNorma) / stdNorma
            : 0,
          num_articulos: aniosPorAutor.get(slug)?.get(punto.anio)?.length ?? 0,
          articulos: articulosPorAutorAnio.get(slug)?.get(punto.anio) ?? [],
        }))
        .sort((a, b) => a.año - b.año);

      return {
        slug,
        nombre: info.nombre,
        color: COLORES_INNOVACION[indice] ?? '#6b7280',
        num_articulos: numArticulos,
        aviso_pocos_datos:
          numArticulos === 0
            ? `Este autor no tiene ${etiqueta} en español.`
            : numArticulos < UMBRAL_POCOS_ARTICULOS_AUTOR
              ? `Este autor tiene solo ${numArticulos} ${etiqueta} publicado(s); los resultados pueden ser poco fiables.`
              : null,
        trayectoria,
      };
    });

    return ctx.send({ norma, autores });
  },

  async interpretarDeriva(ctx: Context) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return ctx.internalServerError('OPENAI_API_KEY no configurada.');

    const body = ctx.request.body as {
      modo?: string;
      norma?: { num_autores: number; num_articulos: number; media: number; std: number };
      autores?: { nombre: string; num_articulos: number; trayectoria: { año: number; distancia: number }[] }[];
    };

    const { modo = 'prosa', norma, autores } = body;

    if (!norma || !Array.isArray(autores) || autores.length === 0) {
      return ctx.badRequest('Se requieren "norma" y "autores" en el cuerpo de la petición.');
    }

    function tendencia(tray: { año: number; distancia: number }[]): string {
      if (tray.length < 2) return 'Sin datos suficientes';
      const diff = tray[tray.length - 1].distancia - tray[0].distancia;
      if (diff > 0.5) return 'Innovador (z-score creciente: el autor se aleja de la norma)';
      if (diff < -0.3) return 'Convergente (z-score decreciente: el autor se acerca a la norma)';
      return 'Estable (variación inferior a 0,3σ)';
    }

    const modoLabel = modo === 'poesia' ? 'poesía' : 'prosa';
    const autoresTexto = autores.map((a) => {
      const puntos = a.trayectoria
        .map((p) => `  - ${p.año}: z = ${p.distancia.toFixed(2)}`)
        .join('\n');
      return `**${a.nombre}** (${a.num_articulos} textos analizados)\nTendencia: ${tendencia(a.trayectoria)}\nTrayectoria:\n${puntos}`;
    }).join('\n\n');

    const prompt = `Eres un asistente que explica resultados de análisis de datos literarios a un público general, sin conocimientos técnicos previos.

Se te proporcionan los resultados de un análisis que mide cómo de diferente es el vocabulario de un autor respecto al vocabulario habitual del conjunto de autores de las revistas de la Edad de Plata española. Cuanto mayor es la puntuación, más singular o alejado del vocabulario común es ese autor en ese período. La puntuación 0 significa que el autor usa exactamente el vocabulario medio del corpus; puntuaciones entre -1 y +1 son "normales"; por encima de +2 el autor es léxicamente muy singular.

INSTRUCCIONES ESTRICTAS:
- Explica los resultados en lenguaje sencillo y comprensible para alguien sin formación especializada.
- Describe únicamente lo que los datos muestran. No añadas información biográfica, referencias a obras concretas ni contexto histórico que no esté directamente respaldado por los números.
- No atribuyas causas a las variaciones observadas; solo descríbelas.
- Usa formulaciones prudentes: "los datos muestran", "se observa", "parece indicar". Evita afirmaciones categóricas.
- Si los datos de un autor son escasos, señálalo como limitación.
- Si la trayectoria es plana o irregular sin tendencia clara, dilo en lugar de forzar una narrativa.
- No uses términos técnicos como "z-score", "TF-IDF", "centroide" ni "desviación típica"; tradúcelos a lenguaje llano.
- No reproduzcas los números brutos; descríbelos en palabras ("su puntuación sube progresivamente", "se mantiene cerca de la media", "alcanza un nivel muy por encima de la norma").

CLAVE DE LECTURA (solo para tu referencia interna):
- z = 0: vocabulario coincide con la media del corpus
- Entre -1 y +1: rango habitual (la mayoría de autores)
- Por encima de +2: vocabulario muy singular
- Tendencia creciente: el vocabulario se vuelve más singular con el tiempo
- Tendencia decreciente: el vocabulario se acerca más al común con el tiempo

DATOS:
Modo: ${modoLabel}
Corpus de referencia: ${norma.num_autores} autores, ${norma.num_articulos} textos

${autoresTexto}

Escribe en español, en 3-4 párrafos breves y en texto corrido (sin encabezados ni listas). Sé claro, directo y accesible.`;

    const https = await import('https');
    const interpretacion: string = await new Promise((resolve, reject) => {
      const reqBody = JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 900,
        temperature: 0.2,
      });
      const req = https.default.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(reqBody),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString());
              if (json.error) return reject(new Error(json.error.message));
              resolve(json.choices[0].message.content as string);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(reqBody);
      req.end();
    });

    return ctx.send({ interpretacion });
  },

  async cadenasLexicas(ctx: Context) {
    const palabraRaw = ctx.query.palabra;
    if (!palabraRaw || typeof palabraRaw !== 'string' || palabraRaw.trim().length === 0) {
      return ctx.badRequest('El parámetro "palabra" es obligatorio.');
    }
    const palabra = palabraRaw.trim().toLowerCase();

    const autorSlug = typeof ctx.query.autorSlug === 'string' ? ctx.query.autorSlug.trim() : '';
    const reconstruir = ctx.query.reconstruir === 'true';

    if (autorSlug) {
      const autor = await strapi.db
        .connection('authors')
        .where('slug', autorSlug)
        .andWhere('published_at', 'is not', null)
        .first();
      if (!autor) {
        return ctx.notFound(`No se ha encontrado el autor "${autorSlug}".`);
      }
    }

    if (reconstruir || !obtenerIndice()) {
      await construirIndice(strapi);
    }
    const indice = obtenerIndice()!;

    const sucesoresCorpus = calcularProbabilidades(indice.indiceCorpus, indice.frecuenciasCorpus, palabra, 10);
    const predecesoresCorpus = calcularProbabilidades(
      indice.indicePredecesores,
      indice.frecuenciasCorpus,
      palabra,
      10
    );
    const sucesoresCorpusCompletos = calcularProbabilidades(
      indice.indiceCorpus,
      indice.frecuenciasCorpus,
      palabra,
      Number.MAX_SAFE_INTEGER
    );
    const frecuenciaTotalCorpus = indice.frecuenciasCorpus.get(palabra) ?? 0;
    const entropiaCorpus = calcularEntropiaShannon(sucesoresCorpusCompletos);
    const fiableCorpus = frecuenciaTotalCorpus >= FRECUENCIA_MINIMA_FIABLE;
    const numSucesoresDistintosCorpus = indice.indiceCorpus.get(palabra)?.size ?? 0;
    const entropiaMaximaCorpus = numSucesoresDistintosCorpus > 0 ? Math.log2(numSucesoresDistintosCorpus) : 0;
    const entropiaNormalizadaCorpus = entropiaMaximaCorpus > 0 ? entropiaCorpus / entropiaMaximaCorpus : 0;

    const corpus = {
      sucesores: sucesoresCorpus,
      predecesores: predecesoresCorpus,
      entropia: entropiaCorpus,
      frecuenciaTotal: frecuenciaTotalCorpus,
      fiable: fiableCorpus,
      frecuenciaMinima: FRECUENCIA_MINIMA_FIABLE,
      entropiaNormalizada: entropiaNormalizadaCorpus,
      entropiaMaxima: entropiaMaximaCorpus,
      interpretacion: interpretarEntropia(entropiaNormalizadaCorpus, fiableCorpus),
    };

    let autor: CadenasLexicasAutorRespuesta | null = null;

    if (autorSlug) {
      const tieneArticulosEnEspanol = indice.frecuenciasAutor.has(autorSlug);
      const frecAutorMap = indice.frecuenciasAutor.get(autorSlug) ?? new Map<string, number>();
      const frecuenciaTotalAutor = frecAutorMap.get(palabra) ?? 0;

      if (!tieneArticulosEnEspanol) {
        autor = { slug: autorSlug, sinDatos: true, sinArticulosEnEspanol: true };
      } else if (frecuenciaTotalAutor === 0) {
        autor = { slug: autorSlug, sinDatos: true };
      } else {
        const indiceSucesoresAutor =
          indice.indiceAutores.get(autorSlug) ?? new Map<string, Map<string, number>>();
        const indicePredecesoresAutor =
          indice.indicePredecesoresAutores.get(autorSlug) ?? new Map<string, Map<string, number>>();

        const sucesoresAutorBase = calcularProbabilidades(indiceSucesoresAutor, frecAutorMap, palabra, 10);
        const mapaProbabilidadCorpus = new Map(sucesoresCorpusCompletos.map((s) => [s.token, s.probabilidad]));
        const sucesoresAutor = sucesoresAutorBase.map((s) => {
          const probabilidadCorpus = mapaProbabilidadCorpus.get(s.token) ?? 0;
          return { ...s, probabilidadCorpus, desviacion: s.probabilidad - probabilidadCorpus };
        });

        const predecesoresAutor = calcularProbabilidades(indicePredecesoresAutor, frecAutorMap, palabra, 10);
        const sucesoresAutorCompletos = calcularProbabilidades(
          indiceSucesoresAutor,
          frecAutorMap,
          palabra,
          Number.MAX_SAFE_INTEGER
        );
        const entropiaAutor = calcularEntropiaShannon(sucesoresAutorCompletos);
        const fiableAutor = frecuenciaTotalAutor >= FRECUENCIA_MINIMA_FIABLE;
        const numSucesoresDistintosAutor = indiceSucesoresAutor.get(palabra)?.size ?? 0;
        const entropiaMaximaAutor = numSucesoresDistintosAutor > 0 ? Math.log2(numSucesoresDistintosAutor) : 0;
        const entropiaNormalizadaAutor = entropiaMaximaAutor > 0 ? entropiaAutor / entropiaMaximaAutor : 0;

        autor = {
          slug: autorSlug,
          sucesores: sucesoresAutor,
          predecesores: predecesoresAutor,
          entropia: entropiaAutor,
          desviacionEntropia: entropiaAutor - entropiaCorpus,
          frecuenciaTotal: frecuenciaTotalAutor,
          fiable: fiableAutor,
          frecuenciaMinima: FRECUENCIA_MINIMA_FIABLE,
          entropiaNormalizada: entropiaNormalizadaAutor,
          entropiaMaxima: entropiaMaximaAutor,
          interpretacion: interpretarEntropia(entropiaNormalizadaAutor, fiableAutor),
        };
      }
    }

    return ctx.send({
      palabra,
      corpus,
      autor,
      metadatos: {
        fechaConstruccionIndice: obtenerFechaConstruccion()?.toISOString() ?? null,
        totalArticulos: indice.totalArticulos,
        totalTokens: indice.totalTokens,
      },
    });
  },

  // Búsqueda con expansión morfológica: reduce la palabra (o las dos
  // palabras) buscada(s) y cada palabra del texto a su raíz para encontrar
  // también conjugaciones y variantes de número, no solo la forma literal
  // escrita. Si se indican `palabra2` y `distancia`, en vez de ocurrencias
  // sueltas de `palabra`, busca artículos donde una ocurrencia de `palabra`
  // y otra de `palabra2` aparezcan a un máximo de `distancia` palabras de
  // separación en el cuerpo del artículo (la búsqueda de proximidad no se
  // aplica al ámbito título/autor, que no es prosa continua).
  async morfologica(ctx: Context) {
    const palabraRaw = typeof ctx.query.palabra === 'string' ? ctx.query.palabra.trim() : '';
    if (palabraRaw.length < 3) {
      return ctx.badRequest('El parámetro "palabra" debe tener al menos 3 caracteres.');
    }

    const palabra2Raw = typeof ctx.query.palabra2 === 'string' ? ctx.query.palabra2.trim() : '';
    const distanciaRaw = typeof ctx.query.distancia === 'string' ? ctx.query.distancia.trim() : '';

    if (palabra2Raw.length > 0 && (palabra2Raw.length < 3 || !/^\d+$/.test(distanciaRaw))) {
      return ctx.badRequest(
        'Para buscar por proximidad, indica una segunda palabra de al menos 3 caracteres y una distancia (en número de palabras).'
      );
    }

    const usaProximidad = palabra2Raw.length >= 3 && /^\d+$/.test(distanciaRaw);
    const distancia = usaProximidad ? Number(distanciaRaw) : null;

    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Number(ctx.query.pageSize) || 20);

    const buscarEnTituloAutor = !usaProximidad && ctx.query.enTituloAutor !== 'false';
    const buscarEnTexto = ctx.query.enTexto !== 'false';

    if (!usaProximidad && !buscarEnTituloAutor && !buscarEnTexto) {
      return ctx.badRequest('Selecciona al menos un ámbito de búsqueda (título/autor o texto).');
    }

    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';
    const autorSlug = typeof ctx.query.autor === 'string' ? ctx.query.autor.trim() : '';
    const desdeRaw = typeof ctx.query.desde === 'string' ? ctx.query.desde.trim() : '';
    const hastaRaw = typeof ctx.query.hasta === 'string' ? ctx.query.hasta.trim() : '';
    const desde = desdeRaw && /^\d+$/.test(desdeRaw) ? Number(desdeRaw) : null;
    const hasta = hastaRaw && /^\d+$/.test(hastaRaw) ? Number(hastaRaw) : null;

    const knex = strapi.db.connection;

    let articlesQuery = knex('articles as a')
      .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
      .innerJoin('issues as i', 'i.id', 'ail.issue_id')
      .innerJoin('issues_publication_lnk as ipl', 'ipl.issue_id', 'i.id')
      .innerJoin('publications as p', 'p.id', 'ipl.publication_id')
      .where('a.published_at', 'is not', null)
      .andWhere('i.published_at', 'is not', null)
      .andWhere('p.published_at', 'is not', null)
      .whereIn('a.idioma', ['es', 'Español'])
      .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'));

    if (revistaSlug) {
      articlesQuery = articlesQuery.andWhere('p.slug', revistaSlug);
    }
    if (desde !== null) {
      articlesQuery = articlesQuery.andWhere('i.ano', '>=', desde);
    }
    if (hasta !== null) {
      articlesQuery = articlesQuery.andWhere('i.ano', '<=', hasta);
    }

    if (autorSlug) {
      const authorArticleIds: number[] = await knex('articles_authors_lnk as aal')
        .innerJoin('authors as au', 'au.id', 'aal.author_id')
        .where('au.slug', autorSlug)
        .andWhere('au.published_at', 'is not', null)
        .pluck('aal.article_id');

      articlesQuery = articlesQuery.whereIn('a.id', authorArticleIds.length > 0 ? authorArticleIds : [-1]);
    }

    const articleRows: ArticleRow[] = await articlesQuery.select(
      'a.id as article_id',
      'a.titulo as articulo_titulo',
      'a.slug as articulo_slug',
      'a.texto as texto',
      'i.numero_orden as numero_orden',
      'i.ano as anio',
      'p.titulo as revista_titulo',
      'p.slug as revista_slug'
    );

    if (articleRows.length === 0) {
      return ctx.send({ data: [], meta: { total: 0, page, pageSize, pageCount: 0 } });
    }

    const articleIds = articleRows.map((row) => row.article_id);

    const authorRows: { article_id: number; nombre: string }[] = await knex('articles_authors_lnk as aal')
      .innerJoin('authors as au', 'au.id', 'aal.author_id')
      .whereIn('aal.article_id', articleIds)
      .andWhere('au.published_at', 'is not', null)
      .select('aal.article_id as article_id', 'au.nombre as nombre');

    const authorsByArticle = new Map<number, string[]>();
    for (const row of authorRows) {
      const list = authorsByArticle.get(row.article_id) ?? [];
      list.push(row.nombre);
      authorsByArticle.set(row.article_id, list);
    }

    const raizBuscada1 = raizMorfologica(palabraRaw);
    const raizBuscada2 = usaProximidad ? raizMorfologica(palabra2Raw) : null;

    const resultados: {
      id: number;
      titulo: string;
      slug: string;
      autores: string[];
      revista: string;
      revista_slug: string;
      numero_orden: number | null;
      año: number | null;
      fragmento: string;
    }[] = [];

    for (const row of articleRows) {
      const plainText = htmlToPlainText(row.texto);
      const autores = authorsByArticle.get(row.article_id) ?? [];

      let fragmento: string | null = null;

      if (buscarEnTexto || usaProximidad) {
        const ocurrencias = recopilarOcurrencias(plainText);
        const ocurrenciasPalabra1 = ocurrencias.filter((o) => o.raiz === raizBuscada1);

        if (usaProximidad) {
          const ocurrenciasPalabra2 = ocurrencias.filter((o) => o.raiz === raizBuscada2);

          let mejorPar: { a: OcurrenciaMorfologica; b: OcurrenciaMorfologica; separacion: number } | null = null;
          for (const a of ocurrenciasPalabra1) {
            for (const b of ocurrenciasPalabra2) {
              const separacion = Math.abs(a.wordIndex - b.wordIndex);
              if (separacion <= distancia! && (!mejorPar || separacion < mejorPar.separacion)) {
                mejorPar = { a, b, separacion };
              }
            }
          }

          if (mejorPar) {
            fragmento = construirFragmentoProximidad(plainText, mejorPar.a, mejorPar.b);
          }
        } else if (ocurrenciasPalabra1.length > 0) {
          fragmento = construirFragmentoMorfologico(plainText, ocurrenciasPalabra1[0]);
        }
      }

      const coincideEnTituloOAutor =
        buscarEnTituloAutor &&
        [row.articulo_titulo ?? '', ...autores].some((texto) =>
          [...texto.matchAll(WORD_REGEX_MORFOLOGICA)].some(
            (match) => raizMorfologica(match[0]) === raizBuscada1
          )
        );

      if (fragmento === null && !coincideEnTituloOAutor) continue;

      resultados.push({
        id: row.article_id,
        titulo: row.articulo_titulo,
        slug: row.articulo_slug,
        autores,
        revista: row.revista_titulo,
        revista_slug: row.revista_slug,
        numero_orden: row.numero_orden,
        año: row.anio,
        fragmento: fragmento ?? row.articulo_titulo,
      });
    }

    const total = resultados.length;
    const pageCount = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const data = resultados.slice(start, start + pageSize);

    return ctx.send({ data, meta: { total, page, pageSize, pageCount } });
  },

  // --- Análisis de Publicidad ---

  // Tab 1: qué se anuncia más, en qué revistas y en qué períodos. TF-IDF
  // (frecuencia) sobre el texto OCR de los anuncios, con la distribución
  // completa por revista/año y la posibilidad de acotar las palabras a una
  // revista y/o año concretos.
  async publicidadFrecuencia(ctx: Context) {
    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';
    const añoRaw = typeof ctx.query.año === 'string' ? ctx.query.año.trim() : '';
    const año = añoRaw && /^\d+$/.test(añoRaw) ? Number(añoRaw) : null;

    const knex = strapi.db.connection;

    const filas: { texto: string | null; revista_slug: string; revista_titulo: string; anio: number | null }[] =
      await knex('articles as a')
        .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
        .innerJoin('issues as i', 'i.id', 'ail.issue_id')
        .innerJoin('issues_publication_lnk as ipl', 'ipl.issue_id', 'i.id')
        .innerJoin('publications as p', 'p.id', 'ipl.publication_id')
        .where('a.es_anuncio', true)
        .whereIn('a.idioma', ['es', 'Español'])
        .andWhere('a.published_at', 'is not', null)
        .andWhere('i.published_at', 'is not', null)
        .andWhere('p.published_at', 'is not', null)
        .select(
          'a.texto_ocr_anuncios as texto',
          'p.slug as revista_slug',
          'p.titulo as revista_titulo',
          'i.ano as anio'
        );

    const porRevistaMap = new Map<string, { revista: string; slug: string; num_anuncios: number }>();
    const porAñoMap = new Map<number, number>();
    for (const fila of filas) {
      const entry = porRevistaMap.get(fila.revista_slug) ?? {
        revista: fila.revista_titulo,
        slug: fila.revista_slug,
        num_anuncios: 0,
      };
      entry.num_anuncios += 1;
      porRevistaMap.set(fila.revista_slug, entry);

      if (fila.anio !== null) {
        porAñoMap.set(fila.anio, (porAñoMap.get(fila.anio) ?? 0) + 1);
      }
    }

    const filasFiltradas = filas.filter(
      (fila) =>
        (!revistaSlug || fila.revista_slug === revistaSlug) && (año === null || fila.anio === año)
    );

    const palabras = contarFrecuencias(tokenize(filasFiltradas.map((f) => f.texto ?? '').join(' ')));

    return ctx.send({
      total_anuncios: filas.length,
      total_anuncios_filtrados: filasFiltradas.length,
      palabras,
      por_revista: [...porRevistaMap.values()].sort((a, b) => b.num_anuncios - a.num_anuncios),
      por_año: [...porAñoMap.entries()]
        .map(([año, num_anuncios]) => ({ año, num_anuncios }))
        .sort((a, b) => a.año - b.año),
    });
  },

  // Tab 2: penetración de tecnologías concretas en la publicidad a lo largo
  // del tiempo, usando similitud semántica (coseno sobre embeddings pgvector)
  // en lugar de coincidencia exacta de palabras clave.
  // El embedding de cada categoría se genera una vez y se cachea en memoria.
  async publicidadTendencias(ctx: Context) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return ctx.internalServerError('OPENAI_API_KEY no configurada.');

    const publicacionSlug =
      typeof ctx.query.publicacion === 'string' ? ctx.query.publicacion.trim() : '';

    const UMBRAL = 0.28;
    const knex = strapi.db.connection;

    const categorias = await readCategorias(knex);

    const wherePublicacion = publicacionSlug ? 'AND p.slug = ?' : '';
    const params = publicacionSlug ? [publicacionSlug] : [];
    const { rows: anunciosRaw } = await knex.raw(`
      SELECT a.id, a.embedding::text AS embedding_str, i.ano AS anio
      FROM articles a
      INNER JOIN articles_issue_lnk ail ON ail.article_id = a.id
      INNER JOIN issues i ON i.id = ail.issue_id
      INNER JOIN issues_publication_lnk ipl ON ipl.issue_id = i.id
      INNER JOIN publications p ON p.id = ipl.publication_id
      WHERE a.es_anuncio = true
        AND a.embedding IS NOT NULL
        AND a.published_at IS NOT NULL
        AND i.published_at IS NOT NULL
        AND p.published_at IS NOT NULL
        ${wherePublicacion}
    `, params);

    type AnuncioRow = { id: number; embedding_str: string; anio: number | null };
    const anuncios: { id: number; vec: number[]; anio: number }[] = (anunciosRaw as AnuncioRow[])
      .filter((r) => r.anio !== null)
      .map((r) => ({
        id: r.id,
        anio: Number(r.anio),
        vec: JSON.parse(r.embedding_str) as number[],
      }));

    const categoriasConSerie = await Promise.all(
      categorias.map(async ({ nombre, concepto }) => {
        let catVec = _cacheCatEmbeddings.get(nombre);
        if (!catVec) {
          catVec = await getEmbeddingTecnologia(concepto, apiKey);
          _cacheCatEmbeddings.set(nombre, catVec);
        }

        const menciones = new Map<number, number>();
        for (const anuncio of anuncios) {
          const sim = cosineSimilitud(anuncio.vec, catVec);
          if (sim >= UMBRAL) {
            menciones.set(anuncio.anio, (menciones.get(anuncio.anio) ?? 0) + 1);
          }
        }

        return {
          categoria: nombre,
          grupo: (categorias.find((c) => c.nombre === nombre)?.grupo ?? ''),
          palabras_clave: [concepto],
          similitud_umbral: UMBRAL,
          serie: [...menciones.entries()]
            .map(([año, num_anuncios]) => ({ año, num_anuncios }))
            .sort((a, b) => a.año - b.año),
        };
      })
    );

    return ctx.send({ total_anuncios: anuncios.length, categorias: categoriasConSerie });
  },

  async listarCategorias(ctx: Context) {
    const knex = strapi.db.connection;
    await initCategoriasTable(knex);
    const categorias = await knex('publicidad_categorias').orderBy('id');
    return ctx.send({ categorias });
  },

  async descubrirCategorias(ctx: Context) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return ctx.internalServerError('OPENAI_API_KEY no configurada.');

    const knex = strapi.db.connection;
    await initCategoriasTable(knex);

    const categoriasActuales: { nombre: string }[] = await knex('publicidad_categorias').select('nombre');
    const nombresActuales = categoriasActuales.map((c) => c.nombre).join(', ');

    const { rows: titulosRaw } = await knex.raw(`
      SELECT DISTINCT titulo FROM articles
      WHERE es_anuncio = true AND published_at IS NOT NULL
      ORDER BY titulo LIMIT 250
    `);
    const titulosTexto = (titulosRaw as { titulo: string }[])
      .map((r) => `- ${r.titulo}`)
      .join('\n');

    const prompt = `Eres un experto en historia cultural y publicidad española del siglo XX.

Se te proporciona una lista de títulos de anuncios publicados en revistas literarias y culturales españolas entre 1900 y 1940 (Edad de Plata).

CATEGORÍAS YA EXISTENTES (no las repitas):
${nombresActuales}

TÍTULOS DE ANUNCIOS DEL CORPUS:
${titulosTexto}

TAREA:
Identifica entre 5 y 10 nuevas categorías temáticas de productos, servicios o sectores económicos que estén claramente representadas en estos títulos y que NO estén ya cubiertas por las categorías existentes.

Para cada categoría, proporciona:
- "nombre": nombre corto y descriptivo en español (máximo 4 palabras)
- "concepto": frase descriptiva de 8-15 palabras clave en español que captura la esencia semántica de la categoría, útil para búsqueda vectorial

Responde ÚNICAMENTE con un array JSON válido, sin texto adicional, con este formato exacto:
[
  { "nombre": "Nombre de categoría", "concepto": "palabras clave descriptivas de la categoría" },
  ...
]`;

    const https = await import('https');
    const respuestaGPT: string = await new Promise((resolve, reject) => {
      const reqBody = JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
        temperature: 0.3,
      });
      const req = https.default.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(reqBody),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString());
              if (json.error) return reject(new Error(json.error.message));
              resolve(json.choices[0].message.content as string);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      req.write(reqBody);
      req.end();
    });

    let sugerencias: { nombre: string; concepto: string }[] = [];
    try {
      const clean = respuestaGPT.replace(/```json\n?|\n?```/g, '').trim();
      sugerencias = JSON.parse(clean);
    } catch {
      return ctx.internalServerError('El modelo no devolvió JSON válido.');
    }

    return ctx.send({ sugerencias });
  },

  async guardarCategorias(ctx: Context) {
    const body = ctx.request.body as { categorias?: { nombre: string; concepto: string }[] };
    if (!Array.isArray(body?.categorias) || body.categorias.length === 0) {
      return ctx.badRequest('Se requiere un array "categorias".');
    }

    const knex = strapi.db.connection;
    await initCategoriasTable(knex);

    const existing: { nombre: string }[] = await knex('publicidad_categorias').select('nombre');
    const existingNames = new Set(existing.map((c) => c.nombre.toLowerCase()));

    const toInsert = body.categorias.filter(
      (c) => c.nombre?.trim() && c.concepto?.trim() && !existingNames.has(c.nombre.trim().toLowerCase())
    );

    if (toInsert.length > 0) {
      await knex('publicidad_categorias').insert(
        toInsert.map((c) => ({ nombre: c.nombre.trim(), concepto: c.concepto.trim(), activa: true }))
      );
    }

    return ctx.send({ insertadas: toInsert.length });
  },

  async toggleCategoria(ctx: Context) {
    const body = ctx.request.body as { id?: number };
    const id = Number(body?.id);
    if (!id) return ctx.badRequest('Se requiere "id".');

    const knex = strapi.db.connection;
    await initCategoriasTable(knex);

    const cat: CategoriaRow | undefined = await knex('publicidad_categorias').where({ id }).first();
    if (!cat) return ctx.notFound('Categoría no encontrada.');

    const nuevaActiva = !cat.activa;
    await knex('publicidad_categorias').where({ id }).update({ activa: nuevaActiva });
    _cacheCatEmbeddings.delete(cat.nombre);

    return ctx.send({ id, activa: nuevaActiva });
  },

  async publicidadPublicaciones(ctx: Context) {
    const knex = strapi.db.connection;
    const rows: { slug: string; titulo: string; num_anuncios: string }[] = await knex(
      'publications as p'
    )
      .innerJoin('issues_publication_lnk as ipl', 'ipl.publication_id', 'p.id')
      .innerJoin('issues as i', 'i.id', 'ipl.issue_id')
      .innerJoin('articles_issue_lnk as ail', 'ail.issue_id', 'i.id')
      .innerJoin('articles as a', 'a.id', 'ail.article_id')
      .where('a.es_anuncio', true)
      .whereNotNull('a.embedding')
      .whereNotNull('a.published_at')
      .whereNotNull('i.published_at')
      .whereNotNull('p.published_at')
      .select('p.slug', 'p.titulo')
      .countDistinct('a.id as num_anuncios')
      .groupBy('p.slug', 'p.titulo')
      .orderBy('num_anuncios', 'desc');
    return ctx.send({
      publicaciones: rows.map((r) => ({ ...r, num_anuncios: Number(r.num_anuncios) })),
    });
  },

  // Tab 3: lenguaje publicitario (sucesores/predecesores y entropía), igual
  // que cadenasLexicas pero sobre el corpus de anuncios en vez del literario,
  // sin desglose por autor (la inmensa mayoría de los anuncios no tienen).
  async publicidadCadenasLexicas(ctx: Context) {
    const palabraRaw = ctx.query.palabra;
    if (!palabraRaw || typeof palabraRaw !== 'string' || palabraRaw.trim().length === 0) {
      return ctx.badRequest('El parámetro "palabra" es obligatorio.');
    }
    const palabra = palabraRaw.trim().toLowerCase();
    const reconstruir = ctx.query.reconstruir === 'true';

    if (reconstruir || !obtenerIndice('publicidad')) {
      await construirIndice(strapi, 'publicidad');
    }
    const indice = obtenerIndice('publicidad')!;

    const sucesores = calcularProbabilidades(indice.indiceCorpus, indice.frecuenciasCorpus, palabra, 10);
    const predecesores = calcularProbabilidades(indice.indicePredecesores, indice.frecuenciasCorpus, palabra, 10);
    const sucesoresCompletos = calcularProbabilidades(
      indice.indiceCorpus,
      indice.frecuenciasCorpus,
      palabra,
      Number.MAX_SAFE_INTEGER
    );
    const frecuenciaTotal = indice.frecuenciasCorpus.get(palabra) ?? 0;
    const entropia = calcularEntropiaShannon(sucesoresCompletos);
    const fiable = frecuenciaTotal >= FRECUENCIA_MINIMA_FIABLE;
    const numSucesoresDistintos = indice.indiceCorpus.get(palabra)?.size ?? 0;
    const entropiaMaxima = numSucesoresDistintos > 0 ? Math.log2(numSucesoresDistintos) : 0;
    const entropiaNormalizada = entropiaMaxima > 0 ? entropia / entropiaMaxima : 0;

    return ctx.send({
      palabra,
      corpus: {
        sucesores,
        predecesores,
        entropia,
        frecuenciaTotal,
        fiable,
        frecuenciaMinima: FRECUENCIA_MINIMA_FIABLE,
        entropiaNormalizada,
        entropiaMaxima,
        interpretacion: interpretarEntropia(entropiaNormalizada, fiable),
      },
      metadatos: {
        fechaConstruccionIndice: obtenerFechaConstruccion('publicidad')?.toISOString() ?? null,
        totalArticulos: indice.totalArticulos,
        totalTokens: indice.totalTokens,
      },
    });
  },

  // Tab 4: ¿adoptó la publicidad el léxico de las vanguardias literarias de
  // las mismas revistas? Compara, con el mismo TF-IDF + distancia de coseno
  // que estilometria, el corpus de anuncios contra el corpus literario
  // (artículos que no son anuncios), acotable a una revista y, dentro de
  // ella, a un número concreto.
  async publicidadVanguardia(ctx: Context) {
    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';
    const numeroOrdenRaw = typeof ctx.query.numero_orden === 'string' ? ctx.query.numero_orden.trim() : '';
    const numeroOrden = numeroOrdenRaw && /^\d+$/.test(numeroOrdenRaw) ? Number(numeroOrdenRaw) : null;

    if (numeroOrden !== null && !revistaSlug) {
      return ctx.badRequest('Para acotar a un número concreto, indica también la revista.');
    }

    const knex = strapi.db.connection;

    if (revistaSlug) {
      const publicacion = await knex('publications')
        .where('slug', revistaSlug)
        .andWhere('published_at', 'is not', null)
        .first();
      if (!publicacion) {
        return ctx.notFound(`No se ha encontrado la revista "${revistaSlug}".`);
      }
    }

    async function cargarCorpus(esAnuncio: boolean) {
      let query = knex('articles as a')
        .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
        .innerJoin('issues as i', 'i.id', 'ail.issue_id')
        .innerJoin('issues_publication_lnk as ipl', 'ipl.issue_id', 'i.id')
        .innerJoin('publications as p', 'p.id', 'ipl.publication_id')
        .andWhere('a.published_at', 'is not', null)
        .andWhere('i.published_at', 'is not', null)
        .andWhere('p.published_at', 'is not', null)
        .whereIn('a.idioma', ['es', 'Español']);

      query = esAnuncio
        ? query.andWhere('a.es_anuncio', true)
        : query.andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'));

      if (revistaSlug) query = query.andWhere('p.slug', revistaSlug);
      if (numeroOrden !== null) query = query.andWhere('i.numero_orden', numeroOrden);

      const columnaTexto = esAnuncio ? 'a.texto_ocr_anuncios' : 'a.texto';
      return query.select(`${columnaTexto} as texto`) as Promise<{ texto: string | null }[]>;
    }

    const [filasAnuncios, filasLiteratura] = await Promise.all([
      cargarCorpus(true),
      cargarCorpus(false),
    ]);

    const textoAnuncios = filasAnuncios.map((f) => f.texto ?? '').join(' ');
    const textoLiteratura = filasLiteratura.map((f) => htmlToPlainText(f.texto)).join(' ');

    const tokensAnuncios = tokenize(textoAnuncios);
    const tokensLiteratura = tokenize(textoLiteratura);

    if (tokensAnuncios.length === 0) {
      return ctx.badRequest('No hay suficiente texto de anuncios para este ámbito.');
    }
    if (tokensLiteratura.length === 0) {
      return ctx.badRequest('No hay suficiente texto literario para este ámbito.');
    }

    const vocabulario = [...new Set([...tokensAnuncios, ...tokensLiteratura])];
    const [vectorAnuncios, vectorLiteratura] = buildTfIdf([tokensAnuncios, tokensLiteratura], vocabulario);

    const similitudCoseno = cosineSimilarity(vectorAnuncios, vectorLiteratura, vocabulario);
    const distanciaCoseno = 1 - similitudCoseno;

    const diferencias = vocabulario.map((palabra) => {
      const pesoAnuncios = vectorAnuncios.get(palabra) ?? 0;
      const pesoLiteratura = vectorLiteratura.get(palabra) ?? 0;
      return { palabra, diferencia: pesoAnuncios - pesoLiteratura, pesoAnuncios, pesoLiteratura };
    });

    const palabrasAnuncios = [...diferencias]
      .sort((a, b) => b.diferencia - a.diferencia)
      .slice(0, 10)
      .map((entry) => ({ palabra: entry.palabra, peso: entry.pesoAnuncios }));

    const palabrasLiteratura = [...diferencias]
      .sort((a, b) => a.diferencia - b.diferencia)
      .slice(0, 10)
      .map((entry) => ({ palabra: entry.palabra, peso: entry.pesoLiteratura }));

    return ctx.send({
      anuncios: { num_articulos: filasAnuncios.length },
      literatura: { num_articulos: filasLiteratura.length },
      distancia_coseno: distanciaCoseno,
      similitud_coseno: similitudCoseno,
      palabras_caracteristicas: {
        anuncios: palabrasAnuncios,
        literatura: palabrasLiteratura,
      },
      nube_palabras: {
        anuncios: contarFrecuencias(tokensAnuncios),
        literatura: contarFrecuencias(tokensLiteratura),
      },
      interpretacion: interpretarDistancia(distanciaCoseno),
    });
  },
};

// Alias explícito para dejar claro en el código que el texto plano conserva
// los mismos offsets de carácter que se usarán al normalizar con NFD.
function collapseHtmlButKeepOffsets(html: string | null): string {
  return htmlToPlainText(html);
}
