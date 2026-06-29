#!/usr/bin/env node
// Importa artículos desde un CSV a PostgreSQL (producción).
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/import_articulos_csv.js --revista=<slug> /ruta/al/archivo.csv
//
// Columnas del CSV (cabecera obligatoria, orden libre):
//   titulo*           — título del artículo
//   numero_orden*     — número de orden del ejemplar donde aparece
//   slug              — slug URL (se genera desde titulo si no se indica)
//   autores           — nombres separados por punto y coma (;)
//   texto             — contenido HTML del artículo
//   idioma            — código de idioma, por defecto "es"
//   es_anuncio        — true/false, por defecto false
//   pagina_inicio     — página inicial en el facsímil
//   pagina_fin        — página final en el facsímil
//   posicion          — posición en el índice del número
//   id_articulo_legado — identificador en el sistema legado
//
// Comportamiento (idempotente):
//   - Si id_articulo_legado presente y ya existe en BD → omite
//   - Si no hay id_articulo_legado y ya existe por slug → omite
//   - Crea autores nuevos automáticamente (draft + published)
//   - Genera texto_plano desde texto (stripeado de HTML + entidades)
//   - Siempre crea fila draft (published_at NULL) + fila published

'use strict';

const { Client } = require('pg');
const fs = require('fs');
const crypto = require('crypto');

