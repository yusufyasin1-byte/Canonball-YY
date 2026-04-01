import { describe, it, expect } from "vitest";
import {
  scanCredentialAssets,
  analyzeExceptionCoverage,
  extractQueueManagement,
  detectEnvironmentRequirements,
  suggestTriggers,
  calculateReadiness,
  runDhgAnalysis,
  crossReferenceArtifacts,
  type CredentialAssetInventory,
  type ExceptionCoverageResult,
  type QueueManagementResult,
  type EnvironmentRequirements,
  type DecisionBranch,
} from "../xaml/dhg-analyzers";
import { generateDhgFromOutcomeReport, type DhgContext } from "../dhg-generator";
import type { PipelineOutcomeReport } from "../uipath-pipeline";

function makeQueueResult(overrides: Partial<QueueManagementResult> = {}): QueueManagementResult {
  return {
    entries: [],
    uniqueQueues: [],
    hasAddQueueItem: false,
    hasGetTransaction: false,
    hasSetTransactionStatus: false,
    isTransactionalPattern: false,
    retryPolicy: { maxRetries: 0, autoRetryEnabled: false, note: "N/A" },
    slaGuidance: "No queue-based SLA applicable.",
    deadLetterHandling: "No dead-letter handling applicable — process does not consume queue items.",
    ...overrides,
  };
}

function makeEnvResult(overrides: Partial<EnvironmentRequirements> = {}): EnvironmentRequirements {
  return {
    needsWindowsTarget: false,
    needsAttendedRobot: false,
    usesModernActivities: true,
    browserExtensions: [],
    requiredPackages: [],
    usesOrchestrator: false,
    usesActionCenter: false,
    usesAICenter: false,
    usesDocumentUnderstanding: false,
    usesDataService: false,
    machineTemplate: { recommendedType: "Standard", note: "Standard unattended machine template" },
    orchestratorFolderGuidance: "Create a Modern Folder with at least one unattended robot assignment.",
    studioVersion: "25.10.0",
    ...overrides,
  };
}

function makeXaml(body: string): string {
  return `<Activity xmlns:ui="http://schemas.uipath.com/workflow/activities"
    xmlns:uweb="http://schemas.uipath.com/workflow/activities/web"
    xmlns:udb="http://schemas.uipath.com/workflow/activities/database"
    xmlns:umail="http://schemas.uipath.com/workflow/activities/mail"
    xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities">
    <Sequence DisplayName="Main">
      ${body}
    </Sequence>
  </Activity>`;
}

