const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const XLSX = require('xlsx');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const excelFile = process.argv[2];
if (!excelFile) {
  console.error('Uso: node seed-articulos-revista.js <archivo.xlsx (dentro de excels/)>');
  process.exit(1);
}
const EXCEL_PATH = path.join(__dirname, 'excels', excelFile);

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

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

// El excel codifica el/los autor(es) como un número simple, o como una
// mezcla redundante de comas y barras (p. ej. "1000042, 1000353 | 1000042 |
// 1000353") cuando hay varios; extraer todos los números y deduplicar
// funciona para ambos casos sin depender del separador exacto.
function parseAutorLegadoIds(value) {
  if (value === null || value === undefined || value === '') return [];
  if (typeof value === 'number') return [value];
  return [...new Set(String(value).match(/\d+/g) ?? [])].map(Number);
}

function slugify(text) {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function downloadToTmp(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Descarga fallida (${res.statusCode}): ${url}`));
          return;
        }
        const ext = path.extname(new URL(url).pathname) || '.jpg';
        const tmpPath = path.join(os.tmpdir(), `articulo-revista-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        const fileStream = fs.createWriteStream(tmpPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve(tmpPath)));
        fileStream.on('error', reject);
      })
      .on('error', reject);
  });
}

async function uploadImage(app, url, baseName) {
  const tmpPath = await downloadToTmp(url);
  try {
    const ext = path.extname(tmpPath);
    const stats = fs.statSync(tmpPath);
    const [uploaded] = await app.plugin('upload').service('upload').upload({
      data: {},
      files: {
        filepath: tmpPath,
        originalFilename: `${baseName}${ext}`,
        mimetype: MIME_BY_EXT[ext.toLowerCase()] || 'application/octet-stream',
        size: stats.size,
      },
    });
    return uploaded.id;
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

async function main() {
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const validRows = rows.filter((row) => row.titulo && row.id_articulo_legado && row.id_numero_legado);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const issues = await app.documents('api::issue.issue').findMany({
    status: 'published',
    fields: ['id_numero_legado'],
  });
  const issueByLegado = new Map(issues.map((issue) => [issue.id_numero_legado, issue]));

  const authors = await app.documents('api::author.author').findMany({
    status: 'published',
    fields: ['id_autor_legado'],
  });
  const authorByLegado = new Map(authors.filter((a) => a.id_autor_legado).map((a) => [a.id_autor_legado, a]));

  const existingArticles = await app.documents('api::article.article').findMany({
    status: 'published',
    fields: ['titulo', 'id_articulo_legado'],
    populate: { issue: { fields: ['id_numero_legado'] }, imagenes: true },
  });
  const existingByKey = new Map();
  const existingByLegado = new Map();
  for (const article of existingArticles) {
    if (article.id_articulo_legado) {
      existingByLegado.set(article.id_articulo_legado, article);
      continue;
    }
    const numeroLegado = article.issue?.id_numero_legado;
    if (!numeroLegado) continue;
    existingByKey.set(`${normalizeForMatch(article.titulo)}::${numeroLegado}`, article);
  }

  let updated = 0;
  let created = 0;
  let anuncios = 0;
  let yaImportados = 0;

  for (const row of validRows) {
    if (existingByLegado.has(row.id_articulo_legado)) {
      yaImportados++;
      continue;
    }

    const issue = issueByLegado.get(row.id_numero_legado);
    if (!issue) {
      throw new Error(`No se encontró número con id_numero_legado=${row.id_numero_legado} (artículo "${row.titulo}")`);
    }

    const autorIds = parseAutorLegadoIds(row.id_autor_legado);
    const autoresArticulo = autorIds.map((id) => {
      const author = authorByLegado.get(id);
      if (!author) throw new Error(`No se encontró autor con id_autor_legado=${id} (artículo "${row.titulo}")`);
      return author;
    });

    const esAnuncio = String(row.anuncio).toUpperCase() === 'TRUE';
    if (esAnuncio) anuncios++;

    const imageUrls = (row.imagenes || '')
      .split('|')
      .map((u) => u.trim())
      .filter(Boolean);

    const matchKey = `${normalizeForMatch(String(row.titulo))}::${row.id_numero_legado}`;
    const match = existingByKey.get(matchKey);

    if (match) {
      const imagenIds = match.imagenes?.length
        ? undefined
        : await Promise.all(imageUrls.map((url, idx) => uploadImage(app, url, `${row.id_articulo_legado}-${idx + 1}`)));

      await app.documents('api::article.article').update({
        documentId: match.documentId,
        data: {
          id_articulo_legado: row.id_articulo_legado,
          idioma: row.idioma,
          es_anuncio: esAnuncio,
          texto_ocr_anuncios: row.texto_ocr_anuncios ?? undefined,
          ...(autoresArticulo.length ? { authors: autoresArticulo.map((a) => a.documentId) } : {}),
          ...(imagenIds ? { imagenes: imagenIds } : {}),
        },
        status: 'published',
      });
      updated++;
      continue;
    }

    const imagenIds = await Promise.all(
      imageUrls.map((url, idx) => uploadImage(app, url, `${row.id_articulo_legado}-${idx + 1}`))
    );

    let slug = slugify(String(row.titulo));
    const data = {
      titulo: String(row.titulo),
      texto: row.texto,
      idioma: row.idioma,
      es_anuncio: esAnuncio,
      texto_ocr_anuncios: row.texto_ocr_anuncios ?? null,
      posicion: row.posicion,
      id_articulo_legado: row.id_articulo_legado,
      issue: issue.documentId,
      authors: autoresArticulo.map((a) => a.documentId),
      imagenes: imagenIds,
    };

    try {
      await app.documents('api::article.article').create({ data: { ...data, slug }, status: 'published' });
    } catch (err) {
      slug = `${slug}-${row.id_articulo_legado}`;
      await app.documents('api::article.article').create({ data: { ...data, slug }, status: 'published' });
    }
    created++;
  }

  console.log(JSON.stringify({ total: validRows.length, updated, created, anuncios, yaImportados }, null, 2));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
