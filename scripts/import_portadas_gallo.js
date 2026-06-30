'use strict';

// Descarga e importa las portadas de los 2 números de Gallo.
// Ejecutar dentro del contenedor: docker exec -w /app edad-plata-backend-1 node scripts/import_portadas_gallo.js

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'localhost',
  port:     parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD || '',
});

const UPLOADS_DIR = '/app/public/uploads';

const NUMEROS = [
  { draftId: 93, publishedId: 94, numeroOrden: 1, url: 'http://revistas.edaddeplata.org:8080/WUV/img/REV/GAL/01590001.jpg' },
  { draftId: 95, publishedId: 96, numeroOrden: 2, url: 'http://revistas.edaddeplata.org:8080/WUV/img/REV/GAL/01600001.jpg' },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

async function procesarPortada(numero) {
  const sharp = require('sharp');
  const ext = '.jpg';
  const hash = crypto.randomBytes(5).toString('hex');
  const baseName = `gallo_n${numero.numeroOrden}_${hash}`;

  const tmpPath = `/tmp/${baseName}${ext}`;
  console.log(`\nDescargando n.º ${numero.numeroOrden}: ${numero.url}`);
  await download(numero.url, tmpPath);

  const meta = await sharp(tmpPath).metadata();
  const { width, height } = meta;

  const VARIANTES = [
    { suffix: '_thumbnail', width: 156 },
    { suffix: '_small',     width: 500 },
    { suffix: '_medium',    width: 750 },
    { suffix: '_large',     width: 1000 },
  ];

  const formats = {};
  for (const v of VARIANTES) {
    const outName = `${baseName}${v.suffix}${ext}`;
    const outPath = path.join(UPLOADS_DIR, outName);
    const resized = await sharp(tmpPath).resize({ width: v.width, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    fs.writeFileSync(outPath, resized);
    const resMeta = await sharp(resized).metadata();
    formats[v.suffix.slice(1)] = {
      name: outName,
      hash: `${baseName}${v.suffix}`,
      ext,
      mime: 'image/jpeg',
      width: resMeta.width,
      height: resMeta.height,
      size: resized.length / 1024,
      url: `/uploads/${outName}`,
    };
  }

  const mainName = `${baseName}${ext}`;
  const mainPath = path.join(UPLOADS_DIR, mainName);
  fs.copyFileSync(tmpPath, mainPath);
  fs.unlinkSync(tmpPath);

  const fileSize = fs.statSync(mainPath).size / 1024;

  const { rows: [file] } = await db.query(
    `INSERT INTO files
       (name, alternative_text, caption, width, height, formats, hash, ext, mime, size, url, provider, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'local', NOW(), NOW())
     RETURNING id`,
    [
      mainName,
      `Portada Gallo n.º ${numero.numeroOrden}`,
      null,
      width,
      height,
      JSON.stringify(formats),
      baseName,
      ext,
      'image/jpeg',
      fileSize,
      `/uploads/${mainName}`,
    ]
  );

  for (const relatedId of [numero.draftId, numero.publishedId]) {
    await db.query(
      `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
       VALUES ($1, $2, 'api::issue.issue', 'imagen_portada', 1.0)
       ON CONFLICT DO NOTHING`,
      [file.id, relatedId]
    );
  }

  console.log(`✓ n.º ${numero.numeroOrden} — file id=${file.id}, ${width}×${height}px`);
}

async function main() {
  await db.connect();
  for (const n of NUMEROS) {
    await procesarPortada(n);
  }
  await db.end();
  console.log('\nPortadas importadas.');
}

main().catch((err) => { console.error(err); process.exit(1); });
