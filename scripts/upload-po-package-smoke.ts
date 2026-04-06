import fs from "node:fs";
import path from "node:path";
import { getAccessToken } from "../server/uipath-auth";
import { uploadNupkgBuffer } from "../server/package-assembler";
import { metadataService } from "../server/catalog/metadata-service";

type EnvConfig = {
  orgName: string;
  tenantName: string;
  folderId?: string;
  folderName?: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
};

async function main() {
  const config: EnvConfig = {
    orgName: process.env.UIPATH_ORGANIZATION_ID || "",
    tenantName: process.env.UIPATH_TENANT_NAME || "",
    folderId: process.env.UIPATH_FOLDER_ID || undefined,
    folderName: process.env.UIPATH_FOLDER_NAME || undefined,
    clientId: process.env.UIPATH_CLIENT_ID || "",
    clientSecret: process.env.UIPATH_CLIENT_SECRET || "",
    scopes: process.env.UIPATH_SCOPES || "OR.Default",
  };

  const packagePath = process.env.UIPATH_PACKAGE_PATH
    ? path.resolve(process.env.UIPATH_PACKAGE_PATH)
    : path.resolve(process.cwd(), "simulation_output_po_invoice", "POInvoiceTestNew.1.0.0-sim.nupkg");
  const packageBaseName = path.basename(packagePath, ".nupkg");
  const inferredParts = packageBaseName.split(".");
  const inferredVersion = inferredParts.length >= 3 ? inferredParts.slice(-3).join(".") : "";
  const inferredProjectName = inferredParts.length >= 4 ? inferredParts.slice(0, -3).join(".") : packageBaseName;
  const projectName = process.env.UIPATH_PACKAGE_ID || inferredProjectName || "POInvoiceTestNew";
  const version = process.env.UIPATH_PACKAGE_VERSION || inferredVersion || "1.0.0-sim";
  const processName = process.env.UIPATH_PROCESS_NAME || projectName;

  if (!config.orgName || !config.tenantName || !config.clientId || !config.clientSecret) {
    throw new Error("Missing required UIPATH_* auth environment variables.");
  }
  if (!fs.existsSync(packagePath)) {
    throw new Error(`Package file not found: ${packagePath}`);
  }

  const token = await getAccessToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: config.scopes,
  });

  const nupkgBuffer = fs.readFileSync(packagePath);
  const upload = await uploadNupkgBuffer(config as any, token, nupkgBuffer, projectName, version);
  const baseUrl = metadataService.getServiceUrl("OR", config as any);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (config.folderId) {
    headers["X-UIPATH-OrganizationUnitId"] = config.folderId;
  }

  const processFeedUrl = `${baseUrl}/odata/Processes?$filter=Id eq '${encodeURIComponent(projectName)}'&$top=1`;
  const processFeedRes = await fetch(processFeedUrl, { headers });
  const processFeedText = await processFeedRes.text();
  let processFeedBody: any = null;
  try { processFeedBody = JSON.parse(processFeedText); } catch {}

  let releaseResult: any = null;
  if (upload.ok && processFeedRes.ok && (processFeedBody?.value?.length || 0) > 0) {
    const existingReleaseUrl = `${baseUrl}/odata/Releases?$filter=ProcessKey eq '${encodeURIComponent(projectName)}'&$top=1`;
    const existingRes = await fetch(existingReleaseUrl, { headers });
    const existingText = await existingRes.text();
    let existingBody: any = null;
    try { existingBody = JSON.parse(existingText); } catch {}

    if ((existingBody?.value?.length || 0) > 0) {
      releaseResult = {
        action: "exists",
        status: existingRes.status,
        body: existingBody.value[0],
      };
    } else {
      const createBody = {
        Name: processName,
        ProcessKey: projectName,
        ProcessVersion: version,
        EntryPointPath: "Main.xaml",
        Description: "Smoke deployment from Codex",
      };
      const createRes = await fetch(`${baseUrl}/odata/Releases`, {
        method: "POST",
        headers,
        body: JSON.stringify(createBody),
      });
      const createText = await createRes.text();
      let createJson: any = null;
      try { createJson = JSON.parse(createText); } catch {}
      releaseResult = {
        action: "create",
        status: createRes.status,
        ok: createRes.ok,
        body: createJson ?? createText,
      };
    }
  }

  console.log(JSON.stringify({
    upload,
    processFeed: {
      status: processFeedRes.status,
      ok: processFeedRes.ok,
      body: processFeedBody ?? processFeedText,
    },
    releaseResult,
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
