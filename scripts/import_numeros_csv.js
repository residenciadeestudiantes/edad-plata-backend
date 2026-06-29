#!/usr/bin/env node
// Importa números de revista desde un CSV a PostgreSQL (producción).
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/import_numeros_csv.js --revista=<slug> /ruta/al/archivo.csv
//
// Columnas del CSV (cabecera obligatoria, orden libre):
//   numero_orden*     — número de orden del ejemplar (entero)
//   ano*              — año de publicación (entero)
//   titulo            — título del número (opcional)
//   mes               — mes de publicación 1-12 (opcional)
//   url_facsimil      — URL al PDF del facsímil (opcional)
//   id_numero_legado  — identificador en el sistema legado (opcional)
//
// Comportamiento (idempotente):
//   - Si id_numero_legado presente y ya existe en BD → omite
//   - Si no hay id_numero_legado y ya existe (revista + numero_orden) → omite
//   - Siempre crea fila draft (published_at NULL) + fila published

'use strict';

const { Client } = require('pg');
const fs = require('fs');
const crypto = require('crypto');

// ── Argumentos ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const revistaArg = args.find(a => a.startsWith('--revista='));
if (!revistaArg) {
  console.error('Uso: node import_numeros_csv.js --revista=<slug> <archivo.csv>');
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

function genDocumentId() {
  return crypto.randomBytes(18).toString('base64').toLowerCase()
    .replace(/[^a-z0-9]/g, '').slice(0, 24).padEnd(24, '0');
}
function num(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function str(v) { return v && String(v).trim() ? String(v).trim() : null; }

// ── Main ──────────────────────────────────────────────────────────────────────

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'postgres',
  port:     parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD,
});

async function run() {
  await db.connect();
  console.log('Conectado a PostgreSQL.\n');

  // Resolver publicación (necesitamos fila draft y published)
  const { rows: pubs } = await db.query(
    `SELECT id, published_at FROM publications WHERE slug = $1 ORDER BY id`,
    [revistaSlug]
  );
  if (pubs.length === 0) {
    console.error(`No se encontró ninguna publicación con slug "${revistaSlug}".`);
    console.error('Slugs disponibles:');
    const { rows: all } = await db.query(
      `SELECT slug, titulo FROM publications WHERE published_at IS NOT NULL ORDER BY titulo`
    );
    all.forEach(p => console.error(`  ${p.slug}  (${p.titulo})`));
    await db.end(); process.exit(1);
  }
  const pubDraft     = pubs.find(p => !p.published_at);
  const pubPublished = pubs.find(p =>  p.published_at);
  if (!pubDraft || !pubPublished) {
    console.error(`La publicación "${revistaSlug}" no tiene ambas filas (draft + published). IDs: ${pubs.map(p => p.id).join(', ')}`);
    await db.end(); process.exit(1);
  }

  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length === 0) {
    console.log('CSV vacío o sin datos.');
    await db.end(); return;
  }

  console.log(`Publicación : "${revistaSlug}" (draft=${pubDraft.id}, published=${pubPublished.id})`);
  console.log(`Filas en CSV: ${rows.length}\n`);

  let creados = 0, omitidos = 0, errores = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const numero_orden    = num(row.numero_orden);
    const ano             = num(row.ano);
    if (!numero_orden || !ano) {
      console.warn(`⚠  Fila omitida (falta numero_orden o ano): ${JSON.stringify(row)}`);
      errores++; continue;
    }
    const titulo          = str(row.titulo);
    const mes             = num(row.mes);
    const url_facsimil    = str(row.url_facsimil);
    const id_numero_legado = num(row.id_numero_legado);

    // Comprobar duplicado
    let dup;
    if (id_numero_legado) {
      dup = await db.query(
        `SELECT id FROM issues WHERE id_numero_legado = $1 LIMIT 1`,
        [id_numero_legado]
      );
    } else {
      dup = await db.query(`
        SELECT i.id FROM issues i
        INNER JOIN issues_publication_lnk lnk ON lnk.issue_id = i.id
        WHERE lnk.publication_id = $1 AND i.numero_orden = $2 AND i.published_at IS NOT NULL
        LIMIT 1
      `, [pubPublished.id, numero_orden]);
    }
    if (dup.rows.length > 0) {
      console.log(`  — omitido (ya existe): n.º ${numero_orden} (${ano})`);
      omitidos++; continue;
    }

    const docId = genDocumentId();
    try {
      const { rows: [draft] } = await db.query(`
        INSERT INTO issues
          (document_id, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, created_at, updated_at, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,NULL)
        RETURNING id
      `, [docId, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, now]);

      await db.query(
        `INSERT INTO issues_publication_lnk (issue_id, publication_id, issue_ord) VALUES ($1,$2,$3)`,
        [draft.id, pubDraft.id, numero_orden]
      );

      const { rows: [pub] } = await db.query(`
        INSERT INTO issues
          (document_id, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, created_at, updated_at, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8)
        RETURNING id
      `, [docId, titulo, numero_orden, mes, ano, url_facsimil, id_numero_legado, now]);

      await db.query(
        `INSERT INTO issues_publication_lnk (issue_id, publication_id, issue_ord) VALUES ($1,$2,$3)`,
        [pub.id, pubPublished.id, numero_orden]
      );

      console.log(`✓ n.º ${numero_orden}. ${titulo || '(sin título)'} (${ano})${id_numero_legado ? '  legado=' + id_numero_legado : ''}`);
      creados++;
    } catch (err) {
      console.error(`✗ Error en n.º ${numero_orden}: ${err.message}`);
      errores++;
    }
  }

  console.log(`\nResultado: ${creados} creados · ${omitidos} omitidos · ${errores} errores.`);
  await db.end();
}

run().catch(err => { console.error(err); process.exit(1); });
