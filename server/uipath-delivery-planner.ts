import type { UiPathPackage } from "./types/uipath-package";
import type {
  UiPathDeliveryRecommendation,
  UiPathTestCase,
  UiPathTestSet,
} from "./types/uipath-solution";

function safeArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function safeText(value: any, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function flattenSignalText(value: any, output: string[] = []): string[] {
  if (value == null) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    if (text) output.push(text);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenSignalText(item, output);
    return output;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(value)) flattenSignalText(nested, output);
  }
  return output;
}

function countKeywordSignals(haystack: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) count++;
  }
  return count;
}

export function extractUiPathTestDesign(orchestratorArtifacts: any): {
  testCases: UiPathTestCase[];
  testSets: UiPathTestSet[];
} {
  const testCases = safeArray(orchestratorArtifacts?.testCases).map((testCase: any, index: number) => ({
    name: safeText(testCase?.name, `TC${String(index + 1).padStart(3, "0")}`),
    description: safeText(testCase?.description, "Generated validation scenario"),
    steps: safeArray(testCase?.steps).map((step: any, stepIndex: number) => ({
      action: safeText(step?.action, `Execute step ${stepIndex + 1}`),
      expected: safeText(step?.expected, "Expected result not specified"),
    })),
  })).filter((testCase) => testCase.name);

  const testSets = safeArray(orchestratorArtifacts?.testSets).map((testSet: any, index: number) => ({
    name: safeText(testSet?.name, `Test Set ${index + 1}`),
    description: safeText(testSet?.description, "Generated grouped validation scenarios"),
    testCaseNames: safeArray<string>(testSet?.testCaseNames)
      .map((name) => safeText(name))
      .filter(Boolean),
  })).filter((testSet) => testSet.name);

  return { testCases, testSets };
}

