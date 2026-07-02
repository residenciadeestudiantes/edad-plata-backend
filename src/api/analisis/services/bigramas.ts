// ARQUITECTURA DE CACHÉ:
// Prototipo: caché en memoria (se pierde al reiniciar Strapi).
// Producción: sustituir indiceCache por Redis con la misma interfaz
// (obtenerIndice/construirIndice), sin que el controlador tenga que cambiar.
// El índice se construye bajo demanda la primera vez que se consulta.

import { STOPWORDS } from './stopwords';

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface ProbabilidadToken {
  token: string;
  frecuencia: number;
  probabilidad: number;
}

export interface IndiceLexico {
  indiceCorpus: Map<string, Map<string, number>>;
  indicePredecesores: Map<string, Map<string, number>>;
  indiceAutores: Map<string, Map<string, Map<string, number>>>;
  indicePredecesoresAutores: Map<string, Map<string, Map<string, number>>>;
  frecuenciasCorpus: Map<string, number>;
  frecuenciasAutor: Map<string, Map<string, number>>;
  totalArticulos: number;
  totalTokens: number;
}

// Dos corpus indexables con la misma estructura e independientes entre sí:
// "literario" (artículos que no son anuncios, texto en `texto`) y
// "publicidad" (anuncios, texto en `texto_ocr_anuncios`). Cada uno tiene su
// propia caché para no mezclar ni reconstruir el uno al pedir el otro.
export type TipoCorpus = 'literario' | 'publicidad';

const indiceCachePorCorpus = new Map<TipoCorpus, IndiceLexico>();
const fechaConstruccionPorCorpus = new Map<TipoCorpus, Date>();

export function obtenerIndice(corpus: TipoCorpus = 'literario'): IndiceLexico | null {
  return indiceCachePorCorpus.get(corpus) ?? null;
}

export function obtenerFechaConstruccion(corpus: TipoCorpus = 'literario'): Date | null {
  return fechaConstruccionPorCorpus.get(corpus) ?? null;
}

// Limpieza de HTML equivalente a la del resto de endpoints de análisis, más
// la eliminación explícita de enlaces javascript:dispatch(...) que pueden
// quedar en textos importados sin sanear.
export function limpiarHtml(html: string | null): string {
  if (!html) return '';

  return html
    .replace(/<a[^>]*href="javascript:[^"]*"[^>]*>.*?<\/a>/gi, ' ')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokeniza en minúsculas, quitando toda la puntuación salvo los guiones
// internos de palabras compuestas (p. ej. "anglo-americano" se conserva
// como un solo token; un guion suelto al principio o final de un token se
// recorta). Filtra tokens de menos de 3 caracteres y stopwords.
export function tokenizarParaBigramas(texto: string): string[] {
  return stripDiacritics(texto)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ''))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function incrementar(mapa: Map<string, number>, clave: string): void {
  mapa.set(clave, (mapa.get(clave) ?? 0) + 1);
}

function incrementarAnidado(
  mapa: Map<string, Map<string, number>>,
  clave: string,
  subclave: string
): void {
  const sub = mapa.get(clave) ?? new Map<string, number>();
  incrementar(sub, subclave);
  mapa.set(clave, sub);
}

function incrementarDobleAnidado(
  mapa: Map<string, Map<string, Map<string, number>>>,
  clave: string,
  subclave: string,
  subsubclave: string
): void {
  const nivel1 = mapa.get(clave) ?? new Map<string, Map<string, number>>();
  incrementarAnidado(nivel1, subclave, subsubclave);
  mapa.set(clave, nivel1);
}

const TAMAÑO_PAGINA = 100;

