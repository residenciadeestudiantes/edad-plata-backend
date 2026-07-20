const isOwner = 'api::proyecto.is-owner';

export default {
  routes: [
    {
      method: 'GET',
      path: '/proyectos/:id/analisis',
      handler: 'analisis-guardado.listar',
      config: { policies: [isOwner] },
    },
    {
      method: 'POST',
      path: '/proyectos/:id/analisis',
      handler: 'analisis-guardado.guardar',
      config: { policies: [isOwner] },
    },
    {
      method: 'DELETE',
      path: '/proyectos/:id/analisis/:analisisId',
      handler: 'analisis-guardado.eliminar',
      config: { policies: [isOwner] },
    },
  ],
};
