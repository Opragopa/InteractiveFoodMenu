import { hash } from "@node-rs/argon2";
import { ID, Query } from "node-appwrite";
import { createServices } from "./appwrite.js";
import { loadConfig } from "./config.js";

async function hiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Run this command in an interactive terminal.");
  process.stdout.write("Пароль первого оператора: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        const chars = chunk.toString("utf8");
        if (chars === "\r" || chars === "\n") { process.stdin.off("data", onData); resolve(); return; }
        if (chars === "\u0003") { process.stdin.off("data", onData); reject(new Error("Cancelled.")); return; }
        if (chars === "\u007f" || chars === "\b") { value = value.slice(0, -1); return; }
        if (!/[\x00-\x1f]/.test(chars)) value += chars;
      };
      process.stdin.on("data", onData);
    });
  } finally { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\n"); }
  return value;
}

const username = String(process.argv[2] ?? "").trim().toLowerCase();
if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username)) throw new Error("Specify a username of 3–40 Latin characters, digits, dots, dashes or underscores.");
const config = loadConfig();
const services = await createServices(config);
const existing = await services.tables.listRows({ databaseId: config.appwriteDatabaseId, tableId: "operators", queries: [Query.limit(1)] });
if (existing.rows.length) throw new Error("An operator already exists; the first-operator command is disabled.");
const password = await hiddenPassword();
if (password.length < 12 || password.length > 128 || Buffer.byteLength(password) > 256) throw new Error("Password must contain 12–128 characters.");
await services.tables.createRow({ databaseId: config.appwriteDatabaseId, tableId: "operators", rowId: ID.unique(),
  data: { username, passwordHash: await hash(password), active: true, sessionVersion: 1, createdAt: new Date().toISOString() } });
process.stdout.write(`Оператор ${username} создан.\n`);

await services.close?.();
