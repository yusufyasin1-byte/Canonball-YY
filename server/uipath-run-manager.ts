import { randomUUID } from "crypto";
import { storage } from "./storage";
import { documentStorage } from "./document-storage";
import { processMapStorage } from "./process-map-storage";
import { chatStorage } from "./replit_integrations/chat/storage";
import { getCodeLLM, SDD_LLM_TIMEOUT_MS } from "./lib/llm";
import { RunLogger } from "./lib/run-logger";
import { runBuildPipeline, getCachedPipelineResult, findUiPathMessage, type IdeaContext, type PipelineResult } from "./uipath-pipeline";
import type { PipelineProgressEvent, PipelineProgressCallback } from "./uipath-pipeline";
import type { UipathGenerationRun } from "@shared/schema";
import { sanitizeAndParseJson } from "./lib/json-utils";
import { uipathPackageSchema } from "./types/uipath-package";
import { UIPATH_PROMPT, repairTruncatedPackageJson } from "./uipath-prompts";
import { QualityGateError } from "./uipath-integration";
import type { MetaValidationMode } from "./meta-validation";
import { generateDecomposedSpec } from "./uipath-spec-decomposer";
import { estimateComplexityFromContext } from "./complexity-classifier";

export type TriggerSource = "manual" | "chat" | "api";

export interface RunCallbacks {
  onProgress?: (message: string) => void;
  onPipelineEvent?: PipelineProgressCallback;
  onMetaValidation?: (event: any) => void;
  onPackageResolved?: (packageJson: any) => void;
  onComplete?: (result: RunResult) => void;
  onFail?: (error: string, context?: Record<string, any>) => void;
}

export interface RunOptions {
  generationMode?: "baseline_openable" | "full_implementation";
  metaValidationMode?: MetaValidationMode;
  forceRegenerate?: boolean;
  callbacks?: RunCallbacks;
}

export interface RunResult {
  status: string;
  packageJson: any;
  pipelineResult: PipelineResult | null;
  cached: boolean;
}

interface ActiveRun {
  runId: string;
  ideaId: string;
  events: PipelineProgressEvent[];
  sseListeners: Set<(event: PipelineProgressEvent) => void>;
  completed: boolean;
  finalStatus?: string;
  error?: string;
}

const activeRuns = new Map<string, ActiveRun>();
const ideaActiveRunMap = new Map<string, string>();

export function getActiveRunForIdea(ideaId: string): ActiveRun | undefined {
  const runId = ideaActiveRunMap.get(ideaId);
  if (!runId) return undefined;
  return activeRuns.get(runId);
}

export function getActiveRun(runId: string): ActiveRun | undefined {
  return activeRuns.get(runId);
}

export function subscribeToRun(runId: string, listener: (event: PipelineProgressEvent) => void): () => void {
  const run = activeRuns.get(runId);
  if (!run) return () => {};
  run.sseListeners.add(listener);
  return () => {
    run.sseListeners.delete(listener);
  };
}

export async function reconcileOrphanedRuns(): Promise<void> {
  const orphaned = await storage.failOrphanedRuns();
  if (orphaned.length > 0) {
    for (const run of orphaned) {
      console.log(`[RunManager] Reconciled orphaned run ${run.runId} for idea ${run.ideaId}`);
    }
    console.log(`[RunManager] Startup reconciliation complete: ${orphaned.length} orphaned run(s) cleaned up`);
  } else {
    console.log("[RunManager] Startup reconciliation complete: no orphaned runs found");
  }
}

const STALE_THRESHOLD_MS = 2 * 60 * 1000;
const HARD_TIMEOUT_MS = 10 * 60 * 1000;

async function checkDbInProgress(ideaId: string): Promise<boolean> {
  const latest = await storage.getLatestGenerationRunForIdea(ideaId);
  if (latest && latest.status === "running" && !latest.completedAt) {
    const now = Date.now();
    const createdAgeMs = now - new Date(latest.createdAt).getTime();
    const updatedAgeMs = now - new Date(latest.updatedAt).getTime();

    if (createdAgeMs >= HARD_TIMEOUT_MS) {
      await storage.failGenerationRun(latest.runId, "timed_out");
      console.warn(`[RunManager] Cleaned up timed-out run ${latest.runId} for idea ${ideaId} (age: ${Math.round(createdAgeMs / 1000)}s)`);
      return false;
    }

    if (updatedAgeMs >= STALE_THRESHOLD_MS) {
      await storage.failGenerationRun(latest.runId, "stale_no_progress");
      console.warn(`[RunManager] Cleaned up stale run ${latest.runId} for idea ${ideaId} (no heartbeat for ${Math.round(updatedAgeMs / 1000)}s)`);
      return false;
    }

    return true;
  }
  return false;
}

