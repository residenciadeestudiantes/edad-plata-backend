// Rellena el campo `pies_imagen` en todos los artículos publicados.
// Extrae el texto de los elementos TituloI y NormalI del HTML del artículo.
//
// Uso (en el servidor, dentro del contenedor backend):
//   node scripts/populate_pies_imagen.js
//
// Variables de entorno necesarias (las mismas que usa Strapi):
//   DATABASE_CLIENT, DATABASE_HOST, DATABASE_PORT,
//   DATABASE_NAME, DATABASE_USERNAME, DATABASE_PASSWORD

'use strict';

const { Client } = require('pg');

const db = new Client({
  host:     process.env.DATABASE_HOST     || 'localhost',
  port:     parseInt(process.env.DATABASE_PORT || '5432', 10),
  database: process.env.DATABASE_NAME     || 'strapi',
  user:     process.env.DATABASE_USERNAME || 'strapi',
  password: process.env.DATABASE_PASSWORD || '',
});

function extraerPiesImagen(html) {
  if (!html) return '';
  const re = /<div class="(?:TituloI|NormalI)">([\s\S]*?)<\/div>/g;
  const partes = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const texto = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (texto) partes.push(texto);
  }
  return partes.join('\n');
}

async function run() {
  await db.connect();
  console.log('Conectado a PostgreSQL.');

  const { rows } = await db.query(
    `SELECT id, texto FROM articles WHERE published_at IS NOT NULL AND texto IS NOT NULL`
  );
  console.log(`Procesando ${rows.length} artículos publicados con texto…`);

  let updated = 0;
  let sinPies = 0;

  for (const row of rows) {
    const pies = extraerPiesImagen(row.texto);
    await db.query(
      `UPDATE articles SET pies_imagen = $1 WHERE id = $2`,
      [pies || null, row.id]
    );
    if (pies) updated++;
    else sinPies++;
  }

  console.log(`Hecho. Artículos con pies de imagen: ${updated}. Sin pies: ${sinPies}.`);
  await db.end();
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
