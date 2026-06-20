export default {
  routes: [
    {
      method: 'GET',
      path: '/analisis/concordancias',
      handler: 'analisis.concordancias',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/estilometria',
      handler: 'analisis.estilometria',
      config: { auth: false },
    },
    {
      method: 'GET',
      path: '/analisis/innovacion',
      handler: 'analisis.innovacion',
      config: { auth: false },
    },
  ],
};
