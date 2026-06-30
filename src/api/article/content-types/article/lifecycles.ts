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
    .replace(
      /(<div class="Normal"><a class="page"[\s\S]*?<\/a><\/div>)/g,
      '<!-- $1 -->'
    );
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

function esPoema(html: string): boolean {
  return /class="(?:Estrofa|TítuloP)"/.test(html);
}

function procesarTexto(data: ArticleData) {
  if (data.texto) {
    data.texto = limpiarTexto(data.texto);
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
