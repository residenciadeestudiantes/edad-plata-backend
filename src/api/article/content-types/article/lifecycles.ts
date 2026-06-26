// Al crear o editar un artículo, limpia el campo `texto` eliminando los divs
// de metadatos que genera el proceso de importación/OCR y que no deben
// mostrarse en el front: títulos duplicados, nombres de autor, descripciones
// de imagen y enlaces de paginación interna del visor de facsímil.
interface ArticleData {
  texto?: string | null;
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

function procesarTexto(data: ArticleData) {
  if (data.texto) {
    data.texto = limpiarTexto(data.texto);
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
