#!/usr/bin/env node
// Descarga el listado completo de "personas" del API público de
// http://nrevistasedp.edaddeplata.org y lo cruza por nombre con los
// autores ya existentes en nuestra base (tabla `authors`).
//
// El API no expone biografía ni texto libre: cada persona trae nombre,
// lugar/año de nacimiento-muerte, sexo, y los IDs de sus obras, artículos,
// revistas y movimientos relacionados. Ese es el contenido que se extrae.
//
// Uso:
//   node scripts/scrape_personas_nrevistasedp.js [--force]
//
// Salidas (en exports/):
//   personas_nrevistasedp.json        -> volcado íntegro del API (5917 registros)
//   personas_nrevistasedp.csv         -> mismo listado en CSV
//   cruce_personas_autores.csv        -> cruce por nombre contra `authors` local
//   cruce_personas_autores_fuzzy.csv  -> candidatos difusos para los sin match

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const API_BASE = 'http://nrevistasedp.edaddeplata.org/api/people';
const OUT_DIR = path.join(__dirname, '..', 'exports');
const RAW_JSON = path.join(OUT_DIR, 'personas_nrevistasedp.json');
const RAW_CSV = path.join(OUT_DIR, 'personas_nrevistasedp.csv');
const CRUCE_CSV = path.join(OUT_DIR, 'cruce_personas_autores.csv');
const FUZZY_CSV = path.join(OUT_DIR, 'cruce_personas_autores_fuzzy.csv');
const DB_PATH = path.join(__dirname, '..', '.tmp', 'data.db');

// Partículas de nombre español sin valor para desambiguar.
const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'don', 'dona']);

