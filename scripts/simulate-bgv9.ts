import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import AdmZip from "adm-zip";
import { buildNuGetPackage } from "../server/package-assembler";
import { selectGenerationMode } from "../server/xaml-generator";
import { catalogService } from "../server/catalog/catalog-service";
import { getSimulationCase } from "./simulation-fixtures";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

const GENERATED_FILE_NAMES = new Set([
  "summary.json",
  "sdd-extracted.txt",
  "project.json",
  "archive-manifest.txt",
  "dependency-map.json",
  "quality-gate.json",
  "build-result-meta.json",
  "DeveloperHandoffGuide.md",
  "entry-points.json",
]);

function resetDir(dir: string) {
  ensureDir(dir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const shouldDelete =
      lower.endsWith(".xaml") ||
      lower.endsWith(".nupkg") ||
      GENERATED_FILE_NAMES.has(entry.name);
    if (!shouldDelete) continue;
    try {
      fs.rmSync(path.join(dir, entry.name), { force: true });
    } catch {
      // Leave locked files alone; the rerun will still refresh everything else.
    }
  }
}

async function extractDocText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

async function main() {
  const selectorPath = "C:/Users/yusuf.yasin/Downloads/CannonBall/CB2_git/scripts/simulation_case.txt";
  const selectedFromFile = fs.existsSync(selectorPath)
    ? fs.readFileSync(selectorPath, "utf8").trim().toLowerCase()
    : "";
  const kind = (selectedFromFile || process.env.SIM_CASE || "bgv9").trim().toLowerCase();
  const sim = getSimulationCase(kind);
  resetDir(sim.outputDir);

  const sddContent = await extractDocText(sim.docPath);
  sim.package.internal = {
    ...sim.package.internal,
    sddContent,
  };

  const selectedMode = selectGenerationMode("hybrid", 0.92, catalogService.getStudioProfile());
  const result = await buildNuGetPackage(sim.package, sim.version, sim.cacheKey, selectedMode.mode);

  const summary = {
    case: kind,
    selectedMode: selectedMode.mode,
    selectedModeReason: selectedMode.reason,
    generationMode: result.generationMode,
    usedFallbackStubs: result.usedFallbackStubs,
    cacheHit: result.cacheHit ?? false,
    usedPackages: result.usedPackages,
    dependencyMap: result.dependencyMap,
    archiveManifestCount: result.archiveManifest.length,
    xamlFiles: result.xamlEntries.map(e => e.name),
    qualityGatePassed: result.qualityGateResult?.passed ?? null,
    qualityViolationCount: result.qualityGateResult?.violations?.length ?? 0,
    topViolations: (result.qualityGateResult?.violations ?? []).slice(0, 25),
  };

  fs.writeFileSync(path.join(sim.outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(path.join(sim.outputDir, "sdd-extracted.txt"), sddContent, "utf8");
  for (const entry of result.xamlEntries) {
    fs.writeFileSync(path.join(sim.outputDir, entry.name), entry.content, "utf8");
  }
  if (result.projectJsonContent) {
    fs.writeFileSync(path.join(sim.outputDir, "project.json"), result.projectJsonContent, "utf8");
  }

  const nupkgName = `${sim.package.projectName}.${sim.version}.nupkg`;
  fs.writeFileSync(path.join(sim.outputDir, nupkgName), result.buffer);

  try {
    const zip = new AdmZip(result.buffer);
    const dhgEntry = zip.getEntries().find(e => /DeveloperHandoffGuide\.md$/i.test(e.entryName));
    if (dhgEntry) {
      fs.writeFileSync(path.join(sim.outputDir, "DeveloperHandoffGuide.md"), dhgEntry.getData());
    }
  } catch (err) {
    console.warn(`Unable to extract DeveloperHandoffGuide.md from generated package: ${err instanceof Error ? err.message : String(err)}`);
  }

  fs.writeFileSync(path.join(sim.outputDir, "archive-manifest.txt"), result.archiveManifest.join("\n"), "utf8");
  fs.writeFileSync(path.join(sim.outputDir, "dependency-map.json"), JSON.stringify(result.dependencyMap, null, 2), "utf8");
  if (result.qualityGateResult) {
    fs.writeFileSync(path.join(sim.outputDir, "quality-gate.json"), JSON.stringify(result.qualityGateResult, null, 2), "utf8");
  }
  fs.writeFileSync(path.join(sim.outputDir, "build-result-meta.json"), JSON.stringify({
    gaps: result.gaps,
    referencedMLSkillNames: result.referencedMLSkillNames,
    usedAIFallback: result.usedAIFallback,
  }, null, 2), "utf8");

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
