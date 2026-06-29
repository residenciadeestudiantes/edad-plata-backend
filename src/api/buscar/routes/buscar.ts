export default {
  routes: [
    {
      method: 'GET',
      path: '/buscar/texto',
      handler: 'buscar.texto',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/buscar/semantico',
      handler: 'buscar.semantico',
      config: { auth: false },
    },
  ],
};