const FORCE = process.argv.includes('--force');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Misma normalización que scripts/seed-ids-autores.js: ignora orden
// ("Apellido, Nombre" vs "Nombre Apellido") ordenando las palabras.
function normalizeForMatch(str) {
  return stripAccents(str)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

function tokensOf(str) {
  return stripAccents(str)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function significantTokens(tokens) {
  return tokens.filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// El API no tiene un campo "profesión" propio: se deduce de las claves de
// activities_types (ej. {"poeta":1,"ensayista":1} -> "poeta, ensayista").
function profesionDe(p) {
  return Object.keys(p.activities_types || {}).join(', ');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

async function fetchAllPersonas() {
  if (fs.existsSync(RAW_JSON) && !FORCE) {
    console.log(`Ya existe ${RAW_JSON} (usa --force para volver a descargar).`);
    return JSON.parse(fs.readFileSync(RAW_JSON, 'utf8'));
  }

  console.log('Descargando listado de personas desde el API...');
  const first = await fetch(`${API_BASE}?page=1`).then((r) => r.json());
  const total = first.total;
  const pageSize = first.elements.length;
  const totalPages = Math.ceil(total / pageSize);
  console.log(`Total personas: ${total} (${totalPages} páginas de ${pageSize})`);

  const all = [...first.elements];
  const seenIds = new Set(all.map((e) => e.id));

  for (let page = 2; page <= totalPages; page++) {
    const data = await fetch(`${API_BASE}?page=${page}`).then((r) => r.json());
    for (const el of data.elements) {
      if (!seenIds.has(el.id)) {
        seenIds.add(el.id);
        all.push(el);
      }
    }
    if (page % 10 === 0 || page === totalPages) {
      console.log(`  página ${page}/${totalPages} (${all.length} personas acumuladas)`);
    }
    await sleep(120); // ritmo suave, no machacar el servidor público
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(RAW_JSON, JSON.stringify(all, null, 2), 'utf8');
  console.log(`Guardado ${RAW_JSON} (${all.length} personas).`);
  return all;
}

function writeRawCsv(personas) {
  const headers = [
    'id', 'l', 'birth_place', 'death_place', 'birth_year', 'death_year',
    'sex', 'genre', 'works_count', 'articles_count', 'magazines_count',
    'movements_count', 'activities_types', 'works_ids', 'articles_ids',
    'magazines_ids', 'movements_ids',
  ];
  const rows = personas.map((p) => ({
    id: p.id,
    l: p.l,
    birth_place: p.birth_place,
    death_place: p.death_place,
    birth_year: p.birth_year,
    death_year: p.death_year,
    sex: p.sex,
    genre: p.genre,
    works_count: p.works_count,
    articles_count: p.articles_count,
    magazines_count: p.magazines_count,
    movements_count: p.movements_count,
    activities_types: JSON.stringify(p.activities_types || {}),
    works_ids: p.works_ids,
    articles_ids: p.articles_ids,
    magazines_ids: p.magazines_ids,
    movements_ids: p.movements_ids,
  }));
  writeCsv(RAW_CSV, headers, rows);
  console.log(`Guardado ${RAW_CSV} (${rows.length} filas).`);
}

function cruzarConAutoresLocales(personas) {
  const db = new Database(DB_PATH, { readonly: true });
  const localAuthors = db.prepare(`
    SELECT document_id, nombre, id_autor_legado
    FROM authors
    WHERE published_at IS NOT NULL
  `).all();
  db.close();
  console.log(`Autores locales (publicados): ${localAuthors.length}`);

  // remoto: normalized -> [personas]
  const remoteByKey = new Map();
  for (const p of personas) {
    const key = normalizeForMatch(p.l);
    if (!key) continue;
    if (!remoteByKey.has(key)) remoteByKey.set(key, []);
    remoteByKey.get(key).push(p);
  }

  const activity = (p) =>
    (p.works_count || 0) + (p.articles_count || 0) + (p.magazines_count || 0) + (p.movements_count || 0);

  const rows = [];
  const noMatchAuthors = [];
  let matched = 0, resolved = 0, noMatch = 0;

  for (const author of localAuthors) {
    const key = normalizeForMatch(author.nombre);
    const candidates = remoteByKey.get(key) || [];

    if (candidates.length === 0) {
      noMatch++;
      noMatchAuthors.push(author);
      rows.push({
        local_document_id: author.document_id,
        local_nombre: author.nombre,
        local_id_autor_legado: author.id_autor_legado,
        match_status: 'sin_match',
        remote_id: '', remote_nombre: '', remote_birth_year: '', remote_death_year: '',
        remote_birth_place: '', remote_death_place: '', remote_profesion: '',
        remote_works_count: '', remote_articles_count: '', remote_magazines_count: '',
        remote_alt_ids: '',
      });
      continue;
    }

    // Si hay varios candidatos con el mismo nombre normalizado, la base
    // remota suele tener duplicados (un registro "completo" y otro "stub"
    // casi vacío para la misma persona). Nos quedamos con el de más
    // actividad (obras+artículos+revistas+movimientos) y dejamos rastro
    // de los demás ids en remote_alt_ids.
    const sorted = [...candidates].sort((a, b) => activity(b) - activity(a));
    const best = sorted[0];
    const alts = sorted.slice(1);

    if (candidates.length === 1) {
      matched++;
    } else {
      resolved++;
    }

    rows.push({
      local_document_id: author.document_id,
      local_nombre: author.nombre,
      local_id_autor_legado: author.id_autor_legado,
      match_status: candidates.length === 1 ? 'match' : 'match_resuelto_de_duplicados',
      remote_id: best.id, remote_nombre: best.l,
      remote_birth_year: best.birth_year ?? '', remote_death_year: best.death_year ?? '',
      remote_birth_place: best.birth_place ?? '', remote_death_place: best.death_place ?? '',
      remote_profesion: profesionDe(best),
      remote_works_count: best.works_count, remote_articles_count: best.articles_count,
      remote_magazines_count: best.magazines_count,
      remote_alt_ids: alts.map((p) => p.id).join('|'),
    });
  }

  const headers = [
    'local_document_id', 'local_nombre', 'local_id_autor_legado', 'match_status',
    'remote_id', 'remote_nombre', 'remote_birth_year', 'remote_death_year',
    'remote_birth_place', 'remote_death_place', 'remote_profesion',
    'remote_works_count', 'remote_articles_count', 'remote_magazines_count', 'remote_alt_ids',
  ];
  writeCsv(CRUCE_CSV, headers, rows);

  console.log('\n--- Resumen del cruce ---');
  console.log(`Autores locales totales:            ${localAuthors.length}`);
  console.log(`  con match único:                  ${matched}`);
  console.log(`  match resuelto (varios candidatos): ${resolved}`);
  console.log(`  sin match:                         ${noMatch}`);
  console.log(`Personas remotas totales:            ${personas.length}`);
  console.log(`Guardado ${CRUCE_CSV}`);

  return noMatchAuthors;
}

// Segunda pasada, solo sobre los autores que no tuvieron match exacto.
// Compara conjuntos de tokens "significativos" (sin partículas, longitud >= 3)
// con un coeficiente de solapamiento (overlap = intersección / mínimo de los
// dos tamaños), que detecta bien casos como "Castelao" vs "Alfonso R. Castelao".
// No se aplica automáticamente: todo queda marcado para revisión manual.
function fuzzyMatchRemaining(personas, noMatchAuthors) {
  if (noMatchAuthors.length === 0) {
    console.log('\nNo hay autores sin match; no hace falta la pasada difusa.');
    return;
  }

  console.log(`\nBuscando candidatos difusos para ${noMatchAuthors.length} autores sin match...`);

  const remoteSig = personas.map((p) => ({
    p,
    sig: new Set(significantTokens(tokensOf(p.l))),
  })).filter((r) => r.sig.size > 0);

  const invertedIndex = new Map(); // token -> [{p, sig}]
  for (const entry of remoteSig) {
    for (const tok of entry.sig) {
      if (!invertedIndex.has(tok)) invertedIndex.set(tok, []);
      invertedIndex.get(tok).push(entry);
    }
  }

  const activity = (p) =>
    (p.works_count || 0) + (p.articles_count || 0) + (p.magazines_count || 0) + (p.movements_count || 0);

  const MAX_CANDIDATOS_UTILES = 15; // por encima de esto, el nombre es demasiado genérico
  const TOP_N = 3;

  const rows = [];
  let conCandidatos = 0, sinCandidatos = 0, demasiadoGenerico = 0;

  for (const author of noMatchAuthors) {
    const localSig = new Set(significantTokens(tokensOf(author.nombre)));
    if (localSig.size === 0) {
      sinCandidatos++;
      rows.push({
        local_document_id: author.document_id, local_nombre: author.nombre,
        local_id_autor_legado: author.id_autor_legado, candidatos_totales: 0,
        rank: '', remote_id: '', remote_nombre: '', overlap: '', jaccard: '',
        remote_birth_year: '', remote_death_year: '', remote_birth_place: '', remote_death_place: '',
        remote_profesion: '', remote_works_count: '',
        remote_articles_count: '', remote_magazines_count: '', nota: 'nombre sin tokens útiles',
      });
      continue;
    }

    const seenIds = new Set();
    const candidates = [];
    for (const tok of localSig) {
      for (const entry of invertedIndex.get(tok) || []) {
        if (seenIds.has(entry.p.id)) continue;
        seenIds.add(entry.p.id);
        const inter = [...localSig].filter((t) => entry.sig.has(t)).length;
        const union = new Set([...localSig, ...entry.sig]).size;
        const overlap = inter / Math.min(localSig.size, entry.sig.size);
        const jaccard = inter / union;
        if (overlap >= 0.5) candidates.push({ p: entry.p, overlap, jaccard });
      }
    }

    if (candidates.length === 0) {
      sinCandidatos++;
      rows.push({
        local_document_id: author.document_id, local_nombre: author.nombre,
        local_id_autor_legado: author.id_autor_legado, candidatos_totales: 0,
        rank: '', remote_id: '', remote_nombre: '', overlap: '', jaccard: '',
        remote_birth_year: '', remote_death_year: '', remote_birth_place: '', remote_death_place: '',
        remote_profesion: '', remote_works_count: '',
        remote_articles_count: '', remote_magazines_count: '', nota: 'sin candidatos',
      });
      continue;
    }

    conCandidatos++;
    if (candidates.length > MAX_CANDIDATOS_UTILES) demasiadoGenerico++;

    candidates.sort((a, b) => b.overlap - a.overlap || b.jaccard - a.jaccard || activity(b.p) - activity(a.p));

    const top = candidates.slice(0, TOP_N);
    top.forEach((c, i) => {
      rows.push({
        local_document_id: author.document_id,
        local_nombre: author.nombre,
        local_id_autor_legado: author.id_autor_legado,
        candidatos_totales: candidates.length,
        rank: i + 1,
        remote_id: c.p.id,
        remote_nombre: c.p.l,
        overlap: c.overlap.toFixed(2),
        jaccard: c.jaccard.toFixed(2),
        remote_birth_year: c.p.birth_year ?? '',
        remote_death_year: c.p.death_year ?? '',
        remote_birth_place: c.p.birth_place ?? '',
        remote_death_place: c.p.death_place ?? '',
        remote_profesion: profesionDe(c.p),
        remote_works_count: c.p.works_count,
        remote_articles_count: c.p.articles_count,
        remote_magazines_count: c.p.magazines_count,
        nota: candidates.length > MAX_CANDIDATOS_UTILES ? 'nombre muy genérico, revisar con cuidado' : '',
      });
    });
  }

  const headers = [
    'local_document_id', 'local_nombre', 'local_id_autor_legado', 'candidatos_totales',
    'rank', 'remote_id', 'remote_nombre', 'overlap', 'jaccard',
    'remote_birth_year', 'remote_death_year', 'remote_birth_place', 'remote_death_place',
    'remote_profesion', 'remote_works_count', 'remote_articles_count',
    'remote_magazines_count', 'nota',
  ];
  writeCsv(FUZZY_CSV, headers, rows);

  console.log('\n--- Resumen de la pasada difusa (solo revisión manual) ---');
  console.log(`Autores sin match exacto analizados: ${noMatchAuthors.length}`);
  console.log(`  con al menos un candidato:         ${conCandidatos}`);
  console.log(`    de ellos, nombre muy genérico:    ${demasiadoGenerico}`);
  console.log(`  sin ningún candidato:               ${sinCandidatos}`);
  console.log(`Guardado ${FUZZY_CSV}`);
}

async function main() {
  const personas = await fetchAllPersonas();
  writeRawCsv(personas);
  const noMatchAuthors = cruzarConAutoresLocales(personas);
  fuzzyMatchRemaining(personas, noMatchAuthors);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
