#!/usr/bin/env node
// Puebla `entidad-mencionada` + `mencion` sobre el corpus real de artículos,
// usando el pipeline de scripts/prueba_entity_linking.js (extracción con
// LLM + enlace contra el diccionario de vanguardias + desambiguación con
// contexto). Pensado para ejecutarse en lotes, en producción, vía:
//   docker compose exec backend node scripts/entidades_poblar_corpus.js --apply --limit=20
//
// Salta los artículos que YA tengan alguna mención del pipeline nuevo
// (metodo != legado) — así se puede relanzar en lotes sucesivos sin
// reprocesar ni gastar de más en llamadas al LLM. Los artículos que solo
// tengan menciones "legado" (migradas de persona-mencionada) sí se procesan,
// porque el pipeline nuevo cubre categorías que esas no tenían (obras,
// ciudades, instituciones).
//
// Por defecto hace DRY RUN. Hay que pasar --apply para escribir de verdad.
//
// Uso:
//   OPENAI_API_KEY=... node scripts/entidades_poblar_corpus.js
//       [--limit=20]                (artículos NUEVOS a procesar en esta tirada)
//       [--publicacion="Residencia"] (filtra por nombre de revista)
//       [--apply]

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
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 20;
const publicacionArg = args.find((a) => a.startsWith('--publicacion='));
const PUBLICACION = publicacionArg ? publicacionArg.split('=')[1] : null;
const MAX_CANDIDATOS_DESAMBIGUACION = 12;

const MAPA_TIPO = { persona: 'persona', lugar: 'lugar', colectivo: 'institucion', publicacion: 'obra' };

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY no configurada.');

  console.log(`Modo: ${APPLY ? 'APLICANDO (escribe en producción)' : 'DRY RUN (usa --apply para escribir)'}`);
  console.log(`Límite de artículos nuevos esta tirada: ${LIMIT}${PUBLICACION ? ` | Revista: ${PUBLICACION}` : ''}\n`);

  const gazetteer = construirGazetteer();

  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  // Artículos con al menos una mención del pipeline nuevo: se saltan.
  // status: 'published' es necesario aquí: `article` se conecta por id
  // numérico (ver más abajo), lo que liga la relación específicamente a la
  // fila publicada del artículo — sin este status, el populate por defecto
  // busca en el contexto draft y no encuentra el enlace, devolviendo null.
  const yaProcesados = await app.documents('api::mencion.mencion').findMany({
    status: 'published',
    filters: { metodo: { $ne: 'legado' } },
    fields: ['id'],
    populate: { article: { fields: ['slug'] } },
  });
  const slugsYaProcesados = new Set(yaProcesados.map((m) => m.article?.slug).filter(Boolean));
  console.log(`Artículos ya cubiertos por el pipeline nuevo (se saltan): ${slugsYaProcesados.size}`);

  const filtros = {
    es_poema: { $eq: false },
    es_obra_grafica: { $eq: false },
    es_anuncio: { $eq: false },
    texto_plano: { $notNull: true },
  };
  if (PUBLICACION) filtros.issue = { publication: { titulo: { $eq: PUBLICACION } } };

  const candidatos = await app.documents('api::article.article').findMany({
    status: 'published',
    filters: filtros,
    fields: ['titulo', 'slug', 'texto_plano'],
    
  });
  const articulos = candidatos.filter((a) => !slugsYaProcesados.has(a.slug)).slice(0, LIMIT);
  console.log(`Artículos candidatos totales: ${candidatos.length} | Nuevos a procesar esta tirada: ${articulos.length}\n`);

  const todosLosArticulos = await app.documents('api::article.article').findMany({
    status: 'published', fields: ['slug'],
  });
  const articuloIdPorSlug = new Map(todosLosArticulos.map((a) => [a.slug, a.id]));

  const cacheEntidad = new Map();
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

  let menciones = 0, sinMatch = 0, articulosSinMenciones = 0, errores = 0;

  for (const [idx, art] of articulos.entries()) {
    console.log('='.repeat(70));
    console.log(`[${idx + 1}/${articulos.length}] ${art.titulo || '(sin título)'} [${art.slug}]`);

    let listaMenciones;
    try {
      listaMenciones = await llamarOpenAI(apiKey, art.texto_plano);
    } catch (err) {
      console.error(`  ✗ Error extrayendo menciones: ${err.message}`);
      errores++;
      continue;
    }
    console.log(`  Menciones candidatas: ${listaMenciones.length}`);
    if (listaMenciones.length === 0) articulosSinMenciones++;

    for (const m of listaMenciones) {
      const resultado = buscarEnGazetteer(m.texto, gazetteer);
      const cands = candidatosParaDesambiguar(m, resultado);
      const contexto = extraerContexto(m.texto, art.texto_plano);

      let entradaFinal = null, metodo = null, confianza = null;

      if (cands === null && resultado.estado === 'exacto') {
        entradaFinal = resultado.entrada;
        metodo = resultado.origen;
        confianza = 'alta';
      } else if (cands && cands.length <= MAX_CANDIDATOS_DESAMBIGUACION) {
        let eleccion;
        try {
          eleccion = await llamarDesambiguacion(apiKey, m.texto, m.tipo_probable, contexto, cands);
        } catch (err) {
          console.error(`  ✗ Error desambiguando "${m.texto}": ${err.message}`);
          continue;
        }
        const elegido = eleccion && cands[eleccion - 1];
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
      console.log(`    "${m.texto}" -> ${entradaFinal.nombre} [${MAPA_TIPO[entradaFinal.tipo]}] (${metodo}/${confianza}/${estado})`);

      if (!APPLY) {
        await obtenerOCrearEntidad(entradaFinal);
        menciones++;
        continue;
      }

      const entidadId = await obtenerOCrearEntidad(entradaFinal);
      const articuloId = articuloIdPorSlug.get(art.slug);
      try {
        await app.documents('api::mencion.mencion').create({
          data: { texto_mencion: m.texto, contexto, metodo, confianza, estado, article: articuloId, entidad: entidadId },
        });
        menciones++;
      } catch (err) {
        errores++;
        console.error(`  ✗ Error creando mención "${m.texto}": ${err.message}`);
      }
    }
  }

  console.log('\n--- Resumen ---');
  console.log(`Artículos procesados: ${articulos.length}`);
  console.log(`Artículos sin ninguna mención extraída: ${articulosSinMenciones}`);
  console.log(`Menciones creadas${APPLY ? '' : ' (simuladas)'}: ${menciones}`);
  console.log(`Entidades nuevas${APPLY ? '' : ' (simuladas)'}: ${entidadesNuevas}`);
  console.log(`Sin match / descartadas: ${sinMatch}`);
  console.log(`Errores: ${errores}`);
  console.log(`\nArtículos candidatos que quedan por procesar: ${candidatos.length - slugsYaProcesados.size - articulos.length}`);

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
