import { createHash } from "crypto";
import AdmZip from "adm-zip";
import { storage } from "./storage";
import { documentStorage } from "./document-storage";
import { processMapStorage } from "./process-map-storage";
import { chatStorage } from "./replit_integrations/chat/storage";
import {
  buildNuGetPackage,
  QualityGateError,
  getAICenterSkills,
  rebuildNupkgWithEntries,
  type BuildResult,
  type GenerationMode,
} from "./uipath-integration";
import { catalogService } from "./catalog/catalog-service";
import type { StudioProfile } from "./catalog/metadata-service";
import {
  normalizeXaml as normalizeXamlCompliance,
  validateXamlContent,
  type XamlGap,
} from "./xaml-generator";
import { generateDhgFromOutcomeReport, type DhgContext } from "./dhg-generator";
import { runDhgAnalysis, type UpstreamContext, type ProcessStepSummary } from "./xaml/dhg-analyzers";
import { parseArtifactBlockAsObject } from "./lib/artifact-parser";
import type { UiPathPackage, UiPathPackageSpec, UiPathPackageInternal } from "./types/uipath-package";
import { analyzeAndFix, type AnalysisReport } from "./workflow-analyzer";
import { runQualityGate, classifyQualityIssues, getBlockingFiles, type QualityGateResult } from "./uipath-quality-gate";
import { calculateTemplateCompliance } from "./catalog/xaml-template-builder";
import {
  calculateConfidenceScore,
  runMetaValidation,
  applyCorrections,
  runDeterministicValidation,
  calculateEstimatedCost,
  recordGenerationMetrics,
  type MetaValidationMode,
  type MetaValidationResult,
  type ConfidenceScorerInput,
  type GenerationMetrics,
  type EntryWorkflowMetadata,
} from "./meta-validation";
import { classifyComplexity, estimateComplexityFromContext, type ComplexityTier, type ComplexityClassification } from "./complexity-classifier";
import { recordPipelineHealth, computePipelineHealthFromResult } from "./pipeline-health";
import { buildUiPathSolutionArtifact } from "./uipath-solution-builder";
import { buildUiPathTestAutomationArtifact } from "./uipath-test-automation-builder";
import {
  extractUiPathTestDesign,
  recommendUiPathDelivery,
} from "./uipath-delivery-planner";
import type {
  UiPathDeliveryRecommendation,
  UiPathSolutionArtifact,
  UiPathTestAutomationArtifact,
  UiPathTestCase,
  UiPathTestSet,
} from "./types/uipath-solution";

export type { GenerationMode };
export type { ComplexityTier, ComplexityClassification };

export interface MetaValidationEvent {
  status: string;
  correctionsApplied?: number;
  correctionsSkipped?: number;
  correctionsFailed?: number;
  flatStructureWarnings?: number;
  confidenceScore?: number;
  durationMs?: number;
}

export type PackageStatus = "BUILDING" | "READY" | "READY_WITH_WARNINGS" | "FALLBACK_READY" | "FAILED";

export type PipelineEventType = "started" | "heartbeat" | "completed" | "warning" | "failed";

export interface PipelineProgressEvent {
  type: PipelineEventType;
  stage: string;
  message: string;
  elapsed?: number;
  context?: Record<string, any>;
}

export type PipelineProgressCallback = (event: PipelineProgressEvent) => void;

class PipelineStageTracker {
  private startTimes: Map<string, number> = new Map();
  private heartbeatIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private activeStage: string | null = null;
  private onProgress: PipelineProgressCallback;

  constructor(onProgress: PipelineProgressCallback) {
    this.onProgress = onProgress;
  }

  start(stage: string, message: string, context?: Record<string, any>) {
    this.activeStage = stage;
    this.startTimes.set(stage, Date.now());
    this.onProgress({ type: "started", stage, message, context });
  }

  heartbeat(stage: string, messageFn: () => string) {
    this.clearHeartbeat(stage);
    const interval = setInterval(() => {
      const startTime = this.startTimes.get(stage);
      const elapsed = startTime ? (Date.now() - startTime) / 1000 : 0;
      this.onProgress({
        type: "heartbeat",
        stage,
        message: messageFn(),
        elapsed: Math.round(elapsed * 10) / 10,
      });
    }, 3500);
    this.heartbeatIntervals.set(stage, interval);
  }

  complete(stage: string, message: string, context?: Record<string, any>) {
    this.clearHeartbeat(stage);
    const startTime = this.startTimes.get(stage);
    const elapsed = startTime ? (Date.now() - startTime) / 1000 : 0;
    this.onProgress({
      type: "completed",
      stage,
      message,
      elapsed: Math.round(elapsed * 10) / 10,
      context,
    });
  }

  warn(stage: string, message: string, context?: Record<string, any>) {
    this.onProgress({ type: "warning", stage, message, context });
  }

  fail(stage: string, message: string, context?: Record<string, any>) {
    this.clearHeartbeat(stage);
    this.onProgress({ type: "failed", stage, message, context });
  }

  private clearHeartbeat(stage: string) {
    const interval = this.heartbeatIntervals.get(stage);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(stage);
    }
  }

  cleanup() {
    for (const [stage, interval] of this.heartbeatIntervals) {
      clearInterval(interval);
    }
    this.heartbeatIntervals.clear();
  }
}

export interface PipelineWarning {
  code: string;
  message: string;
  stage: string;
  recoverable: boolean;
  affectedFiles?: string[];
}

export interface DowngradeEvent {
  fromMode: GenerationMode;
  toMode: GenerationMode;
  reason: string;
  triggerStage: string;
  timestamp: Date;
}

export type RemediationLevel = "property" | "activity" | "sequence" | "structural-leaf" | "workflow" | "package" | "validation-finding";

export type RemediationCode =
  | "STUB_PROPERTY_BAD_EXPRESSION"
  | "STUB_PROPERTY_MISSING_SELECTOR"
  | "STUB_PROPERTY_UNSUPPORTED_TYPE"
  | "STUB_PROPERTY_INVALID_VALUE"
  | "STUB_ACTIVITY_CATALOG_VIOLATION"
  | "STUB_ACTIVITY_BLOCKED_PATTERN"
  | "STUB_ACTIVITY_OBJECT_OBJECT"
  | "STUB_ACTIVITY_PSEUDO_XAML"
  | "STUB_ACTIVITY_WELLFORMEDNESS"
  | "STUB_ACTIVITY_UNKNOWN"
  | "STUB_ACTIVITY_PROPERTY_ESCALATION"
  | "STUB_SEQUENCE_MULTIPLE_FAILURES"
  | "STUB_SEQUENCE_WELLFORMEDNESS"
  | "STUB_STRUCTURAL_LEAF"
  | "STUB_WORKFLOW_BLOCKING"
  | "STUB_WORKFLOW_GENERATOR_FAILURE"
  | "HALLUCINATED_ACTIVITY_STUBBED";

export type RepairCode =
  | "REPAIR_ALIAS_NORMALIZE"
  | "REPAIR_ENUM_CORRECTION"
  | "REPAIR_CATALOG_PROPERTY_SYNTAX"
  | "REPAIR_CATALOG_PROPERTY_VALUE"
  | "REPAIR_CATALOG_WRAPPER"
  | "REPAIR_LOG_LEVEL_NORMALIZE"
  | "REPAIR_AMPERSAND_ESCAPE"
  | "REPAIR_BARE_ANGLE_ESCAPE"
  | "REPAIR_DUPLICATE_ATTRIBUTE"
  | "REPAIR_TAKESCREENSHOT_STRIP"
  | "REPAIR_XAML_SANITIZE"
  | "REPAIR_UNKNOWN_ACTIVITY_REMOVE"
  | "REPAIR_INVOKE_PATH_FIX"
  | "REPAIR_DEPENDENCY_ADD"
  | "REPAIR_GENERIC"
  | "REPAIR_PLACEHOLDER_CLEANUP"
  | "REPAIR_MIXED_EXPRESSION_SYNTAX";

export interface RemediationEntry {
  level: RemediationLevel;
  file: string;
  remediationCode: RemediationCode;
  originalTag?: string;
  originalDisplayName?: string;
  propertyName?: string;
  reason: string;
  classifiedCheck: string;
  developerAction: string;
  estimatedEffortMinutes: number;
}

export interface AutoRepairEntry {
  repairCode: RepairCode;
  file: string;
  description: string;
  developerAction: string;
  estimatedEffortMinutes: number;
}

export interface DowngradeEventEntry {
  file?: string;
  fromMode: string;
  toMode: string;
  triggerReason: string;
  developerAction: string;
  estimatedEffortMinutes: number;
}

export interface QualityWarningEntry {
  file: string;
  check: string;
  detail: string;
  severity: "warning" | "blocking";
  developerAction: string;
  estimatedEffortMinutes: number;
  businessContext?: string;
  stubCategory?: "handoff" | "failure";
}

export const PROPERTY_REMEDIATION_ESCALATION_THRESHOLD = 3;

export interface StructuralPreservationMetrics {
  file: string;
  totalActivities: number;
  preservedActivities: number;
  stubbedActivities: number;
  preservedStructures: string[];
  studioLoadable?: boolean;
  studioLoadableNote?: string;
}

export type StudioCompatibilityLevel = "studio-clean" | "studio-warnings" | "studio-blocked";

export type StubFailureCategory =
  | "xml-wellformedness"
  | "quality-gate-escalation"
  | "type-mismatch"
  | "structural-invalid"
  | "generation-failure"
  | "compliance-failure"
  | "expression-syntax"
  | "undeclared-variable"
  | "unknown-activity";

