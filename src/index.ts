import { serve } from "@hono/node-server";
import app from "./web";
import { initWhatsApp } from "./whatsapp";
import { startMonitor } from "./monitor";

const PORT = parseInt(process.env.PORT || "3069");

async function main() {
  console.log("[Uptime] Starting...");

  // 1. Init WhatsApp
  try {
    await initWhatsApp();
    console.log("[Uptime] WhatsApp initialized");
  } catch (err) {
    console.error("[Uptime] WhatsApp init error (will retry on reconnect):", err);
  }

  // 2. Start web server
  serve({ fetch: app.fetch, port: PORT }, () => {
    console.log(`[Uptime] Dashboard running at http://localhost:${PORT}`);
  });

  // 3. Start monitor
  await startMonitor();
  console.log("[Uptime] Monitor started");
}

main().catch(console.error);
