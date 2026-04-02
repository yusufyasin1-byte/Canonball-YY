import { db } from "./db";
import { appSettings, uipathConnections } from "@shared/schema";
import { eq } from "drizzle-orm";
import archiver from "archiver";
import { metadataService as _mdsStatic, ORCHESTRATOR_ODATA_PATHS as ODP } from "./catalog/metadata-service";
import type { ServiceResourceType } from "./catalog/metadata-schemas";
import AdmZip from "adm-zip";
import { createHash } from "crypto";
import { PassThrough } from "stream";
import { getAccessToken } from "./uipath-auth";
import {
  generateRichXamlFromSpec,
  generateRichXamlFromNodes,
  generateInitAllSettingsXaml,
  generateReframeworkMainXaml,
  generateGetTransactionDataXaml,
  generateSetTransactionStatusXaml,
  generateCloseAllApplicationsXaml,
  generateKillAllProcessesXaml,
  aggregateGaps,
  generateDeveloperHandoffGuide,
  generateDhgSummary,
  normalizeXaml as makeUiPathCompliant,
  ensureBracketWrapped,
  validateXamlContent,
  generateStubWorkflow,
  selectGenerationMode,
  applyActivityPolicy,
  isReFrameworkFile,
  replaceActivityWithStub,
  replaceSequenceChildrenWithStub,
  type GenerationMode,
  type GenerationModeConfig,
  type XamlGeneratorResult,
  type XamlGap,
  type TargetFramework,
  type XamlValidationViolation,
  type DhgQualityIssue,
} from "./xaml-generator";
export type { GenerationMode };

export {
  type BuildResult,
  buildNuGetPackage,
  removeDuplicateAttributes,
  clearPackageCache,
  normalizePackageName,
  rebuildNupkgWithEntries,
} from "./package-assembler";

import { buildNuGetPackage, type BuildResult, isValidNuGetVersion, uploadNupkgBuffer } from "./package-assembler";

import type { XamlGenerationContext, UiPathPackage } from "./types/uipath-package";
import { enrichWithAITree, type EnrichmentResult, type TreeEnrichmentResult } from "./ai-xaml-enricher";
import { assembleWorkflowFromSpec } from "./workflow-tree-assembler";
import type { WorkflowSpec as TreeWorkflowSpec } from "./workflow-spec-types";
import { analyzeAndFix, setGovernancePolicies, type AnalysisReport } from "./workflow-analyzer";
import { runQualityGate, formatQualityGateViolations, classifyQualityIssues, getBlockingFiles, hasOnlyWarnings, hasBlockingIssues, type QualityGateResult, type ClassifiedIssue } from "./uipath-quality-gate";
import { escapeXml } from "./lib/xml-utils";
import { computePackageFingerprint } from "./lib/utils";
import { scanXamlForRequiredPackages, classifyAutomationPattern, shouldUseReFramework, type AutomationPattern, ACTIVITY_NAME_ALIAS_MAP, normalizeActivityName } from "./uipath-activity-registry";
import { filterBlockedActivitiesFromXaml } from "./uipath-activity-policy";
import { catalogService, type ProcessType } from "./catalog/catalog-service";

export { QualityGateError, UIPATH_PACKAGE_ALIAS_MAP, type UiPathConfig } from "./uipath-shared";
import { QualityGateError, type UiPathConfig } from "./uipath-shared";

export async function getUiPathConfig(): Promise<UiPathConfig | null> {
  const { getConfig } = await import("./uipath-auth");
  const authConfig = await getConfig();
  if (authConfig) {
    return {
      orgName: authConfig.orgName,
      tenantName: authConfig.tenantName,
      clientId: authConfig.clientId,
      clientSecret: authConfig.clientSecret,
      scopes: authConfig.scopes,
      folderId: authConfig.folderId,
      folderName: authConfig.folderName,
    };
  }
  return null;
}

export async function getCommunicationsMiningToken(): Promise<string | null> {
  const activeRows = await db
    .select()
    .from(uipathConnections)
    .where(eq(uipathConnections.isActive, true));
  if (activeRows.length === 0) return null;
  return activeRows[0].communicationsMiningToken || null;
}

export async function saveCommunicationsMiningToken(token: string): Promise<void> {
  const activeRows = await db
    .select()
    .from(uipathConnections)
    .where(eq(uipathConnections.isActive, true));
  if (activeRows.length === 0) {
    throw new Error("No active UiPath connection found. Configure an Orchestrator connection first.");
  }
  await db
    .update(uipathConnections)
    .set({ communicationsMiningToken: token.trim() })
    .where(eq(uipathConnections.id, activeRows[0].id));
}

export async function clearCommunicationsMiningToken(): Promise<void> {
  const activeRows = await db
    .select()
    .from(uipathConnections)
    .where(eq(uipathConnections.isActive, true));
  if (activeRows.length > 0) {
    await db
      .update(uipathConnections)
      .set({ communicationsMiningToken: null })
      .where(eq(uipathConnections.id, activeRows[0].id));
  }
}

export async function getCommunicationsMiningStatus(): Promise<{
  configured: boolean;
  connected: boolean;
  message: string;
}> {
  const config = await getUiPathConfig();
  if (!config) {
    return { configured: false, connected: false, message: "UiPath is not configured" };
  }

  const token = await getCommunicationsMiningToken();
  if (!token) {
    return { configured: false, connected: false, message: "Communications Mining API token not configured" };
  }

  try {
    const { metadataService } = await import("./catalog/metadata-service");
    const reinferUrl = metadataService.getServiceUrl("REINFER", config);
    const res = await fetch(`${reinferUrl}/api/v1/datasets`, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        configured: true,
        connected: false,
        message: `Communications Mining connection failed (${res.status}): ${text.slice(0, 200)}`,
      };
    }

    return {
      configured: true,
      connected: true,
      message: "Connected to Communications Mining",
    };
  } catch (err: any) {
    return {
      configured: true,
      connected: false,
      message: `Communications Mining connection error: ${err.message}`,
    };
  }
}