export interface PerWorkflowStudioCompatibility {
  file: string;
  level: StudioCompatibilityLevel;
  blockers: string[];
  failureCategory?: StubFailureCategory;
  failureSummary?: string;
}

export interface PipelineOutcomeReport {
  remediations: RemediationEntry[];
  propertyRemediations: RemediationEntry[];
  autoRepairs: AutoRepairEntry[];
  downgradeEvents: DowngradeEventEntry[];
  qualityWarnings: QualityWarningEntry[];
  fullyGeneratedFiles: string[];
  totalEstimatedEffortMinutes: number;
  structuralPreservationMetrics?: StructuralPreservationMetrics[];
  studioCompatibility?: PerWorkflowStudioCompatibility[];
  preEmissionValidation?: {
    totalActivities: number;
    validActivities: number;
    unknownActivities: number;
    strippedProperties: number;
    enumCorrections: number;
    missingRequiredFilled: number;
    commentConversions: number;
    issueCount: number;
  };
}

export interface PipelineResult {
  packageBuffer: Buffer;
  solutionArtifact?: UiPathSolutionArtifact;
  testAutomationArtifact?: UiPathTestAutomationArtifact | null;
  deliveryRecommendation?: UiPathDeliveryRecommendation;
  testCases?: UiPathTestCase[];
  testSets?: UiPathTestSet[];
  analysisReports: Array<{ fileName: string; report: AnalysisReport }>;
  gaps: XamlGap[];
  usedPackages: string[];
  qualityGateResult?: QualityGateResult;
  dhgContent: string;
  cacheHit?: boolean;
  projectName: string;
  xamlEntries: { name: string; content: string }[];
  dependencyMap: Record<string, string>;
  archiveManifest: string[];
  qualityGateBlocking: boolean;
  qualityGateWarnings: string[];
  generationMode: GenerationMode;
  usedFallbackStubs: boolean;
  referencedMLSkillNames: string[];
  warnings: PipelineWarning[];
  downgrades: DowngradeEvent[];
  usedAIFallback: boolean;
  status: PackageStatus;
  templateComplianceScore?: number;
  metaValidationResult?: MetaValidationResult;
  outcomeReport?: PipelineOutcomeReport;
}

export interface DhgResult {
  dhgContent: string;
  projectName: string;
  analysisReports: Array<{ fileName: string; report: AnalysisReport }>;
}

export interface IdeaContext {
  idea: NonNullable<Awaited<ReturnType<typeof storage.getIdea>>>;
  sdd: Awaited<ReturnType<typeof documentStorage.getLatestDocument>>;
  pdd: Awaited<ReturnType<typeof documentStorage.getLatestDocument>>;
  dsd: Awaited<ReturnType<typeof documentStorage.getLatestDocument>>;
  mapNodes: any[];
  processEdges: any[];
}

type CachedPipelineResult = PipelineResult & { fingerprint: string };

const pipelineCache = new Map<string, CachedPipelineResult>();
const PIPELINE_CACHE_MAX = 20;

function evictOldestPipelineCacheEntry(): void {
  if (pipelineCache.size >= PIPELINE_CACHE_MAX) {
    const oldest = pipelineCache.keys().next().value;
    if (oldest) {
      pipelineCache.delete(oldest);
      console.log(`[Pipeline Cache] Evicted oldest entry: ${oldest}`);
    }
  }
}

function computeFingerprint(pkg: UiPathPackageSpec, sddContent: string, nodes: any[], edges: any[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(pkg));
  hash.update(sddContent);
  hash.update(JSON.stringify(nodes.map((n: any) => ({ id: n.id, name: n.name, type: n.nodeType, description: n.description, system: n.system }))));
  hash.update(JSON.stringify(edges.map((e: any) => ({ source: e.sourceNodeId, target: e.targetNodeId, label: e.label }))));
  return hash.digest("hex").slice(0, 16);
}

function validateArchiveStructure(buffer: Buffer): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!buffer || buffer.length === 0) {
    errors.push("Package buffer is empty");
    return { valid: false, errors };
  }

  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const entryNames = entries.map(e => e.entryName);

    const hasMainXaml = entryNames.some(n => {
      const basename = n.split("/").pop() || n;
      return basename === "Main.xaml";
    });
    if (!hasMainXaml) {
      errors.push("Archive is missing Main.xaml");
    }

    const hasProjectJson = entryNames.some(n => {
      const basename = n.split("/").pop() || n;
      return basename === "project.json";
    });
    if (!hasProjectJson) {
      errors.push("Archive is missing project.json");
    }
  } catch (err: any) {
    errors.push(`Archive is not a valid ZIP: ${err.message}`);
  }

  return { valid: errors.length === 0, errors };
}

async function loadIdeaContext(ideaId: string): Promise<IdeaContext> {
  const idea = await storage.getIdea(ideaId);
  if (!idea) throw new Error("Idea not found");

  const sdd = await documentStorage.getLatestDocument(ideaId, "SDD");
  const pdd = await documentStorage.getLatestDocument(ideaId, "PDD");
  const dsd = await documentStorage.getLatestDocument(ideaId, "DSD");
  const toBeNodes = await processMapStorage.getNodesByIdeaId(ideaId, "to-be");
  const asIsNodes = await processMapStorage.getNodesByIdeaId(ideaId, "as-is");
  const mapNodes = toBeNodes.length > 0 ? toBeNodes : asIsNodes;
  const mapVariant = toBeNodes.length > 0 ? "to-be" : "as-is";

  let processEdges: any[] = [];
  if (mapNodes.length > 0) {
    processEdges = await processMapStorage.getEdgesByIdeaId(ideaId, mapVariant as "to-be" | "as-is");
  }

  return { idea, sdd, pdd, dsd, mapNodes, processEdges };
}

async function extractOrchestratorArtifacts(sddContent: string | undefined, warnings: PipelineWarning[]): Promise<any | null> {
  if (!sddContent) return null;
  try {
    const { parseArtifactsFromSDD, extractArtifactsWithLLM } = await import("./uipath-deploy");
    let artifacts = parseArtifactsFromSDD(sddContent);
    if (!artifacts) {
      console.warn("[Pipeline] No artifact block found in SDD content — attempting LLM extraction as recovery...");
      artifacts = await extractArtifactsWithLLM(sddContent);
      if (artifacts) {
        console.log("[Pipeline] LLM extraction recovery succeeded");
      } else {
        console.error("[Pipeline] LLM extraction recovery failed — no artifacts will be provisioned");
      }
    }
    return artifacts || null;
  } catch (err: any) {
    const msg = err?.message || "Unknown error";
    console.warn(`[Pipeline] Artifact extraction failed: ${msg}`);
    warnings.push({
      code: "ARTIFACT_EXTRACTION_FAILED",
      message: `Orchestrator artifact extraction failed: ${msg}`,
      stage: "artifact-extraction",
      recoverable: true,
    });
    return null;
  }
}

function enrichPackageWithContext(
  pkg: UiPathPackageSpec,
  context: IdeaContext,
  orchestratorArtifacts: any | null,
  aiCenterSkills?: any[],
): UiPathPackage {
  const internal: UiPathPackage["internal"] = {};
  if (context.sdd?.content) internal.sddContent = context.sdd.content;
  if (context.idea.automationType) internal.automationType = context.idea.automationType as UiPathPackageInternal["automationType"];
  if (context.mapNodes.length > 0) {
    internal.processNodes = context.mapNodes;
    internal.processEdges = context.processEdges;
  }
  if (orchestratorArtifacts) internal.orchestratorArtifacts = orchestratorArtifacts;
  if (aiCenterSkills) internal.aiCenterSkills = aiCenterSkills;
  return { ...pkg, internal };
}

export function computeVersion(): string {
  const now = new Date();
  const patch = now.getFullYear() * 10000 + (now.getMonth() + 1) * 100 + now.getDate();
  return `1.0.${patch}`;
}

export function findUiPathMessage(messages: any[]): any | null {
  return [...messages].reverse().find((m: any) =>
    (m.role === "assistant" || m.role === "system") && m.content.startsWith("[UIPATH:")
  ) || null;
}

export function parseUiPathPackage(uipathMsg: any): UiPathPackage {
  let jsonStr = uipathMsg.content.slice(8);
  if (jsonStr.endsWith("]")) jsonStr = jsonStr.slice(0, -1);
  const braceEnd = jsonStr.lastIndexOf("}");
  if (braceEnd !== -1) jsonStr = jsonStr.slice(0, braceEnd + 1);
  const parsed = JSON.parse(jsonStr);
  if (!parsed.internal) parsed.internal = {};
  return parsed as UiPathPackage;
}

