#!/usr/bin/env node
// Regenera embeddings de anuncios usando texto_ocr_anuncios como fuente.
// Los embeddings anteriores (basados en texto_plano, casi vacío en anuncios)
// se sobreescriben.
//
// Uso (desde dentro del contenedor backend):
//   node /app/scripts/generar_embeddings_anuncios.js

'use strict';

const https = require('https');
const { Client } = require('pg');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('Falta OPENAI_API_KEY'); process.exit(1); }

const MODEL      = 'text-embedding-3-small';
const BATCH_SIZE = 50;
const MAX_CHARS  = 8000;

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'postgres',
  port:     parseInt(process.env.DATABASE_PORT || '5432'),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD,
});

function truncar(texto) {
  return texto.length > MAX_CHARS ? texto.slice(0, MAX_CHARS) : texto;
}

function openaiEmbeddings(inputs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, input: inputs });
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/embeddings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const json = JSON.parse(Buffer.concat(chunks).toString());
        if (json.error) return reject(new Error(json.error.message));
        resolve(json.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function run() {
  await db.connect();
  console.log('Conectado a PostgreSQL.\n');

  const { rows } = await db.query(`
    SELECT id, texto_ocr_anuncios
    FROM articles
    WHERE es_anuncio = true
      AND published_at IS NOT NULL
      AND texto_ocr_anuncios IS NOT NULL
      AND texto_ocr_anuncios != ''
    ORDER BY id
  `);

  console.log(`Anuncios a procesar: ${rows.length}\n`);

  let total = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const lote  = rows.slice(i, i + BATCH_SIZE);
    const textos = lote.map(r => truncar(r.texto_ocr_anuncios.replace(/\r\n/g, '\n').trim()));

    process.stdout.write(`Lote ${Math.floor(i / BATCH_SIZE) + 1} (ids ${lote[0].id}–${lote[lote.length - 1].id})… `);

    let vectores;
    try {
      vectores = await openaiEmbeddings(textos);
    } catch (err) {
      console.error(`\nError: ${err.message}. Reintentando…`);
      await new Promise(r => setTimeout(r, 5000));
      vectores = await openaiEmbeddings(textos);
    }

    for (let j = 0; j < lote.length; j++) {
      await db.query(
        'UPDATE articles SET embedding = $1 WHERE id = $2',
        [`[${vectores[j].join(',')}]`, lote[j].id]
      );
    }
    total += lote.length;
    console.log(`✓ (${total}/${rows.length})`);

    if (i + BATCH_SIZE < rows.length) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nFin. ${total} embeddings de anuncios actualizados.`);
  await db.end();
}

run().catch(err => { console.error(err); process.exit(1); });
