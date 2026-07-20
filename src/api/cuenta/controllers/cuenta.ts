import type { Context } from 'koa';

// Registro, edición y borrado de la cuenta propia del usuario. No se
// implementa envolviendo los controllers del plugin users-permissions
// (src/extensions/users-permissions) porque, comprobado empíricamente en
// esta versión de Strapi, sobrescribir o añadir acciones a los
// controllers de un plugin no se refleja en el motor de permisos (los
// endpoints se registran y no rompen el arranque, pero el chequeo de
// habilidad/scope sigue evaluando el controller original, dando siempre
// 403 aunque el permiso exista en base de datos). Por eso esta lógica
// vive en una API propia, igual que /api/proyectos o /api/analisis, cuyo
// gating vía el rol Authenticated sí funciona de forma fiable.

const getUserService = () => strapi.plugin('users-permissions').service('user');
const getJwtService = () => strapi.plugin('users-permissions').service('jwt');

async function sanitizeUser(user: Record<string, unknown>) {
  return strapi.contentAPI.sanitize.output(user, strapi.getModel('plugin::users-permissions.user'));
}

export default {
  async registro(ctx: Context) {
    const { nombre, apellidos, email, password } = (ctx.request.body ?? {}) as Record<string, string>;

    if (!nombre || !apellidos) {
      return ctx.badRequest('nombre y apellidos son obligatorios');
    }
    if (!email || !password) {
      return ctx.badRequest('email y password son obligatorios');
    }

    const pluginStore = await strapi.store({ type: 'plugin', name: 'users-permissions' });
    const settings = (await pluginStore.get({ key: 'advanced' })) as {
      allow_register: boolean;
      default_role: string;
      unique_email: boolean;
    };

    if (!settings.allow_register) {
      return ctx.badRequest('El registro está actualmente deshabilitado');
    }

    const emailNormalizado = email.toLowerCase();

    const conflictingUserCount = await strapi.db.query('plugin::users-permissions.user').count({
      where: { email: emailNormalizado },
    });
    if (conflictingUserCount > 0) {
      return ctx.badRequest('Ya existe una cuenta con ese email');
    }

    const role = await strapi.db.query('plugin::users-permissions.role').findOne({
      where: { type: settings.default_role },
    });
    if (!role) {
      return ctx.internalServerError('No se encontró el rol por defecto');
    }

    // Strapi exige un `username` único de fábrica; el formulario de
    // registro no lo pide, así que se autogenera a partir del email.
    const user = await getUserService().add({
      username: emailNormalizado,
      email: emailNormalizado,
      password,
      nombre,
      apellidos,
      provider: 'local',
      role: role.id,
      confirmed: true,
    });

    const jwt = getJwtService().issue({ id: user.id });
    const sanitizedUser = await sanitizeUser(user);

    ctx.body = { jwt, user: sanitizedUser };
  },

  async actualizar(ctx: Context) {
    const authUser = ctx.state.user;
    if (!authUser) return ctx.unauthorized();

    const allowedKeys = ['nombre', 'apellidos', 'email'];
    const body = (ctx.request.body ?? {}) as Record<string, string>;
    const invalidKeys = Object.keys(body).filter((key) => !allowedKeys.includes(key));
    if (invalidKeys.length > 0) {
      return ctx.badRequest(`Campos no permitidos: ${invalidKeys.join(', ')}`);
    }

    const data: Record<string, string> = { ...body };
    if (data.email) {
      data.email = data.email.toLowerCase();

      const advancedConfigs = (await strapi
        .store({ type: 'plugin', name: 'users-permissions', key: 'advanced' })
        .get()) as { unique_email: boolean };

      if (advancedConfigs.unique_email) {
        const existing = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { email: data.email },
        });
        if (existing && existing.id !== authUser.id) {
          return ctx.badRequest('Ya existe una cuenta con ese email');
        }
      }

      // Mantiene el invariante username === email establecido en el registro.
      data.username = data.email;
    }

    const updated = await getUserService().edit(authUser.id, data);
    ctx.body = await sanitizeUser(updated);
  },

  async eliminar(ctx: Context) {
    const authUser = ctx.state.user;
    if (!authUser) return ctx.unauthorized();

    // Borrado en cascada de los Proyectos del usuario antes de borrar la cuenta.
    const proyectos = await strapi.documents('api::proyecto.proyecto').findMany({
      filters: { owner: authUser.id },
    });
    for (const proyecto of proyectos) {
      await strapi.documents('api::proyecto.proyecto').delete({ documentId: proyecto.documentId });
    }

    await getUserService().remove({ id: authUser.id });
    ctx.body = { ok: true };
  },
};
