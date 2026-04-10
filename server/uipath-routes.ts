import type { Express, Request, Response } from "express";
import type { ParsedQs } from "qs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { getUiPathConfig, getAccessToken, saveUiPathConfig, testUiPathConnection, pushToUiPath, getLastTestedAt, fetchUiPathFolders, saveUiPathFolder, createProcess, listMachines, listRobots, listProcesses, startJob, getJobStatus, verifyUiPathScopes, probeUiPathScopes, autoDetectUiPathScopes, clearProbeCache, discoverIntegrationService, clearIntegrationServiceCache, discoverGovernancePolicies, discoverAttendedRobots, discoverStudioProjects, QualityGateError } from "./uipath-integration";
import { parseArtifactsFromSDD, extractArtifactsWithLLM, deployAllArtifacts, formatDeploymentReport } from "./uipath-deploy";
import { getPreviousManifest, reconcileArtifacts, saveManifest, formatReconciliationSummary } from "./artifact-reconciliation";
import { documentStorage } from "./document-storage";
import { chatStorage } from "./replit_integrations/chat/storage";
import { storage } from "./storage";
import { findUiPathMessage, parseUiPathPackage, generateUiPathPackage, computeVersion, getCachedPipelineResult, runBuildPipeline, type PipelineProgressEvent } from "./uipath-pipeline";
import { aggregateAnalysisReports, analyzeAndFix, formatDeploymentGateMarkdown, shouldBlockDeploymentFromAnalysis } from "./workflow-analyzer";
import { validateContractIntegrity } from "./xaml/workflow-contract-integrity";
import * as auth from "./uipath-auth";
import { metadataService, ORCHESTRATOR_DIAGNOSTIC_ENTITIES } from "./catalog/metadata-service";
import * as orch from "./orchestrator-client";
import * as prereqs from "./prerequisite-checker";
import { db } from "./db";
import { pipelineJobs, provisioningLog, actionTasks, testResults, uipathConnections, appSettings } from "@shared/schema";
import { eq, desc, ne } from "drizzle-orm";
import {
  startUiPathGenerationRun, getActiveRunForIdea, getActiveRun, subscribeToRun, cancelActiveRun,
  createObserverRun, getObserverRun, getLatestObserverRun,
  emitObserverProgress, emitObserverPipelineEvent, emitObserverHeartbeat,
  emitObserverMetaValidation, emitObserverDone, emitObserverError,
  cancelObserverRun, isObserverRunCancelled, subscribeToObserverRun, isObserverTerminalStatus,
  getObserverRunEvents,
  type ObserverRunState,
} from "./uipath-run-manager";
import {
  activateUiPathNativeSolution,
  DEFAULT_UIPATH_SOLUTION_SCOPES,
  deployUiPathNativeSolution,
  packUiPathNativeSolution,
  uploadUiPathNativeSolutionPackage,
  validateUiPathSolutionFolderResources,
} from "./uipath-solution-cli";
import { publishLinkedUiPathTestAutomationArtifact } from "./uipath-test-automation-publisher";

function extractOrgSlug(input: string): string {
  let val = input.trim();
  val = val.replace(/^https?:\/\//, "");
  val = val.replace(/^cloud\.uipath\.com\//, "");
  val = val.replace(/\/+$/, "");
  val = val.split("/")[0];
  return val.trim();
}

type DeployPackagePayload = {
  buffer: Buffer;
  gaps: Array<import("./xaml-generator").XamlGap>;
  usedPackages: string[];
  cacheHit?: boolean;
  qualityGateResult?: import("./uipath-quality-gate").QualityGateResult;
  xamlEntries: { name: string; content: string }[];
  dependencyMap: Record<string, string>;
  archiveManifest: string[];
  usedFallbackStubs: boolean;
  generationMode: import("./uipath-integration").GenerationMode;
  referencedMLSkillNames: string[];
  usedAIFallback: boolean;
  analysisReports?: Array<{ fileName: string; report: import("./workflow-analyzer").AnalysisReport }>;
};

function getWorkflowAnalyzerGateFailure(prebuiltResult: any): {
  blocked: boolean;
  summary?: string;
  aggregate?: ReturnType<typeof aggregateAnalysisReports>;
  contractIntegrity?: ReturnType<typeof validateContractIntegrity>;
} {
  const sourceEntries = Array.isArray(prebuiltResult?.xamlEntries) ? prebuiltResult.xamlEntries : [];
  const analysisReports = sourceEntries.length > 0
    ? sourceEntries.map((entry: { name: string; content: string }) => ({
        fileName: entry.name,
        report: analyzeAndFix(entry.content, "strict").report,
      }))
    : Array.isArray(prebuiltResult?.analysisReports) ? prebuiltResult.analysisReports : [];
  if (analysisReports.length === 0) {
    return { blocked: false };
  }

  const aggregate = aggregateAnalysisReports(analysisReports);
  const contractIntegrity = sourceEntries.length > 0
    ? validateContractIntegrity(sourceEntries)
    : undefined;
  const analyzerBlocks = shouldBlockDeploymentFromAnalysis(analysisReports);
  const contractBlocks = Boolean(contractIntegrity?.hasContractIntegrityIssues);

  if (!analyzerBlocks && !contractBlocks) {
    return { blocked: false, aggregate, contractIntegrity };
  }

  const contractSummary = contractIntegrity
    ? [
        contractIntegrity.contractIntegritySummary,
        contractIntegrity.contractIntegrityDefects.length > 0
          ? contractIntegrity.contractIntegrityDefects
              .map((defect) => `- ${defect.file}: ${defect.defectType} (${defect.propertyName || defect.targetArgument || "unknown"}) -> ${defect.notes}`)
              .join("\n")
          : "",
      ].filter(Boolean).join("\n")
    : "";

  return {
    blocked: true,
    aggregate,
    contractIntegrity,
    summary: [
      formatDeploymentGateMarkdown(analysisReports),
      contractSummary ? "\n**Contract Integrity**\n" + contractSummary : "",
    ].filter(Boolean).join("\n"),
  };
}

async function publishLinkedTestAutomationIfAvailable(params: {
  cachedPipeline: ReturnType<typeof getCachedPipelineResult> | null;
  deployArtifactsResult: Awaited<ReturnType<typeof deployAllArtifacts>>;
  packageProjectName: string;
  sendEvent: (event: Record<string, unknown>) => void;
}) {
  const { cachedPipeline, deployArtifactsResult, packageProjectName, sendEvent } = params;
  const artifact = cachedPipeline?.testAutomationArtifact;
  const tmContext = deployArtifactsResult.testManagerContext;
  if (!artifact || !tmContext?.projectId || !tmContext.activeTmBase) {
    return null;
  }

  const tmLinks = artifact.workflowMappings
    .map((workflow) => {
      const match = tmContext.testCases.find((testCase) => testCase.name.toLowerCase() === workflow.testCaseName.toLowerCase());
      if (!match?.objKey) return null;
      return {
        testCaseName: workflow.testCaseName,
        tmTestCaseId: match.id,
        tmObjKey: match.objKey,
      };
    })
    .filter((link): link is NonNullable<typeof link> => !!link);

  if (tmLinks.length === 0) {
    return {
      linkedCount: 0,
      totalLinksExpected: artifact.workflowMappings.length,
      skipped: true,
      reason: "No Test Manager object keys were available for the generated test cases.",
    };
  }

  sendEvent({ deployStatus: "Packing linked UiPath Tests project..." });
  const publishResult = await publishLinkedUiPathTestAutomationArtifact({
    artifact,
    tmProjectId: tmContext.projectId,
    tmProjectName: tmContext.projectName || packageProjectName,
    testManagerBasePath: tmContext.activeTmBase,
    links: tmLinks,
  });

  sendEvent({ deployStatus: `Linked ${publishResult.linkedCount}/${publishResult.totalLinksExpected} automated test workflow(s)` });
  return publishResult;
}

let migrationDone = false;
async function migrateExistingConfigToConnection(): Promise<void> {
  if (migrationDone) return;
  const existing = await db.select().from(uipathConnections);
  if (existing.length > 0) {
    migrationDone = true;
    return;
  }
  const all = await db.select().from(appSettings);
  const map = new Map(all.map((r) => [r.key, r.value]));
  const orgName = map.get("uipath_org_name");
  const tenantName = map.get("uipath_tenant_name");
  const clientId = map.get("uipath_client_id");
  const clientSecret = map.get("uipath_client_secret");
  if (!orgName || !tenantName || !clientId || !clientSecret) {
    migrationDone = true;
    return;
  }
  await db.insert(uipathConnections).values({
    name: `${orgName} / ${tenantName}`,
    orgName,
    tenantName,
    clientId,
    clientSecret,
    scopes: map.get("uipath_scopes") || metadataService.getScopesForServiceString("OR"),
    folderId: map.get("uipath_folder_id") || null,
    folderName: map.get("uipath_folder_name") || null,
    isActive: true,
  });
  auth.invalidateAllTokens();
  auth.invalidateConfig();
  clearProbeCache(); metadataService.clearReachability();
  migrationDone = true;
  console.log("[UiPath] Migrated existing config to uipath_connections table");
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!req.session.userId) {
    res.status(401).json({ message: "Not authenticated" });
    return false;
  }
  const role = req.session.activeRole || "";
  if (role !== "Admin") {
    res.status(403).json({ message: "Admin access required" });
    return false;
  }
  return true;
}

type ParamLike = string | string[] | undefined;
type QueryLike = string | ParsedQs | (string | ParsedQs)[] | undefined;

function firstString(value: ParamLike): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function firstQueryString(value: QueryLike): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function requiredParam(value: ParamLike, name: string): string {
  const normalized = firstString(value)?.trim();
  if (!normalized) {
    throw new Error(`Missing route parameter: ${name}`);
  }
  return normalized;
}

function optionalQuery(value: QueryLike): string | undefined {
  const normalized = firstQueryString(value)?.trim();
  return normalized ? normalized : undefined;
}

function parseIntegerParam(value: ParamLike): number {
  const normalized = firstString(value);
  return Number.parseInt(normalized ?? "", 10);
}

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

function mergeUiPathScopes(...scopeSets: Array<string | undefined>): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const scopeSet of scopeSets) {
    for (const scope of String(scopeSet || "").split(/\s+/).filter(Boolean)) {
      if (!seen.has(scope)) {
        seen.add(scope);
        ordered.push(scope);
      }
    }
  }
  return ordered.join(" ");
}

function extractTestManagerArtifacts(artifacts: any): {
  testCases?: any[];
  testDataQueues?: any[];
  requirements?: any[];
  testSets?: any[];
} {
  return {
    ...(Array.isArray(artifacts?.testCases) && artifacts.testCases.length > 0 ? { testCases: artifacts.testCases } : {}),
    ...(Array.isArray(artifacts?.testDataQueues) && artifacts.testDataQueues.length > 0 ? { testDataQueues: artifacts.testDataQueues } : {}),
    ...(Array.isArray(artifacts?.requirements) && artifacts.requirements.length > 0 ? { requirements: artifacts.requirements } : {}),
    ...(Array.isArray(artifacts?.testSets) && artifacts.testSets.length > 0 ? { testSets: artifacts.testSets } : {}),
  };
}

function hasTestManagerArtifacts(artifacts: {
  testCases?: any[];
  testDataQueues?: any[];
  requirements?: any[];
  testSets?: any[];
}): boolean {
  return (
    (artifacts.testCases?.length || 0) > 0 ||
    (artifacts.testDataQueues?.length || 0) > 0 ||
    (artifacts.requirements?.length || 0) > 0 ||
    (artifacts.testSets?.length || 0) > 0
  );
}

