const path = require('path');
const XLSX = require('xlsx');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const excelFile = process.argv[2];
if (!excelFile) {
  console.error('Uso: node seed-ficha-revista.js <archivo.xlsx (dentro de excels/)>');
  process.exit(1);
}
const EXCEL_PATH = path.join(__dirname, 'excels', excelFile);

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// El excel codifica el/los autor(es) como un número simple o varios
// separados por ";" o "|" según el origen del excel; extraer todos los
// números funciona para ambos casos sin depender del separador exacto.
function parseAutorIds(value) {
  if (!value) return [];
  return String(value).match(/\d+/g)?.map(Number) ?? [];
}

function parseNombres(value) {
  if (!value) return [];
  return String(value)
    .split(/[;|]/)
    .map((nombre) => nombre.trim())
    .filter(Boolean);
}

function slugify(text) {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function normalizeTitulo(str) {
  return stripAccents(str)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findPublicationByTitulo(app, titulo) {
  const exact = await app.documents('api::publication.publication').findFirst({
    filters: { titulo: { $eqi: titulo } },
  });
  if (exact) return exact;

  // Sin match exacto (tilde distinta, o el excel añade una aclaración entre
  // paréntesis que no está en el título real, p. ej. "Lola (suplemento de
  // Carmen)" cuando en la base solo existe "Lola"): compara normalizando
  // tildes y quitando paréntesis contra todas las publicaciones.
  const normalizado = normalizeTitulo(titulo);
  const todas = await app.documents('api::publication.publication').findMany({
    status: 'published',
    fields: ['titulo'],
  });
  const match = todas.find((p) => normalizeTitulo(p.titulo) === normalizado);
  if (!match) return null;
  return app.documents('api::publication.publication').findOne({ documentId: match.documentId });
}

async function findOrCreateMateria(app, nombre) {
  const existing = await app.documents('api::materia.materia').findFirst({
    filters: { nombre: { $eqi: nombre } },
  });
  if (existing) return existing.documentId;

  const created = await app.documents('api::materia.materia').create({
    data: { nombre, slug: slugify(nombre) },
    status: 'published',
  });
  return created.documentId;
}

async function main() {
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, header: 1 });

  const headerRowIndex = rows.findIndex((row) => row[0] === 'Título');
  if (headerRowIndex === -1) {
    throw new Error('No se encontró la fila de cabecera ("Título") en el excel');
  }
  const headers = rows[headerRowIndex];
  const dataRows = rows
    .slice(headerRowIndex + 1)
    .filter((row) => row[0])
    .map((row) => Object.fromEntries(headers.map((header, idx) => [header, row[idx] ?? null])));

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const authors = await app.documents('api::author.author').findMany({
    status: 'published',
    fields: ['id_autor_legado'],
  });
  const authorByLegado = new Map(authors.filter((a) => a.id_autor_legado).map((a) => [a.id_autor_legado, a]));

  const results = [];

  for (const row of dataRows) {
    const titulo = String(row['Título']).trim();
    const publication = await findPublicationByTitulo(app, titulo);

    if (!publication) {
      throw new Error(`No se encontró publicación con título "${titulo}"`);
    }

    const directorIds = parseAutorIds(row['Director']);
    const impresorIds = parseAutorIds(row['Impresores']);

    const directores = directorIds.map((id) => {
      const author = authorByLegado.get(id);
      if (!author) throw new Error(`No se encontró autor con id_autor_legado=${id} (director de "${titulo}")`);
      return author.documentId;
    });
    const impresores = impresorIds.map((id) => {
      const author = authorByLegado.get(id);
      if (!author) throw new Error(`No se encontró autor con id_autor_legado=${id} (impresor de "${titulo}")`);
      return author.documentId;
    });

    const materiaNombres = parseNombres(row['Materia']);
    const materias = [];
    for (const nombre of materiaNombres) {
      materias.push(await findOrCreateMateria(app, nombre));
    }

    const data = {
      directores,
      impresores,
      lugar_publicacion: row['Ciudad'] ?? undefined,
      periodicidad: row['Periodicidad'] ?? undefined,
      numeros_publicados: row['Números publicados'] ?? undefined,
      fecha_primer_numero: row['Fecha primer número'] ? `${row['Fecha primer número']}-01-01` : undefined,
      fecha_ultimo_numero: row['Fecha último número'] ? `${row['Fecha último número']}-01-01` : undefined,
      notas: row['Notas'] ?? undefined,
      materias: materiaNombres.length > 0 ? materias : undefined,
      idioma: row['Idioma'] ?? undefined,
    };

    await app.documents('api::publication.publication').update({
      documentId: publication.documentId,
      data,
      status: 'published',
    });

    results.push({ titulo, documentId: publication.documentId });
  }

  console.log(JSON.stringify({ total: results.length, actualizados: results }, null, 2));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
