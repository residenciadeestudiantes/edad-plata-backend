const { compileStrapi, createStrapi } = require('@strapi/strapi');

async function main() {
  const appContext = await compileStrapi();
  const app = await createStrapi(appContext).load();
  app.log.level = 'error';

  const publicRole = await app
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });

  if (!publicRole) {
    throw new Error('No se encontró el rol "public"');
  }

  const actions = ['api::actividad.actividad.find', 'api::actividad.actividad.findOne'];

  for (const action of actions) {
    const existing = await app.query('plugin::users-permissions.permission').findOne({
      where: { action, role: publicRole.id },
    });

    if (existing) {
      console.log(`Ya existía: ${action}`);
      continue;
    }

    await app.query('plugin::users-permissions.permission').create({
      data: { action, role: publicRole.id },
    });
    console.log(`Concedido: ${action}`);
  }

  await app.destroy();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
