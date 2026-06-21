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

// Stopwords del español para el análisis estilométrico (TF-IDF): artículos,
// pronombres (personales, posesivos, demostrativos, relativos e
// indefinidos), preposiciones y conjunciones. Se excluyen deliberadamente
// del cálculo porque son palabras gramaticales de uso casi universal que no
// caracterizan el estilo de un autor concreto. A diferencia de
// `stripDiacritics` (usado en concordancias), aquí SÍ se conservan las
// tildes: la tokenización de este endpoint no pliega diacríticos.
const STOPWORDS = new Set([
  // Artículos
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'lo',
  // Pronombres personales (sujeto, objeto, preposicionales)
  'yo', 'tú', 'tu', 'vos', 'él', 'ella', 'ello', 'nosotros', 'nosotras',
  'vosotros', 'vosotras', 'ellos', 'ellas', 'usted', 'ustedes', 'me', 'te',
  'se', 'nos', 'os', 'le', 'les', 'mí', 'ti', 'sí', 'conmigo', 'contigo',
  'consigo',
  // Pronombres y determinantes posesivos
  'mi', 'mis', 'tus', 'su', 'sus', 'nuestro', 'nuestra', 'nuestros',
  'nuestras', 'vuestro', 'vuestra', 'vuestros', 'vuestras', 'mío', 'mía',
  'míos', 'mías', 'tuyo', 'tuya', 'tuyos', 'tuyas', 'suyo', 'suya', 'suyos',
  'suyas',
  // Demostrativos
  'este', 'esta', 'estos', 'estas', 'esto', 'ese', 'esa', 'esos', 'esas',
  'eso', 'aquel', 'aquella', 'aquellos', 'aquellas', 'aquello',
  // Relativos e interrogativos
  'que', 'quien', 'quienes', 'cual', 'cuales', 'cuyo', 'cuya', 'cuyos',
  'cuyas', 'donde', 'cuando', 'como', 'cuanto', 'cuanta', 'cuantos',
  'cuantas',
  // Indefinidos
  'alguien', 'algo', 'nadie', 'nada', 'alguno', 'alguna', 'algunos',
  'algunas', 'ninguno', 'ninguna', 'ningunos', 'ningunas', 'cualquier',
  'cualquiera', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros',
  'otras', 'mismo', 'misma', 'mismos', 'mismas', 'tal', 'tales', 'cada',
  'varios', 'varias', 'uno', 'unos', 'unas',
  // Preposiciones
  'a', 'ante', 'bajo', 'cabe', 'con', 'contra', 'de', 'desde', 'en',
  'entre', 'hacia', 'hasta', 'para', 'por', 'según', 'sin', 'sobre', 'tras',
  'durante', 'mediante', 'excepto', 'salvo', 'al', 'del',
  // Conjunciones y adverbios funcionales
  'y', 'e', 'ni', 'o', 'u', 'pero', 'mas', 'sino', 'aunque', 'porque',
  'pues', 'si', 'ya', 'muy', 'más', 'menos', 'también', 'tampoco', 'no',
  'tan', 'tanto', 'hay',
]);

