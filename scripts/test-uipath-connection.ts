import { metadataService } from "../server/catalog/metadata-service";
import { getAccessToken, getDefaultOrScopes } from "../server/uipath-auth";

async function main() {
  const envConfig = {
    orgName: process.env.UIPATH_ORGANIZATION_ID || "",
    tenantName: process.env.UIPATH_TENANT_NAME || "",
    folderId: process.env.UIPATH_FOLDER_ID || undefined,
    clientId: process.env.UIPATH_CLIENT_ID || "",
    clientSecret: process.env.UIPATH_CLIENT_SECRET || "",
    scopes: process.env.UIPATH_SCOPES || getDefaultOrScopes(),
  };

  if (!envConfig.orgName || !envConfig.tenantName || !envConfig.clientId || !envConfig.clientSecret) {
    console.log(JSON.stringify({
      ok: false,
      message: "Missing one or more required UIPATH_* environment variables.",
    }, null, 2));
    process.exit(1);
  }

  const token = await getAccessToken({
    clientId: envConfig.clientId,
    clientSecret: envConfig.clientSecret,
    scopes: envConfig.scopes,
  });

  const orchUrl = metadataService.getServiceUrl("OR", envConfig);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (envConfig.folderId) {
    headers["X-UIPATH-OrganizationUnitId"] = envConfig.folderId;
  }

  const folderUrl = `${orchUrl}/odata/Folders?$top=3`;
  const machineUrl = `${orchUrl}/odata/Machines?$top=3`;

  const folderRes = await fetch(folderUrl, { headers });
  const machineRes = await fetch(machineUrl, { headers });

  const folderText = await folderRes.text();
  const machineText = await machineRes.text();

  let folderBody: any = null;
  let machineBody: any = null;
  try { folderBody = JSON.parse(folderText); } catch {}
  try { machineBody = JSON.parse(machineText); } catch {}

  console.log(JSON.stringify({
    ok: true,
    config: envConfig,
    tokenAcquired: true,
    orchestrator: {
      baseUrl: orchUrl,
      folders: {
        status: folderRes.status,
        ok: folderRes.ok,
        body: folderBody ?? folderText.slice(0, 500),
      },
      machines: {
        status: machineRes.status,
        ok: machineRes.ok,
        body: machineBody ?? machineText.slice(0, 500),
      },
    },
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
