import {
  DEFAULT_UIPATH_SOLUTION_SCOPES,
  validateUiPathSolutionFolderResources,
} from "../server/uipath-solution-cli";

function parseCsvEnv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const auth = {
    organizationName: process.env.UIPATH_ORGANIZATION_ID || "",
    tenantName: process.env.UIPATH_TENANT_NAME || "",
    applicationId: process.env.UIPATH_CLIENT_ID || "",
    applicationSecret: process.env.UIPATH_CLIENT_SECRET || "",
    applicationScope: process.env.UIPATH_SCOPES || process.env.UIPATH_SOLUTION_SCOPES || DEFAULT_UIPATH_SOLUTION_SCOPES,
    orchestratorUrl: process.env.UIPATH_ORCHESTRATOR_URL || "https://cloud.uipath.com/",
  };

  if (!auth.organizationName || !auth.tenantName || !auth.applicationId || !auth.applicationSecret) {
    throw new Error("Missing required UiPath credentials in UIPATH_* environment variables.");
  }

  const result = await validateUiPathSolutionFolderResources(auth, {
    folderId: process.env.UIPATH_SOLUTION_FOLDER_ID || "",
    folderName: process.env.UIPATH_SOLUTION_FOLDER_NAME || "",
    processes: parseCsvEnv(process.env.UIPATH_EXPECTED_PROCESSES),
    assets: parseCsvEnv(process.env.UIPATH_EXPECTED_ASSETS),
    queues: parseCsvEnv(process.env.UIPATH_EXPECTED_QUEUES),
    buckets: parseCsvEnv(process.env.UIPATH_EXPECTED_BUCKETS),
  });

  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exit(2);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }, null, 2));
  process.exit(1);
});