export async function startUiPathGenerationRun(
  ideaId: string,
  triggerSource: TriggerSource,
  options?: RunOptions,
): Promise<{ runId: string; run: UipathGenerationRun }> {
  const existingRunId = ideaActiveRunMap.get(ideaId);
  if (existingRunId) {
    const existingActive = activeRuns.get(existingRunId);
    if (existingActive && !existingActive.completed) {
      throw new Error("A generation run is already in progress for this idea");
    }
  }

  const dbInProgress = await checkDbInProgress(ideaId);
  if (dbInProgress) {
    throw new Error("A generation run is already in progress for this idea");
  }

  const runId = randomUUID();

  let dbRun: UipathGenerationRun;
  try {
    dbRun = await storage.createGenerationRun({
      ideaId,
      runId,
      status: "running",
      generationMode: options?.generationMode || undefined,
      triggeredBy: triggerSource,
      currentPhase: "initializing",
      phaseProgress: null,
      outcomeReport: null,
      dhgContent: null,
      errorMessage: null,
    });
  } catch (insertErr: any) {
    if (insertErr?.code === "23505" || insertErr?.message?.includes("unique") || insertErr?.message?.includes("duplicate")) {
      throw new Error("A generation run is already in progress for this idea");
    }
    throw insertErr;
  }

  const activeRun: ActiveRun = {
    runId,
    ideaId,
    events: [],
    sseListeners: new Set(),
    completed: false,
  };
  activeRuns.set(runId, activeRun);
  ideaActiveRunMap.set(ideaId, runId);

  executeRun(runId, ideaId, options).catch((err) => {
    console.error(`[RunManager] Unhandled error in run ${runId}:`, err);
  });

  return { runId, run: dbRun };
}

const HEARTBEAT_INTERVAL_MS = 30_000;