// ── Argumentos ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const revistaArg = args.find(a => a.startsWith('--revista='));
if (!revistaArg) {
  console.error('Uso: node import_articulos_csv.js --revista=<slug> <archivo.csv>');
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

function slugify(text) {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function htmlATextoPlano(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function num(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function str(v) { return v && String(v).trim() ? String(v).trim() : null; }
function bool(v) { return String(v).trim().toLowerCase() === 'true'; }

// ── Main ──────────────────────────────────────────────────────────────────────

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'postgres',
  port:     parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD,
});

// Cache de autores ya vistos en esta sesión (nombre normalizado → {draftId, publishedId})
const authorCache = new Map();

async function resolveAutor(nombre, now) {
  const nombreNorm = nombre.trim();
  if (!nombreNorm) return null;

  if (authorCache.has(nombreNorm)) return authorCache.get(nombreNorm);

  // Buscar en BD (insensible a mayúsculas)
  const { rows } = await db.query(
    `SELECT id, published_at FROM authors WHERE lower(nombre) = lower($1) ORDER BY id`,
    [nombreNorm]
  );
  if (rows.length >= 2) {
    const draft     = rows.find(r => !r.published_at);
    const published = rows.find(r =>  r.published_at);
    if (draft && published) {
      const result = { draftId: draft.id, publishedId: published.id };
      authorCache.set(nombreNorm, result);
      return result;
    }
  }

  // Crear autor nuevo
  const docId = genDocumentId();
  const slug  = slugify(nombreNorm);

  // Comprobar que el slug no colisione
  const { rows: slugCheck } = await db.query(
    `SELECT id FROM authors WHERE slug = $1 LIMIT 1`, [slug]
  );
  const finalSlug = slugCheck.length > 0 ? `${slug}-${Date.now()}` : slug;

  const { rows: [draftRow] } = await db.query(`
    INSERT INTO authors (document_id, nombre, slug, created_at, updated_at, published_at)
    VALUES ($1,$2,$3,$4,$4,NULL) RETURNING id
  `, [docId, nombreNorm, finalSlug, now]);

  const { rows: [pubRow] } = await db.query(`
    INSERT INTO authors (document_id, nombre, slug, created_at, updated_at, published_at)
    VALUES ($1,$2,$3,$4,$4,$4) RETURNING id
  `, [docId, nombreNorm, finalSlug, now]);

  console.log(`    + autor creado: "${nombreNorm}" (slug=${finalSlug})`);
  const result = { draftId: draftRow.id, publishedId: pubRow.id };
  authorCache.set(nombreNorm, result);
  return result;
}

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
    const { rows: all } = await db.query(
      `SELECT slug, titulo FROM publications WHERE published_at IS NOT NULL ORDER BY titulo`
    );
    console.error('Slugs disponibles:');
    all.forEach(p => console.error(`  ${p.slug}  (${p.titulo})`));
    await db.end(); process.exit(1);
  }
  const pubDraft     = pubs.find(p => !p.published_at);
  const pubPublished = pubs.find(p =>  p.published_at);
  if (!pubDraft || !pubPublished) {
    console.error(`La publicación "${revistaSlug}" no tiene ambas filas (draft + published).`);
    await db.end(); process.exit(1);
  }

  // Precargar mapa numero_orden → {draftIssueId, publishedIssueId}
  const { rows: issueRows } = await db.query(`
    SELECT i.id, i.numero_orden, i.published_at
    FROM issues i
    INNER JOIN issues_publication_lnk lnk ON lnk.issue_id = i.id
    WHERE lnk.publication_id IN ($1, $2)
    ORDER BY i.numero_orden, i.id
  `, [pubDraft.id, pubPublished.id]);

  const issueMap = new Map();
  for (const r of issueRows) {
    const key = r.numero_orden;
    if (!issueMap.has(key)) issueMap.set(key, {});
    const entry = issueMap.get(key);
    if (!r.published_at) entry.draftId     = r.id;
    else                  entry.publishedId = r.id;
  }

  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length === 0) {
    console.log('CSV vacío o sin datos.');
    await db.end(); return;
  }

  console.log(`Publicación : "${revistaSlug}" (draft=${pubDraft.id}, published=${pubPublished.id})`);
  console.log(`Números cargados: ${issueMap.size} | Filas en CSV: ${rows.length}\n`);

  let creados = 0, omitidos = 0, errores = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const titulo       = str(row.titulo);
    const numero_orden = num(row.numero_orden);
    if (!titulo || !numero_orden) {
      console.warn(`⚠  Fila omitida (falta titulo o numero_orden): ${JSON.stringify(row)}`);
      errores++; continue;
    }

    const issue = issueMap.get(numero_orden);
    if (!issue || !issue.draftId || !issue.publishedId) {
      console.error(`✗ No existe el número ${numero_orden} para "${revistaSlug}". Importa primero los números.`);
      errores++; continue;
    }

    const id_articulo_legado = num(row.id_articulo_legado);
    const texto      = str(row.texto);
    const textoPlano = htmlATextoPlano(texto);
    const idioma     = str(row.idioma) || 'es';
    const es_anuncio = bool(row.es_anuncio);
    const posicion   = num(row.posicion);
    const pag_ini    = num(row.pagina_inicio);
    const pag_fin    = num(row.pagina_fin);

    // Slug
    let slug = str(row.slug) || slugify(titulo);
    if (!slug) slug = `articulo-${Date.now()}`;

    // Comprobar duplicado
    let dup;
    if (id_articulo_legado) {
      dup = await db.query(
        `SELECT id FROM articles WHERE id_articulo_legado = $1 LIMIT 1`,
        [id_articulo_legado]
      );
    } else {
      dup = await db.query(
        `SELECT id FROM articles WHERE slug = $1 LIMIT 1`,
        [slug]
      );
    }
    if (dup.rows.length > 0) {
      console.log(`  — omitido (ya existe): "${titulo}"`);
      omitidos++; continue;
    }

    // Resolver autores
    const autoresStr = str(row.autores) || '';
    const nombresAutores = autoresStr
      .split(';')
      .map(n => n.trim())
      .filter(Boolean);

    const autorIds = [];
    for (const nombre of nombresAutores) {
      try {
        const a = await resolveAutor(nombre, now);
        if (a) autorIds.push(a);
      } catch (err) {
        console.warn(`    ⚠ No se pudo resolver autor "${nombre}": ${err.message}`);
      }
    }

    // Garantizar unicidad del slug en esta inserción
    const { rows: slugExist } = await db.query(
      `SELECT id FROM articles WHERE slug = $1 LIMIT 1`, [slug]
    );
    if (slugExist.length > 0) slug = `${slug}-${Date.now()}`;

    const docId = genDocumentId();
    try {
      // Draft
      const { rows: [draft] } = await db.query(`
        INSERT INTO articles
          (document_id, titulo, slug, texto, texto_plano, idioma, es_anuncio,
           posicion, pagina_inicio, pagina_fin, id_articulo_legado,
           created_at, updated_at, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,NULL)
        RETURNING id
      `, [docId, titulo, slug, texto, textoPlano, idioma, es_anuncio,
          posicion, pag_ini, pag_fin, id_articulo_legado, now]);

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
          (document_id, titulo, slug, texto, texto_plano, idioma, es_anuncio,
           posicion, pagina_inicio, pagina_fin, id_articulo_legado,
           created_at, updated_at, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12)
        RETURNING id
      `, [docId, titulo, slug, texto, textoPlano, idioma, es_anuncio,
          posicion, pag_ini, pag_fin, id_articulo_legado, now]);

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

      const autLabel = nombresAutores.length ? `  [${nombresAutores.join('; ')}]` : '';
      console.log(`✓ n.º${numero_orden} "${titulo}"${autLabel}`);
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
