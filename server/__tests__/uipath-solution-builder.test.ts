import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { buildUiPathSolutionArtifact } from "../uipath-solution-builder";
import type { BuildResult } from "../package-assembler";
import type { UiPathPackage } from "../types/uipath-package";

describe("UiPath solution builder", () => {
  it("builds a solution-ready bundle around the generated package", () => {
    const pkg: UiPathPackage = {
      projectName: "InvoiceAutomation",
      description: "Invoice processing automation",
      dependencies: ["UiPath.System.Activities"],
      workflows: [
        {
          name: "Main",
          description: "Main workflow",
          variables: [],
          steps: [],
        },
      ],
      internal: {
        automationType: "hybrid",
        orchestratorArtifacts: {
          queues: [{ name: "InvoiceQueue" }],
          assets: [{ name: "Asset.ApiKey" }],
          storageBuckets: [{ name: "Invoices" }],
        },
      },
    };

    const buildResult: BuildResult = {
      buffer: Buffer.from("fake-nupkg"),
      gaps: [],
      usedPackages: ["UiPath.System.Activities"],
      xamlEntries: [
        { name: "Main.xaml", content: "<Activity><Sequence /></Activity>" },
      ],
      dependencyMap: { "UiPath.System.Activities": "[25.10.0]" },
      archiveManifest: ["lib/net45/Main.xaml", "lib/net45/project.json"],
      usedFallbackStubs: false,
      generationMode: "full_implementation",
      referencedMLSkillNames: [],
      usedAIFallback: false,
      projectJsonContent: JSON.stringify({ name: "InvoiceAutomation", main: "Main.xaml" }, null, 2),
    };

    const artifact = buildUiPathSolutionArtifact({
      pkg,
      buildResult,
      packageBuffer: Buffer.from("fake-nupkg"),
      projectName: "InvoiceAutomation",
      dhgContent: "# DHG",
      ctx: {
        idea: { title: "Invoice Automation" } as any,
        sdd: { content: "# SDD" } as any,
        pdd: { content: "# PDD" } as any,
        mapNodes: [],
        processEdges: [],
      },
      version: "1.0.20260402",
    });

    expect(artifact.fileName).toContain("InvoiceAutomation_Solution");
    expect(artifact.manifest.automationType).toBe("hybrid");
    expect(artifact.manifest.resources.queues).toEqual(["InvoiceQueue"]);
    expect(artifact.manifest.resources.assets).toEqual(["Asset.ApiKey"]);

    const zip = new AdmZip(artifact.buffer);
    const entryNames = zip.getEntries().map(entry => entry.entryName);

    expect(entryNames).toContain("solution/manifest.json");
    expect(entryNames).toContain("README.md");
    expect(entryNames).toContain("projects/InvoiceAutomation/Main.xaml");
    expect(entryNames).toContain("projects/InvoiceAutomation/project.json");
    expect(entryNames).toContain("projects/InvoiceAutomation/DeveloperHandoffGuide.md");
    expect(entryNames).toContain("docs/SDD.md");
    expect(entryNames).toContain("docs/PDD.md");
    expect(entryNames.some(name => name.startsWith("packages/InvoiceAutomation.1.0.20260402") && name.endsWith(".nupkg"))).toBe(true);
  });
});