function buildDhgFromBuildResult(
  pkg: UiPathPackage,
  ctx: IdeaContext,
  buildResult: BuildResult,
  overrideXamlEntries?: { name: string; content: string }[],
  generationMode?: GenerationMode,
): DhgResult {
  const sddContent = ctx.sdd?.content || "";
  const workflows = pkg.workflows || [];
  const xamlEntries = overrideXamlEntries || buildResult.xamlEntries;

  const effectiveWfNames = xamlEntries.map(e => {
    const baseName = e.name.split("/").pop() || e.name;
    return baseName.replace(/\.xaml$/i, "");
  });

  const analysisReports: Array<{ fileName: string; report: AnalysisReport }> = [];
  for (const entry of xamlEntries) {
    const { report } = analyzeAndFix(entry.content);
    analysisReports.push({ fileName: entry.name, report });
  }

  const enrichment = pkg.internal?.enrichment || null;
  const useReFramework = enrichment?.useReFramework ?? pkg.internal?.useReFramework ?? false;
  const painPoints = (pkg.internal?.painPoints || []).map((p: { name?: string; description?: string }) => ({
    name: p.name || "",
    description: p.description || "",
  }));

  const extractedArtifacts = pkg.internal?.extractedArtifacts || undefined;
  const projectName = pkg.projectName || ctx.idea.title.replace(/\s+/g, "_");

  let dhgContent = "";

  if (buildResult.outcomeReport) {
    const qualityWarningCount = buildResult.outcomeReport.qualityWarnings.length;
    const remediationCount = buildResult.outcomeReport.remediations.length + buildResult.outcomeReport.propertyRemediations.length;

    const plannedWfNames = workflows.map((wf: { name?: string }) => (wf.name || "Workflow").replace(/\s+/g, "_"));
    const archiveWfNames = new Set(effectiveWfNames);
    const stubRemediations = buildResult.outcomeReport.remediations.filter(r => r.remediationCode === "STUB_WORKFLOW_BLOCKING");
    const stubFileNames = new Set(stubRemediations.map(r => r.file.replace(/\.xaml$/i, "")));
    const entryPointStubbed = stubFileNames.has("Main");
    const plannedButMissingCount = plannedWfNames.filter(n => !archiveWfNames.has(n)).length;

    const pipelineStudioBlocked = buildResult.outcomeReport?.studioCompatibility?.filter(
      sc => sc.level === "studio-blocked"
    ).length ?? stubFileNames.size;
    const pipelineStudioLoadable = archiveWfNames.size - pipelineStudioBlocked;
    const stubAwareness = {
      entryPointStubbed,
      stubCount: stubFileNames.size,
      totalWorkflowCount: archiveWfNames.size,
      plannedButMissingCount,
      studioLoadableCount: Math.max(0, pipelineStudioLoadable),
      studioBlockedCount: pipelineStudioBlocked,
    };

    const upstreamContext: UpstreamContext = {
      ideaDescription: ctx.idea.description || undefined,
      automationType: ctx.idea.automationType || undefined,
      automationTypeRationale: ctx.idea.automationTypeRationale || undefined,
      feasibilityComplexity: ctx.idea.feasibilityComplexity || undefined,
      feasibilityEffortEstimate: ctx.idea.feasibilityEffortEstimate || undefined,
      qualityWarnings: buildResult.outcomeReport.qualityWarnings.map(w => ({
        code: w.check,
        message: w.detail,
        severity: w.severity,
      })),
    };
    if (ctx.pdd?.content) {
      const pddContent = typeof ctx.pdd.content === "string" ? ctx.pdd.content : "";
      upstreamContext.pddSummary = pddContent.slice(0, 2000) + (pddContent.length > 2000 ? "..." : "");
    }
    if (ctx.sdd?.content) {
      const sddContentStr = typeof ctx.sdd.content === "string" ? ctx.sdd.content : "";
      upstreamContext.sddSummary = sddContentStr.slice(0, 2000) + (sddContentStr.length > 2000 ? "..." : "");
    }

    if (ctx.mapNodes && ctx.mapNodes.length > 0) {
      const toBeNodes = ctx.mapNodes.filter((n: any) => n.viewType === "to-be" || !n.viewType || n.viewType === "as-is");
      upstreamContext.processSteps = toBeNodes.map((n: any): ProcessStepSummary => ({
        name: n.name || "",
        role: n.role || "",
        system: n.system || "",
        nodeType: n.nodeType || "task",
        isPainPoint: !!n.isPainPoint,
        description: n.description || "",
      }));

      upstreamContext.painPoints = ctx.mapNodes
        .filter((n: any) => n.isPainPoint)
        .map((n: any) => `${n.name || "Unnamed step"}${n.description ? ": " + n.description : ""}`);

      const uniqueSystems = [...new Set(
        ctx.mapNodes
          .map((n: any) => (n.system || "").trim())
          .filter((s: string) => s.length > 0),
      )] as string[];
      if (uniqueSystems.length > 0) upstreamContext.systems = uniqueSystems;

      const uniqueRoles = [...new Set(
        ctx.mapNodes
          .map((n: any) => (n.role || "").trim())
          .filter((r: string) => r.length > 0),
      )] as string[];
      if (uniqueRoles.length > 0) upstreamContext.roles = uniqueRoles;

      if (ctx.processEdges && ctx.processEdges.length > 0) {
        const nodeById = new Map<number, any>();
        for (const n of ctx.mapNodes) nodeById.set(n.id, n);

        const decisionNodes = ctx.mapNodes.filter((n: any) =>
          (n.nodeType || "").toLowerCase() === "decision" || (n.nodeType || "").toLowerCase() === "gateway"
        );

        if (decisionNodes.length > 0) {
          const decisionBranches: Array<{ decisionNodeName: string; branches: Array<{ label: string; targetNodeName: string }> }> = [];
          for (const dn of decisionNodes) {
            const outgoing = ctx.processEdges.filter((e: any) => e.sourceNodeId === dn.id);
            if (outgoing.length > 0) {
              decisionBranches.push({
                decisionNodeName: dn.name || "Decision",
                branches: outgoing.map((e: any) => ({
                  label: e.label || "→",
                  targetNodeName: nodeById.get(e.targetNodeId)?.name || `Node ${e.targetNodeId}`,
                })),
              });
            }
          }
          if (decisionBranches.length > 0) upstreamContext.decisionBranches = decisionBranches;
        }
      }
    }

    let sddArtifacts: Record<string, any> | null = null;
    if (ctx.sdd?.content && typeof ctx.sdd.content === "string") {
      sddArtifacts = parseArtifactBlockAsObject(ctx.sdd.content);
    }

    const pipelineEmptyContainerCount = buildResult.outcomeReport.qualityWarnings.filter(
      w => w.check === "empty-container"
    ).length;
    const analysis = runDhgAnalysis(
      xamlEntries,
      buildResult.projectJsonContent || undefined,
      qualityWarningCount,
      remediationCount,
      ctx.idea.automationType || undefined,
      upstreamContext,
      sddArtifacts,
      stubAwareness,
      pipelineEmptyContainerCount,
    );
    analysis.hasBlockedWorkflows = buildResult.outcomeReport?.studioCompatibility?.some(
      sc => sc.level === "studio-blocked"
    ) ?? false;
    const dhgContext: DhgContext = {
      projectName,
      workflowNames: effectiveWfNames,
      generationMode: generationMode || undefined,
      analysis,
      xamlEntries,
    };
    dhgContent = generateDhgFromOutcomeReport(buildResult.outcomeReport, dhgContext);
  } else {
    const syntheticReport: PipelineOutcomeReport = {
      remediations: [],
      propertyRemediations: [],
      autoRepairs: [],
      downgradeEvents: [],
      qualityWarnings: [],
      fullyGeneratedFiles: xamlEntries.map(e => {
        const baseName = e.name.split("/").pop() || e.name;
        return baseName;
      }),
      totalEstimatedEffortMinutes: 0,
    };
    const analysis = runDhgAnalysis(
      xamlEntries,
      buildResult.projectJsonContent || undefined,
      0,
      0,
      ctx.idea.automationType || undefined,
    );
    const dhgContext: DhgContext = {
      projectName,
      workflowNames: effectiveWfNames,
      generationMode: generationMode || undefined,
      analysis,
      xamlEntries,
    };
    dhgContent = generateDhgFromOutcomeReport(syntheticReport, dhgContext);
  }

  return {
    dhgContent,
    projectName: pkg.projectName || ctx.idea.title,
    analysisReports,
  };
}

export interface SpecGenerationResult {
  ctx: IdeaContext;
  enrichedPkg: UiPathPackage;
  fingerprint: string;
  aiSkills: any[];
  artifacts: any | null;
  pipelineWarnings: PipelineWarning[];
  usedAIFallback: boolean;
}

