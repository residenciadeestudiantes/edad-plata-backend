const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const XLSX = require('xlsx');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const EXCEL_PATH = path.join(__dirname, 'excels', 'numeros_caballo_verde.xlsx');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

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
        const tmpPath = path.join(os.tmpdir(), `caballo-verde-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        const fileStream = fs.createWriteStream(tmpPath);
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(() => resolve(tmpPath)));
        fileStream.on('error', reject);
      })
      .on('error', reject);
  });
}

async function main() {
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  const validRows = rows.filter((row) => row.titulo && row.id_numero_legado);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const results = [];

  for (const row of validRows) {
    const publication = await app.documents('api::publication.publication').findFirst({
      filters: { id_revista_legado: row.revista_id },
    });

    if (!publication) {
      throw new Error(`No se encontró publicación con id_revista_legado=${row.revista_id} (número "${row.titulo}")`);
    }

    const existing = await app.documents('api::issue.issue').findFirst({
      filters: { id_numero_legado: row.id_numero_legado },
    });
    if (existing) {
      console.log(`Ya existe número con id_numero_legado=${row.id_numero_legado}, se omite: ${row.titulo}`);
      continue;
    }

    let imagenPortadaId;
    if (row.imagen_portada) {
      const tmpPath = await downloadToTmp(row.imagen_portada);
      try {
        const ext = path.extname(tmpPath);
        const stats = fs.statSync(tmpPath);
        const [uploaded] = await app.plugin('upload').service('upload').upload({
          data: {},
          files: {
            filepath: tmpPath,
            originalFilename: `${row.id_numero_legado}${ext}`,
            mimetype: MIME_BY_EXT[ext.toLowerCase()] || 'application/octet-stream',
            size: stats.size,
          },
        });
        imagenPortadaId = uploaded.id;
      } finally {
        fs.unlinkSync(tmpPath);
      }
    }

    const issue = await app.documents('api::issue.issue').create({
      data: {
        titulo: row.titulo,
        numero_orden: row.numero_orden,
        mes: row.mes,
        año: row.año,
        url_facsimil: row.url_facsimil,
        id_numero_legado: row.id_numero_legado,
        imagen_portada: imagenPortadaId,
        publication: publication.documentId,
      },
      status: 'published',
    });

    results.push({ titulo: issue.titulo, documentId: issue.documentId, id_numero_legado: row.id_numero_legado });
  }

  console.log(JSON.stringify(results, null, 2));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
