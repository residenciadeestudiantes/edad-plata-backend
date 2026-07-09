// Al crear o editar un artículo:
// 1. Limpia `texto` eliminando divs de metadatos OCR (títulos duplicados,
//    autores, descripciones de imagen, enlaces de paginación interna).
// 2. Rellena `texto_plano` con el contenido de `texto` sin etiquetas HTML,
//    para búsquedas de texto completo y embeddings vectoriales (pgvector).
// 3. Al crear un artículo nuevo marcado como poema sin ningún tema asignado,
//    lo clasifica automáticamente en "Literatura y creación" (documentId fijo
//    en el CMS de producción): los poemas no pasan por el clasificador LLM de
//    temas, así que sin esta regla quedarían siempre sin clasificar.
interface ArticleData {
  texto?: string | null;
  texto_plano?: string | null;
  pies_imagen?: string | null;
  es_poema?: boolean | null;
  es_obra_grafica?: boolean | null;
  temas?: unknown;
}

const TEMA_LITERATURA_CREACION_DOCUMENT_ID = 'i6lv2b3ern6qf4432696c0kw';

function necesitaTemaPoemaSinClasificar(data: ArticleData): boolean {
  const sinTemas = !data.temas || (Array.isArray(data.temas) && data.temas.length === 0);
  return Boolean(data.es_poema) && sinTemas;
}

// Asignar la relación `temas` directamente en `data` dentro de beforeCreate
// no funciona: el Document Service ya ha resuelto/validado las relaciones
// antes de que corra el lifecycle, así que un array de documentId añadido
// aquí llega mal formado a la fase de "publish" y aborta la transacción
// (se comprobó importando artículos reales: el primer artículo-poema de un
// lote fallaba siempre con "current transaction is aborted"). Por eso se
// aplica en afterCreate, como una actualización aparte —mismo patrón que
// usa el guardado del validador de temas—, no como parte de la creación.
async function asignarTemaPoemaSinClasificar(documentId: string) {
  await strapi.documents('api::article.article').update({
    documentId,
    data: { temas: [TEMA_LITERATURA_CREACION_DOCUMENT_ID] } as any,
    status: 'published',
  });
}

function limpiarTexto(texto: string): string {
  return texto
    .replace(/<div class="Título">[\s\S]*?<\/div>/g, '')
    .replace(/<div class="Titulo">[\s\S]*?<\/div>/g, '')
    .replace(/<div class="Autor">[\s\S]*?<\/div>/g, '')
    .replace(/<div class="Autortexto">[\s\S]*?<\/div>/g, '')
    .replace(/<div class="DescrI">[\s\S]*?<\/div>/g, '')
    .replace(/<a class="page"[\s\S]*?<\/a>/g, '');
}

function htmlAPlanoTexto(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')          // elimina etiquetas
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')              // colapsa espacios múltiples
    .trim();
}

// Extrae el texto de todos los pies de foto (TituloI y NormalI) del HTML
// del artículo. Se almacena en texto plano para búsquedas por contenido.
function extraerPiesImagen(html: string): string {
  const re = /<div class="(?:TituloI|NormalI)">([\s\S]*?)<\/div>/g;
  const partes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const texto = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (texto) partes.push(texto);
  }
  return partes.join('\n');
}

