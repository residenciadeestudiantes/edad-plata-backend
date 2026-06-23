
// PROTOTIPO: cálculo TF-IDF implementado en Node.js para validación.
// En producción, este endpoint delegará en un microservicio FastAPI + scikit-learn
// que expone la misma interfaz JSON. El frontend no requerirá cambios.

import type { Context } from 'koa';
import {
  construirIndice,
  obtenerIndice,
  obtenerFechaConstruccion,
  calcularProbabilidades,
  calcularEntropiaShannon,
  type ProbabilidadToken,
} from '../services/bigramas';

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

interface PalabraFrecuencia {
  text: string;
  value: number;
}

const TOP_PALABRAS_NUBE = 150;

// Cuenta frecuencias de palabras (sin stopwords) en uno o varios textos HTML
// y devuelve las más frecuentes en el formato {text, value} que espera
// react-d3-cloud en el frontend.
function contarFrecuencias(textos: (string | null)[]): PalabraFrecuencia[] {
  const tokens = tokenize(textos.map(htmlToPlainText).join(' '));
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
      .select('a.texto as texto', 'p.slug as revista_slug', 'p.titulo as revista_titulo');

    const corpusCompleto = contarFrecuencias(filas.map((f) => f.texto));

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
          palabras: contarFrecuencias(filasRevista.map((f) => f.texto)),
        };
      }
    }

    return ctx.send({
      autor: { slug: autorInfo.slug, nombre: autorInfo.nombre, num_articulos: filas.length },
      corpus_completo: corpusCompleto,
      revista,
    });
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

    // Corpus de referencia: todos los autores publicados con al menos un
    // artículo publicado, usados para calcular la norma estilística
    // (centroide TF-IDF de todos los autores).
    const filasReferencia: { autor_slug: string; texto: string | null }[] = await knex(
      'articles_authors_lnk as aal'
    )
      .innerJoin('authors as au', 'au.id', 'aal.author_id')
      .innerJoin('articles as a', 'a.id', 'aal.article_id')
      .where('au.published_at', 'is not', null)
      .andWhere('a.published_at', 'is not', null)
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

    // Artículos por autor y año de los autores solicitados, para construir
    // su trayectoria en el MISMO espacio vectorial que la norma (se añaden
    // como documentos extra a la misma llamada a buildTfIdf, más abajo).
    const filasPorAnio: { autor_slug: string; texto: string | null; anio: number | null }[] = await knex(
      'articles_authors_lnk as aal'
    )
      .innerJoin('authors as au', 'au.id', 'aal.author_id')
      .innerJoin('articles as a', 'a.id', 'aal.article_id')
      .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
      .innerJoin('issues as i', 'i.id', 'ail.issue_id')
      .whereIn('au.slug', slugsSolicitados)
      .andWhere('au.published_at', 'is not', null)
      .andWhere('a.published_at', 'is not', null)
      .andWhere('i.published_at', 'is not', null)
      .select('au.slug as autor_slug', 'a.texto as texto', 'i.ano as anio');

    const aniosPorAutor = new Map<string, Map<number, string[]>>();
    const totalArticulosPorAutor = new Map<string, number>();
    for (const fila of filasPorAnio) {
      totalArticulosPorAutor.set(fila.autor_slug, (totalArticulosPorAutor.get(fila.autor_slug) ?? 0) + 1);
      if (fila.anio === null) continue;
      const porAnio = aniosPorAutor.get(fila.autor_slug) ?? new Map<number, string[]>();
      const textos = porAnio.get(fila.anio) ?? [];
      textos.push(fila.texto ?? '');
      porAnio.set(fila.anio, textos);
      aniosPorAutor.set(fila.autor_slug, porAnio);
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

    const norma = {
      num_autores: slugsReferencia.length,
      num_articulos: filasReferencia.length,
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
          distancia: 1 - cosineSimilarity(vector, centroide, vocabulario),
          num_articulos: aniosPorAutor.get(slug)?.get(punto.anio)?.length ?? 0,
        }))
        .sort((a, b) => a.año - b.año);

      return {
        slug,
        nombre: info.nombre,
        color: COLORES_INNOVACION[indice] ?? '#6b7280',
        num_articulos: numArticulos,
        aviso_pocos_datos:
          numArticulos < UMBRAL_POCOS_ARTICULOS_AUTOR
            ? `Este autor tiene solo ${numArticulos} artículo(s) publicado(s); los resultados pueden ser poco fiables.`
            : null,
        trayectoria,
      };
    });

    return ctx.send({ norma, autores });
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
      const frecAutorMap = indice.frecuenciasAutor.get(autorSlug) ?? new Map<string, number>();
      const frecuenciaTotalAutor = frecAutorMap.get(palabra) ?? 0;

      if (frecuenciaTotalAutor === 0) {
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
};

// Alias explícito para dejar claro en el código que el texto plano conserva
// los mismos offsets de carácter que se usarán al normalizar con NFD.
function collapseHtmlButKeepOffsets(html: string | null): string {
  return htmlToPlainText(html);
}
