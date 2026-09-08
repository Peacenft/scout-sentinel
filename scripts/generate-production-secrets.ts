import { randomBytes } from "node:crypto";
import { open, chmod } from "node:fs/promises";
import { resolve } from "node:path";

const outputPath = resolve(process.cwd(), ".production-secrets.local");
const contents = [
  `SESSION_PEPPER=${randomBytes(32).toString("base64url")}`,
  `BOOTSTRAP_ADMIN_TOKEN=${randomBytes(32).toString("base64url")}`,
  `BINANCE_TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
  ""
].join("\n");

let file;
try {
  file = await open(outputPath, "wx", 0o600);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    throw new Error(`${outputPath} already exists. Refusing to overwrite production secrets.`);
  }
  throw error;
}

try {
  await file.writeFile(contents, { encoding: "utf8" });
} finally {
  await file.close();
}
await chmod(outputPath, 0o600);
process.stdout.write(`Created ${outputPath} with mode 0600. Secret values were not printed.\n`);
