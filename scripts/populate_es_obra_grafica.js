#!/usr/bin/env node
// Rellena el campo es_obra_grafica en todos los artículos publicados existentes.
// Uso: docker compose exec backend node scripts/populate_es_obra_grafica.js

'use strict';

const { Client } = require('pg');

const client = new Client({
  host:     process.env.DATABASE_HOST     || 'localhost',
  port:     parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD || '',
});

function esObraGrafica(html) {
  const limpio = html
    .replace(/<a class="page"[\s\S]*?<\/a>/g, '')
    .replace(/<div class="Normal">\s*<\/div>/g, '');
  const tieneImgbox = /<div class="imgbox">/.test(limpio);
  const tieneDescrI = /<div class="DescrI">/.test(limpio);
  const tieneTextoReal = /<div class="(?:Normal|Estrofa|Cita)/.test(limpio);
  return tieneImgbox && !tieneDescrI && !tieneTextoReal;
}

async function main() {
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, texto FROM articles WHERE published_at IS NOT NULL`
  );

  let obraGrafica = 0;
  let nulos = 0;

  for (const row of rows) {
    const valor = row.texto ? esObraGrafica(row.texto) : false;
    if (!row.texto) nulos++;
    if (valor) obraGrafica++;
    await client.query(
      `UPDATE articles SET es_obra_grafica = $1 WHERE id = $2`,
      [valor, row.id]
    );
  }

  console.log(`Total procesados: ${rows.length}`);
  console.log(`Marcados como obra gráfica: ${obraGrafica}`);
  console.log(`Sin texto: ${nulos}`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
