// Al crear o editar un artículo:
// 1. Limpia `texto` eliminando divs de metadatos OCR (títulos duplicados,
//    autores, descripciones de imagen, enlaces de paginación interna).
// 2. Rellena `texto_plano` con el contenido de `texto` sin etiquetas HTML,
//    para búsquedas de texto completo y embeddings vectoriales (pgvector).
interface ArticleData {
  texto?: string | null;
  texto_plano?: string | null;
  pies_imagen?: string | null;
  es_poema?: boolean | null;
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
  }
}

export default {
  beforeCreate(event: { params: { data: ArticleData } }) {
    procesarTexto(event.params.data);
  },
  beforeUpdate(event: { params: { data: ArticleData } }) {
    procesarTexto(event.params.data);
  },
};
