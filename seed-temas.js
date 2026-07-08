#!/usr/bin/env node
// Crea los temas (categorías temáticas de artículo) iniciales si no existen ya.
// Idempotente: si un tema con ese nombre ya existe, se omite.
// Uso: node seed-temas.js

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');

function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function slugify(text) {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const TEMAS = [
  'Ciencias y tecnología',
  'Humanidades y filología',
  'Artes visuales y arquitectura',
  'Ciencias sociales y política',
  'Música y artes escénicas',
  'Literatura y creación',
  'Filosofía y pensamiento',
  'Historia',
];

async function main() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  let creados = 0;
  let yaExistian = 0;

  for (const nombre of TEMAS) {
    const existente = await app.documents('api::tema.tema').findFirst({
      filters: { nombre: { $eq: nombre } },
    });

    if (existente) {
      console.log(`Ya existía: ${nombre}`);
      yaExistian++;
      continue;
    }

    await app.documents('api::tema.tema').create({
      data: { nombre, slug: slugify(nombre) },
      status: 'published',
    });
    console.log(`Creado: ${nombre}`);
    creados++;
  }

  console.log(JSON.stringify({ creados, yaExistian }, null, 2));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
