export interface UiPathSolutionComponent {
  type: "rpa_project" | "agent" | "app" | "api_workflow" | "resource_manifest" | "documentation";
  name: string;
  path: string;
  description?: string;
  packageFile?: string;
}

export type UiPathNativeSolutionProjectType = "Process" | "Agent" | "App" | "ApiWorkflow";

export interface UiPathSolutionResourceSummary {
  queues: string[];
  assets: string[];
  storageBuckets: string[];
  actionCatalogs: string[];
  processes: string[];
  integrations: string[];
}

export interface UiPathConnectorRecommendation {
  connectorName: string;
  sourceSystems: string[];
  rationale: string;
  usedActions?: string[];
}

export interface UiPathOperatingModelSummary {
  runtimeProfile: string;
  recommendedFolderStrategy: string;
  recommendedRobotType: string;
  triggerStrategy: string;
  supportModel: string;
  deploymentReadinessNotes: string[];
  integrationServiceConnectors: string[];
  apps: string[];
  dataFabricEntities: string[];
  triggerNames: string[];
  governanceArtifacts: string[];
}

export interface UiPathReleaseReadinessSummary {
  score: number;
  status: "ready" | "mostly_ready" | "needs_work";
  strengths: string[];
  outstandingItems: string[];
  releaseGates: string[];
}

export interface UiPathTestReleaseSummary {
  projectName: string;
  smokeTestSetName?: string;
  automatedCoveragePercent: number;
  nextActions: string[];
}

export interface UiPathReportingSummary {
  businessKpis: string[];
  operationalKpis: string[];
  dashboards: string[];
  alerts: string[];
}

export interface UiPathExecutiveSummary {
  overview: string;
  lifecycleCoverage: string[];
  keyOutputs: string[];
  deploymentStory: string[];
}

export type UiPathDeliveryTarget = "package" | "solution";
export type UiPathDeliveryModality =
  | "unattended_robot"
  | "attended_assistant"
  | "app_fronted_process"
  | "agent_orchestrated"
  | "api_workflow";
export type UiPathExecutionModel = "unattended" | "attended" | "hybrid";

export interface UiPathDeliveryRecommendation {
  recommendedOutput: UiPathDeliveryTarget;
  recommendedModality: UiPathDeliveryModality;
  recommendedExecutionModel: UiPathExecutionModel;
  recommendedProducts: string[];
  connectorRecommendations: UiPathConnectorRecommendation[];
  rationale: string[];
  signals: {
    automationType: "rpa" | "agent" | "hybrid";
    workflowCount: number;
    queueCount: number;
    assetCount: number;
    storageBucketCount: number;
    actionCatalogCount: number;
    integrationCount: number;
    sharedResourceCount: number;
    uiInteractionSignalCount: number;
    assistantSignalCount: number;
    appSignalCount: number;
    apiSignalCount: number;
    humanInLoopSignalCount: number;
    triggerCount: number;
    appCount: number;
    dataFabricEntityCount: number;
  };
}

export interface UiPathTestCaseStep {
  action: string;
  expected: string;
}

export interface UiPathTestCase {
  name: string;
  description: string;
  steps: UiPathTestCaseStep[];
}

export interface UiPathTestSet {
  name: string;
  description: string;
  testCaseNames: string[];
}

export interface UiPathTestAutomationArtifact {
  fileName: string;
  buffer: Buffer;
  projectName: string;
  version: string;
  workflowCount: number;
  workflowFiles: string[];
  testCases: UiPathTestCase[];
  testSets: UiPathTestSet[];
}

export interface UiPathSolutionManifest {
  schemaVersion: "1.0";
  solutionName: string;
  displayName: string;
  version: string;
  generatedAt: string;
  sourceProjectName: string;
  automationType: "rpa" | "agent" | "hybrid";
  deliveryMode: "solution_bundle" | "native_uis";
  deploymentSupport: {
    packageDeploySupported: boolean;
    solutionDeploySupported: "manual_or_cli";
    notes: string[];
  };
  recommendation?: UiPathDeliveryRecommendation;
  operatingModel?: UiPathOperatingModelSummary;
  releaseReadiness?: UiPathReleaseReadinessSummary;
  testRelease?: UiPathTestReleaseSummary;
  reporting?: UiPathReportingSummary;
  executiveSummary?: UiPathExecutiveSummary;
  testCases?: UiPathTestCase[];
  testSets?: UiPathTestSet[];
  components: UiPathSolutionComponent[];
  resources: UiPathSolutionResourceSummary;
}

export interface UiPathSolutionArtifact {
  fileName: string;
  buffer: Buffer;
  manifest: UiPathSolutionManifest;
  components: UiPathSolutionComponent[];
}
