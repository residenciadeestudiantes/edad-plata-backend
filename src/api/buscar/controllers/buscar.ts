// Búsqueda exacta de una frase literal en el cuerpo completo de los
// artículos (a diferencia de /api/analisis/concordancias, que busca una
// palabra suelta con límites de palabra \b). Devuelve un resultado por
// artículo (no por ocurrencia), con un único fragmento de contexto, en el
// formato {data, meta} que espera la página /buscar del frontend.
//
// Búsqueda avanzada (booleana): admite encadenar hasta 3 palabras con
// operadores Y/O/NO entre la 1ª-2ª y la 2ª-3ª (q, op1+q2, op2+q3),
// evaluados de izquierda a derecha sin precedencia.

import type { Context } from 'koa';
import * as https from 'https';

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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

type Operador = 'AND' | 'OR' | 'NOT';

function esOperadorValido(value: string): value is Operador {
  return value === 'AND' || value === 'OR' || value === 'NOT';
}

function combinar(a: boolean, operador: Operador, b: boolean): boolean {
  if (operador === 'AND') return a && b;
  if (operador === 'OR') return a || b;
  return a && !b; // NOT: a debe darse, b no debe darse
}

// Construye el fragmento de contexto a partir del primer término (en orden
// de prioridad) que efectivamente aparece en el cuerpo del artículo. Si
// ninguno aparece en el cuerpo (p. ej. solo coincide en el título, o el
// término que hizo match fue uno excluido con NOT), usa el título como
// fragmento, igual que en la búsqueda simple de un solo término.
function construirFragmento(
  plainText: string,
  normalizedText: string,
  terminosPrioridad: { original: string; normalizado: string }[],
  tituloOriginal: string
): string {
  for (const termino of terminosPrioridad) {
    const index = normalizedText.indexOf(termino.normalizado);
    if (index === -1) continue;

    const start = Math.max(0, index - CONTEXT_CHARS);
    const end = Math.min(plainText.length, index + termino.original.length + CONTEXT_CHARS);
    const antes = collapseWhitespace(plainText.slice(start, index));
    const coincidencia = plainText.slice(index, index + termino.original.length);
    const despues = collapseWhitespace(plainText.slice(index + termino.original.length, end));
    return `${antes} **${coincidencia}** ${despues}`.trim();
  }

  return tituloOriginal;
}

