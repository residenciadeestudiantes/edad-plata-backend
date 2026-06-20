module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/archivo/contexto',
      handler: 'archivo.contexto',
      config: { auth: false },
    },
  ],
};
