// Copied beside the compiled schema by build-runtime-env.mjs. Production only.
// Preloaded before Next: failure exits without opening a listener or any client.
const { validateProductionEnv, ProductionEnvError } = require("./envSchema.cjs");
process.env.NODE_ENV ??= "production";
process.env.PORT ??= "8080";
try {
  validateProductionEnv(process.env);
} catch (error) {
  console.error(error instanceof ProductionEnvError ? error.message : "Invalid production environment. See docs/radlearn/ENV_SCHEMA.md.");
  process.exit(1);
}
