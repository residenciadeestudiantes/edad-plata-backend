export default {
  routes: [
    {
      method: 'POST',
      path: '/cuenta/registro',
      handler: 'cuenta.registro',
      config: { auth: false },
    },
    {
      method: 'PUT',
      path: '/cuenta/me',
      handler: 'cuenta.actualizar',
    },
    {
      method: 'DELETE',
      path: '/cuenta/me',
      handler: 'cuenta.eliminar',
    },
  ],
};
