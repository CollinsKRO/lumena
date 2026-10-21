module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    lumenServerUrl: process.env.EXPO_PUBLIC_LUMEN_SERVER_URL,
    lumenCosignerPublicKey: process.env.EXPO_PUBLIC_LUMEN_COSIGNER_PUBLIC_KEY,
  },
});
