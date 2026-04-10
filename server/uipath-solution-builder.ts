import { randomUUID } from "crypto";
import AdmZip from "adm-zip";
import { generateConfigXlsx } from "./package-assembler";
import type { BuildResult } from "./package-assembler";
import type { IdeaContext } from "./uipath-pipeline";
import type { UiPathPackage } from "./types/uipath-package";
import type {
  UiPathDeliveryRecommendation,
  UiPathExecutiveSummary,
  UiPathNativeSolutionProjectType,
  UiPathOperatingModelSummary,
  UiPathPlatformOpsSummary,
  UiPathReportingSummary,
  UiPathReleaseReadinessSummary,
  UiPathSolutionArtifact,
  UiPathSolutionComponent,
  UiPathSolutionManifest,
  UiPathSolutionResourceSummary,
  UiPathTestReleaseSummary,
  UiPathTestCase,
  UiPathTestSet,
} from "./types/uipath-solution";
import { renderUiPathTestCasesMarkdown } from "./uipath-delivery-planner";

function sanitizeName(value: string): string {
  return (value || "UiPathSolution")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "UiPathSolution";
}

function normalizeFolderName(value: string): string {
  return (value || "UiPath Project")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "UiPath Project";
}

function resourceFileBase(value: string): string {
  return sanitizeName(value).replace(/-/g, "_") || "UiPath_Project";
}

