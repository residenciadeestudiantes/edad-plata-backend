const { compileStrapi, createStrapi } = require('@strapi/strapi');

function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const ISSUE_DOCUMENT_ID = 'ghzsurhbne3xa525ocpj24m2'; // La Gaceta Literaria, número 1

async function main() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const author = await app.documents('api::author.author').create({
    data: {
      nombre: 'Juan Ramón Jiménez',
      slug: slugify('Juan Ramón Jiménez'),
      nombre_normalizado: 'jimenez juan ramon',
      biografia: [{ type: 'paragraph', children: [{ type: 'text', text: 'Autor de prueba.' }] }],
    },
    status: 'published',
  });

  const article = await app.documents('api::article.article').create({
    data: {
      titulo: 'Carta de amor',
      slug: slugify('Carta de amor'),
      texto: '<p>Texto de prueba en HTML.</p>',
      posicion: 2,
      issue: ISSUE_DOCUMENT_ID,
      authors: [author.documentId],
    },
    status: 'published',
  });

  console.log(JSON.stringify({
    authorSlug: author.slug,
    articleSlug: article.slug,
  }));

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