function extractOrgName(input: string): string {
  let val = input.trim();
  val = val.replace(/^https?:\/\//, "");
  val = val.replace(/^cloud\.uipath\.com\//, "");
  val = val.replace(/\/+$/, "");
  val = val.split("/")[0];
  return val.trim();
}

export async function saveUiPathConfig(config: { orgName: string; tenantName: string; clientId: string; clientSecret?: string; scopes?: string }): Promise<void> {
  const entries: { key: string; value: string }[] = [
    { key: "uipath_org_name", value: extractOrgName(config.orgName) },
    { key: "uipath_tenant_name", value: config.tenantName.trim() },
    { key: "uipath_client_id", value: config.clientId.trim() },
  ];

  if (config.clientSecret) {
    entries.push({ key: "uipath_client_secret", value: config.clientSecret.trim() });
  }

  if (config.scopes) {
    entries.push({ key: "uipath_scopes", value: config.scopes.trim() });
  }

  for (const entry of entries) {
    const existing = await db.select().from(appSettings).where(eq(appSettings.key, entry.key));
    if (existing.length > 0) {
      await db.update(appSettings).set({ value: entry.value, updatedAt: new Date() }).where(eq(appSettings.key, entry.key));
    } else {
      await db.insert(appSettings).values(entry);
    }
  }

  const { invalidateConfig } = await import("./uipath-auth");
  invalidateConfig();
}

async function upsertSetting(key: string, value: string): Promise<void> {
  const existing = await db.select().from(appSettings).where(eq(appSettings.key, key));
  if (existing.length > 0) {
    await db.update(appSettings).set({ value, updatedAt: new Date() }).where(eq(appSettings.key, key));
  } else {
    await db.insert(appSettings).values({ key, value });
  }
}

export async function saveUiPathFolder(folderId: string | null, folderName: string | null): Promise<void> {
  if (folderId && folderName) {
    await upsertSetting("uipath_folder_id", folderId);
    await upsertSetting("uipath_folder_name", folderName);
  } else {
    const existing1 = await db.select().from(appSettings).where(eq(appSettings.key, "uipath_folder_id"));
    if (existing1.length > 0) {
      await db.delete(appSettings).where(eq(appSettings.key, "uipath_folder_id"));
    }
    const existing2 = await db.select().from(appSettings).where(eq(appSettings.key, "uipath_folder_name"));
    if (existing2.length > 0) {
      await db.delete(appSettings).where(eq(appSettings.key, "uipath_folder_name"));
    }
  }

  const { uipathConnections } = await import("@shared/schema");
  const { eq: eqOp } = await import("drizzle-orm");
  const activeRows = await db.select().from(uipathConnections).where(eqOp(uipathConnections.isActive, true));
  if (activeRows.length > 0) {
    await db.update(uipathConnections).set({
      folderId: folderId || null,
      folderName: folderName || null,
    }).where(eqOp(uipathConnections.id, activeRows[0].id));
  }

  const { invalidateConfig } = await import("./uipath-auth");
  invalidateConfig();
}

export async function fetchUiPathFolders(): Promise<{ success: boolean; folders?: { id: number; displayName: string; fullyQualifiedName: string }[]; message?: string }> {
  const config = await getUiPathConfig();
  if (!config) {
    return { success: false, message: "UiPath is not configured." };
  }

  try {
    const token = await getAccessToken(config);
    const { metadataService } = await import("./catalog/metadata-service");
    const orchUrl = metadataService.getServiceUrl("OR", config);
    const url = `${orchUrl}${ODP.Folders}?$orderby=DisplayName&$top=100`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      return { success: false, message: `Failed to fetch folders (${res.status}): ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const folders = (data.value || []).map((f: any) => ({
      id: f.Id,
      displayName: f.DisplayName,
      fullyQualifiedName: f.FullyQualifiedName || f.DisplayName,
    }));
    return { success: true, folders };
  } catch (err: any) {
    return { success: false, message: `Failed to fetch folders: ${err.message}` };
  }
}

export async function recordLastTestedAt(): Promise<void> {
  await upsertSetting("uipath_last_tested", new Date().toISOString());
}

export async function getLastTestedAt(): Promise<string | null> {
  const rows = await db.select().from(appSettings).where(eq(appSettings.key, "uipath_last_tested"));
  return rows.length > 0 ? rows[0].value : null;
}

export { getAccessToken } from "./uipath-auth";

export async function pushToUiPath(pkg: UiPathPackage, ideaId?: string, prebuiltResult?: BuildResult): Promise<{ success: boolean; message: string; details?: any }> {
  const config = await getUiPathConfig();
  if (!config) {
    return { success: false, message: "UiPath Orchestrator is not configured. Go to Admin > Integrations to set it up." };
  }

  const projectName = (pkg.projectName || "Automation").replace(/\s+/g, "_");

  try {
    const token = await getAccessToken(config);

    const now = new Date();
    const patch = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
    let version = `1.0.${patch}`;

    const buildResult = prebuiltResult || await buildNuGetPackage(pkg, version, ideaId);
    if (prebuiltResult) {
      console.log(`[UiPath] Using pre-built .nupkg for "${projectName}" — ${buildResult.buffer.length} bytes`);
    } else {
      console.log(`[UiPath] Built .nupkg for "${projectName}" v${version} — ${buildResult.buffer.length} bytes (${buildResult.gaps.length} gaps, ${buildResult.usedPackages.length} packages)`);
    }

    let result = { ...(await uploadNupkgBuffer(config, token, buildResult.buffer, projectName, version)), gaps: buildResult.gaps };

    if (result.status === 409) {
      const hourMin = now.getHours() * 100 + now.getMinutes();
      version = `1.${hourMin}.${patch}`;
      console.log(`[UiPath] Version conflict — rebuilding with v${version} (reusing cached enrichment)`);
      const retryBuild = await buildNuGetPackage(pkg, version, ideaId);
      console.log(`[UiPath] Rebuilt .nupkg for "${projectName}" v${version} — ${retryBuild.buffer.length} bytes`);
      result = { ...(await uploadNupkgBuffer(config, token, retryBuild.buffer, projectName, version)), gaps: retryBuild.gaps };
    }

    if (!result.ok) {
      let friendlyMsg = `Upload failed (HTTP ${result.status}).`;

      if (result.status === 409) {
        friendlyMsg = `Package "${projectName}" already exists in all attempted versions (1.0.0 – ${version}). Delete old versions in Orchestrator or use a different package name.`;
      } else if (result.status === 400) {
        friendlyMsg = `UiPath rejected the package (invalid format). Response: ${result.responseText.slice(0, 300)}`;
      } else if (result.status === 403) {
        const orchScopes = _mdsStatic.getScopeGuidance("orchestrator");
        friendlyMsg = `Access denied. Your External Application may not have the required scope (${orchScopes}). Check Admin > External Applications in UiPath Cloud.`;
      } else {
        friendlyMsg += ` ${result.responseText.slice(0, 300)}`;
      }

      return { success: false, message: friendlyMsg };
    }

    let uploadedId = projectName;
    let uploadedVersion = version;
    let uploadedKey = `${projectName}:${version}`;
    let projectType = "Process";

    try {
      const responseData = JSON.parse(result.responseText);

      if (responseData?.value?.[0]?.Body) {
        const body = JSON.parse(responseData.value[0].Body);
        uploadedId = body.Id || projectName;
        uploadedVersion = body.Version || version;
        uploadedKey = `${uploadedId}:${uploadedVersion}`;
        projectType = body.ProjectType || "Process";
        console.log(`[UiPath] Parsed bulk response — Id: ${uploadedId}, Version: ${uploadedVersion}`);
      } else if (responseData?.Id) {
        uploadedId = responseData.Id;
        uploadedVersion = responseData.Version || version;
        uploadedKey = responseData.Key || `${uploadedId}:${uploadedVersion}`;
        projectType = responseData.ProjectType || "Process";
      }
    } catch (e: any) {
      console.log(`[UiPath] Could not parse response — using defaults. Raw: ${result.responseText.slice(0, 500)}`);
    }

    const orchUrl = orchBaseUrl(config);
    const folderInfo = config.folderName ? ` into folder "${config.folderName}"` : " to the tenant feed";

    const locationSteps = config.folderName
      ? [
          `• Go to ${orchUrl}`,
          `• Open folder "${config.folderName}" in the left sidebar`,
          `• Click "Packages" tab`,
          `• Search for "${uploadedId}"`,
        ]
      : [
          `• Go to ${orchUrl}`,
          `• Navigate to Tenant > Packages`,
          `• Search for "${uploadedId}"`,
        ];

    const dhgSummary = result.gaps.length > 0 ? generateDhgSummary(result.gaps) : "";

    const successMsg = [
      `Package "${uploadedId}" v${uploadedVersion} uploaded successfully${folderInfo}.`,
      ``,
      `Where to find it:`,
      ...locationSteps,
      ``,
      `Package key: ${uploadedKey}`,
      `Type: ${projectType}`,
      `Org: ${config.orgName} / Tenant: ${config.tenantName}`,
      ...(config.folderName ? [`Folder: ${config.folderName}`] : []),
      ...(dhgSummary ? [``, `---`, ``, dhgSummary] : []),
    ].join("\n");

    return {
      success: true,
      message: successMsg,
      details: {
        packageId: uploadedId,
        version: uploadedVersion,
        key: uploadedKey,
        projectType,
        orgName: config.orgName,
        tenantName: config.tenantName,
        orchestratorUrl: orchUrl,
        folderName: config.folderName || null,
        folderId: config.folderId || null,
        gapCount: result.gaps.length,
        dhgSummary: dhgSummary || null,
      },
    };
  } catch (err: any) {
    if (err instanceof QualityGateError) {
      throw err;
    }
    const msg = err.message || String(err);
    console.error(`[UiPath] Push failed for "${projectName}":`, msg);

    let friendlyMsg = `Push failed: ${msg}`;
    if (msg.includes("invalid_scope")) {
      const orchScopeHint = _mdsStatic.getScopeGuidance("orchestrator");
      friendlyMsg = `Authentication failed — invalid scopes. Make sure your External Application in UiPath Cloud has the required scopes (${orchScopeHint}).`;
    } else if (msg.includes("invalid_client")) {
      friendlyMsg = `Authentication failed — invalid App ID or App Secret. Verify your credentials in Admin > Integrations.`;
    }

    return { success: false, message: friendlyMsg };
  }
}

function orchBaseUrl(config: UiPathConfig): string {
  return _mdsStatic.getServiceUrl("OR", config);
}

function folderHeaders(config: UiPathConfig, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (config.folderId) {
    headers["X-UIPATH-OrganizationUnitId"] = config.folderId;
  }
  return headers;
}

async function resolvePackageVersionFromFeed(packageId: string, knownVersion: string): Promise<string | null> {
  try {
    const config = await getUiPathConfig();
    if (!config) {
      return isValidNuGetVersion(knownVersion) ? knownVersion : null;
    }
    const token = await getAccessToken(config);
    const base = orchBaseUrl(config);
    const hdrs = folderHeaders(config, token);
    const feedUrl = `${base}${ODP.GetPackageVersions(packageId)}`;
    const res = await fetch(feedUrl, { headers: hdrs, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const versions = data.value || [];
      if (versions.length > 0) {
        const latest = versions[versions.length - 1]?.Version || versions[0]?.Version;
        if (latest) {
          const resolved = latest;
          if (isValidNuGetVersion(resolved)) {
            console.log(`[UiPath Feed] Resolved ${packageId} to v${latest} from tenant feed`);
            return resolved;
          } else {
            console.log(`[UiPath Feed] Rejected invalid version for ${packageId}: ${resolved}`);
          }
        }
      }
    }
  } catch (e: any) {
    console.warn(`[UiPath] Version lookup failed: ${e.message}`);
  }
  return isValidNuGetVersion(knownVersion) ? knownVersion : null;
}

export { resolvePackageVersionFromFeed };

async function tryCreateRelease(
  base: string,
  headers: Record<string, string>,
  body: Record<string, any>,
  folderLabel: string
): Promise<{ ok: boolean; status: number; data?: any; text?: string }> {
  console.log(`[UiPath] Creating process in ${folderLabel}: ${JSON.stringify(body)}`);
  const res = await fetch(`${base}${ODP.Releases}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`[UiPath] Create process response from ${folderLabel} (${res.status}): ${text.slice(0, 500)}`);
  if (res.ok) {
    return { ok: true, status: res.status, data: JSON.parse(text) };
  }
  return { ok: false, status: res.status, text };
}

export async function createProcess(
  packageId: string,
  packageVersion: string,
  processName: string,
  description?: string
): Promise<{ success: boolean; message: string; process?: any }> {
  const config = await getUiPathConfig();
  if (!config) return { success: false, message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const existingRes = await fetch(
      `${base}${ODP.Releases}?$filter=ProcessKey eq '${encodeURIComponent(packageId)}'&$top=1`,
      { headers }
    );
    if (existingRes.ok) {
      const existingData = await existingRes.json();
      if (existingData.value?.length > 0) {
        const existing = existingData.value[0];
        if (existing.ProcessVersion !== packageVersion) {
          const updateRes = await fetch(`${base}${ODP.Releases}(${existing.Id})`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ProcessVersion: packageVersion }),
          });
          if (updateRes.ok) {
            console.log(`[UiPath] Updated process "${existing.Name}" to v${packageVersion}`);
            return {
              success: true,
              message: `Process "${existing.Name}" updated to v${packageVersion}.`,
              process: { ...existing, ProcessVersion: packageVersion },
            };
          }
        }
        console.log(`[UiPath] Process already exists: "${existing.Name}" (ID: ${existing.Id})`);
        return {
          success: true,
          message: `Process "${existing.Name}" already exists.`,
          process: existing,
        };
      }
    }

    const pkgCheck = await fetch(
      `${base}${ODP.Processes}?$filter=Id eq '${encodeURIComponent(packageId)}'&$top=1`,
      { headers }
    );
    let packageInFeed = false;
    if (pkgCheck.ok) {
      const pkgData = await pkgCheck.json();
      packageInFeed = (pkgData.value?.length || 0) > 0;
      console.log(`[UiPath] Package feed check: ${packageInFeed ? "found" : "not found"} for ${packageId}`);
    }

    if (!packageInFeed) {
      return {
        success: false,
        message: `Package "${packageId}" was uploaded but is not yet indexed in the Orchestrator feed. This typically happens with stub packages. Open the package in UiPath Studio and publish it to create a runnable process.`,
      };
    }

    const releaseBody: Record<string, any> = {
      Name: processName,
      ProcessKey: packageId,
      ProcessVersion: packageVersion,
      EntryPointPath: "Main.xaml",
      Description: (description || `Created by CannonBall`).slice(0, 250),
    };

    const result = await tryCreateRelease(base, headers, releaseBody, config.folderName || "configured folder");

    if (result.ok) {
      return {
        success: true,
        message: `Process "${result.data.Name}" created successfully (ID: ${result.data.Id}).`,
        process: result.data,
      };
    }

    const isPackageNotFound = result.text?.includes("1677") || result.text?.includes("Package not found");

    if (isPackageNotFound) {
      console.log(`[UiPath] Package not found in configured folder "${config.folderName}" (FeedType may be FolderHierarchy).`);

      let suggestedFolders: string[] = [];
      try {
        const foldersRes = await fetch(`${base}${ODP.Folders}?$top=50&$orderby=DisplayName`, {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (foldersRes.ok) {
          const foldersData = await foldersRes.json();
          suggestedFolders = (foldersData.value || [])
            .filter((f: any) => f.FeedType === "Processes" && f.IsActive)
            .slice(0, 5)
            .map((f: any) => f.DisplayName);
        }
      } catch (e: any) { console.warn(`[UiPath] Failed to fetch suggested folders: ${e.message}`); }

      const suggestion = suggestedFolders.length > 0
        ? ` Compatible folders in your tenant: ${suggestedFolders.map(n => `"${n}"`).join(", ")}. Update your folder selection in Admin > Integrations.`
        : " Try switching to a folder with standard feed type in Admin > Integrations.";

      return {
        success: false,
        message: `Package "${packageId}" uploaded successfully and is indexed in the feed, but Process (Release) creation failed because folder "${config.folderName}" uses a "FolderHierarchy" feed type which doesn't support API-based Release creation.${suggestion} Alternatively, create the Process manually in Orchestrator from the uploaded package.`,
      };
    }

    if (result.status === 403) {
      return { success: false, message: `Access denied creating process. ${_mdsStatic.getRemediationStep("orchestrator")}` };
    }
    return { success: false, message: `Failed to create process (${result.status}): ${(result.text || "").slice(0, 200)}` };
  } catch (err: any) {
    console.error("[UiPath] Create process error:", err.message);
    return { success: false, message: `Failed to create process: ${err.message}` };
  }
}

export async function listMachines(): Promise<{ success: boolean; machines?: any[]; message?: string }> {
  const config = await getUiPathConfig();
  if (!config) return { success: false, message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const res = await fetch(`${base}${ODP.Machines}?$top=50&$orderby=Name`, { headers });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 403) {
        return { success: false, message: `Access denied. ${_mdsStatic.getRemediationStep("orchestrator")}` };
      }
      return { success: false, message: `Failed to fetch machines (${res.status}): ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const machines = (data.value || []).map((m: any) => ({
      id: m.Id,
      name: m.Name,
      type: m.Type,
      status: m.Status,
      description: m.Description,
    }));
    return { success: true, machines };
  } catch (err: any) {
    return { success: false, message: `Failed to fetch machines: ${err.message}` };
  }
}

export async function listRobots(): Promise<{ success: boolean; robots?: any[]; message?: string }> {
  const config = await getUiPathConfig();
  if (!config) return { success: false, message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const res = await fetch(`${base}${ODP.Sessions}?$top=50&$orderby=Robot/Name`, { headers });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 403) {
        return { success: false, message: `Access denied. ${_mdsStatic.getRemediationStep("orchestrator")}` };
      }
      return { success: false, message: `Failed to fetch robots (${res.status}): ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const robots = (data.value || []).map((s: any) => ({
      id: s.Id,
      robotId: s.Robot?.Id,
      robotName: s.Robot?.Name || s.Robot?.MachineName || "Unknown",
      machineName: s.Robot?.MachineName || s.HostMachineName || "Unknown",
      status: s.Status || "Unknown",
      type: s.Robot?.Type || "Unknown",
      isUnresponsive: s.IsUnresponsive,
    }));
    return { success: true, robots };
  } catch (err: any) {
    return { success: false, message: `Failed to fetch robots: ${err.message}` };
  }
}

export async function listProcesses(): Promise<{ success: boolean; processes?: any[]; message?: string }> {
  const config = await getUiPathConfig();
  if (!config) return { success: false, message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const res = await fetch(`${base}${ODP.Releases}?$top=50&$orderby=Name`, { headers });
    if (!res.ok) {
      const errText = await res.text();
      return { success: false, message: `Failed to fetch processes (${res.status}): ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const processes = (data.value || []).map((r: any) => ({
      id: r.Id,
      name: r.Name,
      processKey: r.ProcessKey,
      processVersion: r.ProcessVersion,
      isLatestVersion: r.IsLatestVersion,
      description: r.Description,
    }));
    return { success: true, processes };
  } catch (err: any) {
    return { success: false, message: `Failed to fetch processes: ${err.message}` };
  }
}

export type GovernancePolicy = {
  id: string;
  name: string;
  description: string;
  type: "naming" | "activity-restriction" | "error-handling" | "security" | "general";
  severity: "error" | "warning" | "info";
  pattern?: string;
  restrictedActivities?: string[];
  requiredPatterns?: string[];
};

export type AutomationOpsResult = {
  available: boolean;
  policies: GovernancePolicy[];
  message: string;
};

export async function discoverGovernancePolicies(): Promise<AutomationOpsResult> {
  const config = await getUiPathConfig();
  if (!config) return { available: false, policies: [], message: "UiPath is not configured." };

  try {
    const { tryAcquireResourceToken } = await import("./uipath-auth");
    const pmResult = await tryAcquireResourceToken("PM").catch(() => ({ ok: false, scopes: [] as string[] }));
    let token: string;
    if (pmResult.ok) {
      const { getPmToken } = await import("./uipath-auth");
      token = await getPmToken();
    } else {
      token = await getAccessToken(config);
    }
    const { metadataService } = await import("./catalog/metadata-service");
    const base = metadataService.getCloudBaseUrl(config);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const aopsTaxEntry = metadataService.getCapabilityTaxonomyEntry("automationOps");
    const aopsServiceUrl = metadataService.getServiceUrl("AUTOMATIONOPS", config);
    const aopsSecondaryPaths = aopsTaxEntry?.secondaryProbePaths || [];
    const aopsPoliciesPath = aopsSecondaryPaths[0];
    const aopsRulesPath = aopsSecondaryPaths[1];
    const aopsLabel = aopsTaxEntry?.displayName || "Automation Ops";

    if (!aopsPoliciesPath) {
      return { available: false, policies: [], message: `${aopsLabel} probe paths not configured in taxonomy.` };
    }

    const policiesRes = await fetch(`${aopsServiceUrl}${aopsPoliciesPath}`, { headers }).catch(() => null);
    if (!policiesRes || !policiesRes.ok) {
      if (policiesRes && policiesRes.status === 404) {
        return { available: false, policies: [], message: `${aopsLabel} is not enabled on this tenant.` };
      }
      if (policiesRes && policiesRes.status === 403) {
        return { available: false, policies: [], message: `Access denied to ${aopsLabel}. Check app scopes.` };
      }

      const rulesRes = aopsRulesPath
        ? await fetch(`${aopsServiceUrl}${aopsRulesPath}`, { headers }).catch(() => null)
        : null;
      if (rulesRes && rulesRes.ok) {
        const rulesData = await rulesRes.json();
        const rules = (rulesData.value || rulesData.items || []);
        const policies: GovernancePolicy[] = rules.map((r: any) => ({
          id: r.Id || r.id || r.RuleId,
          name: r.Name || r.name || r.RuleName || "Unknown Rule",
          description: r.Description || r.description || "",
          type: classifyPolicyType(r.Name || r.name || r.Category || ""),
          severity: mapPolicySeverity(r.Severity || r.severity || r.DefaultAction || "warning"),
          pattern: r.Pattern || r.pattern || undefined,
          restrictedActivities: r.RestrictedActivities || undefined,
          requiredPatterns: r.RequiredPatterns || undefined,
        }));
        console.log(`[Automation Ops] Discovered ${policies.length} governance rules via rules API`);
        return { available: true, policies, message: `${policies.length} governance rules active.` };
      }

      return { available: false, policies: [], message: "Automation Ops API not accessible." };
    }

    const data = await policiesRes.json();
    const rawPolicies = data.value || data.items || data.policies || [];
    const policies: GovernancePolicy[] = rawPolicies.map((p: any) => ({
      id: p.Id || p.id || p.PolicyId,
      name: p.Name || p.name || p.PolicyName || "Unknown Policy",
      description: p.Description || p.description || "",
      type: classifyPolicyType(p.Name || p.name || p.Type || p.Category || ""),
      severity: mapPolicySeverity(p.Severity || p.severity || p.DefaultAction || "warning"),
      pattern: p.Pattern || p.pattern || undefined,
      restrictedActivities: p.RestrictedActivities || p.restrictedActivities || undefined,
      requiredPatterns: p.RequiredPatterns || p.requiredPatterns || undefined,
    }));

    console.log(`[Automation Ops] Discovered ${policies.length} governance policies`);
    return { available: true, policies, message: `${policies.length} governance policies active.` };
  } catch (err: any) {
    console.warn(`[Automation Ops] Discovery failed: ${err.message}`);
    return { available: false, policies: [], message: `Discovery failed: ${err.message}` };
  }
}

function classifyPolicyType(nameOrCategory: string): GovernancePolicy["type"] {
  const lower = nameOrCategory.toLowerCase();
  if (lower.includes("naming") || lower.includes("convention") || lower.includes("nmg")) return "naming";
  if (lower.includes("restrict") || lower.includes("block") || lower.includes("forbidden") || lower.includes("activity")) return "activity-restriction";
  if (lower.includes("error") || lower.includes("catch") || lower.includes("exception") || lower.includes("dbp")) return "error-handling";
  if (lower.includes("secur") || lower.includes("credential") || lower.includes("password") || lower.includes("sec")) return "security";
  return "general";
}

function mapPolicySeverity(severity: string): GovernancePolicy["severity"] {
  const lower = severity.toLowerCase();
  if (lower === "error" || lower === "block" || lower === "reject") return "error";
  if (lower === "info" || lower === "informational") return "info";
  return "warning";
}

export type AttendedRobotInfo = {
  available: boolean;
  attendedRobots: Array<{ id: number; name: string; machineName: string; status: string; userName?: string }>;
  unattendedRobots: Array<{ id: number; name: string; machineName: string; status: string }>;
  hasAttended: boolean;
  hasUnattended: boolean;
  message: string;
};

export async function discoverAttendedRobots(): Promise<AttendedRobotInfo> {
  const config = await getUiPathConfig();
  if (!config) return { available: false, attendedRobots: [], unattendedRobots: [], hasAttended: false, hasUnattended: false, message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const res = await fetch(`${base}${ODP.Sessions}?$top=100&$expand=Robot`, { headers });
    if (!res.ok) {
      return { available: false, attendedRobots: [], unattendedRobots: [], hasAttended: false, hasUnattended: false, message: `Sessions API returned ${res.status}` };
    }

    const data = await res.json();
    const sessions = data.value || [];
    const attended: AttendedRobotInfo["attendedRobots"] = [];
    const unattended: AttendedRobotInfo["unattendedRobots"] = [];

    for (const s of sessions) {
      const robotType = s.Robot?.Type || s.Type || "";
      const entry = {
        id: s.Robot?.Id || s.Id,
        name: s.Robot?.Name || "Unknown",
        machineName: s.Robot?.MachineName || s.HostMachineName || "Unknown",
        status: s.Status || "Unknown",
      };
      if (robotType === "Attended" || robotType === "Development" || robotType === "CitizenDeveloper") {
        attended.push({ ...entry, userName: s.Robot?.Username });
      } else {
        unattended.push(entry);
      }
    }

    console.log(`[Assistant Discovery] ${attended.length} attended, ${unattended.length} unattended robots`);
    return {
      available: true,
      attendedRobots: attended,
      unattendedRobots: unattended,
      hasAttended: attended.length > 0,
      hasUnattended: unattended.length > 0,
      message: `${attended.length} attended, ${unattended.length} unattended robots discovered.`,
    };
  } catch (err: any) {
    console.warn(`[Assistant Discovery] Failed: ${err.message}`);
    return { available: false, attendedRobots: [], unattendedRobots: [], hasAttended: false, hasUnattended: false, message: `Discovery failed: ${err.message}` };
  }
}

export type StudioProject = {
  id: string;
  name: string;
  description: string;
  projectType: string;
  lastModified?: string;
  feedId?: string;
};

export type StudioProcessesResult = {
  available: boolean;
  projects: StudioProject[];
  existingNames: string[];
  message: string;
};

export async function discoverStudioProjects(): Promise<StudioProcessesResult> {
  const config = await getUiPathConfig();
  if (!config) return { available: false, projects: [], existingNames: [], message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const [releasesRes, packagesRes] = await Promise.all([
      fetch(`${base}${ODP.Releases}?$top=200&$orderby=Name&$select=Id,Name,ProcessKey,ProcessVersion,Description`, { headers }).catch(() => null),
      fetch(`${base}${ODP.Processes}?$top=200&$orderby=Title&$select=Id,Title,Version,Description,IsActive`, { headers }).catch(() => null),
    ]);

    const projects: StudioProject[] = [];
    const nameSet = new Set<string>();

    if (releasesRes && releasesRes.ok) {
      const data = await releasesRes.json();
      for (const r of (data.value || [])) {
        const name = r.Name || r.ProcessKey;
        if (name && !nameSet.has(name)) {
          nameSet.add(name);
          projects.push({
            id: String(r.Id),
            name,
            description: r.Description || "",
            projectType: "release",
            feedId: r.ProcessKey,
          });
        }
      }
    }

    if (packagesRes && packagesRes.ok) {
      const data = await packagesRes.json();
      for (const p of (data.value || [])) {
        const name = p.Title || p.Id;
        if (name && !nameSet.has(name)) {
          nameSet.add(name);
          projects.push({
            id: String(p.Id),
            name,
            description: p.Description || "",
            projectType: "package",
          });
        }
      }
    }

    console.log(`[Studio Discovery] ${projects.length} existing projects/processes found`);
    return {
      available: projects.length > 0 || (releasesRes?.ok ?? false),
      projects,
      existingNames: Array.from(nameSet),
      message: `${projects.length} existing processes discovered.`,
    };
  } catch (err: any) {
    console.warn(`[Studio Discovery] Failed: ${err.message}`);
    return { available: false, projects: [], existingNames: [], message: `Discovery failed: ${err.message}` };
  }
}

export async function startJob(
  processReleaseKey: string,
  robotIds?: number[]
): Promise<{ success: boolean; message: string; job?: any }> {
  const config = await getUiPathConfig();
  if (!config) return { success: false, message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const startInfo: Record<string, any> = {
      ReleaseKey: processReleaseKey,
      Strategy: "ModernJobsCount",
      JobsCount: 1,
    };

    if (robotIds && robotIds.length > 0) {
      startInfo.Strategy = "Specific";
      startInfo.RobotIds = robotIds;
    }

    const body = { startInfo };
    console.log(`[UiPath] Starting job: ${JSON.stringify(body)}`);

    const res = await fetch(
      `${base}${ODP.StartJobs}`,
      { method: "POST", headers, body: JSON.stringify(body) }
    );

    const text = await res.text();
    console.log(`[UiPath] Start job response (${res.status}): ${text.slice(0, 500)}`);

    if (!res.ok) {
      if (res.status === 403) {
        return { success: false, message: `Access denied. ${_mdsStatic.getRemediationStep("orchestrator")}` };
      }
      let errorDetail = text.slice(0, 300);
      try {
        const errObj = JSON.parse(text);
        errorDetail = errObj.message || errObj.errorMessage || errorDetail;
      } catch (e: any) { console.warn(`[UiPath] Failed to parse job error response: ${e.message}`); }
      return { success: false, message: `Failed to start job (${res.status}): ${errorDetail}` };
    }

    const data = JSON.parse(text);
    const jobs = data.value || [data];
    const job = jobs[0];
    return {
      success: true,
      message: `Job started successfully (ID: ${job.Id}, State: ${job.State}).`,
      job: {
        id: job.Id,
        key: job.Key,
        state: job.State,
        startTime: job.StartTime,
        releaseKey: processReleaseKey,
      },
    };
  } catch (err: any) {
    console.error("[UiPath] Start job error:", err.message);
    return { success: false, message: `Failed to start job: ${err.message}` };
  }
}

export async function getJobStatus(jobId: number): Promise<{ success: boolean; message: string; job?: any }> {
  const config = await getUiPathConfig();
  if (!config) return { success: false, message: "UiPath is not configured." };

  try {
    const token = await getAccessToken(config);
    const headers = folderHeaders(config, token);
    const base = orchBaseUrl(config);

    const res = await fetch(`${base}${ODP.Jobs}(${jobId})`, { headers });
    if (!res.ok) {
      return { success: false, message: `Failed to fetch job status (${res.status})` };
    }
    const data = await res.json();
    return {
      success: true,
      message: `Job ${data.Id}: ${data.State}`,
      job: {
        id: data.Id,
        key: data.Key,
        state: data.State,
        startTime: data.StartTime,
        endTime: data.EndTime,
        info: data.Info,
        outputData: data.OutputData,
        hostMachineName: data.HostMachineName,
        releaseName: data.ReleaseName,
      },
    };
  } catch (err: any) {
    return { success: false, message: `Failed to fetch job status: ${err.message}` };
  }
}

export async function runHealthCheck(packageId?: string): Promise<{
  checks: Array<{ name: string; status: "pass" | "fail" | "warn"; message: string; details?: any }>;
  summary: string;
}> {
  const checks: Array<{ name: string; status: "pass" | "fail" | "warn"; message: string; details?: any }> = [];

  const config = await getUiPathConfig();
  if (!config) {
    checks.push({ name: "Connection", status: "fail", message: "UiPath is not configured. Go to Admin > Integrations to set it up." });
    return { checks, summary: "Not configured" };
  }

  let token: string;
  try {
    token = await getAccessToken(config);
    checks.push({ name: "Authentication", status: "pass", message: "OAuth token obtained successfully." });
  } catch (err: any) {
    checks.push({ name: "Authentication", status: "fail", message: `Authentication failed: ${err.message}` });
    return { checks, summary: "Authentication failed" };
  }

  const headers = folderHeaders(config, token);
  const base = orchBaseUrl(config);

  try {
    const res = await fetch(`${base}${ODP.Folders}?$top=1`, { headers });
    if (res.ok) {
      checks.push({ name: "API Access", status: "pass", message: "Connected to Orchestrator API." });
    } else {
      checks.push({ name: "API Access", status: "fail", message: `API returned ${res.status}. Check org/tenant names.` });
      return { checks, summary: "API access failed" };
    }
  } catch (err: any) {
    checks.push({ name: "API Access", status: "fail", message: `Cannot reach Orchestrator: ${err.message}` });
    return { checks, summary: "Cannot reach API" };
  }

  if (config.folderId) {
    try {
      const res = await fetch(`${base}${ODP.Folders}?$filter=Id eq ${config.folderId}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (data.value?.length > 0) {
          checks.push({ name: "Target Folder", status: "pass", message: `Folder "${config.folderName}" (ID: ${config.folderId}) exists.` });
        } else {
          checks.push({ name: "Target Folder", status: "fail", message: `Folder ID ${config.folderId} not found. Re-select in Admin > Integrations.` });
        }
      }
    } catch (e: any) {
      checks.push({ name: "Target Folder", status: "warn", message: "Could not verify folder." });
    }
  } else {
    checks.push({ name: "Target Folder", status: "warn", message: "No folder selected — packages go to tenant feed. Select a folder in Admin > Integrations for better organization." });
  }

  if (packageId) {
    try {
      const res = await fetch(
        `${base}${ODP.Processes}?$filter=Id eq '${encodeURIComponent(packageId)}'&$top=1`,
        { headers }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.value?.length > 0) {
          const pkg = data.value[0];
          checks.push({ name: "Package", status: "pass", message: `Package "${packageId}" v${pkg.Version} found in feed.`, details: { version: pkg.Version } });
        } else {
          checks.push({ name: "Package", status: "fail", message: `Package "${packageId}" not found in feed. Push it first.` });
        }
      }
    } catch (e: any) {
      checks.push({ name: "Package", status: "warn", message: "Could not check package status." });
    }

    try {
      const res = await fetch(
        `${base}${ODP.Releases}?$filter=ProcessKey eq '${encodeURIComponent(packageId)}'&$top=1`,
        { headers }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.value?.length > 0) {
          const proc = data.value[0];
          checks.push({
            name: "Process",
            status: "pass",
            message: `Process "${proc.Name}" linked to package (v${proc.ProcessVersion}).`,
            details: { processId: proc.Id, releaseKey: proc.Key, version: proc.ProcessVersion },
          });
        } else {
          checks.push({ name: "Process", status: "fail", message: `No process created from package "${packageId}". Create one to run it.` });
        }
      }
    } catch (e: any) {
      checks.push({ name: "Process", status: "warn", message: "Could not check process status." });
    }
  }

  try {
    const res = await fetch(`${base}${ODP.Sessions}?$top=10`, { headers });
    if (res.ok) {
      const data = await res.json();
      const sessions = data.value || [];
      const available = sessions.filter((s: any) => s.Status === "Available");
      if (sessions.length === 0) {
        checks.push({
          name: "Robots",
          status: "fail",
          message: "No robot sessions found in this folder. Assign robots in Orchestrator > Folder Settings > Machines & Robots.",
          details: { count: 0 },
        });
      } else if (available.length === 0) {
        checks.push({
          name: "Robots",
          status: "warn",
          message: `${sessions.length} robot(s) found but none are "Available". They may be busy or disconnected.`,
          details: { total: sessions.length, available: 0 },
        });
      } else {
        checks.push({
          name: "Robots",
          status: "pass",
          message: `${available.length} robot(s) available out of ${sessions.length} total.`,
          details: { total: sessions.length, available: available.length },
        });
      }
    } else {
      checks.push({ name: "Robots", status: "warn", message: `Could not check robot sessions. ${_mdsStatic.getRemediationStep("orchestrator")}` });
    }
  } catch (e: any) {
    checks.push({ name: "Robots", status: "warn", message: "Could not check robot sessions." });
  }

  try {
    const res = await fetch(`${base}${ODP.Machines}?$top=10`, { headers });
    if (res.ok) {
      const data = await res.json();
      const machines = data.value || [];
      if (machines.length === 0) {
        checks.push({
          name: "Machines",
          status: "warn",
          message: "No machine templates found. Create machine templates in Orchestrator > Tenant > Machines.",
          details: { count: 0 },
        });
      } else {
        checks.push({
          name: "Machines",
          status: "pass",
          message: `${machines.length} machine template(s) available.`,
          details: { count: machines.length },
        });
      }
    }
  } catch (e: any) {
    checks.push({ name: "Machines", status: "warn", message: "Could not check machines." });
  }

  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const passCount = checks.filter((c) => c.status === "pass").length;

  let summary: string;
  if (failCount > 0) {
    summary = `${failCount} issue(s) found — fix them to run automations.`;
  } else if (warnCount > 0) {
    summary = `All critical checks passed. ${warnCount} warning(s).`;
  } else {
    summary = `All ${passCount} checks passed — ready to run automations.`;
  }

  return { checks, summary };
}

