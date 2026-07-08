#!/usr/bin/env node
// Clasifica artículos por tema (categoría temática) usando gpt-4o-mini.
// Excluye artículos ya marcados como poema u obra gráfica (no son prosa de
// contenido temático). Permite más de un tema cuando el artículo cruza
// varios claramente; en general prefiere uno solo.
//
// Idempotente: salta los artículos que ya tienen algún tema asignado.
//
// Uso:
//   docker compose exec backend node scripts/clasificar_temas_llm.js
//   docker compose exec backend node scripts/clasificar_temas_llm.js --slugs=slug1,slug2
//   docker compose exec backend node scripts/clasificar_temas_llm.js --limit=20

'use strict';

const https = require('https');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const args = process.argv.slice(2);
const slugsArg = args.find((a) => a.startsWith('--slugs='));
const limitArg = args.find((a) => a.startsWith('--limit='));
const slugsFiltro = slugsArg ? slugsArg.split('=')[1].split(',').map((s) => s.trim()) : null;
const limite = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

function llamarOpenAI(apiKey, temasNombres, titulo, textoPlano) {
  const textoRecortado = (textoPlano || '').slice(0, 12000);
  const prompt = `Clasifica el siguiente artículo de una revista cultural española (1898-1936) en una o más de estas categorías temáticas:

${temasNombres.map((n) => `- ${n}`).join('\n')}

Instrucciones:
- Devuelve solo las categorías que apliquen claramente. Lo habitual es UNA sola.
- Usa más de una únicamente si el artículo cruza de verdad dos temas (p. ej. una biografía de un músico centrada en su muerte violenta puede ser a la vez "Música y artes escénicas" e "Historia"). No fuerces varias por rutina.
- Usa exactamente los nombres de la lista, tal cual están escritos.
- Responde solo JSON con esta forma: {"temas": ["Categoría 1", "Categoría 2"]}

Título: ${titulo}

Texto:
${textoRecortado}`;

  const reqBody = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 100,
    temperature: 0,
    response_format: { type: 'json_object' },
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(reqBody),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            if (json.error) return reject(new Error(json.error.message));
            const contenido = json.choices[0].message.content;
            const parsed = JSON.parse(contenido);
            resolve(Array.isArray(parsed.temas) ? parsed.temas : []);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no configurada.');

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const temas = await app.documents('api::tema.tema').findMany({ status: 'published' });
  if (temas.length === 0) throw new Error('No hay temas creados. Ejecuta antes seed-temas.js.');
  const temaPorNombre = new Map(temas.map((t) => [t.nombre.toLowerCase().trim(), t]));
  const temasNombres = temas.map((t) => t.nombre);

  const filtros = { es_poema: { $eq: false }, es_obra_grafica: { $eq: false } };
  if (slugsFiltro) filtros.slug = { $in: slugsFiltro };

  let articulos = await app.documents('api::article.article').findMany({
    status: 'published',
    filters: filtros,
    fields: ['titulo', 'slug', 'texto_plano'],
    populate: { temas: { fields: ['nombre'] } },
  });

  if (!slugsFiltro) {
    articulos = articulos.filter((a) => !a.temas || a.temas.length === 0);
  }
  if (limite) articulos = articulos.slice(0, limite);

  console.log(`Artículos a clasificar: ${articulos.length}`);

  const conteoTemas = new Map(temasNombres.map((n) => [n, 0]));
  let clasificados = 0;
  let sinTemaValido = 0;
  let errores = 0;

  for (const [i, articulo] of articulos.entries()) {
    let nombresDevueltos;
    try {
      nombresDevueltos = await llamarOpenAI(apiKey, temasNombres, articulo.titulo, articulo.texto_plano);
    } catch (err) {
      console.error(`  ✗ Error OpenAI en "${articulo.titulo}": ${err.message}`);
      errores++;
      continue;
    }

    const temaIds = [];
    const nombresValidos = [];
    for (const nombre of nombresDevueltos) {
      const tema = temaPorNombre.get(String(nombre).toLowerCase().trim());
      if (tema) {
        temaIds.push(tema.documentId);
        nombresValidos.push(tema.nombre);
        conteoTemas.set(tema.nombre, conteoTemas.get(tema.nombre) + 1);
      }
    }

    if (temaIds.length === 0) {
      console.warn(`  ⚠ Sin tema válido para "${articulo.titulo}" (devolvió: ${JSON.stringify(nombresDevueltos)})`);
      sinTemaValido++;
      continue;
    }

    await app.documents('api::article.article').update({
      documentId: articulo.documentId,
      data: { temas: temaIds },
      status: 'published',
    });

    clasificados++;
    console.log(`  [${i + 1}/${articulos.length}] "${articulo.titulo}" → ${nombresValidos.join(', ')}`);
  }

  console.log('\n--- Resumen ---');
  console.log(JSON.stringify({ total: articulos.length, clasificados, sinTemaValido, errores }, null, 2));
  console.log('Por tema:', JSON.stringify(Object.fromEntries(conteoTemas), null, 2));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