describe("scanCredentialAssets", () => {
  it("detects GetCredential with hardcoded name", () => {
    const xaml = makeXaml(`<ui:GetCredential CredentialName="MyAppLogin" Result="[cred_Output]" />`);
    const result = scanCredentialAssets([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].activityType).toBe("GetCredential");
    expect(result.entries[0].assetName).toBe("MyAppLogin");
    expect(result.entries[0].isHardcoded).toBe(true);
    expect(result.entries[0].variableName).toBe("cred_Output");
    expect(result.uniqueCredentialNames).toEqual(["MyAppLogin"]);
    expect(result.hardcodedCount).toBe(1);
  });

  it("detects GetAsset with hardcoded name", () => {
    const xaml = makeXaml(`<ui:GetAsset AssetName="Config_URL" Result="[str_URL]" />`);
    const result = scanCredentialAssets([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].activityType).toBe("GetAsset");
    expect(result.entries[0].assetName).toBe("Config_URL");
    expect(result.uniqueAssetNames).toEqual(["Config_URL"]);
  });

  it("detects SetCredential", () => {
    const xaml = makeXaml(`<ui:SetCredential CredentialName="NewCred" />`);
    const result = scanCredentialAssets([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].activityType).toBe("SetCredential");
  });

  it("detects SetAsset", () => {
    const xaml = makeXaml(`<ui:SetAsset AssetName="LastRunDate" />`);
    const result = scanCredentialAssets([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].activityType).toBe("SetAsset");
  });

  it("detects variable-driven asset names", () => {
    const xaml = makeXaml(`<ui:GetAsset AssetName="[config_AssetName]" />`);
    const result = scanCredentialAssets([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].isHardcoded).toBe(false);
    expect(result.variableCount).toBe(1);
  });

  it("returns empty for no asset activities", () => {
    const xaml = makeXaml(`<ui:LogMessage Text="Hello" />`);
    const result = scanCredentialAssets([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(0);
    expect(result.uniqueAssetNames).toEqual([]);
    expect(result.uniqueCredentialNames).toEqual([]);
  });

  it("handles multiple assets across files", () => {
    const xaml1 = makeXaml(`<ui:GetCredential CredentialName="Cred1" />`);
    const xaml2 = makeXaml(`<ui:GetAsset AssetName="Asset1" />\n<ui:GetAsset AssetName="Asset2" />`);
    const result = scanCredentialAssets([
      { name: "lib/Login.xaml", content: xaml1 },
      { name: "lib/Process.xaml", content: xaml2 },
    ]);
    expect(result.entries.length).toBe(3);
    expect(result.uniqueCredentialNames).toEqual(["Cred1"]);
    expect(result.uniqueAssetNames).toContain("Asset1");
    expect(result.uniqueAssetNames).toContain("Asset2");
  });

  it("infers Credential assetValueType for GetCredential", () => {
    const xaml = makeXaml(`<ui:GetCredential CredentialName="MyLogin" Result="[cred_Out]" />`);
    const result = scanCredentialAssets([{ name: "Main.xaml", content: xaml }]);
    expect(result.entries[0].assetValueType).toBe("Credential");
  });

  it("reads explicit AssetType attribute", () => {
    const xaml = makeXaml(`<ui:GetAsset AssetName="MaxRetry" AssetType="Integer" Result="[int_Retry]" />`);
    const result = scanCredentialAssets([{ name: "Main.xaml", content: xaml }]);
    expect(result.entries[0].assetValueType).toBe("Integer");
  });

  it("infers asset type from variable name heuristics", () => {
    const xaml = makeXaml(`<ui:GetAsset AssetName="SomeFlag" Result="[bool_Flag]" />`);
    const result = scanCredentialAssets([{ name: "Main.xaml", content: xaml }]);
    expect(result.entries[0].assetValueType).toBe("Boolean");
  });
});

describe("analyzeExceptionCoverage", () => {
  it("detects activities inside TryCatch", () => {
    const xaml = makeXaml(`
      <TryCatch DisplayName="Error Handler">
        <TryCatch.Try>
          <ui:HttpClient DisplayName="Call API" />
        </TryCatch.Try>
        <TryCatch.Catches>
          <Catch TypeArgument="System.Exception">
            <ActivityAction />
          </Catch>
        </TryCatch.Catches>
      </TryCatch>
    `);
    const result = analyzeExceptionCoverage([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.totalActivities).toBeGreaterThanOrEqual(1);
    expect(result.coveredActivities).toBeGreaterThanOrEqual(1);
    expect(result.coveragePercent).toBe(100);
  });

  it("detects uncovered high-risk activities", () => {
    const xaml = makeXaml(`<ui:HttpClient DisplayName="Call API" />`);
    const result = analyzeExceptionCoverage([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.totalActivities).toBe(1);
    expect(result.coveredActivities).toBe(0);
    expect(result.coveragePercent).toBe(0);
    expect(result.uncoveredHighRiskActivities.length).toBe(1);
  });

  it("identifies files without TryCatch", () => {
    const xaml = makeXaml(`<ui:LogMessage Text="Hello" />`);
    const result = analyzeExceptionCoverage([{ name: "lib/Simple.xaml", content: xaml }]);
    expect(result.filesWithoutTryCatch).toContain("Simple.xaml");
  });

  it("returns 100% coverage when no high-risk activities", () => {
    const xaml = makeXaml(`<ui:LogMessage Text="Hello" />`);
    const result = analyzeExceptionCoverage([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.totalActivities).toBe(0);
    expect(result.coveragePercent).toBe(100);
  });

  it("detects catch types from TypeArgument", () => {
    const xaml = makeXaml(`
      <TryCatch>
        <TryCatch.Try>
          <ui:ExecuteQuery DisplayName="Run Query" />
        </TryCatch.Try>
        <TryCatch.Catches>
          <Catch TypeArgument="System.Exception">
            <ActivityAction />
          </Catch>
          <Catch TypeArgument="System.TimeoutException">
            <ActivityAction />
          </Catch>
        </TryCatch.Catches>
      </TryCatch>
    `);
    const result = analyzeExceptionCoverage([{ name: "lib/Main.xaml", content: xaml }]);
    const dbEntry = result.entries.find(e => e.activityName === "Run Query");
    expect(dbEntry).toBeDefined();
    expect(dbEntry!.insideTryCatch).toBe(true);
    expect(dbEntry!.catchTypes).toContain("System.Exception");
    expect(dbEntry!.catchTypes).toContain("System.TimeoutException");
  });
});

describe("extractQueueManagement", () => {
  it("detects AddQueueItem", () => {
    const xaml = makeXaml(`<ui:AddQueueItem QueueName="InvoiceQueue" />`);
    const result = extractQueueManagement([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(1);
    expect(result.entries[0].activityType).toBe("AddQueueItem");
    expect(result.entries[0].queueName).toBe("InvoiceQueue");
    expect(result.hasAddQueueItem).toBe(true);
    expect(result.uniqueQueues).toEqual(["InvoiceQueue"]);
  });

  it("detects transactional pattern", () => {
    const xaml = makeXaml(`
      <ui:GetTransactionItem QueueName="WorkQueue" />
      <ui:SetTransactionStatus />
    `);
    const result = extractQueueManagement([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.hasGetTransaction).toBe(true);
    expect(result.hasSetTransactionStatus).toBe(true);
    expect(result.isTransactionalPattern).toBe(true);
  });

  it("detects non-transactional queue usage", () => {
    const xaml = makeXaml(`<ui:AddQueueItem QueueName="TestQueue" />`);
    const result = extractQueueManagement([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.isTransactionalPattern).toBe(false);
    expect(result.hasAddQueueItem).toBe(true);
  });

  it("returns empty for no queue activities", () => {
    const xaml = makeXaml(`<ui:LogMessage Text="Hello" />`);
    const result = extractQueueManagement([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(0);
    expect(result.uniqueQueues).toEqual([]);
  });

  it("detects hardcoded vs variable queue names", () => {
    const xaml = makeXaml(`
      <ui:AddQueueItem QueueName="HardcodedQueue" />
      <ui:GetTransactionItem QueueName="[config_QueueName]" />
    `);
    const result = extractQueueManagement([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.entries.length).toBe(2);
    const hardcoded = result.entries.find(e => e.queueName === "HardcodedQueue");
    const variable = result.entries.find(e => e.queueName === "[config_QueueName]");
    expect(hardcoded?.isHardcoded).toBe(true);
    expect(variable?.isHardcoded).toBe(false);
  });

  it("detects BulkAddQueueItems", () => {
    const xaml = makeXaml(`<ui:BulkAddQueueItems QueueName="BulkQueue" />`);
    const result = extractQueueManagement([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.hasAddQueueItem).toBe(true);
    expect(result.entries[0].activityType).toBe("BulkAddQueueItems");
  });

  it("provides retry policy for transactional pattern", () => {
    const xaml = makeXaml(`
      <ui:GetTransactionItem QueueName="Q1" />
      <ui:SetTransactionStatus />
    `);
    const result = extractQueueManagement([{ name: "Main.xaml", content: xaml }]);
    expect(result.retryPolicy.autoRetryEnabled).toBe(true);
    expect(result.retryPolicy.maxRetries).toBe(3);
    expect(result.slaGuidance).toContain("SLA");
    expect(result.deadLetterHandling).toContain("Failed");
  });

  it("provides no retry for dispatcher-only", () => {
    const xaml = makeXaml(`<ui:AddQueueItem QueueName="Q1" />`);
    const result = extractQueueManagement([{ name: "Main.xaml", content: xaml }]);
    expect(result.retryPolicy.autoRetryEnabled).toBe(false);
    expect(result.retryPolicy.note).toContain("Dispatcher");
  });

  it("sets no-queue guidance when no queue activities", () => {
    const xaml = makeXaml(`<ui:LogMessage Text="Hello" />`);
    const result = extractQueueManagement([{ name: "Main.xaml", content: xaml }]);
    expect(result.slaGuidance).toContain("No queue-based SLA applicable");
    expect(result.deadLetterHandling).toContain("does not consume queue items");
  });
});

describe("detectEnvironmentRequirements", () => {
  it("detects Windows-only requirements", () => {
    const xaml = makeXaml(`<ui:ExcelApplicationScope />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.needsWindowsTarget).toBe(true);
  });

  it("detects attended robot needs", () => {
    const xaml = makeXaml(`<ui:InputDialog />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.needsAttendedRobot).toBe(true);
  });

  it("detects modern activities", () => {
    const xaml = makeXaml(`<ui:UseApplication />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.usesModernActivities).toBe(true);
  });

  it("detects browser extension needs", () => {
    const xaml = makeXaml(`<ui:UseBrowser />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.browserExtensions.length).toBeGreaterThan(0);
  });

  it("detects Orchestrator usage", () => {
    const xaml = makeXaml(`<ui:GetCredential CredentialName="Test" />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.usesOrchestrator).toBe(true);
  });

  it("detects Action Center usage", () => {
    const xaml = makeXaml(`<ui:CreateFormTask />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.usesActionCenter).toBe(true);
  });

  it("detects AI Center usage", () => {
    const xaml = makeXaml(`<ui:MLSkill />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.usesAICenter).toBe(true);
  });

  it("detects Document Understanding usage", () => {
    const xaml = makeXaml(`<ui:DigitizeDocument />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.usesDocumentUnderstanding).toBe(true);
  });

  it("detects Data Service usage", () => {
    const xaml = makeXaml(`<ui:QueryEntity />`);
    const result = detectEnvironmentRequirements([{ name: "lib/Main.xaml", content: xaml }]);
    expect(result.usesDataService).toBe(true);
  });

  it("extracts packages from project.json", () => {
    const projectJson = JSON.stringify({
      dependencies: {
        "UiPath.System.Activities": "[25.10.0]",
        "UiPath.Excel.Activities": "[25.10.0]",
      },
    });
    const result = detectEnvironmentRequirements([], projectJson);
    expect(result.requiredPackages).toContain("UiPath.System.Activities");
    expect(result.requiredPackages).toContain("UiPath.Excel.Activities");
  });

  it("handles missing project.json gracefully", () => {
    const result = detectEnvironmentRequirements([]);
    expect(result.requiredPackages).toEqual([]);
  });

  it("provides machine template for AI Center workloads", () => {
    const xaml = makeXaml(`<ui:MLSkill />`);
    const result = detectEnvironmentRequirements([{ name: "Main.xaml", content: xaml }]);
    expect(result.machineTemplate.recommendedType).toBe("Server");
  });

  it("provides Serverless for modern cross-platform", () => {
    const xaml = makeXaml(`<ui:UseApplication />`);
    const result = detectEnvironmentRequirements([{ name: "Main.xaml", content: xaml }]);
    expect(result.machineTemplate.recommendedType).toBe("Serverless");
  });

  it("provides Standard for attended robot", () => {
    const xaml = makeXaml(`<ui:InputDialog />`);
    const result = detectEnvironmentRequirements([{ name: "Main.xaml", content: xaml }]);
    expect(result.machineTemplate.recommendedType).toBe("Standard");
    expect(result.machineTemplate.note).toContain("interactive session");
  });

  it("provides orchestrator folder guidance", () => {
    const xaml = makeXaml(`<ui:GetCredential CredentialName="Test" />`);
    const result = detectEnvironmentRequirements([{ name: "Main.xaml", content: xaml }]);
    expect(result.orchestratorFolderGuidance).toContain("Modern Folder");
  });

  it("defaults studioVersion to 25.10.0", () => {
    const result = detectEnvironmentRequirements([]);
    expect(result.studioVersion).toBe("25.10.0");
  });

  it("extracts studioVersion from project.json", () => {
    const pj = JSON.stringify({ studioVersion: "24.10.6" });
    const result = detectEnvironmentRequirements([], pj);
    expect(result.studioVersion).toBe("24.10.6");
  });
});

describe("suggestTriggers", () => {
  it("suggests queue trigger for transactional pattern", () => {
    const qResult = makeQueueResult({ uniqueQueues: ["WorkQueue"], hasGetTransaction: true, hasSetTransactionStatus: true, isTransactionalPattern: true });
    const envResult = makeEnvResult({ usesOrchestrator: true });
    const triggers = suggestTriggers(qResult, envResult);
    expect(triggers.some(t => t.triggerType === "Queue")).toBe(true);
    expect(triggers[0].suggestedConfig).toContain("WorkQueue");
  });

  it("suggests attended trigger for attended robot", () => {
    const qResult = makeQueueResult();
    const envResult = makeEnvResult({ needsAttendedRobot: true });
    const triggers = suggestTriggers(qResult, envResult);
    expect(triggers.some(t => t.triggerType === "Attended")).toBe(true);
    expect(triggers[0].suggestedConfig).toContain("Assistant");
  });

  it("suggests schedule trigger as default with cron expression", () => {
    const qResult = makeQueueResult();
    const envResult = makeEnvResult();
    const triggers = suggestTriggers(qResult, envResult);
    expect(triggers.some(t => t.triggerType === "Schedule")).toBe(true);
    expect(triggers[0].suggestedConfig).toContain("Cron:");
  });

  it("suggests API trigger for agent automation", () => {
    const qResult = makeQueueResult();
    const envResult = makeEnvResult();
    const triggers = suggestTriggers(qResult, envResult, "agent");
    expect(triggers.some(t => t.triggerType === "API/Webhook")).toBe(true);
    expect(triggers[0].suggestedConfig).toContain("StartJobs");
  });

  it("suggests event trigger for Action Center usage", () => {
    const qResult = makeQueueResult();
    const envResult = makeEnvResult({ usesActionCenter: true });
    const triggers = suggestTriggers(qResult, envResult);
    expect(triggers.some(t => t.triggerType === "EventBased")).toBe(true);
  });
});

describe("calculateReadiness", () => {
  const emptyCred: CredentialAssetInventory = {
    entries: [],
    hardcodedCount: 0,
    variableCount: 0,
    uniqueAssetNames: [],
    uniqueCredentialNames: [],
  };
  const emptyExc: ExceptionCoverageResult = {
    entries: [],
    totalActivities: 0,
    coveredActivities: 0,
    coveragePercent: 100,
    uncoveredHighRiskActivities: [],
    filesWithoutTryCatch: [],
  };
  const emptyQueue = makeQueueResult();
  const simpleEnv = makeEnvResult({ requiredPackages: ["UiPath.System.Activities"] });

  it("returns Ready for clean package", () => {
    const result = calculateReadiness(emptyCred, emptyExc, emptyQueue, simpleEnv, 0, 0);
    expect(result.rating).toBe("Ready");
    expect(result.percent).toBeGreaterThanOrEqual(85);
  });

  it("penalizes hardcoded credentials", () => {
    const cred: CredentialAssetInventory = {
      entries: [{ file: "Main.xaml", activityType: "GetAsset", assetName: "Test", isHardcoded: true, lineNumber: 1, assetValueType: "Unknown" as const }],
      hardcodedCount: 1,
      variableCount: 0,
      uniqueAssetNames: ["Test"],
      uniqueCredentialNames: [],
    };
    const result = calculateReadiness(cred, emptyExc, emptyQueue, simpleEnv, 0, 0);
    const credSection = result.sections.find(s => s.section === "Credentials & Assets");
    expect(credSection!.score).toBeLessThan(credSection!.maxScore);
  });

  it("penalizes low exception coverage", () => {
    const exc: ExceptionCoverageResult = {
      entries: [
        { file: "Main.xaml", activityName: "ui:HttpClient", lineNumber: 10, insideTryCatch: false, catchTypes: [] },
        { file: "Main.xaml", activityName: "ui:ExecuteQuery", lineNumber: 20, insideTryCatch: false, catchTypes: [] },
      ],
      totalActivities: 2,
      coveredActivities: 0,
      coveragePercent: 0,
      uncoveredHighRiskActivities: ["Main.xaml:10 ui:HttpClient", "Main.xaml:20 ui:ExecuteQuery"],
      filesWithoutTryCatch: ["Main.xaml"],
    };
    const result = calculateReadiness(emptyCred, exc, emptyQueue, simpleEnv, 0, 0);
    const excSection = result.sections.find(s => s.section === "Exception Handling");
    expect(excSection!.score).toBeLessThan(5);
  });

  it("returns lower rating for many issues", () => {
    const exc: ExceptionCoverageResult = {
      entries: Array(5).fill(null).map((_, i) => ({
        file: "Main.xaml",
        activityName: `Activity${i}`,
        lineNumber: i * 10,
        insideTryCatch: false,
        catchTypes: [],
      })),
      totalActivities: 5,
      coveredActivities: 0,
      coveragePercent: 0,
      uncoveredHighRiskActivities: Array(5).fill("Main.xaml:1 Activity"),
      filesWithoutTryCatch: ["Main.xaml", "Sub1.xaml", "Sub2.xaml", "Sub3.xaml"],
    };
    const result = calculateReadiness(emptyCred, exc, emptyQueue, simpleEnv, 15, 10);
    expect(result.percent).toBeLessThan(85);
    expect(result.rating !== "Ready").toBe(true);
  });

  it("penalizes GetTransactionItem without SetTransactionStatus", () => {
    const queue = makeQueueResult({
      entries: [{ file: "Main.xaml", activityType: "GetTransactionItem", queueName: "Q1", isHardcoded: true, lineNumber: 1 }],
      uniqueQueues: ["Q1"],
      hasGetTransaction: true,
    });
    const result = calculateReadiness(emptyCred, emptyExc, queue, simpleEnv, 0, 0);
    const queueSection = result.sections.find(s => s.section === "Queue Management");
    expect(queueSection!.score).toBeLessThan(queueSection!.maxScore);
    expect(queueSection!.notes.some(n => n.includes("SetTransactionStatus"))).toBe(true);
  });

  it("does not penalize exception handling when no high-risk activities", () => {
    const exc: ExceptionCoverageResult = {
      entries: [],
      totalActivities: 0,
      coveredActivities: 0,
      coveragePercent: 100,
      uncoveredHighRiskActivities: [],
      filesWithoutTryCatch: ["Simple.xaml", "Helper.xaml"],
    };
    const result = calculateReadiness(emptyCred, exc, emptyQueue, simpleEnv, 0, 0);
    const excSection = result.sections.find(s => s.section === "Exception Handling");
    expect(excSection!.score).toBe(excSection!.maxScore);
  });
});

describe("runDhgAnalysis", () => {
  it("runs full analysis pipeline", () => {
    const xaml = makeXaml(`
      <ui:GetCredential CredentialName="AppLogin" />
      <TryCatch>
        <TryCatch.Try>
          <ui:HttpClient DisplayName="Call API" />
        </TryCatch.Try>
        <TryCatch.Catches>
          <Catch TypeArgument="System.Exception"><ActivityAction /></Catch>
        </TryCatch.Catches>
      </TryCatch>
      <ui:AddQueueItem QueueName="ResultQueue" />
    `);
    const result = runDhgAnalysis([{ name: "lib/Main.xaml", content: xaml }]);

    expect(result.credentialInventory.entries.length).toBe(1);
    expect(result.queueManagement.entries.length).toBe(1);
    expect(result.environmentRequirements.usesOrchestrator).toBe(true);
    expect(result.triggerSuggestions.length).toBeGreaterThan(0);
    expect(result.readiness.sections.length).toBe(5);
    expect(result.readiness.percent).toBeGreaterThan(0);
  });

  it("works with empty entries", () => {
    const result = runDhgAnalysis([]);
    expect(result.credentialInventory.entries.length).toBe(0);
    expect(result.readiness.rating).toBe("Ready");
  });

  it("passes projectJsonContent to environment detector", () => {
    const projectJson = JSON.stringify({
      dependencies: {
        "UiPath.System.Activities": "[25.10.0]",
        "UiPath.Excel.Activities": "[25.10.0]",
      },
    });
    const result = runDhgAnalysis([], projectJson);
    expect(result.environmentRequirements.requiredPackages).toContain("UiPath.System.Activities");
    expect(result.environmentRequirements.requiredPackages).toContain("UiPath.Excel.Activities");
  });

  it("DHG requiredPackages matches full post-alignment dependency set for multi-workflow packages", () => {
    const postAlignmentDeps = {
      "UiPath.System.Activities": "[25.10.17127]",
      "UiPath.Excel.Activities": "[2.24.2]",
      "UiPath.UIAutomation.Activities": "[25.10.17127]",
      "UiPath.Mail.Activities": "[1.23.11]",
      "UiPath.Web.Activities": "[1.21.0]",
      "UiPath.Persistence.Activities": "[3.0.3]",
      "UiPath.IntelligentOCR.Activities": "[6.13.0]",
    };
    const projectJson = JSON.stringify({ dependencies: postAlignmentDeps });
    const result = runDhgAnalysis([], projectJson);
    const reportedPkgs = result.environmentRequirements.requiredPackages;
    const expectedPkgs = Object.keys(postAlignmentDeps);
    expect(reportedPkgs.sort()).toEqual(expectedPkgs.sort());
  });

  it("DHG requiredPackages is empty when projectJsonContent is undefined", () => {
    const result = runDhgAnalysis([], undefined);
    expect(result.environmentRequirements.requiredPackages).toEqual([]);
  });
});

describe("DHG generator with analysis context", () => {
  function makeMinimalReport(): PipelineOutcomeReport {
    return {
      remediations: [],
      propertyRemediations: [],
      autoRepairs: [],
      downgradeEvents: [],
      qualityWarnings: [],
      fullyGeneratedFiles: ["Main.xaml"],
      totalEstimatedEffortMinutes: 0,
    };
  }

  it("includes Environment Setup section when analysis is present", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:UseBrowser /><ui:GetCredential CredentialName="Cred1" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Environment Setup");
    expect(md).toContain("Browser Extensions");
    expect(md).toContain("Chrome/Edge UiPath Extension");
  });

  it("includes Credential & Asset Inventory section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`
        <ui:GetCredential CredentialName="AppCred" />
        <ui:GetAsset AssetName="Config_URL" />
      `),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Credential & Asset Inventory");
    expect(md).toContain("AppCred");
    expect(md).toContain("Config_URL");
    expect(md).toContain("Orchestrator Credentials to Provision");
    expect(md).toContain("Orchestrator Assets to Provision");
  });

  it("includes Queue Management section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`
        <ui:GetTransactionItem QueueName="WorkQueue" />
        <ui:SetTransactionStatus />
      `),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Queue Management");
    expect(md).toContain("WorkQueue");
    expect(md).toContain("Transactional (Dispatcher/Performer)");
  });

  it("includes Exception Handling Coverage section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:HttpClient DisplayName="Call API" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Exception Handling Coverage");
    expect(md).toContain("Uncovered High-Risk Activities");
  });

  it("includes Trigger Configuration section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:LogMessage Text="Hi" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Trigger Configuration");
  });

  it("includes Pre-Deployment Checklist section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:GetCredential CredentialName="Cred1" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Pre-Deployment Checklist");
    expect(md).toContain("Provision credential");
    expect(md).toContain("Publish package to Orchestrator feed");
  });

  it("includes Deployment Readiness Score section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:LogMessage Text="Hi" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Deployment Readiness Score");
    expect(md).toContain("Overall:");
  });

  it("shows readiness in header when analysis present", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:LogMessage Text="Hi" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("**Deployment Readiness:**");
  });

  it("downgrades readiness score details for baseline packages with bind points", () => {
    const analysis = runDhgAnalysis([{
      name: "Main.xaml",
      content: makeXaml(`<ui:LogMessage DisplayName="Queue Bind Point - Orchestrator Queue" Message="[&quot;Implement queue ingestion&quot;]" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      generationMode: "baseline_openable",
      analysis,
      xamlEntries: [{
        name: "Main.xaml",
        content: makeXaml(`<ui:LogMessage DisplayName="Queue Bind Point - Orchestrator Queue" Message="[&quot;Implement queue ingestion&quot;]" />`),
      }],
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("**Deployment Readiness:** Needs Work (55%)");
    expect(md).toContain("**Overall: Needs Work");
    expect(md).toContain("Override for Baseline Mode");
  });

  it("includes workflow contract guidance for generated XAML entries", () => {
    const mainXaml = `
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
  xmlns:ui="http://schemas.uipath.com/workflow/activities">
  <x:Members>
    <x:Property Name="in_Config" Type="InArgument(x:String)" />
    <x:Property Name="out_Result" Type="OutArgument(x:String)" />
  </x:Members>
  <Sequence>
    <ui:LogMessage DisplayName="Data Service Bind Point - Data Service"
      Message="[&quot;Implement persistence&quot;]" />
  </Sequence>
</Activity>`;
    const analysis = runDhgAnalysis([{ name: "Main.xaml", content: mainXaml }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      generationMode: "baseline_openable",
      analysis,
      xamlEntries: [{ name: "Main.xaml", content: mainXaml }],
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Workflow Contracts");
    expect(md).toContain("Orchestration");
    expect(md).toContain("in_Config");
    expect(md).toContain("out_Result");
    expect(md).toContain("Contains system bind points that must be implemented for production.");
  });

  it("includes Retry Policy and SLA Guidance in queue section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`
        <ui:GetTransactionItem QueueName="WorkQueue" />
        <ui:SetTransactionStatus />
      `),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Retry Policy");
    expect(md).toContain("SLA Guidance");
    expect(md).toContain("Dead-Letter / Failed Items Handling");
    expect(md).toContain("Auto Retry");
  });

  it("includes Machine Template and Folder Guidance in environment section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:UseApplication />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Machine Template");
    expect(md).toContain("Orchestrator Folder Structure");
    expect(md).toContain("Studio Version");
  });

  it("includes Detailed Usage Map in credential section", () => {
    const analysis = runDhgAnalysis([{
      name: "lib/Main.xaml",
      content: makeXaml(`<ui:GetAsset AssetName="Config_URL" Result="[str_URL]" />`),
    }]);
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Detailed Usage Map");
    expect(md).toContain("Config_URL");
  });

  it("includes upstream context section when provided", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      { ideaDescription: "Invoice processing automation", automationType: "rpa", feasibilityScore: 85 },
    );
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Process Context (from Pipeline)");
    expect(md).toContain("Invoice processing automation");
    expect(md).toContain("Automation Type");
    expect(md).toContain("Feasibility Score");
  });

  it("includes upstream quality warnings section", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 2, 0, undefined,
      {
        qualityWarnings: [
          { code: "SELECTOR_LOW_QUALITY", message: "Selector score 4/20 in Main.xaml", severity: "warning" },
          { code: "TYPE_MISMATCH", message: "Int32 expected but got String", severity: "warning" },
        ],
      },
    );
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("Upstream Quality Findings");
    expect(md).toContain("SELECTOR_LOW_QUALITY");
    expect(md).toContain("TYPE_MISMATCH");
  });

  it("includes PDD and SDD summaries in upstream context", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      { pddSummary: "Process Design for invoice handling", sddSummary: "Solution using REFramework with SAP" },
    );
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
      analysis,
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).toContain("PDD Summary");
    expect(md).toContain("invoice handling");
    expect(md).toContain("SDD Summary");
    expect(md).toContain("REFramework with SAP");
  });

  it("omits analysis sections when no analysis context", () => {
    const context: DhgContext = {
      projectName: "TestProject",
      workflowNames: ["Main"],
    };
    const md = generateDhgFromOutcomeReport(makeMinimalReport(), context);
    expect(md).not.toContain("Environment Setup");
    expect(md).not.toContain("Credential & Asset Inventory");
    expect(md).not.toContain("Queue Management");
    expect(md).not.toContain("Exception Handling Coverage");
    expect(md).not.toContain("Trigger Configuration");
    expect(md).not.toContain("Pre-Deployment Checklist");
    expect(md).not.toContain("Deployment Readiness Score");
  });
});

describe("crossReferenceArtifacts", () => {
  it("identifies aligned assets present in both SDD and XAML", () => {
    const sddArtifacts = {
      assets: [{ name: "Config_URL", type: "Text", description: "Base URL" }],
    };
    const credInventory: CredentialAssetInventory = {
      entries: [{ file: "Main.xaml", activityType: "GetAsset", assetName: "Config_URL", isHardcoded: true, lineNumber: 5, assetValueType: "Text" }],
      hardcodedCount: 1, variableCount: 0, uniqueAssetNames: ["Config_URL"], uniqueCredentialNames: [],
    };
    const result = crossReferenceArtifacts(sddArtifacts, credInventory, makeQueueResult());
    expect(result.alignedCount).toBe(1);
    expect(result.sddOnlyCount).toBe(0);
    expect(result.xamlOnlyCount).toBe(0);
    expect(result.entries[0].status).toBe("aligned");
    expect(result.entries[0].name).toBe("Config_URL");
  });

  it("identifies SDD-only assets not in XAML", () => {
    const sddArtifacts = {
      assets: [{ name: "MissingAsset", type: "Text" }],
    };
    const credInventory: CredentialAssetInventory = {
      entries: [], hardcodedCount: 0, variableCount: 0, uniqueAssetNames: [], uniqueCredentialNames: [],
    };
    const result = crossReferenceArtifacts(sddArtifacts, credInventory, makeQueueResult());
    expect(result.sddOnlyCount).toBe(1);
    expect(result.entries[0].status).toBe("sdd-only");
  });

  it("identifies XAML-only assets not in SDD", () => {
    const credInventory: CredentialAssetInventory = {
      entries: [{ file: "Main.xaml", activityType: "GetAsset", assetName: "ExtraAsset", isHardcoded: true, lineNumber: 10, assetValueType: "Text" }],
      hardcodedCount: 1, variableCount: 0, uniqueAssetNames: ["ExtraAsset"], uniqueCredentialNames: [],
    };
    const result = crossReferenceArtifacts({}, credInventory, makeQueueResult());
    expect(result.xamlOnlyCount).toBe(1);
    expect(result.entries[0].status).toBe("xaml-only");
  });

  it("handles partial overlap correctly", () => {
    const sddArtifacts = {
      assets: [
        { name: "SharedAsset", type: "Text" },
        { name: "SddOnly", type: "Integer" },
      ],
    };
    const credInventory: CredentialAssetInventory = {
      entries: [
        { file: "Main.xaml", activityType: "GetAsset", assetName: "SharedAsset", isHardcoded: true, lineNumber: 5, assetValueType: "Text" },
        { file: "Main.xaml", activityType: "GetAsset", assetName: "XamlOnly", isHardcoded: true, lineNumber: 15, assetValueType: "Boolean" },
      ],
      hardcodedCount: 2, variableCount: 0, uniqueAssetNames: ["SharedAsset", "XamlOnly"], uniqueCredentialNames: [],
    };
    const result = crossReferenceArtifacts(sddArtifacts, credInventory, makeQueueResult());
    expect(result.alignedCount).toBe(1);
    expect(result.sddOnlyCount).toBe(1);
    expect(result.xamlOnlyCount).toBe(1);
  });

  it("cross-references queues between SDD and XAML", () => {
    const sddArtifacts = {
      queues: [
        { name: "InvoiceQueue", maxRetries: 5, uniqueReference: true, description: "Invoice processing" },
      ],
    };
    const qResult = makeQueueResult({
      entries: [{ file: "Main.xaml", activityType: "AddQueueItem", queueName: "InvoiceQueue", isHardcoded: true, lineNumber: 10 }],
      uniqueQueues: ["InvoiceQueue"],
    });
    const credInventory: CredentialAssetInventory = {
      entries: [], hardcodedCount: 0, variableCount: 0, uniqueAssetNames: [], uniqueCredentialNames: [],
    };
    const result = crossReferenceArtifacts(sddArtifacts, credInventory, qResult);
    const qEntry = result.entries.find(e => e.type === "queue");
    expect(qEntry).toBeDefined();
    expect(qEntry!.status).toBe("aligned");
    expect(result.sddQueueConfigs).toHaveLength(1);
    expect(result.sddQueueConfigs![0].maxRetries).toBe(5);
    expect(result.sddQueueConfigs![0].uniqueReference).toBe(true);
  });

  it("extracts SDD trigger definitions", () => {
    const sddArtifacts = {
      triggers: [
        { name: "DailyRun", type: "Time", cron: "0 6 * * 1-5", description: "Weekday morning run" },
        { name: "QueueTrigger", type: "Queue", queueName: "WorkQueue" },
      ],
    };
    const credInventory: CredentialAssetInventory = {
      entries: [], hardcodedCount: 0, variableCount: 0, uniqueAssetNames: [], uniqueCredentialNames: [],
    };
    const result = crossReferenceArtifacts(sddArtifacts, credInventory, makeQueueResult());
    expect(result.sddTriggers).toHaveLength(2);
    expect(result.sddTriggers![0].cron).toBe("0 6 * * 1-5");
    expect(result.sddTriggers![1].queueName).toBe("WorkQueue");
  });

  it("handles null SDD artifacts", () => {
    const credInventory: CredentialAssetInventory = {
      entries: [], hardcodedCount: 0, variableCount: 0, uniqueAssetNames: [], uniqueCredentialNames: [],
    };
    const result = crossReferenceArtifacts(null, credInventory, makeQueueResult());
    expect(result.entries).toHaveLength(0);
    expect(result.alignedCount).toBe(0);
  });

  it("handles credential type assets from SDD", () => {
    const sddArtifacts = {
      assets: [{ name: "AppLogin", type: "Credential", description: "App credentials" }],
    };
    const credInventory: CredentialAssetInventory = {
      entries: [{ file: "Main.xaml", activityType: "GetCredential", assetName: "AppLogin", isHardcoded: true, lineNumber: 3, assetValueType: "Credential" }],
      hardcodedCount: 1, variableCount: 0, uniqueAssetNames: [], uniqueCredentialNames: ["AppLogin"],
    };
    const result = crossReferenceArtifacts(sddArtifacts, credInventory, makeQueueResult());
    const credEntry = result.entries.find(e => e.type === "credential");
    expect(credEntry).toBeDefined();
    expect(credEntry!.status).toBe("aligned");
    expect(credEntry!.valueType).toBe("Credential");
  });
});

describe("SDD-derived triggers in suggestTriggers", () => {
  it("uses SDD triggers when provided", () => {
    const sddTriggers = [
      { name: "MorningRun", type: "Time", cron: "0 6 * * 1-5", description: "Daily at 6 AM" },
    ];
    const triggers = suggestTriggers(makeQueueResult(), makeEnvResult(), undefined, sddTriggers);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].triggerType).toBe("Schedule");
    expect(triggers[0].suggestedConfig).toContain("Cron: 0 6 * * 1-5");
    expect(triggers[0].reason).toContain("SDD orchestrator_artifacts");
  });

  it("uses SDD queue trigger with queue name", () => {
    const sddTriggers = [
      { name: "QueueProcessor", type: "Queue", queueName: "InvoiceQueue" },
    ];
    const triggers = suggestTriggers(makeQueueResult(), makeEnvResult(), undefined, sddTriggers);
    expect(triggers[0].triggerType).toBe("Queue");
    expect(triggers[0].suggestedConfig).toContain("Queue: InvoiceQueue");
  });

  it("falls back to XAML analysis when no SDD triggers", () => {
    const triggers = suggestTriggers(makeQueueResult(), makeEnvResult(), undefined, undefined);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].triggerType).toBe("Schedule");
    expect(triggers[0].suggestedConfig).toContain("0 8 * * 1-5");
  });

  it("falls back to XAML analysis when SDD triggers array is empty", () => {
    const triggers = suggestTriggers(makeQueueResult(), makeEnvResult(), undefined, []);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].triggerType).toBe("Schedule");
  });
});

describe("runDhgAnalysis with SDD artifacts", () => {
  it("includes sddCrossReference when SDD artifacts provided", () => {
    const xaml = makeXaml(`<ui:GetAsset AssetName="Config_URL" />`);
    const sddArtifacts = {
      assets: [{ name: "Config_URL", type: "Text" }],
      triggers: [{ name: "DailyRun", type: "Time", cron: "0 7 * * *" }],
    };
    const result = runDhgAnalysis(
      [{ name: "Main.xaml", content: xaml }],
      undefined, 0, 0, undefined, undefined,
      sddArtifacts,
    );
    expect(result.sddCrossReference).toBeDefined();
    expect(result.sddCrossReference!.alignedCount).toBe(1);
    expect(result.triggerSuggestions[0].suggestedConfig).toContain("0 7 * * *");
  });

  it("omits sddCrossReference when no SDD artifacts", () => {
    const result = runDhgAnalysis([]);
    expect(result.sddCrossReference).toBeUndefined();
  });
});

describe("DHG generator - governance checklist", () => {
  function makeMinimalReport2(): PipelineOutcomeReport {
    return {
      remediations: [], propertyRemediations: [], autoRepairs: [],
      downgradeEvents: [], qualityWarnings: [], fullyGeneratedFiles: ["Main.xaml"],
      totalEstimatedEffortMinutes: 0,
    };
  }

  it("includes governance items in pre-deployment checklist", () => {
    const analysis = runDhgAnalysis([{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }]);
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport2(), context);
    expect(md).toContain("UAT test execution completed and sign-off obtained");
    expect(md).toContain("Peer code review completed");
    expect(md).toContain("quality gate warnings addressed");
    expect(md).toContain("Business process owner validation");
    expect(md).toContain("CoE approval obtained");
    expect(md).toContain("Production readiness assessment");
    expect(md).toContain("Governance");
  });
});

describe("DHG generator - process map topology", () => {
  function makeMinimalReport3(): PipelineOutcomeReport {
    return {
      remediations: [], propertyRemediations: [], autoRepairs: [],
      downgradeEvents: [], qualityWarnings: [], fullyGeneratedFiles: ["Main.xaml"],
      totalEstimatedEffortMinutes: 0,
    };
  }

  it("includes Business Process Overview when process steps present", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      {
        processSteps: [
          { name: "Login to SAP", role: "Accountant", system: "SAP", nodeType: "task", isPainPoint: false, description: "Open SAP GUI" },
          { name: "Extract data", role: "Accountant", system: "SAP", nodeType: "task", isPainPoint: true, description: "Manual copy-paste" },
        ],
        painPoints: ["Extract data: Manual copy-paste"],
        systems: ["SAP"],
        roles: ["Accountant"],
      },
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport3(), context);
    expect(md).toContain("Business Process Overview");
    expect(md).toContain("Process Steps");
    expect(md).toContain("Login to SAP");
    expect(md).toContain("Pain Points");
    expect(md).toContain("Manual copy-paste");
    expect(md).toContain("Target Applications / Systems");
    expect(md).toContain("SAP");
    expect(md).toContain("User Roles Involved");
    expect(md).toContain("Accountant");
  });

  it("cross-references systems in environment setup", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      { systems: ["SAP", "Excel"] },
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport3(), context);
    expect(md).toContain("Target Applications (from Process Map)");
    expect(md).toContain("SAP");
    expect(md).toContain("Excel");
  });

  it("omits Business Process Overview when no process data", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      { ideaDescription: "Some automation" },
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport3(), context);
    expect(md).not.toContain("Business Process Overview");
  });
});

describe("DHG generator - SDD artifact cross-reference rendering", () => {
  function makeMinimalReport4(): PipelineOutcomeReport {
    return {
      remediations: [], propertyRemediations: [], autoRepairs: [],
      downgradeEvents: [], qualityWarnings: [], fullyGeneratedFiles: ["Main.xaml"],
      totalEstimatedEffortMinutes: 0,
    };
  }

  it("renders SDD × XAML Artifact Reconciliation section", () => {
    const sddArtifacts = {
      assets: [
        { name: "Config_URL", type: "Text" },
        { name: "SddOnlyAsset", type: "Integer" },
      ],
    };
    const xaml = makeXaml(`
      <ui:GetAsset AssetName="Config_URL" />
      <ui:GetAsset AssetName="XamlOnlyAsset" />
    `);
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: xaml }],
      undefined, 0, 0, undefined, undefined,
      sddArtifacts,
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport4(), context);
    expect(md).toContain("SDD × XAML Artifact Reconciliation");
    expect(md).toContain("Aligned");
    expect(md).toContain("SDD Only");
    expect(md).toContain("XAML Only");
  });

  it("renders SDD queue configs in queue section", () => {
    const sddArtifacts = {
      queues: [{ name: "WorkQueue", maxRetries: 5, uniqueReference: true, sla: "30 minutes" }],
    };
    const xaml = makeXaml(`<ui:GetTransactionItem QueueName="WorkQueue" /><ui:SetTransactionStatus />`);
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: xaml }],
      undefined, 0, 0, undefined, undefined,
      sddArtifacts,
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport4(), context);
    expect(md).toContain("5x, SDD");
    expect(md).toContain("Yes (SDD)");
    expect(md).toContain("30 minutes");
  });

  it("renders SDD triggers in trigger section", () => {
    const sddArtifacts = {
      triggers: [{ name: "NightlyBatch", type: "Time", cron: "0 2 * * *", description: "Run at 2 AM" }],
    };
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined, undefined,
      sddArtifacts,
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport4(), context);
    expect(md).toContain("SDD-specified: NightlyBatch");
    expect(md).toContain("Cron: 0 2 * * *");
  });
});

describe("DHG generator - structured upstream context", () => {
  function makeMinimalReport5(): PipelineOutcomeReport {
    return {
      remediations: [], propertyRemediations: [], autoRepairs: [],
      downgradeEvents: [], qualityWarnings: [], fullyGeneratedFiles: ["Main.xaml"],
      totalEstimatedEffortMinutes: 0,
    };
  }

  it("includes automation type rationale", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      { automationType: "rpa", automationTypeRationale: "Structured data processing with SAP" },
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport5(), context);
    expect(md).toContain("Rationale");
    expect(md).toContain("Structured data processing with SAP");
  });

  it("includes feasibility complexity and effort estimate", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      { feasibilityComplexity: "Medium", feasibilityEffortEstimate: "4-6 weeks" },
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalReport5(), context);
    expect(md).toContain("Feasibility Complexity");
    expect(md).toContain("Medium");
    expect(md).toContain("Effort Estimate");
    expect(md).toContain("4-6 weeks");
  });
});

function makeMinimalOutcomeReport(): PipelineOutcomeReport {
  return {
    remediations: [], propertyRemediations: [], autoRepairs: [],
    downgradeEvents: [], qualityWarnings: [], fullyGeneratedFiles: ["Main.xaml"],
    totalEstimatedEffortMinutes: 0,
  } as PipelineOutcomeReport;
}

describe("Edge Cases (Code Review Fixes)", () => {
  it("normalizes SDD trigger types case-insensitively", () => {
    const sddTriggers = [
      { name: "T1", type: "queue", cron: "", queueName: "Q1" },
      { name: "T2", type: "TIME", cron: "0 8 * * *" },
      { name: "T3", type: "Api" },
      { name: "T4", type: "EVENT" },
      { name: "T5", type: "  Schedule  " },
      { name: "T6", type: "webhook" },
      { name: "T7", type: "cron", cron: "0 6 * * 1" },
    ];
    const queueResult = makeQueueResult();
    const envResult: EnvironmentRequirements = {
      targetFramework: "Windows",
      robotType: "Unattended",
      requiresBrowserExtension: false,
      nugetDependencies: [],
    };
    const result = suggestTriggers(queueResult, envResult, undefined, sddTriggers);
    expect(result[0].triggerType).toBe("Queue");
    expect(result[1].triggerType).toBe("Schedule");
    expect(result[2].triggerType).toBe("API/Webhook");
    expect(result[3].triggerType).toBe("EventBased");
    expect(result[4].triggerType).toBe("Schedule");
    expect(result[5].triggerType).toBe("API/Webhook");
    expect(result[6].triggerType).toBe("Schedule");
  });

  it("trims artifact names in cross-referencing to avoid false gaps", () => {
    const credInventory: CredentialAssetInventory = {
      entries: [
        { activityType: "GetAsset", assetName: "  MyAsset  ", isHardcoded: true, file: "Main.xaml", lineNumber: 5 },
        { activityType: "GetCredential", assetName: "MyCred ", isHardcoded: true, file: "Main.xaml", lineNumber: 10 },
      ],
      hardcodedCount: 2,
      variableCount: 0,
      uniqueAssetNames: ["  MyAsset  "],
      uniqueCredentialNames: ["MyCred "],
    };
    const queueMgmt = makeQueueResult({ uniqueQueues: [" OrderQueue "], entries: [{ queueName: " OrderQueue ", activityType: "AddQueueItem", isHardcoded: true, file: "Main.xaml", lineNumber: 15 }] });
    const sddArtifacts = {
      assets: [
        { name: "MyAsset", type: "Text", value: "v" },
        { name: "MyCred", type: "Credential", value: "" },
      ],
      queues: [{ name: "OrderQueue", maxRetries: 3 }],
    };
    const result = crossReferenceArtifacts(sddArtifacts, credInventory, queueMgmt);
    const aligned = result.entries.filter(e => e.status === "aligned");
    const sddOnly = result.entries.filter(e => e.status === "sdd-only");
    const xamlOnly = result.entries.filter(e => e.status === "xaml-only");
    expect(aligned.length).toBe(3);
    expect(sddOnly.length).toBe(0);
    expect(xamlOnly.length).toBe(0);
  });

  it("surfaces SDD-only queue configs in DHG output", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`
        <ui:AddQueueItem QueueName="OrderQueue" />
      `) }],
      undefined, 0, 0, undefined, undefined,
      { queues: [
        { name: "OrderQueue", maxRetries: 3 },
        { name: "RefundQueue", maxRetries: 5, sla: "2h", uniqueReference: true },
      ]}
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalOutcomeReport(), context);
    expect(md).toContain("SDD-Defined Queues (Not Yet in XAML)");
    expect(md).toContain("RefundQueue");
    expect(md).toContain("5x");
    expect(md).toContain("2h");
  });

  it("renders decision branch topology from processEdges", () => {
    const analysis = runDhgAnalysis(
      [{ name: "Main.xaml", content: makeXaml(`<ui:LogMessage Text="Hi" />`) }],
      undefined, 0, 0, undefined,
      {
        processSteps: [
          { name: "Start", role: "", system: "", nodeType: "start", isPainPoint: false, description: "" },
          { name: "Validate Input", role: "Clerk", system: "SAP", nodeType: "task", isPainPoint: false, description: "" },
          { name: "Amount > 1000?", role: "", system: "", nodeType: "decision", isPainPoint: false, description: "Threshold check" },
          { name: "Manager Approval", role: "Manager", system: "Email", nodeType: "task", isPainPoint: false, description: "" },
          { name: "Auto Approve", role: "", system: "SAP", nodeType: "task", isPainPoint: false, description: "" },
        ],
        decisionBranches: [
          {
            decisionNodeName: "Amount > 1000?",
            branches: [
              { label: "Yes", targetNodeName: "Manager Approval" },
              { label: "No", targetNodeName: "Auto Approve" },
            ],
          },
        ],
      },
    );
    const context: DhgContext = { projectName: "TestProject", workflowNames: ["Main"], analysis };
    const md = generateDhgFromOutcomeReport(makeMinimalOutcomeReport(), context);
    expect(md).toContain("Decision Points (Process Map Topology)");
    expect(md).toContain("Amount > 1000?");
    expect(md).toContain("[Yes]");
    expect(md).toContain("Manager Approval");
    expect(md).toContain("[No]");
    expect(md).toContain("Auto Approve");
  });
});
