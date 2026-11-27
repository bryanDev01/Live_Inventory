import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
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
      source: "./api.ts",
      env: {
        APP_ORIGIN: { value: process.env.APP_ORIGIN, required: true },
        ALLOWED_CURRENCIES: { value: process.env.ALLOWED_CURRENCIES, required: true },
      },
    },
  },
});