export type LicenseInfo = {
  runtime: Array<{ type: string; allowed: number; used: number; available: number }>;
  namedUser: Array<{ type: string; allowed: number; used: number; available: number }>;
  summary: string;
  recommendations: string[];
};

async function fetchLicenseInfo(orchBase: string, hdrs: Record<string, string>): Promise<LicenseInfo | null> {
  try {
    const [runtimeRes, namedUserRes] = await Promise.all([
      fetch(`${orchBase}${ODP.LicensesRuntime}`, { headers: hdrs }).catch(() => null),
      fetch(`${orchBase}${ODP.LicensesNamedUser}`, { headers: hdrs }).catch(() => null),
    ]);

    const runtime: LicenseInfo["runtime"] = [];
    const namedUser: LicenseInfo["namedUser"] = [];

    if (runtimeRes?.ok) {
      try {
        const data = await runtimeRes.json();
        const items = data.value || (Array.isArray(data) ? data : []);
        for (const item of items) {
          const type = item.RuntimeType || item.Type || item.LicenseType || "Unknown";
          const allowed = item.Allowed ?? item.Total ?? item.Count ?? 0;
          const used = item.Used ?? item.InUse ?? 0;
          if (allowed > 0 || used > 0) {
            runtime.push({ type, allowed, used, available: Math.max(0, allowed - used) });
          }
        }
      } catch (e: any) { /* runtime license parse error */ }
    }

    if (!runtimeRes?.ok) {
      try {
        const settingsRes = await fetch(`${orchBase}${ODP.GetLicense}`, { headers: hdrs });
        if (settingsRes.ok) {
          const data = await settingsRes.json();
          if (data.Attended !== undefined) runtime.push({ type: "Attended", allowed: data.Attended || 0, used: 0, available: data.Attended || 0 });
          if (data.Unattended !== undefined) runtime.push({ type: "Unattended", allowed: data.Unattended || 0, used: 0, available: data.Unattended || 0 });
          if (data.NonProduction !== undefined) runtime.push({ type: "NonProduction", allowed: data.NonProduction || 0, used: 0, available: data.NonProduction || 0 });
          if (data.Development !== undefined) runtime.push({ type: "Development", allowed: data.Development || 0, used: 0, available: data.Development || 0 });
          if (data.TestAutomation !== undefined) runtime.push({ type: "TestAutomation", allowed: data.TestAutomation || 0, used: 0, available: data.TestAutomation || 0 });
        }
      } catch (e: any) { /* fallback license query also failed */ }
    }

    if (namedUserRes?.ok) {
      try {
        const data = await namedUserRes.json();
        const items = data.value || (Array.isArray(data) ? data : []);
        for (const item of items) {
          const type = item.UserType || item.Type || item.LicenseType || "Unknown";
          const allowed = item.Allowed ?? item.Total ?? 0;
          const used = item.Used ?? item.InUse ?? 0;
          if (allowed > 0 || used > 0) {
            namedUser.push({ type, allowed, used, available: Math.max(0, allowed - used) });
          }
        }
      } catch (e: any) { /* named user license parse error */ }
    }

    if (runtime.length === 0 && namedUser.length === 0) return null;

    const summaryParts: string[] = [];
    for (const r of runtime) {
      summaryParts.push(`${r.type}: ${r.used}/${r.allowed} used (${r.available} available)`);
    }
    for (const n of namedUser) {
      summaryParts.push(`${n.type} (Named User): ${n.used}/${n.allowed} used`);
    }

    const recommendations: string[] = [];
    const hasUnattended = runtime.some(r => r.type === "Unattended" && r.allowed > 0);
    const hasAttended = runtime.some(r => r.type === "Attended" && r.allowed > 0);
    const hasTestAuto = runtime.some(r => r.type === "TestAutomation" && r.allowed > 0);
    const hasNonProd = runtime.some(r => r.type === "NonProduction" && r.allowed > 0);

    if (!hasUnattended) {
      recommendations.push("**Unattended Robot License**: Not available. Adding Unattended licenses would enable fully autonomous back-office automation — scheduled processing, queue-based workloads, and 24/7 execution without human intervention.");
    }
    if (!hasAttended) {
      recommendations.push("**Attended Robot License**: Not available. Adding Attended licenses would enable human-assisted automation — desktop bots that help users complete tasks faster with side-by-side guidance.");
    }
    if (!hasTestAuto) {
      recommendations.push("**Test Automation License**: Not available. Adding Test Automation licenses would enable automated regression testing of the automation using UiPath Test Manager, ensuring quality across updates.");
    }
    if (!hasNonProd) {
      recommendations.push("**Non-Production License**: Not available. Adding Non-Production licenses would provide a dedicated testing/staging environment for the automation before production deployment.");
    }

    return {
      runtime,
      namedUser,
      summary: summaryParts.join("; "),
      recommendations,
    };
  } catch (err: any) {
    console.warn(`[UiPath] License fetch failed: ${err.message}`);
    return null;
  }
}

export type PlatformCapabilityProfile = {
  configured: boolean;
  available: {
    orchestrator: boolean;
    actionCenter: boolean;
    documentUnderstanding: boolean;
    generativeExtraction: boolean;
    communicationsMining: boolean;
    testManager: boolean;
    storageBuckets: boolean;
    aiCenter: boolean;
    maestro: boolean;
    integrationService: boolean;
    ixp: boolean;
    automationHub: boolean;
    automationOps: boolean;
    automationStore: boolean;
    apps: boolean;
    assistant: boolean;
  };
  grantedScopes: string[];
  summary: string;
  availableDescription: string;
  unavailableRecommendations: string;
  licenseInfo?: LicenseInfo | null;
  integrationService?: IntegrationServiceDiscovery;
  aiCenterSkills?: AICenterSkill[];
  aiCenterPackages?: AICenterPackage[];
};

export type AICenterSkill = {
  id: string;
  name: string;
  mlPackageName: string;
  mlPackageVersionId: string;
  status: string;
  inputType: string;
  outputType: string;
  gpu: boolean;
  projectName: string;
};

export type AICenterPackage = {
  id: string;
  name: string;
  description: string;
  inputType: string;
  outputType: string;
  trainingStatus: string;
  projectName: string;
};

type AgentCapabilities = {
  autonomous: boolean;
  conversational: boolean;
  coded: boolean;
};

type UnifiedProbeResult = {
  configured: boolean;
  flags: {
    orchestrator: boolean;
    actionCenter: boolean;
    testManager: boolean;
    documentUnderstanding: boolean;
    generativeExtraction: boolean;
    communicationsMining: boolean;
    dataService: boolean;
    platformManagement: boolean;
    environments: boolean;
    triggers: boolean;
    storageBuckets: boolean;
    aiCenter: boolean;
    agents: boolean;
    autopilot: boolean;
    maestro: boolean;
    integrationService: boolean;
    ixp: boolean;
    automationHub: boolean;
    automationOps: boolean;
    automationStore: boolean;
    apps: boolean;
    assistant: boolean;
    attendedRobots: boolean;
    studioProjects: boolean;
    hasUnattendedSlots: boolean;
  };
  agentCapabilities?: AgentCapabilities;
  agentConfidence?: "official" | "inferred";
  grantedScopes: string[];
  licenseInfo: LicenseInfo | null;
  aiCenterSkills: AICenterSkill[];
  aiCenterPackages: AICenterPackage[];
  governancePolicies?: GovernancePolicy[];
  attendedRobotInfo?: AttendedRobotInfo;
  studioProjectInfo?: StudioProcessesResult;
  serverlessDetected?: boolean;
  probeHttpStatuses?: Record<string, number | null>;
  tokenFailures?: Record<string, string>;
  cmRequiresDedicatedToken?: boolean;
  cachedAt: number;
  probeFailed?: boolean;
  probeError?: string;
  internalError?: boolean;
};

let _probeCache: UnifiedProbeResult | null = null;
let _probeCacheConfigAt = 0;
const PROBE_CACHE_TTL_MS = 60_000;

export function clearProbeCache(): void {
  _probeCache = null;
  _probeCacheConfigAt = 0;
}

export function getProbeCache(): UnifiedProbeResult | null {
  return _probeCache;
}

async function fetchWithAlternates(
  primaryUrl: string,
  alternateUrls: string[],
  headers: Record<string, string>,
  resourceType: string,
  probePath?: string,
): Promise<{ res: Response | null; usedUrl: string; triedAlternate: boolean }> {
  try {
    const res = await fetch(primaryUrl, { headers });
    if (res.ok || res.status === 401 || res.status === 403) {
      if (res.ok) {
        const text = await res.clone().text();
        const trimmed = text.trimStart();
        if (trimmed.startsWith("<") || trimmed.startsWith("<!DOCTYPE")) {
          console.log(`[UiPath Probe] ${resourceType}: primary ${primaryUrl} returned HTML — trying alternates`);
        } else {
          return { res, usedUrl: primaryUrl, triedAlternate: false };
        }
      } else {
        return { res, usedUrl: primaryUrl, triedAlternate: false };
      }
    }
  } catch { /* primary failed, try alternates */ }

  for (const alt of alternateUrls) {
    if (alt === primaryUrl) continue;
    try {
      const res = await fetch(alt, { headers });
      if (res.ok || res.status === 401 || res.status === 403) {
        if (res.ok) {
          const text = await res.clone().text();
          const trimmed = text.trimStart();
          if (trimmed.startsWith("<") || trimmed.startsWith("<!DOCTYPE")) {
            console.log(`[UiPath Probe] ${resourceType}: alternate ${alt} returned HTML — skipping`);
            continue;
          }
        }
        const baseUrl = probePath ? alt.replace(probePath, "") : alt;
        console.log(`[UiPath Probe] ${resourceType}: primary URL failed, alternate succeeded: ${baseUrl}`);
        const { metadataService: mds } = await import("./catalog/metadata-service");
        mds.setActiveEndpoint(resourceType as import("./catalog/metadata-schemas").ServiceResourceType, baseUrl);
        return { res, usedUrl: alt, triedAlternate: true };
      }
    } catch { /* alternate also failed */ }
  }

  try {
    const res = await fetch(primaryUrl, { headers });
    return { res, usedUrl: primaryUrl, triedAlternate: false };
  } catch {
    return { res: null, usedUrl: primaryUrl, triedAlternate: false };
  }
}

type ProbeResultEntry = {
  available: boolean;
  httpStatus: number | null;
  reachability: "reachable" | "limited" | "unreachable" | "unknown";
  response?: Response | null;
  authLimited?: boolean;
};

function isServiceReachable(res: Response | null): boolean {
  if (!res) return false;
  if (res.ok) return true;
  if (res.status === 403 || res.status === 401) return true;
  if (res.status >= 300 && res.status < 400) return true;
  return false;
}

function getServiceReachabilityStatus(res: Response | null): "reachable" | "limited" | "unreachable" | "unknown" {
  if (!res) return "unknown";
  if (res.ok) return "reachable";
  if (res.status === 401 || res.status === 403) return "limited";
  if (res.status >= 300 && res.status < 400) return "limited";
  return "unreachable";
}

