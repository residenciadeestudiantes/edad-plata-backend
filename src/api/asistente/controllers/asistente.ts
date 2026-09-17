// Asistente conversacional (RAG): responde preguntas sobre el corpus
// combinando búsqueda semántica de artículos (mismo patrón pgvector que
// /api/buscar/semantico) con búsqueda por nombre sobre autores, entidades
// mencionadas (persona/lugar/institucion/obra, ver sesión 51) y el
// diccionario biográfico de vanguardias completo (services/diccionario-
// vanguardias.ts). Solo accesible con rol Authenticated (ver routes/
// asistente.ts y sembrarPermisosAuthenticated en src/index.ts).

import type { Context } from 'koa';
import { getEmbedding, chatCompletion, type ChatMessage } from '../services/openai-client';
import { buscarEnDiccionario } from '../services/diccionario-vanguardias';

const TOP_ARTICULOS = 6;
const MIN_SIMILITUD_ARTICULOS = 0.35;
const TOP_AUTORES = 4;
const TOP_ENTIDADES = 4;
const TOP_DICCIONARIO = 4;

const CONECTORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);

// Interrogativos y palabras frecuentes al inicio de una pregunta en
// español, que aparecen capitalizadas solo por ir en mayúscula inicial de
// frase — no son nombres propios. Sin este filtro, "¿Qué fue el
// cubismo?" extraía "Qué" como candidato, cuya forma normalizada ("que")
// es subcadena de "marqués" y contaminaba los resultados con entidades y
// autores de apellido "Marqués de..." (encontrado al probar en producción).
const INTERROGATIVOS = new Set([
  'que', 'cual', 'cuales', 'quien', 'quienes', 'como', 'donde', 'cuando',
  'cuanto', 'cuanta', 'cuantos', 'cuantas', 'cuyo', 'cuya', 'cuyos', 'cuyas',
]);

// Heurística de extracción de nombres propios de la pregunta del usuario
// (secuencias de palabras capitalizadas, admitiendo conectores como "de"/
// "del" en medio — "García de la Serna" — y palabras capitalizadas sueltas
// como candidato individual). En el mismo espíritu que el gazetteer de
// scripts/prueba_entity_linking.js, pero sin desambiguación por LLM: aquí
// solo sirve para acotar qué autores/entidades/diccionario consultar.
function extraerCandidatos(texto: string): string[] {
  const tokens = texto.split(/\s+/);
  const candidatos: string[] = [];
  let actual: string[] = [];

  function cerrar() {
    if (actual.length >= 2) candidatos.push(actual.join(' '));
    actual = [];
  }

  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/[.,;:!?¿¡"'()«»]/g, '');
    if (!token) {
      cerrar();
      continue;
    }
    const esCapitalizado = /^[A-ZÁÉÍÓÚÑÜ]/.test(token) && !INTERROGATIVOS.has(normalizarNombre(token));
    const esConector = CONECTORES.has(token.toLowerCase());
    if (esCapitalizado) {
      actual.push(token);
    } else if (esConector && actual.length > 0) {
      actual.push(token.toLowerCase());
    } else {
      cerrar();
    }
  }
  cerrar();

  for (const tokenRaw of tokens) {
    const token = tokenRaw.replace(/[.,;:!?¿¡"'()«»]/g, '');
    if (/^[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]{2,}$/.test(token) && !INTERROGATIVOS.has(normalizarNombre(token))) {
      candidatos.push(token);
    }
  }

  return [...new Set(candidatos)];
}

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

function normalizarNombre(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Puntúa una coincidencia de nombre por la longitud del candidato que la
// produjo, para que un apellido común de una sola palabra ("García") no
// desplace a una coincidencia por el nombre completo ("Federico García
// Lorca"). Mismo criterio que diccionario-vanguardias.ts.
function puntuarCoincidencia(nombre: string, candidatos: string[]): number {
  const nombreNorm = normalizarNombre(nombre);
  let score = 0;
  for (const c of candidatos) {
    const cNorm = normalizarNombre(c);
    if (nombreNorm.includes(cNorm) || cNorm.includes(nombreNorm)) score = Math.max(score, cNorm.length);
  }
  return score;
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

interface AutorContexto {
  nombre: string;
  slug: string;
  biografia: string;
  anioNacimiento: number | null;
  anioFallecimiento: number | null;
}

async function buscarAutores(candidatos: string[]): Promise<AutorContexto[]> {
  if (candidatos.length === 0) return [];
  const autores = await strapi.documents('api::author.author').findMany({
    status: 'published',
    filters: {
      $or: candidatos.flatMap((c) => [
        { nombre: { $containsi: c } },
        { variantes_nombre: { $containsi: c } },
      ]),
    } as never,
    fields: ['nombre', 'slug', 'biografia', 'anio_nacimiento', 'anio_fallecimiento'],
  });
  return (autores as any[])
    .sort((a, b) => puntuarCoincidencia(b.nombre, candidatos) - puntuarCoincidencia(a.nombre, candidatos))
    .slice(0, TOP_AUTORES)
    .map((a) => ({
      nombre: a.nombre as string,
      slug: a.slug as string,
      biografia: recortar(extraerTextoBloques(a.biografia), 600),
      anioNacimiento: a.anio_nacimiento ?? null,
      anioFallecimiento: a.anio_fallecimiento ?? null,
    }));
}

interface EntidadContexto {
  nombre: string;
  tipo: string;
  descripcion: string;
}

// Solo se citan menciones con estado "confirmada": la sesión 51 dejó
// documentado que la confianza media/baja del pipeline de entity-linking
// no es fiable, así que no debe usarse como contexto de un asistente que
// cita sus fuentes como si fueran datos verificados.
async function buscarEntidades(candidatos: string[]): Promise<EntidadContexto[]> {
  if (candidatos.length === 0) return [];
  const entidades = await strapi.documents('api::entidad-mencionada.entidad-mencionada').findMany({
    status: 'published',
    filters: { $or: candidatos.map((c) => ({ nombre: { $containsi: c } })) } as never,
    fields: ['nombre', 'tipo', 'descripcion'],
  });
  return (entidades as any[])
    .sort((a, b) => puntuarCoincidencia(b.nombre, candidatos) - puntuarCoincidencia(a.nombre, candidatos))
    .slice(0, TOP_ENTIDADES)
    .map((e) => ({
      nombre: e.nombre as string,
      tipo: e.tipo as string,
      descripcion: recortar(e.descripcion ?? '', 600),
    }));
}

interface Fuente {
  id: string;
  tipo: 'articulo' | 'autor' | 'entidad' | 'diccionario';
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

    const candidatos = extraerCandidatos(pregunta);
    const knex = strapi.db.connection;
    const vectorLiteral = `[${queryVector.join(',')}]`;

    const [articulos, autores, entidades, diccionario] = await Promise.all([
      buscarArticulos(knex, vectorLiteral),
      buscarAutores(candidatos),
      buscarEntidades(candidatos),
      buscarEnDiccionario(candidatos, TOP_DICCIONARIO),
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
