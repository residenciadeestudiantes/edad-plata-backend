export default {
  routes: [
    {
      method: 'GET',
      path: '/analisis/concordancias',
      handler: 'analisis.concordancias',
      config: { auth: false },
    },
  ],
};
