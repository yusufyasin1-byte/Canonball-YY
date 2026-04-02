import {
  activateUiPathNativeSolution,
  DEFAULT_UIPATH_SOLUTION_SCOPES,
  deployUiPathNativeSolution,
  uploadUiPathNativeSolutionPackage,
} from "../server/uipath-solution-cli";

function sanitizeUseCaseName(value: string): string {
  return (value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleCaseWords(value: string): string {
  return sanitizeUseCaseName(value)
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function main() {
  const auth = {
    organizationName: process.env.UIPATH_ORGANIZATION_ID || "",
    tenantName: process.env.UIPATH_TENANT_NAME || "",
    applicationId: process.env.UIPATH_CLIENT_ID || "",
    applicationSecret: process.env.UIPATH_CLIENT_SECRET || "",
    applicationScope: process.env.UIPATH_SOLUTION_SCOPES || DEFAULT_UIPATH_SOLUTION_SCOPES,
    orchestratorUrl: process.env.UIPATH_ORCHESTRATOR_URL || "https://cloud.uipath.com/",
  };

  const packagePath = process.env.UIPATH_SOLUTION_PACKAGE_PATH || "";
  const packageName = process.env.UIPATH_SOLUTION_PACKAGE_NAME || "";
  const version = process.env.UIPATH_SOLUTION_VERSION || "";
  const useCaseName = titleCaseWords(
    process.env.UIPATH_USECASE_NAME
    || process.env.UIPATH_SOLUTION_NAME
    || process.env.UIPATH_PROCESS_NAME
    || packageName,
  );
  const deploymentParentFolder = process.env.UIPATH_SOLUTION_PARENT_FOLDER || process.env.UIPATH_FOLDER_NAME || "";
  const folderName = process.env.UIPATH_SOLUTION_FOLDER_NAME || (useCaseName ? `${useCaseName} Solutions` : "");
  const deploymentName = process.env.UIPATH_SOLUTION_DEPLOYMENT_NAME || useCaseName;

  if (!auth.organizationName || !auth.tenantName || !auth.applicationId || !auth.applicationSecret) {
    throw new Error("Missing required UiPath external app credentials in UIPATH_* environment variables.");
  }
  if (!packagePath || !packageName || !version || !folderName || !deploymentName) {
    throw new Error("Missing one or more required solution deployment values: UIPATH_SOLUTION_PACKAGE_PATH, UIPATH_SOLUTION_PACKAGE_NAME, UIPATH_SOLUTION_VERSION, and a stable deployment/folder identity.");
  }

  const upload = await uploadUiPathNativeSolutionPackage(auth, packagePath, { traceLevel: "Information" });
  const deploy = await deployUiPathNativeSolution(auth, {
    packageName,
    version,
    deploymentName,
    folderName,
    parentFolderName: deploymentParentFolder || undefined,
    traceLevel: "Information",
  });
  const activate = await activateUiPathNativeSolution(auth, deploymentName, version, { traceLevel: "Information" });

  console.log(JSON.stringify({
    ok: true,
    packagePath,
    packageName,
    version,
    folderName,
    deploymentParentFolder,
    useCaseName,
    deploymentName,
    upload,
    deploy,
    activate,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }, null, 2));
  process.exit(1);
});
