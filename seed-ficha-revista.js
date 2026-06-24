const path = require('path');
const XLSX = require('xlsx');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const excelFile = process.argv[2];
if (!excelFile) {
  console.error('Uso: node seed-ficha-revista.js <archivo.xlsx (dentro de excels/)>');
  process.exit(1);
}
const EXCEL_PATH = path.join(__dirname, 'excels', excelFile);

function parseAutorIds(value) {
  if (!value) return [];
  return String(value)
    .split(';')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number);
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
    const publication = await app.documents('api::publication.publication').findFirst({
      filters: { titulo: { $eqi: titulo } },
    });

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

    const data = {
      directores,
      impresores,
      lugar_publicacion: row['Ciudad'] ?? undefined,
      periodicidad: row['Periodicidad'] ?? undefined,
      numeros_publicados: row['Números publicados'] ?? undefined,
      fecha_primer_numero: row['Fecha primer número'] ? `${row['Fecha primer número']}-01-01` : undefined,
      fecha_ultimo_numero: row['Fecha último número'] ? `${row['Fecha último número']}-01-01` : undefined,
      notas: row['Notas'] ?? undefined,
      materia: row['Materia'] ?? undefined,
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
