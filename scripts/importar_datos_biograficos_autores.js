#!/usr/bin/env node
// Importa a `authors` los datos de nacimiento/fallecimiento y actividad
// obtenidos del cruce con nrevistasedp.edaddeplata.org
// (ver scripts/scrape_personas_nrevistasedp.js).
//
// Por defecto hace un DRY RUN: solo muestra qué cambiaría, no escribe nada.
// Hay que pasar --apply explícitamente para guardar los cambios.
//
// No pisa datos ya existentes (si un autor ya tiene anio_nacimiento, por
// ejemplo, se deja tal cual) salvo que se pase --force. Las actividades
// se van sumando a las que ya tuviera el autor, nunca se quitan.
//
// Uso:
//   node scripts/importar_datos_biograficos_autores.js
//       [--csv=exports/cruce_personas_autores.csv]   (por defecto)
//       [--apply]                                     (si no, dry run)
//       [--force]                                     (sobrescribe campos ya rellenos)
//       [--limit=50]                                  (para probar con pocos)
//
// Para aplicar los candidatos de la pasada difusa, cúrsalos primero a mano
// en exports/cruce_personas_autores_fuzzy.csv (borra las filas que no
// quieras aceptar) y luego:
//   node scripts/importar_datos_biograficos_autores.js --csv=exports/cruce_personas_autores_fuzzy.csv --apply
// (de ese archivo solo se usan las filas con rank=1; las rank=2/3 se ignoran)

'use strict';