async function probeEndpointByTaxonomy(
  entry: import("./catalog/metadata-schemas").CapabilityTaxonomyEntry,
  config: UiPathConfig,
  headersByToken: Record<string, Record<string, string>>,
  metadataSvc: typeof import("./catalog/metadata-service").metadataService,
): Promise<ProbeResultEntry> {
  const pc = entry.probeConfig;
  if (!pc) return { available: false, httpStatus: null, reachability: "unknown" };

  const svcType = entry.serviceResourceType as import("./catalog/metadata-schemas").ServiceResourceType;
  const serviceUrl = metadataSvc.getServiceUrl(svcType, config);
  const probePath = pc.probePath;
  const hdrs = headersByToken[pc.tokenResource || "OR"] || headersByToken["OR"];
  const primaryUrl = `${serviceUrl}${probePath}`;

  try {
    let res: Response | null = null;
    if (pc.useAlternates) {
      const alternates = metadataSvc.getServiceUrlAlternates(svcType, config);
      const result = await fetchWithAlternates(
        primaryUrl,
        alternates.map(u => `${u}${probePath}`),
        hdrs,
        svcType,
        probePath,
      );
      res = result.res;
      if (result.triedAlternate) {
        console.log(`[UiPath Probe] ${entry.displayName}: alternate URL succeeded: ${result.usedUrl}`);
      }
    } else {
      res = await fetch(primaryUrl, { headers: hdrs, redirect: "manual" }).catch(() => null);
    }

    const reachability = getServiceReachabilityStatus(res);
    const isOk = res?.ok ?? false;
    const isAuthLimited = !isOk && (res?.status === 401 || res?.status === 403);
    const available = isOk || (!!pc.acceptLimitedAuth && isAuthLimited);
    if (available) {
      const status = isAuthLimited ? "limited" as const : reachability;
      console.log(`[UiPath Probe] ${entry.displayName} ${isAuthLimited ? "reachable (auth-limited)" : "available"} (${res?.status})`);
      metadataSvc.updateServiceReachability(svcType, status);
    } else {
      let bodySnippet = "";
      try {
        if (res) {
          const text = await res.clone().text();
          bodySnippet = text.substring(0, 200);
        }
      } catch { /* ignore */ }
      console.warn(`[UiPath Probe] ${entry.displayName} probe returned ${res?.status ?? "no response"}: ${bodySnippet}`);
    }
    return { available, httpStatus: res?.status ?? null, reachability, response: res, authLimited: isAuthLimited };
  } catch (e: any) {
    console.warn(`[UiPath Probe] ${entry.displayName} probe failed: ${e.message}`);
    return { available: false, httpStatus: null, reachability: "unknown" };
  }
}

