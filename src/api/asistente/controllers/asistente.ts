// Asistente conversacional (RAG): responde preguntas sobre el corpus
// combinando búsqueda semántica de artículos (mismo patrón pgvector que
// /api/buscar/semantico) con búsqueda por nombre sobre revistas, autores,
// entidades mencionadas (persona/lugar/institucion/obra, ver sesión 51) y
// el diccionario biográfico de vanguardias completo (services/diccionario-
// vanguardias.ts). Solo accesible con rol Authenticated (ver routes/
// asistente.ts y sembrarPermisosAuthenticated en src/index.ts).

import type { Context } from 'koa';
import { getEmbedding, chatCompletion, type ChatMessage } from '../services/openai-client';
import { buscarEnDiccionario } from '../services/diccionario-vanguardias';
import { mejoresCoincidencias, construirFrecuencias } from '../services/coincidencias';

const TOP_ARTICULOS = 6;
const MIN_SIMILITUD_ARTICULOS = 0.35;
const TOP_REVISTAS = 3;
const TOP_AUTORES = 4;
const TOP_ENTIDADES = 4;
const TOP_DICCIONARIO = 4;

function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  return limpio.length > max ? limpio.slice(0, max) + '…' : limpio;
}

// Texto plano equivalente al contenido "blocks" (rich text) de Strapi,
// mismo criterio que extractPlainText en frontend/lib/blocks.tsx.
function extraerTextoBloques(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block: any) => (block?.children ?? []).map((c: any) => c?.text ?? '').join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fragmentoArticulo(texto: string | null): string {
  if (!texto) return '';
  const limpio = texto
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_: string, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > 500 ? limpio.slice(0, 500) + '…' : limpio;
}

interface ArticuloContexto {
  titulo: string;
  slug: string;
  autores: string[];
  revista: string;
  numeroOrden: number | null;
  anio: number | null;
  fragmento: string;
}

// Misma consulta pgvector que buscar.semantico (backend/src/api/buscar/
// controllers/buscar.ts), simplificada: sin filtros ni paginación, top N.
async function buscarArticulos(knex: any, vectorLiteral: string): Promise<ArticuloContexto[]> {
  const sql = `
    SELECT
      a.id          AS article_id,
      a.titulo      AS articulo_titulo,
      a.slug        AS articulo_slug,
      a.texto_plano AS texto_plano,
      i.numero_orden AS numero_orden,
      i.ano          AS anio,
      p.titulo       AS revista_titulo,
      1 - (a.embedding <=> ?::vector) AS similitud
    FROM articles a
    INNER JOIN articles_issue_lnk     ail ON ail.article_id = a.id
    INNER JOIN issues                 i   ON i.id  = ail.issue_id
    INNER JOIN issues_publication_lnk ipl ON ipl.issue_id = i.id
    INNER JOIN publications           p   ON p.id  = ipl.publication_id
    WHERE a.published_at IS NOT NULL
      AND i.published_at IS NOT NULL
      AND p.published_at IS NOT NULL
      AND a.embedding IS NOT NULL
      AND (a.es_anuncio = false OR a.es_anuncio IS NULL)
    ORDER BY a.embedding <=> ?::vector
    LIMIT ?
  `;
  const { rows } = await knex.raw(sql, [vectorLiteral, vectorLiteral, TOP_ARTICULOS]);
  const filas = (rows as any[]).filter((r) => Number(r.similitud) >= MIN_SIMILITUD_ARTICULOS);

  const articleIds = filas.map((r) => r.article_id);
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

  return filas.map((r) => ({
    titulo: r.articulo_titulo as string,
    slug: r.articulo_slug as string,
    autores: authorsByArticle.get(r.article_id) ?? [],
    revista: r.revista_titulo as string,
    numeroOrden: r.numero_orden ? Number(r.numero_orden) : null,
    anio: r.anio ? Number(r.anio) : null,
    fragmento: fragmentoArticulo(r.texto_plano),
  }));
}

interface RevistaContexto {
  titulo: string;
  slug: string;
  descripcion: string;
  anioInicio: number | null;
  anioFin: number | null;
  lugarPublicacion: string | null;
  periodicidad: string | null;
  numerosPublicados: number | null;
  directores: string[];
}

// Mismo criterio de caché que cargarAutores(): el catálogo de revistas es
// pequeño (unas pocas decenas), cabe entero en memoria.
let revistasCache: RevistaContexto[] | null = null;
let revistasFrecuencias: Map<string, number> | null = null;

async function cargarRevistas(): Promise<RevistaContexto[]> {
  if (!revistasCache) {
    const revistas = await strapi.documents('api::publication.publication').findMany({
      status: 'published',
      fields: [
        'titulo', 'slug', 'descripcion', 'año_inicio', 'año_fin',
        'lugar_publicacion', 'periodicidad', 'numeros_publicados',
      ],
      populate: { directores: { fields: ['nombre'] } },
    });
    revistasCache = (revistas as any[]).map((r) => ({
      titulo: r.titulo as string,
      slug: r.slug as string,
      descripcion: recortar(extraerTextoBloques(r.descripcion), 600),
      anioInicio: r.año_inicio ?? null,
      anioFin: r.año_fin ?? null,
      lugarPublicacion: r.lugar_publicacion ?? null,
      periodicidad: r.periodicidad ?? null,
      numerosPublicados: r.numeros_publicados ?? null,
      directores: (r.directores ?? []).map((d: any) => d.nombre as string),
    }));
    revistasFrecuencias = construirFrecuencias(revistasCache, (r) => r.titulo);
  }
  return revistasCache;
}