async function executeRun(
  runId: string,
  ideaId: string,
  options?: RunOptions,
): Promise<void> {
  console.log(`[RunManager] executeRun started — runId=${runId}, ideaId=${ideaId}`);
  const activeRun = activeRuns.get(runId)!;
  const callbacks = options?.callbacks;
  const phaseEvents: PipelineProgressEvent[] = [];
  let _pipelineProgressCallback: PipelineProgressCallback | null = null;

  const runLoggerOnlyStages = new Set(["sdd_validation", "cache_hit", "build_pipeline"]);

  const runLogger = new RunLogger(runId, "uipath_package", (stageEvent) => {
    if (!_pipelineProgressCallback) return;
    if (stageEvent.stage.startsWith("pipeline_")) return;
    if (!runLoggerOnlyStages.has(stageEvent.stage)) return;
    if (stageEvent.type === "stage_start") {
      _pipelineProgressCallback({
        type: "started",
        stage: stageEvent.stage,
        message: `Stage started: ${stageEvent.stage}`,
      });
    } else if (stageEvent.type === "stage_end") {
      const eventType = stageEvent.outcome === "failed" ? "failed" as const
        : stageEvent.outcome === "degraded" ? "warning" as const
        : "completed" as const;
      _pipelineProgressCallback({
        type: eventType,
        stage: stageEvent.stage,
        message: stageEvent.error || `Stage ${stageEvent.outcome}: ${stageEvent.stage}`,
        elapsed: stageEvent.durationMs ? Math.round(stageEvent.durationMs / 100) / 10 : undefined,
      });
    }
  });

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  const startHeartbeat = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      storage.updateGenerationRunStatus(runId, "running").catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
  };

  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const pipelineProgressCallback: PipelineProgressCallback = (event) => {
    phaseEvents.push(event);
    activeRun.events.push(event);

    Array.from(activeRun.sseListeners).forEach(listener => {
      try { listener(event); } catch {}
    });

    if (callbacks?.onPipelineEvent) {
      try {
        callbacks.onPipelineEvent(event);
      } catch (cbErr: any) {
        console.error(`[Observer] pipelineProgressCallback: onPipelineEvent callback error for runId=${runId}:`, cbErr?.message || cbErr);
      }
    }

    const isSpecStage = event.stage?.startsWith("spec_");
    if (!isSpecStage) {
      if (event.type === "started" && event.stage) {
        runLogger.stageStart(`pipeline_${event.stage}`, event.context ? { ...event.context } : undefined);
      } else if (event.type === "completed" && event.stage) {
        runLogger.stageEnd(`pipeline_${event.stage}`, "succeeded", event.context ? { ...event.context } : undefined);
      } else if (event.type === "failed" && event.stage) {
        runLogger.stageEnd(`pipeline_${event.stage}`, "failed", event.context ? { ...event.context } : undefined, event.message);
      } else if (event.type === "warning" && event.stage) {
        runLogger.recordFallback(`pipeline_${event.stage}`, event.message || "warning");
      }
    }

    storage.updateGenerationRunStatus(runId, "running", event.stage).catch(() => {});

    if (phaseEvents.length % 5 === 0 || event.type === "completed" || event.type === "failed") {
      storage.updateGenerationRunPhaseProgress(runId, JSON.stringify(phaseEvents.slice(-50))).catch(() => {});
    }
  };
  _pipelineProgressCallback = pipelineProgressCallback;

  const emitProgress = (message: string) => {
    if (callbacks?.onProgress) {
      try { callbacks.onProgress(message); } catch {}
    }
  };

  let packageJson: any = null;

  startHeartbeat();

  try {
    runLogger.stageStart("sdd_validation");
    await storage.updateGenerationRunStatus(runId, "running", "sdd_validation");
    console.log(`[RunManager] Run ${runId}: SDD validation phase started`);
    emitProgress("Loading idea and documents...");

    const sddApproval = await documentStorage.getApproval(ideaId, "SDD");
    if (!sddApproval) {
      throw new RunError("SDD must be approved first", "precondition");
    }
    const sdd = await documentStorage.getDocument(sddApproval.documentId);
    if (!sdd) {
      throw new RunError("Approved SDD document not found", "precondition");
    }

    if (sdd.artifactsValid === false) {
      throw new RunError("SDD is missing valid deployment artifacts. Please revise the SDD to regenerate the artifacts section before generating a package.", "precondition");
    }

    if (sdd.artifactsValid === null || sdd.artifactsValid === undefined) {
      const { parseArtifactBlock } = await import("./lib/artifact-parser");
      const hasBlock = parseArtifactBlock(sdd.content);
      if (!hasBlock) {
        throw new RunError("SDD is missing deployment artifacts block. Please revise the SDD to regenerate the artifacts section.", "precondition");
      }
      console.log(`[RunManager] Run ${runId}: Legacy SDD — artifact block present (lightweight parse check passed)`);
    } else {
      console.log(`[RunManager] Run ${runId}: SDD artifact block validated (stored artifactsValid=true)`);
    }

    const idea = await storage.getIdea(ideaId);
    if (!idea) {
      throw new RunError("Idea not found", "precondition");
    }

    console.log(`[RunManager] Run ${runId}: SDD validation passed`);
    runLogger.stageEnd("sdd_validation", "succeeded");

    const existingMessages = await chatStorage.getMessagesByIdeaId(ideaId);
    const existingUiPath = [...existingMessages].reverse().find((m: any) => m.content.startsWith("[UIPATH:"));

    if (existingUiPath && !options?.forceRegenerate) {
      try {
        const existingData = JSON.parse(existingUiPath.content.slice(8, -1));
        if ((existingData.workflows || []).length > 0) {
          packageJson = existingData;

          const cachedResult = getCachedPipelineResult(ideaId);
          if (cachedResult) {
            if (callbacks?.onPackageResolved) callbacks.onPackageResolved(packageJson);
            if (callbacks?.onComplete) {
              callbacks.onComplete({
                status: cachedResult.status || "READY",
                packageJson,
                pipelineResult: cachedResult,
                cached: true,
              });
            }
            runLogger.stageStart("cache_hit");
            runLogger.stageEnd("cache_hit", "succeeded", { cached: true });
            const cachedOutcome = runLogger.buildOutcomeSummary();
            await runLogger.flush();
            await finishRun(runId, activeRun, phaseEvents, {
              status: "completed",
              outcomeReport: JSON.stringify({ ...cachedOutcome, cached: true }),
              generationMode: cachedResult.generationMode,
            });
            return;
          }
        }
      } catch {}
    }

    if (!packageJson) {
      runLogger.stageStart("spec_generation");
      await storage.updateGenerationRunStatus(runId, "running", "spec_generation");
      console.log(`[RunManager] Run ${runId}: Spec generation phase started`);

      runLogger.stageStart("spec_context_loading");
      pipelineProgressCallback({ type: "started", stage: "spec_context_loading", message: "Loading SDD, PDD and process map" });
      const pdd = await documentStorage.getLatestDocument(ideaId, "PDD");
      const toBeNodes = await processMapStorage.getNodesByIdeaId(ideaId, "to-be");
      const asIsNodes = await processMapStorage.getNodesByIdeaId(ideaId, "as-is");
      const mapNodes = toBeNodes.length > 0 ? toBeNodes : asIsNodes;
      const mapSummary = mapNodes.map((n: any) => ({ name: n.name, type: n.nodeType, role: n.role, system: n.system, description: n.description }));
      runLogger.stageEnd("spec_context_loading", "succeeded", { hasPdd: !!pdd, mapNodeCount: mapSummary.length });
      pipelineProgressCallback({ type: "completed", stage: "spec_context_loading", message: "Context loaded", context: { hasPdd: !!pdd, mapNodeCount: mapSummary.length } });

      runLogger.stageStart("spec_prompt_assembly");
      pipelineProgressCallback({ type: "started", stage: "spec_prompt_assembly", message: "Preparing scaffold prompt" });

      const preComplexity = estimateComplexityFromContext(sdd.content, mapNodes);
      console.log(`[RunManager] Run ${runId}: Pre-generation complexity: tier=${preComplexity.tier}, score=${preComplexity.score}, budget=${preComplexity.budget.label}, reasons=${preComplexity.reasons.join("; ")}`);
      runLogger.stageStart("pre_complexity_estimation");
      runLogger.stageEnd("pre_complexity_estimation", "succeeded", {
        tier: preComplexity.tier,
        score: preComplexity.score,
        budgetLabel: preComplexity.budget.label,
        reasons: preComplexity.reasons,
      });
      pipelineProgressCallback({ type: "completed", stage: "pre_complexity_estimation", message: `Pre-generation complexity: ${preComplexity.tier} (${preComplexity.budget.label})`, context: { tier: preComplexity.tier, score: preComplexity.score, budget: preComplexity.budget.label } });

      let systemCtx = `You are a Senior Developer and Solution Architect generating a production-ready UiPath package for "${idea.title}". You enforce production engineering rigor: strict variable naming conventions (camelCase locals, PascalCase arguments), meaningful logging at every decision point and exception handler (not just "Error occurred"), cohesive workflow boundaries where each .xaml owns a meaningful business sub-process, realistic UI selectors with fallback strategies, and error handling beyond generic TryCatch — you anticipate specific runtime failures (selector timeouts, stale element references, API rate limits, file locks, credential expiry) and handle them deliberately with inline TryCatch and RetryScope (not separate error-handler .xaml files). You comply strictly with the output JSON schemas — no extra fields, no missing required fields, no prose outside the JSON.\n\nComplexity Assessment: ${preComplexity.tier} — ${preComplexity.budget.label}\n${preComplexity.budget.guidance}\n\nApproved SDD:\n${sdd.content}`;
      if (pdd) systemCtx += `\n\nApproved PDD:\n${pdd.content}`;
      if (mapSummary.length > 0) systemCtx += `\n\nProcess Map Steps:\n${JSON.stringify(mapSummary)}`;
      runLogger.stageEnd("spec_prompt_assembly", "succeeded");
      pipelineProgressCallback({ type: "completed", stage: "spec_prompt_assembly", message: "Scaffold prompt assembled" });

      try {
        const decomposedResult = await generateDecomposedSpec({
          systemContext: systemCtx,
          runId,
          runLogger,
          onProgress: (msg: string) => emitProgress(msg),
          onPipelineProgress: pipelineProgressCallback,
          complexityGuidance: preComplexity.budget.guidance,
        });

        packageJson = decomposedResult.packageSpec;

        const decompositionMetrics = decomposedResult.metrics;
        const actualWorkflowCount = packageJson.workflows.length;
        const withinBudget = actualWorkflowCount >= preComplexity.budget.min && actualWorkflowCount <= preComplexity.budget.max;
        console.log(`[RunManager] Run ${runId}: Workflow budget check: actual=${actualWorkflowCount}, expected=${preComplexity.budget.label}, withinBudget=${withinBudget}`);
        runLogger.stageStart("workflow_budget_check");
        runLogger.stageEnd("workflow_budget_check", "succeeded", {
          preGenerationTier: preComplexity.tier,
          budgetLabel: preComplexity.budget.label,
          budgetMin: preComplexity.budget.min,
          budgetMax: preComplexity.budget.max,
          actualCount: actualWorkflowCount,
          withinBudget,
        });
        pipelineProgressCallback({
          type: "completed",
          stage: "workflow_budget_check",
          message: withinBudget
            ? `Workflow count (${actualWorkflowCount}) is within expected range (${preComplexity.budget.label})`
            : `Workflow count (${actualWorkflowCount}) is outside expected range (${preComplexity.budget.label})`,
          context: {
            preGenerationTier: preComplexity.tier,
            budgetGuidanceApplied: preComplexity.budget.label,
            actualCount: actualWorkflowCount,
            withinBudget,
          },
        });

        runLogger.stageEnd("spec_generation", "succeeded", {
          decomposed: true,
          workflowCount: actualWorkflowCount,
          stubCount: decompositionMetrics.stubCount,
          totalLlmCalls: decompositionMetrics.totalLlmCalls,
          scaffoldDurationMs: decompositionMetrics.scaffoldDurationMs,
          totalElapsedMs: decompositionMetrics.totalElapsedMs,
          perWorkflow: decompositionMetrics.perWorkflow,
        });

        runLogger.stageStart("spec_merge");
        pipelineProgressCallback({ type: "started", stage: "spec_merge", message: "Validating merged package specification" });
        emitProgress("Validating merged package specification...");
        runLogger.stageEnd("spec_merge", "succeeded", {
          workflowCount: packageJson.workflows.length,
          decomposed: true,
        });
        pipelineProgressCallback({
          type: "completed",
          stage: "spec_merge",
          message: `Specification validated — ${packageJson.workflows.length} workflow(s)`,
          context: { workflowCount: packageJson.workflows.length },
        });
      } catch (decompErr: any) {
        runLogger.stageEnd("spec_generation", "failed", undefined, decompErr?.message);
        pipelineProgressCallback({ type: "failed", stage: "spec_generation", message: decompErr?.message || "Spec generation failed" });
        throw new RunError(
          `Package spec generation failed: ${decompErr?.message || "Unknown error"}. Please try again.`,
          "llm_parse",
        );
      }

      if (!packageJson.workflows || packageJson.workflows.length === 0) {
        pipelineProgressCallback({ type: "failed", stage: "spec_merge", message: "Package has no workflows" });
        throw new RunError("AI generated a package with no workflows. Please try again.", "llm_parse");
      }

      const workflowCount = packageJson.workflows.length;
      runLogger.stageStart("spec_handoff");
      pipelineProgressCallback({ type: "started", stage: "spec_handoff", message: "Spec generation complete, handing off to build pipeline" });
      runLogger.stageEnd("spec_handoff", "succeeded");
      pipelineProgressCallback({ type: "completed", stage: "spec_handoff", message: `Handing off ${workflowCount} workflow(s) to build pipeline` });
    }

    if (callbacks?.onPackageResolved) callbacks.onPackageResolved(packageJson);

    runLogger.stageStart("build_pipeline");
    await storage.updateGenerationRunStatus(runId, "running", "build_pipeline");
    console.log(`[RunManager] Run ${runId}: build pipeline phase started`);
    emitProgress("Pre-building .nupkg with AI enrichment...");

    const sddDoc = await documentStorage.getLatestDocument(ideaId, "SDD");
    const pddDoc = await documentStorage.getLatestDocument(ideaId, "PDD");
    const toBeN = await processMapStorage.getNodesByIdeaId(ideaId, "to-be");
    const asIsN = await processMapStorage.getNodesByIdeaId(ideaId, "as-is");
    const mNodes = toBeN.length > 0 ? toBeN : asIsN;
    const mVariant = toBeN.length > 0 ? "to-be" : "as-is";
    let pEdges: any[] = [];
    if (mNodes.length > 0) {
      pEdges = await processMapStorage.getEdgesByIdeaId(ideaId, mVariant as "to-be" | "as-is");
    }
    const dsdDoc = await documentStorage.getLatestDocument(ideaId, "DSD");
    const preloadedContext: IdeaContext = { idea, sdd: sddDoc, pdd: pddDoc, dsd: dsdDoc, mapNodes: mNodes, processEdges: pEdges };

    let userMetaValidationMode: MetaValidationMode = options?.metaValidationMode || "Auto";

    const pipelineResult = await runBuildPipeline(ideaId, packageJson, {
      onProgress: (msg: string) => emitProgress(msg),
      onPipelineProgress: pipelineProgressCallback,
      onMetaValidation: callbacks?.onMetaValidation,
      generationMode: options?.generationMode,
      metaValidationMode: userMetaValidationMode,
      preloadedContext,
      forceRebuild: options?.forceRegenerate,
    });

    console.log(`[RunManager] Run ${runId}: build pipeline phase completed — status: ${pipelineResult.status}`);
    runLogger.stageEnd("build_pipeline", pipelineResult.status === "FAILED" ? "failed" : "succeeded", {
      pipelineStatus: pipelineResult.status,
      warningCount: pipelineResult.warnings?.length || 0,
    });

    if (pipelineResult.status === "FAILED") {
      throw new RunError("Package build produced no output", "build_failed", { packageJson });
    }

    const xamlFiles = (pipelineResult.xamlEntries || []).filter(
      (e: { name: string }) => e.name.endsWith(".xaml")
    );
    const specWorkflowNames = new Set(
      (packageJson.workflows || []).map((wf: { name: string }) => {
        const base = wf.name.replace(/\.xaml$/i, "");
        return base.toLowerCase();
      })
    );

    const extraWorkflows = xamlFiles
      .filter((e: { name: string }) => {
        const basename = (e.name.split("/").pop() || e.name).replace(/\.xaml$/i, "");
        return !specWorkflowNames.has(basename.toLowerCase());
      })
      .map((e: { name: string }) => {
        const basename = (e.name.split("/").pop() || e.name).replace(/\.xaml$/i, "");
        return { name: basename, description: "Auto-generated workflow", steps: [] };
      });

    const allWorkflows = [...(packageJson.workflows || []), ...extraWorkflows];
    const updatedPackageJson = { ...packageJson, workflows: allWorkflows, generatedWorkflowCount: allWorkflows.length };

    await chatStorage.createMessage(ideaId, "assistant", `[UIPATH:${JSON.stringify(updatedPackageJson)}]`);

    const result: RunResult = {
      status: pipelineResult.status,
      packageJson: updatedPackageJson,
      pipelineResult,
      cached: false,
    };

    if (callbacks?.onComplete) callbacks.onComplete(result);

    stopHeartbeat();

    const isDegraded = pipelineResult.warnings?.length > 0 || pipelineResult.status === "FALLBACK_READY";
    const outcomeSummary = runLogger.buildOutcomeSummary({
      status: isDegraded ? "succeeded_degraded" : "succeeded",
      degradations: isDegraded
        ? (pipelineResult.warnings || []).map((w: any) => typeof w === "string" ? w : w.message || JSON.stringify(w))
        : undefined,
    });
    await runLogger.flush();

    const outcomeReportJson = JSON.stringify({
      ...outcomeSummary,
      pipelineOutcome: pipelineResult.outcomeReport || undefined,
    });
    await finishRun(runId, activeRun, phaseEvents, {
      status: isDegraded ? "completed_with_warnings" : "completed",
      outcomeReport: outcomeReportJson,
      dhgContent: pipelineResult.dhgContent || undefined,
      generationMode: pipelineResult.generationMode,
    });

    console.log(`[RunManager] Run ${runId} completed for idea ${ideaId} — status: ${pipelineResult.status}`);

  } catch (err: any) {
    const errorMessage = err?.message || "Unknown error";
    let errorContext: Record<string, any> | undefined;

    if (err instanceof RunError) {
      errorContext = err.context;
    } else if (err instanceof QualityGateError) {
      const qgResult = err.qualityGateResult;
      errorContext = {
        stage: "quality-gate",
        qualityGateWarning: true,
        qualityGateViolations: qgResult?.violations,
        qualityGateSummary: qgResult?.summary,
        packageJson,
      };
    }

    console.error(`[RunManager] Run ${runId} caught error:`, errorMessage);

    stopHeartbeat();

    const runningStages = runLogger.getStages().filter(s => s.outcome === "running");
    for (const rs of runningStages) {
      runLogger.stageEnd(rs.stage, "failed", undefined, errorMessage);
    }

    const lastStartedStage = phaseEvents.filter(e => e.type === "started").pop()?.stage;
    const rawFailedStage = runningStages[0]?.stage || lastStartedStage || "unknown";
    const failedStage = rawFailedStage.startsWith("pipeline_") ? rawFailedStage.slice("pipeline_".length) : rawFailedStage;
    pipelineProgressCallback({ type: "failed", stage: failedStage, message: errorMessage });

    if (callbacks?.onFail) {
      try { callbacks.onFail(errorMessage, errorContext); } catch {}
    }

    const isBlocked = err instanceof RunError && err.stage === "precondition";
    const failOutcome = runLogger.buildOutcomeSummary({
      status: isBlocked ? "blocked" : "failed",
      blockReason: isBlocked ? errorMessage : undefined,
      errorMessage,
    });
    await runLogger.flush();

    await failRunInternal(runId, activeRun, phaseEvents, errorMessage, failOutcome as unknown as Record<string, unknown>, isBlocked ? "blocked" : "failed");
  } finally {
    stopHeartbeat();
  }
}

