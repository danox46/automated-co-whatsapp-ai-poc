import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { generateKeyPairSync } from "node:crypto";

const testSigningPair = generateKeyPairSync("rsa", { modulusLength: 2048 });

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.mcp.jsonc" },
      miniflare: {
        bindings: {
          META_APP_ID: "test-app-id",
          META_APP_SECRET: "test-app-secret",
          META_EMBEDDED_SIGNUP_CONFIG_ID: "test-config-id",
          META_WEBHOOK_VERIFY_TOKEN: "test-webhook-token",
          CONVERSATION_REF_SECRET: "test-conversation-reference-secret",
          INSTALLATION_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
          PILOT_ADMIN_TOKEN: "test-pilot-admin-token",
          PUBLIC_ORIGIN: "https://pilot.test",
          OAUTH_SIGNING_KEY_ID: "test-oauth-key",
          OAUTH_SIGNING_PRIVATE_JWK: JSON.stringify(testSigningPair.privateKey.export({ format: "jwk" })),
          OAUTH_SIGNING_PUBLIC_JWK: JSON.stringify(testSigningPair.publicKey.export({ format: "jwk" }))
        }
      }
    })
  ],
  test: {
    include: ["test-workers/**/*.test.ts"]
  }
});