// Tokeniza un texto en minúsculas, sin puntuación (conservando tildes y
// letras Unicode), separado por espacios. Por defecto descarta las
// stopwords (palabras funcionales); `incluirFuncionales` permite
// conservarlas para quien quiera analizar el corpus sin ese filtro.
function tokenize(text: string, incluirFuncionales = false): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && (incluirFuncionales || !STOPWORDS.has(token)));
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

    const tokens1 = tokenize(texto1, incluirFuncionales);
    const tokens2 = tokenize(texto2, incluirFuncionales);

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

  // Deriva estilística de 1 a 4 autores respecto a la norma del corpus (el
  // centroide TF-IDF de TODOS los autores con artículos publicados). Para
  // cada autor seleccionado, cada punto de la trayectoria es un "documento"
  // TF-IDF con sus artículos de un año concreto, comparado por distancia de
  // coseno contra el centroide de la norma.
  async innovacion(ctx: Context) {
    const autoresParam = typeof ctx.query.autores === 'string' ? ctx.query.autores : '';
    const slugs = [...new Set(autoresParam.split(',').map((s) => s.trim()).filter(Boolean))];

    if (slugs.length === 0) {
      return ctx.badRequest('El parámetro "autores" es obligatorio (de 1 a 4 slugs separados por comas).');
    }
    if (slugs.length > 4) {
      return ctx.badRequest('Selecciona como máximo 4 autores.');
    }

    const knex = strapi.db.connection;

    const rows: { autor_slug: string; autor_nombre: string; texto: string | null; anio: number | null }[] =
      await knex('articles as a')
        .innerJoin('articles_authors_lnk as aal', 'aal.article_id', 'a.id')
        .innerJoin('authors as au', 'au.id', 'aal.author_id')
        .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
        .innerJoin('issues as i', 'i.id', 'ail.issue_id')
        .where('a.published_at', 'is not', null)
        .andWhere('au.published_at', 'is not', null)
        .andWhere('i.published_at', 'is not', null)
        .select(
          'au.slug as autor_slug',
          'au.nombre as autor_nombre',
          'a.texto as texto',
          'i.ano as anio'
        );

    const nombrePorSlug = new Map<string, string>();
    for (const row of rows) {
      nombrePorSlug.set(row.autor_slug, row.autor_nombre);
    }

    for (const slug of slugs) {
      if (!nombrePorSlug.has(slug)) {
        return ctx.notFound(`No se ha encontrado el autor "${slug}" (o no tiene artículos publicados).`);
      }
    }

    // --- Norma: centroide TF-IDF de todo el corpus (todos los autores) ---
    const tokensNorma = tokenize(rows.map((row) => htmlToPlainText(row.texto)).join(' '));
    const autoresEnNorma = new Set(rows.map((row) => row.autor_slug)).size;

    // --- Un "documento" TF-IDF por cada (autor, año) de los seleccionados ---
    interface PuntoPendiente {
      slug: string;
      anio: number;
      tokens: string[];
      numArticulos: number;
    }
    const puntosPorAutorAño = new Map<string, PuntoPendiente>();
    const totalArticulosPorAutor = new Map<string, number>();

    for (const row of rows) {
      if (!slugs.includes(row.autor_slug)) continue;

      totalArticulosPorAutor.set(
        row.autor_slug,
        (totalArticulosPorAutor.get(row.autor_slug) ?? 0) + 1
      );

      if (row.anio === null) continue;

      const clave = `${row.autor_slug}::${row.anio}`;
      const punto = puntosPorAutorAño.get(clave) ?? {
        slug: row.autor_slug,
        anio: row.anio,
        tokens: [],
        numArticulos: 0,
      };
      punto.tokens.push(...tokenize(htmlToPlainText(row.texto)));
      punto.numArticulos += 1;
      puntosPorAutorAño.set(clave, punto);
    }

    const puntos = [...puntosPorAutorAño.values()]
      .filter((punto) => punto.tokens.length > 0)
      .sort((a, b) => a.anio - b.anio);

    const documentos = [tokensNorma, ...puntos.map((punto) => punto.tokens)];
    const vocabulario = [...new Set(documentos.flat())];
    const vectores = buildTfIdf(documentos, vocabulario);
    const vectorNorma = vectores[0];

    const UMBRAL_ARTICULOS_AUTOR = 3;
    const UMBRAL_ARTICULOS_NORMA = 20;
    const COLORES_AUTORES = ['#DA3C00', '#3838BD', '#008867', '#DD158B'];

    const autoresResultado = slugs.map((slug, index) => {
      const nombre = nombrePorSlug.get(slug) as string;
      const numArticulos = totalArticulosPorAutor.get(slug) ?? 0;

      const trayectoria = puntos
        .map((punto, i) => ({ punto, vector: vectores[i + 1] }))
        .filter(({ punto }) => punto.slug === slug)
        .map(({ punto, vector }) => ({
          año: punto.anio,
          distancia: 1 - cosineSimilarity(vector, vectorNorma, vocabulario),
          num_articulos: punto.numArticulos,
        }));

      return {
        slug,
        nombre,
        color: COLORES_AUTORES[index % COLORES_AUTORES.length],
        num_articulos: numArticulos,
        aviso_pocos_datos:
          numArticulos < UMBRAL_ARTICULOS_AUTOR
            ? `El cálculo de ${nombre} se ha hecho con ${numArticulos} artículo${numArticulos === 1 ? '' : 's'} y puede no ser representativo.`
            : null,
        trayectoria,
      };
    });

    return ctx.send({
      norma: {
        num_autores: autoresEnNorma,
        num_articulos: rows.length,
        aviso_pocos_datos:
          rows.length < UMBRAL_ARTICULOS_NORMA
            ? `El cálculo de la norma se ha hecho con ${rows.length} artículo${rows.length === 1 ? '' : 's'} de ${autoresEnNorma} autor${autoresEnNorma === 1 ? '' : 'es'} y puede no ser representativo.`
            : null,
      },
      autores: autoresResultado,
    });
  },
};

// Alias explícito para dejar claro en el código que el texto plano conserva
// los mismos offsets de carácter que se usarán al normalizar con NFD.
function collapseHtmlButKeepOffsets(html: string | null): string {
  return htmlToPlainText(html);
}
