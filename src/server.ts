import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config/env.js";
import { logger } from "./logging/logger.js";

const config = loadConfig();
const app = createApp(config);

app.listen(config.port, () => {
  logger.info("Server started", { port: config.port });
});
