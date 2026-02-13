import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as QRCode from "qrcode";
import * as path from "path";
import * as fs from "fs";
import { handleCommand } from "./commands";

type WAState = "disconnected" | "qr_ready" | "connecting" | "connected";

let sock: WASocket | null = null;
let currentQR: string | null = null;
let state: WAState = "disconnected";
let connectedNumber: string | null = null;
let shouldReconnect = true;

const AUTH_DIR = path.resolve("./data/baileys-auth");

function ensureAuthDir() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

export async function initWhatsApp(): Promise<void> {
  ensureAuthDir();
  shouldReconnect = true;
  await connectWA();
}

async function connectWA(): Promise<void> {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: authState,
    printQRInTerminal: false,
    browser: ["Uptime Monitor", "Chrome", "1.0.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        state = "qr_ready";
        console.log("[WA] QR code ready — scan from dashboard");
      } catch (err) {
        console.error("[WA] QR generation error:", err);
      }
    }

    if (connection === "connecting") {
      state = "connecting";
      currentQR = null;
      console.log("[WA] Connecting...");
    }

    if (connection === "close") {
      currentQR = null;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log("[WA] Logged out — clearing session");
        state = "disconnected";
        connectedNumber = null;
        // Clear auth files so fresh QR is generated on reconnect
        if (fs.existsSync(AUTH_DIR)) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
      } else if (shouldReconnect) {
        console.log(
          `[WA] Connection closed (code: ${statusCode}), reconnecting...`
        );
        state = "disconnected";
        setTimeout(() => connectWA(), 3000);
      } else {
        state = "disconnected";
        connectedNumber = null;
        console.log("[WA] Disconnected (manual)");
      }
    }

    if (connection === "open") {
      state = "connected";
      currentQR = null;
      connectedNumber = sock?.user?.id?.split(":")[0] || null;
      console.log(`[WA] Connected as ${connectedNumber}`);
    }
  });

  // Bot command listener
  sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
    if (type !== "notify") return;

    for (const msg of msgs) {
      if (!msg.message || msg.key.fromMe) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";
      if (!text.startsWith("/")) continue;

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid) continue;

      // Determine scope based on sender context
      let scope: { notifyType: string; notifyTarget: string };

      if (remoteJid.endsWith("@g.us")) {
        // Group message — scope by group JID
        scope = { notifyType: "group", notifyTarget: remoteJid };
      } else {
        // Personal message — scope by phone number
        // Strip device suffix (:XX) and @s.whatsapp.net
        const phone = remoteJid.split("@")[0].split(":")[0];
        scope = { notifyType: "personal", notifyTarget: phone };
      }

      console.log(`[WA] Command: "${text}" from ${scope.notifyType}:${scope.notifyTarget}`);

      try {
        const reply = await handleCommand(text, scope);
        if (reply && sock) {
          await sock.sendMessage(remoteJid, { text: reply });
        }
      } catch (err) {
        console.error("[WA] Command error:", err);
        if (sock) {
          await sock.sendMessage(remoteJid, {
            text: "Error processing command. Try again later.",
          });
        }
      }
    }
  });
}

export function getQR(): string | null {
  return state === "qr_ready" ? currentQR : null;
}

export function getStatus(): { state: WAState; number: string | null } {
  return { state, number: connectedNumber };
}

export async function sendToNumber(
  phone: string,
  message: string
): Promise<void> {
  if (!sock || state !== "connected") {
    console.error("[WA] Cannot send — not connected");
    return;
  }
  const jid = `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text: message });
}

export async function sendToGroup(
  groupId: string,
  message: string
): Promise<void> {
  if (!sock || state !== "connected") {
    console.error("[WA] Cannot send — not connected");
    return;
  }
  await sock.sendMessage(groupId, { text: message });
}

export async function listGroups(): Promise<
  { id: string; subject: string }[]
> {
  if (!sock || state !== "connected") return [];
  try {
    const groups = await sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      id: g.id,
      subject: g.subject,
    }));
  } catch (err) {
    console.error("[WA] Failed to list groups:", err);
    return [];
  }
}

export async function disconnect(): Promise<void> {
  shouldReconnect = false;
  if (sock) {
    await sock.logout().catch(() => {});
    sock = null;
  }
  state = "disconnected";
  connectedNumber = null;
  currentQR = null;
  // Clear auth files
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
}

export async function reconnect(): Promise<void> {
  shouldReconnect = true;
  if (sock) {
    sock.end(undefined);
    sock = null;
  }
  state = "disconnected";
  connectedNumber = null;
  currentQR = null;
  // Clear auth for fresh QR
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  await connectWA();
}
