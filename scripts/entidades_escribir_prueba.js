#!/usr/bin/env node
// PRUEBA LOCAL: aplica el pipeline de entity linking (scripts/prueba_entity_linking.js)
// sobre unos pocos artículos y escribe de verdad `entidad-mencionada` +
// `mencion` — pero contra la base SQLite LOCAL (backend/.env), nunca contra
// producción. Sirve para validar el diseño de los content-types antes de
// plantearse aplicarlo al corpus real.
//
// Solo crea `mencion` para resultados con un match (match_directo o
// match_desambiguado); "ninguno"/"sin_match"/"demasiados_candidatos" no
// generan ningún registro, solo se listan en el resumen.
//
// estado: 'confirmada' si confianza=alta, 'pendiente' en cualquier otro caso
// (media/baja) — nunca 'descartada' al crear, eso es una acción editorial.
//
// Uso:
//   OPENAI_API_KEY=... node scripts/entidades_escribir_prueba.js [--limit=3] [--apply]
// (sin --apply hace dry run: corre el pipeline y muestra qué crearía, sin escribir)

'use strict';

const { compileStrapi, createStrapi } = require('@strapi/strapi');
const {
  construirGazetteer,
  buscarEnGazetteer,
  candidatosParaDesambiguar,
  llamarOpenAI,
  llamarDesambiguacion,
  extraerContexto,
} = require('./prueba_entity_linking.js');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 3;
const MAX_CANDIDATOS_DESAMBIGUACION = 12;

// tipo del diccionario -> tipo de entidad-mencionada
const MAPA_TIPO = { persona: 'persona', lugar: 'lugar', colectivo: 'institucion', publicacion: 'obra' };

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no configurada.');

  console.log(`Modo: ${APPLY ? 'APLICANDO (escribe en la BD local)' : 'DRY RUN (usa --apply para escribir)'}\n`);

  const gazetteer = construirGazetteer();

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const articulos = await app.documents('api::article.article').findMany({
    status: 'published',
    filters: { texto_plano: { $notNull: true } },
    fields: ['titulo', 'slug', 'texto_plano'],
    limit: LIMIT,
  });
  console.log(`Artículos de prueba (local): ${articulos.length}\n`);

  const cacheEntidad = new Map(); // nombre del diccionario -> documentId de entidad-mencionada
  let entidadesNuevas = 0;

  async function obtenerOCrearEntidad(entradaDic) {
    if (cacheEntidad.has(entradaDic.nombre)) return cacheEntidad.get(entradaDic.nombre);

    const existentes = await app.documents('api::entidad-mencionada.entidad-mencionada').findMany({
      filters: { nombre: { $eq: entradaDic.nombre } },
      fields: ['documentId'],
      limit: 1,
    });
    if (existentes.length > 0) {
      cacheEntidad.set(entradaDic.nombre, existentes[0].documentId);
      return existentes[0].documentId;
    }

    entidadesNuevas++;
    if (!APPLY) {
      const fake = `(nueva:${entradaDic.nombre})`;
      cacheEntidad.set(entradaDic.nombre, fake);
      return fake;
    }

    const slugBase = entradaDic.nombre
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const creada = await app.documents('api::entidad-mencionada.entidad-mencionada').create({
      data: {
        nombre: entradaDic.nombre,
        slug: slugBase,
        tipo: MAPA_TIPO[entradaDic.tipo],
        lema_diccionario: entradaDic.lema,
        descripcion: entradaDic.texto,
        lugar_inicio: entradaDic.lugar_inicio,
        anio_inicio: entradaDic.anio_inicio,
        lugar_fin: entradaDic.lugar_fin,
        anio_fin: entradaDic.anio_fin,
      },
      status: 'published',
    });
    cacheEntidad.set(entradaDic.nombre, creada.documentId);
    return creada.documentId;
  }

  let menciones = 0, sinMatch = 0;

  for (const art of articulos) {
    console.log('='.repeat(70));
    console.log(`ARTÍCULO: ${art.titulo || '(sin título)'} [${art.slug}]`);

    const listaMenciones = await llamarOpenAI(apiKey, art.texto_plano);
    console.log(`Menciones candidatas: ${listaMenciones.length}`);

    for (const m of listaMenciones) {
      const resultado = buscarEnGazetteer(m.texto, gazetteer);
      const candidatos = candidatosParaDesambiguar(m, resultado);
      const contexto = extraerContexto(m.texto, art.texto_plano);

      let entradaFinal = null, metodo = null, confianza = null;

      if (candidatos === null && resultado.estado === 'exacto') {
        entradaFinal = resultado.entrada;
        metodo = resultado.origen;
        confianza = 'alta';
      } else if (candidatos && candidatos.length <= MAX_CANDIDATOS_DESAMBIGUACION) {
        let eleccion;
        try {
          eleccion = await llamarDesambiguacion(apiKey, m.texto, m.tipo_probable, contexto, candidatos);
        } catch (err) {
          console.error(`  ✗ Error desambiguando "${m.texto}": ${err.message}`);
          continue;
        }
        const elegido = eleccion && candidatos[eleccion - 1];
        if (elegido) {
          entradaFinal = elegido;
          metodo = resultado.estado === 'exacto' ? 'remision' : 'apellido_desambiguado';
          confianza = metodo === 'remision' ? 'media' : 'baja';
        }
      }

      if (!entradaFinal) {
        sinMatch++;
        continue;
      }

      const estado = confianza === 'alta' ? 'confirmada' : 'pendiente';
      console.log(`  "${m.texto}" -> ${entradaFinal.nombre} [${MAPA_TIPO[entradaFinal.tipo]}] (${metodo}/${confianza}/${estado})`);

      if (!APPLY) {
        await obtenerOCrearEntidad(entradaFinal); // solo para contar entidades nuevas en el dry run
        menciones++;
        continue;
      }

      const entidadId = await obtenerOCrearEntidad(entradaFinal);
      await app.documents('api::mencion.mencion').create({
        data: {
          texto_mencion: m.texto,
          contexto,
          metodo,
          confianza,
          estado,
          article: art.documentId,
          entidad: entidadId,
        },
      });
      menciones++;
    }
    console.log();
  }

  console.log('--- Resumen ---');
  console.log(`Menciones creadas${APPLY ? '' : ' (simuladas)'}: ${menciones}`);
  console.log(`Sin match / descartadas: ${sinMatch}`);
  console.log(`Entidades nuevas${APPLY ? '' : ' (simuladas)'}: ${entidadesNuevas}`);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
