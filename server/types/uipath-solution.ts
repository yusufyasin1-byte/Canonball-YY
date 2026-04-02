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
  components: UiPathSolutionComponent[];
  resources: UiPathSolutionResourceSummary;
}

export interface UiPathSolutionArtifact {
  fileName: string;
  buffer: Buffer;
  manifest: UiPathSolutionManifest;
  components: UiPathSolutionComponent[];
}
