import type { Context } from 'koa';

// Comprueba que el proyecto de ctx.params.id pertenece al usuario
// autenticado. Deniega devolviendo false (Strapi responde 403
// automáticamente); si concede, deja el proyecto ya cargado en
// ctx.state.proyecto para que el controller no repita la consulta.
export default async (ctx: Context, _config: unknown, { strapi }: { strapi: any }) => {
  const user = ctx.state.user;
  if (!user) return false;

  const { id } = ctx.params;
  const proyecto = await strapi.documents('api::proyecto.proyecto').findOne({
    documentId: id,
    populate: ['owner'],
  });

  if (!proyecto || proyecto.owner?.id !== user.id) {
    return false;
  }

  ctx.state.proyecto = proyecto;
  return true;
};
