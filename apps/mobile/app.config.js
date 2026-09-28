export default ({ config }) =>
  process.env.APP_VARIANT === "development"
    ? {
        ...config,
        name: "OpenMuse Dev",
        scheme: "openmuse-dev",
        android: { ...config.android, package: "app.openmuse.mobile.dev" },
      }
    : config;
