#!/usr/bin/env node
// Cruza las entradas de tipo "persona" del diccionario de vanguardias
// (backend/diccionarios/entradas_finales.json) con los autores existentes
// en Strapi, por nombre normalizado (insensible a orden de palabras,
// acentos y mayúsculas — igual que scrape_personas_nrevistasedp.js).
//
// Para los autores que hagan match exacto, propone rellenar
// anio_nacimiento / anio_fallecimiento / lugar_nacimiento /
// lugar_fallecimiento — SOLO los campos que el autor tenga vacíos; nunca
// pisa datos ya existentes (habría que añadir --force si algún día hace
// falta, como en importar_datos_biograficos_autores.js).
//
// FASE 1 (esta ejecución): lee autores por la API pública de solo lectura
// de Strapi y genera un informe de qué cambiaría, sin escribir nada.
// La escritura real se hace en un segundo paso, una vez decidido cómo
// autenticarse contra el Strapi remoto.
//
// Uso:
//   node scripts/diccionario_asignar_biografia_autores.js [--out=cambios_propuestos.json]

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'diccionarios');
const STRAPI_URL = process.env.STRAPI_URL || 'https://cmsedp.testresidencia.com';

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const OUT_PATH = path.join(DIR, outArg ? outArg.split('=')[1] : 'cambios_propuestos_autores.json');

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'don', 'dona', 'o', 'u']);

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Misma normalización que scrape_personas_nrevistasedp.js: ignora acentos,
// mayúsculas, orden de palabras ("Apellido, Nombre" vs "Nombre Apellido")
// y partículas sin valor para desambiguar.
function normalizeForMatch(str) {
  return stripAccents(str)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

async function fetchTodosLosAutores() {
  const autores = [];
  let page = 1;
  const pageSize = 100;
  for (;;) {
    const url = `${STRAPI_URL}/api/authors?pagination[page]=${page}&pagination[pageSize]=${pageSize}&fields[0]=nombre&fields[1]=nombre_normalizado&fields[2]=variantes_nombre&fields[3]=anio_nacimiento&fields[4]=anio_fallecimiento&fields[5]=lugar_nacimiento&fields[6]=lugar_fallecimiento`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Error ${res.status} al pedir autores (página ${page})`);
    const json = await res.json();
    autores.push(...json.data);
    if (page >= json.meta.pagination.pageCount) break;
    page++;
  }
  return autores;
}

function main() {
  return fetchTodosLosAutores().then((autores) => {
    console.log(`Autores en Strapi: ${autores.length}`);

    const finales = JSON.parse(fs.readFileSync(path.join(DIR, 'entradas_finales.json'), 'utf8'));
    const personas = finales.filter((e) => e.tipo === 'persona');
    console.log(`Entradas de tipo persona en el diccionario: ${personas.length}`);

    // Un autor puede matchear por su nombre de dictionary o, si es un
    // seudónimo, por el nombre real. Indexamos por todas las claves
    // razonables de cada entrada.
    const indice = new Map(); // claveNormalizada -> entrada del diccionario
    for (const p of personas) {
      const claves = new Set([normalizeForMatch(p.nombre)]);
      if (p.nombre_real) claves.add(normalizeForMatch(p.nombre_real));
      for (const clave of claves) {
        if (!clave) continue;
        if (indice.has(clave) && indice.get(clave) !== p) {
          indice.set(clave, null); // clave ambigua (2 entradas distintas comparten nombre normalizado): no usar
        } else {
          indice.set(clave, p);
        }
      }
    }

    const propuestos = [];
    let sinDatosNuevos = 0;
    let matchAmbiguo = 0;
    let sinMatch = 0;

    for (const autor of autores) {
      const clavesAutor = new Set([normalizeForMatch(autor.nombre)]);
      if (autor.nombre_normalizado) clavesAutor.add(normalizeForMatch(autor.nombre_normalizado));
      if (autor.variantes_nombre) {
        for (const v of autor.variantes_nombre.split(/[,;\n]/)) {
          const c = normalizeForMatch(v);
          if (c) clavesAutor.add(c);
        }
      }

      let entrada = null;
      for (const clave of clavesAutor) {
        if (!clave || !indice.has(clave)) continue;
        const candidata = indice.get(clave);
        if (candidata === null) { matchAmbiguo++; continue; }
        entrada = candidata;
        break;
      }
      if (!entrada) { sinMatch++; continue; }

      // El paréntesis del lema debe traer algún indicio real de fecha (un
      // dígito, o el marcador de desconocido ¿/?): si no trae nada de eso,
      // no es un paréntesis de nacimiento-muerte (p. ej. "(CENTENARIO)"),
      // y no hay que fiarse de ningún lugar/año que hayamos extraído de él.
      if (!/[\d¿?]/.test(entrada.lema)) { sinDatosNuevos++; continue; }

      // Un lugar nunca debería llevar dígitos: si los lleva es que el año
      // de al lado venía corrupto en el propio diccionario (p. ej. "198X")
      // y se coló dentro del lugar al no reconocerse como año válido.
      const lugarValido = (l) => l && !/\d/.test(l);

      const cambios = {};
      if (!autor.anio_nacimiento && entrada.anio_inicio) cambios.anio_nacimiento = entrada.anio_inicio;
      if (!autor.anio_fallecimiento && entrada.anio_fin) cambios.anio_fallecimiento = entrada.anio_fin;
      if (!autor.lugar_nacimiento && lugarValido(entrada.lugar_inicio)) cambios.lugar_nacimiento = entrada.lugar_inicio;
      if (!autor.lugar_fallecimiento && lugarValido(entrada.lugar_fin)) cambios.lugar_fallecimiento = entrada.lugar_fin;

      if (Object.keys(cambios).length === 0) { sinDatosNuevos++; continue; }

      propuestos.push({
        documentId: autor.documentId,
        nombre_autor: autor.nombre,
        lema_diccionario: entrada.lema,
        datos_actuales: {
          anio_nacimiento: autor.anio_nacimiento,
          anio_fallecimiento: autor.anio_fallecimiento,
          lugar_nacimiento: autor.lugar_nacimiento,
          lugar_fallecimiento: autor.lugar_fallecimiento,
        },
        cambios,
      });
    }

    fs.writeFileSync(OUT_PATH, JSON.stringify(propuestos, null, 2), 'utf8');

    console.log(`\n--- Resumen (solo lectura, nada escrito todavía) ---`);
    console.log(`Autores con match exacto en el diccionario: ${propuestos.length + sinDatosNuevos}`);
    console.log(`  - con datos nuevos que aportar:  ${propuestos.length}`);
    console.log(`  - match pero sin datos nuevos (ya completos, o el diccionario tampoco tiene fecha/lugar): ${sinDatosNuevos}`);
    console.log(`Autores sin match en el diccionario: ${sinMatch}`);
    console.log(`Coincidencias de nombre ambiguas (2+ entradas del diccionario comparten nombre normalizado, descartadas): ${matchAmbiguo}`);
    console.log(`\nPropuesta de cambios guardada en ${OUT_PATH}`);

    console.log('\n--- Muestra de 15 cambios propuestos ---');
    for (const p of propuestos.slice(0, 15)) {
      console.log(`  ${p.nombre_autor} (${p.lema_diccionario}) ->`, JSON.stringify(p.cambios));
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