async function finishRun(
  runId: string,
  activeRun: ActiveRun,
  phaseEvents: PipelineProgressEvent[],
  updates: { status: string; outcomeReport?: string; dhgContent?: string; generationMode?: string },
): Promise<void> {
  const finalProgress = JSON.stringify(phaseEvents.slice(-50));
  await storage.updateGenerationRunPhaseProgress(runId, finalProgress).catch(() => {});
  await storage.completeGenerationRun(runId, updates);

  activeRun.completed = true;
  activeRun.finalStatus = updates.status;

  Array.from(activeRun.sseListeners).forEach(listener => {
    try {
      listener({ type: "completed", stage: "run_manager", message: `Run completed with status: ${updates.status}` });
    } catch {}
  });

  scheduleCleanup(runId, activeRun.ideaId);
}

async function failRunInternal(
  runId: string,
  activeRun: ActiveRun,
  phaseEvents: PipelineProgressEvent[],
  errorMessage: string,
  outcomeSummary?: Record<string, unknown>,
  truthfulStatus?: string,
): Promise<void> {
  const finalProgress = JSON.stringify(phaseEvents.slice(-50));
  const dbStatus = truthfulStatus || "failed";
  await storage.updateGenerationRunPhaseProgress(runId, finalProgress).catch(() => {});
  if (outcomeSummary) {
    await storage.completeGenerationRun(runId, {
      status: dbStatus,
      outcomeReport: JSON.stringify(outcomeSummary),
    }).catch(() => {});
    if (dbStatus === "failed") {
      await storage.failGenerationRun(runId, errorMessage).catch(() => {});
    }
  } else {
    await storage.failGenerationRun(runId, errorMessage).catch(() => {});
  }

  activeRun.completed = true;
  activeRun.finalStatus = dbStatus;
  activeRun.error = errorMessage;

  Array.from(activeRun.sseListeners).forEach(listener => {
    try {
      listener({ type: "failed", stage: "run_manager", message: errorMessage });
    } catch {}
  });

  scheduleCleanup(runId, activeRun.ideaId);
}