export default {
  async texto(ctx: Context) {
    const palabra1 = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';

    if (palabra1.length < 3) {
      return ctx.badRequest('El parámetro "q" debe tener al menos 3 caracteres.');
    }

    const operador1Raw = typeof ctx.query.op1 === 'string' ? ctx.query.op1.trim().toUpperCase() : '';
    const palabra2 = typeof ctx.query.q2 === 'string' ? ctx.query.q2.trim() : '';
    const operador2Raw = typeof ctx.query.op2 === 'string' ? ctx.query.op2.trim().toUpperCase() : '';
    const palabra3 = typeof ctx.query.q3 === 'string' ? ctx.query.q3.trim() : '';

    // Una condición solo se aplica si tiene operador válido Y su palabra
    // asociada (con el mínimo de caracteres); en otro caso se ignora en
    // silencio en vez de dar error, para tolerar estados intermedios del
    // formulario.
    const usaCondicion1 = esOperadorValido(operador1Raw) && palabra2.length >= 3;
    const operador1 = usaCondicion1 ? (operador1Raw as Operador) : null;
    const usaCondicion2 = usaCondicion1 && esOperadorValido(operador2Raw) && palabra3.length >= 3;
    const operador2 = usaCondicion2 ? (operador2Raw as Operador) : null;

    const page = Math.max(1, Number(ctx.query.page) || 1);
    const pageSize = Math.max(1, Number(ctx.query.pageSize) || 20);

    // Ámbito de la búsqueda: por defecto se busca en ambos (compatibilidad
    // con peticiones que no envíen estos parámetros). Si se envía "false"
    // explícitamente, ese ámbito se excluye.
    const buscarEnTituloAutor = ctx.query.enTituloAutor !== 'false';
    const buscarEnTexto = ctx.query.enTexto !== 'false';

    if (!buscarEnTituloAutor && !buscarEnTexto) {
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
      .andWhere((qb) => qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio'));

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
      'a.texto_plano as texto',
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

    const normalizada1 = stripDiacritics(palabra1).toLowerCase();
    const normalizada2 = usaCondicion1 ? stripDiacritics(palabra2).toLowerCase() : '';
    const normalizada3 = usaCondicion2 ? stripDiacritics(palabra3).toLowerCase() : '';

    // Orden de prioridad para elegir qué término mostrar como fragmento de
    // contexto: el primero de la cadena que de verdad aparece en el cuerpo.
    const terminosPrioridad = [
      { original: palabra1, normalizado: normalizada1 },
      ...(usaCondicion1 ? [{ original: palabra2, normalizado: normalizada2 }] : []),
      ...(usaCondicion2 ? [{ original: palabra3, normalizado: normalizada3 }] : []),
    ];

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
      const plainText = row.texto ?? '';
      const normalizedText = stripDiacritics(plainText).toLowerCase();
      const normalizedTitulo = stripDiacritics(row.articulo_titulo ?? '').toLowerCase();
      const autoresNormalizados = (authorsByArticle.get(row.article_id) ?? []).map((nombre) =>
        stripDiacritics(nombre).toLowerCase()
      );

      // El ámbito (título/autor, texto del artículo, o ambos) decide en qué
      // campos se busca el término; ver checkboxes del formulario avanzado.
      const contieneTermino = (normalizado: string) => {
        const enTexto = buscarEnTexto && normalizedText.includes(normalizado);
        const enTituloOAutor =
          buscarEnTituloAutor &&
          (normalizedTitulo.includes(normalizado) ||
            autoresNormalizados.some((autor) => autor.includes(normalizado)));
        return enTexto || enTituloOAutor;
      };

      let coincide = contieneTermino(normalizada1);
      if (usaCondicion1 && operador1) {
        coincide = combinar(coincide, operador1, contieneTermino(normalizada2));
      }
      if (usaCondicion2 && operador2) {
        coincide = combinar(coincide, operador2, contieneTermino(normalizada3));
      }

      if (!coincide) continue;

      const fragmento = construirFragmento(
        plainText,
        normalizedText,
        terminosPrioridad,
        row.articulo_titulo
      );

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

  async imagenes(ctx: Context) {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
    if (q.length < 3) {
      return ctx.badRequest('El parámetro "q" debe tener al menos 3 caracteres.');
    }

    const page     = Math.max(1, Number(ctx.query.page)     || 1);
    const pageSize = Math.max(1, Number(ctx.query.pageSize) || 20);

    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';
    const autorSlug   = typeof ctx.query.autor   === 'string' ? ctx.query.autor.trim()   : '';
    const desdeRaw    = typeof ctx.query.desde   === 'string' ? ctx.query.desde.trim()   : '';
    const hastaRaw    = typeof ctx.query.hasta   === 'string' ? ctx.query.hasta.trim()   : '';
    const desde = desdeRaw && /^\d+$/.test(desdeRaw) ? Number(desdeRaw) : null;
    const hasta = hastaRaw && /^\d+$/.test(hastaRaw) ? Number(hastaRaw) : null;

    const knex = strapi.db.connection;
    const normalizada = stripDiacritics(q).toLowerCase();

    let query = knex('articles as a')
      .innerJoin('articles_issue_lnk as ail', 'ail.article_id', 'a.id')
      .innerJoin('issues as i', 'i.id', 'ail.issue_id')
      .innerJoin('issues_publication_lnk as ipl', 'ipl.issue_id', 'i.id')
      .innerJoin('publications as p', 'p.id', 'ipl.publication_id')
      .where('a.published_at', 'is not', null)
      .andWhere('i.published_at', 'is not', null)
      .andWhere('p.published_at', 'is not', null)
      .andWhereNot('a.pies_imagen', null)
      .andWhere(knex.raw("a.pies_imagen != ''"))
      .select(
        'a.id as article_id',
        'a.titulo as articulo_titulo',
        'a.slug as articulo_slug',
        'a.pies_imagen as pies_imagen',
        'i.numero_orden as numero_orden',
        'i.ano as anio',
        'p.titulo as revista_titulo',
        'p.slug as revista_slug'
      );

    if (revistaSlug) query = query.andWhere('p.slug', revistaSlug);
    if (desde !== null) query = query.andWhere('i.ano', '>=', desde);
    if (hasta !== null) query = query.andWhere('i.ano', '<=', hasta);

    if (autorSlug) {
      const authorArticleIds: number[] = await knex('articles_authors_lnk as aal')
        .innerJoin('authors as au', 'au.id', 'aal.author_id')
        .where('au.slug', autorSlug)
        .andWhere('au.published_at', 'is not', null)
        .pluck('aal.article_id');
      query = query.whereIn('a.id', authorArticleIds.length > 0 ? authorArticleIds : [-1]);
    }

    const rows: {
      article_id: number;
      articulo_titulo: string;
      articulo_slug: string;
      pies_imagen: string;
      numero_orden: number | null;
      anio: number | null;
      revista_titulo: string;
      revista_slug: string;
    }[] = await query;

    // Filtrado en memoria con normalización de diacríticos
    const resultados = rows
      .filter((row) => stripDiacritics(row.pies_imagen ?? '').toLowerCase().includes(normalizada))
      .map((row) => {
        // Fragmento: la línea que contiene el término buscado
        const lineas = (row.pies_imagen ?? '').split('\n');
        const lineaMatch = lineas.find((l) =>
          stripDiacritics(l).toLowerCase().includes(normalizada)
        ) ?? lineas[0] ?? '';
        const idx = stripDiacritics(lineaMatch).toLowerCase().indexOf(normalizada);
        const fragmento = idx >= 0
          ? `${lineaMatch.slice(0, idx)}**${lineaMatch.slice(idx, idx + q.length)}**${lineaMatch.slice(idx + q.length)}`
          : lineaMatch;

        return {
          id:           row.article_id,
          titulo:       row.articulo_titulo,
          slug:         row.articulo_slug,
          revista:      row.revista_titulo,
          revista_slug: row.revista_slug,
          numero_orden: row.numero_orden,
          año:          row.anio,
          fragmento,
        };
      });

    // Obtener autores
    const articleIds = resultados.map((r) => r.id);
    const authorRows: { article_id: number; nombre: string }[] = articleIds.length
      ? await knex('articles_authors_lnk as aal')
          .innerJoin('authors as au', 'au.id', 'aal.author_id')
          .whereIn('aal.article_id', articleIds)
          .andWhere('au.published_at', 'is not', null)
          .select('aal.article_id as article_id', 'au.nombre as nombre')
      : [];

    const authorsByArticle = new Map<number, string[]>();
    for (const row of authorRows) {
      const list = authorsByArticle.get(row.article_id) ?? [];
      list.push(row.nombre);
      authorsByArticle.set(row.article_id, list);
    }

    const data = resultados
      .map((r) => ({ ...r, autores: authorsByArticle.get(r.id) ?? [] }))
      .slice((page - 1) * pageSize, page * pageSize);

    const total     = resultados.length;
    const pageCount = Math.ceil(total / pageSize);

    return ctx.send({ data, meta: { total, page, pageSize, pageCount } });
  },

  async semantico(ctx: Context) {
    const q = typeof ctx.query.q === 'string' ? ctx.query.q.trim() : '';
    if (q.length < 3) {
      return ctx.badRequest('El parámetro "q" debe tener al menos 3 caracteres.');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return ctx.internalServerError('OPENAI_API_KEY no configurada.');
    }

    const page     = Math.max(1, Number(ctx.query.page)     || 1);
    const pageSize = Math.max(1, Math.min(50, Number(ctx.query.pageSize) || 20));
    const revistaSlug = typeof ctx.query.revista === 'string' ? ctx.query.revista.trim() : '';
    const autorSlug   = typeof ctx.query.autor   === 'string' ? ctx.query.autor.trim()   : '';
    const desdeRaw    = typeof ctx.query.desde   === 'string' ? ctx.query.desde.trim()   : '';
    const hastaRaw    = typeof ctx.query.hasta   === 'string' ? ctx.query.hasta.trim()   : '';
    const desde = desdeRaw && /^\d+$/.test(desdeRaw) ? Number(desdeRaw) : null;
    const hasta = hastaRaw && /^\d+$/.test(hastaRaw) ? Number(hastaRaw) : null;

    // 1. Obtener embedding de la consulta
    let queryVector: number[];
    try {
      queryVector = await getEmbedding(q, apiKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return ctx.internalServerError(`Error al generar embedding: ${msg}`);
    }

    // 2. Búsqueda por similitud coseno en PostgreSQL
    const knex = strapi.db.connection;

    // Construimos la lista de IDs de artículos del autor si se filtra
    let authorArticleIds: number[] | null = null;
    if (autorSlug) {
      authorArticleIds = await knex('articles_authors_lnk as aal')
        .innerJoin('authors as au', 'au.id', 'aal.author_id')
        .where('au.slug', autorSlug)
        .andWhere('au.published_at', 'is not', null)
        .pluck('aal.article_id');
    }

    // La búsqueda vectorial se hace con SQL raw para poder usar el operador <=>
    const vectorLiteral = `[${queryVector.join(',')}]`;

    let sql = `
      SELECT
        a.id          AS article_id,
        a.titulo      AS articulo_titulo,
        a.slug        AS articulo_slug,
        a.texto_plano AS texto_plano,
        i.numero_orden AS numero_orden,
        i.ano          AS anio,
        p.titulo       AS revista_titulo,
        p.slug         AS revista_slug,
        1 - (a.embedding <=> ?::vector) AS similitud
      FROM articles a
      INNER JOIN articles_issue_lnk   ail ON ail.article_id = a.id
      INNER JOIN issues               i   ON i.id  = ail.issue_id
      INNER JOIN issues_publication_lnk ipl ON ipl.issue_id = i.id
      INNER JOIN publications         p   ON p.id  = ipl.publication_id
      WHERE a.published_at IS NOT NULL
        AND i.published_at IS NOT NULL
        AND p.published_at IS NOT NULL
        AND a.embedding IS NOT NULL
        AND (a.es_anuncio = false OR a.es_anuncio IS NULL)
    `;

    const params: unknown[] = [vectorLiteral];

    if (revistaSlug) { sql += ' AND p.slug = ?';  params.push(revistaSlug); }
    if (desde !== null) { sql += ' AND i.ano >= ?'; params.push(desde); }
    if (hasta !== null) { sql += ' AND i.ano <= ?'; params.push(hasta); }
    if (authorArticleIds !== null) {
      if (authorArticleIds.length === 0) {
        return ctx.send({ data: [], meta: { total: 0, page, pageSize, pageCount: 0 } });
      }
      sql += ` AND a.id = ANY(?)`;
      params.push(authorArticleIds);
    }

    // Pedimos más resultados de los necesarios para poder paginar en memoria
    const FETCH_LIMIT = 200;
    sql += ` ORDER BY a.embedding <=> ?::vector LIMIT ?`;
    params.push(vectorLiteral, FETCH_LIMIT);

    const { rows } = await knex.raw(sql, params);

    // 3. Obtener autores de los artículos recuperados
    const articleIds = rows.map((r) => r.article_id);
    const authorRows: { article_id: number; nombre: string }[] = articleIds.length
      ? await knex('articles_authors_lnk as aal')
          .innerJoin('authors as au', 'au.id', 'aal.author_id')
          .whereIn('aal.article_id', articleIds)
          .andWhere('au.published_at', 'is not', null)
          .select('aal.article_id as article_id', 'au.nombre as nombre')
      : [];

    const authorsByArticle = new Map<number, string[]>();
    for (const row of authorRows) {
      const list = authorsByArticle.get(row.article_id) ?? [];
      list.push(row.nombre);
      authorsByArticle.set(row.article_id, list);
    }

    // 4. Construir respuesta (descartamos resultados por debajo del umbral mínimo)
    const MIN_SIMILITUD = 0.35;
    const resultados = rows.filter((row) => Number(row.similitud) >= MIN_SIMILITUD).map((row) => ({
      id:           row.article_id,
      titulo:       row.articulo_titulo,
      slug:         row.articulo_slug,
      autores:      authorsByArticle.get(row.article_id) ?? [],
      revista:      row.revista_titulo,
      revista_slug: row.revista_slug,
      numero_orden: row.numero_orden ? Number(row.numero_orden) : null,
      año:          row.anio ? Number(row.anio) : null,
      fragmento:    fragmentoDesdeTextoPlano(row.texto_plano),
      similitud:    Math.round(Number(row.similitud) * 1000) / 1000,
    }));

    const total     = resultados.length;
    const pageCount = Math.ceil(total / pageSize);
    const start     = (page - 1) * pageSize;
    const data      = resultados.slice(start, start + pageSize);

    return ctx.send({ data, meta: { total, page, pageSize, pageCount } });
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000),
    });
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/embeddings',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.data[0].embedding as number[]);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fragmentoDesdeTextoPlano(texto: string | null): string {
  if (!texto) return '';
  const limpio = texto
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > 300 ? limpio.slice(0, 300) + '…' : limpio;
}
