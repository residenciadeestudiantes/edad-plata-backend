// PROTOTIPO: cálculo TF-IDF implementado en Node.js para validación.
// En producción, este endpoint delegará en un microservicio FastAPI + scikit-learn
// que expone la misma interfaz JSON. El frontend no requerirá cambios.

import type { Context } from 'koa';

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

// Stopwords del español para el análisis estilométrico (TF-IDF). A diferencia
// de `stripDiacritics` (usado en concordancias), aquí SÍ se conservan las
// tildes: la tokenización de este endpoint no pliega diacríticos.
const STOPWORDS = new Set([
  'de', 'la', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por', 'un',
  'para', 'con', 'una', 'su', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le',
  'ya', 'o', 'este', 'sí', 'porque', 'esta', 'entre', 'cuando', 'muy', 'sin',
  'sobre', 'también', 'me', 'hasta', 'hay', 'donde', 'quien', 'desde', 'todo',
  'nos', 'durante', 'estados', 'todos', 'uno', 'les', 'ni', 'contra',
]);

// Tokeniza un texto en minúsculas, sin puntuación (conservando tildes y
// letras Unicode), separado por espacios y sin stopwords.
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
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
      .andWhere('p.published_at', 'is not', null);

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

    const texto1 = autor1Data.articleRows.map((row) => htmlToPlainText(row.texto)).join(' ');
    const texto2 = autor2Data.articleRows.map((row) => htmlToPlainText(row.texto)).join(' ');

    const tokens1 = tokenize(texto1);
    const tokens2 = tokenize(texto2);

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
      interpretacion: interpretarDistancia(distanciaCoseno),
    });
  },

  // PROTOTIPO DE VALIDACIÓN: datos hardcodeados para demostración visual.
  // En producción este endpoint calculará el centroide TF-IDF del corpus completo
  // y la distancia anual de cada autor al centroide, mediante microservicio FastAPI + scikit-learn.
  async innovacion(ctx: Context) {
    return ctx.send({
      es_prototipo: true,
      nota: 'Datos de demostración. No corresponden a autores reales del corpus.',
      centroide_año_inicio: 1920,
      centroide_año_fin: 1936,
      autores: [
        {
          nombre: 'Federico García Lorca',
          color: '#DA3C00',
          trayectoria: [
            { año: 1920, distancia: 0.41 },
            { año: 1922, distancia: 0.38 },
            { año: 1924, distancia: 0.52 },
            { año: 1926, distancia: 0.61 },
            { año: 1928, distancia: 0.74 },
            { año: 1930, distancia: 0.82 },
            { año: 1933, distancia: 0.89 },
          ],
        },
        {
          nombre: 'Ramón Gómez de la Serna',
          color: '#3838BD',
          trayectoria: [
            { año: 1920, distancia: 0.71 },
            { año: 1922, distancia: 0.68 },
            { año: 1924, distancia: 0.73 },
            { año: 1926, distancia: 0.75 },
            { año: 1928, distancia: 0.72 },
            { año: 1930, distancia: 0.78 },
            { año: 1933, distancia: 0.80 },
          ],
        },
        {
          nombre: 'José Ortega y Gasset',
          color: '#008867',
          trayectoria: [
            { año: 1920, distancia: 0.22 },
            { año: 1922, distancia: 0.19 },
            { año: 1924, distancia: 0.24 },
            { año: 1926, distancia: 0.21 },
            { año: 1928, distancia: 0.26 },
            { año: 1930, distancia: 0.23 },
            { año: 1933, distancia: 0.28 },
          ],
        },
        {
          nombre: 'Juan Ramón Jiménez',
          color: '#DD158B',
          trayectoria: [
            { año: 1920, distancia: 0.33 },
            { año: 1922, distancia: 0.29 },
            { año: 1924, distancia: 0.44 },
            { año: 1926, distancia: 0.58 },
            { año: 1928, distancia: 0.63 },
            { año: 1930, distancia: 0.71 },
            { año: 1933, distancia: 0.69 },
          ],
        },
      ],
    });
  },
};

// Alias explícito para dejar claro en el código que el texto plano conserva
// los mismos offsets de carácter que se usarán al normalizar con NFD.
function collapseHtmlButKeepOffsets(html: string | null): string {
  return htmlToPlainText(html);
}
