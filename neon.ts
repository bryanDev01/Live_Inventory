import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  // Neon Auth injects NEON_AUTH_BASE_URL and NEON_AUTH_JWKS_URL into every Function on this branch,
  // so api.ts reads them without declaring them here (Neon Functions authentication docs).
  preview: {
    realtime: true,
  },
  auth: true,
  aiGateway: true,
  functions: {
    hello: {
      name: "Service health checks",
      source: "./hello.ts",
      env: {
        ORIGIN_SECRET: { value: process.env.ORIGIN_SECRET, required: true },
        REALTIME_URL: { value: process.env.NEON_REALTIME_URL, required: true },
        REALTIME_SECRET: { value: process.env.NEON_REALTIME_SECRET, required: true },
      },
    },
    api: {
      name: "Inventory API",
      source: "./main-api.ts",
      env: {
        APP_ORIGIN: { value: process.env.APP_ORIGIN, required: true },
        ALLOWED_CURRENCIES: { value: process.env.ALLOWED_CURRENCIES, required: true },
        IMPORT_MAX_MB: { value: process.env.IMPORT_MAX_MB, required: true },
        IMPORT_MAX_ROWS: { value: process.env.IMPORT_MAX_ROWS, required: true },
        IMPORT_MAX_UNCOMPRESSED_MB: { value: process.env.IMPORT_MAX_UNCOMPRESSED_MB, required: true },
        VAPID_PUBLIC_KEY: { value: process.env.VAPID_PUBLIC_KEY, required: true },
        VAPID_PRIVATE_KEY: { value: process.env.VAPID_PRIVATE_KEY, required: true },
        VAPID_SUBJECT: { value: process.env.VAPID_SUBJECT, required: true },
      },
    },
  },
});