export async function cancelActiveRun(runId: string): Promise<boolean> {
  const activeRun = activeRuns.get(runId);
  if (!activeRun || activeRun.completed) return false;

  activeRun.completed = true;
  activeRun.finalStatus = "cancelled";

  Array.from(activeRun.sseListeners).forEach(listener => {
    try {
      listener({ type: "failed", stage: "run_manager", message: "Run cancelled by user" });
    } catch {}
  });

  await storage.failGenerationRun(runId, "Cancelled by user").catch(() => {});
  scheduleCleanup(runId, activeRun.ideaId);
  return true;
}

function scheduleCleanup(runId: string, ideaId: string): void {
  setTimeout(() => {
    const run = activeRuns.get(runId);
    if (run && run.completed) {
      activeRuns.delete(runId);
      const currentRunId = ideaActiveRunMap.get(ideaId);
      if (currentRunId === runId) {
        ideaActiveRunMap.delete(ideaId);
      }
    }
  }, 5 * 60 * 1000);
}

class RunError extends Error {
  stage: string;
  context?: Record<string, any>;
  constructor(message: string, stage: string, context?: Record<string, any>) {
    super(message);
    this.stage = stage;
    this.context = context;
  }
}

import { EventEmitter } from "events";

export type ObserverRunStatus = "PENDING" | "BUILDING" | "STALLED" | "READY" | "READY_WITH_WARNINGS" | "FALLBACK_READY" | "FAILED" | "CANCELLED";

