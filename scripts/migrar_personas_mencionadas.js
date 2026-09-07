#!/usr/bin/env node
// Migra `persona-mencionada` (poblada por el piloto de extracción de hace
// un año, ver scripts/importar_personas_mencionadas.js) a la tabla
// unificada `entidad-mencionada` + `mencion`.
//
// No se puede saber con qué método se enlazó cada persona originalmente
// (esa información no se conservó), así que cada mención migrada se marca
// metodo='legado', confianza='media', estado='confirmada' — son datos que
// ya llevan tiempo en producción y se han venido tratando como fiables,
// pero no verificados por el pipeline nuevo (con contexto y desambiguación).
//
// Antes de crear una entidad-mencionada nueva, comprueba si ya existe una
// con nombre equivalente (normalizado, insensible a orden de palabras y
// acentos) creada por el pipeline del diccionario — evita duplicar a la
// misma persona bajo dos nombres distintos ("Vicente Aleixandre" vs
// "Aleixandre, Vicente").
//
// No borra ni toca `persona-mencionada` ni la relación
// `article.personas_mencionadas`: el frontend (Análisis > Análisis de
// contenido) todavía las usa. Es un paso aparte, deliberadamente pospuesto.
//
// Uso:
//   node scripts/migrar_personas_mencionadas.js [--limit=20] [--apply]

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'san', 'santa', 'don', 'dona', 'o', 'u', 'e']);
function stripAccents(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function normalizeForMatch(str) {
  return stripAccents(str)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

function slugify(text) {
  return stripAccents(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main() {
  console.log(`Modo: ${APPLY ? 'APLICANDO CAMBIOS' : 'DRY RUN (usa --apply para escribir)'}\n`);

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  let personas = await app.documents('api::persona-mencionada.persona-mencionada').findMany({
    status: 'published',
    fields: ['nombre'],
    populate: { articles: { fields: ['slug'] } },
  });
  if (LIMIT) personas = personas.slice(0, LIMIT);
  console.log(`Personas a migrar: ${personas.length}`);

  // Conectar por id numérico, no por documentId: para un puñado de
  // artículos conectar por documentId lanza "Invalid relations" (mismo
  // bug ya documentado en importar_personas_mencionadas.js), aunque el
  // artículo existe y está publicado.
  const todosLosArticulos = await app.documents('api::article.article').findMany({
    status: 'published',
    fields: ['slug'],
  });
  const articuloIdPorSlug = new Map(todosLosArticulos.map((a) => [a.slug, a.id]));

  const entidadesExistentes = await app.documents('api::entidad-mencionada.entidad-mencionada').findMany({
    status: 'published',
    fields: ['nombre'],
  });
  const entidadPorNombreNormalizado = new Map(
    entidadesExistentes.map((e) => [normalizeForMatch(e.nombre), e])
  );
  console.log(`Entidades ya existentes en entidad-mencionada: ${entidadesExistentes.length}\n`);

  let entidadesReutilizadas = 0, entidadesCreadas = 0;
  let mencionesCreadas = 0, mencionesYaExistian = 0, sinArticulos = 0, errores = 0;

  for (const [i, persona] of personas.entries()) {
    const articulos = persona.articles || [];
    if (articulos.length === 0) {
      sinArticulos++;
      continue;
    }

    const clave = normalizeForMatch(persona.nombre);
    let entidad = entidadPorNombreNormalizado.get(clave);

    if (entidad) {
      entidadesReutilizadas++;
    } else {
      entidadesCreadas++;
      if (APPLY) {
        entidad = await app.documents('api::entidad-mencionada.entidad-mencionada').create({
          data: { nombre: persona.nombre, slug: slugify(persona.nombre), tipo: 'persona' },
          status: 'published',
        });
      } else {
        entidad = { documentId: `(nueva:${persona.nombre})`, nombre: persona.nombre };
      }
      entidadPorNombreNormalizado.set(clave, entidad);
    }

    for (const art of articulos) {
      const articuloId = articuloIdPorSlug.get(art.slug);
      if (!articuloId) {
        errores++;
        console.error(`  ✗ Artículo no encontrado por slug: ${art.slug}`);
        continue;
      }

      if (APPLY) {
        const yaExiste = await app.documents('api::mencion.mencion').findMany({
          filters: { article: { slug: { $eq: art.slug } }, entidad: { documentId: { $eq: entidad.documentId } } },
          fields: ['documentId'],
          limit: 1,
        });
        if (yaExiste.length > 0) {
          mencionesYaExistian++;
          continue;
        }

        try {
          await app.documents('api::mencion.mencion').create({
            data: {
              texto_mencion: persona.nombre,
              metodo: 'legado',
              confianza: 'media',
              estado: 'confirmada',
              article: articuloId,
              entidad: entidad.documentId,
            },
          });
          mencionesCreadas++;
        } catch (err) {
          errores++;
          console.error(`  ✗ Error en "${persona.nombre}" / ${art.slug}: ${err.message}`);
        }
      } else {
        mencionesCreadas++;
      }
    }

    if ((i + 1) % 50 === 0) console.log(`  ... ${i + 1}/${personas.length}`);
  }

  console.log('\n--- Resumen ---');
  console.log(`Entidades reutilizadas (ya existían con nombre equivalente): ${entidadesReutilizadas}`);
  console.log(`Entidades nuevas${APPLY ? '' : ' (simuladas)'}: ${entidadesCreadas}`);
  console.log(`Menciones creadas${APPLY ? '' : ' (simuladas)'}: ${mencionesCreadas}`);
  console.log(`Menciones que ya existían (idempotencia): ${mencionesYaExistian}`);
  console.log(`Personas sin ningún artículo: ${sinArticulos}`);
  console.log(`Errores: ${errores}`);

  if (!APPLY) console.log('\nDRY RUN. Añade --apply para escribir de verdad.');

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
