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

export type UiPathDeliveryTarget = "package" | "solution";

export interface UiPathDeliveryRecommendation {
  recommendedOutput: UiPathDeliveryTarget;
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
