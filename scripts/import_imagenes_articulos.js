#!/usr/bin/env node
// Descarga e importa las imágenes de artículos cuyos IDs legados aparecen en un Excel.
// Las columnas esperadas en el Excel: id_articulo_legado, imagenes (URLs separadas por " | ")
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/import_imagenes_articulos.js /ruta/al/archivo.xlsx
//
// Comportamiento (idempotente):
//   - Omite imágenes ya enlazadas al artículo (comprueba files_related_mph)
//   - Enlaza cada imagen al par draft+published del artículo

'use strict';

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { Client } = require('pg');
const XLSX    = require('xlsx');

const UPLOADS_DIR = '/app/public/uploads';

const xlsxPath = process.argv[2];
if (!xlsxPath) {
  console.error('Uso: node import_imagenes_articulos.js <archivo.xlsx>');
  process.exit(1);
}

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'postgres',
  port:     parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD,
});

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} para ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    });
  });
}

async function importarImagen(url, altText) {
  const sharp = require('sharp');
  const ext   = path.extname(new URL(url).pathname) || '.jpg';
  const hash  = crypto.randomBytes(6).toString('hex');
  const base  = `articulo_img_${hash}`;
  const tmpPath  = `/tmp/${base}${ext}`;
  const mainName = `${base}${ext}`;
  const mainPath = path.join(UPLOADS_DIR, mainName);

  await download(url, tmpPath);

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
    const outName = `${base}${v.suffix}${ext}`;
    const outPath = path.join(UPLOADS_DIR, outName);
    const buf = await sharp(tmpPath)
      .resize({ width: v.width, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    fs.writeFileSync(outPath, buf);
    const rm = await sharp(buf).metadata();
    formats[v.suffix.slice(1)] = {
      name: outName, hash: `${base}${v.suffix}`, ext,
      mime: 'image/jpeg', width: rm.width, height: rm.height,
      size: buf.length / 1024, url: `/uploads/${outName}`,
    };
  }

  fs.copyFileSync(tmpPath, mainPath);
  fs.unlinkSync(tmpPath);

  const fileSize = fs.statSync(mainPath).size / 1024;

  const { rows: [file] } = await db.query(
    `INSERT INTO files
       (name, alternative_text, caption, width, height, formats, hash, ext, mime, size, url, provider, created_at, updated_at)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,'local',NOW(),NOW())
     RETURNING id`,
    [mainName, altText || null, width, height, JSON.stringify(formats), base, ext, 'image/jpeg', fileSize, `/uploads/${mainName}`]
  );

  return file.id;
}

async function enlazarImagen(fileId, articleId, orden) {
  await db.query(
    `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
     VALUES ($1,$2,'api::article.article','imagenes',$3)
     ON CONFLICT DO NOTHING`,
    [fileId, articleId, orden]
  );
}

async function run() {
  await db.connect();
  console.log('Conectado a PostgreSQL.\n');

  const wb   = XLSX.readFile(xlsxPath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  console.log(`Filas en Excel: ${rows.length}\n`);

  let importadas = 0, omitidas = 0, errores = 0;

  for (const row of rows) {
    const idLegado   = parseInt(String(row.id_articulo_legado), 10);
    const imagenCol  = String(row.imagenes || '').trim();
    const titulo     = String(row.titulo || '').trim();

    if (!idLegado || !imagenCol) continue;

    const urls = imagenCol.split('|').map(u => u.trim()).filter(Boolean);
    if (urls.length === 0) continue;

    // Buscar draft + published del artículo por id_articulo_legado
    const { rows: arts } = await db.query(
      `SELECT id, published_at FROM articles WHERE id_articulo_legado = $1 ORDER BY id`,
      [idLegado]
    );
    if (arts.length === 0) {
      console.warn(`  ⚠  Sin artículo para id_articulo_legado=${idLegado}`);
      continue;
    }

    for (let i = 0; i < urls.length; i++) {
      const url   = urls[i];
      const orden = i + 1;

      // Comprobar si ya existe una imagen en esa posición para cualquiera de los artículos
      const artIds = arts.map(a => a.id);
      const { rows: ya } = await db.query(
        `SELECT 1 FROM files_related_mph
         WHERE related_type='api::article.article'
           AND field='imagenes'
           AND related_id = ANY($1)
           AND "order" = $2
         LIMIT 1`,
        [artIds, orden]
      );
      if (ya.length > 0) {
        console.log(`  — omitida (ya existe pos.${orden}): "${titulo}"`);
        omitidas++;
        continue;
      }

      try {
        process.stdout.write(`  ↓ Descargando imagen ${orden}/${urls.length} de "${titulo}"… `);
        const fileId = await importarImagen(url, titulo);
        for (const art of arts) {
          await enlazarImagen(fileId, art.id, orden);
        }
        console.log(`✓ file_id=${fileId}`);
        importadas++;
      } catch (err) {
        console.error(`\n  ✗ Error en "${titulo}" imagen ${orden}: ${err.message}`);
        errores++;
      }
    }
  }

  console.log(`\nResultado: ${importadas} imágenes importadas · ${omitidas} omitidas · ${errores} errores.`);
  await db.end();
}

run().catch(err => { console.error(err); process.exit(1); });
