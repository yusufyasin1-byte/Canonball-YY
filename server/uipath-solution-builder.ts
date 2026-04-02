import AdmZip from "adm-zip";
import { generateConfigXlsx } from "./package-assembler";
import type { BuildResult } from "./package-assembler";
import type { IdeaContext } from "./uipath-pipeline";
import type { UiPathPackage } from "./types/uipath-package";
import type {
  UiPathSolutionArtifact,
  UiPathSolutionComponent,
  UiPathSolutionManifest,
  UiPathSolutionResourceSummary,
} from "./types/uipath-solution";

function sanitizeName(value: string): string {
  return (value || "UiPathSolution")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "UiPathSolution";
}

function summarizeResources(orchestratorArtifacts: any): UiPathSolutionResourceSummary {
  const safeArray = (value: any): any[] => Array.isArray(value) ? value : [];

  return {
    queues: safeArray(orchestratorArtifacts?.queues).map((q: any) => String(q?.name || "").trim()).filter(Boolean),
    assets: safeArray(orchestratorArtifacts?.assets).map((a: any) => String(a?.name || "").trim()).filter(Boolean),
    storageBuckets: safeArray(orchestratorArtifacts?.storageBuckets).map((s: any) => String(s?.name || "").trim()).filter(Boolean),
    actionCatalogs: safeArray(orchestratorArtifacts?.actionCatalogs).map((c: any) => String(c?.name || "").trim()).filter(Boolean),
    processes: safeArray(orchestratorArtifacts?.processes).map((p: any) => String(p?.name || "").trim()).filter(Boolean),
    integrations: safeArray(orchestratorArtifacts?.integrationServiceConnectors).map((c: any) => String(c?.name || c?.system || "").trim()).filter(Boolean),
  };
}

function makeReadme(manifest: UiPathSolutionManifest): string {
  const lines: string[] = [
    `# ${manifest.displayName}`,
    "",
    "This bundle is CannonBall's solution-ready output for UiPath.",
    "",
    "What is inside:",
    `- ` + `One packaged RPA project: ${manifest.sourceProjectName}`,
    "- A solution manifest describing components and shared resources",
    "- Reconstructed project files for Studio/Studio Web import",
    "- Deployment notes for the current supported path",
    "",
    "Current deployment model:",
    "- Package deployment is supported directly by CB2 today.",
    "- Solution deployment should be done through UiPath Studio Web or UiPath CLI/CI-CD.",
    "",
    "Recommended usage:",
    "1. Open or create a UiPath solution in Studio Web.",
    `2. Add the packaged project \`packages/${sanitizeName(manifest.sourceProjectName)}.${manifest.version}.nupkg\` or import the project files from \`projects/${sanitizeName(manifest.sourceProjectName)}/\`.`,
    "3. Provision the shared resources listed in `solution/manifest.json`.",
    "4. Publish/deploy the solution through the UiPath-supported solution flow.",
    "",
    "This bundle is intentionally additive: it preserves the package path while making the output solution-oriented.",
    "",
  ];

  return lines.join("\n");
}

export function buildUiPathSolutionArtifact(params: {
  pkg: UiPathPackage;
  buildResult: BuildResult;
  packageBuffer: Buffer;
  projectName: string;
  dhgContent?: string;
  ctx: IdeaContext;
  version: string;
}): UiPathSolutionArtifact {
  const {
    pkg,
    buildResult,
    packageBuffer,
    projectName,
    dhgContent,
    ctx,
    version,
  } = params;

  const safeProjectName = sanitizeName(projectName);
  const solutionName = sanitizeName(`${projectName}_Solution`);
  const orchestratorArtifacts = pkg.internal?.orchestratorArtifacts || pkg.internal?.extractedArtifacts || {};
  const resources = summarizeResources(orchestratorArtifacts);

  const components: UiPathSolutionComponent[] = [
    {
      type: "rpa_project",
      name: projectName,
      path: `projects/${safeProjectName}`,
      description: pkg.description || `${projectName} automation project`,
      packageFile: `packages/${safeProjectName}.${version}.nupkg`,
    },
    {
      type: "resource_manifest",
      name: "SharedResources",
      path: "solution/manifest.json",
      description: "Queues, assets, storage, and other shared resource definitions extracted from the design",
    },
  ];

  if (ctx.sdd?.content) {
    components.push({
      type: "documentation",
      name: "SDD",
      path: "docs/SDD.md",
      description: "Approved or latest Solution Design Document used during generation",
    });
  }
  if (ctx.pdd?.content) {
    components.push({
      type: "documentation",
      name: "PDD",
      path: "docs/PDD.md",
      description: "Latest Process Design Document used during generation",
    });
  }

  const manifest: UiPathSolutionManifest = {
    schemaVersion: "1.0",
    solutionName,
    displayName: `${projectName} Solution`,
    version,
    generatedAt: new Date().toISOString(),
    sourceProjectName: projectName,
    automationType: pkg.internal?.automationType || "rpa",
    deliveryMode: "solution_bundle",
    deploymentSupport: {
      packageDeploySupported: true,
      solutionDeploySupported: "manual_or_cli",
      notes: [
        "The underlying RPA package is included and remains deployable through the existing Orchestrator package flow.",
        "Native UiPath solution deployment should use UiPath Studio Web or UiPath CLI/CI-CD.",
      ],
    },
    components,
    resources,
  };

  const zip = new AdmZip();
  zip.addFile("solution/manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  zip.addFile("README.md", Buffer.from(makeReadme(manifest), "utf8"));
  zip.addFile(`packages/${safeProjectName}.${version}.nupkg`, packageBuffer);

  for (const entry of buildResult.xamlEntries) {
    const fileName = entry.name.split("/").pop() || entry.name;
    zip.addFile(`projects/${safeProjectName}/${fileName}`, Buffer.from(entry.content, "utf8"));
  }

  if (buildResult.projectJsonContent) {
    zip.addFile(`projects/${safeProjectName}/project.json`, Buffer.from(buildResult.projectJsonContent, "utf8"));
  }

  const sddContent = ctx.sdd?.content || "";
  const configContent = generateConfigXlsx(projectName, sddContent, orchestratorArtifacts);
  zip.addFile(`projects/${safeProjectName}/Data/Config.xlsx`, Buffer.from(configContent, "utf8"));

  if (dhgContent) {
    zip.addFile(`projects/${safeProjectName}/DeveloperHandoffGuide.md`, Buffer.from(dhgContent, "utf8"));
  }
  if (ctx.sdd?.content) {
    zip.addFile("docs/SDD.md", Buffer.from(ctx.sdd.content, "utf8"));
  }
  if (ctx.pdd?.content) {
    zip.addFile("docs/PDD.md", Buffer.from(ctx.pdd.content, "utf8"));
  }

  return {
    fileName: `${solutionName}.${version}.zip`,
    buffer: zip.toBuffer(),
    manifest,
    components,
  };
}