export async function generateWorkflowSpecs(
  ideaId: string,
  pkg: UiPathPackageSpec,
  options?: {
    generationMode?: GenerationMode;
    onProgress?: (message: string) => void;
    onPipelineProgress?: PipelineProgressCallback;
    preloadedContext?: IdeaContext;
    runId?: string;
    complexityTier?: ComplexityTier;
  },
): Promise<SpecGenerationResult> {
  const mode: GenerationMode = options?.generationMode || "full_implementation";
  const pipelineWarnings: PipelineWarning[] = [];
  let usedAIFallback = false;

  const noop: PipelineProgressCallback = () => {};
  const tracker = new PipelineStageTracker(options?.onPipelineProgress || noop);
  const emitLegacy = options?.onProgress;

  try {
    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, "spec_generating");
      } catch (e) { /* best-effort */ }
    }

    tracker.start("spec_generation", "Loading context and preparing spec generation");
    tracker.heartbeat("spec_generation", () => "Loading idea, SDD, and process map data");
    const ctx = options?.preloadedContext || await loadIdeaContext(ideaId);
    const artifacts = await extractOrchestratorArtifacts(ctx.sdd?.content, pipelineWarnings);
    tracker.complete("spec_generation", "Context loaded for spec generation", {
      hasSdd: !!ctx.sdd,
      hasPdd: !!ctx.pdd,
      nodeCount: ctx.mapNodes.length,
    });

    const fp = computeFingerprint(pkg, ctx.sdd?.content || "", ctx.mapNodes, ctx.processEdges);

    if (emitLegacy) emitLegacy(mode === "baseline_openable" ? "Generating baseline Studio-openable package..." : "AI-enriching XAML workflows...");

    let aiSkills: any[] = [];
    if (mode !== "baseline_openable") {
      tracker.start("spec_generation_ai", "Fetching AI Center skills");
      tracker.heartbeat("spec_generation_ai", () => "Checking AI Center availability");
    }
    try {
      const aiResult = await getAICenterSkills();
      if (aiResult.available) aiSkills = aiResult.skills;
      if (mode !== "baseline_openable") {
        tracker.complete("spec_generation_ai", `${aiSkills.length} AI skill(s) available`, { skillCount: aiSkills.length });
      }
    } catch (err: any) {
      const msg = err?.message || "Unknown error";
      console.warn(`[Pipeline] AI Center skills fetch failed: ${msg}`);
      pipelineWarnings.push({
        code: "AI_CENTER_SKILLS_UNAVAILABLE",
        message: `AI Center skills could not be fetched: ${msg}`,
        stage: "ai-center",
        recoverable: true,
      });
      if (mode !== "baseline_openable") {
        tracker.warn("spec_generation_ai", `AI Center unavailable: ${msg}`);
        tracker.complete("spec_generation_ai", "Continuing without AI Center");
      }
    }

    const enrichedPkg = enrichPackageWithContext(pkg, ctx, artifacts, aiSkills);

    tracker.start("spec_generation_done", "Spec generation complete");
    tracker.complete("spec_generation_done", "WorkflowSpecs ready for XAML emission");

    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, "spec_ready");
        await storage.updateGenerationRunSpecSnapshot(options.runId, {
          pkg: enrichedPkg,
          fingerprint: fp,
          generationMode: mode,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(`[Pipeline] Failed to persist spec snapshot: ${(e as Error).message}`);
      }
    }

    return {
      ctx,
      enrichedPkg: enrichedPkg,
      fingerprint: fp,
      aiSkills,
      artifacts,
      pipelineWarnings,
      usedAIFallback,
    };
  } finally {
    tracker.cleanup();
  }
}