async function buscarRevistas(pregunta: string): Promise<RevistaContexto[]> {
  const catalogo = await cargarRevistas();
  return mejoresCoincidencias(pregunta, catalogo, (r) => r.titulo, TOP_REVISTAS, revistasFrecuencias!);
}

interface AutorContexto {
  nombre: string;
  slug: string;
  biografia: string;
  anioNacimiento: number | null;
  anioFallecimiento: number | null;
}

// Catálogo de autores cacheado en memoria (mismo espíritu de caché-
// prototipo que services/lemas.ts): al no depender ya de que el usuario
// escriba los nombres con mayúscula, comparar contra el catálogo entero
// es más simple y fiable que construir un filtro $containsi por candidato
// extraído del texto — y de paso evita una consulta a Postgres en cada
// pregunta salvo la primera del proceso.
let autoresCache: AutorContexto[] | null = null;
let autoresFrecuencias: Map<string, number> | null = null;

async function cargarAutores(): Promise<AutorContexto[]> {
  if (!autoresCache) {
    const autores = await strapi.documents('api::author.author').findMany({
      status: 'published',
      fields: ['nombre', 'slug', 'biografia', 'anio_nacimiento', 'anio_fallecimiento'],
    });
    autoresCache = (autores as any[]).map((a) => ({
      nombre: a.nombre as string,
      slug: a.slug as string,
      biografia: recortar(extraerTextoBloques(a.biografia), 600),
      anioNacimiento: a.anio_nacimiento ?? null,
      anioFallecimiento: a.anio_fallecimiento ?? null,
    }));
    autoresFrecuencias = construirFrecuencias(autoresCache, (a) => a.nombre);
  }
  return autoresCache;
}

async function buscarAutores(pregunta: string): Promise<AutorContexto[]> {
  const catalogo = await cargarAutores();
  return mejoresCoincidencias(pregunta, catalogo, (a) => a.nombre, TOP_AUTORES, autoresFrecuencias!);
}

interface EntidadContexto {
  nombre: string;
  tipo: string;
  descripcion: string;
}

// Mismo criterio de caché que cargarAutores(). Solo se cargan entidades
// publicadas; el campo `descripcion` (biografía del diccionario de
// vanguardias) ya viene resuelto desde la sesión 51, no hace falta volver
// a consultar menciones/confianza aquí.
let entidadesCache: EntidadContexto[] | null = null;
let entidadesFrecuencias: Map<string, number> | null = null;

async function cargarEntidades(): Promise<EntidadContexto[]> {
  if (!entidadesCache) {
    const entidades = await strapi.documents('api::entidad-mencionada.entidad-mencionada').findMany({
      status: 'published',
      fields: ['nombre', 'tipo', 'descripcion'],
    });
    entidadesCache = (entidades as any[]).map((e) => ({
      nombre: e.nombre as string,
      tipo: e.tipo as string,
      descripcion: recortar(e.descripcion ?? '', 600),
    }));
    entidadesFrecuencias = construirFrecuencias(entidadesCache, (e) => e.nombre);
  }
  return entidadesCache;
}

async function buscarEntidades(pregunta: string): Promise<EntidadContexto[]> {
  const catalogo = await cargarEntidades();
  return mejoresCoincidencias(pregunta, catalogo, (e) => e.nombre, TOP_ENTIDADES, entidadesFrecuencias!);
}

interface Fuente {
  id: string;
  tipo: 'articulo' | 'revista' | 'autor' | 'entidad' | 'diccionario';
  titulo: string;
  link: string | null;
  fragmento: string;
}

