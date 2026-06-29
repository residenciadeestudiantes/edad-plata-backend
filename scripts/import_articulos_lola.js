#!/usr/bin/env node
// Importa artículos de Lola desde articulos_revista_lola.xlsx a PostgreSQL (producción).
//
// Uso (desde dentro del contenedor backend):
//   node /app/excels/import_articulos_lola.js
//
// El Excel debe estar en /app/excels/articulos_revista_lola.xlsx
//
// Columnas del Excel usadas:
//   titulo, id_numero_legado, id_articulo_legado, id_autor_legado (puede ser "id1 | id2"),
//   texto, texto_plano, texto_ocr_anuncios, idioma, anuncio, posicion

'use strict';

const { Client } = require('pg');
const XLSX = require('xlsx');
const crypto = require('crypto');
const path = require('path');

const EXCEL_PATH = path.join(__dirname, 'articulos_revista_lola.xlsx');

const IDIOMA_MAP = { 'Español': 'es', 'español': 'es', 'Catalán': 'ca', 'Francés': 'fr', 'Inglés': 'en' };

function genDocumentId() {
  return crypto.randomBytes(18).toString('base64').toLowerCase()
    .replace(/[^a-z0-9]/g, '').slice(0, 24).padEnd(24, '0');
}

function slugify(text) {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function num(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function str(v) { return v && String(v).trim() ? String(v).trim() : null; }

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

  // Precargar issues de Lola: id_numero_legado → {draftId, publishedId}
  const { rows: issueRows } = await db.query(`
    SELECT i.id, i.id_numero_legado, i.published_at
    FROM issues i
    INNER JOIN issues_publication_lnk lnk ON lnk.issue_id = i.id
    INNER JOIN publications p ON p.id = lnk.publication_id
    WHERE p.slug = 'lola' AND i.id_numero_legado IS NOT NULL
    ORDER BY i.id_numero_legado, i.id
  `);
  const issueMap = new Map();
  for (const r of issueRows) {
    const key = r.id_numero_legado;
    if (!issueMap.has(key)) issueMap.set(key, {});
    const entry = issueMap.get(key);
    if (!r.published_at) entry.draftId     = r.id;
    else                  entry.publishedId = r.id;
  }
  console.log(`Issues Lola cargados: ${issueMap.size} números\n`);

  // Precargar autores: id_autor_legado → {draftId, publishedId}
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
  console.log(`Autores cargados con id_autor_legado: ${authorMap.size}\n`);

  // Leer Excel
  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  console.log(`Filas en Excel: ${rows.length}\n`);

  let creados = 0, omitidos = 0, errores = 0;
  const now = new Date().toISOString();
  const slugsUsados = new Set();

  for (const row of rows) {
    const titulo           = str(row.titulo);
    const id_numero_legado = num(row.id_numero_legado);
    const id_articulo_legado = num(row.id_articulo_legado);

    if (!titulo || !id_numero_legado) {
      console.warn(`⚠  Fila omitida (falta titulo o id_numero_legado): ${JSON.stringify(row)}`);
      errores++; continue;
    }

    // Comprobar si ya existe
    if (id_articulo_legado) {
      const dup = await db.query(
        `SELECT id FROM articles WHERE id_articulo_legado = $1 LIMIT 1`,
        [id_articulo_legado]
      );
      if (dup.rows.length > 0) {
        console.log(`  — omitido (ya existe): "${titulo}" (legado=${id_articulo_legado})`);
        omitidos++; continue;
      }
    }

    // Resolver issue
    const issue = issueMap.get(id_numero_legado);
    if (!issue || !issue.draftId || !issue.publishedId) {
      console.error(`✗ No existe el número con id_numero_legado=${id_numero_legado}. ¿Están importados los números?`);
      errores++; continue;
    }

    // Resolver autores
    const autorLegadoStr = str(row.id_autor_legado);
    const autorIds = [];
    if (autorLegadoStr) {
      const legadoIds = autorLegadoStr.split('|').map(s => num(s.trim())).filter(Boolean);
      for (const legId of legadoIds) {
        const a = authorMap.get(legId);
        if (a) {
          autorIds.push(a);
        } else {
          console.warn(`    ⚠ Autor con id_autor_legado=${legId} no encontrado en BD`);
        }
      }
    }

    // Campos del artículo
    const texto       = str(row.texto);
    const textoPlano  = str(row.texto_plano);
    const textoOcr    = str(row.texto_ocr_anuncios);
    const idioma      = IDIOMA_MAP[str(row.idioma)] || 'es';
    const es_anuncio  = row.anuncio === true || row.anuncio === 1 || row.anuncio === 'true';
    const posicion    = num(row.posicion);

    // Generar slug único
    let slug = slugify(titulo);
    if (!slug) slug = `articulo-lola-${id_articulo_legado || Date.now()}`;
    const slugBase = slug;
    let sufijo = 1;
    while (slugsUsados.has(slug)) { slug = `${slugBase}-${sufijo++}`; }
    // Verificar también en BD
    const slugCheck = await db.query(`SELECT id FROM articles WHERE slug = $1 LIMIT 1`, [slug]);
    if (slugCheck.rows.length > 0) { slug = `${slugBase}-${Date.now()}`; }
    slugsUsados.add(slug);

    const docId = genDocumentId();
    try {
      // Draft
      const { rows: [draft] } = await db.query(`
        INSERT INTO articles
          (document_id, titulo, slug, texto, texto_plano, texto_ocr_anuncios,
           idioma, es_anuncio, posicion, id_articulo_legado,
           created_at, updated_at, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,NULL)
        RETURNING id
      `, [docId, titulo, slug, texto, textoPlano, textoOcr,
          idioma, es_anuncio, posicion, id_articulo_legado, now]);

      await db.query(
        `INSERT INTO articles_issue_lnk (article_id, issue_id, article_ord) VALUES ($1,$2,$3)`,
        [draft.id, issue.draftId, posicion]
      );
      for (let i = 0; i < autorIds.length; i++) {
        await db.query(
          `INSERT INTO articles_authors_lnk (article_id, author_id, author_ord) VALUES ($1,$2,$3)`,
          [draft.id, autorIds[i].draftId, i + 1]
        );
      }

      // Published
      const { rows: [pub] } = await db.query(`
        INSERT INTO articles
          (document_id, titulo, slug, texto, texto_plano, texto_ocr_anuncios,
           idioma, es_anuncio, posicion, id_articulo_legado,
           created_at, updated_at, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11)
        RETURNING id
      `, [docId, titulo, slug, texto, textoPlano, textoOcr,
          idioma, es_anuncio, posicion, id_articulo_legado, now]);

      await db.query(
        `INSERT INTO articles_issue_lnk (article_id, issue_id, article_ord) VALUES ($1,$2,$3)`,
        [pub.id, issue.publishedId, posicion]
      );
      for (let i = 0; i < autorIds.length; i++) {
        await db.query(
          `INSERT INTO articles_authors_lnk (article_id, author_id, author_ord) VALUES ($1,$2,$3)`,
          [pub.id, autorIds[i].publishedId, i + 1]
        );
      }

      const autLabel = autorIds.length ? ` [${legadoStr(autorLegadoStr)}]` : '';
      console.log(`✓ "${titulo}" (n.º legado ${id_numero_legado})${autLabel}`);
      creados++;
    } catch (err) {
      console.error(`✗ Error en "${titulo}": ${err.message}`);
      errores++;
    }
  }

  console.log(`\nResultado: ${creados} creados · ${omitidos} omitidos · ${errores} errores.`);
  await db.end();
}

function legadoStr(s) { return s ? String(s).replace(/\s*\|\s*/g, ', ') : ''; }

run().catch(err => { console.error(err); process.exit(1); });
