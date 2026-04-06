import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { buildUiPathSolutionArtifact } from "../uipath-solution-builder";
import type { BuildResult } from "../package-assembler";
import type { UiPathPackage } from "../types/uipath-package";
import type { UiPathDeliveryRecommendation } from "../types/uipath-solution";

describe("UiPath solution builder", () => {
  it("builds a native .uis solution export around the generated project", () => {
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
          assets: [{ name: "Asset.ApiKey", type: "Text", value: "abc123" }],
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

    const deliveryRecommendation: UiPathDeliveryRecommendation = {
      recommendedOutput: "solution",
      recommendedModality: "app_fronted_process",
      recommendedExecutionModel: "hybrid",
      recommendedProducts: ["Orchestrator", "Apps", "Queues"],
      connectorRecommendations: [
        {
          connectorName: "Microsoft 365",
          sourceSystems: ["Outlook", "SharePoint"],
          rationale: "Use the Microsoft 365 connector family for mail and document interactions.",
          usedActions: ["Send email", "Upload file"],
        },
      ],
      rationale: ["Multiple shared resources were found."],
      signals: {
        automationType: "hybrid",
        workflowCount: 1,
        queueCount: 1,
        assetCount: 1,
        storageBucketCount: 1,
        actionCatalogCount: 0,
        integrationCount: 0,
        sharedResourceCount: 3,
        uiInteractionSignalCount: 0,
        assistantSignalCount: 0,
        appSignalCount: 2,
        apiSignalCount: 0,
        humanInLoopSignalCount: 1,
        triggerCount: 0,
        appCount: 0,
        dataFabricEntityCount: 0,
      },
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
        dsd: { content: "# DSD" } as any,
        mapNodes: [],
        processEdges: [],
      },
      version: "1.0.20260402",
      deliveryRecommendation,
      testCases: [
        {
          name: "TC001 - Happy path",
          description: "Validates invoice happy path",
          steps: [
            { action: "Submit invoice", expected: "Queue item created" },
          ],
        },
      ],
      testSets: [
        {
          name: "Smoke",
          description: "Core validation",
          testCaseNames: ["TC001 - Happy path"],
        },
      ],
    });

    expect(artifact.fileName).toContain("InvoiceAutomation_Solution");
    expect(artifact.fileName.endsWith(".uis")).toBe(true);
    expect(artifact.manifest.automationType).toBe("hybrid");
    expect(artifact.manifest.deliveryMode).toBe("native_uis");
    expect(artifact.manifest.recommendation?.recommendedOutput).toBe("solution");
    expect(artifact.manifest.recommendation?.connectorRecommendations.map((connector) => connector.connectorName)).toContain("Microsoft 365");
    expect(artifact.manifest.operatingModel?.governanceArtifacts).toContain("DSD");
    expect(artifact.manifest.releaseReadiness?.score).toBeGreaterThan(70);
    expect(artifact.manifest.testRelease?.automatedCoveragePercent).toBe(100);
    expect(artifact.manifest.reporting?.businessKpis[0]).toContain("InvoiceAutomation");
    expect(artifact.manifest.executiveSummary?.overview).toContain("InvoiceAutomation");
    expect(artifact.manifest.executiveSummary?.lifecycleCoverage).toContain("Deploy through package or native solution deployment paths");
    expect(artifact.manifest.testCases).toHaveLength(1);
    expect(artifact.manifest.resources.queues).toEqual(["InvoiceQueue"]);
    expect(artifact.manifest.resources.assets).toEqual(["Asset.ApiKey"]);

    const zip = new AdmZip(artifact.buffer);
    const entryNames = zip.getEntries().map(entry => entry.entryName);

    expect(entryNames).toContain("Solution.uipx");
    expect(entryNames).toContain("SolutionStorage.json");
    expect(entryNames).toContain("InvoiceAutomation/project.uiproj");
    expect(entryNames).toContain("InvoiceAutomation/Main.xaml");
    expect(entryNames).toContain("InvoiceAutomation/project.json");
    expect(entryNames).toContain("InvoiceAutomation/DeveloperHandoffGuide.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/SDD.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/PDD.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/DSD.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/TestCases.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/TestCases.json");
    expect(entryNames).toContain("InvoiceAutomation/docs/OperatingModel.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/GovernancePack.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/TestReleasePlan.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/InsightsPlan.md");
    expect(entryNames).toContain("InvoiceAutomation/docs/ExecutiveSummary.md");
    expect(entryNames).toContain("resources/solution_folder/package/InvoiceAutomation.json");
    expect(entryNames).toContain("resources/solution_folder/process/process/InvoiceAutomation.json");
    expect(entryNames).toContain("resources/solution_folder/queue/InvoiceQueue.json");
    expect(entryNames).toContain("resources/solution_folder/asset/stringAsset/Asset_ApiKey.json");
    expect(entryNames).toContain("resources/solution_folder/bucket/orchestratorBucket/Invoices.json");

    const solutionUipx = JSON.parse(zip.readAsText("Solution.uipx"));
    expect(solutionUipx.Projects).toHaveLength(1);
    expect(solutionUipx.Projects[0]).toMatchObject({
      Type: "Process",
      ProjectRelativePath: "InvoiceAutomation/project.uiproj",
    });

    const processResource = JSON.parse(zip.readAsText("resources/solution_folder/process/process/InvoiceAutomation.json"));
    expect(processResource.resource.kind).toBe("process");
    expect(processResource.resource.spec.packageName).toContain("InvoiceAutomation");

    const queueResource = JSON.parse(zip.readAsText("resources/solution_folder/queue/InvoiceQueue.json"));
    expect(queueResource.resource.kind).toBe("queue");
    expect(queueResource.resource.type).toBeUndefined();
    expect(queueResource.resource.spec.name).toBe("InvoiceQueue");
    expect(queueResource.resource.spec.acceptAutomaticallyRetry).toBe(true);
    expect(queueResource.resource.spec.retentionAction).toBe("Delete");

    const assetResource = JSON.parse(zip.readAsText("resources/solution_folder/asset/stringAsset/Asset_ApiKey.json"));
    expect(assetResource.resource.kind).toBe("asset");
    expect(assetResource.resource.type).toBe("stringAsset");
    expect(assetResource.resource.spec.type).toBe("Text");
    expect(assetResource.resource.spec.value).toBe("abc123");

    const storageBucketResource = JSON.parse(zip.readAsText("resources/solution_folder/bucket/orchestratorBucket/Invoices.json"));
    expect(storageBucketResource.resource.kind).toBe("bucket");
    expect(storageBucketResource.resource.type).toBe("orchestratorBucket");
    expect(storageBucketResource.resource.spec.name).toBe("Invoices");
    expect(storageBucketResource.resource.spec.type).toBe("Orchestrator");

    const testCasesMarkdown = zip.readAsText("InvoiceAutomation/docs/TestCases.md");
    expect(testCasesMarkdown).toContain("TC001 - Happy path");
    expect(testCasesMarkdown).toContain("Queue item created");

    const operatingModelMarkdown = zip.readAsText("InvoiceAutomation/docs/OperatingModel.md");
    expect(operatingModelMarkdown).toContain("Operating Model");
    expect(operatingModelMarkdown).toContain("Deployment Readiness Notes");

    const governancePackMarkdown = zip.readAsText("InvoiceAutomation/docs/GovernancePack.md");
    expect(governancePackMarkdown).toContain("Release Readiness");
    expect(governancePackMarkdown).toContain("Release Gates");

    const testReleasePlanMarkdown = zip.readAsText("InvoiceAutomation/docs/TestReleasePlan.md");
    expect(testReleasePlanMarkdown).toContain("Smoke test set");
    expect(testReleasePlanMarkdown).toContain("Release Actions");

    const insightsPlanMarkdown = zip.readAsText("InvoiceAutomation/docs/InsightsPlan.md");
    expect(insightsPlanMarkdown).toContain("Business KPIs");
    expect(insightsPlanMarkdown).toContain("Alerts");

    const executiveSummaryMarkdown = zip.readAsText("InvoiceAutomation/docs/ExecutiveSummary.md");
    expect(executiveSummaryMarkdown).toContain("Executive Summary");
    expect(executiveSummaryMarkdown).toContain("Lifecycle Coverage");
    expect(executiveSummaryMarkdown).toContain("Deployment Story");
  });
});
