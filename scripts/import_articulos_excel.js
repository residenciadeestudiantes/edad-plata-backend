#!/usr/bin/env node
// Importa artículos desde un Excel (.xlsx) a PostgreSQL.
// Pensado para ficheros con columnas:
//   titulo, anuncio, id_numero_legado, texto, texto_ocr_anuncios,
//   idioma, id_articulo_legado, posicion, id_autor_legado, imagenes
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/import_articulos_excel.js --revista=<slug> /ruta/al/archivo.xlsx
//
// Comportamiento (idempotente):
//   - Omite artículos cuyo id_articulo_legado ya existe en BD
//   - Resuelve la issue via id_numero_legado → id en BD
//   - Crea dos filas por artículo (draft + published)

'use strict';

const { Client } = require('pg');
const crypto     = require('crypto');
const XLSX       = require('xlsx');

// ── Argumentos ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const revistaArg = args.find(a => a.startsWith('--revista='));
if (!revistaArg) {
  console.error('Uso: node import_articulos_excel.js --revista=<slug> <archivo.xlsx>');
  process.exit(1);
}
const revistaSlug = revistaArg.split('=')[1].trim();
const xlsxPath    = args.find(a => !a.startsWith('--'));
if (!xlsxPath) {
  console.error('Indica la ruta al fichero .xlsx');
  process.exit(1);
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

function num(v) { const n = parseInt(String(v), 10); return isNaN(n) ? null : n; }
function str(v) { const s = String(v ?? '').trim(); return s || null; }
function bool(v) { return String(v).trim().toUpperCase() === 'TRUE'; }

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

  // Resolver publicación (draft + published)
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

  // Precargar mapa id_numero_legado → {draftIssueId, publishedIssueId}
  const { rows: issueRows } = await db.query(`
    SELECT i.id, i.id_numero_legado, i.published_at
    FROM issues i
    INNER JOIN issues_publication_lnk lnk ON lnk.issue_id = i.id
    WHERE lnk.publication_id IN ($1, $2)
    ORDER BY i.id_numero_legado, i.id
  `, [pubDraft.id, pubPublished.id]);

  const issueMap = new Map(); // id_numero_legado → { draftId, publishedId }
  for (const r of issueRows) {
    const key = r.id_numero_legado;
    if (!issueMap.has(key)) issueMap.set(key, {});
    const entry = issueMap.get(key);
    if (!r.published_at) entry.draftId     = r.id;
    else                  entry.publishedId = r.id;
  }

  // Leer Excel
  const wb   = XLSX.readFile(xlsxPath);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  console.log(`Publicación: "${revistaSlug}" (draft=${pubDraft.id}, published=${pubPublished.id})`);
  console.log(`Números cargados: ${issueMap.size} | Filas en Excel: ${rows.length}\n`);

  let creados = 0, omitidos = 0, errores = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const titulo            = str(row.titulo);
    const id_numero_legado  = num(row.id_numero_legado);
    const id_articulo_legado = num(row.id_articulo_legado);

    if (!titulo || !id_numero_legado) {
      console.warn(`⚠  Fila omitida (falta titulo o id_numero_legado): ${JSON.stringify(row)}`);
      errores++; continue;
    }

    const issue = issueMap.get(id_numero_legado);
    if (!issue || !issue.draftId || !issue.publishedId) {
      console.error(`✗ No existe número con id_numero_legado=${id_numero_legado} para "${revistaSlug}".`);
      errores++; continue;
    }

    // Idempotencia
    if (id_articulo_legado) {
      const { rows: dup } = await db.query(
        `SELECT id FROM articles WHERE id_articulo_legado = $1 LIMIT 1`,
        [id_articulo_legado]
      );
      if (dup.length > 0) {
        console.log(`  — omitido (ya existe): "${titulo}"`);
        omitidos++; continue;
      }
    }

    const texto            = str(row.texto);
    const textoOcr         = str(row.texto_ocr_anuncios);
    const textoPlano       = htmlATextoPlano(texto);
    const piesImagen       = extraerPiesImagen(texto || '');
    const idioma           = str(row.idioma) || 'Español';
    const es_anuncio       = bool(row.anuncio);
    const posicion         = num(row.posicion);

    let slug = slugify(titulo) || `articulo-${Date.now()}`;
    const { rows: slugExist } = await db.query(
      `SELECT id FROM articles WHERE slug = $1 LIMIT 1`, [slug]
    );
    if (slugExist.length > 0) slug = `${slug}-${Date.now()}`;

    const docId = genDocumentId();
    try {
      const campos = `document_id, titulo, slug, texto, texto_plano, texto_ocr_anuncios,
                      pies_imagen, idioma, es_anuncio, posicion, id_articulo_legado,
                      created_at, updated_at, published_at`;
      const vals   = [
        docId, titulo, slug, texto, textoPlano, textoOcr,
        piesImagen, idioma, es_anuncio, posicion, id_articulo_legado,
        now,
      ];

      // Draft
      const { rows: [draft] } = await db.query(
        `INSERT INTO articles (${campos}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,NULL) RETURNING id`,
        vals
      );
      await db.query(
        `INSERT INTO articles_issue_lnk (article_id, issue_id, article_ord) VALUES ($1,$2,$3)`,
        [draft.id, issue.draftId, posicion]
      );

      // Published
      const { rows: [pub] } = await db.query(
        `INSERT INTO articles (${campos}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING id`,
        vals
      );
      await db.query(
        `INSERT INTO articles_issue_lnk (article_id, issue_id, article_ord) VALUES ($1,$2,$3)`,
        [pub.id, issue.publishedId, posicion]
      );

      console.log(`✓ n.º legado ${id_numero_legado} pos.${posicion ?? '?'} "${titulo}"`);
      creados++;
    } catch (err) {
      console.error(`✗ Error en "${titulo}": ${err.message}`);
      errores++;
    }
  }

  console.log(`\nResultado: ${creados} creados · ${omitidos} omitidos · ${errores} errores.`);
  await db.end();
}

function extraerPiesImagen(html) {
  const re = /<div class="(?:TituloI|NormalI)">([\s\S]*?)<\/div>/g;
  const partes = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (t) partes.push(t);
  }
  return partes.join('\n') || null;
}

run().catch(err => { console.error(err); process.exit(1); });