export interface ObserverRunEvent {
  type: "status" | "progress" | "pipeline" | "heartbeat" | "metaValidation" | "done" | "error" | "warnings" | "complianceScore" | "outcomeSummary";
  data: any;
  timestamp: number;
}

export interface ObserverRunState {
  runId: string;
  ideaId: string;
  status: ObserverRunStatus;
  source: "chat" | "retry" | "approval" | "auto";
  createdAt: number;
  updatedAt: number;
  currentPhase?: string;
  phaseProgress?: string;
  warnings?: Array<{ code: string; message: string; stage: string; recoverable: boolean }>;
  complianceScore?: number;
  completenessLevel?: "structural" | "functional" | "incomplete";
  outcomeSummary?: {
    stubbedActivities: number;
    stubbedSequences: number;
    stubbedWorkflows: number;
    autoRepairs: number;
    fullyGenerated: number;
    totalEstimatedMinutes: number;
  };
  dependencyMap?: Record<string, string>;
  error?: string;
}

interface ObserverRunEntry {
  state: ObserverRunState;
  emitter: EventEmitter;
  events: ObserverRunEvent[];
}

const observerRuns = new Map<string, ObserverRunEntry>();
const latestObserverRunByIdea = new Map<string, string>();

export function createObserverRun(runId: string, ideaId: string, source: "chat" | "retry" | "approval" | "auto"): ObserverRunState {
  const now = Date.now();
  const state: ObserverRunState = {
    runId,
    ideaId,
    status: "BUILDING",
    source,
    createdAt: now,
    updatedAt: now,
  };
  const entry: ObserverRunEntry = {
    state,
    emitter: new EventEmitter(),
    events: [],
  };
  entry.emitter.setMaxListeners(20);
  observerRuns.set(runId, entry);
  latestObserverRunByIdea.set(ideaId, runId);
  console.log(`[Observer] createObserverRun: runId=${runId}, ideaId=${ideaId}, source=${source}`);
  return { ...state };
}

