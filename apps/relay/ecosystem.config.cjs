module.exports = {
  apps: [
    {
      name: "peerkit-relay",
      script: "dist/index.js",
      env: {
        RELAY_HOST: "0.0.0.0",
        RELAY_PORT: "9000",
      },
    },
  ],
};