const fs = require('fs');
const path = require('path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const csvArg = args.find((a) => a.startsWith('--csv='));
const limitArg = args.find((a) => a.startsWith('--limit='));
const CSV_PATH = csvArg
  ? path.resolve(__dirname, '..', csvArg.split('=')[1])
  : path.join(__dirname, '..', 'exports', 'cruce_personas_autores.csv');
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

// Parser CSV mínimo (comillas dobles, comas y saltos de línea dentro de campos).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignorar, \n lo cierra
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const headers = rows.shift();
  return rows
    .filter((r) => r.length === headers.length && r.some((v) => v !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}

function capitalizeFirst(str) {
  const s = str.trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseActividades(remoteProfesion) {
  if (!remoteProfesion || !remoteProfesion.trim()) return [];
  return remoteProfesion
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(capitalizeFirst);
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(`No existe el archivo ${CSV_PATH}. Ejecuta antes scrape_personas_nrevistasedp.js.`);
  }

  let filas = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));

  // El archivo de la pasada difusa trae varios candidatos por autor
  // (columna rank); nos quedamos solo con el mejor de cada uno.
  if (filas.length > 0 && 'rank' in filas[0]) {
    filas = filas.filter((f) => f.rank === '1');
  }

  filas = filas.filter((f) => f.local_document_id && f.remote_id);
  if (LIMIT) filas = filas.slice(0, LIMIT);

  console.log(`Modo: ${APPLY ? 'APLICANDO CAMBIOS' : 'DRY RUN (usa --apply para guardar)'}`);
  console.log(`CSV: ${CSV_PATH}`);
  console.log(`Filas con candidato remoto: ${filas.length}${LIMIT ? ` (limitado a ${LIMIT})` : ''}\n`);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const autoresExistentes = await app.documents('api::author.author').findMany({
    status: 'published',
    fields: ['nombre', 'anio_nacimiento', 'anio_fallecimiento', 'lugar_nacimiento', 'lugar_fallecimiento'],
    populate: { actividades: { fields: ['nombre', 'documentId'] } },
  });
  const autorPorId = new Map(autoresExistentes.map((a) => [a.documentId, a]));

  const actividadesExistentes = await app.documents('api::actividad.actividad').findMany({
    status: 'published',
    fields: ['nombre'],
  });
  const actividadPorNombre = new Map(
    actividadesExistentes.map((a) => [a.nombre.toLowerCase(), a])
  );

  async function obtenerOCrearActividad(nombre) {
    const key = nombre.toLowerCase();
    if (actividadPorNombre.has(key)) return { actividad: actividadPorNombre.get(key), esNueva: false };

    if (!APPLY) {
      // En dry run no creamos nada; simulamos un placeholder para el resumen.
      const fake = { documentId: `(nueva:${nombre})`, nombre };
      actividadPorNombre.set(key, fake);
      return { actividad: fake, esNueva: true };
    }

    const slugBase = nombre
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const creada = await app.documents('api::actividad.actividad').create({
      data: { nombre, slug: slugBase },
      status: 'published',
    });
    actividadPorNombre.set(key, creada);
    console.log(`  + nueva actividad: "${nombre}"`);
    return { actividad: creada, esNueva: true };
  }

  let actualizados = 0, sinCambios = 0, noEncontrados = 0, nuevasActividades = 0;
  const ejemplos = [];

  for (const fila of filas) {
    const autor = autorPorId.get(fila.local_document_id);
    if (!autor) {
      noEncontrados++;
      console.warn(`  ⚠ No se encontró el autor local ${fila.local_document_id} (${fila.local_nombre})`);
      continue;
    }

    const data = {};

    // El API remoto usa "0" como año desconocido (en vez de vacío) y
    // "*ERR:*ERR" como marcador de lugar roto: los tratamos como sin dato.
    const esAnioInvalido = (v) => !Number.isFinite(Number(v)) || Number(v) === 0;
    const esLugarInvalido = (v) => v.includes('*ERR');

    const setSiVacio = (campo, valor) => {
      if (valor === undefined || valor === null || valor === '') return;
      const esAnio = campo.startsWith('anio_');
      if (esAnio && esAnioInvalido(valor)) return;
      if (!esAnio && esLugarInvalido(valor)) return;
      if (!FORCE && autor[campo] !== null && autor[campo] !== undefined && autor[campo] !== '') return;
      data[campo] = esAnio ? Number(valor) : valor;
    };

    setSiVacio('anio_nacimiento', fila.remote_birth_year);
    setSiVacio('anio_fallecimiento', fila.remote_death_year);
    setSiVacio('lugar_nacimiento', fila.remote_birth_place);
    setSiVacio('lugar_fallecimiento', fila.remote_death_place);

    const actividadesNuevas = parseActividades(fila.remote_profesion);
    const actividadesActualesIds = new Set((autor.actividades || []).map((a) => a.documentId));
    const actividadesActualesNombres = new Set(
      (autor.actividades || []).map((a) => a.nombre.toLowerCase())
    );

    const idsFinal = new Set(actividadesActualesIds);
    let huboActividadNueva = false;
    for (const nombreAct of actividadesNuevas) {
      if (actividadesActualesNombres.has(nombreAct.toLowerCase())) continue;
      const { actividad: act, esNueva } = await obtenerOCrearActividad(nombreAct);
      if (esNueva) nuevasActividades++;
      idsFinal.add(act.documentId);
      huboActividadNueva = true;
    }
    if (huboActividadNueva) {
      data.actividades = [...idsFinal];
    }

    if (Object.keys(data).length === 0) {
      sinCambios++;
      continue;
    }

    actualizados++;
    if (ejemplos.length < 15) {
      ejemplos.push({ nombre: autor.nombre, cambios: data });
    }

    if (APPLY) {
      await app.documents('api::author.author').update({
        documentId: fila.local_document_id,
        data,
        status: 'published',
      });
    }
  }

  console.log('\n--- Ejemplos de cambios (primeros 15) ---');
  for (const ej of ejemplos) {
    console.log(`  ${ej.nombre}:`, JSON.stringify(ej.cambios));
  }

  console.log('\n--- Resumen ---');
  console.log(`Autores actualizados${APPLY ? '' : ' (simulado)'}: ${actualizados}`);
  console.log(`Autores sin cambios (ya tenían los datos): ${sinCambios}`);
  console.log(`Autores no encontrados en la base local:   ${noEncontrados}`);
  console.log(`Actividades nuevas creadas${APPLY ? '' : ' (simuladas)'}:   ${nuevasActividades}`);

  if (!APPLY) {
    console.log('\nEsto ha sido un DRY RUN. Añade --apply para guardar los cambios de verdad.');
  }

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
