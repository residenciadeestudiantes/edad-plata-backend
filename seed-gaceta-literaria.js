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
      titulo: 'La Gaceta Literaria',
      slug: slugify('La Gaceta Literaria'),
      descripcion: [{ type: 'paragraph', children: [{ type: 'text', text: 'Datos de prueba para verificación manual en navegador.' }] }],
      año_inicio: 1927,
      año_fin: 1932,
      lugar_publicacion: 'Madrid',
      notas: 'Registro creado por seed-gaceta-literaria.js, borrar tras la prueba.',
    },
    status: 'published',
  });

  const author = await app.documents('api::author.author').create({
    data: {
      nombre: 'Ernesto Giménez Caballero',
      slug: slugify('Ernesto Giménez Caballero'),
      nombre_normalizado: 'gimenez caballero ernesto',
      biografia: [{ type: 'paragraph', children: [{ type: 'text', text: 'Autor de prueba.' }] }],
    },
    status: 'published',
  });

  const issue = await app.documents('api::issue.issue').create({
    data: {
      titulo: 'Número 1',
      numero_orden: 1,
      publication: publication.documentId,
    },
    status: 'published',
  });

  const article = await app.documents('api::article.article').create({
    data: {
      titulo: 'El clamor de la poesía',
      slug: slugify('El clamor de la poesía'),
      texto: '<p>Texto de prueba en HTML.</p>',
      posicion: 1,
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
