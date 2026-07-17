#!/usr/bin/env node
// Importa a `personas-mencionadas` el resultado ya canonicalizado de la
// extracción de entidades (piloto de un año, ver conversación/scripts
// auxiliares fuera de este repo). Vincula cada persona a los artículos
// (por slug) en los que se la menciona.
//
// Por defecto hace DRY RUN. Hay que pasar --apply para guardar de verdad.
//
// Uso:
//   node scripts/importar_personas_mencionadas.js <archivo.json> [--apply]
//
// Formato esperado del JSON (array):
//   [{ "canon": "Federico García Lorca", "articulos": [{ "slug": "..." }, ...] }, ...]

'use strict';

const fs = require('fs');
const path = require('path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const jsonPath = args.find((a) => !a.startsWith('--'));

if (!jsonPath) {
  console.error('Uso: node scripts/importar_personas_mencionadas.js <archivo.json> [--apply]');
  process.exit(1);
}

function slugify(text) {
  return text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  const personas = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));
  console.log(`Modo: ${APPLY ? 'APLICANDO CAMBIOS' : 'DRY RUN (usa --apply para guardar)'}`);
  console.log(`Personas a importar: ${personas.length}\n`);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  // Mapa slug de artículo -> documentId (solo publicados)
  const todosLosArticulos = await app.documents('api::article.article').findMany({
    status: 'published',
    fields: ['slug'],
  });
  const articuloIdPorSlug = new Map(todosLosArticulos.map((a) => [a.slug, a.documentId]));
  console.log(`Artículos publicados en la base: ${todosLosArticulos.length}`);

  const existentes = await app.documents('api::persona-mencionada.persona-mencionada').findMany({
    status: 'published',
    fields: ['nombre'],
  });
  const personaPorNombre = new Map(existentes.map((p) => [p.nombre.toLowerCase(), p]));

  let creadas = 0, actualizadas = 0, sinArticulos = 0;
  let totalVinculosNuevos = 0, articulosNoEncontrados = 0;

  for (const persona of personas) {
    const articleIds = [];
    for (const art of persona.articulos) {
      const id = articuloIdPorSlug.get(art.slug);
      if (id) articleIds.push(id);
      else articulosNoEncontrados++;
    }

    if (articleIds.length === 0) {
      sinArticulos++;
      continue;
    }

    const key = persona.canon.toLowerCase();
    const existente = personaPorNombre.get(key);

    if (existente) {
      actualizadas++;
      if (APPLY) {
        await app.documents('api::persona-mencionada.persona-mencionada').update({
          documentId: existente.documentId,
          data: { articles: articleIds },
          status: 'published',
        });
      }
    } else {
      creadas++;
      if (APPLY) {
        const slugBase = slugify(persona.canon);
        await app.documents('api::persona-mencionada.persona-mencionada').create({
          data: { nombre: persona.canon, slug: slugBase, articles: articleIds },
          status: 'published',
        });
      }
    }
    totalVinculosNuevos += articleIds.length;
  }

  console.log('\n--- Resumen ---');
  console.log(`Personas nuevas${APPLY ? '' : ' (simulado)'}:        ${creadas}`);
  console.log(`Personas actualizadas${APPLY ? '' : ' (simulado)'}:  ${actualizadas}`);
  console.log(`Sin ningún artículo encontrado:     ${sinArticulos}`);
  console.log(`Vínculos persona-artículo escritos:  ${totalVinculosNuevos}`);
  console.log(`Slugs de artículo no encontrados:    ${articulosNoEncontrados}`);

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