async function probeAllServices(): Promise<UnifiedProbeResult> {
  const { getConfigLoadedAt } = await import("./uipath-auth");
  const currentConfigAt = getConfigLoadedAt();
  if (_probeCache && Date.now() - _probeCache.cachedAt < PROBE_CACHE_TTL_MS && currentConfigAt === _probeCacheConfigAt) {
    return _probeCache;
  }

  const { metadataService } = await import("./catalog/metadata-service");
  const taxonomy = metadataService.getCapabilityTaxonomy();
  const taxonomyByFlag = new Map<string, import("./catalog/metadata-schemas").CapabilityTaxonomyEntry>();
  for (const entry of taxonomy) {
    taxonomyByFlag.set(entry.flagKey, entry);
  }

  const emptyFlags: UnifiedProbeResult["flags"] = {} as UnifiedProbeResult["flags"];
  for (const entry of taxonomy) {
    (emptyFlags as Record<string, boolean>)[entry.flagKey] = false;
  }

  const empty: UnifiedProbeResult = {
    configured: false,
    flags: { ...emptyFlags },
    grantedScopes: [],
    licenseInfo: null,
    aiCenterSkills: [],
    aiCenterPackages: [],
    cachedAt: Date.now(),
  };

  const config = await getUiPathConfig();
  if (!config) {
    _probeCache = empty;
    _probeCacheConfigAt = currentConfigAt;
    return empty;
  }

  try {
    const { getHeaders: getOrHeaders, tryAcquireResourceToken, getDuToken } = await import("./uipath-auth");
    const token = await getAccessToken(config);
    const hdrs = await getOrHeaders();
    const orchBase = metadataService.getServiceUrl("OR", config);

    let grantedScopes: string[] = [];
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
        const scopeVal = payload.scope || payload.scp;
        if (scopeVal) grantedScopes = Array.isArray(scopeVal) ? scopeVal : scopeVal.split(/\s+/);
      }
    } catch (e: any) {
      console.warn(`[UiPath Probe] Failed to decode JWT scopes: ${e.message}`);
      grantedScopes = config.scopes.split(/\s+/);
    }

    const orchEntry = taxonomyByFlag.get("orchestrator");
    const orchProbePath = orchEntry!.probeConfig!.probePath;
    const orchRes = await fetch(`${orchBase}${orchProbePath}`, { headers: hdrs });
    if (!orchRes.ok) {
      const result: UnifiedProbeResult = {
        configured: true, flags: { ...emptyFlags, orchestrator: false, environments: false, triggers: false, apps: false },
        grantedScopes, licenseInfo: null, aiCenterSkills: [], aiCenterPackages: [],
        governancePolicies: [],
        probeHttpStatuses: { orchestrator: orchRes.status },
        cachedAt: Date.now(),
      };
      _probeCache = result;
      _probeCacheConfigAt = currentConfigAt;
      return result;
    }

    type ResourceType = "OR" | "TM" | "DU" | "PM" | "DF" | "PIMS" | "IXP" | "AI";
    const { TOKEN_RESOURCE_TO_SERVICE: resToSvc } = await import("./catalog/metadata-service");
    const guardedTokenAcquire = (rt: ResourceType) => {
      const svcType = (resToSvc[rt] || rt) as import("./catalog/metadata-schemas").ServiceResourceType;
      if (!metadataService.hasOidcScopeFamily(svcType)) {
        console.log(`[UiPath Probe] ${rt}: no OIDC scope family — skipping token acquisition`);
        return Promise.resolve({ ok: false, scopes: [] as string[] });
      }
      return tryAcquireResourceToken(rt);
    };

    type TokenResult = PromiseSettledResult<{ ok: boolean; scopes: string[] }>;
    const tokenResults: Record<string, TokenResult> = {};
    const tokenResourceSet = new Set<string>();
    const tokenFlagMap: Record<string, string> = {};
    for (const entry of taxonomy) {
      const tokenRes = entry.probeConfig?.tokenResource;
      if (tokenRes && tokenRes !== "OR") {
        tokenResourceSet.add(tokenRes);
        tokenFlagMap[tokenRes] = entry.flagKey;
      }
    }
    const tokenResources = Array.from(tokenResourceSet) as ResourceType[];
    const settled = await Promise.allSettled(tokenResources.map(rt => guardedTokenAcquire(rt)));
    for (let i = 0; i < tokenResources.length; i++) {
      tokenResults[tokenResources[i]] = settled[i];
    }

    const isTokenOk = (rt: string): boolean => {
      const r = tokenResults[rt];
      return r?.status === "fulfilled" && r.value.ok;
    };

    const tokenFailures: Record<string, string> = {};
    for (const [rt, flagKey] of Object.entries(tokenFlagMap)) {
      const result = tokenResults[rt];
      if (!result) continue;
      if (result.status === "rejected") {
        tokenFailures[flagKey] = `Token acquisition rejected: ${(result as PromiseRejectedResult).reason?.message || "unknown error"}`;
      } else if (!result.value.ok) {
        tokenFailures[flagKey] = "Token acquisition failed: resource not provisioned or missing scopes";
      }
    }

    const headersByToken: Record<string, Record<string, string>> = { OR: hdrs };
    const authModule = await import("./uipath-auth");
    const tokenGetterMap: Record<string, () => Promise<string>> = {
      DU: authModule.getDuToken, AI: authModule.getAiToken,
      IXP: authModule.getIxpToken, PM: authModule.getPmToken,
      TM: authModule.getTmToken, DF: authModule.getDfToken,
    };
    const tokenGetters: Record<string, () => Promise<string>> = {};
    for (const rt of tokenResources) {
      if (tokenGetterMap[rt]) tokenGetters[rt] = tokenGetterMap[rt];
    }
    for (const [rt, getter] of Object.entries(tokenGetters)) {
      if (isTokenOk(rt)) {
        try {
          const tok = await getter();
          headersByToken[rt] = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
        } catch { headersByToken[rt] = hdrs; }
      } else {
        headersByToken[rt] = hdrs;
      }
    }
    if (config.folderId && headersByToken["DU"]) {
      headersByToken["DU"]["X-UIPATH-OrganizationUnitId"] = config.folderId;
    }

    const parentApiEntries = taxonomy.filter(e => e.probeStrategy === "parent-api" && e.probeConfig);
    const resolveParentApiProbe = (e: import("./catalog/metadata-schemas").CapabilityTaxonomyEntry) => {
      const tokenRes = e.probeConfig?.tokenResource || "OR";
      const probeHdrs = headersByToken[tokenRes] || hdrs;
      const parentFlag = e.parentService;
      let baseUrl = orchBase;
      if (parentFlag) {
        const parentEntry = taxonomyByFlag.get(parentFlag);
        if (parentEntry?.serviceResourceType) {
          try { baseUrl = metadataService.getServiceUrl(parentEntry.serviceResourceType, config); } catch { /* fallback */ }
        }
      }
      if (e.serviceResourceType && e.serviceResourceType !== "OR") {
        try { baseUrl = metadataService.getServiceUrl(e.serviceResourceType as import("./catalog/metadata-schemas").ServiceResourceType, config); } catch { /* fallback */ }
      }
      if (tokenRes !== "OR" && tokenRes !== "PM") {
        try { baseUrl = metadataService.getServiceUrl(tokenRes as import("./catalog/metadata-schemas").ServiceResourceType, config); } catch { /* fallback */ }
      }
      if (tokenRes === "PM") {
        try { baseUrl = metadataService.getServiceUrl("AUTOMATIONOPS" as import("./catalog/metadata-schemas").ServiceResourceType, config); } catch { /* fallback */ }
      }
      return fetch(`${baseUrl}${e.probeConfig!.probePath}`, { headers: probeHdrs }).catch(() => null);
    };
    const parentApiProbes = await Promise.all(parentApiEntries.map(resolveParentApiProbe));
    const parentApiResults: Record<string, Response | null> = {};
    for (let i = 0; i < parentApiEntries.length; i++) {
      parentApiResults[parentApiEntries[i].flagKey] = parentApiProbes[i];
    }
    const acRes = parentApiResults["actionCenter"] ?? null;
    const envRes = parentApiResults["environments"] ?? null;
    const trigRes = parentApiResults["triggers"] ?? null;
    const bucketRes = parentApiResults["storageBuckets"] ?? null;
    const trigTaxEntry = taxonomyByFlag.get("triggers");
    const trigSecondaryPaths = trigTaxEntry?.secondaryProbePaths || [];
    const schedRes = trigSecondaryPaths.length > 0
      ? await fetch(`${orchBase}${trigSecondaryPaths[0]}`, { headers: hdrs }).catch(() => null)
      : null;
    const licenseInfo = await fetchLicenseInfo(orchBase, hdrs);

    let acAvailable = false;
    if (acRes) {
      if (acRes.ok) {
        const acText = await acRes.text();
        const isHTML = acText.trim().startsWith("<");
        if (!isHTML) {
          try {
            const data = JSON.parse(acText);
            const hasError = data.errorCode || data["odata.error"] || (data.message && typeof data.message === "string" && data.message.includes("not onboarded"));
            acAvailable = !hasError;
          } catch { acAvailable = false; }
        }
      } else if (acRes.status === 401 || acRes.status === 403) {
        acAvailable = true;
      }
    }

    let envAvailable = true;
    if (envRes) {
      envAvailable = envRes.ok || envRes.status === 400;
      if (envRes.status === 404 || envRes.status === 405) envAvailable = false;
    }

    const queueTriggersOk = trigRes ? (trigRes.ok || trigRes.status === 400) && trigRes.status !== 404 && trigRes.status !== 405 : false;
    const processSchedulesOk = schedRes ? (schedRes.ok || schedRes.status === 400) && schedRes.status !== 404 && schedRes.status !== 405 : false;
    const triggersAvailable = queueTriggersOk || processSchedulesOk;
    const bucketsAvailable = bucketRes ? bucketRes.ok : false;

    const taxonomyProbeEntries = taxonomy.filter(e =>
      e.probeStrategy === "own-endpoint" && e.probeConfig && !e.customProbeHandler
    );

    for (const entry of taxonomyProbeEntries) {
      if (entry.serviceResourceType === "IXP") {
        console.log(`[UiPath Probe] IXP scope source: ${metadataService.getScopeSource("IXP")}, scopes: ${metadataService.getMinimalScopesForServiceString("IXP")}`);
      }
    }

    const taxonomyProbeResults = await Promise.all(
      taxonomyProbeEntries.map(entry => probeEndpointByTaxonomy(entry, config, headersByToken, metadataService))
    );
    const probeFlags: Record<string, boolean> = {};
    const probeHttpStatuses: Record<string, number | null> = {};
    for (let i = 0; i < taxonomyProbeEntries.length; i++) {
      const entry = taxonomyProbeEntries[i];
      const result = taxonomyProbeResults[i];
      probeFlags[entry.flagKey] = result.available;
      probeHttpStatuses[entry.flagKey] = result.httpStatus;
    }

    let tmAvailable = probeFlags["testManager"] ?? false;
    if (!tmAvailable && isTokenOk("TM")) {
      tmAvailable = true;
    }

    let duAvailable = false;
    let genExtractionAvailable = false;
    let commsMiningAvailable = false;
    let duProbeStatus: number | null = null;
    const duScopeSource = metadataService.getScopeSource("DU");
    const duRequestedScopes = metadataService.getMinimalScopesForService("DU");
    const duTokenResult = tokenResults["DU"];
    const duTokenOk = isTokenOk("DU");
    console.log(`[UiPath Probe] DU diagnostics: tokenOk=${duTokenOk}, scopeSource=${duScopeSource}, requestedScopes=[${duRequestedScopes.join(", ")}]`);
    if (duTokenResult?.status === "fulfilled" && duTokenResult.value.ok) {
      console.log(`[UiPath Probe] DU token granted scopes: [${duTokenResult.value.scopes.join(", ")}]`);
    } else if (duTokenResult?.status === "fulfilled" && !duTokenResult.value.ok) {
      const duTokenError = "error" in duTokenResult.value ? String(duTokenResult.value.error) : "unknown";
      console.log(`[UiPath Probe] DU token acquisition failed: ${duTokenError}`);
    } else if (duTokenResult?.status === "rejected") {
      console.log(`[UiPath Probe] DU token acquisition rejected: ${(duTokenResult as PromiseRejectedResult).reason?.message || "unknown"}`);
    }
    if (duTokenOk) {
      const duEntry = taxonomyByFlag.get("documentUnderstanding");
      if (duEntry?.probeConfig) {
        const duResult = await probeEndpointByTaxonomy(duEntry, config, headersByToken, metadataService);
        duAvailable = duResult.available;
        duProbeStatus = duResult.httpStatus;
        let duProbeBody = "";
        try {
          if (duResult.response) {
            duProbeBody = (await duResult.response.clone().text()).substring(0, 300);
          }
        } catch { /* ignore */ }
        console.log(`[UiPath Probe] DU Discovery API probe: available=${duAvailable}, httpStatus=${duProbeStatus}, responseSnippet=${duProbeBody || "(empty)"}`);
      }
    }

    let genExProbeStatus: number | null = null;
    const genEntry = taxonomyByFlag.get("generativeExtraction");
    if (genEntry?.probeConfig && (isTokenOk("IXP") || isTokenOk("DU"))) {
      const genSvcUrl = metadataService.getServiceUrl("IXP", config);
      const genProbePath = genEntry.probeConfig.probePath;

      if (isTokenOk("IXP")) {
        const genResult = await probeEndpointByTaxonomy(genEntry, config, headersByToken, metadataService);
        genExProbeStatus = genResult.httpStatus;
        let genIxpBodySnippet = "";
        if (genResult.available && genResult.response?.ok) {
          try {
            const text = await genResult.response.text();
            genIxpBodySnippet = text.substring(0, 200);
            const trimmed = text.trim();
            if (trimmed.length > 0 && !trimmed.startsWith("<")) {
              const parsed = JSON.parse(trimmed);
              genExtractionAvailable = !parsed.errorCode && !parsed.ErrorCode && !parsed["odata.error"];
            }
          } catch { genExtractionAvailable = false; }
        }
        if (genExtractionAvailable) {
          console.log("[UiPath Probe] Generative Extraction available via IXP token");
        } else {
          console.warn(`[UiPath Probe] Generative Extraction probe returned ${genExProbeStatus}: ${genIxpBodySnippet}`);
        }
      }

      if (!genExtractionAvailable && isTokenOk("DU")) {
        console.log("[UiPath Probe] Generative Extraction: trying DU token fallback");
        const duFallbackHdrs = headersByToken["DU"] || hdrs;
        try {
          const duFallbackRes = await fetch(`${genSvcUrl}${genProbePath}`, { headers: duFallbackHdrs }).catch(() => null);
          if (duFallbackRes) genExProbeStatus = duFallbackRes.status;
          if (duFallbackRes?.ok) {
            const fbText = await duFallbackRes.text();
            const fbTrimmed = fbText.trim();
            if (fbTrimmed.length > 0 && !fbTrimmed.startsWith("<")) {
              const fbParsed = JSON.parse(fbTrimmed);
              genExtractionAvailable = !fbParsed.errorCode && !fbParsed.ErrorCode && !fbParsed["odata.error"];
              if (genExtractionAvailable) {
                console.log("[UiPath Probe] Generative Extraction available via DU token fallback");
              }
            }
            if (!genExtractionAvailable) {
              console.warn(`[UiPath Probe] Generative Extraction DU fallback probe returned ${duFallbackRes.status}: ${fbText.substring(0, 200)}`);
            }
          } else if (duFallbackRes) {
            let bodySnippet = "";
            try { const t = await duFallbackRes.text(); bodySnippet = t.substring(0, 200); } catch { /* ignore */ }
            console.warn(`[UiPath Probe] Generative Extraction DU fallback probe returned ${duFallbackRes.status}: ${bodySnippet}`);
          }
        } catch { /* DU fallback failed */ }
      }
      if (!genExtractionAvailable) {
        console.warn(`[UiPath Probe] Generative Extraction probe returned ${genExProbeStatus}: not available after all attempts`);
      }
    }

    let cmProbeStatus: number | null = null;
    let cmRequiresDedicatedToken = false;
    const cmEntry = taxonomyByFlag.get("communicationsMining");
    if (cmEntry?.probeConfig) {
      const cmToken = await getCommunicationsMiningToken();
      if (cmToken) {
        const reinferUrl = metadataService.getServiceUrl("REINFER", config);
        const cmProbeUrl = `${reinferUrl}${cmEntry.probeConfig.probePath}`;
        const cmHdrs: Record<string, string> = {
          "Authorization": `Bearer ${cmToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        };
        try {
          const cmRes = await fetch(cmProbeUrl, { headers: cmHdrs });
          cmProbeStatus = cmRes.status;
          if (cmRes.ok) {
            const cmText = await cmRes.text();
            const trimmedCm = cmText.trim();
            if (trimmedCm.length > 0 && !trimmedCm.startsWith("<")) {
              try {
                const cmData = JSON.parse(trimmedCm);
                if (!cmData.errorCode && !cmData.ErrorCode && !cmData["odata.error"]) {
                  commsMiningAvailable = true;
                  metadataService.updateServiceReachability("REINFER", "reachable");
                  console.log("[UiPath Probe] Communications Mining available (dedicated token)");
                }
              } catch { /* invalid json */ }
            }
            if (!commsMiningAvailable) {
              console.warn(`[UiPath Probe] Communications Mining probe returned ${cmRes.status}: ${cmText.substring(0, 200)}`);
            }
          } else {
            let bodySnippet = "";
            try { const t = await cmRes.text(); bodySnippet = t.substring(0, 200); } catch { /* ignore */ }
            console.warn(`[UiPath Probe] Communications Mining probe returned ${cmRes.status}: ${bodySnippet}`);
          }
        } catch (e: any) { console.warn(`[UiPath Probe] Communications Mining probe failed: ${e.message}`); }
      } else {
        cmRequiresDedicatedToken = true;
        console.log("[UiPath Probe] Communications Mining skipped — no dedicated API token configured");
      }
    }

    let aiAvailable = false;
    let aiCenterSkills: AICenterSkill[] = [];
    let aiCenterPackages: AICenterPackage[] = [];
    const aiEntry = taxonomyByFlag.get("aiCenter");
    if (aiEntry?.probeConfig) {
      console.log(`[UiPath Probe] AI Center scope source: ${metadataService.getScopeSource("AI")}, scopes: ${metadataService.getMinimalScopesForServiceString("AI")}`);
      const aiProbeHdrs = headersByToken["AI"] || hdrs;
      const aiServiceUrl = metadataService.getServiceUrl("AI", config);
      const aiAlternates = metadataService.getServiceUrlAlternates("AI", config);
      const aiProbePath = aiEntry.probeConfig.probePath;
      const aiProbeResult = await fetchWithAlternates(
        `${aiServiceUrl}${aiProbePath}`,
        aiAlternates.map(u => `${u}${aiProbePath}`),
        aiProbeHdrs,
        "AI",
        aiProbePath,
      );
      const aiProbe = aiProbeResult.res;
      const aiActiveUrl = aiProbeResult.triedAlternate ? aiProbeResult.usedUrl.replace(aiProbePath, "") : aiServiceUrl;
      if (aiProbe && !isServiceReachable(aiProbe)) {
        let bodySnippet = "";
        try { const t = await aiProbe.clone().text(); bodySnippet = t.substring(0, 200); } catch { /* ignore */ }
        console.warn(`[UiPath Probe] AI Center probe returned ${aiProbe.status}: ${bodySnippet}`);
      }
      if (aiProbe && isServiceReachable(aiProbe)) {
        aiAvailable = true;
        metadataService.updateServiceReachability("AI", getServiceReachabilityStatus(aiProbe));
        const aiSecondaryPaths = aiEntry.secondaryProbePaths || [];
        try {
          const aiEnrichProbes = await Promise.all(
            aiSecondaryPaths.map(sp => fetch(`${aiActiveUrl}${sp}`, { headers: aiProbeHdrs }).catch(() => null))
          );
          const skillsRes = aiEnrichProbes[0] ?? null;
          const pkgsRes = aiEnrichProbes[1] ?? null;
          if (skillsRes && skillsRes.ok) {
            const skillsData = await skillsRes.json();
            const items = skillsData.dataList || skillsData.value || skillsData.items || [];
            aiCenterSkills = items.filter((s: any) => s.name).map((s: any) => ({
              id: s.id || s.mlSkillId || "",
              name: s.name,
              mlPackageName: s.mlPackageName || s.packageName || "",
              mlPackageVersionId: s.mlPackageVersionId || "",
              status: s.deploymentStatus || s.status || "unknown",
              inputType: s.inputType || s.inputDescription || "",
              outputType: s.outputType || s.outputDescription || "",
              gpu: s.requiresGpu || false,
              projectName: s.projectName || "",
            }));
          }
          if (pkgsRes && pkgsRes.ok) {
            const pkgsData = await pkgsRes.json();
            const items = pkgsData.dataList || pkgsData.value || pkgsData.items || [];
            aiCenterPackages = items.filter((p: any) => p.name).map((p: any) => ({
              id: p.id || p.mlPackageId || "",
              name: p.name,
              description: p.description || "",
              inputType: p.inputType || "",
              outputType: p.outputType || "",
              trainingStatus: p.trainingStatus || "",
              projectName: p.projectName || "",
            }));
          }
        } catch (aiErr: any) {
          console.warn(`[UiPath Probe] AI Center skills/packages fetch failed: ${aiErr.message}`);
        }
      }
      probeHttpStatuses["aiCenter"] = aiProbe?.status ?? null;
    }
    probeHttpStatuses["communicationsMining"] = cmProbeStatus;

    let agentsAvailable = false;
    let autopilotAvailable = false;
    let agentsProbeStatus: number | null = null;
    let agentCapabilities: { autonomous: boolean; conversational: boolean; coded: boolean } = { autonomous: false, conversational: false, coded: false };
    const agentsTaxEntry = taxonomyByFlag.get("agents");
    const autopilotTaxEntry = taxonomyByFlag.get("autopilot");
    const agentsServiceUrl = metadataService.getServiceUrl("AGENTS", config);
    const autopilotServiceUrl = metadataService.getServiceUrl("AUTOPILOT", config);
    const agentEndpoints: Array<{ url: string; label: string }> = [];
    if (agentsTaxEntry?.probeConfig) {
      agentEndpoints.push({ url: `${agentsServiceUrl}${agentsTaxEntry.probeConfig.probePath}`, label: agentsTaxEntry.displayName });
    }
    if (autopilotTaxEntry?.probeConfig) {
      agentEndpoints.push({ url: `${autopilotServiceUrl}${autopilotTaxEntry.probeConfig.probePath}`, label: autopilotTaxEntry.displayName });
    }
    const agentSecondaryPaths = agentsTaxEntry?.secondaryProbePaths || [];
    for (const sp of agentSecondaryPaths) {
      agentEndpoints.push({ url: `${orchBase}${sp}`, label: `${agentsTaxEntry?.displayName || "Agents"} (OR)` });
    }
    const agentProbeResults = await Promise.allSettled(
      agentEndpoints.map(ep => fetch(ep.url, { headers: hdrs }))
    );
    for (let i = 0; i < agentProbeResults.length; i++) {
      const pr = agentProbeResults[i];
      if (pr.status === "fulfilled" && agentsProbeStatus === null) {
        agentsProbeStatus = pr.value.status;
      }
      if (pr.status === "fulfilled" && pr.value.ok) {
        agentsAvailable = true;
        agentsProbeStatus = pr.value.status;
        if (agentEndpoints[i].label === autopilotTaxEntry?.displayName) {
          autopilotAvailable = true;
        }
        console.log(`[UiPath Probe] Agent capability discovered via ${agentEndpoints[i].label} API`);
        try {
          const body = await pr.value.json();
          const items = body?.value || body?.items || (Array.isArray(body) ? body : []);
          for (const item of items) {
            const aType = (item.agentType || item.type || "").toLowerCase();
            if (aType.includes("autonomous")) agentCapabilities.autonomous = true;
            else if (aType.includes("conversational") || aType.includes("chat")) agentCapabilities.conversational = true;
            else if (aType.includes("coded")) agentCapabilities.coded = true;
          }
        } catch { /* parse error */ }
        break;
      }
    }
    let agentConfidence: "official" | "inferred" = "official";
    if (!agentsAvailable && agentsTaxEntry?.inferredProbePath) {
      const assetFallback = await fetch(`${orchBase}${agentsTaxEntry.inferredProbePath}`, { headers: hdrs }).catch(() => null);
      if (assetFallback && assetFallback.ok) {
        agentsAvailable = true;
        agentConfidence = "inferred";
      }
    }
    if (agentsAvailable && !agentCapabilities.autonomous && !agentCapabilities.conversational && !agentCapabilities.coded) {
      agentCapabilities = { autonomous: true, conversational: true, coded: true };
    }
    probeHttpStatuses["agents"] = agentsProbeStatus;

    let pmAvailable = isTokenOk("PM");
    let dsAvailable = probeFlags["dataService"] ?? false;
    if (!dsAvailable && isTokenOk("DF")) {
      const dfServiceUrl = metadataService.getServiceUrl("DF", config);
      const dfTaxEntry = taxonomyByFlag.get("dataService");
      const dfProbePath = dfTaxEntry!.probeConfig!.probePath;
      const dfHdrs = headersByToken["DF"] || hdrs;
      const usingDfToken = headersByToken["DF"] !== hdrs && !!headersByToken["DF"];
      console.log(`[UiPath Probe] Data Service probe using ${usingDfToken ? "DF" : "OR"} token`);
      const dfEntityProbe = await fetch(`${dfServiceUrl}${dfProbePath}`, { headers: dfHdrs }).catch(() => null);
      if (dfEntityProbe) probeHttpStatuses["dataService"] = dfEntityProbe.status;
      if (dfEntityProbe && (dfEntityProbe.ok || dfEntityProbe.status === 401)) {
        dsAvailable = true;
        metadataService.updateServiceReachability("DF", getServiceReachabilityStatus(dfEntityProbe));
        console.log(`[UiPath Probe] Data Service available (${dfEntityProbe.status})`);
      }
      const dfSecondaryPaths = dfTaxEntry?.secondaryProbePaths || [];
      if (!dsAvailable && dfSecondaryPaths.length > 0) {
        const dfSwagger = await fetch(`${dfServiceUrl}${dfSecondaryPaths[0]}`, { redirect: "manual" }).catch(() => null);
        if (dfSwagger && dfSwagger.status === 200) dsAvailable = true;
      }
    }

    const pimsHasScopes = metadataService.hasOidcScopeFamily("PIMS" as import("./catalog/metadata-schemas").ServiceResourceType);
    const pimsHasConfiguredScopes = !pimsHasScopes && config?.scopes?.split(/\s+/).some(s => s.startsWith("PIMS."));
    const pimsResult = (pimsHasScopes || pimsHasConfiguredScopes)
      ? await tryAcquireResourceToken("PIMS").catch(() => ({ ok: false, scopes: [] as string[] }))
      : { ok: false, scopes: [] as string[] };
    if (!pimsHasScopes && !pimsHasConfiguredScopes) {
      console.log("[UiPath Probe] PIMS: no OIDC scope family and no configured PIMS scopes — skipping token acquisition");
    } else if (!pimsHasScopes && pimsHasConfiguredScopes) {
      console.log("[UiPath Probe] PIMS: not in OIDC discovery but configured PIMS scopes found — attempting token acquisition");
    }
    const maestroAvailable = (probeFlags["maestro"] ?? false) || pimsResult.ok;
    const isResAvail = parentApiResults["integrationService"];
    const integrationServiceAvailable = isResAvail ? (isResAvail.ok || isResAvail.status === 401 || isResAvail.status === 403) : false;
    if (isResAvail) probeHttpStatuses["integrationService"] = isResAvail.status;

    const opsRes = parentApiResults["automationOps"];
    const automationOpsFromParent = opsRes ? (opsRes.ok || opsRes.status === 401 || opsRes.status === 403) : false;
    if (opsRes) probeHttpStatuses["automationOps"] = opsRes.status;
    const automationOpsAvailable = (probeFlags["automationOps"] ?? false) || automationOpsFromParent;

    probeHttpStatuses["actionCenter"] = acRes?.status ?? null;
    probeHttpStatuses["environments"] = envRes?.status ?? null;
    probeHttpStatuses["triggers"] = trigRes?.status ?? schedRes?.status ?? null;
    probeHttpStatuses["storageBuckets"] = bucketRes?.status ?? null;
    probeHttpStatuses["documentUnderstanding"] = duProbeStatus;
    probeHttpStatuses["generativeExtraction"] = genExProbeStatus;

    const [govResult, attendedResult, studioResult] = await Promise.allSettled([
      discoverGovernancePolicies(),
      discoverAttendedRobots(),
      discoverStudioProjects(),
    ]);
    const govData = govResult.status === "fulfilled" ? govResult.value : null;
    const attendedData = attendedResult.status === "fulfilled" ? attendedResult.value : null;
    const studioData = studioResult.status === "fulfilled" ? studioResult.value : null;

    let serverlessDetected = false;
    let hasUnattendedSlots = false;
    const observationEntry = taxonomyByFlag.get("attendedRobots");
    const sessionProbePath = observationEntry?.probeConfig?.probePath;
    const machineSecondaryPaths = observationEntry?.secondaryProbePaths || [];
    try {
      const sessRes = sessionProbePath
        ? await fetch(`${orchBase}${sessionProbePath}`, { headers: hdrs })
        : null;
      if (sessRes && sessRes.ok) {
        const sessData = await sessRes.json();
        const sessions = sessData.value || [];
        serverlessDetected = sessions.some((s: any) =>
          (s.RuntimeType === "Serverless" || s.RobotType === "Serverless" ||
           (s.MachineTemplateName || "").toLowerCase().includes("serverless"))
        );
        hasUnattendedSlots = sessions.some((s: any) =>
          s.RuntimeType === "Unattended" || s.RobotType === "Unattended"
        );
      }
    } catch (e: any) {
      console.warn(`[UiPath Probe] Session probe failed: ${e.message}`);
    }
    if (!hasUnattendedSlots && machineSecondaryPaths.length > 0) {
      try {
        const machRes = await fetch(`${orchBase}${machineSecondaryPaths[0]}`, { headers: hdrs, signal: AbortSignal.timeout(5000) });
        if (machRes.ok) {
          const machData = await machRes.json();
          const machines = machData.value || [];
          hasUnattendedSlots = machines.some((m: any) => (m.UnattendedSlots || 0) > 0);
        }
      } catch { /* machine probe failed */ }
    }

    const resolvedFlags: Record<string, boolean> = {
      ...probeFlags,
      orchestrator: true,
      actionCenter: acAvailable,
      testManager: tmAvailable,
      documentUnderstanding: duAvailable,
      generativeExtraction: genExtractionAvailable,
      communicationsMining: commsMiningAvailable,
      dataService: dsAvailable,
      platformManagement: pmAvailable,
      integrationService: integrationServiceAvailable,
      environments: envAvailable,
      triggers: triggersAvailable,
      storageBuckets: bucketsAvailable,
      aiCenter: aiAvailable,
      agents: agentsAvailable,
      autopilot: autopilotAvailable,
      maestro: maestroAvailable,
      automationOps: (probeFlags["automationOps"] ?? false) || (govData?.available ?? false),
      attendedRobots: attendedData?.available ?? false,
      studioProjects: studioData?.available ?? false,
      hasUnattendedSlots,
    };
    const flags = { ...emptyFlags } as Record<string, boolean>;
    for (const entry of taxonomy) {
      flags[entry.flagKey] = resolvedFlags[entry.flagKey] ?? false;
    }
    flags["attendedRobots"] = resolvedFlags["attendedRobots"] ?? false;
    flags["studioProjects"] = resolvedFlags["studioProjects"] ?? false;
    flags["hasUnattendedSlots"] = resolvedFlags["hasUnattendedSlots"] ?? false;

    const result: UnifiedProbeResult = {
      configured: true,
      flags: flags as UnifiedProbeResult["flags"],
      agentCapabilities: agentsAvailable ? agentCapabilities : undefined,
      agentConfidence,
      grantedScopes,
      licenseInfo,
      aiCenterSkills,
      aiCenterPackages,
      governancePolicies: govData?.policies,
      attendedRobotInfo: attendedData ?? undefined,
      studioProjectInfo: studioData ?? undefined,
      serverlessDetected,
      probeHttpStatuses,
      tokenFailures: Object.keys(tokenFailures).length > 0 ? tokenFailures : undefined,
      cmRequiresDedicatedToken,
      cachedAt: Date.now(),
    };

    setGovernancePolicies(result.governancePolicies ?? []);

    metadataService.updateServiceReachability("OR", "reachable");
    if (maestroAvailable) metadataService.updateServiceReachability("PIMS", "reachable");
    else metadataService.updateServiceReachability("PIMS", acAvailable ? "limited" : "unknown");
    if (tmAvailable) metadataService.updateServiceReachability("TM", "reachable");
    if (!tmAvailable) metadataService.updateServiceReachability("TM", "unreachable");
    if (agentsAvailable) metadataService.updateServiceReachability("AGENTS", agentConfidence === "inferred" ? "limited" : "reachable");
    if (autopilotAvailable) metadataService.updateServiceReachability("AUTOPILOT", "reachable");
    if (pmAvailable) metadataService.updateServiceReachability("IDENTITY", "reachable");

    const flagToServiceType = metadataService.getFlagToServiceType();

    const serviceStatusSummary = Object.entries(result.flags)
      .map(([k, v]) => {
        const svcType: ServiceResourceType = flagToServiceType[k] || "OR";
        const confidence = metadataService.getServiceConfidence(svcType);
        const reachability = metadataService.getServiceReachability(svcType);
        return `${k}=${v ? "available" : "unavailable"}(${confidence}/${reachability})`;
      })
      .join(", ");
    console.log(`[UiPath Probe] Probe summary: ${serviceStatusSummary}`);

    const deprecatedServices = Object.keys(result.flags).filter(k => {
      const svcType: ServiceResourceType = flagToServiceType[k] || "OR";
      const conf = metadataService.getServiceConfidence(svcType);
      return conf === "deprecated" || conf === "unknown";
    });
    if (deprecatedServices.length > 0) {
      console.warn(`[UiPath Probe] Services with deprecated/unknown confidence: ${deprecatedServices.join(", ")}`);
    }

    const endpointDeprecations: string[] = [];
    for (const [flagKey, svcType] of Object.entries(flagToServiceType)) {
      if (result.flags[flagKey as keyof typeof result.flags]) {
        const dep = metadataService.checkEndpointDeprecation(svcType);
        if (dep.deprecated) {
          endpointDeprecations.push(`${svcType}: ${dep.notes}`);
        }
      }
    }
    if (endpointDeprecations.length > 0) {
      console.warn(`[UiPath Probe] Deprecated endpoints in use: ${endpointDeprecations.join("; ")}`);
    }

    _probeCache = result;
    _probeCacheConfigAt = currentConfigAt;
    console.log(`[UiPath Probe] Unified probe complete — ${Object.entries(result.flags).filter(([, v]) => v).map(([k]) => k).join(", ")}`);
    return result;
  } catch (err: any) {
    const isInternalError = err instanceof ReferenceError || err instanceof TypeError;
    if (isInternalError) {
      console.error(`[UiPath Probe] Internal error during probe: ${err.stack || err.message}`);
    } else {
      console.warn(`[UiPath Probe] Unified probe failed: ${err.message}`);
    }
    const result: UnifiedProbeResult = {
      ...empty,
      configured: true,
      flags: { ...empty.flags, environments: false, triggers: false, apps: false },
      aiCenterSkills: [],
      aiCenterPackages: [],
      governancePolicies: [],
      cachedAt: Date.now(),
      probeFailed: true,
      probeError: err.message,
      internalError: isInternalError,
    };
    _probeCache = result;
    _probeCacheConfigAt = currentConfigAt;
    return result;
  }
}

export async function getPlatformCapabilities(): Promise<PlatformCapabilityProfile> {
  const { metadataService: capMds } = await import("./catalog/metadata-service");
  const taxonomy = capMds.getCapabilityTaxonomy();

  const emptyAvail: PlatformCapabilityProfile["available"] = {
    orchestrator: false, actionCenter: false, documentUnderstanding: false,
    generativeExtraction: false, communicationsMining: false,
    testManager: false, storageBuckets: false, aiCenter: false,
    maestro: false, integrationService: false, ixp: false,
    automationHub: false, automationOps: false, automationStore: false,
    apps: false, assistant: false,
  };
  for (const entry of taxonomy) {
    if (entry.uiSection === "primary" || entry.uiSection === "secondary") {
      (emptyAvail as Record<string, boolean>)[entry.flagKey] = false;
    }
  }

  const empty: PlatformCapabilityProfile = {
    configured: false,
    available: emptyAvail,
    grantedScopes: [],
    summary: "UiPath is not configured. The SDD will be generated with general best practices.",
    availableDescription: "",
    unavailableRecommendations: "",
  };

  const probe = await probeAllServices();
  if (!probe.configured) return empty;
  if (probe.probeFailed) {
    return { ...empty, configured: true, summary: `Could not probe UiPath platform: ${probe.probeError || "unknown error"}. SDD will use general best practices.` };
  }

  const avail: Record<string, boolean> = {};
  for (const entry of taxonomy) {
    if (entry.uiSection === "primary" || entry.uiSection === "secondary") {
      avail[entry.flagKey] = (probe.flags as Record<string, boolean>)[entry.flagKey] ?? false;
    }
  }

  const availNames: string[] = [];
  const unavailRecs: string[] = [];

  const specialHandled = new Set<string>();

  for (const entry of taxonomy) {
    const flagKey = entry.flagKey;
    if (!(flagKey in avail)) continue;

    const isAvail = avail[flagKey];
    const name = entry.displayName;
    const desc = entry.description;

    if (flagKey === "documentUnderstanding") {
      specialHandled.add(flagKey);
      if (isAvail) {
        const duDesc = avail.generativeExtraction
          ? `${name} (${desc}) + Generative Extraction (LLM-powered extraction for unstructured documents)`
          : `${name} (${desc})`;
        availNames.push(duDesc);
      } else {
        unavailRecs.push(`- **${name}**: ${entry.defaultRemediationTemplate?.reason || "Not available."} ${entry.defaultRemediationTemplate?.recommendedStep || ""}`);
      }
      continue;
    }

    if (flagKey === "generativeExtraction") {
      specialHandled.add(flagKey);
      if (isAvail && !avail.documentUnderstanding) {
        availNames.push(`${name} (${desc})`);
      } else if (!isAvail && !avail.documentUnderstanding) {
        unavailRecs.push(`- **${name}**: ${entry.defaultRemediationTemplate?.reason || "Not available."} ${entry.defaultRemediationTemplate?.recommendedStep || ""}`);
      }
      continue;
    }

    if (flagKey === "aiCenter") {
      specialHandled.add(flagKey);
      if (isAvail) {
        const deployedSkills = probe.aiCenterSkills.filter(s => s.status.toLowerCase() === "deployed" || s.status.toLowerCase() === "available");
        if (deployedSkills.length > 0) {
          const skillsList = deployedSkills.map(s => `${s.name} (package: ${s.mlPackageName || "N/A"}, input: ${s.inputType || "N/A"}, output: ${s.outputType || "N/A"})`).join("; ");
          availNames.push(`${name} (${deployedSkills.length} deployed ML skill(s): ${skillsList})`);
        } else if (probe.aiCenterSkills.length > 0) {
          const allSkills = probe.aiCenterSkills.map(s => `${s.name} [${s.status}]`).join("; ");
          availNames.push(`${name} (${probe.aiCenterSkills.length} ML skill(s) found but none deployed: ${allSkills}). ${probe.aiCenterPackages.length} ML package(s) available.`);
        } else {
          availNames.push(`${name} (available, ${probe.aiCenterPackages.length} ML package(s) found, no ML skills deployed yet)`);
        }
      } else {
        unavailRecs.push(`- **${name}**: ${entry.defaultRemediationTemplate?.reason || "Not available."} ${entry.defaultRemediationTemplate?.recommendedStep || ""}`);
      }
      continue;
    }

    specialHandled.add(flagKey);
    if (isAvail) {
      availNames.push(`${name} (${desc})`);
    } else {
      unavailRecs.push(`- **${name}**: ${entry.defaultRemediationTemplate?.reason || "Not available."} ${entry.defaultRemediationTemplate?.recommendedStep || ""}`);
    }
  }

  if (probe.flags.agents) {
    const caps = probe.agentCapabilities;
    const agentTypes: string[] = [];
    if (caps?.autonomous) agentTypes.push("autonomous");
    if (caps?.conversational) agentTypes.push("conversational");
    if (caps?.coded) agentTypes.push("coded");
    const agentEntry = taxonomy.find(e => e.flagKey === "agents");
    const agentName = agentEntry?.displayName || "UiPath Agents";
    const agentDesc = agentEntry?.description || "AI agent definitions, tool bindings to Orchestrator processes";
    const typesStr = agentTypes.length > 0 ? ` — supported types: ${agentTypes.join(", ")}` : "";
    const confidenceNote = probe.agentConfidence === "inferred" ? " [detected via asset naming convention — confirm Agent capability in Orchestrator]" : "";
    availNames.push(`${agentName} (${agentDesc}${typesStr})${confidenceNote}`);
  } else {
    const agentEntry = taxonomy.find(e => e.flagKey === "agents");
    if (agentEntry) {
      unavailRecs.push(`- **${agentEntry.displayName}**: ${agentEntry.defaultRemediationTemplate?.reason || "Not available."} ${agentEntry.defaultRemediationTemplate?.recommendedStep || ""}`);
    }
  }

  const opsEntry = taxonomy.find(e => e.flagKey === "automationOps");
  const opsDisplayName = opsEntry?.displayName || "Automation Ops";
  if (probe.flags.automationOps && probe.governancePolicies && probe.governancePolicies.length > 0) {
    const policyNames = probe.governancePolicies.map(p => p.name).slice(0, 10).join(", ");
    const opsIdx = availNames.findIndex(n => n.startsWith(opsDisplayName));
    if (opsIdx !== -1) availNames[opsIdx] = `${opsDisplayName} (governance policies: ${policyNames}, deployment rules, environment management)`;
    else availNames.push(`${opsDisplayName} (${probe.governancePolicies.length} active governance policies: ${policyNames})`);
  }

  const attendedEntry = taxonomy.find(e => e.flagKey === "attendedRobots");
  const attendedName = attendedEntry?.displayName || "Attended Robots";
  if (probe.attendedRobotInfo) {
    if (probe.attendedRobotInfo.hasAttended) {
      availNames.push(`${attendedName} (${probe.attendedRobotInfo.attendedRobots.length} attended robots available for human-assisted desktop automation)`);
    }
    if (probe.attendedRobotInfo.hasUnattended) {
      const unattendedEntry = taxonomy.find(e => e.flagKey === "hasUnattendedSlots");
      const unattendedName = unattendedEntry?.displayName || "Unattended Slots";
      availNames.push(`${unattendedName} (${probe.attendedRobotInfo.unattendedRobots.length} unattended robots for background processing)`);
    }
  }

  const studioEntry = taxonomy.find(e => e.flagKey === "studioProjects");
  const studioName = studioEntry?.displayName || "Existing Processes";
  if (probe.studioProjectInfo && probe.studioProjectInfo.projects.length > 0) {
    const projectNames = probe.studioProjectInfo.existingNames.slice(0, 10).join(", ");
    availNames.push(`${studioName} (${probe.studioProjectInfo.projects.length} deployed: ${projectNames})`);
  }

  let governanceContext = "";
  if (probe.governancePolicies && probe.governancePolicies.length > 0) {
    governanceContext = `\n\nGOVERNANCE COMPLIANCE (Automation Ops):\nThe following governance policies are ACTIVE and all generated artifacts MUST comply:\n`;
    for (const p of probe.governancePolicies) {
      governanceContext += `- [${p.severity.toUpperCase()}] ${p.name}: ${p.description || "No description"}`;
      if (p.restrictedActivities?.length) governanceContext += ` (restricted activities: ${p.restrictedActivities.join(", ")})`;
      if (p.requiredPatterns?.length) governanceContext += ` (required patterns: ${p.requiredPatterns.join(", ")})`;
      governanceContext += `\n`;
    }
  }

  let attendedContext = "";
  if (probe.attendedRobotInfo) {
    if (probe.attendedRobotInfo.hasAttended && probe.attendedRobotInfo.hasUnattended) {
      attendedContext = `\n\nATTENDED/UNATTENDED ROBOT LANDSCAPE:\nBoth attended (${probe.attendedRobotInfo.attendedRobots.length}) and unattended (${probe.attendedRobotInfo.unattendedRobots.length}) robots are available.\n- Use ATTENDED execution for: human-assisted tasks, desktop interaction, real-time user decisions, tasks requiring user's logged-in session\n- Use UNATTENDED execution for: scheduled background processing, high-volume transactions, tasks that run without human presence\n- Consider HYBRID: unattended for the main processing loop, attended triggers or Action Center for exception handling`;
    } else if (probe.attendedRobotInfo.hasAttended) {
      attendedContext = `\n\nATTENDED ROBOT LANDSCAPE:\nOnly attended robots (${probe.attendedRobotInfo.attendedRobots.length}) are available. Design for attended execution — the robot runs alongside the user on their workstation. Include user interaction points and desktop-aware activities.`;
    } else if (probe.attendedRobotInfo.hasUnattended) {
      attendedContext = `\n\nUNATTENDED ROBOT LANDSCAPE:\nOnly unattended robots (${probe.attendedRobotInfo.unattendedRobots.length}) are available. Design for fully autonomous background execution with no user interaction.`;
    }
  }

  let existingProcessContext = "";
  if (probe.studioProjectInfo && probe.studioProjectInfo.existingNames.length > 0) {
    existingProcessContext = `\n\nEXISTING DEPLOYED PROCESSES (avoid naming conflicts, consider reuse):\n${probe.studioProjectInfo.existingNames.map(n => `- ${n}`).join("\n")}\nWhen naming new processes, ensure unique names that don't conflict with the above. Where applicable, reference existing processes for orchestration or sub-process reuse.`;
  }

  const config = await getUiPathConfig();
  const orgTenant = config ? `${config.orgName}/${config.tenantName}` : "unknown";

  const isEntry = taxonomy.find(e => e.flagKey === "integrationService");
  const isDisplayName = isEntry?.displayName || "Integration Service";
  const isReason = isEntry?.defaultRemediationTemplate?.reason || "Not available.";
  const isStep = isEntry?.defaultRemediationTemplate?.recommendedStep || "";
  let isDiscovery: IntegrationServiceDiscovery | undefined;
  try {
    isDiscovery = await discoverIntegrationService();
    if (isDiscovery.available) {
      const activeConns = isDiscovery.connections.filter(c => c.status === "connected" || c.status === "active");
      if (activeConns.length > 0) {
        const connectorNames = [...new Set(activeConns.map(c => c.connectorName).filter(Boolean))];
        const capConnectors = isDiscovery.connectors.filter(c => c.hasCRUDs || c.hasEvents || c.hasMethods);
        let isDesc = `${isDisplayName} (${activeConns.length} active connection(s): ${connectorNames.join(", ")}`;
        if (capConnectors.length > 0) {
          isDesc += ` — ${capConnectors.length} connector(s) with capabilities`;
        }
        isDesc += `)`;
        availNames.push(isDesc);
      } else if (isDiscovery.connectors.length > 0) {
        availNames.push(`${isDisplayName} (${isDiscovery.connectors.length} connector(s) available, no active connections)`);
      }
    } else {
      unavailRecs.push(`- **${isDisplayName}**: ${isReason} ${isStep}`);
    }
  } catch (err: any) {
    console.warn(`[${isDisplayName}] Discovery failed during capabilities check: ${err.message}`);
  }

  const confidenceNotes: string[] = [];
  const svcConfidenceMap = capMds.getFlagToServiceType();
  for (const [svcName, svcType] of Object.entries(svcConfidenceMap)) {
    if (avail[svcName]) {
      const conf = capMds.getServiceConfidence(svcType);
      const reach = capMds.getServiceReachability(svcType);
      if (conf === "inferred" || reach === "limited") {
        const displayName = capMds.getDisplayName(svcName);
        confidenceNotes.push(`- **${displayName}**: detected with ${conf} confidence / ${reach} reachability — verify availability before relying on this service in critical solution paths`);
      }
    }
  }

  const oidcInfo = capMds.getOidcStatus();
  const oidcContext = oidcInfo.familyCount > 0
    ? `\n\nSCOPE SOURCE: OIDC discovery (${oidcInfo.familyCount} scope families${oidcInfo.isStale ? ", stale" : ""}).`
    : "";

  const confidenceContext = confidenceNotes.length > 0
    ? `\n\nSERVICE CONFIDENCE NOTES (some services detected with limited certainty):\n${confidenceNotes.join("\n")}${oidcContext}`
    : oidcContext;

  return {
    configured: true,
    available: { ...emptyAvail, ...avail } as PlatformCapabilityProfile["available"],
    grantedScopes: probe.grantedScopes,
    summary: `Connected to ${orgTenant}. ${availNames.length} services available.`,
    availableDescription: (availNames.length > 0
      ? `The following UiPath platform services are AVAILABLE and should be used in the solution design:\n${availNames.map(n => `- ${n}`).join("\n")}`
      : "No UiPath services detected.") + governanceContext + attendedContext + existingProcessContext + confidenceContext,
    unavailableRecommendations: unavailRecs.length > 0
      ? `The following services are NOT currently available on this tenant. Include a "Platform Recommendations" section explaining how each would enhance the solution if enabled:\n${unavailRecs.join("\n")}`
      : "All major UiPath platform services are available.",
    licenseInfo: probe.licenseInfo,
    integrationService: isDiscovery,
    aiCenterSkills: probe.aiCenterSkills,
    aiCenterPackages: probe.aiCenterPackages,
  };
}

