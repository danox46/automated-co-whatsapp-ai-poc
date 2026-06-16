import "dotenv/config";
import { loadConfig, validateRuntimeConfig } from "../config/env.js";

const config = loadConfig();
const result = validateRuntimeConfig(config);

if (!result.ok) {
  console.error(`Missing required runtime env vars: ${result.missing.join(", ")}`);
  process.exit(1);
}

console.log("Runtime env check passed.");