export async function compilePackageFromSpecs(
  ideaId: string,
  specResult: SpecGenerationResult,
  pkg: UiPathPackageSpec,
  options?: {
    version?: string;
    generationMode?: GenerationMode;
    onProgress?: (message: string) => void;
    onMetaValidation?: (event: MetaValidationEvent) => void;
    onPipelineProgress?: PipelineProgressCallback;
    metaValidationMode?: MetaValidationMode;
    maxDowngradeAttempts?: number;
    _downgradeAttempt?: number;
    _accumulatedDowngrades?: DowngradeEvent[];
    _accumulatedWarnings?: PipelineWarning[];
    _priorCompliantWorkflows?: Array<{ name: string; content: string }>;
    runId?: string;
    complexityTier?: ComplexityTier;
    forceRebuild?: boolean;
  },
): Promise<PipelineResult> {
  const ver = options?.version || computeVersion();
  const mode: GenerationMode = options?.generationMode || "full_implementation";
  const pipelineWarnings: PipelineWarning[] = [
    ...specResult.pipelineWarnings,
    ...(options?._accumulatedWarnings || []),
  ];
  const downgrades: DowngradeEvent[] = options?._accumulatedDowngrades ? [...options._accumulatedDowngrades] : [];
  let usedAIFallback = specResult.usedAIFallback;
  const maxDowngradeAttempts = options?.maxDowngradeAttempts ?? 1;
  const currentDowngradeAttempt = options?._downgradeAttempt ?? 0;
  const priorCompliantWorkflows = options?._priorCompliantWorkflows || [];

  try {
    const { discoverNewerLines } = await import("./catalog/metadata-refresher");
    const { metadataService: metaSvc } = await import("./catalog/metadata-service");
    const newerLines = await discoverNewerLines();
    if (newerLines.newerLineAvailable) {
      const studioTarget = metaSvc.getStudioTarget();
      const currentLine = studioTarget?.line || "unknown";
      const LTS_LINES = new Set(["25.10", "24.10", "23.10"]);
      if (!LTS_LINES.has(currentLine)) {
        pipelineWarnings.push({
          code: "CATALOG_VERSION_BEHIND_STUDIO",
          message: `Catalog targets Studio line ${currentLine}, but newer line ${newerLines.newerLineAvailable} (v${newerLines.latestVersion}) is available on NuGet. The generated package may need version updates when opened in a newer Studio.`,
          stage: "version-check",
          recoverable: true,
        });
      }
    }
  } catch (err: any) {
    console.debug(`[Pipeline] Newer-line discovery skipped: ${err?.message || "unknown error"}`);
  }

  const noop: PipelineProgressCallback = () => {};
  const tracker = new PipelineStageTracker(options?.onPipelineProgress || noop);
  const mvMode: MetaValidationMode = options?.metaValidationMode || "Auto";

  const ctx = specResult.ctx;
  const enriched = specResult.enrichedPkg;
  const fp = specResult.fingerprint;

  try {
    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, "compiling");
      } catch (e) { /* best-effort */ }
    }

    tracker.start("xaml_emission", "Assembling XAML workflows");
    const workflowCount = (pkg as any).workflows?.length || 0;
    let currentWorkflowIdx = 0;
    tracker.heartbeat("xaml_emission", () => {
      return `Building workflow ${currentWorkflowIdx + 1} of ${workflowCount || "?"}`;
    });
    let buildResult: BuildResult;
    try {
      const _pipelineProfile = catalogService.getStudioProfile();
      if (options?.forceRebuild) {
        enriched.internal.forceRebuild = true;
      }
      if (priorCompliantWorkflows.length > 0) {
        enriched.internal.priorCompliantWorkflows = priorCompliantWorkflows;
        console.log(`[Pipeline] Passing ${priorCompliantWorkflows.length} prior compliant workflow(s) to build: ${priorCompliantWorkflows.map(w => w.name).join(", ")}`);
      }
      buildResult = await buildNuGetPackage(enriched, ver, ideaId, mode, options?.onPipelineProgress ? (event) => {
        options.onPipelineProgress!(event);
      } : undefined, _pipelineProfile, options?.complexityTier);
    } catch (err) {
      if (err instanceof QualityGateError && mode === "full_implementation" && currentDowngradeAttempt < maxDowngradeAttempts) {
        const downgradeEvent: DowngradeEvent = {
          fromMode: "full_implementation",
          toMode: "baseline_openable",
          reason: `Quality gate failed after auto-remediation: ${err.message.slice(0, 200)}`,
          triggerStage: "compiling",
          timestamp: new Date(),
        };
        downgrades.push(downgradeEvent);
        pipelineWarnings.push({
          code: "AUTO_DOWNGRADE_QUALITY_GATE",
          message: `Auto-downgraded from full_implementation to baseline_openable: quality gate failed after remediation`,
          stage: "compiling",
          recoverable: true,
        });
        const qgBlockingFiles = new Set<string>();
        if (err.qualityGateResult) {
          const classified = classifyQualityIssues(err.qualityGateResult);
          const blockingFiles = getBlockingFiles(classified);
          Array.from(blockingFiles).forEach(bf => qgBlockingFiles.add(bf));
        }
        const compliantFromCurrent = (err.compliantWorkflows || []).filter((w: { name: string; content: string }) => {
          const shortName = w.name.split("/").pop() || w.name;
          return !qgBlockingFiles.has(shortName);
        });
        const compliantFromPrior = priorCompliantWorkflows.filter(w => {
          const shortName = w.name.split("/").pop() || w.name;
          return !qgBlockingFiles.has(shortName);
        });
        const mergedCompliant = [...compliantFromCurrent];
        const currentNames = new Set(mergedCompliant.map(w => w.name));
        for (const pw of compliantFromPrior) {
          if (!currentNames.has(pw.name)) {
            mergedCompliant.push(pw);
          }
        }
        if (mergedCompliant.length > 0) {
          console.log(`[Pipeline] Carrying forward ${mergedCompliant.length} compliant workflow(s) (${compliantFromCurrent.length} from current attempt, ${compliantFromPrior.length} from prior): ${mergedCompliant.map(w => w.name).join(", ")}`);
        }
        tracker.warn("xaml_emission", `Quality gate failed — auto-downgrading to baseline_openable (attempt ${currentDowngradeAttempt + 1}/${maxDowngradeAttempts})`);
        tracker.cleanup();
        console.log(`[Pipeline] Auto-downgrade: full_implementation → baseline_openable due to QualityGateError (attempt ${currentDowngradeAttempt + 1}/${maxDowngradeAttempts})`);
        return compilePackageFromSpecs(ideaId, specResult, pkg, {
          ...options,
          generationMode: "baseline_openable",
          _downgradeAttempt: currentDowngradeAttempt + 1,
          _accumulatedDowngrades: downgrades,
          _accumulatedWarnings: pipelineWarnings,
          _priorCompliantWorkflows: mergedCompliant,
        });
      }
      throw err;
    }

    if (buildResult.usedAIFallback) {
      usedAIFallback = true;
    }

    currentWorkflowIdx = workflowCount > 0 ? workflowCount - 1 : 0;
    tracker.complete("xaml_emission", `${buildResult.xamlEntries.length} XAML file(s) assembled`, {
      xamlCount: buildResult.xamlEntries.length,
      cacheHit: buildResult.cacheHit,
    });

    if (buildResult.dependencyWarnings) {
      pipelineWarnings.push(...buildResult.dependencyWarnings);
      for (const w of buildResult.dependencyWarnings) {
        tracker.warn("xaml_emission", w.message);
      }

      const excessiveStrippingWarning = buildResult.dependencyWarnings.find(
        w => w.code === "EXCESSIVE_PROPERTY_STRIPPING" && !w.recoverable
      );
      if (excessiveStrippingWarning && mode !== "baseline_openable" && currentDowngradeAttempt < maxDowngradeAttempts) {
        const downgradeEvent: DowngradeEvent = {
          fromMode: mode,
          toMode: "baseline_openable",
          reason: `Excessive non-catalog property stripping detected: ${excessiveStrippingWarning.message}`,
          triggerStage: "compiling",
          timestamp: new Date(),
        };
        downgrades.push(downgradeEvent);
        pipelineWarnings.push({
          code: "AUTO_DOWNGRADE_EXCESSIVE_STRIPPING",
          message: `Auto-downgraded to baseline_openable: excessive non-catalog property stripping indicates generation hallucination`,
          stage: "compiling",
          recoverable: true,
        });
        const strippingBlockedFiles = new Set<string>();
        buildResult.dependencyWarnings?.forEach(w => {
          if (w.code === "EXCESSIVE_PROPERTY_STRIPPING" && w.affectedFiles) {
            w.affectedFiles.forEach(f => strippingBlockedFiles.add(f));
          }
        });
        const compliantEntries = buildResult.xamlEntries.filter(entry => {
          const shortName = entry.name.split("/").pop() || entry.name;
          return !strippingBlockedFiles.has(shortName);
        });
        if (compliantEntries.length > 0) {
          console.log(`[Pipeline] Carrying forward ${compliantEntries.length} compliant workflow(s) from build: ${compliantEntries.map(e => e.name).join(", ")}`);
        }
        tracker.warn("xaml_emission", `Excessive property stripping detected — auto-downgrading to baseline_openable (attempt ${currentDowngradeAttempt + 1}/${maxDowngradeAttempts})`);
        tracker.cleanup();
        console.log(`[Pipeline] Auto-downgrade: ${mode} → baseline_openable due to excessive property stripping`);
        return compilePackageFromSpecs(ideaId, specResult, pkg, {
          ...options,
          generationMode: "baseline_openable",
          _downgradeAttempt: currentDowngradeAttempt + 1,
          _accumulatedDowngrades: downgrades,
          _accumulatedWarnings: pipelineWarnings,
          _priorCompliantWorkflows: compliantEntries.length > 0 ? compliantEntries : undefined,
        });
      }
    }

    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, "validating");
      } catch (e) { /* best-effort */ }
    }

    tracker.start("compliance_normalization", "Validating archive and catalog compliance");
    const archiveValidation = validateArchiveStructure(buildResult.buffer);
    if (!archiveValidation.valid) {
      tracker.warn("compliance_normalization", `Archive validation failed: ${archiveValidation.errors.join("; ")}`);
      if (mode !== "baseline_openable" && currentDowngradeAttempt < maxDowngradeAttempts) {
        const downgradeEvent: DowngradeEvent = {
          fromMode: mode,
          toMode: "baseline_openable",
          reason: `Archive validation failed: ${archiveValidation.errors.join("; ")}`,
          triggerStage: "validating",
          timestamp: new Date(),
        };
        downgrades.push(downgradeEvent);
        pipelineWarnings.push({
          code: "AUTO_DOWNGRADE_ARCHIVE_INVALID",
          message: `Auto-downgraded to baseline_openable: archive validation failed (${archiveValidation.errors.join("; ")})`,
          stage: "validating",
          recoverable: true,
        });
        tracker.cleanup();
        console.log(`[Pipeline] Auto-downgrade: ${mode} → baseline_openable due to archive validation failure`);
        return compilePackageFromSpecs(ideaId, specResult, pkg, {
          ...options,
          generationMode: "baseline_openable",
          _downgradeAttempt: currentDowngradeAttempt + 1,
          _accumulatedDowngrades: downgrades,
          _accumulatedWarnings: pipelineWarnings,
          _priorCompliantWorkflows: buildResult.xamlEntries.length > 0 ? buildResult.xamlEntries : undefined,
        });
      }
      const archiveError = `Archive validation failed and no downgrade available: ${archiveValidation.errors.join("; ")}`;
      tracker.fail("compliance_normalization", archiveError);
      tracker.cleanup();
      throw new Error(archiveError);
    }

    let templateComplianceScore: number | undefined;
    try {
      if (buildResult.xamlEntries.length > 0) {
        let totalScore = 0;
        let count = 0;
        for (const entry of buildResult.xamlEntries) {
          const compliance = calculateTemplateCompliance(entry.content);
          totalScore += compliance.score;
          count++;
          if (compliance.violations.length > 0) {
            console.log(`[Pipeline] Template compliance for ${entry.name}: ${compliance.score} (${compliance.compliantActivities}/${compliance.totalActivities} compliant, ${compliance.violations.length} violations)`);
          }
        }
        templateComplianceScore = count > 0 ? Math.round((totalScore / count) * 100) / 100 : 1.0;
        const hasStubs = buildResult.usedFallbackStubs || buildResult.outcomeReport?.remediations.some(
          r => r.level === "activity" || r.level === "sequence" || r.level === "structural-leaf" || r.level === "workflow"
        );
        if (hasStubs && templateComplianceScore > 0.69) {
          console.log(`[Pipeline] Capping templateComplianceScore from ${templateComplianceScore} to 0.69 — package contains stubs`);
          templateComplianceScore = 0.69;
        }
        console.log(`[Pipeline] Overall templateComplianceScore: ${templateComplianceScore}`);
      }
    } catch (err: any) {
      console.warn(`[Pipeline] Template compliance calculation failed: ${err.message}`);
      tracker.warn("compliance_normalization", `Template compliance check failed: ${err.message}`);
    }
    tracker.complete("compliance_normalization", "Compliance normalization complete", { templateComplianceScore });

    const qgResult = buildResult.qualityGateResult;
    const isIncomplete = qgResult ? qgResult.completenessLevel === "incomplete" : false;
    const hasStructuralCatalogErrors = qgResult
      ? qgResult.violations.some((v: any) => v.severity === "error" && (v.check === "CATALOG_STRUCTURAL_VIOLATION" || v.check === "ENUM_VIOLATION"))
      : false;
    const hasMainXamlMissing = qgResult
      ? qgResult.violations.some((v: any) => v.severity === "error" && v.check === "main-xaml")
      : false;
    let qualityGateBlocking = mode === "baseline_openable"
      ? (isIncomplete || hasStructuralCatalogErrors || hasMainXamlMissing)
      : (qgResult ? (!qgResult.passed || isIncomplete) : false);
    let qualityGateWarnings: string[] = qgResult
      ? qgResult.violations
          .filter((v: any) => {
            if (v.severity === "warning") return true;
            if (mode === "baseline_openable" && v.severity === "error") {
              if (isIncomplete) return false;
              if (v.check === "CATALOG_STRUCTURAL_VIOLATION" || v.check === "ENUM_VIOLATION") return false;
              return true;
            }
            return false;
          })
          .map((v: any) => v.detail)
      : [];
    let postCorrectionQualityGate: QualityGateResult | null = null;

    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, "remediating");
      } catch (e) { /* best-effort */ }
    }

    tracker.start("validation", "Running meta-validation and remediation");
    let metaValidationResult: MetaValidationResult | undefined;
    let finalXamlEntries = buildResult.xamlEntries;
    let finalPackageBuffer = buildResult.buffer;
    let mvInputTokens = 0;
    let mvOutputTokens = 0;
    let canonicalRebuildFailed = false;
    let canonicalRebuildErrorMsg = "";
    const hasNupkg = buildResult.buffer && buildResult.buffer.length > 0;

    if (hasNupkg) {
      try {
        const mainXamlEntry = buildResult.xamlEntries.find(e => {
          const basename = e.name.split("/").pop() || e.name;
          return basename === "Main.xaml";
        });
        let entryWorkflow: EntryWorkflowMetadata | undefined;
        if (mainXamlEntry) {
          const mainContent = mainXamlEntry.content;
          const invokeCount = (mainContent.match(/InvokeWorkflowFile/g) || []).length;
          const mainActivityCount = (mainContent.match(/<ui:[A-Z]/g) || []).length + (mainContent.match(/<[A-Za-z]+\.[A-Za-z]+/g) || []).length;
          const mainHasReFramework = mainContent.includes("GetTransactionData") || mainContent.includes("SetTransactionStatus") || mainContent.includes("ReFramework");
          const mainHasCatalogViolations = (qgResult?.violations.filter(v => (v.check === "catalog-violation" || v.check === "CATALOG_VIOLATION" || v.check === "CATALOG_STRUCTURAL_VIOLATION") && (v.file === "Main.xaml" || v.file.endsWith("/Main.xaml"))).length || 0) > 0;
          entryWorkflow = {
            isPreviouslyStubbed: buildResult.usedFallbackStubs,
            invokeWorkflowFileCount: invokeCount,
            hasReFramework: mainHasReFramework,
            activityCount: mainActivityCount,
            hasCatalogViolations: mainHasCatalogViolations,
          };
        }

        const scorerInput: ConfidenceScorerInput = {
          workflowCount: buildResult.xamlEntries.length,
          activityCount: buildResult.xamlEntries.reduce((sum, e) => sum + (e.content.match(/<ui:[A-Z]/g)?.length || 0), 0),
          templateComplianceScore,
          catalogViolationCount: qgResult?.violations.filter(v => v.check === "catalog-violation" || v.check === "CATALOG_VIOLATION" || v.check === "CATALOG_STRUCTURAL_VIOLATION").length || 0,
          uncataloguedActivityCount: qgResult?.violations.filter(v => v.check === "uncatalogued-activity").length || 0,
          hasReFramework: buildResult.xamlEntries.some(e => e.name.includes("GetTransactionData") || e.name.includes("SetTransactionStatus")),
          hasDocumentUnderstanding: buildResult.xamlEntries.some(e => e.content.includes("DigitizeDocument") || e.content.includes("ClassifyDocument")),
          hasAICenter: buildResult.xamlEntries.some(e => e.content.includes("MLSkill") || e.content.includes("Predict")),
          priorGenerationHadStubs: buildResult.usedFallbackStubs,
          qualityGateWarningCount: qgResult?.summary.totalWarnings || 0,
          entryWorkflow,
        };

        const confidenceResult = calculateConfidenceScore(scorerInput);
        const shouldEngage = mvMode !== "Off" && (mvMode === "Always" || (mvMode === "Auto" && confidenceResult.shouldEngage));

        options?.onMetaValidation?.({ status: "assessing", confidenceScore: confidenceResult.score });

        if (shouldEngage) {
          options?.onMetaValidation?.({ status: "will-validate", confidenceScore: confidenceResult.score });
          if (options?.onProgress) options.onProgress("Running meta-validation review...");
          console.log(`[Pipeline] Meta-validation engaged (mode=${mvMode}, score=${confidenceResult.score.toFixed(2)}, categories=${confidenceResult.triggeredCategories.join(",")})`);

          options?.onMetaValidation?.({ status: "started" });

          const useLlmMetaValidation = process.env.LLM_META_VALIDATION === "true";
          let correctionSet;
          if (useLlmMetaValidation) {
            console.log(`[Pipeline] LLM_META_VALIDATION=true — using LLM-based meta-validation`);
            correctionSet = await runMetaValidation(
              buildResult.xamlEntries,
              confidenceResult.triggeredCategories,
              options?.onProgress,
            );
          } else {
            console.log(`[Pipeline] Using deterministic meta-validators (${confidenceResult.triggeredCategories.join(",")})`);
            correctionSet = runDeterministicValidation(
              buildResult.xamlEntries,
              confidenceResult.triggeredCategories,
              options?.onProgress,
            );
          }

          mvInputTokens = correctionSet.inputTokens;
          mvOutputTokens = correctionSet.outputTokens;

          const applicationResult = applyCorrections(buildResult.xamlEntries, correctionSet);
          finalXamlEntries = applicationResult.updatedXamlEntries;

          if (applicationResult.applied > 0) {
            const preCorrectionEntries = buildResult.xamlEntries.map(e => ({ ...e }));
            let revertedCount = 0;
            for (let i = 0; i < finalXamlEntries.length; i++) {
              const entry = finalXamlEntries[i];
              try {
                const { XMLParser } = await import("fast-xml-parser");
                const parser = new XMLParser({ ignoreAttributes: false, allowBooleanAttributes: true });
                parser.parse(entry.content);
              } catch (xmlErr: any) {
                const original = preCorrectionEntries.find(e => e.name === entry.name);
                if (original) {
                  console.warn(`[Pipeline] Well-formedness check failed for ${entry.name} after corrections: ${xmlErr.message} — reverting to pre-correction version`);
                  finalXamlEntries[i] = { ...original };
                  revertedCount++;
                  pipelineWarnings.push({
                    code: "POST_MV_WELLFORMEDNESS_REVERT",
                    message: `[Post-MV] Reverted ${entry.name} to pre-correction version due to XML well-formedness failure: ${xmlErr.message}`,
                    stage: "remediating",
                    recoverable: true,
                  });
                }
              }
            }
            if (revertedCount > 0) {
              console.log(`[Pipeline] Reverted ${revertedCount} XAML file(s) to pre-correction versions due to well-formedness failures`);
            }
          }

          if (applicationResult.applied > 0 && buildResult.buffer.length > 0) {
            const rebuilt = await rebuildNupkgWithEntries(buildResult.buffer, finalXamlEntries, buildResult.archiveManifest);
            if (rebuilt) {
              finalPackageBuffer = rebuilt;
              console.log(`[Pipeline] Rebuilt .nupkg with ${applicationResult.applied} correction(s) applied (${finalPackageBuffer.length} bytes)`);
            } else {
              canonicalRebuildFailed = true;
              canonicalRebuildErrorMsg =
                `Canonical nupkg rebuild failed after ${applicationResult.applied} meta-validation correction(s). ` +
                `Cannot produce a structurally valid package with corrected XAML.`;
            }
          }

          if (applicationResult.applied > 0) {
            try {
              const xamlValidationViolations = validateXamlContent(finalXamlEntries);
              if (xamlValidationViolations.length > 0) {
                console.log(`[Pipeline] Post-correction XAML validation: ${xamlValidationViolations.length} issue(s) found`);
                for (const v of xamlValidationViolations) {
                  pipelineWarnings.push({
                    code: `POST_MV_XAML_${v.check.toUpperCase().replace(/-/g, "_")}`,
                    message: `[Post-MV] ${v.detail}`,
                    stage: "remediating",
                    recoverable: true,
                  });
                }
              }

              const projectJsonContent = buildResult.projectJsonContent || "{}";
              const revalidationResult = runQualityGate({
                xamlEntries: finalXamlEntries,
                projectJsonContent,
                targetFramework: "Windows",
                archiveManifest: buildResult.archiveManifest,
              });

              postCorrectionQualityGate = revalidationResult;
              const revalIncomplete = revalidationResult.completenessLevel === "incomplete";

              if (!revalidationResult.passed) {
                const postFixWarnings = revalidationResult.violations.filter(v => v.severity === "warning");
                const postFixErrors = revalidationResult.violations.filter(v => v.severity === "error");
                qualityGateBlocking = postFixErrors.length > 0 || revalIncomplete;
                qualityGateWarnings = postFixWarnings.map(v => v.detail);
                if (postFixErrors.length > 0) {
                  console.warn(`[Pipeline] Post-correction quality gate found ${postFixErrors.length} error(s)`);
                  for (const e of postFixErrors) {
                    pipelineWarnings.push({
                      code: "POST_MV_QG_ERROR",
                      message: `[Post-MV QG] ${e.detail}`,
                      stage: "remediating",
                      recoverable: false,
                    });
                  }
                }
                if (postFixWarnings.length > 0) {
                  console.log(`[Pipeline] Post-correction quality gate: ${postFixWarnings.length} warning(s) remain`);
                }
              } else {
                qualityGateBlocking = revalIncomplete;
                qualityGateWarnings = [];
                console.log(`[Pipeline] Post-correction quality gate: ${revalIncomplete ? "PASSED but INCOMPLETE — blocking" : "PASSED"}`);
              }
            } catch (qgErr: unknown) {
              const errMsg = qgErr instanceof Error ? qgErr.message : String(qgErr);
              console.warn(`[Pipeline] Post-correction revalidation failed: ${errMsg}`);
            }
          }

          if (applicationResult.flatStructureWarnings > 0) {
            pipelineWarnings.push({
              code: "META_VALIDATION_FLAT_STRUCTURE",
              message: `${applicationResult.flatStructureWarnings} FLAT_STRUCTURE issue(s) detected — manual review recommended`,
              stage: "remediating",
              recoverable: true,
            });
          }

          const mvStatus = applicationResult.applied > 0
            ? "fixed"
            : applicationResult.flatStructureWarnings > 0
              ? "warnings"
              : "clean";

          metaValidationResult = {
            engaged: true,
            mode: mvMode,
            confidenceScore: confidenceResult.score,
            correctionsApplied: applicationResult.applied,
            correctionsSkipped: applicationResult.skipped,
            correctionsFailed: applicationResult.failed,
            flatStructureWarnings: applicationResult.flatStructureWarnings,
            durationMs: applicationResult.durationMs + correctionSet.reviewDurationMs,
            status: mvStatus,
          };

          console.log(`[Pipeline] Meta-validation complete: ${applicationResult.applied} applied, ${applicationResult.skipped} skipped, ${applicationResult.failed} failed (${metaValidationResult.durationMs}ms) | corrections_applied=${applicationResult.applied}, meta_validations_engaged=1`);

          const completionEvent: MetaValidationEvent = {
            status: mvStatus === "fixed" ? "completed" : mvStatus === "warnings" ? "warning" : "completed",
            correctionsApplied: applicationResult.applied,
            correctionsSkipped: applicationResult.skipped,
            correctionsFailed: applicationResult.failed,
            flatStructureWarnings: applicationResult.flatStructureWarnings,
            confidenceScore: confidenceResult.score,
            durationMs: metaValidationResult.durationMs,
          };

          if (applicationResult.skipped > 0 && mvStatus !== "warnings") {
            completionEvent.status = "warning";
          }

          options?.onMetaValidation?.(completionEvent);
        } else {
          options?.onMetaValidation?.({ status: "not-needed", confidenceScore: confidenceResult.score, durationMs: 0 });
          metaValidationResult = {
            engaged: false,
            mode: mvMode,
            confidenceScore: confidenceResult.score,
            correctionsApplied: 0,
            correctionsSkipped: 0,
            correctionsFailed: 0,
            flatStructureWarnings: 0,
            durationMs: 0,
            status: "skipped",
          };
          console.log(`[Pipeline] Meta-validation skipped (mode=${mvMode}, score=${confidenceResult.score.toFixed(2)})`);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[Pipeline] Meta-validation failed: ${errMsg}`);
        pipelineWarnings.push({
          code: "META_VALIDATION_FAILED",
          message: `Meta-validation review failed: ${errMsg}`,
          stage: "remediating",
          recoverable: true,
        });
      }
    }
    if (canonicalRebuildFailed) {
      console.error(`[Pipeline] ${canonicalRebuildErrorMsg}`);
      throw new Error(canonicalRebuildErrorMsg);
    }
    tracker.complete("validation", "Validation and remediation complete");

    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, "packaging");
      } catch (e) { /* best-effort */ }
    }

    tracker.start("packaging_dhg", "Building .nupkg archive");
    if (hasNupkg) {
      tracker.complete("packaging_dhg", `Package built (${Math.round(finalPackageBuffer.length / 1024)}KB)`, {
        sizeBytes: finalPackageBuffer.length,
      });
    } else {
      tracker.fail("packaging_dhg", "Package build produced no output");
    }

    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, "dhg_generating");
      } catch (e) { /* best-effort */ }
    }

    tracker.start("packaging_dhg_guide", "Generating Developer Handoff Guide");
    tracker.heartbeat("packaging_dhg_guide", () => "Analyzing workflows and writing guide");
    const dhgResult = buildDhgFromBuildResult(enriched, ctx, buildResult, finalXamlEntries, mode);
    tracker.complete("packaging_dhg_guide", "Handoff Guide generated", {
      analysisCount: dhgResult.analysisReports.length,
    });

    const orchestratorArtifacts = enriched.internal?.orchestratorArtifacts || enriched.internal?.extractedArtifacts || {};
    const deliveryRecommendation = recommendUiPathDelivery({
      pkg: enriched,
      orchestratorArtifacts,
    });
    const { testCases, testSets } = extractUiPathTestDesign(orchestratorArtifacts);

    tracker.start("test_automation_bundle", "Building executable UiPath Tests project");
    const testAutomationArtifact = buildUiPathTestAutomationArtifact({
      projectName: dhgResult.projectName,
      version: ver,
      testCases,
      testSets,
    });
    tracker.complete(
      "test_automation_bundle",
      testAutomationArtifact
        ? `Executable UiPath Tests project built (${testAutomationArtifact.workflowCount} test workflow${testAutomationArtifact.workflowCount === 1 ? "" : "s"})`
        : "No executable UiPath Tests project generated",
      {
        workflowCount: testAutomationArtifact?.workflowCount || 0,
      },
    );

    tracker.start("solution_bundle", "Building native UiPath .uis solution export");
    const solutionArtifact = buildUiPathSolutionArtifact({
      pkg: enriched,
      buildResult,
      packageBuffer: finalPackageBuffer,
      projectName: dhgResult.projectName,
      dhgContent: dhgResult.dhgContent,
      ctx,
      version: ver,
      deliveryRecommendation,
      testCases,
      testSets,
    });
    tracker.complete("solution_bundle", `Native UiPath .uis solution export built (${Math.round(solutionArtifact.buffer.length / 1024)}KB)`, {
      sizeBytes: solutionArtifact.buffer.length,
      componentCount: solutionArtifact.components.length,
    });

    if (pipelineWarnings.length > 0) {
      for (const w of pipelineWarnings) {
        tracker.warn(w.stage, w.message);
      }
    }

    const entryPointIsStubbed = buildResult.outcomeReport?.remediations.some(
      r => (r.remediationCode === "STUB_WORKFLOW_BLOCKING" || r.remediationCode === "STUB_WORKFLOW_GENERATOR_FAILURE") && (r.file === "Main.xaml" || r.file === "Main")
    ) ?? false;
    const hasStructuralBlockers = buildResult.outcomeReport?.studioCompatibility?.some(
      sc => sc.level === "studio-blocked"
    ) ?? false;
    const hasDegradation = downgrades.length > 0 || usedAIFallback || entryPointIsStubbed || hasStructuralBlockers;
    const hasStructuralWarnings = buildResult.outcomeReport?.studioCompatibility?.some(
      sc => sc.level === "studio-warnings"
    ) ?? false;
    const finalStatus: PackageStatus = !hasNupkg
      ? "FAILED"
      : hasDegradation
        ? "FALLBACK_READY"
        : (hasStructuralWarnings || pipelineWarnings.length > 0 || metaValidationResult?.flatStructureWarnings)
          ? "READY_WITH_WARNINGS"
          : "READY";

    if (options?.runId) {
      try {
        await storage.updateGenerationRunStatus(options.runId, finalStatus === "FAILED" ? "failed" : "completed");
      } catch (e) { /* best-effort */ }
    }

    tracker.start("complete", "Finalizing pipeline");
    tracker.complete("complete", `Pipeline complete — ${finalStatus}`, {
      status: finalStatus,
      workflowCount: buildResult.xamlEntries.length,
      warningCount: pipelineWarnings.length,
      downgradeCount: downgrades.length,
      usedAIFallback,
      templateComplianceScore,
    });

    const result: PipelineResult = {
      packageBuffer: finalPackageBuffer,
      solutionArtifact,
      testAutomationArtifact,
      deliveryRecommendation,
      testCases,
      testSets,
      analysisReports: dhgResult.analysisReports,
      gaps: buildResult.gaps,
      usedPackages: buildResult.usedPackages,
      qualityGateResult: postCorrectionQualityGate || buildResult.qualityGateResult,
      cacheHit: buildResult.cacheHit,
      dhgContent: dhgResult.dhgContent,
      projectName: dhgResult.projectName,
      xamlEntries: finalXamlEntries,
      dependencyMap: buildResult.dependencyMap,
      archiveManifest: buildResult.archiveManifest,
      qualityGateBlocking,
      qualityGateWarnings,
      generationMode: mode,
      usedFallbackStubs: buildResult.usedFallbackStubs,
      referencedMLSkillNames: buildResult.referencedMLSkillNames || [],
      warnings: pipelineWarnings,
      downgrades,
      usedAIFallback,
      status: finalStatus,
      templateComplianceScore,
      metaValidationResult,
      outcomeReport: buildResult.outcomeReport,
    };

    evictOldestPipelineCacheEntry();
    const degradationKey = (downgrades.length > 0 || usedAIFallback) ? "degraded" : "clean";
    const finalCacheKey = `${ideaId}:${mode}:${mvMode}:${degradationKey}`;
    pipelineCache.set(finalCacheKey, { ...result, fingerprint: fp });
    try {
      const mvTokens = { input: mvInputTokens, output: mvOutputTokens };
      const totalXamlLength = finalXamlEntries.reduce((sum, e) => sum + e.content.length, 0);
      const estimatedAssemblyOutputTokens = Math.ceil(totalXamlLength / 3.5);
      const estimatedAssemblyInputTokens = Math.ceil(estimatedAssemblyOutputTokens * 1.5);
      const assemblyTokens = { input: estimatedAssemblyInputTokens, output: estimatedAssemblyOutputTokens };
      const totalTokens = {
        input: assemblyTokens.input + mvTokens.input,
        output: assemblyTokens.output + mvTokens.output,
      };
      const assemblyCost = calculateEstimatedCost(assemblyTokens.input, assemblyTokens.output, "default");
      const mvCost = mvInputTokens > 0 ? calculateEstimatedCost(mvTokens.input, mvTokens.output, "haiku") : 0;
      const estimatedCost = assemblyCost + mvCost;
      await recordGenerationMetrics({
        id: `gen-${ideaId}-${Date.now()}`,
        timestamp: new Date(),
        ideaId,
        decompositionTokens: { input: 0, output: 0 },
        assemblyTokens,
        metaValidationTokens: mvTokens,
        totalTokens,
        estimatedCostUsd: estimatedCost,
        templateComplianceScore: templateComplianceScore || 0,
        confidenceScore: metaValidationResult?.confidenceScore || 0,
        metaValidationEngaged: metaValidationResult?.engaged || false,
        metaValidationMode: mvMode,
        correctionsApplied: metaValidationResult?.correctionsApplied || 0,
        finalStatus,
      });
    } catch (metricsErr: unknown) {
      const errMsg = metricsErr instanceof Error ? metricsErr.message : String(metricsErr);
      console.warn(`[Pipeline] Failed to record generation metrics: ${errMsg}`);
    }

    try {
      const pipelineStartTime = (tracker as any).startTimes?.get("spec_generation") || Date.now();
      const durationMs = Date.now() - pipelineStartTime;
      const transitiveDepsCount = qgResult
        ? qgResult.violations.filter((v: any) =>
            v.check === "transitive-dependency-missing" || v.check === "error-activity-reference" || v.check === "unresolved-type-argument"
          ).length
        : 0;
      const qgRunCount = 1 + downgrades.length;
      const healthMetrics = computePipelineHealthFromResult(result, ideaId, durationMs, qgRunCount, transitiveDepsCount);
      await recordPipelineHealth(healthMetrics);
    } catch (healthErr: unknown) {
      const errMsg = healthErr instanceof Error ? healthErr.message : String(healthErr);
      console.warn(`[Pipeline] Failed to record pipeline health: ${errMsg}`);
    }

    console.log(`[Pipeline] Cached result for ${ideaId} (mode=${mode}, fingerprint ${fp}, ${finalPackageBuffer.length} bytes, status=${finalStatus}, warnings=${pipelineWarnings.length}, templateCompliance=${templateComplianceScore ?? "N/A"})`);

    return result;
  } finally {
    tracker.cleanup();
  }
}

export async function generateUiPathPackage(
  ideaId: string,
  pkg: UiPathPackageSpec,
  options?: {
    version?: string;
    generationMode?: GenerationMode;
    onProgress?: (message: string) => void;
    onMetaValidation?: (event: MetaValidationEvent) => void;
    onPipelineProgress?: PipelineProgressCallback;
    preloadedContext?: IdeaContext;
    metaValidationMode?: MetaValidationMode;
    maxDowngradeAttempts?: number;
    _downgradeAttempt?: number;
    _accumulatedDowngrades?: DowngradeEvent[];
    _accumulatedWarnings?: PipelineWarning[];
    _usedAIFallback?: boolean;
    forceRebuild?: boolean;
  },
): Promise<PipelineResult> {
  const ver = options?.version || computeVersion();
  const mode: GenerationMode = options?.generationMode || "full_implementation";
  const mvMode: MetaValidationMode = options?.metaValidationMode || "Auto";
  const pipelineWarnings: PipelineWarning[] = options?._accumulatedWarnings ? [...options._accumulatedWarnings] : [];
  const downgrades: DowngradeEvent[] = options?._accumulatedDowngrades ? [...options._accumulatedDowngrades] : [];
  let usedAIFallback = options?._usedAIFallback || false;
  const forceRebuild = options?.forceRebuild || false;

  const noop: PipelineProgressCallback = () => {};
  const tracker = new PipelineStageTracker(options?.onPipelineProgress || noop);

  try {
    tracker.start("decomposition", "Computing fingerprint and checking cache");
    const ctx = options?.preloadedContext || await loadIdeaContext(ideaId);
    const fp = computeFingerprint(pkg, ctx.sdd?.content || "", ctx.mapNodes, ctx.processEdges);
    const degradationKey = (downgrades.length > 0 || usedAIFallback) ? "degraded" : "clean";
    const cacheKey = `${ideaId}:${mode}:${mvMode}:${degradationKey}`;
    const cached = pipelineCache.get(cacheKey);
    if (forceRebuild) {
      console.log(`[Pipeline Cache] FORCE REBUILD requested for ${cacheKey} — bypassing pipeline cache`);
      pipelineCache.delete(cacheKey);
    } else if (cached && cached.fingerprint === fp) {
      tracker.complete("decomposition", "Cache hit — serving cached result");
      tracker.cleanup();
      return cached;
    }
    const preComplexity = estimateComplexityFromContext(ctx.sdd?.content, ctx.mapNodes);
    tracker.start("pre_complexity_estimation", "Estimating pre-generation complexity");
    tracker.complete("pre_complexity_estimation", `Pre-generation complexity: ${preComplexity.tier} (${preComplexity.budget.label})`, {
      tier: preComplexity.tier,
      score: preComplexity.score,
      budgetLabel: preComplexity.budget.label,
      budgetMin: preComplexity.budget.min,
      budgetMax: preComplexity.budget.max,
      reasons: preComplexity.reasons,
    });
    console.log(`[Pipeline] Pre-generation complexity: tier=${preComplexity.tier}, score=${preComplexity.score}, budget=${preComplexity.budget.label}, reasons=${preComplexity.reasons.join("; ")}`);

    const workflowCount = (pkg as any).workflows?.length || 0;
    tracker.complete("decomposition", `Decomposed into ${workflowCount} workflow(s)`, { workflowCount });

    const withinBudget = workflowCount >= preComplexity.budget.min && workflowCount <= preComplexity.budget.max;
    tracker.start("workflow_budget_check", "Checking workflow count against budget");
    tracker.complete("workflow_budget_check", withinBudget
      ? `Workflow count (${workflowCount}) is within expected range (${preComplexity.budget.label})`
      : `Workflow count (${workflowCount}) is outside expected range (${preComplexity.budget.label})`, {
      actualCount: workflowCount,
      expectedMin: preComplexity.budget.min,
      expectedMax: preComplexity.budget.max,
      withinBudget,
      preGenerationTier: preComplexity.tier,
    });
    console.log(`[Pipeline] Workflow budget check: actual=${workflowCount}, expected=${preComplexity.budget.label}, withinBudget=${withinBudget}`);

    const complexity = classifyComplexity(
      pkg,
      ctx.sdd?.content,
      ctx.mapNodes,
    );
    tracker.start("complexity_classification", `Classifying process complexity`);
    const complexityPath = complexity.streamlined ? "streamlined" : "full pipeline";
    tracker.complete("complexity_classification", `Complexity: ${complexity.tier} (${complexityPath})`, {
      complexityTier: complexity.tier,
      complexityScore: complexity.score,
      streamlined: complexity.streamlined,
      reasons: complexity.reasons,
    });
    console.log(`[Pipeline] Complexity classification: tier=${complexity.tier}, score=${complexity.score}, streamlined=${complexity.streamlined}, reasons=${complexity.reasons.join("; ")}`);

    let specResult: SpecGenerationResult;
    try {
      specResult = await generateWorkflowSpecs(ideaId, pkg, {
        generationMode: mode,
        onProgress: options?.onProgress,
        onPipelineProgress: options?.onPipelineProgress,
        preloadedContext: ctx,
        complexityTier: complexity.tier,
      });
    } catch (specErr) {
      throw specErr;
    }

    specResult.pipelineWarnings.push(...pipelineWarnings);
    specResult.usedAIFallback = specResult.usedAIFallback || usedAIFallback;

    try {
      const result = await compilePackageFromSpecs(ideaId, specResult, pkg, {
        version: ver,
        generationMode: mode,
        onProgress: options?.onProgress,
        onMetaValidation: options?.onMetaValidation,
        onPipelineProgress: options?.onPipelineProgress,
        metaValidationMode: mvMode,
        maxDowngradeAttempts: options?.maxDowngradeAttempts,
        _downgradeAttempt: options?._downgradeAttempt,
        _accumulatedDowngrades: downgrades,
        _accumulatedWarnings: options?._accumulatedWarnings,
        complexityTier: complexity.tier,
        forceRebuild,
      });

      return result;
    } catch (compileErr) {
      throw compileErr;
    }
  } finally {
    tracker.cleanup();
  }
}

export function getCachedPipelineResult(ideaId: string, mode?: GenerationMode): PipelineResult | null {
  let bestMatch: PipelineResult | null = null;
  for (const [key, value] of pipelineCache.entries()) {
    const matchesId = mode
      ? key.startsWith(`${ideaId}:${mode}:`)
      : key.startsWith(`${ideaId}:`);
    if (matchesId) {
      if (key.endsWith(":clean")) return value;
      if (!bestMatch) bestMatch = value;
    }
  }
  return bestMatch;
}

export async function generateDhg(
  ideaId: string,
  pkg: UiPathPackage,
): Promise<DhgResult> {
  const cached = getCachedPipelineResult(ideaId);
  if (cached) {
    console.log(`[Pipeline] Serving cached DHG for ${ideaId}`);
    return {
      dhgContent: cached.dhgContent,
      projectName: cached.projectName,
      analysisReports: cached.xamlEntries.map(e => {
        const { report } = analyzeAndFix(e.content);
        return { fileName: e.name, report };
      }),
    };
  }

  console.log(`[Pipeline] No cached result for DHG — running full pipeline for ${ideaId}`);
  const pipelineResult = await generateUiPathPackage(ideaId, pkg);

  return {
    dhgContent: pipelineResult.dhgContent,
    projectName: pipelineResult.projectName,
    analysisReports: pipelineResult.xamlEntries.map(e => {
      const { report } = analyzeAndFix(e.content);
      return { fileName: e.name, report };
    }),
  };
}

export interface BuildPipelineOptions {
  generationMode?: GenerationMode;
  metaValidationMode?: MetaValidationMode;
  onProgress?: (message: string) => void;
  onPipelineProgress?: PipelineProgressCallback;
  onMetaValidation?: (event: MetaValidationEvent) => void;
  preloadedContext?: IdeaContext;
  version?: string;
  forceRebuild?: boolean;
}

export async function runBuildPipeline(
  ideaId: string,
  pkg: UiPathPackageSpec,
  options?: BuildPipelineOptions,
): Promise<PipelineResult> {
  return generateUiPathPackage(ideaId, pkg, {
    version: options?.version || computeVersion(),
    generationMode: options?.generationMode,
    metaValidationMode: options?.metaValidationMode,
    onProgress: options?.onProgress,
    onPipelineProgress: options?.onPipelineProgress,
    onMetaValidation: options?.onMetaValidation,
    preloadedContext: options?.preloadedContext,
    forceRebuild: options?.forceRebuild,
  });
}

export { QualityGateError } from "./uipath-integration";

export function normalizeAndAnalyzeXaml(
  xaml: string,
  targetFramework: "Windows" | "Portable" = "Windows",
): { normalized: string; report: AnalysisReport } {
  const compliant = normalizeXamlCompliance(xaml, targetFramework);
  const { fixed, report } = analyzeAndFix(compliant);
  return { normalized: fixed, report };
}

export { normalizeAndAnalyzeXaml as normalizeXaml };

export { normalizeXamlCompliance as makeUiPathCompliant, analyzeAndFix };