function processPackageName(solutionName: string, projectName: string): string {
  const dots = `${solutionName}.process.${projectName}`
    .replace(/[^A-Za-z0-9]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");

  return dots || "Solution.process.UiPath.Project";
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

function safeArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function buildOperatingModelSummary(params: {
  orchestratorArtifacts: any;
  recommendation?: UiPathDeliveryRecommendation;
}): UiPathOperatingModelSummary {
  const { orchestratorArtifacts, recommendation } = params;
  const triggerNames = safeArray(orchestratorArtifacts?.triggers)
    .map((trigger: any) => String(trigger?.name || "").trim())
    .filter(Boolean);
  const connectorNames = [
    ...safeArray(orchestratorArtifacts?.integrationServiceConnectors).map((connector: any) => String(connector?.connectorName || connector?.name || connector?.system || "").trim()),
    ...safeArray(recommendation?.connectorRecommendations).map((connector) => connector.connectorName),
  ].filter(Boolean);
  const appNames = safeArray(orchestratorArtifacts?.apps)
    .map((app: any) => String(app?.name || "").trim())
    .filter(Boolean);
  const entityNames = safeArray(orchestratorArtifacts?.dataFabricEntities)
    .map((entity: any) => String(entity?.name || "").trim())
    .filter(Boolean);

  const runtimeProfile = recommendation?.recommendedExecutionModel === "attended"
    ? "Attended user-launched execution with Assistant guidance."
    : recommendation?.recommendedExecutionModel === "hybrid"
      ? "Hybrid execution with unattended processing plus human review/approval touchpoints."
      : "Fully unattended Orchestrator-managed execution.";

  const triggerStrategy = triggerNames.length > 0
    ? `Primary trigger model: ${triggerNames.join(", ")}.`
    : recommendation?.recommendedModality === "api_workflow"
      ? "Primary trigger model: API/webhook-led invocation."
      : "Primary trigger model: orchestrated schedule or manual deployment-time configuration.";

  const recommendedRobotType = recommendation?.recommendedExecutionModel === "attended"
    ? "Attended / Assistant robot"
    : recommendation?.recommendedExecutionModel === "hybrid"
      ? "Unattended robots with Action Center / Apps support"
      : "Unattended robot";

  const readinessNotes = [
    "Provision queues, assets, storage buckets, and integration dependencies before go-live.",
    "Validate deployment gates and contract-integrity checks before release.",
  ];
  if (triggerNames.length === 0) readinessNotes.push("No trigger artifact was generated yet — deployment should confirm the production trigger strategy.");
  if (connectorNames.length > 0) readinessNotes.push(`Integration Service connections required: ${Array.from(new Set(connectorNames)).join(", ")}.`);
  if (entityNames.length > 0) readinessNotes.push(`Data persistence model includes Data Service entities: ${entityNames.join(", ")}.`);
  if (appNames.length > 0) readinessNotes.push(`User-facing Apps surfaces expected: ${appNames.join(", ")}.`);

  return {
    runtimeProfile,
    recommendedFolderStrategy: "Deploy into a stable solution folder per use case so processes, queues, assets, and tests evolve together.",
    recommendedRobotType,
    triggerStrategy,
    supportModel: "Operations should use deployment reports, validation gates, generated test artifacts, and handoff/governance docs as the primary support pack.",
    deploymentReadinessNotes: readinessNotes,
    integrationServiceConnectors: Array.from(new Set(connectorNames)).sort((a, b) => a.localeCompare(b)),
    apps: Array.from(new Set(appNames)).sort((a, b) => a.localeCompare(b)),
    dataFabricEntities: Array.from(new Set(entityNames)).sort((a, b) => a.localeCompare(b)),
    triggerNames: Array.from(new Set(triggerNames)).sort((a, b) => a.localeCompare(b)),
    governanceArtifacts: ["PDD", "SDD", "DSD", "Developer Handoff Guide", "Test Cases"],
  };
}

function buildPlatformOpsSummary(params: {
  recommendation?: UiPathDeliveryRecommendation;
  operatingModel: UiPathOperatingModelSummary;
  resources: UiPathSolutionResourceSummary;
  testCaseCount: number;
}): UiPathPlatformOpsSummary {
  const { recommendation, operatingModel, resources, testCaseCount } = params;
  const managementSurfaces = new Set<string>(["Orchestrator"]);
  const deploymentInterfaces = ["Package upload API", "Native solution CLI/API flow"];
  const fallbackStrategy = [
    "Prefer UiPath CLI for packaging and solution operations when supported in the target environment.",
    "Fall back to Orchestrator/Test Manager REST APIs for resource provisioning, linking, and diagnostics when CLI coverage is incomplete.",
  ];
  const operationalChecks = [
    "Confirm target folder, queues, assets, buckets, and triggers before deployment.",
    "Run Workflow Analyzer and contract-integrity gates before promoting the artifact.",
    "Verify published package or solution version matches the generated release notes and artifact metadata.",
  ];

  if ((recommendation?.recommendedProducts || []).includes("Integration Service") || resources.integrations.length > 0) {
    managementSurfaces.add("Integration Service");
    operationalChecks.push("Validate Integration Service connections and connector permissions before cutover.");
  }
  if ((recommendation?.recommendedProducts || []).includes("Action Center")) {
    managementSurfaces.add("Action Center");
    operationalChecks.push("Confirm Action Center catalogs, SLAs, and reviewer permissions before launch.");
  }
  if ((recommendation?.recommendedProducts || []).includes("Apps") || operatingModel.apps.length > 0) {
    managementSurfaces.add("Apps");
    operationalChecks.push("Validate the user-facing Apps surface and routing before enabling production users.");
  }
  if ((recommendation?.recommendedProducts || []).includes("Data Service") || operatingModel.dataFabricEntities.length > 0) {
    managementSurfaces.add("Data Service");
    operationalChecks.push("Validate Data Service entities and access policies before deployment.");
  }
  if (testCaseCount > 0) {
    managementSurfaces.add("Test Manager");
    deploymentInterfaces.push("UiPath Tests publish flow");
    operationalChecks.push("Publish the generated UiPath Tests project and verify Test Manager automation links before release.");
  }

  return {
    authenticationModel: "External application OAuth client-credentials authentication with folder-scoped deployment targeting.",
    deploymentInterfaces,
    managementSurfaces: Array.from(managementSurfaces),
    fallbackStrategy,
    operationalChecks,
  };
}

function renderOperatingModelMarkdown(params: {
  projectName: string;
  operatingModel: UiPathOperatingModelSummary;
  resources: UiPathSolutionResourceSummary;
}): string {
  const { projectName, operatingModel, resources } = params;
  const lines = [
    `# ${projectName} Operating Model`,
    "",
    "## Runtime Profile",
    operatingModel.runtimeProfile,
    "",
    "## Deployment Strategy",
    operatingModel.recommendedFolderStrategy,
    "",
    "## Robot and Trigger Strategy",
    `- Robot model: ${operatingModel.recommendedRobotType}`,
    `- Trigger strategy: ${operatingModel.triggerStrategy}`,
    "",
    "## Provisioned Resource Surface",
    `- Queues: ${resources.queues.length > 0 ? resources.queues.join(", ") : "None"}`,
    `- Assets: ${resources.assets.length > 0 ? resources.assets.join(", ") : "None"}`,
    `- Storage buckets: ${resources.storageBuckets.length > 0 ? resources.storageBuckets.join(", ") : "None"}`,
    `- Action Center catalogs: ${resources.actionCatalogs.length > 0 ? resources.actionCatalogs.join(", ") : "None"}`,
    `- Processes: ${resources.processes.length > 0 ? resources.processes.join(", ") : "None"}`,
    `- Integration dependencies: ${operatingModel.integrationServiceConnectors.length > 0 ? operatingModel.integrationServiceConnectors.join(", ") : "None"}`,
    "",
    "## Deployment Readiness Notes",
    ...operatingModel.deploymentReadinessNotes.map((note) => `- ${note}`),
    "",
    "## Governance and Support Pack",
    ...operatingModel.governanceArtifacts.map((artifact) => `- ${artifact}`),
    "",
    "## Support Model",
    operatingModel.supportModel,
    "",
  ];
  return lines.join("\n");
}

function renderPlatformOpsMarkdown(params: {
  projectName: string;
  platformOps: UiPathPlatformOpsSummary;
}): string {
  const { projectName, platformOps } = params;
  const lines = [
    `# ${projectName} Platform Operations Guide`,
    "",
    "## Authentication Model",
    platformOps.authenticationModel,
    "",
    "## Deployment Interfaces",
    ...platformOps.deploymentInterfaces.map((item) => `- ${item}`),
    "",
    "## Management Surfaces",
    ...platformOps.managementSurfaces.map((item) => `- ${item}`),
    "",
    "## Fallback Strategy",
    ...platformOps.fallbackStrategy.map((item) => `- ${item}`),
    "",
    "## Operational Checks",
    ...platformOps.operationalChecks.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

function renderActivityPackagePlanMarkdown(params: {
  projectName: string;
  recommendation?: UiPathDeliveryRecommendation;
}): string {
  const { projectName, recommendation } = params;
  const packageRecommendations = recommendation?.activityPackageRecommendations || [];
  const lines = [
    `# ${projectName} Activity Package Plan`,
    "",
  ];

  if (packageRecommendations.length === 0) {
    lines.push("No explicit activity-package recommendations were inferred from the generated workflow plan.");
    lines.push("");
    return lines.join("\n");
  }

  for (const packageRecommendation of packageRecommendations) {
    lines.push(`## ${packageRecommendation.packageName}`);
    lines.push("");
    lines.push(`- Capability area: ${packageRecommendation.capabilityArea}`);
    lines.push(`- Rationale: ${packageRecommendation.rationale}`);
    lines.push(`- Referenced activities: ${packageRecommendation.referencedActivities.length > 0 ? packageRecommendation.referencedActivities.join(", ") : "None explicitly identified"}`);
    lines.push("");
  }

  return lines.join("\n");
}

function buildReleaseReadinessSummary(params: {
  recommendation?: UiPathDeliveryRecommendation;
  operatingModel: UiPathOperatingModelSummary;
  resources: UiPathSolutionResourceSummary;
  hasPdd: boolean;
  hasSdd: boolean;
  hasDsd: boolean;
  hasDhg: boolean;
  testCaseCount: number;
  testSetCount: number;
}): UiPathReleaseReadinessSummary {
  const {
    recommendation,
    operatingModel,
    resources,
    hasPdd,
    hasSdd,
    hasDsd,
    hasDhg,
    testCaseCount,
    testSetCount,
  } = params;

  let score = 0;
  const strengths: string[] = [];
  const outstandingItems: string[] = [];
  const releaseGates: string[] = [
    "Workflow Analyzer gate passes",
    "Contract integrity validation passes",
    "Deployment target and resources are confirmed",
  ];

  if (hasPdd) {
    score += 10;
    strengths.push("PDD generated");
  } else {
    outstandingItems.push("PDD is missing");
  }
  if (hasSdd) {
    score += 15;
    strengths.push("SDD generated");
  } else {
    outstandingItems.push("SDD is missing");
  }
  if (hasDsd) {
    score += 10;
    strengths.push("DSD generated");
  } else {
    outstandingItems.push("DSD is missing");
  }
  if (hasDhg) {
    score += 10;
    strengths.push("Developer handoff guide present");
  } else {
    outstandingItems.push("Developer handoff guide is missing");
  }
  if (resources.queues.length + resources.assets.length + resources.storageBuckets.length + resources.actionCatalogs.length + resources.integrations.length > 0) {
    score += 15;
    strengths.push("Deployment resource model defined");
  } else {
    outstandingItems.push("No deployment resources were defined");
  }
  if (testCaseCount > 0) {
    score += 15;
    strengths.push(`${testCaseCount} generated test case(s)`);
    releaseGates.push("Test automation artifacts are published and linked in Test Manager");
  } else {
    outstandingItems.push("No generated test cases found");
  }
  if (testSetCount > 0) {
    score += 5;
    strengths.push(`${testSetCount} generated test set(s)`);
  } else {
    outstandingItems.push("No generated test sets found");
  }
  if ((operatingModel.deploymentReadinessNotes?.length ?? 0) > 0) {
    score += 10;
    strengths.push("Operating model and deployment-readiness notes generated");
  }
  if ((recommendation?.connectorRecommendations.length ?? 0) > 0 || resources.integrations.length > 0) {
    score += 10;
    strengths.push("Integration dependency model captured");
  }

  score = Math.min(score, 100);
  const status: UiPathReleaseReadinessSummary["status"] =
    score >= 80 ? "ready" : score >= 60 ? "mostly_ready" : "needs_work";

  return {
    score,
    status,
    strengths,
    outstandingItems,
    releaseGates,
  };
}

function renderGovernancePackMarkdown(params: {
  projectName: string;
  operatingModel: UiPathOperatingModelSummary;
  releaseReadiness: UiPathReleaseReadinessSummary;
}): string {
  const { projectName, operatingModel, releaseReadiness } = params;
  const lines = [
    `# ${projectName} Governance Pack`,
    "",
    "## Release Readiness",
    `- Score: ${releaseReadiness.score}/100`,
    `- Status: ${releaseReadiness.status}`,
    "",
    "## Strengths",
    ...releaseReadiness.strengths.map((item) => `- ${item}`),
    "",
    "## Outstanding Items",
    ...(releaseReadiness.outstandingItems.length > 0
      ? releaseReadiness.outstandingItems.map((item) => `- ${item}`)
      : ["- No major outstanding items were identified in the generated pack."]),
    "",
    "## Release Gates",
    ...releaseReadiness.releaseGates.map((gate) => `- ${gate}`),
    "",
    "## Operating Model References",
    `- Runtime profile: ${operatingModel.runtimeProfile}`,
    `- Trigger strategy: ${operatingModel.triggerStrategy}`,
    `- Support model: ${operatingModel.supportModel}`,
    "",
  ];
  return lines.join("\n");
}

function buildTestReleaseSummary(params: {
  projectName: string;
  testCases: UiPathTestCase[];
  testSets: UiPathTestSet[];
  recommendation?: UiPathDeliveryRecommendation;
}): UiPathTestReleaseSummary {
  const { projectName, testCases, testSets, recommendation } = params;
  const smokeTestSet = testSets.find((testSet) => /smoke|happy path/i.test(testSet.name));
  const automatedCoveragePercent = testCases.length > 0 ? 100 : 0;
  const nextActions = [
    "Publish the generated UiPath Tests project to Orchestrator.",
    "Link the packaged automations to the generated Test Manager cases.",
    "Execute the smoke test set after deployment and capture the result in the release report.",
  ];
  if ((recommendation?.recommendedOutput || "package") === "solution") {
    nextActions.unshift("Deploy the native solution bundle before executing the linked test set.");
  }

  return {
    projectName,
    smokeTestSetName: smokeTestSet?.name,
    automatedCoveragePercent,
    nextActions,
  };
}

function renderTestReleasePlanMarkdown(params: {
  projectName: string;
  testRelease: UiPathTestReleaseSummary;
  testCases: UiPathTestCase[];
  testSets: UiPathTestSet[];
}): string {
  const { projectName, testRelease, testCases, testSets } = params;
  const lines = [
    `# ${projectName} Test Release Plan`,
    "",
    `- Automated coverage: ${testRelease.automatedCoveragePercent}%`,
    `- Smoke test set: ${testRelease.smokeTestSetName || "Not identified"}`,
    "",
    "## Test Assets",
    `- Test cases: ${testCases.length}`,
    `- Test sets: ${testSets.length}`,
    "",
    "## Release Actions",
    ...testRelease.nextActions.map((action) => `- ${action}`),
    "",
  ];
  return lines.join("\n");
}

function buildReportingSummary(params: {
  projectName: string;
  resources: UiPathSolutionResourceSummary;
  recommendation?: UiPathDeliveryRecommendation;
  operatingModel: UiPathOperatingModelSummary;
}): UiPathReportingSummary {
  const { projectName, resources, recommendation, operatingModel } = params;
  const businessKpis = [
    `${projectName} straight-through processing rate`,
    `${projectName} exception volume by category`,
    `${projectName} average cycle time`,
  ];
  const operationalKpis = [
    "Job success/failure rate",
    "Trigger execution timeliness",
    "Queue backlog and retry count",
  ];
  if (resources.actionCatalogs.length > 0) {
    operationalKpis.push("Action Center aging / SLA breaches");
  }
  if (resources.integrations.length > 0 || (recommendation?.connectorRecommendations.length ?? 0) > 0) {
    operationalKpis.push("Connector/API failure rate");
  }
  const dashboards = [
    "Operational run dashboard in UiPath Insights",
    "Business outcome dashboard for process owners",
  ];
  const alerts = [
    "Deployment gate failure alert",
    "Smoke test failure alert",
    "Trigger stopped / disabled alert",
  ];
  if (operatingModel.triggerNames.length > 0) {
    alerts.push(`Trigger monitoring for: ${operatingModel.triggerNames.join(", ")}`);
  }

  return { businessKpis, operationalKpis, dashboards, alerts };
}

function renderInsightsPlanMarkdown(params: {
  projectName: string;
  reporting: UiPathReportingSummary;
}): string {
  const { projectName, reporting } = params;
  const lines = [
    `# ${projectName} Reporting and Insights Plan`,
    "",
    "## Business KPIs",
    ...reporting.businessKpis.map((item) => `- ${item}`),
    "",
    "## Operational KPIs",
    ...reporting.operationalKpis.map((item) => `- ${item}`),
    "",
    "## Recommended Dashboards",
    ...reporting.dashboards.map((item) => `- ${item}`),
    "",
    "## Alerts",
    ...reporting.alerts.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

function buildExecutiveSummary(params: {
  projectName: string;
  recommendation?: UiPathDeliveryRecommendation;
  platformOps: UiPathPlatformOpsSummary;
  operatingModel: UiPathOperatingModelSummary;
  releaseReadiness: UiPathReleaseReadinessSummary;
  testRelease: UiPathTestReleaseSummary;
  reporting: UiPathReportingSummary;
  hasPdd: boolean;
  hasSdd: boolean;
  hasDsd: boolean;
}): UiPathExecutiveSummary {
  const {
    projectName,
    recommendation,
    platformOps,
    operatingModel,
    releaseReadiness,
    testRelease,
    reporting,
    hasPdd,
    hasSdd,
    hasDsd,
  } = params;

  const lifecycleCoverage = [
    "Discover through generated process and business context documents",
    "Design through template-aligned PDD / SDD / DSD outputs",
    `Generate through ${recommendation?.recommendedOutput || "package"}-ready UiPath artifacts`,
    "Validate through Workflow Analyzer and contract-integrity gates",
    "Deploy through package or native solution deployment paths",
    "Test through generated Test Manager-ready test cases, sets, and executable test automation artifacts",
    "Operate through deployment reports, operating model guidance, KPI recommendations, and platform operations playbooks",
  ];

  const keyOutputs = [
    hasPdd ? "PDD generated" : "PDD pending",
    hasSdd ? "SDD generated" : "SDD pending",
    hasDsd ? "DSD generated" : "DSD pending",
    `Release readiness scored at ${releaseReadiness.score}/100`,
    `Automated test coverage pack at ${testRelease.automatedCoveragePercent}%`,
    `Primary KPI recommendation: ${reporting.businessKpis[0]}`,
    `Primary deployment interface: ${platformOps.deploymentInterfaces[0]}`,
  ];

  const deploymentStory = [
    operatingModel.runtimeProfile,
    operatingModel.recommendedFolderStrategy,
    `Recommended UiPath modality: ${recommendation?.recommendedModality || "unattended_robot"}`,
    `Recommended release path includes smoke validation via ${testRelease.smokeTestSetName || "the generated smoke set"}.`,
  ];

  return {
    overview: `${projectName} can move from use case intake to deployable, testable automation through a single Canonball delivery flow with explicit document, deployment, and testing outputs.`,
    lifecycleCoverage,
    keyOutputs,
    deploymentStory,
  };
}

function renderExecutiveSummaryMarkdown(params: {
  projectName: string;
  executiveSummary: UiPathExecutiveSummary;
}): string {
  const { projectName, executiveSummary } = params;
  const lines = [
    `# ${projectName} Executive Summary`,
    "",
    executiveSummary.overview,
    "",
    "## Lifecycle Coverage",
    ...executiveSummary.lifecycleCoverage.map((item) => `- ${item}`),
    "",
    "## Key Outputs",
    ...executiveSummary.keyOutputs.map((item) => `- ${item}`),
    "",
    "## Deployment Story",
    ...executiveSummary.deploymentStory.map((item) => `- ${item}`),
    "",
  ];
  return lines.join("\n");
}

function buildProjectDescriptor(projectName: string): string {
  return JSON.stringify({
    ProjectType: "Process" as UiPathNativeSolutionProjectType,
    Name: projectName,
    Description: null,
    MainFile: "Main.xaml",
  }, null, 2);
}

function buildSolutionUipx(projectFolder: string, projectKey: string): string {
  return JSON.stringify({
    DocVersion: "1.0.0",
    StudioMinVersion: "2025.04.0",
    SolutionId: randomUUID(),
    Projects: [
      {
        Type: "Process" as UiPathNativeSolutionProjectType,
        ProjectRelativePath: `${projectFolder}/project.uiproj`,
        Id: projectKey,
      },
    ],
  }, null, 2);
}

function buildSolutionStorage(projectFolder: string): string {
  return JSON.stringify({
    SolutionId: randomUUID(),
    Projects: [
      {
        ProjectId: randomUUID(),
        ProjectRelativePath: `${projectFolder}/project.uiproj`,
      },
    ],
  });
}

function buildPackageResourceDescriptor(params: {
  projectName: string;
  projectKey: string;
  packageKey: string;
  folderName: string;
}): string {
  const { projectName, projectKey, packageKey, folderName } = params;

  return JSON.stringify({
    docVersion: "1.0.0",
    resource: {
      name: projectName,
      kind: "package",
      apiVersion: "orchestrator.uipath.com/v1",
      projectKey,
      isOverridable: true,
      dependencies: [],
      runtimeDependencies: [],
      files: [],
      folders: [{ fullyQualifiedName: folderName }],
      spec: {
        fileName: null,
        fileReference: null,
        name: projectName,
        description: null,
      },
      locks: [],
      key: packageKey,
    },
  }, null, 2);
}

function buildProcessResourceDescriptor(params: {
  solutionName: string;
  projectName: string;
  projectKey: string;
  packageKey: string;
  processKey: string;
  folderName: string;
  description?: string;
}): string {
  const {
    solutionName,
    projectName,
    projectKey,
    packageKey,
    processKey,
    folderName,
    description,
  } = params;

  return JSON.stringify({
    docVersion: "1.0.0",
    resource: {
      name: projectName,
      kind: "process",
      type: "process",
      apiVersion: "orchestrator.uipath.com/v1",
      projectKey,
      isOverridable: true,
      dependencies: [{ name: projectName, kind: "package" }],
      runtimeDependencies: [],
      files: [],
      folders: [{ fullyQualifiedName: folderName }],
      spec: {
        entryPointUniqueId: null,
        inputArgumentsSchema: null,
        inputArgumentsSchemaV2: null,
        type: "Process",
        name: projectName,
        description: description || null,
        package: {
          key: packageKey,
        },
        packageName: processPackageName(solutionName, projectName),
        packageVersion: null,
        entryPointName: null,
        inputArguments: "{}",
        jobPriority: "Medium",
        hiddenForAttendedUser: false,
        alwaysRunning: false,
        autoStartProcess: false,
        jobRecording: "Disabled",
        targetFrameworkValue: "Portable",
        duration: 40,
        frequency: 500,
        quality: 100,
        remoteControlAccess: "None",
        retentionAction: "Delete",
        retentionPeriod: 30,
        retentionBucketRef: null,
        staleRetentionAction: "Delete",
        staleRetentionPeriod: 180,
        staleRetentionBucketRef: null,
        entryPoints: null,
        connections: null,
        tags: [],
      },
      locks: [],
      key: processKey,
    },
  }, null, 2);
}

function addSharedResourceEnvelope(params: {
  name: string;
  kind: string;
  folderName: string;
  spec: Record<string, unknown>;
  type?: string;
}): string {
  const { name, kind, folderName, spec, type } = params;
  const resource: Record<string, unknown> = {
    name,
    kind,
    apiVersion: "orchestrator.uipath.com/v1",
    isOverridable: true,
    dependencies: [],
    runtimeDependencies: [],
    files: [],
    folders: [{ fullyQualifiedName: folderName }],
    spec,
    locks: [],
    key: randomUUID(),
  };

  if (type) {
    resource.type = type;
  }

  return JSON.stringify({
    docVersion: "1.0.0",
    resource,
  }, null, 2);
}

function mapAssetType(type: string | undefined): "Text" | "Integer" | "Bool" | "Credential" {
  const normalized = String(type || "Text").trim().toLowerCase();
  if (normalized === "credential") return "Credential";
  if (normalized === "integer" || normalized === "int" || normalized === "number") return "Integer";
  if (normalized === "bool" || normalized === "boolean") return "Bool";
  return "Text";
}

function mapAssetResourceSubtype(type: "Text" | "Integer" | "Bool" | "Credential"): string {
  switch (type) {
    case "Integer":
      return "integerAsset";
    case "Bool":
      return "boolAsset";
    case "Credential":
      return "credentialAsset";
    case "Text":
    default:
      return "stringAsset";
  }
}

function buildQueueResourceDescriptor(queue: any, folderName: string): string {
  return addSharedResourceEnvelope({
    name: queue.name,
    kind: "queue",
    folderName,
    spec: {
      name: queue.name,
      description: queue.description || null,
      enforceUniqueReference: Boolean(queue.uniqueReference),
      encrypted: Boolean(queue.encrypted),
      acceptAutomaticallyRetry: queue.autoRetry !== undefined ? Boolean(queue.autoRetry) : true,
      maxNumberOfRetries: Number.isFinite(queue.maxRetries) ? queue.maxRetries : 3,
      specificDataJsonSchema: queue.jsonSchema || null,
      outputDataJsonSchema: queue.outputSchema || null,
      analyticsDataJsonSchema: queue.analyticsSchema || null,
      slaProcessRef: null,
      slaInHours: Number.isFinite(Number(queue.slaInHours)) ? Number(queue.slaInHours) : 0,
      riskSlaInHours: Number.isFinite(Number(queue.riskSlaInHours)) ? Number(queue.riskSlaInHours) : 0,
      retentionAction: queue.retentionAction || "Delete",
      retentionPeriod: Number.isFinite(Number(queue.retentionPeriod)) ? Number(queue.retentionPeriod) : 30,
      retentionBucketRef: null,
      staleRetentionAction: queue.staleRetentionAction || "Delete",
      staleRetentionPeriod: Number.isFinite(Number(queue.staleRetentionPeriod)) ? Number(queue.staleRetentionPeriod) : 180,
      staleRetentionBucketRef: null,
      tags: [],
    },
  });
}

function buildAssetResourceDescriptor(asset: any, folderName: string): string {
  const assetType = mapAssetType(asset.type);
  const assetSubtype = mapAssetResourceSubtype(assetType);
  const normalizedTextValue = (() => {
    if (asset.value !== undefined && asset.value !== null) {
      const raw = String(asset.value);
      if (raw.trim().length > 0) return raw;
    }

    return `${asset.name}_VALUE`;
  })();
  const spec: Record<string, unknown> = {
    name: asset.name,
    description: asset.description || null,
    type: assetType,
    scope: asset.scope || "Global",
    accountMachineValues: null,
    tags: [],
  };

  if (assetType === "Text") spec.value = normalizedTextValue;
  if (assetType === "Integer") spec.value = Number.isFinite(Number(asset.value)) ? Number(asset.value) : 0;
  if (assetType === "Bool") spec.value = String(asset.value).toLowerCase() === "true";
  if (assetType === "Credential") {
    spec.value = null;
  }

  return addSharedResourceEnvelope({
    name: asset.name,
    kind: "asset",
    type: assetSubtype,
    folderName,
    spec,
  });
}

function buildStorageBucketResourceDescriptor(bucket: any, folderName: string): string {
  return addSharedResourceEnvelope({
    name: bucket.name,
    kind: "bucket",
    type: "orchestratorBucket",
    folderName,
    spec: {
      name: bucket.name,
      description: bucket.description || null,
      type: bucket.storageProvider || "Orchestrator",
      options: null,
      tags: [],
    },
  });
}

function buildSolutionResourceReferencesXaml(params: {
  queueNames: string[];
  textAssetNames: string[];
  storageBucketNames: string[];
}): string | null {
  const queueName = params.queueNames[0];
  const textAssetName = params.textAssetNames.find(Boolean);

  if (!queueName && !textAssetName) {
    return null;
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Activity mc:Ignorable="sap sap2010" x:Class="SolutionResourceReferences"',
    ' xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"',
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    ' xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"',
    ' xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"',
    ' xmlns:scg="clr-namespace:System.Collections.Generic;assembly=System.Private.CoreLib"',
    ' xmlns:ucas="clr-namespace:UiPath.Core.Activities.Storage;assembly=UiPath.System.Activities"',
    ' xmlns:ui="http://schemas.uipath.com/workflow/activities"',
    ' xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">',
    '  <TextExpression.NamespacesForImplementation>',
    '    <scg:List x:TypeArguments="x:String" Capacity="24">',
    '      <x:String>UiPath.Platform.ResourceHandling</x:String>',
    '      <x:String>UiPath.Core.Activities.Storage</x:String>',
    '      <x:String>UiPath.Core.Activities.Orchestrator</x:String>',
    '      <x:String>System.Activities</x:String>',
    '      <x:String>UiPath.Core.Activities</x:String>',
    '      <x:String>System</x:String>',
    '      <x:String>System.Collections.Generic</x:String>',
    '      <x:String>System.Collections</x:String>',
    '      <x:String>System.Runtime.Serialization</x:String>',
    '      <x:String>UiPath.Core</x:String>',
    '      <x:String>UiPath.Shared.Activities</x:String>',
    '      <x:String>System.Activities.Statements</x:String>',
    '      <x:String>System.Activities.Expressions</x:String>',
    '      <x:String>System.Activities.Validation</x:String>',
    '      <x:String>System.Activities.XamlIntegration</x:String>',
    '      <x:String>Microsoft.VisualBasic</x:String>',
    '      <x:String>Microsoft.VisualBasic.Activities</x:String>',
    '      <x:String>System.Data</x:String>',
    '      <x:String>System.Diagnostics</x:String>',
    '      <x:String>System.IO</x:String>',
    '      <x:String>System.Linq</x:String>',
    '      <x:String>System.Windows.Markup</x:String>',
    '      <x:String>Newtonsoft.Json</x:String>',
    '      <x:String>Newtonsoft.Json.Linq</x:String>',
    '    </scg:List>',
    '  </TextExpression.NamespacesForImplementation>',
    '  <TextExpression.ReferencesForImplementation>',
    '    <scg:List x:TypeArguments="AssemblyReference" Capacity="16">',
    '      <AssemblyReference>System.Activities</AssemblyReference>',
    '      <AssemblyReference>Microsoft.VisualBasic</AssemblyReference>',
    '      <AssemblyReference>System</AssemblyReference>',
    '      <AssemblyReference>System.Linq</AssemblyReference>',
    '      <AssemblyReference>System.Xaml</AssemblyReference>',
    '      <AssemblyReference>System.Net.Primitives</AssemblyReference>',
    '      <AssemblyReference>System.Runtime.InteropServices</AssemblyReference>',
    '      <AssemblyReference>Newtonsoft.Json</AssemblyReference>',
    '      <AssemblyReference>UiPath.System.Activities</AssemblyReference>',
    '      <AssemblyReference>System.Private.CoreLib</AssemblyReference>',
    '      <AssemblyReference>UiPath.Platform</AssemblyReference>',
    '    </scg:List>',
    '  </TextExpression.ReferencesForImplementation>',
    '  <Sequence sap:VirtualizedContainerService.HintSize="356,732" sap2010:WorkflowViewState.IdRef="Sequence_1">',
    '    <sap:WorkflowViewStateService.ViewState>',
    '      <scg:Dictionary x:TypeArguments="x:String, x:Object">',
    '        <x:Boolean x:Key="IsExpanded">True</x:Boolean>',
    '      </scg:Dictionary>',
    '    </sap:WorkflowViewStateService.ViewState>',
  ];

  if (queueName) {
    lines.push(
      `    <ui:AddQueueItem TimeoutMS="{x:Null}" DisplayName="Add Queue Item" sap2010:WorkflowViewState.IdRef="AddQueueItem_1" Priority="Normal" QueueType="${queueName}">`,
      '      <ui:AddQueueItem.ItemInformation>',
      '        <scg:Dictionary x:TypeArguments="x:String, InArgument" />',
      '      </ui:AddQueueItem.ItemInformation>',
      '    </ui:AddQueueItem>',
    );
  }

  if (textAssetName) {
    lines.push(
      `    <ui:GetRobotAsset TimeoutMS="{x:Null}" Value="{x:Null}" AssetName="${textAssetName}" CacheStrategy="None" DisplayName="Get Asset" sap2010:WorkflowViewState.IdRef="GetRobotAsset_1" />`,
    );
  }

  lines.push('  </Sequence>', '</Activity>');
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
  deliveryRecommendation?: UiPathDeliveryRecommendation;
  testCases?: UiPathTestCase[];
  testSets?: UiPathTestSet[];
}): UiPathSolutionArtifact {
  const {
    pkg,
    buildResult,
    projectName,
    dhgContent,
    ctx,
    version,
    deliveryRecommendation,
    testCases = [],
    testSets = [],
  } = params;

  const projectFolder = normalizeFolderName(projectName);
  const solutionName = sanitizeName(`${projectName}_Solution`);
  const uiFolderName = "solution_folder";
  const projectKey = randomUUID();
  const packageKey = randomUUID();
  const processKey = randomUUID();
  const orchestratorArtifacts = pkg.internal?.orchestratorArtifacts || pkg.internal?.extractedArtifacts || {};
  const resources = summarizeResources(orchestratorArtifacts);
  const operatingModel = buildOperatingModelSummary({
    orchestratorArtifacts,
    recommendation: deliveryRecommendation,
  });
  const platformOps = buildPlatformOpsSummary({
    recommendation: deliveryRecommendation,
    operatingModel,
    resources,
    testCaseCount: testCases.length,
  });
  const releaseReadiness = buildReleaseReadinessSummary({
    recommendation: deliveryRecommendation,
    operatingModel,
    resources,
    hasPdd: Boolean(ctx.pdd?.content),
    hasSdd: Boolean(ctx.sdd?.content),
    hasDsd: Boolean(ctx.dsd?.content),
    hasDhg: Boolean(dhgContent),
    testCaseCount: testCases.length,
    testSetCount: testSets.length,
  });
  const testRelease = buildTestReleaseSummary({
    projectName,
    testCases,
    testSets,
    recommendation: deliveryRecommendation,
  });
  const reporting = buildReportingSummary({
    projectName,
    resources,
    recommendation: deliveryRecommendation,
    operatingModel,
  });
  const executiveSummary = buildExecutiveSummary({
    projectName,
    recommendation: deliveryRecommendation,
    platformOps,
    operatingModel,
    releaseReadiness,
    testRelease,
    reporting,
    hasPdd: Boolean(ctx.pdd?.content),
    hasSdd: Boolean(ctx.sdd?.content),
    hasDsd: Boolean(ctx.dsd?.content),
  });

  const components: UiPathSolutionComponent[] = [
    {
      type: "rpa_project",
      name: projectName,
      path: `${projectFolder}/project.uiproj`,
      description: pkg.description || `${projectName} automation project`,
    },
    {
      type: "resource_manifest",
      name: "PackageResource",
      path: `resources/${uiFolderName}/package/${resourceFileBase(projectName)}.json`,
      description: "Native UiPath package resource descriptor for the solution export",
    },
    {
      type: "resource_manifest",
      name: "ProcessResource",
      path: `resources/${uiFolderName}/process/process/${resourceFileBase(projectName)}.json`,
      description: "Native UiPath process resource descriptor for the solution export",
    },
  ];

  if (ctx.sdd?.content) {
    components.push({
      type: "documentation",
      name: "SDD",
      path: `${projectFolder}/docs/SDD.md`,
      description: "Approved or latest Solution Design Document used during generation",
    });
  }
  if (ctx.pdd?.content) {
    components.push({
      type: "documentation",
      name: "PDD",
      path: `${projectFolder}/docs/PDD.md`,
      description: "Latest Process Design Document used during generation",
    });
  }
  if (ctx.dsd?.content) {
    components.push({
      type: "documentation",
      name: "DSD",
      path: `${projectFolder}/docs/DSD.md`,
      description: "Detailed Solution Design Document used for implementation and support handoff",
    });
  }
  if (testCases.length > 0 || testSets.length > 0) {
    components.push({
      type: "documentation",
      name: "TestCases",
      path: `${projectFolder}/docs/TestCases.md`,
      description: "Generated validation scenarios derived from the use case artifacts",
    });
  }
  components.push({
    type: "documentation",
    name: "PlatformOperations",
    path: `${projectFolder}/docs/PlatformOperations.md`,
    description: "Generated platform operations guide covering auth, deploy interfaces, fallback strategy, and release checks.",
  });
  components.push({
    type: "documentation",
    name: "ActivityPackagePlan",
    path: `${projectFolder}/docs/ActivityPackagePlan.md`,
    description: "Generated activity-package implementation plan derived from workflow, connector, and test signals.",
  });
  components.push({
    type: "documentation",
    name: "OperatingModel",
    path: `${projectFolder}/docs/OperatingModel.md`,
    description: "Generated operating model and deployment-readiness guide for the automation.",
  });
  components.push({
    type: "documentation",
    name: "GovernancePack",
    path: `${projectFolder}/docs/GovernancePack.md`,
    description: "Generated governance and release-readiness summary for enterprise deployment.",
  });
  components.push({
    type: "documentation",
    name: "TestReleasePlan",
    path: `${projectFolder}/docs/TestReleasePlan.md`,
    description: "Generated Test Manager-first release plan for publishing, linking, and smoke validation.",
  });
  components.push({
    type: "documentation",
    name: "InsightsPlan",
    path: `${projectFolder}/docs/InsightsPlan.md`,
    description: "Generated reporting and Insights KPI plan for operations and business stakeholders.",
  });
  components.push({
    type: "documentation",
    name: "ExecutiveSummary",
    path: `${projectFolder}/docs/ExecutiveSummary.md`,
    description: "Generated executive summary of the end-to-end delivery capability for this use case.",
  });

  const queues = Array.isArray(orchestratorArtifacts?.queues) ? orchestratorArtifacts.queues : [];
  for (const queue of queues) {
    if (!queue?.name) continue;
    components.push({
      type: "resource_manifest",
      name: `Queue:${queue.name}`,
      path: `resources/${uiFolderName}/queue/${resourceFileBase(queue.name)}.json`,
      description: "Native UiPath queue resource descriptor",
    });
  }

  const assets = Array.isArray(orchestratorArtifacts?.assets) ? orchestratorArtifacts.assets : [];
  for (const asset of assets) {
    if (!asset?.name) continue;
    const assetSubtype = mapAssetResourceSubtype(mapAssetType(asset.type));
    components.push({
      type: "resource_manifest",
      name: `Asset:${asset.name}`,
      path: `resources/${uiFolderName}/asset/${assetSubtype}/${resourceFileBase(asset.name)}.json`,
      description: "Native UiPath asset resource descriptor",
    });
  }

  const storageBuckets = Array.isArray(orchestratorArtifacts?.storageBuckets) ? orchestratorArtifacts.storageBuckets : [];
  for (const bucket of storageBuckets) {
    if (!bucket?.name) continue;
    components.push({
      type: "resource_manifest",
      name: `StorageBucket:${bucket.name}`,
      path: `resources/${uiFolderName}/bucket/orchestratorBucket/${resourceFileBase(bucket.name)}.json`,
      description: "Native UiPath storage bucket resource descriptor",
    });
  }

  const resourceReferenceXaml = buildSolutionResourceReferencesXaml({
    queueNames: queues.map((queue: any) => String(queue?.name || "")).filter(Boolean),
    textAssetNames: assets
      .filter((asset: any) => mapAssetType(asset?.type) === "Text")
      .map((asset: any) => String(asset?.name || ""))
      .filter(Boolean),
    storageBucketNames: storageBuckets.map((bucket: any) => String(bucket?.name || "")).filter(Boolean),
  });

  const manifest: UiPathSolutionManifest = {
    schemaVersion: "1.0",
    solutionName,
    displayName: `${projectName} Solution`,
    version,
    generatedAt: new Date().toISOString(),
    sourceProjectName: projectName,
    automationType: pkg.internal?.automationType || "rpa",
    deliveryMode: "native_uis",
    deploymentSupport: {
      packageDeploySupported: true,
      solutionDeploySupported: "manual_or_cli",
      notes: [
        "This artifact is exported as a native UiPath Studio Web .uis container.",
        "To appear under UiPath Solutions, deploy it through UiPath's solution upload/deploy/activate flow rather than the package upload API.",
      ],
    },
    recommendation: deliveryRecommendation,
    platformOps,
    operatingModel,
    releaseReadiness,
    testRelease,
    reporting,
    executiveSummary,
    testCases,
    testSets,
    components,
    resources,
  };

  const zip = new AdmZip();
  zip.addFile("Solution.uipx", Buffer.from(buildSolutionUipx(projectFolder, projectKey), "utf8"));
  zip.addFile("SolutionStorage.json", Buffer.from(buildSolutionStorage(projectFolder), "utf8"));
  zip.addFile(`${projectFolder}/project.uiproj`, Buffer.from(buildProjectDescriptor(projectName), "utf8"));

  for (const entry of buildResult.xamlEntries) {
    const entryName = String(entry.name || "").replace(/^\/+/, "");
    if (!entryName) continue;
    zip.addFile(`${projectFolder}/${entryName}`, Buffer.from(entry.content, "utf8"));
  }

  if (buildResult.projectJsonContent) {
    zip.addFile(`${projectFolder}/project.json`, Buffer.from(buildResult.projectJsonContent, "utf8"));
  }

  if (resourceReferenceXaml) {
    zip.addFile(`${projectFolder}/SolutionResourceReferences.xaml`, Buffer.from(resourceReferenceXaml, "utf8"));
  }

  const sddContent = ctx.sdd?.content || "";
  const configContent = generateConfigXlsx(projectName, sddContent, orchestratorArtifacts);
  zip.addFile(`${projectFolder}/Data/Config.xlsx`, Buffer.from(configContent, "utf8"));

  if (dhgContent) {
    zip.addFile(`${projectFolder}/DeveloperHandoffGuide.md`, Buffer.from(dhgContent, "utf8"));
  }
  if (ctx.sdd?.content) {
    zip.addFile(`${projectFolder}/docs/SDD.md`, Buffer.from(ctx.sdd.content, "utf8"));
  }
  if (ctx.pdd?.content) {
    zip.addFile(`${projectFolder}/docs/PDD.md`, Buffer.from(ctx.pdd.content, "utf8"));
  }
  if (ctx.dsd?.content) {
    zip.addFile(`${projectFolder}/docs/DSD.md`, Buffer.from(ctx.dsd.content, "utf8"));
  }
  if (testCases.length > 0 || testSets.length > 0) {
    zip.addFile(
      `${projectFolder}/docs/TestCases.md`,
      Buffer.from(renderUiPathTestCasesMarkdown({ projectName, testCases, testSets }), "utf8"),
    );
    zip.addFile(
      `${projectFolder}/docs/TestCases.json`,
      Buffer.from(JSON.stringify({ testCases, testSets }, null, 2), "utf8"),
    );
  }
  zip.addFile(
    `${projectFolder}/docs/PlatformOperations.md`,
    Buffer.from(renderPlatformOpsMarkdown({ projectName, platformOps }), "utf8"),
  );
  zip.addFile(
    `${projectFolder}/docs/ActivityPackagePlan.md`,
    Buffer.from(renderActivityPackagePlanMarkdown({ projectName, recommendation: deliveryRecommendation }), "utf8"),
  );
  zip.addFile(
    `${projectFolder}/docs/OperatingModel.md`,
    Buffer.from(renderOperatingModelMarkdown({ projectName, operatingModel, resources }), "utf8"),
  );
  zip.addFile(
    `${projectFolder}/docs/GovernancePack.md`,
    Buffer.from(renderGovernancePackMarkdown({ projectName, operatingModel, releaseReadiness }), "utf8"),
  );
  zip.addFile(
    `${projectFolder}/docs/TestReleasePlan.md`,
    Buffer.from(renderTestReleasePlanMarkdown({ projectName, testRelease, testCases, testSets }), "utf8"),
  );
  zip.addFile(
    `${projectFolder}/docs/InsightsPlan.md`,
    Buffer.from(renderInsightsPlanMarkdown({ projectName, reporting }), "utf8"),
  );
  zip.addFile(
    `${projectFolder}/docs/ExecutiveSummary.md`,
    Buffer.from(renderExecutiveSummaryMarkdown({ projectName, executiveSummary }), "utf8"),
  );

  const resourceBase = resourceFileBase(projectName);
  zip.addFile(
    `resources/${uiFolderName}/package/${resourceBase}.json`,
    Buffer.from(buildPackageResourceDescriptor({
      projectName,
      projectKey,
      packageKey,
      folderName: uiFolderName,
    }), "utf8"),
  );
  zip.addFile(
    `resources/${uiFolderName}/process/process/${resourceBase}.json`,
    Buffer.from(buildProcessResourceDescriptor({
      solutionName,
      projectName,
      projectKey,
      packageKey,
      processKey,
      folderName: uiFolderName,
      description: pkg.description,
    }), "utf8"),
  );

  for (const queue of queues) {
    if (!queue?.name) continue;
    zip.addFile(
      `resources/${uiFolderName}/queue/${resourceFileBase(queue.name)}.json`,
      Buffer.from(buildQueueResourceDescriptor(queue, uiFolderName), "utf8"),
    );
  }

  for (const asset of assets) {
    if (!asset?.name) continue;
    const assetSubtype = mapAssetResourceSubtype(mapAssetType(asset.type));
    zip.addFile(
      `resources/${uiFolderName}/asset/${assetSubtype}/${resourceFileBase(asset.name)}.json`,
      Buffer.from(buildAssetResourceDescriptor(asset, uiFolderName), "utf8"),
    );
  }

  for (const bucket of storageBuckets) {
    if (!bucket?.name) continue;
    zip.addFile(
      `resources/${uiFolderName}/bucket/orchestratorBucket/${resourceFileBase(bucket.name)}.json`,
      Buffer.from(buildStorageBucketResourceDescriptor(bucket, uiFolderName), "utf8"),
    );
  }

  return {
    fileName: `${solutionName}.${version}.uis`,
    buffer: zip.toBuffer(),
    manifest,
    components,
  };
}