export async function probeUiPathScopes(): Promise<{
  status: "ok" | "mismatch" | "auth_failed" | "not_configured";
  requestedScopes: string[];
  grantedScopes: string[];
  missingInApp: string[];
  extraInApp: string[];
  message: string;
  oidcValidation?: { validScopes: string[]; invalidRequested: string[]; familyCount: number };
}> {
  const config = await getUiPathConfig();
  if (!config) {
    return { status: "not_configured", requestedScopes: [], grantedScopes: [], missingInApp: [], extraInApp: [], message: "UiPath is not configured." };
  }

  const requestedScopes = config.scopes.split(/\s+/).filter(Boolean);

  const { metadataService: mdsSvc } = await import("./catalog/metadata-service");
  const oidcValid = mdsSvc.getOidcValidScopes();
  const oidcStatus = mdsSvc.getOidcStatus();
  let oidcValidation: { validScopes: string[]; invalidRequested: string[]; familyCount: number } | undefined;
  if (oidcValid.length > 0) {
    const oidcSet = new Set(oidcValid);
    const invalidRequested = requestedScopes.filter(s => !oidcSet.has(s));
    oidcValidation = { validScopes: oidcValid, invalidRequested, familyCount: oidcStatus.familyCount };
  }

  try {
    const token = await getAccessToken(config);
    const comparison = decodeAndCompareScopes(token, requestedScopes);

    if (!comparison.decodedOk) {
      return { status: "ok", requestedScopes, grantedScopes: requestedScopes, missingInApp: [], extraInApp: [], message: "Token obtained. Could not decode granted scopes from JWT — assuming scopes are correct.", oidcValidation };
    }

    const { grantedScopes, missingInApp, extraInApp } = comparison;

    if (missingInApp.length === 0 && extraInApp.length === 0) {
      return { status: "ok", requestedScopes, grantedScopes, missingInApp: [], extraInApp: [], message: "Scopes are in sync.", oidcValidation };
    }

    const parts: string[] = [];
    if (missingInApp.length > 0) parts.push(`${missingInApp.length} scope(s) granted in UiPath but not selected in the app: ${missingInApp.join(", ")}`);
    if (extraInApp.length > 0) parts.push(`${extraInApp.length} scope(s) selected in the app but not granted in UiPath: ${extraInApp.join(", ")}`);
    if (oidcValidation && oidcValidation.invalidRequested.length > 0) {
      parts.push(`${oidcValidation.invalidRequested.length} requested scope(s) not recognized by OIDC: ${oidcValidation.invalidRequested.join(", ")}`);
    }
    return { status: "mismatch", requestedScopes, grantedScopes, missingInApp, extraInApp, message: parts.join(". "), oidcValidation };
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes("invalid_scope")) {
      return { status: "auth_failed", requestedScopes, grantedScopes: [], missingInApp: [], extraInApp: requestedScopes, message: "Authentication failed due to invalid scopes. Update your selected scopes to match what's granted in UiPath Cloud.", oidcValidation };
    }
    return { status: "auth_failed", requestedScopes, grantedScopes: [], missingInApp: [], extraInApp: [], message: `Authentication failed: ${msg}`, oidcValidation };
  }
}

