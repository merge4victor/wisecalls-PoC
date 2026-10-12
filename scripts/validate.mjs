import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "infrastructure/template.yaml",
  "infrastructure/parameters.example.json",
  "functions/customer-context/index.js",
  "functions/product-rates/index.js",
  "functions/atm-locator/index.js",
  "functions/cases-context/index.js",
  "functions/message-processor/index.js",
  "functions/location-session/index.js",
  "functions/get-next-open-slot/index.js",
  "functions/book-callback-slot/index.js",
  "functions/callback-poller/index.js",
  "functions/record-callback-outcome/index.js",
  "frontend/index.html",
  "frontend/styles.css",
  "frontend/app.js",
  "frontend/config.js",
  "frontend/assets/wisecalls_logo.jpg",
  "scripts/deploy-frontend.ps1",
  "docs/03-deployment-runbook.md",
  "docs/04-connect-configuration.md",
  "docs/07-test-and-acceptance.md",
  "docs/09-mobile-location.md",
  "docs/10-location-frontend.md"
];

const missing = required.filter((path) => !existsSync(join(root, path)));
if (missing.length) throw new Error(`Missing required files:\n${missing.join("\n")}`);

JSON.parse(readFileSync(join(root, "infrastructure/parameters.example.json"), "utf8"));
JSON.parse(readFileSync(join(root, "config/seed-data.json"), "utf8"));
JSON.parse(readFileSync(join(root, "config/tool-schemas.json"), "utf8"));
const localCustomerData = join(root, "config/customer-data.local.json");
if (existsSync(localCustomerData)) JSON.parse(readFileSync(localCustomerData, "utf8"));

for (const path of required.filter((value) => value.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", join(root, path)], { stdio: "inherit" });
}
execFileSync(process.execPath, ["--test", join(root, "tests/functions.test.js")], { stdio: "inherit" });

const template = readFileSync(join(root, "infrastructure/template.yaml"), "utf8");
for (const marker of ["ConnectInstanceArn:", "CustomerUserPool:", "CoreDataTable:", "KnowledgeAssistant:", "LocationFrontendDistribution:", "AgentUserPool:", "RedactionDemoTeardownFunction:", "CallbackAllowedPhonePrefixes:"]) {
  if (!template.includes(marker)) throw new Error(`Template marker missing: ${marker}`);
}
const frontend = readFileSync(join(root, "frontend/app.js"), "utf8");
for (const marker of ["servicePhoneNumbers", "tel:", "shareLocation", "window.location.assign(phoneUrl(callNumber))"]) {
  if (!frontend.includes(marker)) throw new Error(`Frontend call marker missing: ${marker}`);
}
console.log("Local validation passed.");