export function recommendUiPathDelivery(params: {
  pkg: UiPathPackage;
  orchestratorArtifacts: any;
}): UiPathDeliveryRecommendation {
  const { pkg, orchestratorArtifacts } = params;
  const automationType = pkg.internal?.automationType || "rpa";
  const workflowCount = safeArray(pkg.workflows).length;
  const queueCount = safeArray(orchestratorArtifacts?.queues).length;
  const assetCount = safeArray(orchestratorArtifacts?.assets).length;
  const storageBucketCount = safeArray(orchestratorArtifacts?.storageBuckets).length;
  const actionCatalogCount = safeArray(orchestratorArtifacts?.actionCenter).length + safeArray(orchestratorArtifacts?.actionCatalogs).length;
  const integrationCount = safeArray(orchestratorArtifacts?.integrationServiceConnectors).length;
  const sharedResourceCount = queueCount + assetCount + storageBucketCount + actionCatalogCount + integrationCount;
  const signalCorpus = flattenSignalText([
    pkg.projectName,
    pkg.description,
    pkg.internal?.sddContent,
    pkg.internal?.processNodes,
    pkg.workflows?.map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      steps: workflow.steps?.map((step) => ({
        activity: step.activity,
        activityType: step.activityType,
        notes: step.notes,
      })),
    })),
    orchestratorArtifacts,
  ]).join(" ").toLowerCase();

  const uiInteractionSignalCount = countKeywordSignals(signalCorpus, [
    "selector",
    "browser",
    "window",
    "desktop",
    "click",
    "type into",
    "screen",
    "application scope",
    "use application",
  ]);
  const assistantSignalCount = countKeywordSignals(signalCorpus, [
    "assistant",
    "attended",
    "user launches",
    "employee runs",
    "desktop helper",
  ]);
  const appSignalCount = countKeywordSignals(signalCorpus, [
    "app",
    "portal",
    "dashboard",
    "form",
    "self-service",
    "request submission",
  ]);
  const apiSignalCount = countKeywordSignals(signalCorpus, [
    "api",
    "webhook",
    "endpoint",
    "rest",
    "http",
    "json",
    "integration service",
  ]);
  const humanInLoopSignalCount = countKeywordSignals(signalCorpus, [
    "action center",
    "approval",
    "review",
    "human in the loop",
    "manual review",
    "validation",
    "exception handling",
  ]);

  const rationale: string[] = [];
  let recommendedOutput: "package" | "solution" = "package";
  let recommendedModality: UiPathDeliveryRecommendation["recommendedModality"] = "unattended_robot";
  let recommendedExecutionModel: UiPathDeliveryRecommendation["recommendedExecutionModel"] = "unattended";
  const recommendedProducts = new Set<string>(["Orchestrator"]);

  if (automationType === "agent" || automationType === "hybrid") {
    recommendedOutput = "solution";
    rationale.push(`Automation type is ${automationType}, which benefits from a broader solution wrapper.`);
  }

  if (workflowCount > 1) {
    recommendedOutput = "solution";
    rationale.push(`${workflowCount} workflows were generated, which is better managed as a solution than a single package.`);
  }

  if (sharedResourceCount > 0) {
    recommendedOutput = "solution";
    rationale.push(`${sharedResourceCount} shared UiPath resource(s) were identified (queues/assets/storage/connections/action catalogs).`);
  }

  if (recommendedOutput === "package") {
    rationale.push("This use case is a simpler single-project automation with little or no shared solution resource surface.");
  } else if (queueCount === 0 && assetCount === 0 && storageBucketCount === 0 && integrationCount === 0 && workflowCount <= 1 && automationType === "rpa") {
    rationale.push("Even though the automation is RPA-only, the surrounding design signals still favor solution lifecycle management.");
  }

  if (integrationCount > 0 || apiSignalCount > 0) {
    recommendedProducts.add("Integration Service");
  }
  if (queueCount > 0) {
    recommendedProducts.add("Queues");
  }
  if (actionCatalogCount > 0 || humanInLoopSignalCount > 0) {
    recommendedProducts.add("Action Center");
  }

  if (automationType === "agent") {
    recommendedModality = "agent_orchestrated";
    recommendedExecutionModel = actionCatalogCount > 0 || humanInLoopSignalCount > 0 ? "hybrid" : "unattended";
    recommendedProducts.add("Agents");
    rationale.push("Agent automation signals were detected, so an agent-orchestrated delivery model is recommended.");
  } else if (appSignalCount >= 2 || actionCatalogCount > 0) {
    recommendedModality = "app_fronted_process";
    recommendedExecutionModel = "hybrid";
    recommendedProducts.add("Apps");
    rationale.push("The use case includes human-facing forms/review patterns, so an Apps + process experience is recommended.");
  } else if ((assistantSignalCount > 0 || uiInteractionSignalCount >= 3) && queueCount === 0 && actionCatalogCount === 0) {
    recommendedModality = "attended_assistant";
    recommendedExecutionModel = "attended";
    recommendedProducts.add("Assistant");
    rationale.push("Desktop/UI-heavy interaction signals favor an attended Assistant-driven experience over a purely unattended bot.");
  } else if (apiSignalCount >= 2 && uiInteractionSignalCount === 0 && appSignalCount === 0) {
    recommendedModality = "api_workflow";
    recommendedExecutionModel = "unattended";
    recommendedProducts.add("Integration Service");
    rationale.push("API/webhook-led signals dominate this use case, so an API workflow pattern is recommended.");
  } else {
    recommendedModality = "unattended_robot";
    recommendedExecutionModel = actionCatalogCount > 0 ? "hybrid" : "unattended";
    rationale.push("The default recommendation is an unattended robot pattern with Orchestrator-managed execution.");
  }

  return {
    recommendedOutput,
    recommendedModality,
    recommendedExecutionModel,
    recommendedProducts: Array.from(recommendedProducts),
    rationale,
    signals: {
      automationType,
      workflowCount,
      queueCount,
      assetCount,
      storageBucketCount,
      actionCatalogCount,
      integrationCount,
      sharedResourceCount,
      uiInteractionSignalCount,
      assistantSignalCount,
      appSignalCount,
      apiSignalCount,
      humanInLoopSignalCount,
    },
  };
}

export function renderUiPathTestCasesMarkdown(params: {
  projectName: string;
  testCases: UiPathTestCase[];
  testSets: UiPathTestSet[];
}): string {
  const { projectName, testCases, testSets } = params;
  const lines: string[] = [
    `# ${projectName} Test Cases`,
    "",
  ];

  if (testCases.length === 0) {
    lines.push("No explicit test cases were generated from the use case artifacts.");
  } else {
    for (const testCase of testCases) {
      lines.push(`## ${testCase.name}`);
      lines.push("");
      lines.push(testCase.description || "No description provided.");
      lines.push("");
      if (testCase.steps.length === 0) {
        lines.push("No detailed steps were generated.");
        lines.push("");
        continue;
      }
      lines.push("| Step | Action | Expected |");
      lines.push("| --- | --- | --- |");
      testCase.steps.forEach((step, index) => {
        lines.push(`| ${index + 1} | ${step.action.replace(/\|/g, "\\|")} | ${step.expected.replace(/\|/g, "\\|")} |`);
      });
      lines.push("");
    }
  }

  if (testSets.length > 0) {
    lines.push("## Test Sets");
    lines.push("");
    for (const testSet of testSets) {
      lines.push(`### ${testSet.name}`);
      lines.push("");
      lines.push(testSet.description || "No description provided.");
      lines.push("");
      if (testSet.testCaseNames.length > 0) {
        lines.push(`Includes: ${testSet.testCaseNames.join(", ")}`);
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}
