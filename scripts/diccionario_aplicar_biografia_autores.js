#!/usr/bin/env node
// Aplica los cambios propuestos por diccionario_asignar_biografia_autores.js
// (backend/diccionarios/cambios_propuestos_autores.json) directamente sobre
// la base de datos real, vía el propio Strapi del servidor (no la API
// pública). Pensado para ejecutarse dentro del contenedor:
//   docker compose exec backend node scripts/diccionario_aplicar_biografia_autores.js
//
// Por defecto hace DRY RUN. Hay que pasar --apply para guardar de verdad.
// Vuelve a comprobar el estado actual del autor antes de escribir (nunca
// pisa un campo que ya tenga valor, aunque el JSON de propuestas esté
// desactualizado).
//
// Uso:
//   node scripts/diccionario_aplicar_biografia_autores.js [--apply]
//       [--in=diccionarios/cambios_propuestos_autores.json]

'use strict';

const fs = require('fs');
const path = require('path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const inArg = args.find((a) => a.startsWith('--in='));
const IN_PATH = path.join(__dirname, '..', inArg ? inArg.split('=')[1] : 'diccionarios/cambios_propuestos_autores.json');

async function main() {
  const propuestos = JSON.parse(fs.readFileSync(IN_PATH, 'utf8'));
  console.log(`Modo: ${APPLY ? 'APLICANDO CAMBIOS' : 'DRY RUN (usa --apply para guardar)'}`);
  console.log(`Propuestas a revisar: ${propuestos.length}\n`);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  let actualizados = 0, sinCambiosYa = 0, noEncontrados = 0, errores = 0;

  for (const p of propuestos) {
    const autor = await app.documents('api::author.author').findOne({
      documentId: p.documentId,
      fields: ['nombre', 'anio_nacimiento', 'anio_fallecimiento', 'lugar_nacimiento', 'lugar_fallecimiento'],
    });
    if (!autor) {
      noEncontrados++;
      console.warn(`  ⚠ No se encontró el autor ${p.documentId} (${p.nombre_autor})`);
      continue;
    }

    // Re-filtra contra el estado actual real, no el capturado en el JSON.
    const data = {};
    for (const campo of ['anio_nacimiento', 'anio_fallecimiento', 'lugar_nacimiento', 'lugar_fallecimiento']) {
      if (p.cambios[campo] === undefined) continue;
      const actual = autor[campo];
      if (actual === null || actual === undefined || actual === '') data[campo] = p.cambios[campo];
    }

    if (Object.keys(data).length === 0) {
      sinCambiosYa++;
      console.log(`  = ${p.nombre_autor}: ya no hay nada que rellenar (cambió entretanto).`);
      continue;
    }

    console.log(`  ${APPLY ? '✓' : '→'} ${p.nombre_autor}:`, JSON.stringify(data));

    if (APPLY) {
      try {
        await app.documents('api::author.author').update({
          documentId: p.documentId,
          data,
          status: 'published',
        });
        actualizados++;
      } catch (err) {
        errores++;
        console.error(`    ✗ Error al guardar "${p.nombre_autor}": ${err.message}`);
      }
    } else {
      actualizados++;
    }
  }

  console.log('\n--- Resumen ---');
  console.log(`Autores actualizados${APPLY ? '' : ' (simulado)'}: ${actualizados}`);
  console.log(`Sin cambios (ya se habían rellenado entretanto): ${sinCambiosYa}`);
  console.log(`No encontrados: ${noEncontrados}`);
  console.log(`Errores: ${errores}`);

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
