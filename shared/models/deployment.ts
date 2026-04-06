export type DeploymentResult = {
  artifact: string;
  name: string;
  status: "created" | "exists" | "updated" | "failed" | "skipped" | "manual" | "in_package";
  message: string;
  id?: number | string;
  manualSteps?: string[];
};

export type ServiceLimitation = {
  service: string;
  status: "limited" | "unavailable" | "unknown";
  reason: string;
};

export type DeployReport = {
  packageId?: string;
  version?: string;
  processName?: string;
  orgName?: string;
  tenantName?: string;
  folderName?: string;
  results: DeploymentResult[];
  summary?: string;
  serviceLimitations?: ServiceLimitation[];
};