function decodeJwtScopes(token: string): string[] {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return [];
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
    const scopeVal = payload.scope || payload.scp;
    if (!scopeVal) return [];
    return Array.isArray(scopeVal) ? scopeVal : scopeVal.split(/\s+/).filter(Boolean);
  } catch (e: any) {
    return [];
  }
}

function decodeAndCompareScopes(token: string, requestedScopes: string[]): {
  grantedScopes: string[];
  missingInApp: string[];
  extraInApp: string[];
  decodedOk: boolean;
} {
  const grantedScopes = decodeJwtScopes(token);
  if (grantedScopes.length === 0) {
    return { grantedScopes: [], missingInApp: [], extraInApp: [], decodedOk: false };
  }
  const grantedSet = new Set(grantedScopes);
  const requestedSet = new Set(requestedScopes);
  const missingInApp = grantedScopes.filter(s => !requestedSet.has(s));
  const extraInApp = requestedScopes.filter(s => !grantedSet.has(s));
  return { grantedScopes, missingInApp, extraInApp, decodedOk: true };
}

export async function autoDetectUiPathScopes(): Promise<{
  status: "synced" | "auth_failed" | "not_configured" | "no_scopes_found";
  detectedScopes: string[];
  previousScopes: string[];
  message: string;
  oidcStatus?: { hasLiveScopes: boolean; familyCount: number; isStale: boolean };
}> {
  const config = await getUiPathConfig();
  if (!config) {
    return { status: "not_configured", detectedScopes: [], previousScopes: [], message: "UiPath is not configured." };
  }

  const previousScopes = config.scopes.split(/\s+/).filter(Boolean);
  const { metadataService: mdsSvc } = await import("./catalog/metadata-service");

  await mdsSvc.refreshFromOIDC();
  const oidcStatus = mdsSvc.getOidcStatus();

  const allServiceTypes: ServiceResourceType[] = ["OR", "TM", "DU", "DF", "PIMS", "IXP", "AI", "HUB", "IDENTITY", "INTEGRATIONSERVICE", "AUTOMATIONOPS", "AUTOMATIONSTORE", "APPS", "ASSISTANT", "AGENTS", "AUTOPILOT", "REINFER"];
  const allRequestedScopes: string[] = [];
  for (const svc of allServiceTypes) {
    const fullScopes = mdsSvc.getFullOidcScopesForService(svc);
    allRequestedScopes.push(...fullScopes);
  }

  const orScopes = mdsSvc.getFullOidcScopesForService("OR");
  if (orScopes.length === 0 && allRequestedScopes.length === 0) {
    return {
      status: "no_scopes_found",
      detectedScopes: [],
      previousScopes,
      message: "OIDC discovery did not find OR scope family. Using baseline scopes.",
      oidcStatus: { hasLiveScopes: oidcStatus.hasLiveScopes, familyCount: oidcStatus.familyCount, isStale: oidcStatus.isStale },
    };
  }

  const dedupedRequestScopes = [...new Set(allRequestedScopes)];
  const scopeString = dedupedRequestScopes.length > 0 ? dedupedRequestScopes.join(" ") : orScopes.join(" ");

  let token: string | null = null;
  let usedBroadRequest = false;
  try {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: scopeString,
    });
    const tokenUrl = mdsSvc.getTokenEndpoint();
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (res.ok) {
      const data = await res.json();
      token = data.access_token;
      usedBroadRequest = true;
    }
  } catch (e: any) { console.warn(`[UiPath] Auto-detect scopes token request failed: ${e.message}`); }

  if (!token) {
    const fallbackScopes = mdsSvc.getMinimalScopesForService("OR");
    for (const tryScope of fallbackScopes) {
      try {
        const params = new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: tryScope,
        });
        const tokenUrl = mdsSvc.getTokenEndpoint();
        const res = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        });
        if (res.ok) {
          const data = await res.json();
          token = data.access_token;
          break;
        }
      } catch (e: any) { console.warn(`[UiPath] Auto-detect scopes fallback (${tryScope}) failed: ${e.message}`); }
    }
  }

  if (!token) {
    return {
      status: "auth_failed",
      detectedScopes: [],
      previousScopes,
      message: "Could not authenticate with UiPath. Verify your App ID and Secret are correct.",
      oidcStatus: { hasLiveScopes: oidcStatus.hasLiveScopes, familyCount: oidcStatus.familyCount, isStale: oidcStatus.isStale },
    };
  }

  const detectedScopes = decodeJwtScopes(token);
  if (detectedScopes.length === 0) {
    return {
      status: "no_scopes_found",
      detectedScopes: [],
      previousScopes,
      message: "Authenticated successfully but could not extract scopes from the JWT token.",
      oidcStatus: { hasLiveScopes: oidcStatus.hasLiveScopes, familyCount: oidcStatus.familyCount, isStale: oidcStatus.isStale },
    };
  }

  const grantedOrScopes = detectedScopes.filter(s => s.startsWith("OR."));
  const dedupedScopes = [...new Set(detectedScopes)].sort();
  const allScopesString = dedupedScopes.join(" ");

  if (usedBroadRequest) {
    await upsertSetting("uipath_scopes", allScopesString);

    const { uipathConnections } = await import("@shared/schema");
    const activeRows = await db.select().from(uipathConnections).where(eq(uipathConnections.isActive, true));
    if (activeRows.length > 0) {
      await db.update(uipathConnections).set({ scopes: allScopesString }).where(eq(uipathConnections.id, activeRows[0].id));
    }
    const { invalidateConfig } = await import("./uipath-auth");
    invalidateConfig();
  }

  const oidcValidScopes = mdsSvc.getOidcValidScopes();
  const nonOrFamilies = Object.entries(mdsSvc.getOidcStatus().scopeFamilies || {})
    .filter(([, f]) => f.mappedService && f.mappedService !== "OR")
    .map(([prefix, f]) => `${prefix}→${f.mappedService}(${f.scopeCount})`)
    .join(", ");

  const persistNote = usedBroadRequest
    ? "Scopes persisted to configuration."
    : "Scopes detected via fallback; existing saved scopes preserved unchanged.";

  return {
    status: "synced",
    detectedScopes,
    previousScopes,
    message: `Auto-detected ${grantedOrScopes.length} OR scopes from UiPath (OIDC-backed: ${oidcValidScopes.length} valid scopes across ${oidcStatus.familyCount} families). Non-OR families: ${nonOrFamilies || "none detected"}. ${persistNote} Each resource type uses separate tokens.`,
    oidcStatus: { hasLiveScopes: oidcStatus.hasLiveScopes, familyCount: oidcStatus.familyCount, isStale: oidcStatus.isStale },
  };
}

export async function verifyUiPathScopes(): Promise<{ success: boolean; internalError?: boolean; requestedScopes: string[]; grantedScopes: string[]; message: string; services?: Record<string, { available: boolean; message: string }>; oidcDiagnostics?: { validScopes: string[]; familyCount: number; isStale: boolean; scopeFamilies?: Record<string, { prefix: string; scopeCount: number; mappedService?: string }> } }> {
  const config = await getUiPathConfig();
  if (!config) {
    return { success: false, requestedScopes: [], grantedScopes: [], message: "UiPath is not configured." };
  }

  try {
    const { tryAcquireResourceToken } = await import("./uipath-auth");
    const { metadataService: mdsSvc } = await import("./catalog/metadata-service");

    const resourceNames: Array<"OR" | "TM" | "DU" | "PM" | "DF" | "PIMS" | "IXP" | "AI"> = ["OR", "TM", "DU", "PM", "DF", "PIMS", "IXP", "AI"];
    const rtToSvc: Record<string, import("./catalog/metadata-schemas").ServiceResourceType> = {
      OR: "OR", TM: "TM", DU: "DU", PM: "IDENTITY", DF: "DF", PIMS: "PIMS", IXP: "IXP", AI: "AI",
    };
    const resourcePromises = resourceNames.map(name => {
      const svcType = rtToSvc[name] || name as import("./catalog/metadata-schemas").ServiceResourceType;
      if (!mdsSvc.hasOidcScopeFamily(svcType) && name !== "OR") {
        return Promise.resolve({ ok: false, scopes: [] as string[], error: `No OIDC scope family for ${name}` });
      }
      return tryAcquireResourceToken(name).catch(() => ({ ok: false, scopes: [] as string[], error: "Token request failed" }));
    });
    const resourceResults = await Promise.allSettled(resourcePromises);

    const resources: Record<string, { ok: boolean; scopes: string[]; error?: string }> = {};
    for (let i = 0; i < resourceNames.length; i++) {
      const r = resourceResults[i];
      resources[resourceNames[i]] = r.status === "fulfilled" ? r.value : { ok: false, scopes: [], error: "Token request failed" };
    }

    const allGrantedScopes: string[] = [];
    const scopeSummary: string[] = [];
    for (const [name, res] of Object.entries(resources)) {
      if (res.ok && res.scopes.length > 0) {
        allGrantedScopes.push(...res.scopes);
        scopeSummary.push(`${name}=${res.scopes.length}`);
      } else if (!res.ok) {
        scopeSummary.push(`${name}=unavailable`);
      } else {
        scopeSummary.push(`${name}=0`);
      }
    }

    const requestedScopes = config.scopes.split(/\s+/).filter(Boolean);

    const probe = await probeAllServices();

    if (probe.probeFailed) {
      const failureMessage = probe.internalError
        ? `Internal probe error: ${probe.probeError || "unknown error"}`
        : `Authentication failed: ${probe.probeError || "probe pipeline failed"}`;
      return {
        success: false,
        internalError: probe.internalError || false,
        requestedScopes,
        grantedScopes: allGrantedScopes,
        message: failureMessage,
      };
    }

    const serviceChecks: Record<string, { available: boolean; message: string }> = {};
    const taxonomy = mdsSvc.getCapabilityTaxonomy();
    for (const entry of taxonomy) {
      const flagVal = (probe.flags as Record<string, boolean>)[entry.flagKey];
      const isAvailable = !!flagVal;
      const remediation = entry.defaultRemediationTemplate;
      if (isAvailable) {
        serviceChecks[entry.displayName] = { available: true, message: "Accessible" };
      } else {
        const msg = remediation?.reason || "Not accessible or not provisioned";
        serviceChecks[entry.displayName] = { available: false, message: msg };
      }
    }

    const aiLabel = mdsSvc.getCapabilityTaxonomyEntry("aiCenter")?.displayName || "AI Center";
    if (probe.flags.aiCenter && probe.aiCenterSkills.length > 0) {
      const deployed = probe.aiCenterSkills.filter(s => s.status.toLowerCase() === "deployed" || s.status.toLowerCase() === "available");
      if (deployed.length > 0) {
        serviceChecks[aiLabel] = { available: true, message: `${deployed.length} ML skill(s) deployed` };
      }
    }

    const arLabel = mdsSvc.getCapabilityTaxonomyEntry("attendedRobots")?.displayName || "Attended Robots";
    if (probe.flags.attendedRobots) {
      serviceChecks[arLabel] = { available: true, message: `${probe.attendedRobotInfo?.attendedRobots.length ?? 0} attended robots discovered` };
    }
    const spLabel = mdsSvc.getCapabilityTaxonomyEntry("studioProjects")?.displayName || "Studio Projects";
    if (probe.flags.studioProjects) {
      serviceChecks[spLabel] = { available: true, message: `${probe.studioProjectInfo?.projects.length ?? 0} existing processes` };
    }

    const availableCount = Object.values(serviceChecks).filter(s => s.available).length;
    const totalCount = Object.keys(serviceChecks).length;

    const oidcInfo = mdsSvc.getOidcStatus();
    const oidcDiagnostics = {
      validScopes: mdsSvc.getOidcValidScopes(),
      familyCount: oidcInfo.familyCount,
      isStale: oidcInfo.isStale,
      scopeFamilies: oidcInfo.scopeFamilies as Record<string, { prefix: string; scopeCount: number; mappedService?: string }> | undefined,
    };

    for (const [name, res] of Object.entries(resources)) {
      if (!res.ok && res.error) {
        const hasScopeFamily = mdsSvc.hasOidcScopeFamily(name as ServiceResourceType);
        if (!hasScopeFamily) {
          const checkName = Object.keys(serviceChecks).find(k => k.includes(name));
          if (checkName && serviceChecks[checkName]) {
            serviceChecks[checkName].message += " (no dedicated scope family in OIDC)";
          }
        }
      }
    }

    return {
      success: true,
      requestedScopes,
      grantedScopes: allGrantedScopes,
      message: `${availableCount}/${totalCount} services accessible. Scopes: ${scopeSummary.join(", ")} (separate tokens per UiPath resource). OIDC: ${oidcInfo.familyCount} scope families${oidcInfo.isStale ? " (stale)" : ""}.`,
      services: serviceChecks,
      oidcDiagnostics,
    };
  } catch (err: any) {
    const msg = err.message || String(err);
    const isInternalError = err instanceof ReferenceError || err instanceof TypeError;
    if (isInternalError) {
      console.error(`[UiPath Verify] Internal error during scope verification: ${err.stack || msg}`);
      return { success: false, internalError: true, requestedScopes: config.scopes.split(/\s+/), grantedScopes: [], message: `Internal probe error: ${msg}` };
    }
    return { success: false, requestedScopes: config.scopes.split(/\s+/), grantedScopes: [], message: `Authentication failed: ${msg}` };
  }
}

export type ServiceStatusDetail = {
  status: "available" | "limited" | "unavailable" | "unknown";
  confidence: "official" | "inferred" | "deprecated" | "unknown";
  evidence: string;
  reachable: "reachable" | "limited" | "unreachable" | "unknown";
  truthfulStatus?: import("./catalog/metadata-schemas").TruthfulStatus;
  displayLabel?: string;
  category?: import("./catalog/metadata-schemas").TaxonomyCategory;
  parentService?: string;
  displayName?: string;
  remediation?: import("./catalog/metadata-schemas").RemediationGuidance;
  discoverySummary?: {
    connectorCount: number;
    activeConnectionCount: number;
    summary: string;
  };
};

export type ServiceAvailabilityMap = {
  configured: boolean;
  orchestrator: boolean;
  actionCenter: boolean;
  testManager: boolean;
  documentUnderstanding: boolean;
  generativeExtraction: boolean;
  communicationsMining: boolean;
  dataService: boolean;
  platformManagement: boolean;
  environments: boolean;
  triggers: boolean;
  agents: boolean;
  agentCapabilities?: { autonomous: boolean; conversational: boolean; coded: boolean };
  maestro: boolean;
  integrationService: boolean;
  integrationServiceDiscovery?: IntegrationServiceDiscovery;
  ixp: boolean;
  automationHub: boolean;
  automationOps: boolean;
  automationStore: boolean;
  apps: boolean;
  assistant: boolean;
  aiCenter?: boolean;
  aiCenterSkills?: AICenterSkill[];
  aiCenterPackages?: AICenterPackage[];
  attendedRobots: boolean;
  studioProjects: boolean;
  governancePolicies?: GovernancePolicy[];
  attendedRobotInfo?: AttendedRobotInfo;
  studioProjectInfo?: StudioProcessesResult;
  serviceDetails?: Record<string, ServiceStatusDetail>;
};

