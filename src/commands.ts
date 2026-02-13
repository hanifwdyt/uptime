import { PrismaClient } from "@prisma/client";
import { startMonitor } from "./monitor";

const prisma = new PrismaClient();

interface ScopeFilter {
  notifyType: string;
  notifyTarget: string;
}

export async function handleCommand(
  text: string,
  scope: ScopeFilter
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return "";

  const [cmd, ...args] = trimmed.split(/\s+/);
  const arg = args.join(" ");

  switch (cmd.toLowerCase()) {
    case "/help":
      return helpText();
    case "/status":
      return statusCmd(scope);
    case "/list":
      return listCmd(scope);
    case "/on":
      return toggleCmd(scope, arg, true);
    case "/off":
      return toggleCmd(scope, arg, false);
    case "/check":
      return checkCmd(scope, arg);
    case "/whoami":
      return whoamiCmd(scope);
    default:
      return `Unknown command: ${cmd}\nType /help for available commands.`;
  }
}

function helpText(): string {
  return [
    "*Uptime Monitor Bot*",
    "",
    "/help — Show this help",
    "/status — Summary of your monitored sites",
    "/list — List all your websites with status",
    "/on <domain> — Resume monitoring",
    "/off <domain> — Pause monitoring",
    "/check <domain> — Force an immediate check",
  ].join("\n");
}

async function statusCmd(scope: ScopeFilter): Promise<string> {
  const sites = await prisma.website.findMany({ where: scope });

  if (sites.length === 0) {
    return "No websites assigned to this chat.";
  }

  const up = sites.filter((s) => s.lastStatus === "up").length;
  const down = sites.filter((s) => s.lastStatus === "down").length;
  const paused = sites.filter((s) => !s.isActive).length;
  const total = sites.length;

  return [
    `*Status Summary* (${total} sites)`,
    `🟢 Up: ${up}`,
    `🔴 Down: ${down}`,
    `⏸ Paused: ${paused}`,
  ].join("\n");
}

async function listCmd(scope: ScopeFilter): Promise<string> {
  const sites = await prisma.website.findMany({
    where: scope,
    orderBy: { name: "asc" },
  });

  if (sites.length === 0) {
    return "No websites assigned to this chat.";
  }

  const lines = sites.map((s) => {
    const icon = !s.isActive
      ? "⏸"
      : s.lastStatus === "up"
        ? "🟢"
        : s.lastStatus === "down"
          ? "🔴"
          : "⚪";
    const ms = s.lastResponseMs != null ? ` (${s.lastResponseMs}ms)` : "";
    return `${icon} *${s.name}*\n   ${s.url}${ms}`;
  });

  return lines.join("\n\n");
}

async function toggleCmd(
  scope: ScopeFilter,
  domain: string,
  active: boolean
): Promise<string> {
  if (!domain) {
    return `Usage: /${active ? "on" : "off"} <domain>\nExample: /${active ? "on" : "off"} example.com`;
  }

  const matches = await prisma.website.findMany({
    where: { ...scope, url: { contains: domain } },
  });

  if (matches.length === 0) {
    return `No website found matching "${domain}" in this chat.`;
  }

  if (matches.length > 1) {
    const list = matches.map((m) => `• ${m.name} — ${m.url}`).join("\n");
    return `Multiple matches found. Be more specific:\n${list}`;
  }

  const site = matches[0];

  if (site.isActive === active) {
    return `*${site.name}* is already ${active ? "active" : "paused"}.`;
  }

  await prisma.website.update({
    where: { id: site.id },
    data: { isActive: active },
  });

  await startMonitor();

  return `${active ? "▶️" : "⏸"} *${site.name}* monitoring ${active ? "resumed" : "paused"}.`;
}

async function checkCmd(scope: ScopeFilter, domain: string): Promise<string> {
  if (!domain) {
    return "Usage: /check <domain>\nExample: /check example.com";
  }

  const matches = await prisma.website.findMany({
    where: { ...scope, url: { contains: domain } },
  });

  if (matches.length === 0) {
    return `No website found matching "${domain}" in this chat.`;
  }

  if (matches.length > 1) {
    const list = matches.map((m) => `• ${m.name} — ${m.url}`).join("\n");
    return `Multiple matches found. Be more specific:\n${list}`;
  }

  const site = matches[0];

  // Perform a live check
  let status = "down";
  let statusCode: number | null = null;
  let responseTime = 0;
  let errorMessage: string | null = null;

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(site.url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "UptimeMonitor/1.0" },
    });

    clearTimeout(timeout);
    responseTime = Date.now() - startTime;
    statusCode = res.status;
    status = res.status < 400 ? "up" : "down";

    if (status === "down") {
      errorMessage = `HTTP ${res.status}`;
    }
  } catch (err: any) {
    responseTime = Date.now() - startTime;
    errorMessage =
      err.name === "AbortError" ? "Timeout (15s)" : err.message;
  }

  const icon = status === "up" ? "🟢" : "🔴";

  const lines = [
    `${icon} *${site.name}*`,
    `URL: ${site.url}`,
    `Status: ${status.toUpperCase()}`,
    `Response: ${responseTime}ms`,
  ];

  if (statusCode) lines.push(`HTTP: ${statusCode}`);
  if (errorMessage) lines.push(`Error: ${errorMessage}`);

  return lines.join("\n");
}

async function whoamiCmd(scope: ScopeFilter): Promise<string> {
  const sites = await prisma.website.findMany({ where: scope });
  const allSites = await prisma.website.findMany({
    select: { name: true, notifyType: true, notifyTarget: true },
  });

  return [
    "*Debug Info*",
    `Your type: ${scope.notifyType}`,
    `Your target: "${scope.notifyTarget}"`,
    `Matched sites: ${sites.length}`,
    "",
    "*All sites in DB:*",
    ...allSites.map(
      (s) => `• ${s.name} → type="${s.notifyType}" target="${s.notifyTarget}"`
    ),
  ].join("\n");
}
