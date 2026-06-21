export default {
  routes: [
    {
      method: 'GET',
      path: '/buscar/texto',
      handler: 'buscar.texto',
      config: { auth: false },
    },
  ],
};
