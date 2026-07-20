const isOwner = 'api::proyecto.is-owner';

export default {
  routes: [
    { method: 'GET', path: '/proyectos', handler: 'proyecto.misProyectos' },
    { method: 'POST', path: '/proyectos', handler: 'proyecto.crear' },
    {
      method: 'GET',
      path: '/proyectos/:id',
      handler: 'proyecto.uno',
      config: { policies: [isOwner] },
    },
    {
      method: 'PUT',
      path: '/proyectos/:id',
      handler: 'proyecto.renombrar',
      config: { policies: [isOwner] },
    },
    {
      method: 'DELETE',
      path: '/proyectos/:id',
      handler: 'proyecto.eliminar',
      config: { policies: [isOwner] },
    },
    {
      method: 'GET',
      path: '/proyectos/:id/articulos',
      handler: 'proyecto.listarArticulos',
      config: { policies: [isOwner] },
    },
    {
      method: 'POST',
      path: '/proyectos/:id/articulos',
      handler: 'proyecto.agregarArticulo',
      config: { policies: [isOwner] },
    },
    {
      method: 'DELETE',
      path: '/proyectos/:id/articulos/:articleId',
      handler: 'proyecto.quitarArticulo',
      config: { policies: [isOwner] },
    },
  ],
};
