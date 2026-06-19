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
  anio: number | null;
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
          anio: row.anio,
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
          anio: row.anio,
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

    return ctx.send({
      palabra,
      totalOcurrencias,
      totalArticulos,
      porRevista,
      porAutor,
      porAño,
      concordancias,
    });
  },
};

// Alias explícito para dejar claro en el código que el texto plano conserva
// los mismos offsets de carácter que se usarán al normalizar con NFD.
function collapseHtmlButKeepOffsets(html: string | null): string {
  return htmlToPlainText(html);
}