export function getObserverRun(runId: string): ObserverRunState | null {
  const entry = observerRuns.get(runId);
  return entry ? { ...entry.state } : null;
}

export function getLatestObserverRun(ideaId: string): ObserverRunState | null {
  const runId = latestObserverRunByIdea.get(ideaId);
  if (!runId) return null;
  return getObserverRun(runId);
}

export function emitObserverProgress(runId: string, message: string): void {
  const entry = observerRuns.get(runId);
  if (!entry) {
    console.warn(`[Observer] emitObserverProgress: observer run ${runId} not found — event dropped`);
    return;
  }
  entry.state.phaseProgress = message;
  entry.state.updatedAt = Date.now();
  emitObserverEvent(runId, { type: "progress", data: { progress: message }, timestamp: Date.now() });
}

export function emitObserverPipelineEvent(runId: string, evt: PipelineProgressEvent): void {
  console.log(`[Observer] emitObserverPipelineEvent: runId=${runId}, stage=${evt.stage}, type=${evt.type}`);
  emitObserverEvent(runId, { type: "pipeline", data: { pipelineEvent: evt }, timestamp: Date.now() });
}

export function emitObserverHeartbeat(runId: string): void {
  emitObserverEvent(runId, { type: "heartbeat", data: { heartbeat: true }, timestamp: Date.now() });
}

