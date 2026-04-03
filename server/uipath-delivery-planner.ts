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

  const rationale: string[] = [];
  let recommendedOutput: "package" | "solution" = "package";

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

  return {
    recommendedOutput,
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
