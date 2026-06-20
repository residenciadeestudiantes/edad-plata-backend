const { compileStrapi, createStrapi } = require('@strapi/strapi');

function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parrafo(texto) {
  return { type: 'paragraph', children: [{ type: 'text', text: texto }] };
}

async function main() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  await app.documents('api::page.page').create({
    data: {
      titulo: 'Qué es la Edad de Plata',
      slug: slugify('Qué es la Edad de Plata'),
      contenido: [
        parrafo(
          'La Edad de Plata es el periodo de extraordinaria vitalidad cultural e intelectual que vivió España aproximadamente entre 1898 y 1936, marcado por generaciones de escritores, artistas, científicos y pensadores que renovaron la vida cultural española y la conectaron con las corrientes europeas de su tiempo.'
        ),
        parrafo(
          'Este contenido es un texto de partida editable desde el panel de administración de Strapi (Content Manager → Página).'
        ),
      ],
    },
    status: 'published',
  });

  await app.documents('api::page.page').create({
    data: {
      titulo: 'Proyecto Edad de Plata',
      slug: slugify('Proyecto Edad de Plata'),
      contenido: [
        parrafo(
          'Este proyecto digitaliza y cataloga revistas culturales españolas del primer tercio del siglo XX, poniendo a disposición de investigadores y público general sus números, artículos y autores.'
        ),
        parrafo(
          'Este contenido es un texto de partida editable desde el panel de administración de Strapi (Content Manager → Página).'
        ),
      ],
    },
    status: 'published',
  });

  console.log('Páginas creadas correctamente.');
  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
