import type { Context } from 'koa';

// Controller propio (no createCoreController), mismo patrón ya probado en
// api::proyecto: Document Service directo, sin el wrapper {data} ni la
// validación de claves de relación de los controllers de fábrica.

export default {
  async listar(ctx: Context) {
    // El filtro corto { proyecto: documentId } no funciona: Strapi solo lo
    // resuelve contra el id numérico, no el documentId. Hay que filtrar
    // explícitamente por el campo documentId del proyecto relacionado.
    const analisis = await strapi.documents('api::analisis-guardado.analisis-guardado').findMany({
      filters: { proyecto: { documentId: ctx.params.id } } as never,
    });
    ctx.body = { data: analisis };
  },

  async guardar(ctx: Context) {
    const { tipo, parametros, titulo } = (ctx.request.body ?? {}) as {
      tipo?: string;
      parametros?: Record<string, unknown>;
      titulo?: string;
    };

    if (!tipo) return ctx.badRequest('tipo es obligatorio');
    if (!parametros) return ctx.badRequest('parametros es obligatorio');
    if (!titulo) return ctx.badRequest('titulo es obligatorio');

    const analisis = await strapi.documents('api::analisis-guardado.analisis-guardado').create({
      data: { tipo, parametros, titulo, proyecto: ctx.params.id } as never,
    });
    ctx.body = { data: analisis };
  },

  async eliminar(ctx: Context) {
    await strapi.documents('api::analisis-guardado.analisis-guardado').delete({
      documentId: ctx.params.analisisId,
    });
    ctx.body = { ok: true };
  },
};
