import type { UiPathPackage } from "./types/uipath-package";
import type {
  UiPathConnectorRecommendation,
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

const CONNECTOR_INFERENCE_RULES: Array<{
  connectorName: string;
  sourceSystems: string[];
  keywords: string[];
  usedActions?: string[];
}> = [
  {
    connectorName: "Microsoft 365",
    sourceSystems: ["Outlook", "SharePoint", "Teams", "OneDrive"],
    keywords: ["outlook", "sharepoint", "teams", "onedrive", "microsoft 365", "office 365"],
    usedActions: ["Send email", "Read list items", "Upload file"],
  },
  {
    connectorName: "Salesforce",
    sourceSystems: ["Salesforce"],
    keywords: ["salesforce", "crm object", "lead", "opportunity", "case"],
    usedActions: ["Get record", "Update record", "Create record"],
  },
  {
    connectorName: "ServiceNow",
    sourceSystems: ["ServiceNow"],
    keywords: ["servicenow", "incident", "service request", "ticket"],
    usedActions: ["Create ticket", "Update incident"],
  },
  {
    connectorName: "SAP",
    sourceSystems: ["SAP"],
    keywords: ["sap", "s/4hana", "ecc", "sap gui"],
    usedActions: ["Invoke BAPI", "Read business object"],
  },
  {
    connectorName: "Workday",
    sourceSystems: ["Workday"],
    keywords: ["workday", "worker", "hris", "new joiner"],
    usedActions: ["Get worker", "Update worker"],
  },
  {
    connectorName: "Coupa",
    sourceSystems: ["Coupa"],
    keywords: ["coupa", "purchase order", "invoice", "supplier"],
    usedActions: ["Get purchase order", "Get invoice", "Create comment"],
  },
  {
    connectorName: "Gmail",
    sourceSystems: ["Gmail"],
    keywords: ["gmail", "google mail"],
    usedActions: ["Send email", "Search messages"],
  },
  {
    connectorName: "Slack",
    sourceSystems: ["Slack"],
    keywords: ["slack", "channel", "direct message"],
    usedActions: ["Post message", "Read channel history"],
  },
  {
    connectorName: "Jira",
    sourceSystems: ["Jira"],
    keywords: ["jira", "issue", "epic", "story"],
    usedActions: ["Create issue", "Update issue"],
  },
];

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => safeText(value)).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function inferConnectorRecommendations(pkg: UiPathPackage, orchestratorArtifacts: any): UiPathConnectorRecommendation[] {
  const explicitConnectors = safeArray(orchestratorArtifacts?.integrationServiceConnectors)
    .map((connector: any) => ({
      connectorName: safeText(connector?.connectorName || connector?.name || connector?.system),
      sourceSystems: uniqueSorted([
        connector?.system,
        connector?.connectionName,
        connector?.connectorName,
      ]),
      rationale: safeText(
        connector?.description,
        "Integration Service connector dependency identified in the generated orchestrator artifacts.",
      ),
      usedActions: uniqueSorted(safeArray<string>(connector?.usedActions || connector?.usedTriggers)),
    }))
    .filter((connector) => connector.connectorName);

  const knownConnectorNames = new Set(explicitConnectors.map((connector) => connector.connectorName.toLowerCase()));
  const sourceSystems = uniqueSorted([
    ...safeArray(pkg.internal?.processNodes).map((node: any) => safeText(node?.system)),
    ...safeArray(orchestratorArtifacts?.processes).map((process: any) => safeText(process?.system)),
  ]);
  const corpus = `${safeText(pkg.projectName)} ${safeText(pkg.description)} ${flattenSignalText([
    pkg.internal?.sddContent,
    pkg.internal?.processNodes,
    pkg.workflows,
    orchestratorArtifacts,
  ]).join(" ")}`.toLowerCase();

  const inferred = CONNECTOR_INFERENCE_RULES
    .filter((rule) => !knownConnectorNames.has(rule.connectorName.toLowerCase()))
    .filter((rule) => rule.keywords.some((keyword) => corpus.includes(keyword)))
    .map<UiPathConnectorRecommendation>((rule) => ({
      connectorName: rule.connectorName,
      sourceSystems: uniqueSorted(sourceSystems.filter((system) => rule.keywords.some((keyword) => system.toLowerCase().includes(keyword)) || rule.sourceSystems.includes(system))),
      rationale: `The use case references ${rule.sourceSystems.join(", ")} patterns, so the ${rule.connectorName} Integration Service connector should be preferred over custom API plumbing where available.`,
      usedActions: rule.usedActions,
    }));

  return [...explicitConnectors, ...inferred];
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
  const triggerCount = safeArray(orchestratorArtifacts?.triggers).length;
  const appCount = safeArray(orchestratorArtifacts?.apps).length;
  const dataFabricEntityCount = safeArray(orchestratorArtifacts?.dataFabricEntities).length;
  const sharedResourceCount = queueCount + assetCount + storageBucketCount + actionCatalogCount + integrationCount;
  const connectorRecommendations = inferConnectorRecommendations(pkg, orchestratorArtifacts);
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
  if (dataFabricEntityCount > 0) {
    recommendedProducts.add("Data Service");
  }
  if (appCount > 0) {
    recommendedProducts.add("Apps");
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

  if (connectorRecommendations.length > 0) {
    rationale.push(`Integration Service should be used for ${connectorRecommendations.map((connector) => connector.connectorName).join(", ")} connector dependencies.`);
  }

  return {
    recommendedOutput,
    recommendedModality,
    recommendedExecutionModel,
    recommendedProducts: Array.from(recommendedProducts),
    connectorRecommendations,
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
      triggerCount,
      appCount,
      dataFabricEntityCount,
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
