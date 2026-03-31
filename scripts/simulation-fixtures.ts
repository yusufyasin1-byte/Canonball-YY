import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { UiPathPackage } from "../server/types/uipath-package";

export type SimulationCase = {
  docPath: string;
  outputDir: string;
  version: string;
  cacheKey: string;
  package: UiPathPackage;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CASE_FILE_MAP: Record<string, string> = {
  bgv9: "bgv9.json",
  po_invoice: "po_invoice.json",
  travel: "travel.json",
};

export function getSimulationCase(kind: string): SimulationCase {
  const normalized = (kind || "bgv9").trim().toLowerCase();
  const fileName = CASE_FILE_MAP[normalized] || CASE_FILE_MAP.bgv9;
  const fixturePath = path.join(__dirname, "fixtures", fileName);
  const raw = fs.readFileSync(fixturePath, "utf8");
  return JSON.parse(raw) as SimulationCase;
}