export async function probeServiceAvailability(): Promise<ServiceAvailabilityMap> {
  const probe = await probeAllServices();
  const { metadataService: mds } = await import("./catalog/metadata-service");
  let isDiscovery: IntegrationServiceDiscovery | undefined;
  try {
    isDiscovery = await discoverIntegrationService();
  } catch (err: any) {
    console.warn(`[Integration Service] Discovery failed during service probe: ${err.message}`);
  }

  const httpStatuses = probe.probeHttpStatuses || {};
  const tokenFailureMap = probe.tokenFailures || {};

  const UNSUPPORTED_API_SERVICES = new Set(["automationStore", "apps", "assistant"]);

  const buildDetail = (flagKey: string, flag: boolean, evidence: string, probeError?: string): ServiceStatusDetail => {
    const entry = mds.getTaxonomyEntry(flagKey);
    const svcType: ServiceResourceType = entry?.serviceResourceType || "OR";
    const confidence = mds.getServiceConfidence(svcType);
    const reachable = mds.getServiceReachability(svcType);
    const rawHttpStatus: number | null = httpStatuses[flagKey] ?? null;
    const tokenFailure = tokenFailureMap[flagKey];

    const isUnsupportedService = UNSUPPORTED_API_SERVICES.has(flagKey);
    const isAuthResponse = rawHttpStatus === 401 || rawHttpStatus === 403;

    let status: ServiceStatusDetail["status"];
    let effectiveAvailable: boolean;

    if (isUnsupportedService) {
      status = "unavailable";
      effectiveAvailable = false;
    } else if (flag) {
      if (reachable === "limited") status = "limited";
      else status = "available";
      effectiveAvailable = true;
    } else if (isAuthResponse) {
      status = "limited";
      effectiveAvailable = false;
    } else {
      if (reachable === "unreachable") status = "unavailable";
      else if (reachable === "limited") status = "limited";
      else if (reachable === "unknown") status = "unknown";
      else status = "unavailable";
      effectiveAvailable = false;
    }

    const effectiveHttpStatus = rawHttpStatus ?? (
      !flag && reachable === "limited" ? 403 :
      !flag && reachable === "unreachable" ? 500 :
      null
    );

    const effectiveProbeError = probeError || tokenFailure || undefined;

    const isCmRequiringToken = flagKey === "communicationsMining" && probe.cmRequiresDedicatedToken;

    let truthfulStatus: import("./catalog/metadata-schemas").TruthfulStatus;
    if (isUnsupportedService) {
      truthfulStatus = "unsupported_external_api";
    } else if (effectiveAvailable) {
      truthfulStatus = "available";
    } else if (isCmRequiringToken) {
      truthfulStatus = "requires_dedicated_token";
    } else if (isAuthResponse) {
      truthfulStatus = "auth_scope";
    } else if (tokenFailure && !effectiveHttpStatus) {
      truthfulStatus = "not_provisioned";
    } else {
      truthfulStatus = mds.deriveTruthfulStatus(flagKey, effectiveAvailable, effectiveHttpStatus, effectiveProbeError);
    }

    const displayLabel = mds.getTruthfulStatusLabel(truthfulStatus);
    const remediation = mds.buildRemediationGuidance(flagKey, truthfulStatus, effectiveHttpStatus, undefined, effectiveProbeError);

    return {
      status, confidence, evidence, reachable,
      truthfulStatus,
      displayLabel,
      category: entry?.category,
      parentService: entry?.parentService,
      displayName: entry?.displayName || flagKey,
      remediation,
    };
  };

  const serviceDetails: Record<string, ServiceStatusDetail> = {
    orchestrator: buildDetail("orchestrator", probe.flags.orchestrator, "Folders API probe"),
    actionCenter: buildDetail("actionCenter", probe.flags.actionCenter, "TaskCatalogs API probe"),
    testManager: buildDetail("testManager", probe.flags.testManager, "TM token acquisition"),
    documentUnderstanding: buildDetail("documentUnderstanding", probe.flags.documentUnderstanding, "DU Discovery API probe"),
    generativeExtraction: buildDetail("generativeExtraction", probe.flags.generativeExtraction, "IXP projects API probe"),
    communicationsMining: buildDetail("communicationsMining", probe.flags.communicationsMining, "reinfer datasets API probe"),
    dataService: buildDetail("dataService", probe.flags.dataService, "Entity API probe"),
    platformManagement: buildDetail("platformManagement", probe.flags.platformManagement, "PM token acquisition"),
    agents: buildDetail("agents", probe.flags.agents, probe.agentConfidence === "inferred" ? "Asset name prefix match" : "Agent Studio/Autopilot API probe"),
    maestro: buildDetail("maestro", probe.flags.maestro, "Maestro API probe or PIMS token"),
    integrationService: buildDetail("integrationService", probe.flags.integrationService, "Connections API probe"),
    ixp: buildDetail("ixp", probe.flags.ixp, "IXP datasets API probe"),
    automationHub: buildDetail("automationHub", probe.flags.automationHub, "Ideas API probe"),
    automationOps: buildDetail("automationOps", probe.flags.automationOps, "Policies API probe"),
    automationStore: buildDetail("automationStore", probe.flags.automationStore, "API probe"),
    apps: buildDetail("apps", probe.flags.apps, "Apps API probe"),
    assistant: buildDetail("assistant", probe.flags.assistant, "Assistant API probe"),
    aiCenter: buildDetail("aiCenter", probe.flags.aiCenter ?? false, "AI Deployer projects probe"),
    autopilot: buildDetail("autopilot", probe.flags.autopilot ?? false, "Autopilot API probe"),
    storageBuckets: buildDetail("storageBuckets", probe.flags.storageBuckets, "Buckets API probe"),
    environments: buildDetail("environments", probe.flags.environments, "Environments API probe"),
    triggers: buildDetail("triggers", probe.flags.triggers, "Queue triggers/schedules API probe"),
    attendedRobots: buildDetail("attendedRobots", probe.flags.attendedRobots, "Sessions/robots API probe"),
    studioProjects: buildDetail("studioProjects", probe.flags.studioProjects, "Releases API probe"),
    hasUnattendedSlots: buildDetail("hasUnattendedSlots", probe.flags.hasUnattendedSlots, "Machines API probe"),
  };

  if (probe.agentConfidence === "inferred" && serviceDetails.agents) {
    serviceDetails.agents.confidence = "inferred";
    serviceDetails.agents.evidence = "Asset name prefix match";
  }

  if (isDiscovery && serviceDetails.integrationService) {
    const activeConns = isDiscovery.connections.filter(
      (c: { status: string }) => c.status === "connected" || c.status === "active"
    );
    serviceDetails.integrationService.discoverySummary = {
      connectorCount: isDiscovery.connectors.length,
      activeConnectionCount: activeConns.length,
      summary: isDiscovery.summary || `${isDiscovery.connectors.length} connector(s), ${activeConns.length} active connection(s)`,
    };
  }

  return {
    configured: probe.configured,
    orchestrator: probe.flags.orchestrator,
    actionCenter: probe.flags.actionCenter,
    testManager: probe.flags.testManager,
    documentUnderstanding: probe.flags.documentUnderstanding,
    generativeExtraction: probe.flags.generativeExtraction,
    communicationsMining: probe.flags.communicationsMining,
    dataService: probe.flags.dataService,
    platformManagement: probe.flags.platformManagement,
    environments: probe.flags.environments,
    triggers: probe.flags.triggers,
    agents: probe.flags.agents,
    agentCapabilities: probe.agentCapabilities,
    maestro: probe.flags.maestro,
    integrationService: probe.flags.integrationService,
    integrationServiceDiscovery: isDiscovery,
    ixp: probe.flags.ixp,
    automationHub: probe.flags.automationHub,
    automationOps: probe.flags.automationOps,
    automationStore: probe.flags.automationStore,
    apps: probe.flags.apps,
    assistant: probe.flags.assistant,
    aiCenter: probe.flags.aiCenter,
    aiCenterSkills: probe.aiCenterSkills,
    aiCenterPackages: probe.aiCenterPackages,
    attendedRobots: probe.flags.attendedRobots,
    studioProjects: probe.flags.studioProjects,
    governancePolicies: probe.governancePolicies,
    attendedRobotInfo: probe.attendedRobotInfo,
    studioProjectInfo: probe.studioProjectInfo,
    serviceDetails,
  };
}

export async function getAICenterSkills(): Promise<{ available: boolean; skills: AICenterSkill[]; packages: AICenterPackage[] }> {
  const probe = await probeAllServices();
  return {
    available: probe.flags.aiCenter,
    skills: probe.aiCenterSkills,
    packages: probe.aiCenterPackages,
  };
}

export type ConnectorOperation = {
  id: string;
  name: string;
  description?: string;
  type: "action" | "trigger" | "unknown";
};

export type IntegrationServiceConnector = {
  id: string;
  name: string;
  description?: string;
  provider?: string;
  iconUrl?: string;
  connectionCount: number;
  operations: ConnectorOperation[];
  categories?: string[];
  hasCRUDs?: boolean;
  hasMethods?: boolean;
  hasExtensions?: boolean;
  hasHttpRequest?: boolean;
  hasEvents?: boolean;
  eventTypes?: string[];
  vendorApiType?: string;
  tier?: string;
  lifecycleStage?: string;
};

export type IntegrationServiceConnection = {
  id: string;
  connectorId: string;
  connectorName: string;
  name: string;
  status: string;
  createdAt?: string;
  provider?: string;
  accountName?: string;
  isDefault?: boolean;
  folderId?: string;
  eventCheckInterval?: number;
  connectionIdentity?: string;
  connectorKey?: string;
  connectorCategories?: string[];
  folderKey?: string;
};

export type IntegrationServiceDiscovery = {
  available: boolean;
  connectors: IntegrationServiceConnector[];
  connections: IntegrationServiceConnection[];
  summary: string;
};

let _isDiscoveryCache: IntegrationServiceDiscovery | null = null;
const IS_CACHE_TTL_MS = 120_000;
let _isCacheAt = 0;

export function clearIntegrationServiceCache(): void {
  _isDiscoveryCache = null;
  _isCacheAt = 0;
}

function sanitizeConnectorString(s: string): string {
  return s.replace(/[<>\[\]{}|\\`]/g, "").slice(0, 100).trim();
}

export async function discoverIntegrationService(): Promise<IntegrationServiceDiscovery> {
  if (_isDiscoveryCache && Date.now() - _isCacheAt < IS_CACHE_TTL_MS) {
    return _isDiscoveryCache;
  }

  const empty: IntegrationServiceDiscovery = {
    available: false,
    connectors: [],
    connections: [],
    summary: "Integration Service is not available.",
  };

  const config = await getUiPathConfig();
  if (!config) return empty;

  try {
    const token = await getAccessToken(config);
    const { metadataService: mdsSvc3 } = await import("./catalog/metadata-service");
    const hdrs: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    let connectionsBaseUrl: string;
    try {
      connectionsBaseUrl = mdsSvc3.getServiceUrl("CONNECTIONS" as import("./catalog/metadata-schemas").ServiceResourceType, config);
    } catch {
      connectionsBaseUrl = mdsSvc3.getServiceUrl("INTEGRATIONSERVICE" as import("./catalog/metadata-schemas").ServiceResourceType, config);
      console.log("[Integration Service] CONNECTIONS endpoint not found, falling back to INTEGRATIONSERVICE");
    }
    const connectionsUrl = `${connectionsBaseUrl}/api/v1/Connections?$top=200&$expand=connector,folder`;
    const connectorsUrl = `${connectionsBaseUrl}/api/v1/Connectors?$top=500`;

    let [connectionRes, connectorRes] = await Promise.allSettled([
      fetch(connectionsUrl, { headers: hdrs }),
      fetch(connectorsUrl, { headers: hdrs }),
    ]);

    const connectionsFailed = connectionRes.status !== "fulfilled" || !connectionRes.value.ok;
    const connectorsFailed = connectorRes.status !== "fulfilled" || !connectorRes.value.ok;
    if (connectionsFailed && connectorsFailed) {
      const fallbackBase = mdsSvc3.getServiceUrl("INTEGRATIONSERVICE" as import("./catalog/metadata-schemas").ServiceResourceType, config);
      if (fallbackBase !== connectionsBaseUrl) {
        console.log("[Integration Service] connections_ endpoints failed, trying integrationservice_ fallback");
        const fbConnectionsUrl = `${fallbackBase}/api/Connections?$top=200`;
        const fbConnectorsUrl = `${fallbackBase}/api/ConnectorDefinitions?$top=500`;
        [connectionRes, connectorRes] = await Promise.allSettled([
          fetch(fbConnectionsUrl, { headers: hdrs }),
          fetch(fbConnectorsUrl, { headers: hdrs }),
        ]);
      }
    }

    const connectors: IntegrationServiceConnector[] = [];
    const connections: IntegrationServiceConnection[] = [];
    const connectorMap = new Map<string, IntegrationServiceConnector>();

    if (connectorRes.status === "fulfilled" && connectorRes.value.ok) {
      try {
        const data = await connectorRes.value.json();
        const items = data.value || data.items || data || [];
        if (Array.isArray(items)) {
          for (const c of items) {
            const key = String(c.key || c.Key || c.id || c.Id || "").slice(0, 100);
            const connector: IntegrationServiceConnector = {
              id: key,
              name: sanitizeConnectorString(c.name || c.Name || c.displayName || c.DisplayName || ""),
              description: sanitizeConnectorString(c.description || c.Description || "") || undefined,
              provider: sanitizeConnectorString(c.provider || c.Provider || c.publisherName || c.PublisherName || "") || undefined,
              iconUrl: c.iconUrl || c.IconUrl || c.icon || c.Icon || undefined,
              connectionCount: c.connectionCount || c.ConnectionCount || 0,
              operations: [],
              categories: Array.isArray(c.categories || c.Categories) ? (c.categories || c.Categories).map((cat: any) => String(cat)) : undefined,
              tier: c.tier || c.Tier || undefined,
              lifecycleStage: c.lifecycleStage || c.LifecycleStage || undefined,
            };
            connectors.push(connector);
            connectorMap.set(key, connector);
          }
        }
      } catch (e) {
        console.warn("[Integration Service] Failed to parse connectors response:", e);
      }
    } else {
      const status = connectorRes.status === "fulfilled" ? connectorRes.value.status : "error";
      console.log(`[Integration Service] Connectors endpoint (connections_) returned ${status}`);
    }

    if (connectionRes.status === "fulfilled" && connectionRes.value.ok) {
      try {
        const data = await connectionRes.value.json();
        const items = data.value || data.items || data || [];
        if (Array.isArray(items)) {
          for (const c of items) {
            const connectorObj = c.connector || c.Connector || {};
            const folderObj = c.folder || c.Folder || {};
            const rawState = String(c.state || c.State || c.status || c.Status || "unknown");
            const normalizedStatus = rawState.toLowerCase() === "enabled" ? "connected"
              : rawState.toLowerCase() === "failed" ? "failed"
              : rawState.toLowerCase();
            const connKey = String(connectorObj.key || connectorObj.Key || c.connectorKey || c.ConnectorKey || "").slice(0, 100);

            connections.push({
              id: String(c.id || c.Id || "").slice(0, 100),
              connectorId: String(connectorObj.id || connectorObj.Id || c.connectorId || c.ConnectorId || "").slice(0, 100),
              connectorName: sanitizeConnectorString(connectorObj.name || connectorObj.Name || connectorObj.displayName || c.connectorName || c.ConnectorName || ""),
              name: sanitizeConnectorString(c.name || c.Name || c.displayName || c.DisplayName || ""),
              status: normalizedStatus,
              createdAt: c.createdAt || c.CreatedAt || undefined,
              provider: sanitizeConnectorString(connectorObj.publisherName || connectorObj.provider || c.provider || "") || undefined,
              accountName: sanitizeConnectorString(c.accountName || c.AccountName || c.account || c.Account || "") || undefined,
              isDefault: c.isDefault ?? c.IsDefault ?? undefined,
              folderId: folderObj.id || folderObj.Id || c.folderId || c.FolderId || undefined,
              eventCheckInterval: typeof (c.eventCheckInterval ?? c.EventCheckInterval) === "number" ? (c.eventCheckInterval ?? c.EventCheckInterval) : undefined,
              connectionIdentity: sanitizeConnectorString(c.connectionIdentity || c.ConnectionIdentity || c.identity || c.Identity || "") || undefined,
              connectorKey: connKey || undefined,
              connectorCategories: Array.isArray(connectorObj.categories || connectorObj.Categories) ? (connectorObj.categories || connectorObj.Categories).map((cat: any) => String(cat)) : undefined,
              folderKey: String(folderObj.key || folderObj.Key || c.folderKey || c.FolderKey || "") || undefined,
            });
          }
        }
      } catch (e) {
        console.warn("[Integration Service] Failed to parse connections response:", e);
      }
    } else {
      const status = connectionRes.status === "fulfilled" ? connectionRes.value.status : "error";
      console.log(`[Integration Service] Connections endpoint (connections_) returned ${status}`);
    }

    const activeConnections = connections.filter(c => c.status === "connected" || c.status === "active");
    const activeConnectorKeys = [...new Set(activeConnections.map(c => c.connectorKey).filter((key): key is string => Boolean(key)))];

    if (activeConnectorKeys.length > 0) {
      const METADATA_CONCURRENCY = 10;
      const fetchMetadata = async (connectorKey: string): Promise<void> => {
        try {
          const metaUrl = `${connectionsBaseUrl}/api/v1/Connectors/${encodeURIComponent(connectorKey)}/metadata`;
          const metaRes = await fetch(metaUrl, { headers: hdrs });
          if (!metaRes.ok) return;
          const meta = await metaRes.json();
          const connector = connectorMap.get(connectorKey);
          if (connector) {
            connector.hasCRUDs = meta.hasCRUDs ?? meta.hasCruds ?? undefined;
            connector.hasMethods = meta.hasMethods ?? undefined;
            connector.hasExtensions = meta.hasExtensions ?? undefined;
            connector.hasHttpRequest = meta.hasHttpRequest ?? undefined;
            connector.hasEvents = meta.hasEvents ?? undefined;
            connector.vendorApiType = meta.vendorApiType || meta.VendorApiType || undefined;
            if (Array.isArray(meta.eventTypes || meta.EventTypes)) {
              connector.eventTypes = (meta.eventTypes || meta.EventTypes).map((et: any) => String(et));
            }
          }
        } catch (e) {
          console.warn(`[Integration Service] Failed to fetch metadata for connector ${connectorKey}:`, e);
        }
      };

      for (let i = 0; i < activeConnectorKeys.length; i += METADATA_CONCURRENCY) {
        const batch = activeConnectorKeys.slice(i, i + METADATA_CONCURRENCY);
        await Promise.allSettled(batch.map(fetchMetadata));
      }
    }

    const isAvailable = connectors.length > 0 || connections.length > 0 ||
      (connectorRes.status === "fulfilled" && connectorRes.value.ok) ||
      (connectionRes.status === "fulfilled" && connectionRes.value.ok);

    const connectorNames = [...new Set(activeConnections.map(c => c.connectorName).filter((name): name is string => Boolean(name)))];

    let summary = "";
    if (isAvailable) {
      const capCount = connectors.filter(c => c.hasCRUDs || c.hasEvents || c.hasMethods).length;
      summary = `Integration Service: ${connectors.length} connector(s) available, ${activeConnections.length} active connection(s)`;
      if (connectorNames.length > 0) {
        summary += ` (${connectorNames.join(", ")})`;
      }
      if (capCount > 0) {
        summary += ` — ${capCount} connector(s) with capability metadata`;
      }
    } else {
      summary = "Integration Service is not available or has no connectors configured.";
    }

    const result: IntegrationServiceDiscovery = {
      available: isAvailable,
      connectors,
      connections,
      summary,
    };

    _isDiscoveryCache = result;
    _isCacheAt = Date.now();
    console.log(`[Integration Service] Discovery complete — ${summary}`);
    return result;
  } catch (err: any) {
    console.warn(`[Integration Service] Discovery failed: ${err.message}`);
    return empty;
  }
}

export async function testUiPathConnection(): Promise<{ success: boolean; message: string; errorType?: string }> {
  const config = await getUiPathConfig();
  if (!config) {
    return { success: false, message: "UiPath Orchestrator is not configured.", errorType: "not_configured" };
  }

  try {
    const token = await getAccessToken(config);
    const { metadataService: mdsSvc4 } = await import("./catalog/metadata-service");
    const orchUrl2 = mdsSvc4.getServiceUrl("OR", config);
    const foldersUrl = `${orchUrl2}${ODP.Folders}?$top=1`;
    const res = await fetch(foldersUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 403) {
        return { success: false, message: "Access denied. The App ID may not have the required scopes granted. Check your External Application settings in UiPath Cloud and ensure the correct scopes are selected.", errorType: "forbidden" };
      }
      if (res.status === 404) {
        return { success: false, message: "Organization or Tenant not found. Double-check the Organization Name and Tenant Name match your UiPath Cloud URL exactly.", errorType: "not_found" };
      }
      return { success: false, message: `Connection failed (${res.status}): ${errText.slice(0, 200)}`, errorType: "unknown" };
    }
    await recordLastTestedAt();
    return { success: true, message: "Connected to UiPath Orchestrator successfully." };
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes("invalid_scope")) {
      return { success: false, message: "Invalid scopes. The scopes you selected must match the scopes granted to your External Application in UiPath Cloud. Go to Admin > External Applications, edit your app, and verify the selected scopes.", errorType: "invalid_scope" };
    }
    if (msg.includes("invalid_client")) {
      return { success: false, message: "Invalid App ID or App Secret. Verify your credentials are correct. You may need to regenerate the App Secret in UiPath Cloud.", errorType: "invalid_client" };
    }
    return { success: false, message: `Connection failed: ${msg}`, errorType: "unknown" };
  }
}
