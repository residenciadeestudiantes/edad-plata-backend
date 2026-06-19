const { compileStrapi, createStrapi } = require('@strapi/strapi');

function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const PUBLICATION_DOCUMENT_ID = 'sahnfk5qczymq8xw34urn2xe'; // La Gaceta Literaria

async function main() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const author = await app.documents('api::author.author').create({
    data: {
      nombre: 'Federico García Lorca',
      slug: slugify('Federico García Lorca'),
      nombre_normalizado: 'garcia lorca federico',
      biografia: [{ type: 'paragraph', children: [{ type: 'text', text: 'Autor de prueba.' }] }],
    },
    status: 'published',
  });

  const issue = await app.documents('api::issue.issue').create({
    data: {
      titulo: 'Número 2',
      numero_orden: 2,
      publication: PUBLICATION_DOCUMENT_ID,
    },
    status: 'published',
  });

  const article = await app.documents('api::article.article').create({
    data: {
      titulo: 'El cante jondo',
      slug: slugify('El cante jondo'),
      texto: '<p>Texto de prueba en HTML.</p>',
      posicion: 1,
      issue: issue.documentId,
      authors: [author.documentId],
    },
    status: 'published',
  });

  console.log(JSON.stringify({
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
