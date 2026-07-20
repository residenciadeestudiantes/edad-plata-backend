import type { Context } from 'koa';

// Controller 100% propio (no createCoreController): probado empíricamente
// que `only`/`except` de createCoreRouter no excluye de verdad las rutas
// core en esta versión de Strapi, así que /proyectos seguía resolviendo
// al `find`/`create` de fábrica (que exige el wrapper {data:...} y
// rechaza "owner" como clave no reconocida por ser una relación). Todo se
// gestiona aquí directamente vía Document Service, igual que ya hace
// /api/buscar y /api/analisis.

export default {
  // Solo mis proyectos, nunca los de otros usuarios.
  async misProyectos(ctx: Context) {
    const proyectos = await strapi.documents('api::proyecto.proyecto').findMany({
      filters: { owner: ctx.state.user.id },
    });
    ctx.body = { data: proyectos };
  },

  // El owner nunca se toma del cliente, siempre del usuario autenticado.
  async crear(ctx: Context) {
    const { nombre } = (ctx.request.body ?? {}) as { nombre?: string };
    if (!nombre) return ctx.badRequest('nombre es obligatorio');

    const proyecto = await strapi.documents('api::proyecto.proyecto').create({
      data: { nombre, owner: ctx.state.user.id } as never,
    });
    ctx.body = { data: proyecto };
  },

  // La policy is-owner ya verificó la propiedad y dejó el proyecto en
  // ctx.state.proyecto, sin necesidad de volver a consultarlo.
  async uno(ctx: Context) {
    ctx.body = { data: ctx.state.proyecto };
  },

  async renombrar(ctx: Context) {
    const { nombre } = (ctx.request.body ?? {}) as { nombre?: string };
    if (!nombre) return ctx.badRequest('nombre es obligatorio');

    const proyecto = await strapi.documents('api::proyecto.proyecto').update({
      documentId: ctx.params.id,
      data: { nombre } as never,
    });
    ctx.body = { data: proyecto };
  },

  async eliminar(ctx: Context) {
    // Borra primero los análisis guardados del proyecto: son hijos
    // exclusivos suyos (relación manyToOne), no entidades compartidas
    // como los artículos, así que quedarían huérfanos si no se limpian
    // antes de borrar el proyecto.
    const analisis = await strapi.documents('api::analisis-guardado.analisis-guardado').findMany({
      filters: { proyecto: { documentId: ctx.params.id } } as never,
    });
    for (const item of analisis) {
      await strapi.documents('api::analisis-guardado.analisis-guardado').delete({
        documentId: item.documentId,
      });
    }

    await strapi.documents('api::proyecto.proyecto').delete({ documentId: ctx.params.id });
    ctx.body = { ok: true };
  },

  async listarArticulos(ctx: Context) {
    // status: 'published' es necesario porque `article` tiene
    // draftAndPublish habilitado y los artículos importados solo existen
    // en versión publicada (sin draft); sin indicarlo, el Document
    // Service filtra por defecto por status "draft" al poblar la
    // relación y siempre devuelve un array vacío aunque el enlace exista.
    const proyecto = await strapi.documents('api::proyecto.proyecto').findOne({
      documentId: ctx.params.id,
      status: 'published',
      populate: {
        articles: {
          fields: ['titulo', 'slug', 'texto_plano', 'pagina_inicio', 'pagina_fin'],
          populate: ['issue', 'authors'],
        },
      },
    });
    ctx.body = { data: proyecto?.articles ?? [] };
  },

  // Conecta por id numérico (no documentId): scripts/importar_personas_mencionadas.js
  // documenta que Strapi 5 lanza "Invalid relations" al conectar por documentId
  // en algunos casos.
  async agregarArticulo(ctx: Context) {
    const { articleId } = (ctx.request.body ?? {}) as { articleId?: number };
    if (!articleId) return ctx.badRequest('articleId es obligatorio');

    await strapi.documents('api::proyecto.proyecto').update({
      documentId: ctx.params.id,
      data: { articles: { connect: [{ id: articleId }] } } as never,
    });
    ctx.body = { ok: true };
  },

  async quitarArticulo(ctx: Context) {
    const articleId = Number(ctx.params.articleId);

    await strapi.documents('api::proyecto.proyecto').update({
      documentId: ctx.params.id,
      data: { articles: { disconnect: [{ id: articleId }] } } as never,
    });
    ctx.body = { ok: true };
  },
};
