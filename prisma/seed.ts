import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const websites = [
  { name: "Homepage", url: "https://hanif.app" },
  { name: "Aturuang", url: "https://aturuang.hanif.app" },
  { name: "Bagirata", url: "https://bagirata.hanif.app" },
  { name: "Mangan", url: "https://mangan.hanif.app" },
  { name: "Kana Quiz", url: "https://kana.hanif.app" },
  { name: "Miniboard", url: "https://task.hanif.app" },
  { name: "Pomodo", url: "https://pomodo.hanif.app" },
  { name: "Netflix Forwarder", url: "https://ijin-masuk-netflix.hanif.app" },
  { name: "Uptime Monitor", url: "https://uptime.hanif.app" },
];

async function main() {
  for (const site of websites) {
    const exists = await prisma.website.findFirst({
      where: { url: site.url },
    });
    if (exists) {
      console.log(`[Skip] ${site.name} — already exists`);
      continue;
    }
    await prisma.website.create({
      data: {
        name: site.name,
        url: site.url,
        checkInterval: 60,
        notifyType: "personal",
        notifyTarget: "",
      },
    });
    console.log(`[Added] ${site.name} — ${site.url}`);
  }
  console.log("Seed done!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
