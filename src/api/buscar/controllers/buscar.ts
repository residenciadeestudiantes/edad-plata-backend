// Búsqueda exacta de una frase literal en el cuerpo completo de los
// artículos (a diferencia de /api/analisis/concordancias, que busca una
// palabra suelta con límites de palabra \b). Devuelve un resultado por
// artículo (no por ocurrencia), con un único fragmento de contexto, en el
// formato {data, meta} que espera la página /buscar del frontend.

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

const CONTEXT_CHARS = 80;

// Quita las marcas diacríticas (tildes, diéresis) tras una normalización NFD,
// preservando la longitud de caracteres del texto original carácter a
// carácter, para poder reutilizar los mismos índices sobre el texto plano.
function stripDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

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
  async texto(ctx: Context) {
    const frase = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';

    if (frase.length < 3) {
      return ctx.badRequest('El parámetro "q" debe tener al menos 3 caracteres.');
    }

    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Number(ctx.query.pageSize) || 20);

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
      .andWhere('p.published_at', 'is not', null);

    if (revistaSlug) {
      articlesQuery = articlesQuery.andWhere('p.slug', revistaSlug);
    }
    if (desde !== null) {
      // La columna real en SQLite es `ano` (Strapi normaliza la ñ del nombre del campo).
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

    const normalizedFrase = stripDiacritics(frase).toLowerCase();

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
      const normalizedText = stripDiacritics(plainText).toLowerCase();
      const normalizedTitulo = stripDiacritics(row.articulo_titulo ?? '').toLowerCase();

      const matchIndex = normalizedText.indexOf(normalizedFrase);
      const matchEnTitulo = normalizedTitulo.includes(normalizedFrase);

      if (matchIndex === -1 && !matchEnTitulo) continue;

      let fragmento: string;
      if (matchIndex !== -1) {
        const start = Math.max(0, matchIndex - CONTEXT_CHARS);
        const end = Math.min(plainText.length, matchIndex + frase.length + CONTEXT_CHARS);
        const antes = collapseWhitespace(plainText.slice(start, matchIndex));
        const coincidencia = plainText.slice(matchIndex, matchIndex + frase.length);
        const despues = collapseWhitespace(plainText.slice(matchIndex + frase.length, end));
        fragmento = `${antes} **${coincidencia}** ${despues}`.trim();
      } else {
        fragmento = row.articulo_titulo;
      }

      resultados.push({
        id: row.article_id,
        titulo: row.articulo_titulo,
        slug: row.articulo_slug,
        autores: authorsByArticle.get(row.article_id) ?? [],
        revista: row.revista_titulo,
        revista_slug: row.revista_slug,
        numero_orden: row.numero_orden,
        año: row.anio,
        fragmento,
      });
    }

    const total = resultados.length;
    const pageCount = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const data = resultados.slice(start, start + pageSize);

    return ctx.send({ data, meta: { total, page, pageSize, pageCount } });
  },
};
