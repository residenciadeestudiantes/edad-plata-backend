const path = require('path');
const XLSX = require('xlsx');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const EXCEL_PATH = path.join(__dirname, 'excels', 'ids_autores.xlsx');

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeForMatch(str) {
  return stripAccents(str)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function slugify(text) {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main() {
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const validRows = rows.filter((row) => row.id_autor && row.nombre_autor);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const existingAuthors = await app.documents('api::author.author').findMany({
    status: 'published',
    fields: ['nombre', 'id_autor_legado'],
  });

  const existingByKey = new Map();
  for (const author of existingAuthors) {
    existingByKey.set(normalizeForMatch(author.nombre), author);
  }

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const row of validRows) {
    const nombre = String(row.nombre_autor).trim();
    const idAutorLegado = Number(row.id_autor);
    const key = normalizeForMatch(nombre);
    const match = existingByKey.get(key);

    if (match) {
      if (match.id_autor_legado) {
        skipped++;
        continue;
      }
      await app.documents('api::author.author').update({
        documentId: match.documentId,
        data: { id_autor_legado: idAutorLegado },
        status: 'published',
      });
      updated++;
      continue;
    }

    let slug = slugify(nombre);
    try {
      await app.documents('api::author.author').create({
        data: { nombre, slug, id_autor_legado: idAutorLegado },
        status: 'published',
      });
    } catch (err) {
      slug = `${slug}-${idAutorLegado}`;
      await app.documents('api::author.author').create({
        data: { nombre, slug, id_autor_legado: idAutorLegado },
        status: 'published',
      });
    }
    created++;
  }

  console.log(JSON.stringify({ total: validRows.length, updated, created, skipped }, null, 2));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
