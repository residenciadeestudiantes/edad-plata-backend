#!/usr/bin/env node
// Importa números de revista desde un Excel (.xlsx) a PostgreSQL,
// descargando y vinculando las portadas automáticamente.
//
// Columnas esperadas en el Excel:
//   titulo, numero_orden, mes, año, imagen_portada, url_original, id_numero_legado
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/import_numeros_excel.js --revista=<slug> /ruta/al/archivo.xlsx
//
// Comportamiento (idempotente):
//   - Omite números cuyo id_numero_legado ya existe para la revista
//   - Descarga la imagen de portada y genera variantes con sharp
//   - Crea dos filas por número (draft + published)

'use strict';

const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const pathLib    = require('path');
const crypto     = require('crypto');
const { Client } = require('pg');
const XLSX       = require('xlsx');

const UPLOADS_DIR = '/app/public/uploads';

// ── Argumentos ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const revistaArg = args.find(a => a.startsWith('--revista='));
if (!revistaArg) {
  console.error('Uso: node import_numeros_excel.js --revista=<slug> <archivo.xlsx>');
  process.exit(1);
}
const revistaSlug = revistaArg.split('=')[1].trim();
const xlsxPath    = args.find(a => !a.startsWith('--'));
if (!xlsxPath) {
  console.error('Indica la ruta al fichero .xlsx');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function num(v) { const n = parseInt(String(v), 10); return isNaN(n) ? null : n; }
function str(v) { const s = String(v ?? '').trim(); return s || null; }

function genDocumentId() {
  return crypto.randomBytes(18).toString('base64').toLowerCase()
    .replace(/[^a-z0-9]/g, '').slice(0, 24).padEnd(24, '0');
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file  = fs.createWriteStream(dest);
    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch (_) {}
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

async function importarPortada(url, altText) {
  const sharp  = require('sharp');
  const ext    = pathLib.extname(new URL(url.trim()).pathname) || '.jpg';
  const hash   = crypto.randomBytes(5).toString('hex');
  const base   = `portada_${revistaSlug}_${hash}`;
  const tmpPath  = `/tmp/${base}${ext}`;
  const mainName = `${base}${ext}`;
  const mainPath = pathLib.join(UPLOADS_DIR, mainName);

  await download(url.trim(), tmpPath);

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
    const buf = await sharp(tmpPath)
      .resize({ width: v.width, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    fs.writeFileSync(pathLib.join(UPLOADS_DIR, outName), buf);
    const rm = await sharp(buf).metadata();
    formats[v.suffix.slice(1)] = {
      name: outName, hash: `${base}${v.suffix}`, ext,
      mime: 'image/jpeg', width: rm.width, height: rm.height,
      size: buf.length / 1024, url: `/uploads/${outName}`,
    };
  }

  fs.copyFileSync(tmpPath, mainPath);
  try { fs.unlinkSync(tmpPath); } catch (_) {}

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

// ── DB ────────────────────────────────────────────────────────────────────────

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'postgres',
  port:     parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD,
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  await db.connect();
  console.log('Conectado a PostgreSQL.\n');

  // Resolver publicación
  const { rows: pubs } = await db.query(
    `SELECT id, published_at FROM publications WHERE slug = $1 ORDER BY id`,
    [revistaSlug]
  );
  if (pubs.length === 0) {
    console.error(`No se encontró ninguna publicación con slug "${revistaSlug}".`);
    await db.end(); process.exit(1);
  }
  const pubDraft     = pubs.find(p => !p.published_at);
  const pubPublished = pubs.find(p =>  p.published_at);
  if (!pubDraft || !pubPublished) {
    console.error(`La publicación "${revistaSlug}" no tiene ambas filas (draft + published).`);
    await db.end(); process.exit(1);
  }
  console.log(`Publicación "${revistaSlug}": draft=${pubDraft.id}, published=${pubPublished.id}\n`);

  // Leer Excel
  const wb   = XLSX.readFile(xlsxPath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  console.log(`Filas en Excel: ${rows.length}\n`);

  let creados = 0, omitidos = 0, errores = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const titulo          = str(row.titulo) || `N.º ${row.numero_orden}`;
    const numero_orden    = num(row.numero_orden);
    const mes             = num(row.mes);
    const ano             = num(row.año);
    const url_facsimil    = str(row.url_original);
    const id_numero_legado = num(row.id_numero_legado);
    const imagen_portada  = str(row.imagen_portada);

    if (!numero_orden) {
      console.warn(`  ⚠  Fila omitida (sin numero_orden): ${JSON.stringify(row)}`);
      errores++; continue;
    }

    // Idempotencia
    const { rows: dup } = await db.query(
      `SELECT i.id FROM issues i
       INNER JOIN issues_publication_lnk lnk ON lnk.issue_id = i.id
       WHERE lnk.publication_id IN ($1,$2) AND i.id_numero_legado = $3
       LIMIT 1`,
      [pubDraft.id, pubPublished.id, id_numero_legado]
    );
    if (dup.length > 0) {
      console.log(`  — omitido (ya existe): n.º ${numero_orden} "${titulo}"`);
      omitidos++; continue;
    }

    const docId = genDocumentId();
    try {
      // Draft
      const { rows: [draft] } = await db.query(
        `INSERT INTO issues
           (document_id, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, created_at, updated_at, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,NULL)
         RETURNING id`,
        [docId, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, now]
      );
      await db.query(
        `INSERT INTO issues_publication_lnk (issue_id, publication_id, issue_ord) VALUES ($1,$2,$3)`,
        [draft.id, pubDraft.id, numero_orden]
      );

      // Published
      const { rows: [pub] } = await db.query(
        `INSERT INTO issues
           (document_id, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, created_at, updated_at, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8)
         RETURNING id`,
        [docId, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, now]
      );
      await db.query(
        `INSERT INTO issues_publication_lnk (issue_id, publication_id, issue_ord) VALUES ($1,$2,$3)`,
        [pub.id, pubPublished.id, numero_orden]
      );

      console.log(`✓ N.º ${numero_orden} "${titulo}" — draft=${draft.id}, published=${pub.id}`);

      // Portada
      if (imagen_portada) {
        try {
          process.stdout.write(`  ↓ Descargando portada… `);
          const fileId = await importarPortada(imagen_portada, titulo);
          for (const issueId of [draft.id, pub.id]) {
            await db.query(
              `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
               VALUES ($1,$2,'api::issue.issue','imagen_portada',1.0)
               ON CONFLICT DO NOTHING`,
              [fileId, issueId]
            );
          }
          console.log(`✓ file_id=${fileId}`);
        } catch (imgErr) {
          console.error(`\n  ✗ Error portada: ${imgErr.message}`);
        }
      }

      creados++;
    } catch (err) {
      console.error(`✗ Error en "${titulo}": ${err.message}`);
      errores++;
    }
  }

  console.log(`\nResultado: ${creados} creados · ${omitidos} omitidos · ${errores} errores.`);
  await db.end();
}

run().catch(err => { console.error(err); process.exit(1); });
