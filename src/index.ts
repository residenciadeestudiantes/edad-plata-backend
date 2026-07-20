import type { Core } from '@strapi/strapi';

// Acciones que deben quedar accesibles para cualquier usuario con rol
// Authenticated: todo el controller de análisis (antes público) y las
// acciones de cuenta propia (actualizar/eliminar) de src/api/cuenta.
// Se derivan de los propios controllers en vez de mantener listas a mano.
async function sembrarPermisosAuthenticated(strapi: Core.Strapi) {
  const authenticatedRole = await strapi
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'authenticated' } });

  if (!authenticatedRole) {
    strapi.log.warn(
      '[bootstrap] Rol "authenticated" no encontrado; no se pudieron conceder permisos de análisis/cuenta.'
    );
    return;
  }

  const analisisController = strapi.controller('api::analisis.analisis');
  const analisisActions = Object.keys(analisisController).map(
    (action) => `api::analisis.analisis.${action}`
  );

  const proyectoController = strapi.controller('api::proyecto.proyecto');
  const proyectoActions = Object.keys(proyectoController).map(
    (action) => `api::proyecto.proyecto.${action}`
  );

  const extraActions = [
    'api::cuenta.cuenta.actualizar',
    'api::cuenta.cuenta.eliminar',
  ];

  for (const action of [...analisisActions, ...proyectoActions, ...extraActions]) {
    const existing = await strapi
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: authenticatedRole.id } });

    if (!existing) {
      await strapi.query('plugin::users-permissions.permission').create({
        data: { action, role: authenticatedRole.id },
      });
      strapi.log.info(`[bootstrap] Permiso concedido a Authenticated: ${action}`);
    }
  }
}

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await sembrarPermisosAuthenticated(strapi);
  },
};