// Poema si al menos la mitad de los bloques de párrafo/verso son de tipo
// Estrofa (proporción, no simple presencia): evita falsos positivos cuando
// un artículo en prosa solo cita un fragmento de verso. Los divs "Normal"
// que únicamente contienen el enlace de paginación no cuentan como bloque
// de prosa real.
function esPoema(html: string): boolean {
  const limpio = html
    .replace(/<a class="page"[\s\S]*?<\/a>/g, '')
    .replace(/<div class="Normal">\s*<\/div>/g, '');
  const estrofas = (limpio.match(/<div class="Estrofa[^"]*"/g) ?? []).length;
  const normales = (limpio.match(/<div class="Normal[^"]*"/g) ?? []).length;
  const total = estrofas + normales;
  return total > 0 && estrofas / total >= 0.5;
}

// Obra gráfica (lámina, retrato, óleo...): el artículo son solo una o más
// imágenes con su autor y título (bloques "imgbox" con AutorI/TituloI) y no
// queda ningún bloque de texto real. Los anuncios también son "imgbox" sin
// texto, pero describen la imagen con "DescrI" en vez de AutorI/TituloI, así
// que su presencia descarta la clasificación.
function esObraGrafica(html: string): boolean {
  const limpio = html
    .replace(/<a class="page"[\s\S]*?<\/a>/g, '')
    .replace(/<div class="Normal">\s*<\/div>/g, '');
  const tieneImgbox = /<div class="imgbox">/.test(limpio);
  const tieneDescrI = /<div class="DescrI">/.test(limpio);
  const tieneTextoReal = /<div class="(?:Normal|Estrofa|Cita)/.test(limpio);
  return tieneImgbox && !tieneDescrI && !tieneTextoReal;
}

// Clases de contenido que no deben aparecer dentro de un <div class="imgbox">
const CONTENT_OUTSIDE_IMGBOX = new Set([
  'Normal', 'NormalN', 'NormalT', 'NormalTX', 'NormalNX',
  'Cita', 'CitaX', 'EstrofaCita', 'EstrofaCitaX',
  'Estrofa', 'EstrofaI', 'EstrofaT', 'EstrofaTX',
  'Fuente', 'FuenteX',
  'Título', 'Titulo', 'TítuloP', 'TítuloS', 'Subtítulo', 'SubtítuloP',
  'PersonajeT', 'AcotaciónT', 'AcotaciónTX',
  'Autor', 'AutorP', 'Numeración', 'Anatomía',
]);

function divBalance(html: string): number {
  return (html.match(/<div/g)?.length ?? 0) - (html.match(/<\/div>/g)?.length ?? 0);
}

// Elimina </div> que aparecen con la pila vacía (cierres sobrantes)
function removeExtraCloses(html: string): string {
  const re = /<div\s[^>]*class="([^"]*)"[^>]*>/g;
  const CLOSE = '</div>';
  const parts: string[] = [];
  const stack: string[] = [];
  let pos = 0;

  while (pos < html.length) {
    re.lastIndex = pos;
    const om = re.exec(html);
    const ci = html.indexOf(CLOSE, pos);
    const openAt = om ? om.index : Infinity;
    const closeAt = ci >= 0 ? ci : Infinity;

    if (!isFinite(openAt) && !isFinite(closeAt)) { parts.push(html.slice(pos)); break; }

    if (openAt <= closeAt) {
      parts.push(html.slice(pos, openAt));
      parts.push(html.slice(openAt, openAt + om![0].length));
      stack.push(om![1]);
      pos = openAt + om![0].length;
    } else {
      parts.push(html.slice(pos, closeAt));
      if (stack.length > 0) { stack.pop(); parts.push(CLOSE); }
      pos = closeAt + CLOSE.length;
    }
  }
  return parts.join('');
}

// Inyecta </div> antes del primer div de contenido real que aparece dentro de un imgbox sin cerrar
function fixUnclosedImgbox(html: string): string {
  const re = /<div\s[^>]*class="([^"]*)"[^>]*>/g;
  const CLOSE = '</div>';
  const parts: string[] = [];
  const stack: string[] = [];
  let pos = 0;
  let changed = false;

  while (pos < html.length) {
    re.lastIndex = pos;
    const om = re.exec(html);
    const ci = html.indexOf(CLOSE, pos);
    const openAt = om ? om.index : Infinity;
    const closeAt = ci >= 0 ? ci : Infinity;

    if (!isFinite(openAt) && !isFinite(closeAt)) { parts.push(html.slice(pos)); break; }

    if (openAt <= closeAt) {
      parts.push(html.slice(pos, openAt));
      const cls = om![1];
      if (CONTENT_OUTSIDE_IMGBOX.has(cls) && stack.includes('imgbox')) {
        parts.push('</div>\n');
        const idx = stack.lastIndexOf('imgbox');
        stack.splice(idx, 1);
        changed = true;
      }
      parts.push(html.slice(openAt, openAt + om![0].length));
      stack.push(cls);
      pos = openAt + om![0].length;
    } else {
      parts.push(html.slice(pos, closeAt));
      parts.push(CLOSE);
      if (stack.length > 0) stack.pop();
      pos = closeAt + CLOSE.length;
    }
  }
  return changed ? parts.join('') : html;
}

// Corrige divs desbalanceados: elimina cierres sobrantes, cierra imgboxes abiertos,
// y si aún sobran aperturas (Normal/Cita sin cerrar), añade </div> al final.
function balancearDivs(html: string): string {
  let result = html;
  let bal = divBalance(result);
  if (bal === 0) return result;

  if (bal < 0) result = removeExtraCloses(result);

  bal = divBalance(result);
  if (bal > 0) result = fixUnclosedImgbox(result);

  bal = divBalance(result);
  while (bal > 0) {
    result = result.trimEnd() + '\n</div>\n';
    bal--;
  }
  return result;
}

function procesarTexto(data: ArticleData) {
  if (data.texto) {
    data.texto = limpiarTexto(data.texto);
    data.texto = balancearDivs(data.texto);
    data.texto_plano = htmlAPlanoTexto(data.texto);
    data.pies_imagen = extraerPiesImagen(data.texto);
    data.es_poema = esPoema(data.texto);
    data.es_obra_grafica = esObraGrafica(data.texto);
  }
}

export default {
  beforeCreate(event: { params: { data: ArticleData } }) {
    procesarTexto(event.params.data);
  },
  async afterCreate(event: {
    params: { data: ArticleData };
    result: { documentId: string };
  }) {
    if (necesitaTemaPoemaSinClasificar(event.params.data)) {
      await asignarTemaPoemaSinClasificar(event.result.documentId);
    }
  },
  beforeUpdate(event: { params: { data: ArticleData } }) {
    procesarTexto(event.params.data);
  },
};