export default {
  async preguntar(ctx: Context) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return ctx.internalServerError('OPENAI_API_KEY no configurada.');

    const body = ctx.request.body as {
      pregunta?: string;
      historial?: { rol: 'usuario' | 'asistente'; contenido: string }[];
    };
    const pregunta = typeof body.pregunta === 'string' ? body.pregunta.trim() : '';
    if (pregunta.length < 3) {
      return ctx.badRequest('El parámetro "pregunta" debe tener al menos 3 caracteres.');
    }
    const historial = Array.isArray(body.historial) ? body.historial.slice(-6) : [];

    let queryVector: number[];
    try {
      queryVector = await getEmbedding(pregunta, apiKey);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return ctx.internalServerError(`Error al generar embedding: ${msg}`);
    }

    const knex = strapi.db.connection;
    const vectorLiteral = `[${queryVector.join(',')}]`;

    const [articulos, revistas, autores, entidades, diccionario] = await Promise.all([
      buscarArticulos(knex, vectorLiteral),
      buscarRevistas(pregunta),
      buscarAutores(pregunta),
      buscarEntidades(pregunta),
      buscarEnDiccionario(pregunta, TOP_DICCIONARIO),
    ]);

    const fuentes: Fuente[] = [];
    const bloques: string[] = [];

    if (articulos.length > 0) {
      bloques.push('ARTÍCULOS DEL CORPUS:');
      articulos.forEach((a, i) => {
        const id = `A${i + 1}`;
        fuentes.push({ id, tipo: 'articulo', titulo: a.titulo, link: `/articulos/${a.slug}`, fragmento: a.fragmento });
        bloques.push(
          `[${id}] "${a.titulo}" — ${a.autores.join(', ') || 'autor desconocido'}, ${a.revista} n.º ${a.numeroOrden ?? '?'} (${a.anio ?? '?'})\n${a.fragmento}`
        );
      });
    }

    if (revistas.length > 0) {
      bloques.push('\nREVISTAS:');
      revistas.forEach((r, i) => {
        const id = `R${i + 1}`;
        fuentes.push({ id, tipo: 'revista', titulo: r.titulo, link: `/revistas/${r.slug}`, fragmento: r.descripcion });
        const fechas = r.anioInicio || r.anioFin ? ` (${r.anioInicio ?? '?'}-${r.anioFin ?? '?'})` : '';
        const lugar = r.lugarPublicacion ? `, ${r.lugarPublicacion}` : '';
        const directores = r.directores.length > 0 ? `. Dirigida por: ${r.directores.join(', ')}` : '';
        const periodicidad = r.periodicidad ? `. Periodicidad: ${r.periodicidad}` : '';
        const numeros = r.numerosPublicados != null ? `. ${r.numerosPublicados} números publicados` : '';
        bloques.push(
          `[${id}] ${r.titulo}${fechas}${lugar}${directores}${periodicidad}${numeros}${r.descripcion ? '\n' + r.descripcion : ''}`
        );
      });
    }

    if (autores.length > 0) {
      bloques.push('\nAUTORES:');
      autores.forEach((a, i) => {
        const id = `AU${i + 1}`;
        fuentes.push({ id, tipo: 'autor', titulo: a.nombre, link: `/autores/${a.slug}`, fragmento: a.biografia });
        const fechas =
          a.anioNacimiento || a.anioFallecimiento ? ` (${a.anioNacimiento ?? '?'}-${a.anioFallecimiento ?? '?'})` : '';
        bloques.push(`[${id}] ${a.nombre}${fechas}${a.biografia ? '\n' + a.biografia : ''}`);
      });
    }

    if (entidades.length > 0) {
      bloques.push('\nENTIDADES MENCIONADAS EN EL CORPUS (personas, lugares, instituciones, obras):');
      entidades.forEach((e, i) => {
        const id = `E${i + 1}`;
        fuentes.push({ id, tipo: 'entidad', titulo: e.nombre, link: null, fragmento: e.descripcion });
        bloques.push(`[${id}] ${e.nombre} (${e.tipo})${e.descripcion ? '\n' + e.descripcion : ''}`);
      });
    }

    if (diccionario.length > 0) {
      bloques.push('\nDICCIONARIO BIOGRÁFICO DE VANGUARDIAS:');
      diccionario.forEach((d, i) => {
        const id = `D${i + 1}`;
        const texto = recortar(d.texto ?? '', 700);
        fuentes.push({ id, tipo: 'diccionario', titulo: d.nombre, link: null, fragmento: texto });
        bloques.push(`[${id}] ${d.nombre} (${d.tipo})${texto ? '\n' + texto : ''}`);
      });
    }

    const contexto = bloques.join('\n\n') || '(No se ha encontrado contexto relevante en el corpus para esta pregunta.)';

    const systemPrompt = `Eres el asistente de "Edad de Plata", una hemeroteca digital de revistas culturales españolas de la Edad de Plata (aprox. 1898-1936). Respondes preguntas de investigadores y lectores sobre las revistas, los artículos, los autores y las personas, lugares, instituciones y movimientos de la época.

INSTRUCCIONES ESTRICTAS:
- Responde ÚNICAMENTE con la información del CONTEXTO proporcionado a continuación. No uses conocimiento general ni inventes datos, fechas o atribuciones que no estén en el contexto.
- Cuando uses un dato del contexto, cita su identificador entre corchetes, por ejemplo: "García Lorca colaboró con la Residencia de Estudiantes [AU1]."
- Si el contexto no contiene información suficiente para responder, dilo explícitamente: "No tengo información suficiente en el corpus para responder a esto." No lo compenses con conocimiento externo.
- Responde en español, en un tono claro y accesible, sin tecnicismos innecesarios.

CONTEXTO:
${contexto}`;

    const mensajes: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historial.map((h) => ({
        role: (h.rol === 'usuario' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: h.contenido,
      })),
      { role: 'user', content: pregunta },
    ];

    let respuesta: string;
    try {
      respuesta = await chatCompletion(mensajes, apiKey, { maxTokens: 700, temperature: 0.2 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return ctx.internalServerError(`Error al generar la respuesta: ${msg}`);
    }

    return ctx.send({ respuesta, fuentes });
  },
};