// Recibe la instancia global de Strapi por parámetro (en vez de usar el
// global directamente) para que este módulo sea testeable de forma aislada.
export async function construirIndice(
  strapiInstance: {
    db: { connection: import('knex').Knex };
  },
  corpus: TipoCorpus = 'literario'
): Promise<IndiceLexico> {
  const knex = strapiInstance.db.connection;
  const columnaTexto = corpus === 'publicidad' ? 'a.texto_ocr_anuncios' : 'a.texto';

  const indiceCorpus = new Map<string, Map<string, number>>();
  const indicePredecesores = new Map<string, Map<string, number>>();
  const indiceAutores = new Map<string, Map<string, Map<string, number>>>();
  const indicePredecesoresAutores = new Map<string, Map<string, Map<string, number>>>();
  const frecuenciasCorpus = new Map<string, number>();
  const frecuenciasAutor = new Map<string, Map<string, number>>();

  let totalArticulos = 0;
  let totalTokens = 0;
  let offset = 0;

  // Paginación en dos pasos (IDs de artículo primero, luego sus filas con
  // autores) para no cortar un artículo a la mitad cuando tiene varios
  // autores y el join devuelve varias filas por artículo.
  for (;;) {
    const idsPagina: { id: number }[] = await knex('articles as a')
      .where('a.published_at', 'is not', null)
      .andWhere('a.idioma', 'Español')
      .andWhere((qb) =>
        corpus === 'publicidad'
          ? qb.where('a.es_anuncio', true)
          : qb.where('a.es_anuncio', false).orWhereNull('a.es_anuncio')
      )
      .orderBy('a.id')
      .offset(offset)
      .limit(TAMAÑO_PAGINA)
      .select('a.id as id');

    if (idsPagina.length === 0) break;

    const ids = idsPagina.map((row) => row.id);

    const filas: { article_id: number; texto: string | null; autor_slug: string | null }[] =
      await knex('articles as a')
        .leftJoin('articles_authors_lnk as aal', 'aal.article_id', 'a.id')
        .leftJoin('authors as au', (join) => {
          join.on('au.id', '=', 'aal.author_id').andOnNotNull('au.published_at');
        })
        .whereIn('a.id', ids)
        .select('a.id as article_id', `${columnaTexto} as texto`, 'au.slug as autor_slug');

    const articulosPorId = new Map<number, { texto: string | null; autores: Set<string> }>();
    for (const fila of filas) {
      const entry = articulosPorId.get(fila.article_id) ?? {
        texto: fila.texto,
        autores: new Set<string>(),
      };
      if (fila.autor_slug) entry.autores.add(fila.autor_slug);
      articulosPorId.set(fila.article_id, entry);
    }

    for (const { texto, autores } of articulosPorId.values()) {
      const tokens = tokenizarParaBigramas(limpiarHtml(texto));
      if (tokens.length === 0) continue;

      totalArticulos += 1;
      totalTokens += tokens.length;

      for (let i = 0; i < tokens.length; i++) {
        const palabra = tokens[i];
        incrementar(frecuenciasCorpus, palabra);

        if (i + 1 < tokens.length) {
          incrementarAnidado(indiceCorpus, palabra, tokens[i + 1]);
        }
        if (i - 1 >= 0) {
          incrementarAnidado(indicePredecesores, palabra, tokens[i - 1]);
        }

        for (const autorSlug of autores) {
          const frecAutor = frecuenciasAutor.get(autorSlug) ?? new Map<string, number>();
          incrementar(frecAutor, palabra);
          frecuenciasAutor.set(autorSlug, frecAutor);

          if (i + 1 < tokens.length) {
            incrementarDobleAnidado(indiceAutores, autorSlug, palabra, tokens[i + 1]);
          }
          if (i - 1 >= 0) {
            incrementarDobleAnidado(indicePredecesoresAutores, autorSlug, palabra, tokens[i - 1]);
          }
        }
      }
    }

    offset += idsPagina.length;
    if (idsPagina.length < TAMAÑO_PAGINA) break;
  }

  const indice: IndiceLexico = {
    indiceCorpus,
    indicePredecesores,
    indiceAutores,
    indicePredecesoresAutores,
    frecuenciasCorpus,
    frecuenciasAutor,
    totalArticulos,
    totalTokens,
  };
  indiceCachePorCorpus.set(corpus, indice);
  fechaConstruccionPorCorpus.set(corpus, new Date());

  return indice;
}

// Devuelve hasta `limite` tokens más probables a partir de `palabra`, según
// el índice dado (de sucesores o de predecesores) y sus frecuencias totales.
export function calcularProbabilidades(
  indice: Map<string, Map<string, number>>,
  frecuencias: Map<string, number>,
  palabra: string,
  limite = 10
): ProbabilidadToken[] {
  const tokens = indice.get(palabra) ?? new Map<string, number>();
  const total = frecuencias.get(palabra) ?? 0;
  if (total === 0) return [];

  return Array.from(tokens.entries())
    .map(([token, frecuencia]) => ({
      token,
      frecuencia,
      probabilidad: frecuencia / total,
    }))
    .sort((a, b) => b.probabilidad - a.probabilidad)
    .slice(0, limite);
}

// Entropía de Shannon (en bits) de una distribución de probabilidades:
// mide cuán impredecible es la palabra que sigue/precede. 0 = totalmente
// predecible; valores más altos = uso más variado/innovador.
export function calcularEntropiaShannon(probabilidades: ProbabilidadToken[]): number {
  return -probabilidades.reduce(
    (acumulado, { probabilidad }) =>
      probabilidad > 0 ? acumulado + probabilidad * Math.log2(probabilidad) : acumulado,
    0
  );
}
