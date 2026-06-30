#!/usr/bin/env node
// Rellena el campo es_poema en todos los artículos publicados existentes.
// Uso: docker compose exec backend node scripts/populate_es_poema.js

'use strict';

const { Client } = require('pg');

const client = new Client({
  host:     process.env.DATABASE_HOST     || 'localhost',
  port:     parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD || '',
});

function esPoema(html) {
  return /class="(?:Estrofa|TítuloP)"/.test(html);
}

async function main() {
  await client.connect();

  const { rows } = await client.query(
    `SELECT id, texto FROM articles WHERE published_at IS NOT NULL`
  );

  let poemas = 0;
  let nulos = 0;

  for (const row of rows) {
    const valor = row.texto ? esPoema(row.texto) : false;
    if (!row.texto) nulos++;
    if (valor) poemas++;
    await client.query(
      `UPDATE articles SET es_poema = $1 WHERE id = $2`,
      [valor, row.id]
    );
  }

  console.log(`Total procesados: ${rows.length}`);
  console.log(`Marcados como poema: ${poemas}`);
  console.log(`Sin texto: ${nulos}`);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