export function emitObserverMetaValidation(runId: string, event: any): void {
  emitObserverEvent(runId, { type: "metaValidation", data: { metaValidation: event }, timestamp: Date.now() });
}

export function emitObserverDone(runId: string, payload: any): void {
  const entry = observerRuns.get(runId);
  if (!entry) return;
  if (payload.status) entry.state.status = payload.status as ObserverRunStatus;
  if (payload.warnings) entry.state.warnings = payload.warnings;
  if (payload.templateComplianceScore !== undefined) entry.state.complianceScore = payload.templateComplianceScore;
  if (payload.completenessLevel) entry.state.completenessLevel = payload.completenessLevel;
  if (payload.outcomeSummary) entry.state.outcomeSummary = payload.outcomeSummary;
  if (payload.dependencyMap) entry.state.dependencyMap = payload.dependencyMap;
  entry.state.updatedAt = Date.now();
  emitObserverEvent(runId, { type: "done", data: { done: true, ...payload }, timestamp: Date.now() });
}

export function emitObserverError(runId: string, error: string): void {
  const entry = observerRuns.get(runId);
  if (!entry) return;
  entry.state.status = "FAILED";
  entry.state.error = error;
  entry.state.updatedAt = Date.now();
  emitObserverEvent(runId, { type: "error", data: { status: "FAILED", error }, timestamp: Date.now() });
}

export function cancelObserverRun(runId: string): boolean {
  const entry = observerRuns.get(runId);
  if (!entry) return false;
  if (entry.state.status !== "BUILDING" && entry.state.status !== "PENDING") return false;
  entry.state.status = "CANCELLED";
  entry.state.updatedAt = Date.now();
  emitObserverEvent(runId, { type: "status", data: { status: "CANCELLED" }, timestamp: Date.now() });
  emitObserverEvent(runId, { type: "done", data: { done: true, status: "CANCELLED" }, timestamp: Date.now() });
  return true;
}

export function isObserverRunCancelled(runId: string): boolean {
  const entry = observerRuns.get(runId);
  return entry ? entry.state.status === "CANCELLED" : false;
}

function emitObserverEvent(runId: string, event: ObserverRunEvent): void {
  const entry = observerRuns.get(runId);
  if (!entry) {
    console.warn(`[Observer] emitObserverEvent: observer run ${runId} not found — ${event.type} event dropped`);
    return;
  }
  entry.events.push(event);
  const listenerCount = entry.emitter.listenerCount("event");
  console.log(`[Observer] emitObserverEvent: runId=${runId}, type=${event.type}, totalStored=${entry.events.length}, liveListeners=${listenerCount}`);
  entry.emitter.emit("event", event);
}

export function subscribeToObserverRun(runId: string, onEvent: (event: ObserverRunEvent) => void, replayAll?: boolean): () => void {
  const entry = observerRuns.get(runId);
  if (!entry) {
    console.warn(`[Observer] subscribeToObserverRun: observer run ${runId} not found`);
    onEvent({ type: "error", data: { error: "Run not found" }, timestamp: Date.now() });
    return () => {};
  }

  if (replayAll) {
    console.log(`[Observer] subscribeToObserverRun: replaying ${entry.events.length} stored events for runId=${runId}`);
    for (const evt of entry.events) {
      onEvent(evt);
    }
  }

  const handler = (evt: ObserverRunEvent) => {
    console.log(`[Observer] subscribeToObserverRun: live event type=${evt.type} for runId=${runId}`);
    onEvent(evt);
  };
  entry.emitter.on("event", handler);
  console.log(`[Observer] subscribeToObserverRun: live listener attached for runId=${runId}, totalListeners=${entry.emitter.listenerCount("event")}`);

  return () => {
    entry.emitter.off("event", handler);
  };
}

export function getObserverRunEvents(runId: string, afterIndex: number = 0): { events: ObserverRunEvent[]; totalStored: number; status: ObserverRunStatus } | null {
  const entry = observerRuns.get(runId);
  if (!entry) return null;
  const events = afterIndex >= 0 && afterIndex < entry.events.length
    ? entry.events.slice(afterIndex)
    : [];
  return { events, totalStored: entry.events.length, status: entry.state.status };
}

export function isObserverTerminalStatus(status: ObserverRunStatus): boolean {
  return status === "READY" || status === "READY_WITH_WARNINGS" || status === "FALLBACK_READY" || status === "FAILED" || status === "CANCELLED";
}

export function cleanupOldObserverRuns(): void {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [runId, entry] of observerRuns) {
    if (isObserverTerminalStatus(entry.state.status) && entry.state.updatedAt < cutoff) {
      entry.emitter.removeAllListeners();
      observerRuns.delete(runId);
    }
  }
}

setInterval(cleanupOldObserverRuns, 30 * 60 * 1000);
