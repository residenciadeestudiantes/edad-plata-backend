#!/usr/bin/env node
// Enlaza autores a artículos ya importados que no los tienen.
// Lee la columna id_autor_legado del Excel y vincula via articles_authors_lnk.
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/patch_autores_articulos.js /ruta/al/archivo.xlsx
//
// Idempotente: omite artículos que ya tienen autores vinculados.

'use strict';

const { Client } = require('pg');
const XLSX       = require('xlsx');

const xlsxPath = process.argv[2];
if (!xlsxPath) {
  console.error('Uso: node patch_autores_articulos.js <archivo.xlsx>');
  process.exit(1);
}

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'postgres',
  port:     parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD,
});

function num(v) { const n = parseInt(String(v), 10); return isNaN(n) ? null : n; }
function str(v) { const s = String(v ?? '').trim(); return s || null; }

async function run() {
  await db.connect();
  console.log('Conectado a PostgreSQL.\n');

  // Precargar autores
  const { rows: authorRows } = await db.query(`
    SELECT id, id_autor_legado, published_at
    FROM authors
    WHERE id_autor_legado IS NOT NULL
    ORDER BY id_autor_legado, id
  `);
  const authorMap = new Map();
  for (const r of authorRows) {
    const key = r.id_autor_legado;
    if (!authorMap.has(key)) authorMap.set(key, {});
    const entry = authorMap.get(key);
    if (!r.published_at) entry.draftId     = r.id;
    else                  entry.publishedId = r.id;
  }
  console.log(`Autores con id_autor_legado: ${authorMap.size}\n`);

  const wb   = XLSX.readFile(xlsxPath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  console.log(`Filas en Excel: ${rows.length}\n`);

  let parcheados = 0, omitidos = 0, sinAutor = 0, errores = 0;

  for (const row of rows) {
    const idLegado       = num(row.id_articulo_legado);
    const titulo         = str(row.titulo) || `id_legado=${idLegado}`;
    const autorLegadoStr = str(row.id_autor_legado);

    if (!idLegado) { errores++; continue; }
    if (!autorLegadoStr) { sinAutor++; continue; }

    // Buscar los artículos (draft + published) por id_articulo_legado
    const { rows: arts } = await db.query(
      `SELECT id, published_at FROM articles WHERE id_articulo_legado = $1 ORDER BY id`,
      [idLegado]
    );
    if (arts.length === 0) {
      console.warn(`  ⚠ Sin artículo para id_articulo_legado=${idLegado}`);
      errores++; continue;
    }

    // ¿Ya tiene autores?
    const artIds = arts.map(a => a.id);
    const { rows: yaAutores } = await db.query(
      `SELECT 1 FROM articles_authors_lnk WHERE article_id = ANY($1) LIMIT 1`,
      [artIds]
    );
    if (yaAutores.length > 0) {
      omitidos++;
      continue;
    }

    // Resolver autores legados
    const legadoIds = autorLegadoStr.split('|').map(s => num(s.trim())).filter(Boolean);
    const autorIds = [];
    for (const legId of legadoIds) {
      const a = authorMap.get(legId);
      if (a) autorIds.push(a);
      else console.warn(`    ⚠ Autor id_autor_legado=${legId} no encontrado`);
    }
    if (autorIds.length === 0) { sinAutor++; continue; }

    try {
      const draftArt     = arts.find(a => !a.published_at);
      const publishedArt = arts.find(a =>  a.published_at);

      for (let i = 0; i < autorIds.length; i++) {
        if (draftArt) {
          await db.query(
            `INSERT INTO articles_authors_lnk (article_id, author_id, author_ord)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [draftArt.id, autorIds[i].draftId, i + 1]
          );
        }
        if (publishedArt) {
          await db.query(
            `INSERT INTO articles_authors_lnk (article_id, author_id, author_ord)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [publishedArt.id, autorIds[i].publishedId, i + 1]
          );
        }
      }
      console.log(`✓ "${titulo}" — ${autorIds.length} autor(es)`);
      parcheados++;
    } catch (err) {
      console.error(`✗ Error en "${titulo}": ${err.message}`);
      errores++;
    }
  }

  console.log(`\nResultado: ${parcheados} parcheados · ${omitidos} ya tenían autores · ${sinAutor} sin autor · ${errores} errores.`);
  await db.end();
}

run().catch(err => { console.error(err); process.exit(1); });
