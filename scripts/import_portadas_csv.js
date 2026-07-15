#!/usr/bin/env node
// Backfill de portadas para números que ya existen en PostgreSQL (creados
// previamente sin imagen_portada, p.ej. vía import_numeros_csv.js).
// Descarga la imagen, genera variantes con sharp y la enlaza a las filas
// draft + published del número — mismo mecanismo que usa import_numeros_excel.js
// al crear números nuevos, pero aquí opera sobre números ya existentes.
//
// Columnas esperadas en el CSV (cabecera obligatoria, orden libre):
//   id_numero_legado*  — identificador en el sistema legado (para localizar el número)
//   imagen_portada*    — URL de la imagen de portada
//   titulo             — opcional, se usa como texto alternativo de la imagen
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/import_portadas_csv.js --revista=<slug> /ruta/al/archivo.csv
//
// Comportamiento (idempotente):
//   - Requiere que el número (draft + published) ya exista con ese id_numero_legado
//   - Omite números que ya tienen una portada enlazada (files_related_mph)

'use strict';

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const pathLib = require('path');
const crypto  = require('crypto');
const { Client } = require('pg');

const UPLOADS_DIR = '/app/public/uploads';

// ── Argumentos ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const revistaArg = args.find(a => a.startsWith('--revista='));
if (!revistaArg) {
  console.error('Uso: node import_portadas_csv.js --revista=<slug> <archivo.csv>');
  process.exit(1);
}
const revistaSlug = revistaArg.split('=')[1].trim();
const csvPath = args.find(a => !a.startsWith('--'));
if (!csvPath || !fs.existsSync(csvPath)) {
  console.error(`Fichero CSV no encontrado: ${csvPath || '(no indicado)'}`);
  process.exit(1);
}

// ── Parser CSV (RFC 4180) ─────────────────────────────────────────────────────

function parseCSV(content) {
  const rows = [];
  let row = [], field = '', inQuotes = false, i = 0;
  const src = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { inQuotes = false; i++; continue; }
      field += ch;
    } else {
      if (ch === '"') { inQuotes = true; i++; continue; }
      if (ch === ',') { row.push(field.trim()); field = ''; i++; continue; }
      if (ch === '\n') {
        row.push(field.trim());
        if (row.some(f => f !== '')) rows.push(row);
        row = []; field = ''; i++; continue;
      }
      field += ch;
    }
    i++;
  }
  if (field !== '' || row.length) { row.push(field.trim()); if (row.some(f => f !== '')) rows.push(row); }
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().trim());
  return rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] ?? ''; });
    return obj;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function num(v) { const n = parseInt(String(v), 10); return isNaN(n) ? null : n; }
function str(v) { const s = String(v ?? '').trim(); return s || null; }

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

  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  console.log(`Filas en CSV: ${rows.length}\n`);

  let importadas = 0, omitidas = 0, errores = 0;

  for (const row of rows) {
    const id_numero_legado = num(row.id_numero_legado);
    const imagen_portada   = str(row.imagen_portada);
    const titulo           = str(row.titulo);

    if (!id_numero_legado || !imagen_portada) {
      console.warn(`  ⚠  Fila omitida (falta id_numero_legado o imagen_portada): ${JSON.stringify(row)}`);
      errores++; continue;
    }

    const { rows: issueRows } = await db.query(
      `SELECT i.id, i.published_at IS NOT NULL AS publicado
       FROM issues i
       INNER JOIN issues_publication_lnk lnk ON lnk.issue_id = i.id
       WHERE lnk.publication_id IN ($1,$2) AND i.id_numero_legado = $3`,
      [pubDraft.id, pubPublished.id, id_numero_legado]
    );
    if (issueRows.length === 0) {
      console.warn(`  ⚠  No existe ningún número con id_numero_legado=${id_numero_legado} para "${revistaSlug}" — omitido.`);
      errores++; continue;
    }

    const { rows: yaTiene } = await db.query(
      `SELECT 1 FROM files_related_mph
       WHERE related_type = 'api::issue.issue' AND field = 'imagen_portada'
         AND related_id = ANY($1::int[]) LIMIT 1`,
      [issueRows.map(r => r.id)]
    );
    if (yaTiene.length > 0) {
      console.log(`  — omitido (ya tiene portada): legado=${id_numero_legado}`);
      omitidas++; continue;
    }

    try {
      process.stdout.write(`  ↓ legado=${id_numero_legado} descargando portada… `);
      const fileId = await importarPortada(imagen_portada, titulo);
      for (const issue of issueRows) {
        await db.query(
          `INSERT INTO files_related_mph (file_id, related_id, related_type, field, "order")
           VALUES ($1,$2,'api::issue.issue','imagen_portada',1.0)
           ON CONFLICT DO NOTHING`,
          [fileId, issue.id]
        );
      }
      console.log(`✓ file_id=${fileId}`);
      importadas++;
    } catch (err) {
      console.error(`\n  ✗ Error en legado=${id_numero_legado}: ${err.message}`);
      errores++;
    }
  }

  console.log(`\nResultado: ${importadas} portadas importadas · ${omitidas} omitidas · ${errores} errores.`);
  await db.end();
}

run().catch(err => { console.error(err); process.exit(1); });