export function registerUiPathRoutes(app: Express): void {
  app.get("/api/settings/uipath/taxonomy", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const taxonomy = metadataService.getServiceTaxonomy();
    const hierarchy = metadataService.getTaxonomyHierarchy();
    return res.json({ taxonomy, hierarchy });
  });

  app.get("/api/settings/uipath", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const config = await getUiPathConfig();
    const lastTestedAt = await getLastTestedAt();
    if (!config) {
      return res.json({ configured: false, lastTestedAt });
    }
    return res.json({
      configured: true,
      orgName: config.orgName,
      tenantName: config.tenantName,
      clientId: config.clientId,
      scopes: config.scopes,
      hasSecret: !!config.clientSecret,
      lastTestedAt,
      folderId: config.folderId || null,
      folderName: config.folderName || null,
    });
  });

  app.get("/api/settings/uipath/folders", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await fetchUiPathFolders();
    return res.json(result);
  });

  app.post("/api/settings/uipath/folder", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const { folderId, folderName } = req.body;
    await saveUiPathFolder(folderId || null, folderName || null);
    clearProbeCache(); metadataService.clearReachability();
    return res.json({ success: true });
  });

  app.post("/api/settings/uipath", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const { orgName, tenantName, clientId, clientSecret, scopes } = req.body;
    if (!orgName || !tenantName || !clientId) {
      return res.status(400).json({ message: "Organization, tenant, and client ID are required" });
    }
    const existingConfig = await getUiPathConfig();
    if (!clientSecret && !existingConfig) {
      return res.status(400).json({ message: "App Secret is required for initial configuration" });
    }
    await saveUiPathConfig({ orgName, tenantName, clientId, clientSecret: clientSecret || undefined, scopes: scopes || undefined });

    const cleanOrg = extractOrgSlug(orgName);
    const activeRows = await db.select().from(uipathConnections).where(eq(uipathConnections.isActive, true));
    if (activeRows.length > 0) {
      const updates: Record<string, any> = {
        orgName: cleanOrg,
        tenantName: tenantName.trim(),
        clientId: clientId.trim(),
      };
      if (clientSecret) updates.clientSecret = clientSecret.trim();
      if (scopes) updates.scopes = scopes.trim();
      await db.update(uipathConnections).set(updates).where(eq(uipathConnections.id, activeRows[0].id));
    } else {
      const secret = clientSecret?.trim() || existingConfig?.clientSecret;
      if (secret) {
        await db.insert(uipathConnections).values({
          name: `${cleanOrg} / ${tenantName.trim()}`,
          orgName: cleanOrg,
          tenantName: tenantName.trim(),
          clientId: clientId.trim(),
          clientSecret: secret,
          scopes: scopes?.trim() || metadataService.getScopesForServiceString("OR"),
          isActive: true,
        });
      }
    }
    auth.invalidateAllTokens();
    auth.invalidateConfig();
    clearProbeCache(); metadataService.clearReachability();

    const testResult = await testUiPathConnection();
    return res.json({
      success: true,
      message: "UiPath configuration saved.",
      testResult,
    });
  });

  app.post("/api/settings/uipath/test", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await testUiPathConnection();
    return res.json(result);
  });

  app.get("/api/settings/uipath/connections", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      await migrateExistingConfigToConnection();
      const rows = await db.select().from(uipathConnections);
      const masked = rows.map(r => ({
        ...r,
        clientSecret: r.clientSecret ? "••••••••" : "",
        automationHubToken: r.automationHubToken ? "••••••••" : "",
        communicationsMiningToken: r.communicationsMiningToken ? "••••••••" : "",
      }));
      return res.json(masked);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/settings/uipath/connections", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { name, orgName, tenantName, clientId, clientSecret, scopes, folderId, folderName } = req.body;
      if (!name || !orgName || !tenantName || !clientId || !clientSecret) {
        return res.status(400).json({ message: "Name, organization, tenant, client ID, and client secret are required" });
      }
      const existing = await db.select().from(uipathConnections);
      const isFirst = existing.length === 0;
      const [row] = await db.insert(uipathConnections).values({
        name: name.trim(),
        orgName: extractOrgSlug(orgName),
        tenantName: tenantName.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        scopes: scopes?.trim() || metadataService.getScopesForServiceString("OR"),
        folderId: folderId || null,
        folderName: folderName || null,
        isActive: isFirst,
      }).returning();
      if (isFirst) {
        auth.invalidateAllTokens();
        auth.invalidateConfig();
        clearProbeCache(); metadataService.clearReachability();
      }
      return res.json({ ...row, clientSecret: "••••••••", automationHubToken: row.automationHubToken ? "••••••••" : "", communicationsMiningToken: row.communicationsMiningToken ? "••••••••" : "" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.patch("/api/settings/uipath/connections/:id", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseIntegerParam(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const existing = await db.select().from(uipathConnections).where(eq(uipathConnections.id, id));
      if (existing.length === 0) return res.status(404).json({ message: "Connection not found" });

      const { name, orgName, tenantName, clientId, clientSecret, scopes, folderId, folderName } = req.body;
      const updates: Record<string, any> = {};
      if (name !== undefined) updates.name = name.trim();
      if (orgName !== undefined) updates.orgName = extractOrgSlug(orgName);
      if (tenantName !== undefined) updates.tenantName = tenantName.trim();
      if (clientId !== undefined) updates.clientId = clientId.trim();
      if (clientSecret) updates.clientSecret = clientSecret.trim();
      if (scopes !== undefined) updates.scopes = scopes.trim();
      if (folderId !== undefined) updates.folderId = folderId || null;
      if (folderName !== undefined) updates.folderName = folderName || null;

      const [updated] = await db.update(uipathConnections).set(updates).where(eq(uipathConnections.id, id)).returning();
      if (updated.isActive) {
        auth.invalidateAllTokens();
        auth.invalidateConfig();
        clearProbeCache(); metadataService.clearReachability();
      }
      return res.json({ ...updated, clientSecret: "••••••••", automationHubToken: updated.automationHubToken ? "••••••••" : "", communicationsMiningToken: updated.communicationsMiningToken ? "••••••••" : "" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/settings/uipath/connections/:id", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseIntegerParam(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const existing = await db.select().from(uipathConnections).where(eq(uipathConnections.id, id));
      if (existing.length === 0) return res.status(404).json({ message: "Connection not found" });
      if (existing[0].isActive) return res.status(400).json({ message: "Cannot delete the active connection. Switch to another connection first." });
      await db.delete(uipathConnections).where(eq(uipathConnections.id, id));
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/settings/uipath/connections/:id/activate", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseIntegerParam(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const existing = await db.select().from(uipathConnections).where(eq(uipathConnections.id, id));
      if (existing.length === 0) return res.status(404).json({ message: "Connection not found" });
      await db.update(uipathConnections).set({ isActive: false }).where(ne(uipathConnections.id, id));
      const [activated] = await db.update(uipathConnections).set({ isActive: true }).where(eq(uipathConnections.id, id)).returning();
      auth.invalidateAllTokens();
      auth.invalidateConfig();
      clearProbeCache(); metadataService.clearReachability();
      return res.json({ ...activated, clientSecret: "••••••••", automationHubToken: activated.automationHubToken ? "••••••••" : "", communicationsMiningToken: activated.communicationsMiningToken ? "••••••••" : "" });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/settings/uipath/connections/:id/test", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = parseIntegerParam(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid ID" });
      const rows = await db.select().from(uipathConnections).where(eq(uipathConnections.id, id));
      if (rows.length === 0) return res.status(404).json({ message: "Connection not found" });
      const conn = rows[0];

      const orchEntry = metadataService.getCapabilityTaxonomyEntry("orchestrator");
      const orchScopePrefix = orchEntry?.scopeFamily ? `${orchEntry.scopeFamily}.` : "OR.";
      const orScopes = conn.scopes.split(/\s+/).filter(s => s.startsWith(orchScopePrefix));
      const tokenParams = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: conn.clientId,
        client_secret: conn.clientSecret,
        scope: orScopes.length > 0 ? orScopes.join(" ") : conn.scopes,
      });

      const tokenRes = await fetch(metadataService.getTokenEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });

      if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => "");
        await db.update(uipathConnections).set({ lastTestedAt: new Date() }).where(eq(uipathConnections.id, id));
        return res.json({ success: false, message: `Authentication failed (${tokenRes.status}): ${text.slice(0, 200)}` });
      }

      const tokenData = await tokenRes.json();
      const baseUrl = metadataService.getServiceUrl("OR", { orgName: conn.orgName, tenantName: conn.tenantName });
      const orchTaxEntry = metadataService.getCapabilityTaxonomyEntry("orchestrator");
      const orchProbePath = orchTaxEntry?.probeConfig?.probePath ?? "";
      const orchRes = await fetch(`${baseUrl}${orchProbePath}`, {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, "Content-Type": "application/json" },
      });

      await db.update(uipathConnections).set({ lastTestedAt: new Date() }).where(eq(uipathConnections.id, id));

      if (orchRes.ok) {
        return res.json({ success: true, message: `Connected to ${conn.tenantName}` });
      } else {
        const text = await orchRes.text().catch(() => "");
        return res.json({ success: false, message: `Orchestrator returned ${orchRes.status}: ${text.slice(0, 200)}` });
      }
    } catch (err: any) {
      return res.json({ success: false, message: err.message });
    }
  });

  app.get("/api/settings/uipath/verify-scopes", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await verifyUiPathScopes();
    return res.json(result);
  });

  app.get("/api/settings/uipath/probe-scopes", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await probeUiPathScopes();
    return res.json(result);
  });

  app.post("/api/settings/uipath/auto-detect-scopes", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await autoDetectUiPathScopes();
    return res.json(result);
  });

  app.get("/api/settings/uipath/oidc-diagnostics", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const oidcStatus = metadataService.getOidcStatus();
    const validScopes = metadataService.getOidcValidScopes();
    const resourceTypes: Array<import("./catalog/metadata-schemas").ServiceResourceType> = ["OR", "TM", "DU", "DF", "PIMS", "IXP", "AI", "IDENTITY"];
    const scopesByService: Record<string, string[]> = {};
    for (const rt of resourceTypes) {
      scopesByService[rt] = metadataService.getScopesForService(rt);
    }
    return res.json({
      ...oidcStatus,
      totalValidScopes: validScopes.length,
      scopesByService,
    });
  });

  app.post("/api/settings/uipath/oidc-refresh", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await metadataService.refreshFromOIDC();
    return res.json(result);
  });

  app.get("/api/settings/uipath/du-scope-diagnostics", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { testDuScopeForms } = await import("./uipath-auth");
      const results = await testDuScopeForms();
      const validatedScopes = metadataService.getValidatedScopes("DU");
      const scopeSource = metadataService.getScopeSource("DU");
      const currentMinimalScopes = metadataService.getMinimalScopesForService("DU");
      const candidates = metadataService.getScopeCandidatesForService("DU");
      return res.json({
        scopeTestResults: results,
        validatedScopes,
        scopeSource,
        currentMinimalScopes,
        candidates: candidates.map(c => ({ label: c.label, scopes: c.scopes })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/settings/uipath/status", async (_req: Request, res: Response) => {
    const config = await getUiPathConfig();
    return res.json({ configured: !!config });
  });

  app.get("/api/settings/uipath/machines", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await listMachines();
    return res.json(result);
  });

  app.get("/api/settings/uipath/ai-center", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { getAICenterSkills } = await import("./uipath-integration");
      const result = await getAICenterSkills();
      return res.json(result);
    } catch (err: any) {
      return res.json({ available: false, skills: [], packages: [], error: err.message });
    }
  });

  app.get("/api/settings/uipath/robots", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await listRobots();
    return res.json(result);
  });

  app.get("/api/settings/uipath/processes", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await listProcesses();
    return res.json(result);
  });

  app.get("/api/settings/uipath/governance-policies", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await discoverGovernancePolicies();
    return res.json(result);
  });

  app.get("/api/settings/uipath/attended-robots", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await discoverAttendedRobots();
    return res.json(result);
  });

  app.get("/api/settings/uipath/studio-projects", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const result = await discoverStudioProjects();
    return res.json(result);
  });

  app.get("/api/settings/uipath/health-check", (req: Request, res: Response) => {
    res.redirect(307, "/api/uipath/diagnostics");
  });

  app.post("/api/ideas/:ideaId/create-process", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });

    const user = await storage.getUser(req.session.userId as string);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const { packageId, packageVersion, processName, description } = req.body;
    if (!packageId || !packageVersion || !processName) {
      return res.status(400).json({ message: "packageId, packageVersion, and processName are required" });
    }

    const result = await createProcess(packageId, packageVersion, processName, description);
    return res.json(result);
  });

  app.post("/api/ideas/:ideaId/start-job", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });

    const user = await storage.getUser(req.session.userId as string);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const { releaseKey, robotIds } = req.body;
    if (!releaseKey) {
      return res.status(400).json({ message: "releaseKey is required" });
    }

    const result = await startJob(releaseKey, robotIds);

    if (result.success) {
      await chatStorage.createMessage(
        ideaId,
        "assistant",
        `Job started in UiPath Orchestrator.\n\nJob ID: ${result.job?.id}\nState: ${result.job?.state}\n\nMonitor progress in Orchestrator > Jobs, or use the status check below.`
      );
    } else {
      await chatStorage.createMessage(ideaId, "assistant", `Failed to start job: ${result.message}`);
    }

    return res.json(result);
  });

  app.get("/api/ideas/:ideaId/job-status/:jobId", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const jobId = parseIntegerParam(req.params.jobId);
    if (isNaN(jobId)) return res.status(400).json({ message: "Invalid job ID" });

    const result = await getJobStatus(jobId);
    return res.json(result);
  });

  app.post("/api/ideas/:ideaId/push-uipath", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) {
      return res.status(404).json({ message: "Idea not found" });
    }

    const user = await storage.getUser(req.session.userId as string);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const sddApprovalCheck = await documentStorage.getApproval(ideaId, "SDD");
    if (!sddApprovalCheck) {
      return res.status(400).json({ message: "SDD must be approved first" });
    }

    const messages = await chatStorage.getMessagesByIdeaId(ideaId);
    const uipathMsg = findUiPathMessage(messages);
    if (!uipathMsg) {
      return res.status(404).json({ message: "No UiPath package found. Generate it first." });
    }

    let pkg;
    try {
      pkg = parseUiPathPackage(uipathMsg);
    } catch (e: any) {
      return res.status(500).json({ message: "Invalid package data" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();

    const sendEvent = (data: Record<string, any>) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e: any) { /* SSE write failed — client disconnected */ }
    };

    let clientDisconnected = false;
    req.on("close", () => {
      clientDisconnected = true;
      clearInterval(heartbeat);
    });

    const heartbeat = setInterval(() => {
      try { res.write(`: heartbeat\n\n`); } catch (e: any) { /* SSE heartbeat write failed — client disconnected */ }
    }, 5000);

    try {
      sendEvent({ deployStatus: "Preparing package for deployment..." });

      let prebuiltResult: DeployPackagePayload;
      const cachedPipeline = getCachedPipelineResult(ideaId);
      if (cachedPipeline) {
        console.log(`[UiPath Deploy] Using cached pipeline result for ${ideaId}`);
          prebuiltResult = {
            buffer: cachedPipeline.packageBuffer,
            gaps: cachedPipeline.gaps,
            usedPackages: cachedPipeline.usedPackages,
            qualityGateResult: cachedPipeline.qualityGateResult,
            xamlEntries: cachedPipeline.xamlEntries,
            dependencyMap: cachedPipeline.dependencyMap,
            archiveManifest: cachedPipeline.archiveManifest,
            analysisReports: cachedPipeline.analysisReports,
            usedFallbackStubs: cachedPipeline.usedFallbackStubs,
            generationMode: cachedPipeline.generationMode,
            referencedMLSkillNames: cachedPipeline.referencedMLSkillNames || [],
            usedAIFallback: cachedPipeline.usedAIFallback,
          };
      } else {
        try {
          const pipelineResult = await runBuildPipeline(ideaId, pkg, {
            version: computeVersion(),
            onProgress: (msg) => sendEvent({ deployStatus: msg }),
            onMetaValidation: (event) => sendEvent({ metaValidation: event }),
            onPipelineProgress: (event: PipelineProgressEvent) => sendEvent({ pipelineEvent: event, deployStatus: event.message }),
          });
          prebuiltResult = {
            buffer: pipelineResult.packageBuffer,
            gaps: pipelineResult.gaps,
            usedPackages: pipelineResult.usedPackages,
            qualityGateResult: pipelineResult.qualityGateResult,
            xamlEntries: pipelineResult.xamlEntries,
            dependencyMap: pipelineResult.dependencyMap,
            archiveManifest: pipelineResult.archiveManifest,
            analysisReports: pipelineResult.analysisReports,
            usedFallbackStubs: pipelineResult.usedFallbackStubs,
            generationMode: pipelineResult.generationMode,
            referencedMLSkillNames: pipelineResult.referencedMLSkillNames || [],
            usedAIFallback: pipelineResult.usedAIFallback,
          };
        } catch (err: any) {
          if (err instanceof QualityGateError) {
            sendEvent({
              deployComplete: true,
              success: false,
              result: {
                success: false,
                message: "Package failed quality gate validation",
                qualityGateViolations: err.qualityGateResult.violations,
                qualityGateSummary: err.qualityGateResult.summary,
              },
            });
            clearInterval(heartbeat);
            return res.end();
          }
          throw err;
        }
      }

      const analyzerGate = getWorkflowAnalyzerGateFailure(prebuiltResult);
      if (analyzerGate.blocked) {
        sendEvent({
          deployComplete: true,
          success: false,
          result: {
            success: false,
            message: "Deployment blocked by Workflow Analyzer",
            workflowAnalyzerGate: {
              summary: analyzerGate.summary,
              aggregate: analyzerGate.aggregate,
            },
          },
        });
        clearInterval(heartbeat);
        return res.end();
      }

      const deliveryRecommendation = cachedPipeline?.deliveryRecommendation;
      const shouldDeployAsSolution = deliveryRecommendation?.recommendedOutput === "solution" && !!cachedPipeline?.solutionArtifact?.buffer;

      if (shouldDeployAsSolution && cachedPipeline?.solutionArtifact?.buffer) {
        const config = await getUiPathConfig();
        if (!config) {
          sendEvent({ deployComplete: true, success: false, result: { success: false, message: "UiPath Orchestrator is not configured." } });
          clearInterval(heartbeat);
          return res.end();
        }

        const versionMatch = cachedPipeline.solutionArtifact.fileName.match(/\.(\d+\.\d+\.[^.]*)\.uis$/);
        const version = versionMatch?.[1] || computeVersion();
        const useCaseName = titleCaseWords(
          idea.title
          || pkg.projectName
          || cachedPipeline.solutionArtifact.manifest.displayName
          || "Automation",
        );
        const deploymentParentFolder = config.folderName || "";
        const folderName = `${useCaseName} Solutions`;
        const deploymentName = useCaseName;
        const applicationScope = mergeUiPathScopes(config.scopes, DEFAULT_UIPATH_SOLUTION_SCOPES, "OR.Execution");
        const auth = {
          organizationName: extractOrgSlug(config.orgName),
          tenantName: config.tenantName,
          applicationId: config.clientId,
          applicationSecret: config.clientSecret,
          applicationScope,
          orchestratorUrl: "https://cloud.uipath.com/",
        };

        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cb2-solution-deploy-"));
        const workspaceDir = path.join(tempRoot, "workspace");
        const packedDir = path.join(tempRoot, "packed");
        fs.mkdirSync(workspaceDir, { recursive: true });
        fs.mkdirSync(packedDir, { recursive: true });

        try {
          sendEvent({ deployStatus: "Preparing native UiPath solution workspace..." });
          const zip = new AdmZip(cachedPipeline.solutionArtifact.buffer);
          zip.extractAllTo(workspaceDir, true);

          const solutionUipxPath = path.join(workspaceDir, "Solution.uipx");
          if (!fs.existsSync(solutionUipxPath)) {
            throw new Error("Generated native .uis is missing Solution.uipx.");
          }

          sendEvent({ deployStatus: "Packing native UiPath solution..." });
          const packed = await packUiPathNativeSolution({
            projectPath: solutionUipxPath,
            version,
            outputDir: packedDir,
            traceLevel: "Information",
          });

          sendEvent({ deployStatus: "Uploading solution package to UiPath Solutions..." });
          const upload = await uploadUiPathNativeSolutionPackage(auth, packed.packagePath, { traceLevel: "Information" });

          sendEvent({ deployStatus: `Deploying solution "${deploymentName}"...` });
          const deploy = await deployUiPathNativeSolution(auth, {
            packageName: packed.packageName,
            version,
            deploymentName,
            folderName,
            parentFolderName: deploymentParentFolder || undefined,
            traceLevel: "Information",
          });

          sendEvent({ deployStatus: `Activating solution "${deploymentName}"...` });
          const activate = await activateUiPathNativeSolution(auth, deploymentName, version, { traceLevel: "Information" });

          sendEvent({ deployStatus: `Validating deployed resources in "${folderName}"...` });
          const validation = await validateUiPathSolutionFolderResources(auth, {
            folderName,
            processes: cachedPipeline.solutionArtifact.manifest.resources.processes.length > 0
              ? cachedPipeline.solutionArtifact.manifest.resources.processes
              : [pkg.projectName],
            assets: cachedPipeline.solutionArtifact.manifest.resources.assets,
            queues: cachedPipeline.solutionArtifact.manifest.resources.queues,
            buckets: cachedPipeline.solutionArtifact.manifest.resources.storageBuckets,
          });

          let testManagerResults: any[] = [];
          let testManagerSummary = "";
          let testManagerServiceLimitations: Array<{ service: string; status: "limited" | "unavailable" | "unknown"; reason: string }> | undefined;
          let linkedTestAutomation: any;
          const sdd = await documentStorage.getDocument(sddApprovalCheck.documentId);
          if (sdd?.content) {
            let extractedArtifacts = parseArtifactsFromSDD(sdd.content);
            if (!extractedArtifacts) {
              sendEvent({ deployStatus: "Extracting test artifacts from approved SDD..." });
              extractedArtifacts = await extractArtifactsWithLLM(sdd.content);
            }
            const testManagerArtifacts = extractTestManagerArtifacts(extractedArtifacts || {});
            if (hasTestManagerArtifacts(testManagerArtifacts)) {
              sendEvent({ deployStatus: "Provisioning Test Manager artifacts..." });
              const tmProvision = await deployAllArtifacts(
                testManagerArtifacts,
                null,
                null,
                pkg.projectName,
                (step) => sendEvent({ deployStatus: step }),
                prebuiltResult?.referencedMLSkillNames,
              );
              testManagerResults = tmProvision.results;
              testManagerSummary = tmProvision.summary;
              testManagerServiceLimitations = tmProvision.serviceLimitations;
              linkedTestAutomation = await publishLinkedTestAutomationIfAvailable({
                cachedPipeline,
                deployArtifactsResult: tmProvision,
                packageProjectName: pkg.projectName,
                sendEvent,
              }).catch((err: any) => ({
                error: err?.message || String(err),
              }));
              if (linkedTestAutomation) {
                testManagerSummary = testManagerSummary
                  ? `${testManagerSummary}\nLinked automated tests: ${
                      "linkedCount" in linkedTestAutomation ? linkedTestAutomation.linkedCount : 0
                    }/${
                      "totalLinksExpected" in linkedTestAutomation ? linkedTestAutomation.totalLinksExpected : 0
                    }`
                  : testManagerSummary;
              }
            }
          }

          const result = {
            success: true,
            message: `Solution "${deploymentName}" deployed successfully.`,
            details: {
              deploymentType: "solution",
              packageName: packed.packageName,
              version,
              deploymentName,
              folderName,
              parentFolderName: deploymentParentFolder || null,
              upload,
              deploy,
              activate,
              validation,
              testManagerResults: testManagerResults.length > 0 ? testManagerResults : undefined,
              testManagerSummary: testManagerSummary || undefined,
              linkedTestAutomation: linkedTestAutomation || undefined,
              testManagerServiceLimitations,
            },
          };

          sendEvent({ deployStatus: `Solution "${deploymentName}" active in "${folderName}"` });
          sendEvent({ deployComplete: true, success: true, result });
          clearInterval(heartbeat);
          return res.end();
        } finally {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }

      sendEvent({ deployStatus: "Uploading to Orchestrator..." });
      let result;
      try {
        result = await pushToUiPath(pkg, ideaId, prebuiltResult);
      } catch (pushErr: any) {
        if (pushErr instanceof QualityGateError) {
          sendEvent({
            deployComplete: true,
            success: false,
            result: {
              success: false,
              message: "Package failed quality gate validation",
              qualityGateViolations: pushErr.qualityGateResult.violations,
              qualityGateSummary: pushErr.qualityGateResult.summary,
            },
          });
          clearInterval(heartbeat);
          return res.end();
        }
        throw pushErr;
      }

      if (!result.success) {
        sendEvent({ deployComplete: true, success: false, result });
        clearInterval(heartbeat);
        return res.end();
      }

      const details = result.details;
      const packageId = details?.packageId || pkg.projectName;
      const packageVersion = details?.version || "1.0.0";

      sendEvent({ deployStatus: "Creating process in Orchestrator..." });
      let processResult: { success: boolean; message: string; process?: any } = { success: false, message: "" };
      try {
        const processName = packageId.replace(/_/g, " ");
        processResult = await createProcess(packageId, packageVersion, processName, pkg.description);
        if (processResult.success && processResult.process) {
          result.details = {
            ...result.details,
            processId: processResult.process.Id || processResult.process.id,
            processName: processResult.process.Name || processResult.process.name,
            releaseKey: processResult.process.Key || processResult.process.key,
          };
        }
      } catch (err: any) {
        console.error("[UiPath] Auto-create process failed:", err.message);
      }

      sendEvent({ deployStatus: processResult.success ? `Process "${result.details?.processName}" created` : "Process creation skipped" });

      const sdd = await documentStorage.getDocument(sddApprovalCheck.documentId);
      try {
        if (sdd?.content) {
          let artifacts = parseArtifactsFromSDD(sdd.content);

          if (!artifacts) {
            console.warn("[UiPath] DOWNSTREAM RECOVERY: No artifacts block found in approved SDD — this should have been caught by upstream validation. Attempting LLM extraction as recovery...");
            sendEvent({ deployStatus: "Extracting artifacts from SDD (recovery)..." });
            artifacts = await extractArtifactsWithLLM(sdd.content);
            if (!artifacts) {
              console.error("[UiPath] DOWNSTREAM RECOVERY FAILED: LLM extraction could not produce valid artifacts. Halting deployment.");
              sendEvent({ deployStatus: "ERROR: Failed to extract deployment artifacts from SDD. Deployment halted — please regenerate the SDD with valid artifacts." });
              throw new Error("Artifact extraction failed: no valid deployment artifacts could be extracted from SDD. Regenerate the SDD with valid artifacts before retrying deployment.");
            } else {
              console.log("[UiPath] DOWNSTREAM RECOVERY SUCCEEDED: LLM extraction produced artifacts");
            }
          }

          if (artifacts && (!artifacts.actionCenter || artifacts.actionCenter.length === 0)) {
            const acMentions = (sdd.content.match(/[Aa]ction\s*[Cc]enter|[Hh]uman.*[Ll]oop|[Aa]pproval|[Ee]scalation/gi) || []).length;
            if (acMentions > 0) {
              const supplemented = await extractArtifactsWithLLM(sdd.content);
              if (supplemented?.actionCenter?.length) {
                artifacts.actionCenter = supplemented.actionCenter;
              }
            }
          }

          const hasDeployableArtifacts = artifacts && (
            (artifacts.queues?.length || 0) > 0 ||
            (artifacts.assets?.length || 0) > 0 ||
            (artifacts.machines?.length || 0) > 0 ||
            (artifacts.triggers?.length || 0) > 0 ||
            (artifacts.storageBuckets?.length || 0) > 0 ||
            (artifacts.environments?.length || 0) > 0 ||
            (artifacts.actionCenter?.length || 0) > 0 ||
            (artifacts.documentUnderstanding?.length || 0) > 0 ||
            (artifacts.testCases?.length || 0) > 0 ||
            (artifacts.testDataQueues?.length || 0) > 0 ||
            (artifacts.robotAccounts?.length || 0) > 0 ||
            (artifacts.requirements?.length || 0) > 0 ||
            (artifacts.testSets?.length || 0) > 0 ||
            (artifacts.agents?.length || 0) > 0 ||
            (artifacts.knowledgeBases?.length || 0) > 0 ||
            (artifacts.promptTemplates?.length || 0) > 0 ||
            (artifacts.maestroProcesses?.length || 0) > 0
          );

          if (artifacts && !hasDeployableArtifacts) {
            console.error("[UiPath] Artifact block parsed but contains no deployable artifact arrays. No artifacts will be provisioned.");
            sendEvent({ deployStatus: "WARNING: SDD artifact block is empty — no artifacts to provision. Consider regenerating the SDD." });
          }

          if (hasDeployableArtifacts) {
            sendEvent({ deployStatus: "Reconciling artifacts with previous deployment..." });
            const previousManifest = await getPreviousManifest(ideaId);
            const reconciliation = reconcileArtifacts(artifacts, previousManifest);
            const reconciledArtifacts = reconciliation.reconciledArtifacts;

            if (previousManifest.length > 0) {
              const reconciliationSummary = formatReconciliationSummary(reconciliation.actions);
              if (reconciliationSummary) {
                console.log(`[UiPath Deploy] ${reconciliationSummary}`);
                sendEvent({ deployStatus: reconciliationSummary.split("\n")[0] });
              }
            }

            const releaseId = result.details?.processId || null;
            const releaseKey = result.details?.releaseKey || null;
            const releaseName = result.details?.processName || null;

            sendEvent({ deployStatus: "Provisioning Orchestrator artifacts..." });

            const deployResult = await deployAllArtifacts(reconciledArtifacts, releaseId, releaseKey, releaseName, (step) => {
              sendEvent({ deployStatus: step });
            }, prebuiltResult?.referencedMLSkillNames);
            const linkedTestAutomation = await publishLinkedTestAutomationIfAvailable({
              cachedPipeline,
              deployArtifactsResult: deployResult,
              packageProjectName: pkg.projectName,
              sendEvent,
            }).catch((err: any) => ({
              error: err?.message || String(err),
            }));

            const reconciliationActions = reconciliation.actions;
            const removedArtifacts = reconciliationActions
              .filter((a) => a.action === "removed" && a.previousName)
              .map((a) => ({ artifactType: a.artifactType, artifactName: a.previousName! }));

            try {
              await saveManifest(ideaId, deployResult.results, removedArtifacts);
              console.log(`[UiPath Deploy] Saved deployment manifest for idea ${ideaId}`);
            } catch (manifestErr: any) {
              console.warn(`[UiPath Deploy] Failed to save deployment manifest: ${manifestErr.message}`);
              deployResult.results.push({
                artifact: "Deployment Manifest",
                name: "Artifact Manifest",
                status: "failed",
                message: `Failed to save deployment manifest for future reconciliation: ${manifestErr.message}. Subsequent redeployments may not detect name drift correctly.`,
              });
            }
            const reconSummaryText = previousManifest.length > 0
              ? formatReconciliationSummary(reconciliationActions)
              : "";

            result.details = {
              ...result.details,
              deploymentResults: deployResult.results,
              deploymentSummary: deployResult.summary + (reconSummaryText ? "\n\n" + reconSummaryText : ""),
              reconciliationActions: reconciliationActions.length > 0 ? reconciliationActions : undefined,
              serviceLimitations: deployResult.serviceLimitations ?? undefined,
              linkedTestAutomation: linkedTestAutomation || undefined,
            };
          }
        }
      } catch (err: any) {
        console.error("[UiPath] Artifact deployment failed:", err.message);
        sendEvent({ deployStatus: `Artifact deployment error: ${err.message}` });
        result.details = {
          ...result.details,
          artifactError: err.message,
        };
      }

      const deployResults = result.details?.deploymentResults || [];

      const deployReportData = deployResults.length > 0 ? {
        packageId,
        version: packageVersion,
        processName: result.details?.processName,
        orgName: result.details?.orgName,
        tenantName: result.details?.tenantName,
        folderName: result.details?.folderName,
        results: deployResults,
        summary: result.details?.deploymentSummary || "",
        serviceLimitations: result.details?.serviceLimitations ?? undefined,
      } : null;

      let storePublishLine = "";
      const deploySucceeded = result.success && processResult.success && !result.details?.artifactError;
      if (deploySucceeded) {
        try {
          const { publishToAutomationStore } = await import("./automation-hub");
          sendEvent({ deployStatus: "Publishing to Automation Store..." });
          const storeResult = await publishToAutomationStore({
            name: packageId,
            description: idea.description || pkg.description || "",
            version: packageVersion,
            packageId,
            processName: result.details?.processName || packageId,
            deploymentResults: deployResults,
            ideaId,
          });
          if (storeResult.success) {
            storePublishLine = `\nPublished to Automation Store (ID: ${storeResult.storeId})`;
            sendEvent({ deployStatus: `Published to Automation Store` });
          } else {
            console.log(`[Automation Store] Auto-publish skipped: ${storeResult.message}`);
          }
        } catch (storeErr: any) {
          console.log(`[Automation Store] Auto-publish error: ${storeErr.message}`);
        }
      } else {
        console.log(`[Automation Store] Skipping auto-publish — deployment not fully successful`);
      }

      const processLine = processResult.success
        ? `Process "${result.details?.processName}" created — ready to run.`
        : "";

      const artifactErrorLine = result.details?.artifactError
        ? `\n\n⚠️ Artifact deployment error: ${result.details.artifactError}`
        : "";

      const chatContent = deployReportData
        ? `Package deployed to UiPath Orchestrator.\n\n**${packageId}** v${packageVersion}\n${processLine}${storePublishLine}${artifactErrorLine}\n\n[DEPLOY_REPORT:${JSON.stringify(deployReportData)}]`
        : `Package deployed to UiPath Orchestrator.\n\n**${packageId}** v${packageVersion}\n${processLine}${storePublishLine}${artifactErrorLine}`;

      if (!clientDisconnected) {
        await chatStorage.createMessage(ideaId, "assistant", chatContent);
      }

      sendEvent({ deployComplete: true, success: true, result, deployReport: deployReportData });
      clearInterval(heartbeat);
      return res.end();
    } catch (err: any) {
      console.error("[UiPath Push] Error:", err.message);
      sendEvent({ deployComplete: true, success: false, error: err.message });
      clearInterval(heartbeat);
      return res.end();
    }
  });

  app.get("/api/admin/uipath-diagnostic", (req: Request, res: Response) => {
    res.redirect(307, "/api/uipath/diagnostics");
  });

  app.get("/api/admin/uipath-diagnostic-deep", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const config = await getUiPathConfig();
    if (!config) return res.json({ error: "UiPath not configured" });

    const ts = Date.now();
    const results: Record<string, any> = { timestamp: new Date().toISOString(), config: { orgName: config.orgName, tenantName: config.tenantName, folderId: config.folderId, folderName: config.folderName } };

    async function safeCall(label: string, url: string, opts: RequestInit = {}): Promise<{ status: number; text: string; data: any; ok: boolean; headers?: Record<string, string> }> {
      try {
        const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e: any) { /* Non-JSON response body — use raw text */ }
        return { status: r.status, text: text.slice(0, 2000), data, ok: r.ok };
      } catch (e: any) {
        return { status: 0, text: e.message, data: null, ok: false };
      }
    }

    try {
      const token = await getAccessToken(config);
      const base = metadataService.getServiceUrl("OR", config);
      const hdrs: Record<string, string> = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
      if (config.folderId) hdrs["X-UIPATH-OrganizationUnitId"] = config.folderId;
      results.tokenAcquired = true;

      // ── QUEUES ──
      {
        const ent = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["QueueDefinitions"];
        const sec: any = { artifact: "Queue", steps: [] };
        const list = await safeCall("list", `${base}${ent.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "list", url: `${base}${ent.listPath}`, method: "GET", ...list });
        const body = { Name: `CB_Diag_Queue_${ts}`, Description: "CannonBall diagnostic test", MaxNumberOfRetries: 1, EnforceUniqueReference: false };
        const create = await safeCall("create", `${base}${ent.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
        sec.steps.push({ step: "create", url: `${base}${ent.createPath}`, method: "POST", requestBody: body, ...create });
        sec.overallStatus = create.ok ? "working" : `failed (${create.status})`;
        if (create.ok && create.data?.Id) {
          const del = await safeCall("cleanup", `${base}${ent.createPath}(${create.data.Id})`, { method: "DELETE", headers: hdrs });
          sec.steps.push({ step: "cleanup", method: "DELETE", ...del });
        }
        results.queues = sec;
      }

      // ── ASSETS ──
      {
        const ent = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["Assets"];
        const sec: any = { artifact: "Asset", steps: [] };
        const list = await safeCall("list", `${base}${ent.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "list", url: `${base}${ent.listPath}`, method: "GET", ...list });
        const body = { Name: `CB_Diag_Asset_${ts}`, ValueType: "Text", StringValue: "diag_value", Description: "CannonBall diagnostic" };
        const create = await safeCall("create", `${base}${ent.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
        sec.steps.push({ step: "create", url: `${base}${ent.createPath}`, method: "POST", requestBody: body, ...create });
        sec.overallStatus = create.ok ? "working" : `failed (${create.status})`;
        if (create.ok && create.data?.Id) {
          const del = await safeCall("cleanup", `${base}${ent.createPath}(${create.data.Id})`, { method: "DELETE", headers: hdrs });
          sec.steps.push({ step: "cleanup", method: "DELETE", ...del });
        }
        results.assets = sec;
      }

      // ── MACHINES ──
      {
        const ent = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["Machines"];
        const sec: any = { artifact: "Machine", steps: [] };
        const list = await safeCall("list", `${base}${ent.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "list", url: `${base}${ent.listPath}`, method: "GET", ...list });
        const body = { Name: `CB_Diag_Machine_${ts}`, Type: "Standard", Description: "CannonBall diagnostic" };
        const create = await safeCall("create", `${base}${ent.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
        sec.steps.push({ step: "create", url: `${base}${ent.createPath}`, method: "POST", requestBody: body, ...create });
        if (!create.ok) {
          const bodyTpl = { Name: `CB_Diag_MachineTpl_${ts}`, Description: "CannonBall diagnostic", NonProductionSlots: 0, UnattendedSlots: 1 };
          const createTpl = await safeCall("create_template", `${base}${ent.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(bodyTpl) });
          sec.steps.push({ step: "create_template", requestBody: bodyTpl, ...createTpl });
          sec.overallStatus = createTpl.ok ? "working (template)" : `failed (${create.status}, template ${createTpl.status})`;
        } else {
          sec.overallStatus = "working";
        }
        results.machines = sec;
      }

      // ── STORAGE BUCKETS ──
      {
        const ent = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["Buckets"];
        const sec: any = { artifact: "StorageBucket", steps: [] };
        const list = await safeCall("list", `${base}${ent.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "list", url: `${base}${ent.listPath}`, method: "GET", ...list });

        const diagUuid = () => {
          const h = "0123456789abcdef";
          let u = "";
          for (let i = 0; i < 36; i++) {
            if (i === 8 || i === 13 || i === 18 || i === 23) u += "-";
            else if (i === 14) u += "4";
            else u += h[Math.floor(Math.random() * 16)];
          }
          return u;
        }
        const bucketVariants = [
          { Name: `CB_Diag_Bucket_${ts}`, Identifier: diagUuid(), Description: "CannonBall diagnostic", StorageProvider: "Orchestrator" },
          { Name: `CB_Diag_Bucket2_${ts}`, Identifier: diagUuid(), Description: "CannonBall diagnostic" },
        ];
        let bucketCreated = false;
        for (const body of bucketVariants) {
          const provLabel = (body as any).StorageProvider || "none";
          const create = await safeCall(`create_${provLabel}`, `${base}${ent.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
          sec.steps.push({ step: `create_${provLabel}`, url: `${base}${ent.createPath}`, method: "POST", requestBody: body, ...create });
          if (create.ok) {
            sec.overallStatus = `working (StorageProvider=${provLabel})`;
            bucketCreated = true;
            if (create.data?.Id) {
              await safeCall("cleanup", `${base}${ent.createPath}(${create.data.Id})`, { method: "DELETE", headers: hdrs });
            }
            break;
          }
        }
        if (!bucketCreated) sec.overallStatus = `failed (all variants)`;
        results.storageBuckets = sec;
      }

      // ── ENVIRONMENTS ──
      {
        const sec: any = { artifact: "Environment", steps: [] };
        const envEnt = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["Environments"];
        const list = await safeCall("list", `${base}${envEnt.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "list", url: `${base}${envEnt.listPath}`, method: "GET", ...list });
        const body = { Name: `CB_Diag_Env_${ts}`, Description: "CannonBall diagnostic", Type: "Dev" };
        const create = await safeCall("create", `${base}${envEnt.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
        sec.steps.push({ step: "create", url: `${base}${envEnt.createPath}`, method: "POST", requestBody: body, ...create });
        sec.overallStatus = create.ok ? "working" : `failed (${create.status})`;
        results.environments = sec;
      }

      // ── TRIGGERS (probe only, needs process) ──
      {
        const sec: any = { artifact: "Trigger", steps: [] };
        const trigTaxEntry = metadataService.getCapabilityTaxonomyEntry("triggers");
        const trigDiagPath = trigTaxEntry?.secondaryProbePaths?.[0] ?? "";
        const trigListPath = trigDiagPath.includes("$top") ? trigDiagPath : `${trigDiagPath}?$top=3`;
        const list = await safeCall("list", `${base}${trigListPath}`, { headers: hdrs });
        sec.steps.push({ step: "list", url: `${base}${trigListPath}`, method: "GET", ...list });
        sec.overallStatus = list.ok ? "endpoint available (creation needs process)" : `endpoint unavailable (${list.status})`;
        results.triggers = sec;
      }

      // ── USERS / ROBOT ACCOUNTS ──
      {
        const sec: any = { artifact: "RobotAccount", steps: [] };
        const userEnt = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["Users"];
        const listUsers = await safeCall("list_users", `${base}${userEnt.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "list_users", url: `${base}${userEnt.listPath}`, method: "GET", ...listUsers });

        let pmToken: string | null = null;
        try {
          const { getPmToken } = await import("./uipath-auth");
          pmToken = await getPmToken();
          sec.steps.push({ step: "pm_token", ok: true, status: 200, note: "PM token acquired via centralized auth" });
        } catch (pmErr: any) {
          sec.steps.push({ step: "pm_token", ok: false, status: 0, note: `PM token failed: ${pmErr.message}` });
        }

        if (pmToken) {
          const pmHdrs = { "Authorization": `Bearer ${pmToken}`, "Content-Type": "application/json" };
          const identityGlobal = metadataService.getServiceUrl("IDENTITY", config);
          const identityTenantScoped = `${metadataService.getCloudBaseUrl(config)}/identity_`;
          const identityUrls = [
            `${identityTenantScoped}/api/RobotAccount`,
            `${identityGlobal}/api/RobotAccount`,
          ];
          const robotBody = { name: `CB_Diag_Robot_${ts}`, displayName: `CB_Diag_Robot_${ts}`, domain: "UiPath" };
          let robotCreated = false;
          let robotId: any = null;
          for (const idUrl of identityUrls) {
            const create = await safeCall("create_robot", idUrl, { method: "POST", headers: pmHdrs, body: JSON.stringify(robotBody) });
            sec.steps.push({ step: "create_robot", url: idUrl, method: "POST", requestBody: robotBody, ...create });
            const isHtml = create.text.trimStart().startsWith("<!") || create.text.trimStart().startsWith("<html");
            if (isHtml) {
              sec.steps[sec.steps.length - 1].note = "Response is HTML (web page, not API)";
              continue;
            }
            if (create.ok && create.data) {
              robotCreated = true;
              robotId = create.data?.id || create.data?.Id;
              if (robotId && config.folderId) {
                const assignBody = { assignments: { UserIds: [robotId], RolesPerFolder: [{ FolderId: parseInt(config.folderId, 10), Roles: [{ Name: "Executor" }] }] } };
                const folderEnt = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["Folders"];
                const assign = await safeCall("assign_folder", `${base}${folderEnt.assignPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(assignBody) });
                sec.steps.push({ step: "assign_folder", requestBody: assignBody, ...assign });
              }
              break;
            }
          }
          if (!robotCreated) {
            const odataBody = { UserName: `CB_Diag_Robot_OData_${ts}`, Name: "CB_Diag", Surname: "Robot", RolesList: ["Robot"], Type: "Robot" };
            const odataCreate = await safeCall("create_via_odata", `${base}${userEnt.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(odataBody) });
            sec.steps.push({ step: "create_via_odata_with_pm", url: `${base}${userEnt.createPath}`, requestBody: odataBody, ...odataCreate });
            if (odataCreate.ok) {
              robotCreated = true;
              robotId = odataCreate.data?.Id || odataCreate.data?.id;
            }
          }
          sec.overallStatus = robotCreated ? "working" : "pm_token_ok_but_all_approaches_failed";
        } else {
          const odataBody = { UserName: `CB_Diag_Robot_${ts}`, Name: "CB_Diag", Surname: "Robot", RolesList: ["Robot"], Type: "Robot" };
          const odataCreate = await safeCall("create_via_odata", `${base}${userEnt.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(odataBody) });
          sec.steps.push({ step: "create_via_odata", url: `${base}${userEnt.createPath}`, requestBody: odataBody, ...odataCreate });
          sec.overallStatus = odataCreate.ok ? "working (odata fallback)" : `no_pm_token_and_odata_failed (${odataCreate.status})`;
        }
        results.robotAccounts = sec;
      }

      // ── ACTION CENTER ──
      {
        const tcEnt = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["TaskCatalogs"];
        const gtEnt = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["GenericTasks"];
        const sec: any = { artifact: "ActionCenter", steps: [] };
        const probeCatalogs = await safeCall("probe_catalogs", `${base}${tcEnt.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "probe_catalogs", url: `${base}${tcEnt.listPath}`, ...probeCatalogs });

        const catalogBody = { Name: `CB_Diag_Catalog_${ts}`, Description: "CannonBall diagnostic" };

        let acCreated = false;

        if (probeCatalogs.ok) {
          const create = await safeCall("create_catalog", `${base}${tcEnt.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(catalogBody) });
          sec.steps.push({ step: "create_catalog", url: `${base}${tcEnt.createPath}`, requestBody: catalogBody, ...create });
          if (create.ok || create.status === 201) {
            acCreated = true;
            sec.overallStatus = "working";
            if (create.data?.Id) {
              await safeCall("cleanup", `${base}${tcEnt.createPath}(${create.data.Id})`, { method: "DELETE", headers: hdrs });
            }
          }
        }

        if (!acCreated) {
          const genericEndpoints = [
            { url: `${base}${gtEnt.createPath}`, body: { Title: `CB_Diag_Task_${ts}`, Priority: "Medium", TaskCatalogName: `CB_Diag_Catalog_${ts}`, Type: "ExternalTask" }, label: "create_generic_external" },
            { url: `${base}${gtEnt.createPath}`, body: { Title: `CB_Diag_Task2_${ts}`, Priority: "Medium", TaskCatalogName: `CB_Diag_Catalog2_${ts}`, Type: "ExternalAction" }, label: "create_generic_externalaction" },
            { url: `${base}${gtEnt.createPath}`, body: { Title: `CB_Diag_Task3_${ts}`, Priority: "Medium", TaskCatalogName: `CB_Diag_Catalog3_${ts}`, TaskType: "ExternalAction" }, label: "create_generic_tasktype" },
            { url: `${base}${gtEnt.createPath}`, body: { Title: `CB_Diag_Task4_${ts}`, Priority: "Medium", TaskCatalogName: `CB_Diag_Catalog4_${ts}` }, label: "create_generic_notype" },
          ];
          for (const ep of genericEndpoints) {
            const result = await safeCall(ep.label, ep.url, { method: "POST", headers: hdrs, body: JSON.stringify(ep.body) });
            sec.steps.push({ step: ep.label, url: ep.url, requestBody: ep.body, ...result });
            if (result.ok || result.status === 201) {
              acCreated = true;
              sec.overallStatus = `working (${ep.label})`;
              const checkResult = await safeCall("verify_catalog", `${base}${tcEnt.listPath.replace("$top=1", "$top=5")}`, { headers: hdrs });
              sec.steps.push({ step: "verify_catalog_after_task", ...checkResult });
              break;
            }
          }
        }

        // ── Cloud AC Service Probe ──
        if (!acCreated) {
          const cloudBase = metadataService.getCloudBaseUrl(config);
          const cloudAcUrl = `${cloudBase}/actions_/api/v1/task-catalogs`;
          const cloudAcGet = await safeCall("cloud_ac_get", cloudAcUrl, { headers: hdrs });
          sec.steps.push({ step: "cloud_ac_get", url: cloudAcUrl, method: "GET", ...cloudAcGet });

          const cloudAcBody = { name: `CB_Diag_Catalog_CloudAC_${ts}`, description: "CannonBall diagnostic (Cloud AC)" };
          const cloudAcPost = await safeCall("cloud_ac_post", cloudAcUrl, { method: "POST", headers: hdrs, body: JSON.stringify(cloudAcBody) });
          sec.steps.push({ step: "cloud_ac_post", url: cloudAcUrl, method: "POST", requestBody: cloudAcBody, ...cloudAcPost });

          if (cloudAcPost.ok || cloudAcPost.status === 201) {
            acCreated = true;
            sec.overallStatus = "working (cloud_ac_service)";
            const createdId = cloudAcPost.data?.Id || cloudAcPost.data?.id;
            if (createdId) {
              const cleanup = await safeCall("cloud_ac_cleanup", `${cloudAcUrl}/${createdId}`, { method: "DELETE", headers: hdrs });
              sec.steps.push({ step: "cloud_ac_cleanup", url: `${cloudAcUrl}/${createdId}`, method: "DELETE", ...cleanup });
            } else {
              sec.steps.push({ step: "cloud_ac_cleanup", ok: false, note: "Creation succeeded but no ID found in response for cleanup" });
            }
          }
        }

        // ── Maestro Task Catalog Probe ──
        if (!acCreated) {
          const cloudBase = metadataService.getCloudBaseUrl(config);
          const maestroUrl = `${cloudBase}/maestro_/api/v1/task-catalogs`;

          let pimsTokenOk = false;
          let maestroHdrs = hdrs;
          try {
            const { tryAcquireResourceToken, getMaestroToken } = await import("./uipath-auth");
            const pimsResult = await tryAcquireResourceToken("PIMS").catch(() => ({ ok: false, scopes: [] as string[], error: "Token request failed" }));
            sec.steps.push({ step: "pims_token_acquisition", ok: pimsResult.ok, scopes: pimsResult.scopes, error: (pimsResult as any).error || null });
            if (pimsResult.ok) {
              const pimsToken = await getMaestroToken();
              maestroHdrs = { "Authorization": `Bearer ${pimsToken}`, "Content-Type": "application/json" };
              if (config.folderId) maestroHdrs["X-UIPATH-OrganizationUnitId"] = config.folderId;
              pimsTokenOk = true;
            }
          } catch (pimsErr: any) {
            sec.steps.push({ step: "pims_token_acquisition", ok: false, error: pimsErr.message });
          }

          const maestroGet = await safeCall("maestro_get", maestroUrl, { headers: maestroHdrs });
          sec.steps.push({ step: "maestro_get", url: maestroUrl, method: "GET", pimsToken: pimsTokenOk, ...maestroGet });

          const maestroBody = { name: `CB_Diag_Catalog_Maestro_${ts}`, description: "CannonBall diagnostic (Maestro)" };
          const maestroPost = await safeCall("maestro_post", maestroUrl, { method: "POST", headers: maestroHdrs, body: JSON.stringify(maestroBody) });
          sec.steps.push({ step: "maestro_post", url: maestroUrl, method: "POST", pimsToken: pimsTokenOk, requestBody: maestroBody, ...maestroPost });

          if (maestroPost.ok || maestroPost.status === 201) {
            acCreated = true;
            sec.overallStatus = "working (maestro)";
            const createdId = maestroPost.data?.Id || maestroPost.data?.id;
            if (createdId) {
              const cleanup = await safeCall("maestro_cleanup", `${maestroUrl}/${createdId}`, { method: "DELETE", headers: maestroHdrs });
              sec.steps.push({ step: "maestro_cleanup", url: `${maestroUrl}/${createdId}`, method: "DELETE", ...cleanup });
            } else {
              sec.steps.push({ step: "maestro_cleanup", ok: false, note: "Creation succeeded but no ID found in response for cleanup" });
            }
          }
        }

        if (!acCreated) {
          sec.overallStatus = `all_approaches_failed`;
        }

        // ── Summary of all endpoints tried ──
        const endpointSummary = sec.steps
          .filter((s: any) => s.url)
          .map((s: any) => ({ step: s.step, url: s.url, method: s.method || "GET", status: s.status, ok: s.ok }));
        sec.steps.push({ step: "endpoint_summary", endpoints: endpointSummary, overallStatus: sec.overallStatus });

        results.actionCenter = sec;
      }

      // ── TEST DATA QUEUES ──
      {
        const sec: any = { artifact: "TestDataQueue", steps: [] };
        const tdqEnt = ORCHESTRATOR_DIAGNOSTIC_ENTITIES["TestDataQueues"];
        const list = await safeCall("list", `${base}${tdqEnt.listPath}`, { headers: hdrs });
        sec.steps.push({ step: "list", url: `${base}${tdqEnt.listPath}`, method: "GET", ...list });

        const defaultSchema = JSON.stringify({ type: "object", properties: { TestInput: { type: "string" }, ExpectedOutput: { type: "string" } } });
        const tdqVariants = [
          { Name: `CB_Diag_TDQ_${ts}`, Description: "CannonBall diagnostic", ContentJsonSchema: defaultSchema },
          { Name: `CB_Diag_TDQ2_${ts}`, Description: "CannonBall diagnostic" },
        ];
        let tdqCreated = false;
        for (const body of tdqVariants) {
          const label = (body as any).ContentJsonSchema ? "with_schema" : "no_schema";
          const create = await safeCall(`create_${label}`, `${base}${tdqEnt.createPath}`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
          sec.steps.push({ step: `create_${label}`, requestBody: body, ...create });
          if (create.ok) {
            sec.overallStatus = `working (${label})`;
            tdqCreated = true;
            break;
          }
        }
        if (!tdqCreated) sec.overallStatus = `failed (all variants)`;
        results.testDataQueues = sec;
      }

      // ── DOCUMENT UNDERSTANDING ──
      {
        const sec: any = { artifact: "DocumentUnderstanding", steps: [] };
        const duAlternates = metadataService.getServiceUrlAlternates("DU", config);
        const duBases = duAlternates.map(u => `${u}/api/framework/projects`);
        for (const duUrl of duBases) {
          const probe = await safeCall("probe", `${duUrl}?$top=1`, { headers: hdrs });
          sec.steps.push({ step: "probe", url: duUrl, ...probe });
          if (probe.ok) {
            sec.overallStatus = "available";
            const resolvedDuBase = duAlternates[duBases.indexOf(duUrl)];
            if (resolvedDuBase) metadataService.setResolvedServiceUrl("DU", resolvedDuBase);
            break;
          }
        }
        if (!sec.overallStatus) sec.overallStatus = "not_available";
        results.documentUnderstanding = sec;
      }

      // ── TEST MANAGER ──
      {
        const sec: any = { artifact: "TestManager", steps: [] };
        let tmToken: string | null = null;
        const tmScopes = metadataService.getScopesForServiceString("TM");
        try {
          const tmParams = new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret, scope: tmScopes });
          const tmRes = await safeCall("tm_token", metadataService.getTokenEndpoint(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: tmParams.toString() });
          sec.steps.push({ step: "tm_token", scopesRequested: tmScopes, scopesGranted: tmRes.data?.scope || null, ...tmRes });
          if (tmRes.ok && tmRes.data?.access_token) tmToken = tmRes.data.access_token;
        } catch (e: any) { console.warn(`[Diagnostics] TM token acquisition failed: ${e.message}`); }

        if (!tmToken) {
          sec.overallStatus = "no_tm_token";
          results.testManager = sec;
        } else {
          const tmHdrs: Record<string, string> = { "Authorization": `Bearer ${tmToken}`, "Content-Type": "application/json", "Accept": "application/json" };
          const tmBases = metadataService.getServiceUrlAlternates("TM", config);

          let activeTmBase: string | null = null;
          for (const tmBase of tmBases) {
            const probe = await safeCall("probe", `${tmBase}/api/v2/Projects?$top=10`, { headers: tmHdrs, redirect: "manual" });
            sec.steps.push({ step: "probe", url: `${tmBase}/api/v2/Projects?$top=10`, ...probe });
            if (probe.ok && !probe.text.startsWith("<")) {
              activeTmBase = tmBase;
              metadataService.setResolvedServiceUrl("TM", tmBase);
              break;
            }
          }

          if (!activeTmBase) {
            sec.overallStatus = "no_active_base_url";
            results.testManager = sec;
          } else {
            let projectId: number | null = null;
            let projectPrefix: string | null = null;

            const listProj = await safeCall("list_projects", `${activeTmBase}/api/v2/Projects?$top=50`, { headers: tmHdrs });
            sec.steps.push({ step: "list_projects", url: `${activeTmBase}/api/v2/Projects?$top=50`, ...listProj });

            if (listProj.ok) {
              const projects = listProj.data?.data || listProj.data?.value || (Array.isArray(listProj.data) ? listProj.data : []);
              sec.projectsFound = projects.length;
              sec.projectFields = projects.length > 0 ? Object.keys(projects[0]) : [];
              sec.firstProject = projects.length > 0 ? projects[0] : null;
              if (projects.length > 0) {
                projectId = projects[0].id || projects[0].Id;
                projectPrefix = projects[0].prefix || projects[0].Prefix || projects[0].projectPrefix || projects[0].ProjectPrefix;
              }
            }

            if (!projectId) {
              const projBody = { name: `CB_Diag_Project_${ts}`, prefix: "CBDIAG", description: "CannonBall diagnostic" };
              const createProj = await safeCall("create_project", `${activeTmBase}/api/v2/Projects`, { method: "POST", headers: tmHdrs, body: JSON.stringify(projBody) });
              sec.steps.push({ step: "create_project", requestBody: projBody, ...createProj });
              if (createProj.ok && createProj.data) {
                projectId = createProj.data.id || createProj.data.Id;
                projectPrefix = createProj.data.prefix || createProj.data.Prefix;
                sec.createdProject = createProj.data;
              }
            }

            if (!projectId) {
              sec.overallStatus = "no_project_id";
              results.testManager = sec;
            } else {
              sec.usingProjectId = projectId;
              sec.usingProjectPrefix = projectPrefix;

              const verifyProj = await safeCall("verify_project", `${activeTmBase}/api/v2/Projects/${projectId}`, { headers: tmHdrs });
              sec.steps.push({ step: "verify_project", url: `${activeTmBase}/api/v2/Projects/${projectId}`, ...verifyProj });

              // Test case creation — try multiple approaches
              const tcApproaches = [
                { label: "v2_lowercase", url: `${activeTmBase}/api/v2/Projects/${projectId}/TestCases`, body: { name: `CB_Diag_TC_${ts}`, description: "Diagnostic test case" } },
                { label: "v2_uppercase", url: `${activeTmBase}/api/v2/Projects/${projectId}/TestCases`, body: { Name: `CB_Diag_TC_Upper_${ts}`, Description: "Diagnostic test case (uppercase)" } },
                { label: "v2_with_labels", url: `${activeTmBase}/api/v2/Projects/${projectId}/TestCases`, body: { name: `CB_Diag_TC_Labels_${ts}`, description: "With labels", labels: ["Diagnostic"], manualSteps: [{ stepDescription: "Test step", expectedResult: "Pass", order: 1 }] } },
                { label: "v1_lowercase", url: `${activeTmBase}/api/v1/Projects/${projectId}/TestCases`, body: { name: `CB_Diag_TC_V1_${ts}`, description: "V1 test" } },
                { label: "v2_testcases_direct", url: `${activeTmBase}/api/v2/TestCases`, body: { name: `CB_Diag_TC_Direct_${ts}`, description: "Direct endpoint", projectId: projectId } },
              ];

              for (const approach of tcApproaches) {
                const create = await safeCall(`create_tc_${approach.label}`, approach.url, { method: "POST", headers: tmHdrs, body: JSON.stringify(approach.body) });
                sec.steps.push({ step: `create_tc_${approach.label}`, url: approach.url, method: "POST", requestBody: approach.body, ...create });
                if (create.ok) {
                  sec.testCaseWorking = approach.label;
                  break;
                }
              }

              const listTc = await safeCall("list_testcases", `${activeTmBase}/api/v2/Projects/${projectId}/TestCases?$top=10`, { headers: tmHdrs });
              sec.steps.push({ step: "list_testcases", url: `${activeTmBase}/api/v2/Projects/${projectId}/TestCases?$top=10`, ...listTc });

              // Test sets
              const tsApproaches = [
                { label: "v2_testsets", url: `${activeTmBase}/api/v2/Projects/${projectId}/TestSets`, body: { name: `CB_Diag_TS_${ts}`, description: "Diagnostic test set" } },
                { label: "v1_testsets", url: `${activeTmBase}/api/v1/Projects/${projectId}/TestSets`, body: { name: `CB_Diag_TS_V1_${ts}`, description: "V1 test set" } },
              ];
              for (const approach of tsApproaches) {
                const create = await safeCall(`create_ts_${approach.label}`, approach.url, { method: "POST", headers: tmHdrs, body: JSON.stringify(approach.body) });
                sec.steps.push({ step: `create_ts_${approach.label}`, url: approach.url, requestBody: approach.body, ...create });
                if (create.ok) { sec.testSetWorking = approach.label; break; }
              }

              // Requirements
              const reqApproaches = [
                { label: "v2_requirements", url: `${activeTmBase}/api/v2/Projects/${projectId}/Requirements`, body: { name: `CB_Diag_Req_${ts}`, description: "Diagnostic requirement" } },
              ];
              for (const approach of reqApproaches) {
                const create = await safeCall(`create_req_${approach.label}`, approach.url, { method: "POST", headers: tmHdrs, body: JSON.stringify(approach.body) });
                sec.steps.push({ step: `create_req_${approach.label}`, url: approach.url, requestBody: approach.body, ...create });
                if (create.ok) { sec.requirementWorking = approach.label; break; }
              }

              sec.overallStatus = sec.testCaseWorking ? `working (${sec.testCaseWorking})` : "test_case_creation_failed";
              results.testManager = sec;
            }
          }
        }
      }

      results.summary = {
        queues: results.queues?.overallStatus,
        assets: results.assets?.overallStatus,
        machines: results.machines?.overallStatus,
        storageBuckets: results.storageBuckets?.overallStatus,
        environments: results.environments?.overallStatus,
        triggers: results.triggers?.overallStatus,
        robotAccounts: results.robotAccounts?.overallStatus,
        actionCenter: results.actionCenter?.overallStatus,
        testDataQueues: results.testDataQueues?.overallStatus,
        documentUnderstanding: results.documentUnderstanding?.overallStatus,
        testManager: results.testManager?.overallStatus,
      };

    } catch (e: any) {
      results.error = e.message;
    }

    return res.json(results);
  });

  app.get("/api/uipath/health", async (_req: Request, res: Response) => {
    try {
      const healthResult = await auth.healthCheck();

      let robotCount = 0;
      let pendingTasks = 0;
      if (healthResult.ok) {
        try {
          const robots = await orch.getRobots();
          robotCount = robots.length;
        } catch (e: any) { console.warn(`[UiPath Health] Failed to count robots: ${e.message}`); }
        try {
          const tasks = await orch.getTasks("Pending");
          pendingTasks = tasks.length;
        } catch (e: any) { console.warn(`[UiPath Health] Failed to count pending tasks: ${e.message}`); }
      }

      return res.json({
        ...healthResult,
        robotCount,
        pendingTasks,
      });
    } catch (err: any) {
      return res.json({
        ok: false,
        message: err.message,
        latencyMs: 0,
        robotCount: 0,
        pendingTasks: 0,
      });
    }
  });

  app.get("/api/uipath/live-ops", async (_req: Request, res: Response) => {
    try {
      const config = await auth.getConfig();
      if (!config) {
        return res.json({
          connected: false,
          message: "UiPath is not configured",
        });
      }

      const healthResult = await auth.healthCheck();

      if (!healthResult.ok) {
        return res.json({
          connected: false,
          message: healthResult.message,
          latencyMs: healthResult.latencyMs,
        });
      }

      const [jobs, tasks, folderStats] = await Promise.all([
        orch.getJobs(undefined, "Running").catch(() => []),
        orch.getTasks("Pending").catch(() => []),
        orch.getFolderStats().catch(() => null),
      ]);

      const lastProvision = await db
        .select()
        .from(provisioningLog)
        .orderBy(desc(provisioningLog.executedAt))
        .limit(1);

      return res.json({
        connected: true,
        latencyMs: healthResult.latencyMs,
        tenantName: config.tenantName,
        folderName: config.folderName,
        activeJobs: jobs.length,
        pendingTasks: tasks.length,
        processCount: folderStats?.processCount || 0,
        machineCount: folderStats?.machineCount || 0,
        robotCount: folderStats?.robotCount || 0,
        queueCount: folderStats?.queueCount || 0,
        lastProvisioningDecision: lastProvision[0] || null,
      });
    } catch (err: any) {
      return res.json({
        connected: false,
        message: err.message,
        latencyMs: 0,
      });
    }
  });

  app.get("/api/uipath/diagnostics", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    try {
      const config = await auth.getConfig();
      if (!config) {
        return res.json({
          configured: false,
          checks: [{ name: "Configuration", status: "blocking", detail: "UiPath is not configured", remediation: "Set up UiPath credentials in Admin > Integrations." }],
        });
      }

      const healthResult = await auth.healthCheck();
      const checks: Array<{ name: string; status: string; detail: string; remediation?: string }> = [];

      checks.push({
        name: "Authentication",
        status: healthResult.ok ? "pass" : "blocking",
        detail: healthResult.ok
          ? `Token valid, latency ${healthResult.latencyMs}ms`
          : `Auth failed: ${healthResult.message}`,
        remediation: healthResult.ok ? undefined : "Check client ID, client secret, and scopes in Admin > Integrations.",
      });

      if (healthResult.ok) {
        try {
          const folderStats = await orch.getFolderStats();
          checks.push({
            name: "Folder accessible",
            status: "pass",
            detail: `${folderStats.folderName} (${folderStats.processCount} processes, ${folderStats.queueCount} queues)`,
          });
        } catch (err: any) {
          checks.push({
            name: "Folder accessible",
            status: "blocking",
            detail: `Folder access failed: ${err.message}`,
            remediation: "Ensure External App has access to the target folder.",
          });
        }

        try {
          const processes = await orch.getProcesses();
          checks.push({
            name: "Package feed writable",
            status: "pass",
            detail: `${processes.length} process(es) visible`,
          });
        } catch (e: any) {
          checks.push({
            name: "Package feed writable",
            status: "warning",
            detail: "Could not verify package feed access",
          });
        }

        try {
          const machines = await orch.getMachines();
          checks.push({
            name: "Machines available",
            status: machines.length > 0 ? "pass" : "warning",
            detail: machines.length > 0
              ? `${machines.length} machine(s) registered`
              : "No machines registered",
            remediation: machines.length === 0 ? "Register machines in Orchestrator > Machines." : undefined,
          });
        } catch (e: any) {
          checks.push({ name: "Machines available", status: "warning", detail: "Could not check machines" });
        }

        try {
          const robots = await orch.getRobots();
          checks.push({
            name: "Robots available",
            status: robots.length > 0 ? "pass" : "warning",
            detail: robots.length > 0
              ? `${robots.length} robot(s) available`
              : "No robots found",
            remediation: robots.length === 0 ? "Ensure Unattended robots are configured in Orchestrator." : undefined,
          });
        } catch (e: any) {
          checks.push({ name: "Robots available", status: "warning", detail: "Could not check robots" });
        }

        try {
          const catalogs = await orch.getActionCatalog();
          checks.push({
            name: "Action Center reachable",
            status: "pass",
            detail: `${catalogs.length} task catalog(s) available`,
          });
        } catch (e: any) {
          checks.push({
            name: "Action Center reachable",
            status: "warning",
            detail: "Action Center not available on this tenant",
            remediation: "Action Center requires a specific license. Exception routing will be disabled.",
          });
        }

        try {
          const testSets = await orch.getTestSets();
          checks.push({
            name: "Test Manager reachable",
            status: "pass",
            detail: `${testSets.length} test set(s) available`,
          });
        } catch (e: any) {
          checks.push({
            name: "Test Manager reachable",
            status: "warning",
            detail: "No license detected on this tenant",
            remediation: "Test Manager is not available. Test gate will be skipped during deployment.",
          });
        }

        try {
          const queues = await orch.getQueues();
          checks.push({
            name: "Queue access",
            status: "pass",
            detail: `${queues.length} queue(s) visible in target folder`,
          });
        } catch (e: any) {
          checks.push({
            name: "Queue access",
            status: "warning",
            detail: "Could not list queues",
          });
        }

        try {
          const { getAICenterSkills } = await import("./uipath-integration");
          const aiResult = await getAICenterSkills();
          if (aiResult.available) {
            const deployed = aiResult.skills.filter(s => s.status.toLowerCase() === "deployed" || s.status.toLowerCase() === "available");
            const skillNames = deployed.map(s => s.name).join(", ");
            checks.push({
              name: "AI Center reachable",
              status: "pass",
              detail: deployed.length > 0
                ? `${deployed.length} deployed ML skill(s): ${skillNames}. ${aiResult.packages.length} ML package(s) available.`
                : `AI Center accessible. ${aiResult.packages.length} ML package(s) found, no skills deployed yet.`,
            });
          } else {
            checks.push({
              name: "AI Center reachable",
              status: "warning",
              detail: "AI Center not available on this tenant",
              remediation: "AI Center enables custom ML models for classification, prediction, NLP, and anomaly detection. Enable it via UiPath Automation Cloud.",
            });
          }
        } catch (e: any) {
          checks.push({
            name: "AI Center reachable",
            status: "warning",
            detail: "Could not probe AI Center",
          });
        }
      }

      let serviceDetails: Record<string, any> | undefined;
      try {
        const { getProbeCache } = await import("./uipath-integration");
        const cached = getProbeCache();
        if (cached) {
          const { probeServiceAvailability } = await import("./uipath-integration");
          const svcAvail = await probeServiceAvailability();
          serviceDetails = svcAvail.serviceDetails;
        }
      } catch (e: any) { console.warn(`[UiPath Diagnostics] Failed to attach service details: ${e.message}`); }

      return res.json({
        configured: true,
        connected: healthResult.ok,
        tenantName: config.tenantName,
        latencyMs: healthResult.latencyMs,
        checks,
        serviceDetails,
      });
    } catch (err: any) {
      return res.json({
        configured: true,
        connected: false,
        checks: [{ name: "Connection", status: "blocking", detail: err.message }],
      });
    }
  });

  app.get("/api/uipath/prerequisites", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const report = await prereqs.checkAll();
      const markdown = prereqs.generatePrerequisiteReport(report);
      return res.json({ ...report, markdown });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/provisioning/:processName/status", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const processName = requiredParam(req.params.processName, "processName");
    try {
      const logs = await db
        .select()
        .from(provisioningLog)
        .where(eq(provisioningLog.processName, processName))
        .orderBy(desc(provisioningLog.executedAt))
        .limit(20);

      let activeJobs: orch.Job[] = [];
      try {
        activeJobs = await orch.getJobs(processName, "Running");
      } catch (e: any) { console.warn(`[UiPath] Failed to fetch active jobs for ${processName}: ${e.message}`); }

      return res.json({
        processName,
        activeJobCount: activeJobs.length,
        activeJobs: activeJobs.map((j) => ({ id: j.Id, state: j.State, startTime: j.StartTime })),
        recentDecisions: logs,
        lastDecision: logs[0] || null,
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/provisioning/:processName/emergency-stop", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const processName = requiredParam(req.params.processName, "processName");
    try {
      const jobs = await orch.getJobs(processName, "Running");
      const stopped: number[] = [];
      const failed: Array<{ id: number; error: string }> = [];

      for (const job of jobs) {
        try {
          await orch.stopJob(job.Id);
          stopped.push(job.Id);
        } catch (err: any) {
          failed.push({ id: job.Id, error: err.message });
        }
      }

      try {
        const triggers = await orch.getTriggers(processName);
        for (const trigger of triggers) {
          if (trigger.Enabled) {
            await orch.disableTrigger(trigger.Id).catch(() => {});
          }
        }
      } catch (e: any) { console.warn(`[UiPath] Emergency stop trigger disable failed: ${e.message}`); }

      await db.insert(provisioningLog).values({
        jobId: `emergency_${Date.now()}`,
        processName,
        decision: "emergency_stop",
        robotsDelta: -(stopped.length),
        reasoning: `Emergency stop: ${stopped.length} jobs stopped, ${failed.length} failed`,
        confidence: 1.0,
      });

      return res.json({
        processName,
        jobsStopped: stopped.length,
        jobsFailed: failed.length,
        stoppedIds: stopped,
        failedDetails: failed,
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/uipath/validate-action-center", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;

    try {
      const config = await auth.getConfig();
      if (!config) {
        return res.status(400).json({ error: "UiPath is not configured" });
      }

      const catalogName = (req.body.catalogName as string) || "BDAY-GenAI-GuardrailReview";
      const { getAccessToken } = await import("./uipath-integration");
      const token = await getAccessToken(config);
      const base = metadataService.getServiceUrl("OR", config);
      const cloudBase = metadataService.getCloudBaseUrl(config);
      const hdrs: Record<string, string> = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" };
      if (config.folderId) hdrs["X-UIPATH-OrganizationUnitId"] = String(config.folderId);

      function redactHeaders(h: Record<string, string>): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(h)) {
          out[k] = k.toLowerCase() === "authorization" ? v.slice(0, 15) + "...[REDACTED]" : v;
        }
        return out;
      }

      async function tryEndpoint(label: string, url: string, body: any, headers: Record<string, string>): Promise<any> {
        const startMs = Date.now();
        try {
          const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
          const text = await r.text();
          let data = null;
          try { data = JSON.parse(text); } catch {}
          const httpOk = r.ok || r.status === 201;
          let bodyValid = httpOk;
          let bodyValidationNote: string | undefined;
          if (httpOk && data) {
            if (data.errorCode || data.ErrorCode || data["odata.error"]) {
              bodyValid = false;
              bodyValidationNote = `Response contains error payload: ${data.errorCode || data.ErrorCode || data["odata.error"]?.code || "unknown"}`;
            } else if (typeof data.message === "string" && (data.message.includes("not onboarded") || data.message.includes("not available"))) {
              bodyValid = false;
              bodyValidationNote = `Service message: ${data.message}`;
            } else if (data.error && typeof data.error === "string") {
              bodyValid = false;
              bodyValidationNote = `Error field: ${data.error}`;
            }
          }
          return {
            label, url, method: "POST",
            requestHeaders: redactHeaders(headers),
            requestBody: body,
            status: r.status, ok: r.ok,
            responseBody: text.slice(0, 1500),
            parsedResponse: data,
            latencyMs: Date.now() - startMs,
            success: httpOk && bodyValid,
            bodyValidationNote,
          };
        } catch (e: any) {
          return {
            label, url, method: "POST",
            requestHeaders: redactHeaders(headers),
            requestBody: body,
            status: 0, ok: false,
            responseBody: e.message,
            parsedResponse: null,
            latencyMs: Date.now() - startMs,
            success: false,
            error: e.message,
          };
        }
      }

      const odataBody = { Name: catalogName, Description: "Validation test catalog" };
      const restBody = { name: catalogName, description: "Validation test catalog" };
      const formTaskBody = {
        task: {
          Title: `Validate_${catalogName}_${Date.now()}`,
          Priority: "Medium",
          TaskCatalogName: catalogName,
          Data: JSON.stringify({ source: "validation" }),
        },
      };

      const attempts: any[] = [];

      attempts.push(await tryEndpoint(
        "OData TaskCatalogs", `${base}/odata/TaskCatalogs`, odataBody, hdrs
      ));

      attempts.push(await tryEndpoint(
        "REST API TaskCatalogs", `${base}/api/TaskCatalogs`, restBody, hdrs
      ));

      const genericTypes = [
        { label: "GenericTasks/CreateTask (ExternalTask)", body: { Title: `Validate_Task_${Date.now()}`, Priority: "Medium", TaskCatalogName: catalogName, Type: "ExternalTask" } },
        { label: "GenericTasks/CreateTask (ExternalAction)", body: { Title: `Validate_Task2_${Date.now()}`, Priority: "Medium", TaskCatalogName: catalogName, Type: "ExternalAction" } },
        { label: "GenericTasks/CreateTask (no Type)", body: { Title: `Validate_Task3_${Date.now()}`, Priority: "Medium", TaskCatalogName: catalogName } },
      ];
      for (const gt of genericTypes) {
        attempts.push(await tryEndpoint(gt.label, `${base}/tasks/GenericTasks/CreateTask`, gt.body, hdrs));
      }

      attempts.push(await tryEndpoint(
        "CreateFormTask OData",
        `${base}/odata/Tasks/UiPath.Server.Configuration.OData.CreateFormTask`,
        formTaskBody,
        hdrs
      ));

      attempts.push(await tryEndpoint(
        "Cloud AC Service", `${cloudBase}/actions_/api/v1/task-catalogs`, restBody, hdrs
      ));

      let maestroHdrs = { ...hdrs };
      let pimsTokenOk = false;
      try {
        const pimsResult = await auth.tryAcquireResourceToken("PIMS").catch(() => ({ ok: false, scopes: [] as string[], error: "Token request failed" }));
        if (pimsResult.ok) {
          const pimsToken = await auth.getMaestroToken();
          maestroHdrs = { "Authorization": `Bearer ${pimsToken}`, "Content-Type": "application/json", "Accept": "application/json" };
          if (config.folderId) maestroHdrs["X-UIPATH-OrganizationUnitId"] = String(config.folderId);
          pimsTokenOk = true;
        }
      } catch {}

      attempts.push(await tryEndpoint(
        "Maestro Service (PIMS token)", `${cloudBase}/maestro_/api/v1/task-catalogs`, restBody,
        pimsTokenOk ? maestroHdrs : hdrs
      ));

      const successful = attempts.filter(a => a.success);
      const failed = attempts.filter(a => !a.success);

      return res.json({
        catalogName,
        pimsTokenAcquired: pimsTokenOk,
        totalAttempts: attempts.length,
        successCount: successful.length,
        failCount: failed.length,
        successfulEndpoints: successful.map(a => ({ label: a.label, url: a.url, status: a.status })),
        failedEndpoints: failed.map(a => ({ label: a.label, url: a.url, status: a.status, error: a.responseBody?.slice(0, 300) })),
        details: attempts,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/action-center/tasks", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const localTasks = await db
        .select()
        .from(actionTasks)
        .orderBy(desc(actionTasks.createdAt))
        .limit(50);

      let orchestratorTasks: orch.ActionTask[] = [];
      try {
        orchestratorTasks = await orch.getTasks();
      } catch (e: any) { console.warn(`[UiPath] Failed to fetch Action Center tasks: ${e.message}`); }

      return res.json({
        localTasks,
        orchestratorTasks: orchestratorTasks.map((t) => ({
          id: t.Id,
          title: t.Title,
          status: t.Status,
          type: t.Type,
          assignee: t.AssignedToUser,
          catalogName: t.CatalogName,
          createdAt: t.CreationTime,
        })),
        pendingCount: orchestratorTasks.filter((t) => t.Status === "Pending" || t.Status === "Unassigned").length,
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/action-center/tasks/:taskId/resolve", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const taskId = parseIntegerParam(req.params.taskId);
    if (isNaN(taskId)) return res.status(400).json({ message: "Invalid task ID" });

    const { action, data, resolvedBy } = req.body;
    if (!action) return res.status(400).json({ message: "action is required" });

    try {
      const result = await orch.completeTask(taskId, action, data);

      const existing = await db
        .select()
        .from(actionTasks)
        .where(eq(actionTasks.orchestratorTaskId, String(taskId)))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(actionTasks)
          .set({
            status: "resolved",
            aiResolved: resolvedBy === "ai",
            resolutionReasoning: `Action: ${action}`,
            resolvedAt: new Date(),
          })
          .where(eq(actionTasks.orchestratorTaskId, String(taskId)));
      } else {
        await db.insert(actionTasks).values({
          orchestratorTaskId: String(taskId),
          status: "resolved",
          aiResolved: resolvedBy === "ai",
          resolutionReasoning: `Action: ${action}`,
          resolvedAt: new Date(),
        });
      }

      return res.json({ success: true, result });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/uipath/integration-service", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const discovery = await discoverIntegrationService();
      return res.json(discovery);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/uipath/integration-service/refresh", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      clearIntegrationServiceCache();
      const discovery = await discoverIntegrationService();
      return res.json(discovery);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/tests/job/:jobId", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const jobId = requiredParam(req.params.jobId, "jobId");
    try {
      const results = await db
        .select()
        .from(testResults)
        .where(eq(testResults.jobId, jobId))
        .orderBy(desc(testResults.executedAt))
        .limit(1);

      if (results.length === 0) {
        return res.status(404).json({ message: "No test results found for this job" });
      }

      return res.json(results[0]);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/settings/automation-hub/status", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { getAutomationHubStatus } = await import("./automation-hub");
      const status = await getAutomationHubStatus();
      return res.json(status);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/settings/automation-hub/token", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { token } = req.body;
      if (!token || !String(token).trim()) {
        return res.status(400).json({ message: "Token is required" });
      }
      const { saveAutomationHubToken, getAutomationHubStatus } = await import("./automation-hub");
      await saveAutomationHubToken(token);
      const status = await getAutomationHubStatus();
      return res.json({ success: true, status });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/settings/automation-hub/token", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { clearAutomationHubToken } = await import("./automation-hub");
      await clearAutomationHubToken();
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/settings/communications-mining/status", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { getCommunicationsMiningStatus } = await import("./uipath-integration");
      const status = await getCommunicationsMiningStatus();
      return res.json(status);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/settings/communications-mining/token", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { token } = req.body;
      if (!token || !String(token).trim()) {
        return res.status(400).json({ message: "Token is required" });
      }
      const { saveCommunicationsMiningToken, getCommunicationsMiningStatus } = await import("./uipath-integration");
      await saveCommunicationsMiningToken(token);
      clearProbeCache(); metadataService.clearReachability();
      const status = await getCommunicationsMiningStatus();
      return res.json({ success: true, status });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.delete("/api/settings/communications-mining/token", async (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    try {
      const { clearCommunicationsMiningToken } = await import("./uipath-integration");
      await clearCommunicationsMiningToken();
      clearProbeCache(); metadataService.clearReachability();
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/automation-hub/ideas", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const limit = Number.parseInt(optionalQuery(req.query.limit) ?? "", 10) || 50;
      const offset = Number.parseInt(optionalQuery(req.query.offset) ?? "", 10) || 0;
      const status = optionalQuery(req.query.status);
      const { listAutomationHubIdeas } = await import("./automation-hub");
      const result = await listAutomationHubIdeas(limit, offset, status);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/automation-hub/ideas/:hubIdeaId", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const hubIdeaId = parseIntegerParam(req.params.hubIdeaId);
      if (isNaN(hubIdeaId)) {
        return res.status(400).json({ message: "Invalid Automation Hub idea ID" });
      }
      const { getAutomationHubIdeaDetails } = await import("./automation-hub");
      const result = await getAutomationHubIdeaDetails(hubIdeaId);
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/automation-hub/import/:hubIdeaId", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const hubIdeaId = parseIntegerParam(req.params.hubIdeaId);
      if (isNaN(hubIdeaId)) {
        return res.status(400).json({ message: "Invalid Automation Hub idea ID" });
      }

      const user = await storage.getUser(req.session.userId as string);
      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      const { getAutomationHubIdeaDetails, formatHubIdeaAsContext } = await import("./automation-hub");
      const hubResult = await getAutomationHubIdeaDetails(hubIdeaId);
      if (!hubResult.success || !hubResult.idea) {
        const msg = hubResult.message || "Hub idea not found";
        const status = msg.includes("not configured") ? 400 : 502;
        return res.status(status).json({ message: msg });
      }

      const hubIdea = hubResult.idea;
      const idea = await storage.createIdea({
        title: hubIdea.name,
        description: hubIdea.description || `Imported from Automation Hub (ID: ${hubIdea.id})`,
        owner: user.displayName,
        ownerEmail: user.email,
        stage: "Idea",
        tag: hubIdea.category || null,
      });

      const contextMessage = formatHubIdeaAsContext(hubIdea);
      await chatStorage.createMessage(
        idea.id,
        "user",
        `I'm importing this automation idea from Automation Hub:\n\n${contextMessage}\n\nPlease analyze this idea and help me develop it into an automation.`
      );

      await storage.createAuditLog({
        ideaId: idea.id,
        userId: user.id,
        userName: user.displayName,
        userRole: req.session.activeRole || user.role,
        action: "automation_hub_import",
        details: `Imported from Automation Hub idea #${hubIdea.id}: ${hubIdea.name}`,
      });

      return res.json({
        success: true,
        idea,
        hubIdea,
        message: `Imported "${hubIdea.name}" from Automation Hub`,
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  });

  app.post("/api/ideas/:ideaId/uipath-runs", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const source = (req.body.source as "chat" | "retry" | "approval" | "auto") || "auto";
    const force = req.body.force === true;

    try {
      const triggerSource: "manual" | "chat" | "api" = source === "chat" ? "chat" : source === "retry" ? "manual" : "api";

      let userMetaValidationMode: "Auto" | "Always" | "Off" = "Auto";
      try {
        const storedMode = await storage.getAppSetting(`meta_validation_mode_${req.session.userId}`);
        if (storedMode === "Always" || storedMode === "Off" || storedMode === "Auto") {
          userMetaValidationMode = storedMode;
        }
      } catch (e: any) { console.warn(`[UiPath] Failed to load meta validation mode: ${e.message}`); }

      const observerRunId = crypto.randomUUID();
      createObserverRun(observerRunId, ideaId, source);

      let runId: string;
      try {
        const result = await startUiPathGenerationRun(ideaId, triggerSource, {
          forceRegenerate: force,
          metaValidationMode: userMetaValidationMode,
          callbacks: {
            onProgress: (message: string) => emitObserverProgress(observerRunId, message),
            onPipelineEvent: (evt) => {
              console.log(`[UiPathRoute] onPipelineEvent callback fired: stage=${evt.stage}, type=${evt.type}, observerRun=${observerRunId}`);
              emitObserverPipelineEvent(observerRunId, evt);
              emitObserverProgress(observerRunId, evt.message);
            },
            onMetaValidation: (event: Record<string, unknown>) => emitObserverMetaValidation(observerRunId, event),
            onComplete: (result) => {
              const pr = result.pipelineResult;
              const buildOutcomeSummary = pr?.outcomeReport ? {
                stubbedActivities: pr.outcomeReport.remediations.filter((r: { level: string }) => r.level === "activity").length,
                stubbedSequences: pr.outcomeReport.remediations.filter((r: { level: string }) => r.level === "sequence").length,
                stubbedWorkflows: pr.outcomeReport.remediations.filter((r: { level: string }) => r.level === "workflow").length,
                autoRepairs: pr.outcomeReport.autoRepairs.length,
                fullyGenerated: pr.outcomeReport.fullyGeneratedFiles.length,
                totalEstimatedMinutes: pr.outcomeReport.totalEstimatedEffortMinutes,
              } : undefined;
              emitObserverDone(observerRunId, {
                status: result.status,
                warnings: pr?.warnings || [],
                templateComplianceScore: pr?.templateComplianceScore,
                completenessLevel: pr?.qualityGateResult?.completenessLevel,
                outcomeSummary: buildOutcomeSummary,
                dependencyMap: pr?.dependencyMap,
              });
            },
            onFail: (error: string) => {
              emitObserverError(observerRunId, error);
            },
          },
        });
        runId = result.runId;
      } catch (startErr: unknown) {
        emitObserverError(observerRunId, startErr instanceof Error ? startErr.message : String(startErr));
        throw startErr;
      }

      return res.json({ runId: observerRunId, dbRunId: runId, status: "BUILDING" });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("already in progress")) {
        return res.status(409).json({ message: errMsg });
      }
      return res.status(500).json({ message: errMsg });
    }
  });

  app.get("/api/ideas/:ideaId/uipath-runs/latest", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const observerRun = getLatestObserverRun(ideaId);
    if (observerRun && !isObserverTerminalStatus(observerRun.status)) {
      return res.json({
        run: {
          runId: observerRun.runId,
          ideaId: observerRun.ideaId,
          status: observerRun.status,
          source: observerRun.source,
          warnings: observerRun.warnings,
          complianceScore: observerRun.complianceScore,
          completenessLevel: observerRun.completenessLevel,
          outcomeSummary: observerRun.outcomeSummary,
          createdAt: observerRun.createdAt,
        },
      });
    }

    const activeRun = getActiveRunForIdea(ideaId);
    const dbRun = await storage.getLatestGenerationRunForIdea(ideaId);
    if (!dbRun) {
      if (observerRun) {
        return res.json({
          run: {
            runId: observerRun.runId,
            ideaId: observerRun.ideaId,
            status: observerRun.status,
            source: observerRun.source,
            warnings: observerRun.warnings,
            complianceScore: observerRun.complianceScore,
            completenessLevel: observerRun.completenessLevel,
            outcomeSummary: observerRun.outcomeSummary,
            dependencyMap: observerRun.dependencyMap,
            createdAt: observerRun.createdAt,
          },
        });
      }
      return res.json({ run: null });
    }

    const isActive = activeRun && !activeRun.completed && activeRun.runId === dbRun.runId;
    let parsedPhaseProgress = null;
    let parsedOutcomeReport = null;
    try { if (dbRun.phaseProgress) parsedPhaseProgress = JSON.parse(dbRun.phaseProgress); } catch (e: any) { /* corrupt phaseProgress JSON */ }
    try { if (dbRun.outcomeReport) parsedOutcomeReport = JSON.parse(dbRun.outcomeReport); } catch (e: any) { /* corrupt outcomeReport JSON */ }

    const statusMap: Record<string, string> = {
      running: "BUILDING",
      completed: "READY",
      completed_with_warnings: "READY_WITH_WARNINGS",
      failed: "FAILED",
      cancelled: "CANCELLED",
    };

    const sourceMap: Record<string, string> = {
      manual: "retry",
      chat: "chat",
      api: "auto",
    };

    return res.json({
      run: {
        ...dbRun,
        status: isActive ? "BUILDING" : (statusMap[dbRun.status] || dbRun.status),
        source: sourceMap[dbRun.triggeredBy || ""] || "auto",
        phaseProgress: parsedPhaseProgress,
        outcomeReport: parsedOutcomeReport,
        isActive: !!isActive,
      },
    });
  });

  app.get("/api/ideas/:ideaId/uipath-runs/:runId", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const runId = requiredParam(req.params.runId, "runId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const observerRun = getObserverRun(runId);
    if (observerRun) {
      return res.json({ run: observerRun });
    }

    const dbRun = await storage.getGenerationRun(runId);
    if (!dbRun || dbRun.ideaId !== ideaId) {
      return res.status(404).json({ message: "Run not found" });
    }

    const activeRun = getActiveRun(runId);
    const isActive = activeRun && !activeRun.completed;

    let parsedPhaseProgress = null;
    let parsedOutcomeReport = null;
    try { if (dbRun.phaseProgress) parsedPhaseProgress = JSON.parse(dbRun.phaseProgress); } catch (e: any) { /* corrupt phaseProgress JSON */ }
    try { if (dbRun.outcomeReport) parsedOutcomeReport = JSON.parse(dbRun.outcomeReport); } catch (e: any) { /* corrupt outcomeReport JSON */ }
    return res.json({
      run: {
        ...dbRun,
        phaseProgress: parsedPhaseProgress,
        outcomeReport: parsedOutcomeReport,
        isActive: !!isActive,
      },
    });
  });

  app.get("/api/ideas/:ideaId/uipath-runs/:runId/progress", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const runId = requiredParam(req.params.runId, "runId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const afterIndex = Number.parseInt(optionalQuery(req.query.afterIndex) ?? "", 10) || 0;
    const result = getObserverRunEvents(runId, afterIndex);

    if (!result) {
      const dbRun = await storage.getGenerationRun(runId);
      if (!dbRun || dbRun.ideaId !== ideaId) {
        return res.status(404).json({ message: "Run not found" });
      }
      const statusMap: Record<string, string> = {
        running: "BUILDING", completed: "READY",
        completed_with_warnings: "READY_WITH_WARNINGS",
        failed: "FAILED", cancelled: "CANCELLED",
      };
      const finalStatus = statusMap[dbRun.status] || dbRun.status;
      if (afterIndex > 0) {
        return res.json({ events: [], totalStored: 1, status: finalStatus });
      }
      return res.json({
        events: [{ type: "done", data: { done: true, status: finalStatus }, timestamp: Date.now() }],
        totalStored: 1,
        status: finalStatus,
      });
    }

    return res.json(result);
  });

  app.get("/api/ideas/:ideaId/uipath-runs/:runId/stream", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const runId = requiredParam(req.params.runId, "runId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }

    const observerRun = getObserverRun(runId);
    const dbActiveRun = !observerRun ? getActiveRun(runId) : null;

    if (!observerRun && !dbActiveRun) {
      const dbRun = await storage.getGenerationRun(runId);
      if (!dbRun || dbRun.ideaId !== ideaId) {
        return res.status(404).json({ message: "Run not found" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();

      const statusMap: Record<string, string> = {
        running: "BUILDING", completed: "READY",
        completed_with_warnings: "READY_WITH_WARNINGS",
        failed: "FAILED", cancelled: "CANCELLED",
      };
      const finalStatus = statusMap[dbRun.status] || dbRun.status;
      res.write(`data: ${JSON.stringify({ done: true, status: finalStatus })}\n\n`);
      return res.end();
    }

    if (observerRun && observerRun.ideaId !== ideaId) {
      return res.status(403).json({ message: "Run does not belong to this idea" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const replay = optionalQuery(req.query.replay) === "true";

    if (observerRun) {
      console.log(`[Observer] SSE stream: connecting for runId=${runId}, replay=${replay}, currentStatus=${observerRun.status}`);

      const heartbeatInterval = setInterval(() => {
        try {
          if (res.writableEnded) { clearInterval(heartbeatInterval); return; }
          res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
          if (typeof (res as any).flush === "function") (res as any).flush();
        } catch { clearInterval(heartbeatInterval); }
      }, 15000);

      res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
      if (typeof (res as any).flush === "function") (res as any).flush();

      let unsubscribeFn: () => void = () => {};
      unsubscribeFn = subscribeToObserverRun(runId, (event) => {
        try {
          if (res.writableEnded) {
            console.log(`[Observer] SSE stream: res already ended, skipping event type=${event.type} for runId=${runId}`);
            return;
          }
          const payload = JSON.stringify(event.data);
          res.write(`data: ${payload}\n\n`);
          if (typeof (res as any).flush === "function") (res as any).flush();
          console.log(`[Observer] SSE stream: wrote event type=${event.type} for runId=${runId}`);

          if (event.type === "done" || event.type === "error") {
            console.log(`[Observer] SSE stream: ending stream for runId=${runId} due to event type=${event.type}`);
            clearInterval(heartbeatInterval);
            res.end();
          }
        } catch (e: any) {
          console.error(`[Observer] SSE stream: error writing event for runId=${runId}:`, e.message);
          clearInterval(heartbeatInterval);
          unsubscribeFn();
        }
      }, replay);

      if (isObserverTerminalStatus(observerRun.status) && !replay) {
        console.log(`[Observer] SSE stream: run already terminal (${observerRun.status}), sending final status for runId=${runId}`);
        clearInterval(heartbeatInterval);
        res.write(`data: ${JSON.stringify({ done: true, status: observerRun.status, warnings: observerRun.warnings, templateComplianceScore: observerRun.complianceScore, completenessLevel: observerRun.completenessLevel, outcomeSummary: observerRun.outcomeSummary, dependencyMap: observerRun.dependencyMap })}\n\n`);
        res.end();
        unsubscribeFn();
        return;
      }

      req.on("close", () => {
        console.log(`[Observer] SSE stream: client disconnected for runId=${runId}`);
        clearInterval(heartbeatInterval);
        unsubscribeFn();
      });
    } else if (dbActiveRun) {
      for (const event of dbActiveRun.events) {
        res.write(`data: ${JSON.stringify({ pipelineEvent: event })}\n\n`);
      }
      if (typeof (res as any).flush === "function") (res as any).flush();

      if (dbActiveRun.completed) {
        const resolvedStatus = dbActiveRun.finalStatus === "failed" ? "FAILED" : (dbActiveRun.finalStatus || "READY");
        res.write(`data: ${JSON.stringify({ done: true, status: resolvedStatus })}\n\n`);
        return res.end();
      }

      const unsubscribe = subscribeToRun(runId, (event) => {
        try {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify({ pipelineEvent: event })}\n\n`);
          if (typeof (res as any).flush === "function") (res as any).flush();
          if (event.type === "failed" || (event.type === "completed" && event.stage === "run_manager")) {
            let eventStatus = event.type === "failed" ? "FAILED" : "READY";
            if (event.type === "completed" && event.message) {
              const statusMatch = event.message.match(/status:\s*(\S+)/);
              if (statusMatch) eventStatus = statusMatch[1];
            }
            res.write(`data: ${JSON.stringify({ done: true, status: eventStatus })}\n\n`);
            res.end();
          }
        } catch (e: any) {
          unsubscribe();
        }
      });

      const heartbeat = setInterval(() => {
        try {
          if (res.writableEnded) {
            clearInterval(heartbeat);
            unsubscribe();
            return;
          }
          res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
        } catch (e: any) {
          clearInterval(heartbeat);
          unsubscribe();
        }
      }, 15000);

      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    }
  });

  app.post("/api/ideas/:ideaId/uipath-runs/:runId/cancel", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = requiredParam(req.params.ideaId, "ideaId");
    const idea = await storage.getIdea(ideaId);
    if (!idea) return res.status(404).json({ message: "Idea not found" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });
    const activeRole = (req.session.activeRole || user.role) as string;
    if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
      return res.status(403).json({ message: "Access denied" });
    }
    const runId = requiredParam(req.params.runId, "runId");
    const observerRun = getObserverRun(runId);
    if (observerRun && observerRun.ideaId !== ideaId) {
      return res.status(403).json({ message: "Run does not belong to this idea" });
    }
    const observerCancelled = cancelObserverRun(runId);

    const activeRun = getActiveRunForIdea(ideaId);
    let dbCancelled = false;
    if (activeRun && !activeRun.completed) {
      dbCancelled = await cancelActiveRun(activeRun.runId);
    }

    if (!observerCancelled && !dbCancelled) {
      return res.status(400).json({ message: "Cannot cancel this run" });
    }
    return res.json({ success: true });
  });
}
