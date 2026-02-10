import { PrismaClient, Website } from "@prisma/client";
import { sendToNumber, sendToGroup } from "./whatsapp";
import { formatDuration } from "./utils";

const prisma = new PrismaClient();

const DEFAULT_DOWN_TEMPLATE =
  "🔴 *{name}* is DOWN\nURL: {url}\nError: {error}\nTime: {time}";
const DEFAULT_UP_TEMPLATE =
  "🟢 *{name}* is back UP\nURL: {url}\nDowntime: {downtime}\nTime: {time}";

async function getSetting(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key } });
  return setting?.value ?? null;
}

function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

async function resolveTemplate(
  websiteTemplate: string | null,
  settingKey: string,
  hardcodedDefault: string
): Promise<string> {
  if (websiteTemplate) return websiteTemplate;
  const settingDefault = await getSetting(settingKey);
  if (settingDefault) return settingDefault;
  return hardcodedDefault;
}

export async function notifyDown(
  website: Website,
  error: string,
  statusCode?: number | null
): Promise<void> {
  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const template = await resolveTemplate(
    website.downTemplate,
    "defaultDownTemplate",
    DEFAULT_DOWN_TEMPLATE
  );

  const msg = renderTemplate(template, {
    name: website.name,
    url: website.url,
    error,
    statusCode: statusCode != null ? String(statusCode) : "",
    time: now,
  });

  await sendNotification(website, msg);
}

export async function notifyUp(
  website: Website,
  downtimeSeconds: number
): Promise<void> {
  const now = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const template = await resolveTemplate(
    website.upTemplate,
    "defaultUpTemplate",
    DEFAULT_UP_TEMPLATE
  );

  const msg = renderTemplate(template, {
    name: website.name,
    url: website.url,
    downtime: formatDuration(downtimeSeconds),
    time: now,
  });

  await sendNotification(website, msg);
}

async function sendNotification(
  website: Website,
  message: string
): Promise<void> {
  try {
    if (website.notifyType === "group" && website.notifyTarget) {
      await sendToGroup(website.notifyTarget, message);
    } else if (website.notifyTarget) {
      await sendToNumber(website.notifyTarget, message);
    }
    console.log(`[Notify] Sent to ${website.notifyType}:${website.notifyTarget}`);
  } catch (err) {
    console.error(`[Notify] Failed for ${website.name}:`, err);
  }
}
