const { compileStrapi, createStrapi } = require('@strapi/strapi');

function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function main() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const publication = await app.documents('api::publication.publication').create({
    data: {
      titulo: 'Revista de Occidente (prueba)',
      slug: slugify('Revista de Occidente (prueba)'),
      descripcion: [{ type: 'paragraph', children: [{ type: 'text', text: 'Datos de prueba para verificación manual en navegador.' }] }],
      año_inicio: 1923,
      año_fin: 1936,
      lugar_publicacion: 'Madrid',
      notas: 'Registro creado por seed-test-data.js, borrar tras la prueba.',
    },
    status: 'published',
  });

  const author = await app.documents('api::author.author').create({
    data: {
      nombre: 'José Ortega y Gasset (prueba)',
      slug: slugify('José Ortega y Gasset (prueba)'),
      nombre_normalizado: 'ortega y gasset jose',
      biografia: [{ type: 'paragraph', children: [{ type: 'text', text: 'Autor de prueba.' }] }],
    },
    status: 'published',
  });

  const issue = await app.documents('api::issue.issue').create({
    data: {
      titulo: 'Número 1 (prueba)',
      numero_orden: 1,
      mes: 1,
      año: 1923,
      url_facsimil:
        'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf',
      publication: publication.documentId,
    },
    status: 'published',
  });

  const article = await app.documents('api::article.article').create({
    data: {
      titulo: 'Artículo de prueba',
      slug: slugify('Artículo de prueba'),
      texto: '<p>Texto de prueba en HTML.</p>',
      posicion: 1,
      pagina_inicio: 1,
      pagina_fin: 4,
      issue: issue.documentId,
      authors: [author.documentId],
    },
    status: 'published',
  });

  console.log(JSON.stringify({
    publicationSlug: publication.slug,
    authorSlug: author.slug,
    articleSlug: article.slug,
    numeroOrden: issue.numero_orden,
  }));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
