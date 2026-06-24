const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const XLSX = require('xlsx');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const EXCEL_PATH = path.join(__dirname, 'excels', 'articulos-revista-caballo-verde-definitivo.xlsx');

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
        const tmpPath = path.join(os.tmpdir(), `articulo-cv-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
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
  for (const article of existingArticles) {
    if (article.id_articulo_legado) continue;
    const numeroLegado = article.issue?.id_numero_legado;
    if (!numeroLegado) continue;
    existingByKey.set(`${normalizeForMatch(article.titulo)}::${numeroLegado}`, article);
  }

  let updated = 0;
  let created = 0;
  let skipped = 0;

  for (const row of validRows) {
    const issue = issueByLegado.get(row.id_numero_legado);
    if (!issue) {
      throw new Error(`No se encontró número con id_numero_legado=${row.id_numero_legado} (artículo "${row.titulo}")`);
    }

    const author = row.id_autor_legado ? authorByLegado.get(row.id_autor_legado) : undefined;
    if (row.id_autor_legado && !author) {
      throw new Error(`No se encontró autor con id_autor_legado=${row.id_autor_legado} (artículo "${row.titulo}")`);
    }

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
          ...(author ? { authors: [author.documentId] } : {}),
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
      titulo: row.titulo,
      texto: row.texto,
      idioma: row.idioma,
      posicion: row.posicion,
      id_articulo_legado: row.id_articulo_legado,
      issue: issue.documentId,
      authors: author ? [author.documentId] : [],
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

  console.log(JSON.stringify({ total: validRows.length, updated, created, skipped }, null, 2));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
