import { PrismaClient } from "@prisma/client";
import { notifyDown, notifyUp } from "./notify";

const prisma = new PrismaClient();

const timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export async function startMonitor(): Promise<void> {
  stopMonitor();
  const websites = await prisma.website.findMany({ where: { isActive: true } });

  if (websites.length === 0) {
    console.log("[Monitor] No active websites to monitor");
    return;
  }

  // Staggered start: spread initial checks across the minimum interval
  const minInterval = Math.min(...websites.map((w) => w.checkInterval));
  const delayBetween = (minInterval * 1000) / websites.length;

  websites.forEach((website, index) => {
    const initialDelay = Math.floor(index * delayBetween);
    const timer = setTimeout(() => scheduleCheck(website.id), initialDelay);
    timers.set(`init-${website.id}`, timer);
  });

  console.log(
    `[Monitor] Started monitoring ${websites.length} websites (staggered over ${minInterval}s)`
  );

  // Daily cleanup: delete checks older than 90 days
  cleanupTimer = setInterval(() => cleanupOldChecks(), 24 * 60 * 60 * 1000);
}

export function stopMonitor(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  console.log("[Monitor] Stopped");
}

async function scheduleCheck(websiteId: string): Promise<void> {
  // Re-fetch config every cycle so edits take effect immediately
  const website = await prisma.website.findUnique({ where: { id: websiteId } });
  if (!website || !website.isActive) {
    timers.delete(websiteId);
    return;
  }

  await performCheck(website.id);

  // Schedule next check
  const timer = setTimeout(
    () => scheduleCheck(websiteId),
    website.checkInterval * 1000
  );
  timers.set(websiteId, timer);
}

async function performCheck(websiteId: string): Promise<void> {
  const website = await prisma.website.findUnique({ where: { id: websiteId } });
  if (!website) return;

  let status: "up" | "down" = "down";
  let statusCode: number | null = null;
  let responseTime = 0;
  let errorMessage: string | null = null;

  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(website.url, {
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
    errorMessage = err.name === "AbortError" ? "Timeout (15s)" : err.message;
    status = "down";
  }

  // Save check record
  await prisma.check.create({
    data: { websiteId, status, statusCode, responseTime, errorMessage },
  });

  const previousStatus = website.lastStatus;

  // Update website status
  await prisma.website.update({
    where: { id: websiteId },
    data: {
      lastStatus: status,
      lastCheckedAt: new Date(),
      lastResponseMs: responseTime,
    },
  });

  // State change detection
  if (previousStatus === "up" && status === "down") {
    // UP → DOWN: create incident + notify
    console.log(`[Monitor] ${website.name} went DOWN: ${errorMessage}`);
    const incident = await prisma.incident.create({
      data: { websiteId, downNotified: true },
    });
    const fresh = await prisma.website.findUnique({ where: { id: websiteId } });
    if (fresh) await notifyDown(fresh, errorMessage || "Unknown error", statusCode);
  } else if (previousStatus === "down" && status === "up") {
    // DOWN → UP: resolve incident + notify
    console.log(`[Monitor] ${website.name} is back UP`);
    const openIncident = await prisma.incident.findFirst({
      where: { websiteId, resolvedAt: null },
      orderBy: { startedAt: "desc" },
    });
    if (openIncident) {
      const duration = Math.floor(
        (Date.now() - openIncident.startedAt.getTime()) / 1000
      );
      await prisma.incident.update({
        where: { id: openIncident.id },
        data: { resolvedAt: new Date(), duration, upNotified: true },
      });
      const fresh = await prisma.website.findUnique({
        where: { id: websiteId },
      });
      if (fresh) await notifyUp(fresh, duration);
    }
  }
}

async function cleanupOldChecks(): Promise<void> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const result = await prisma.check.deleteMany({
    where: { checkedAt: { lt: cutoff } },
  });
  if (result.count > 0) {
    console.log(`[Monitor] Cleaned up ${result.count} old checks`);
  }
}
