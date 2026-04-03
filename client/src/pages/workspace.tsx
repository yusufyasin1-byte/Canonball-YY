import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode, type MutableRefObject } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { getApprovalReadiness } from "@/lib/document-readiness";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useRoute, Link, useLocation } from "wouter";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/hooks/use-auth";
import {
  ArrowLeft,
  Send,
  Paperclip,
  Check,
  Lock,
  Sparkles,
  Bot,
  File as FileIcon,
  X,
  Package,
  Pencil,
  FileText,
  ListChecks,
  Map as MapIcon,
  MessageSquare,
  ListPlus,
  Download,
  Trash2,
  Brain,
  Archive,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DeploymentReportCard } from "@/components/deployment-report-card";
import { PrimarySpinner } from "@/components/cannonball-spinner";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { PIPELINE_STAGES, type Idea, type PipelineStage, type ChatMessage as DBChatMessage } from "@shared/schema";
import ProcessMapPanel from "@/components/process-map-panel";
import { parseStepsFromText, parseStepsByView } from "@/lib/step-parser";
import { DocumentCard, UiPathPackageCard } from "@/components/document-card";
import { FeasibilityCard } from "@/components/feasibility-card";
import { useUiPathRun, type PipelineLogEntry, type CancelState } from "@/hooks/use-uipath-run";
import { ArtifactHub } from "@/components/artifact-hub";
import { MetaValidationBar } from "@/components/meta-validation-bar";
import { formatEST, getStageBadgeClass } from "@/lib/utils";

let currentProcessView: "as-is" | "to-be" | "sdd" = "as-is";

function guessIntentFromMessage(text: string): string {
  const lower = text.toLowerCase().trim();
  const hasDeployKeyword = /\bdeploy(ing|ment|ed)?\b/.test(lower);
  const hasUipathKeyword = /\buipath\b/.test(lower);
  const hasPackageVerb = /\b(generate|create|build|regenerate|gen|regen)\b/.test(lower);
  if (hasDeployKeyword && !hasUipathKeyword) return "DEPLOY";
  if (hasUipathKeyword || (/\bpackage\b/.test(lower) && hasPackageVerb)) return "UIPATH_GEN";
  if (/\b(generate|create|regenerate|write)\b.*\bpdd\b/.test(lower) || /\bpdd\b.*\b(generate|create|regenerate|write)\b/.test(lower) || /\bprocess design doc/.test(lower)) return "PDD";
  if (/\b(generate|create|regenerate|write)\b.*\bsdd\b/.test(lower) || /\bsdd\b.*\b(generate|create|regenerate|write)\b/.test(lower) || /\bsolution design doc/.test(lower)) return "SDD";
  if (/\b(generate|create|regenerate|write)\b.*\bdhg\b/.test(lower) || /\bdhg\b.*\b(generate|create|regenerate|write)\b/.test(lower) || /\bdeveloper handoff/.test(lower)) return "DHG";
  if (hasDeployKeyword) return "DEPLOY";
  return "";
}

const STAGE_THINKING_MESSAGES: Record<string, string> = {
  "Idea": "Analyzing your process...",
  "Design": "Designing automation...",
  "Feasibility Assessment": "Assessing feasibility...",
  "Build": "Building solution...",
  "Test": "Preparing tests...",
  "Governance / Security Scan": "Running compliance checks...",
  "CoE Approval": "Processing approval...",
  "Deploy": "Preparing deployment...",
  "Maintenance": "Getting things ready...",
};

const INTENT_THINKING_MESSAGES: Record<string, string> = {
  "DEPLOY": "Preparing deployment...",
  "UIPATH_GEN": "Generating UiPath package...",
  "PDD": "Generating Process Design Document...",
  "SDD": "Generating Solution Design Document...",
  "PDD_SDD": "Generating documents...",
  "DHG": "Generating Developer Handoff Guide...",
  "FEASIBILITY": "Running feasibility assessment...",
  "TO_BE_MAP": "Generating To-Be process map...",
};

const STAGE_DISPLAY_LABELS: Record<string, string> = {
  "platform_capabilities": "Fetching platform capabilities...",
  "llm_parallel_generation": "Generating prose and artifacts...",
  "llm_generation": "Generating document content...",
  "artifacts_retry": "Retrying artifact generation...",
  "artifacts_retry_retry": "Retrying artifact generation...",
  "artifacts_retry_fallback": "Retrying artifact generation (fallback)...",
  "artifact_validation": "Validating artifacts...",
};

interface StreamingProgressProps {
  mode: "thinking" | "doc" | "deploy";
  liveStatus?: string;
  docType?: string;
  currentSection?: string;
  deployStep?: string;
  onCancel?: () => void;
  stage?: string;
  classifiedIntent?: string;
}

function StreamingProgressIndicator({ mode, liveStatus, docType, currentSection, deployStep, onCancel, stage, classifiedIntent }: StreamingProgressProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const isUiPathOrDHG = docType === "UiPath" || docType === "DHG";
  const uiPathSteps = DOC_PROGRESS_STEPS[docType || ""] || [];
  const stepDuration = docType === "UiPath" ? 10 : 6;
  const fallbackStep = isUiPathOrDHG && uiPathSteps.length > 0
    ? uiPathSteps[Math.min(Math.floor(elapsed / stepDuration), uiPathSteps.length - 1)]
    : null;

  const getThinkingMessage = () => {
    if (liveStatus) {
      return liveStatus;
    }
    if (classifiedIntent && INTENT_THINKING_MESSAGES[classifiedIntent]) {
      return INTENT_THINKING_MESSAGES[classifiedIntent];
    }
    return stage ? (STAGE_THINKING_MESSAGES[stage] || "Classifying your request...") : "Classifying your request...";
  };

  if (mode === "thinking") {
    return (
      <div className="flex justify-start" data-testid="thinking-indicator">
        <div className="max-w-[85%] rounded-lg px-3 py-3 bg-card border border-card-border rounded-bl-sm">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="w-[5px] h-[5px] rounded-full bg-muted-foreground/40" style={{ animation: "thinkingPulse 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite", animationDelay: "0ms" }} />
              <span className="w-[5px] h-[5px] rounded-full bg-muted-foreground/40" style={{ animation: "thinkingPulse 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite", animationDelay: "200ms" }} />
              <span className="w-[5px] h-[5px] rounded-full bg-muted-foreground/40" style={{ animation: "thinkingPulse 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite", animationDelay: "400ms" }} />
            </div>
            <span className="text-[11px] text-muted-foreground/70 font-medium">{getThinkingMessage()}</span>
          </div>
        </div>
      </div>
    );
  }

  const getDocStatusText = () => {
    if (isUiPathOrDHG) return currentSection || fallbackStep || "Starting generation...";
    return currentSection || "Starting generation...";
  };

  const statusText = mode === "deploy"
    ? (deployStep || "Preparing deployment...")
    : getDocStatusText();

  const title = mode === "deploy"
    ? "Deploying to UiPath..."
    : docType === "UiPath"
      ? "Generating UiPath..."
      : `Generating ${docType || "document"}...`;

  return (
    <div className="flex justify-start" data-testid={mode === "deploy" ? "deploy-progress-indicator" : "doc-generation-loading"}>
      <div className="max-w-[85%] rounded-lg px-3 py-2.5 bg-card border border-card-border rounded-bl-sm">
        <div className="flex items-center gap-2">
          <PrimarySpinner />
          <div className="flex flex-col gap-0.5">
            <p className="text-xs text-foreground/80 font-medium">{title}</p>
            <p className="text-[10px] text-muted-foreground">
              {statusText} <span className="text-muted-foreground/50">({elapsed}s elapsed)</span>
            </p>
          </div>
          {onCancel && (
            <button
              onClick={onCancel}
              className="text-[10px] text-muted-foreground hover:text-foreground underline ml-2 shrink-0"
              data-testid="button-cancel-doc-gen"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


function PipelineLogPanel({
  entries,
  isComplete,
  onCancel,
}: {
  entries: PipelineLogEntry[];
  isComplete: boolean;
  onCancel?: () => void;
}) {
  const logEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [entries.length]);

  const activeStage = entries.length > 0
    ? entries.filter(e => e.type === "started").pop()?.stage
    : null;
  const completedStages = new Set(entries.filter(e => e.type === "completed").map(e => e.stage));
  const currentActive = activeStage && !completedStages.has(activeStage) ? activeStage : null;

  const deduped = entries.reduce<PipelineLogEntry[]>((acc, entry) => {
    if (entry.type === "heartbeat") {
      const lastIdx = acc.findIndex(e => e.stage === entry.stage && e.type === "heartbeat");
      if (lastIdx >= 0) {
        acc[lastIdx] = entry;
        return acc;
      }
    }
    acc.push(entry);
    return acc;
  }, []);

  const renderIcon = (entry: PipelineLogEntry) => {
    const isActive = entry.stage === currentActive;
    switch (entry.type) {
      case "started":
        return isActive
          ? <span className="w-2 h-2 rounded-full bg-orange-400 pipeline-active-dot shrink-0" data-testid={`pipeline-dot-active-${entry.stage}`} />
          : <span className="w-2 h-2 rounded-full bg-muted-foreground/30 shrink-0" />;
      case "heartbeat":
        return <span className="w-2 h-2 rounded-full bg-orange-400 pipeline-active-dot shrink-0" />;
      case "completed":
        return <Check className="h-3 w-3 text-emerald-400 shrink-0" />;
      case "warning":
        return <span className="text-amber-400 text-[10px] shrink-0">&#9888;</span>;
      case "failed":
        return <X className="h-3 w-3 text-red-400 shrink-0" />;
      default:
        return null;
    }
  };

  const renderMessage = (entry: PipelineLogEntry) => {
    switch (entry.type) {
      case "started":
        return <span className="text-muted-foreground/70 text-[11px]">{entry.message}</span>;
      case "heartbeat":
        return <span className="text-muted-foreground/60 text-[11px] italic pipeline-ellipsis">{entry.message}</span>;
      case "completed":
        return <span className="text-foreground/90 text-[11px]">{entry.message}</span>;
      case "warning":
        return <span className="text-amber-400 text-[11px]">{entry.message}</span>;
      case "failed":
        return <span className="text-red-400 text-[11px]">{entry.message}</span>;
      default:
        return <span className="text-muted-foreground text-[11px]">{entry.message}</span>;
    }
  };

  const totalElapsed = entries.length > 0
    ? Math.round((Date.now() - entries[0].timestamp) / 1000)
    : 0;

  return (
    <div className="flex justify-start" data-testid="pipeline-log-panel">
      <div className="max-w-[90%] w-full rounded-lg bg-card border border-card-border rounded-bl-sm overflow-hidden" ref={containerRef}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
          <div className="flex items-center gap-2">
            <Package className="h-3.5 w-3.5 text-primary" />
            <span className="text-[11px] font-semibold text-foreground/80">
              {isComplete ? "Pipeline Complete" : "Building UiPath Package"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isComplete && (
              <span className="text-[10px] text-muted-foreground/50">{totalElapsed}s</span>
            )}
            {onCancel && !isComplete && (
              <button
                onClick={onCancel}
                className="text-[10px] text-muted-foreground hover:text-foreground underline shrink-0"
                data-testid="button-cancel-pipeline"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
        <div className="max-h-[240px] overflow-y-auto px-3 py-1.5 space-y-0.5 scrollbar-thin">
          {deduped.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2 py-0.5 pipeline-log-entry"
              data-testid={`pipeline-entry-${entry.type}-${entry.stage}`}
            >
              <div className="w-4 flex items-center justify-center shrink-0">
                {renderIcon(entry)}
              </div>
              <div className="flex-1 min-w-0 truncate">
                {renderMessage(entry)}
              </div>
              {entry.type === "completed" && entry.elapsed !== undefined && (
                <span className="text-[9px] text-muted-foreground/50 shrink-0 tabular-nums ml-auto">{entry.elapsed.toFixed(1)}s</span>
              )}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
        {isComplete && (
          <div className="px-3 py-2 border-t border-border/30 pipeline-fade-in">
            <div className="flex items-center gap-1.5">
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-[11px] text-emerald-400 font-medium">Ready to deploy</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WorkflowElapsedTimer({ startTimestamp }: { startTimestamp: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(Math.round((Date.now() - startTimestamp) / 1000));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTimestamp]);
  return <span className="text-[9px] text-muted-foreground/40 ml-1 tabular-nums">{elapsed}s</span>;
}

function UiPathProgressPanel({
  entries,
  isComplete,
  onCancel,
  cancelState,
  startTime,
  isRunning = true,
  onDismiss,
  finalStatus,
}: {
  entries: PipelineLogEntry[];
  isComplete: boolean;
  onCancel?: () => void;
  cancelState: CancelState;
  startTime: number | null;
  isRunning?: boolean;
  onDismiss?: () => void;
  finalStatus?: string | null;
}) {
  const logEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) return;
    const update = () => setElapsed(Math.round((Date.now() - startTime) / 1000));
    update();
    if (!isRunning) return;
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [startTime, isRunning]);

  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [entries.length]);

  const specStages = new Set(["sdd_validation", "spec_context_loading", "spec_prompt_assembly", "spec_scaffold", "spec_workflow_detail", "spec_merge", "spec_handoff", "llm_generation", "llm_context_loading", "llm_prompt_assembly", "llm_parsing", "decomposition", "complexity_classification", "spec_generating", "confidence_assessment", "spec_ready"]);
  const terminalStages = new Set(["complete"]);
  const isBuildEntry = (e: PipelineLogEntry) => !specStages.has(e.stage) && !terminalStages.has(e.stage);
  const hasBuildEntries = entries.some(isBuildEntry);
  const llmEntries = entries.filter(e => specStages.has(e.stage));
  const buildEntries = entries.filter(isBuildEntry);
  const llmPhaseComplete = hasBuildEntries || isComplete;

  const failedEntry = entries.find(e => e.type === "failed");

  const stageLabelMap: Record<string, string> = {
    sdd_validation: "Validating SDD",
    cache_hit: "Loading cached result",
    build_pipeline: "Build pipeline",
    spec_context_loading: "Loading context",
    spec_prompt_assembly: "Preparing prompt",
    spec_scaffold: "AI generation",
    spec_workflow_detail: "Workflow detail",
    spec_merge: "Validating specification",
    spec_handoff: "Handing off to build",
    llm_context_loading: "Loading context",
    llm_prompt_assembly: "Preparing prompt",
    llm_generation: "AI generation",
    llm_parsing: "Parsing response",
    decomposition: "Decomposing workflows",
    complexity_classification: "Classifying complexity",
    spec_generating: "Generating specifications",
    confidence_assessment: "Assessing AI capabilities",
    spec_ready: "Specifications ready",
    ai_enrichment_tree: "Tree-based AI enrichment",
    ai_enrichment_legacy: "Legacy AI enrichment",
    deterministic_scaffold: "Deterministic scaffold",
    compiling: "Compiling XAML workflows",
    validating: "Validating archive",
    ai_enrichment: "AI enrichment",
    complete: "Pipeline complete",
  };
  const friendlyLabel = (stage: string, fallback: string) => stageLabelMap[stage] || fallback;

  const activeStage = buildEntries.length > 0
    ? buildEntries.filter(e => e.type === "started").pop()?.stage
    : null;
  const completedStages = new Set(buildEntries.filter(e => e.type === "completed").map(e => e.stage));
  const currentActive = activeStage && !completedStages.has(activeStage) ? activeStage : null;

  const dedupedBuild = buildEntries.reduce<PipelineLogEntry[]>((acc, entry) => {
    if (entry.type === "heartbeat") {
      const lastIdx = acc.findIndex(e => e.stage === entry.stage && e.type === "heartbeat");
      if (lastIdx >= 0) {
        acc[lastIdx] = entry;
        return acc;
      }
    }
    acc.push(entry);
    return acc;
  }, []);

  const renderIcon = (entry: PipelineLogEntry) => {
    const isActive = entry.stage === currentActive;
    switch (entry.type) {
      case "started":
        return isActive
          ? <span className="w-2 h-2 rounded-full bg-orange-400 pipeline-active-dot shrink-0" data-testid={`pipeline-dot-active-${entry.stage}`} />
          : <span className="w-2 h-2 rounded-full bg-muted-foreground/30 shrink-0" />;
      case "heartbeat":
        return <span className="w-2 h-2 rounded-full bg-orange-400 pipeline-active-dot shrink-0" />;
      case "completed":
        return <Check className="h-3 w-3 text-emerald-400 shrink-0" />;
      case "warning":
        return <span className="text-amber-400 text-[10px] shrink-0">&#9888;</span>;
      case "failed":
        return <X className="h-3 w-3 text-red-400 shrink-0" />;
      default:
        return null;
    }
  };

  const renderMessage = (entry: PipelineLogEntry) => {
    const label = friendlyLabel(entry.stage, entry.message);
    switch (entry.type) {
      case "started":
        return <span className="text-muted-foreground/70 text-[11px]">{label}</span>;
      case "heartbeat":
        return <span className="text-muted-foreground/50 text-[11px] italic pipeline-ellipsis">{entry.message}</span>;
      case "completed":
        return <span className="text-foreground/90 text-[11px]">{entry.message}</span>;
      case "warning":
        return <span className="text-amber-400 text-[11px]">{entry.message}</span>;
      case "failed":
        return <span className="text-red-400 text-[11px] font-medium">{entry.message}</span>;
      default:
        return <span className="text-muted-foreground text-[11px]">{entry.message}</span>;
    }
  };

  const cancelLabel = cancelState === "cancelling" ? "Cancelling..." : cancelState === "cancelled" ? "Cancelled" : cancelState === "cancel_failed" ? "Retry Cancel" : "Cancel";
  const cancelDisabled = cancelState === "cancelling" || cancelState === "cancelled";

  return (
    <div className="flex justify-start" data-testid="uipath-progress-panel">
      <div className="max-w-[90%] w-full rounded-lg bg-card border border-card-border rounded-bl-sm overflow-hidden" ref={containerRef}>
        <div className="flex items-center justify-between px-3 py-2 border-b border-border/30">
          <div className="flex items-center gap-2">
            <Package className="h-3.5 w-3.5 text-primary" />
            <span className="text-[11px] font-semibold text-foreground/80">
              {cancelState === "cancelled" ? "Cancelled" : failedEntry ? "Pipeline Failed" : isComplete ? "Pipeline Complete" : "Generating UiPath Package"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground/50 tabular-nums" data-testid="uipath-elapsed-timer">{elapsed}s</span>
            {onCancel && !isComplete && isRunning && (
              <button
                onClick={onCancel}
                disabled={cancelDisabled}
                className={`text-[10px] shrink-0 ${cancelDisabled ? "text-muted-foreground/40 cursor-not-allowed" : "text-muted-foreground hover:text-foreground underline"}`}
                data-testid="button-cancel-uipath"
              >
                {cancelLabel}
              </button>
            )}
            {!isRunning && onDismiss && (
              <button
                onClick={onDismiss}
                className="text-[10px] shrink-0 text-muted-foreground hover:text-foreground underline"
                data-testid="button-dismiss-uipath"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
        <div className="max-h-[280px] overflow-y-auto px-3 py-1.5 space-y-1 scrollbar-thin">
          <div className="flex items-center gap-2 py-1" data-testid="phase-ai-generation">
            <div className="w-4 flex items-center justify-center shrink-0">
              {llmPhaseComplete ? (
                <Check className="h-3 w-3 text-emerald-400" />
              ) : (
                <span className="w-2 h-2 rounded-full bg-orange-400 pipeline-active-dot shrink-0" />
              )}
            </div>
            <span className={`text-[11px] font-medium ${llmPhaseComplete ? "text-foreground/90" : "text-foreground/80"}`}>
              AI Generation
            </span>
          </div>
          {llmEntries.length > 0 && (
            <div className="pl-6 space-y-0.5">
              {(() => {
                const isPerWorkflowEntry = (e: PipelineLogEntry) => e.stage === "spec_workflow_detail" && !!e.context?.workflowName;
                const nonWorkflowEntries = llmEntries.filter(e => !isPerWorkflowEntry(e));
                const workflowEntries = llmEntries.filter(e => isPerWorkflowEntry(e));

                const completedStagesSet = new Set(nonWorkflowEntries.filter(e => e.type === "completed").map(e => e.stage));
                const completedElapsed = new Map(nonWorkflowEntries.filter(e => e.type === "completed" && e.elapsed !== undefined).map(e => [e.stage, e.elapsed!]));
                const startedStages = new Set(nonWorkflowEntries.filter(e => e.type === "started").map(e => e.stage));
                const realEntries = nonWorkflowEntries.filter(e => e.type !== "heartbeat");
                const filtered = realEntries.filter(e => {
                  if (e.type === "completed" && startedStages.has(e.stage)) return false;
                  return true;
                });
                const lastHeartbeat = [...nonWorkflowEntries].reverse().find(e => e.type === "heartbeat" && (e.stage === "spec_scaffold" || e.stage === "llm_generation" || e.stage === "spec_workflow_detail" || e.stage === "spec_generating" || e.stage === "confidence_assessment"));
                const showHeartbeat = lastHeartbeat && !llmPhaseComplete && !completedStagesSet.has(lastHeartbeat.stage);

                const workflowMap = new Map<string, { started?: PipelineLogEntry; completed?: PipelineLogEntry; warnings: PipelineLogEntry[] }>();
                const workflowOrder: string[] = [];
                for (const entry of workflowEntries) {
                  const wfName = entry.context?.workflowName as string | undefined;
                  if (!wfName) continue;
                  if (!workflowMap.has(wfName)) {
                    workflowMap.set(wfName, { warnings: [] });
                    workflowOrder.push(wfName);
                  }
                  const wf = workflowMap.get(wfName)!;
                  if (entry.type === "started") wf.started = entry;
                  else if (entry.type === "completed") wf.completed = entry;
                  else if (entry.type === "warning") wf.warnings.push(entry);
                }

                const hasWorkflowEntries = workflowOrder.length > 0;

                return (
                  <>
                    {filtered.map((entry, idx) => {
                      const isLast = idx === filtered.length - 1 && !showHeartbeat && !hasWorkflowEntries;
                      const stageCompleted = completedStagesSet.has(entry.stage);
                      const isDone = stageCompleted || llmPhaseComplete;
                      const stageElapsed = completedElapsed.get(entry.stage);
                      return (
                        <div key={entry.id} className="flex items-center gap-2 py-0.5 pipeline-log-entry" data-testid={`progress-entry-${entry.stage}`}>
                          <div className="w-4 flex items-center justify-center shrink-0">
                            {isDone ? (
                              <Check className="h-2.5 w-2.5 text-emerald-400" />
                            ) : isLast ? (
                              <PrimarySpinner size={12} />
                            ) : (
                              <span className="w-2 h-2 rounded-full bg-muted-foreground/30 shrink-0" />
                            )}
                          </div>
                          <span className={`text-[11px] ${isDone ? "text-foreground/70" : "text-muted-foreground/70"}`}>
                            {friendlyLabel(entry.stage, entry.message)}
                            {isDone && stageElapsed !== undefined && (
                              <span className="text-[9px] text-muted-foreground/50 ml-1 tabular-nums">{stageElapsed.toFixed(1)}s</span>
                            )}
                          </span>
                        </div>
                      );
                    })}
                    {showHeartbeat && (
                      <div className="flex items-center gap-2 py-0.5 pipeline-log-entry" data-testid="progress-llm-keepalive">
                        <div className="w-4 flex items-center justify-center shrink-0">
                          <PrimarySpinner size={12} />
                        </div>
                        <span className="text-[11px] text-muted-foreground/50 italic pipeline-ellipsis">{lastHeartbeat.message}</span>
                      </div>
                    )}
                    {hasWorkflowEntries && (
                      <div className="space-y-0.5 mt-0.5">
                        {workflowOrder.map((wfName) => {
                          const wf = workflowMap.get(wfName)!;
                          const index = wf.started?.context?.index ?? "?";
                          const total = wf.started?.context?.total ?? "?";
                          const isActive = wf.started && !wf.completed;
                          const isDone = !!wf.completed;
                          const isStubbed = wf.warnings.some(w => w.context?.outcome === "stubbed") || wf.completed?.context?.outcome === "stubbed";
                          const isTimedOut = wf.warnings.some(w => w.context?.outcome === "timed_out") || wf.completed?.context?.outcome === "timed_out";
                          return (
                            <div key={wfName}>
                              <div className={`flex items-center gap-2 py-0.5 pipeline-log-entry ${isActive ? "bg-orange-400/5 rounded px-1 -mx-1" : ""}`} data-testid={`progress-workflow-${wfName}`}>
                                <div className="w-4 flex items-center justify-center shrink-0">
                                  {isDone && (isStubbed || isTimedOut) ? (
                                    <span className="text-amber-400 text-[11px] shrink-0">&#9888;</span>
                                  ) : isDone ? (
                                    <Check className="h-2.5 w-2.5 text-emerald-400" />
                                  ) : isActive ? (
                                    <PrimarySpinner size={12} />
                                  ) : (
                                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20 shrink-0" />
                                  )}
                                </div>
                                <span className={`text-[11px] ${isDone && (isStubbed || isTimedOut) ? "text-amber-400/80" : isDone ? "text-foreground/70" : isActive ? "text-foreground/80 font-medium" : "text-muted-foreground/40"}`}>
                                  {index}/{total}: {wfName}
                                  {isDone && (isStubbed || isTimedOut) && (
                                    <span className="text-amber-400/70 text-[9px] ml-1">{isTimedOut ? "(timed out)" : "(stubbed)"}</span>
                                  )}
                                  {isDone && wf.completed!.elapsed !== undefined && (
                                    <span className="text-[9px] text-muted-foreground/50 ml-1 tabular-nums">{wf.completed!.elapsed.toFixed(1)}s</span>
                                  )}
                                  {isActive && wf.started && (
                                    <WorkflowElapsedTimer startTimestamp={wf.started.timestamp} />
                                  )}
                                </span>
                              </div>
                              {wf.warnings.map((warn) => (
                                <div key={warn.id} className="flex items-center gap-2 py-0.5 pl-6 pipeline-log-entry" data-testid={`progress-workflow-warning-${wfName}`}>
                                  <span className="text-amber-400 text-[9px]">&#9888;</span>
                                  <span className="text-amber-400/80 text-[9px]">{warn.message}</span>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
          {!llmPhaseComplete && llmEntries.length === 0 && (
            <div className="pl-6 space-y-0.5">
              <div className="flex items-center gap-2 py-0.5">
                <div className="w-4 flex items-center justify-center shrink-0">
                  <PrimarySpinner />
                </div>
                <span className="text-muted-foreground/60 text-[11px] italic pipeline-ellipsis">Generating UiPath package...</span>
              </div>
            </div>
          )}

          {(hasBuildEntries || (isComplete && !hasBuildEntries)) && (
            <>
              <div className="flex items-center gap-2 py-1 mt-1 border-t border-border/20 pt-2" data-testid="phase-package-build">
                <div className="w-4 flex items-center justify-center shrink-0">
                  {isComplete ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-orange-400 pipeline-active-dot shrink-0" />
                  )}
                </div>
                <span className={`text-[11px] font-medium ${isComplete ? "text-foreground/90" : "text-foreground/80"}`}>
                  Package Build
                </span>
              </div>
              <div className="pl-6 space-y-0.5">
                {dedupedBuild.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2 py-0.5 pipeline-log-entry"
                    data-testid={`pipeline-entry-${entry.type}-${entry.stage}`}
                  >
                    <div className="w-4 flex items-center justify-center shrink-0">
                      {renderIcon(entry)}
                    </div>
                    <div className="flex-1 min-w-0 truncate">
                      {renderMessage(entry)}
                    </div>
                    {entry.type === "completed" && entry.elapsed !== undefined && (
                      <span className="text-[9px] text-muted-foreground/50 shrink-0 tabular-nums ml-auto">{entry.elapsed.toFixed(1)}s</span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          <div ref={logEndRef} />
        </div>
        {failedEntry && (
          <div className="px-3 py-2 border-t border-red-500/30 bg-red-500/5 pipeline-fade-in" data-testid="uipath-failure-banner">
            <div className="flex items-center gap-1.5">
              <X className="h-3 w-3 text-red-400 shrink-0" />
              <div className="min-w-0">
                <span className="text-[11px] text-red-400 font-medium block">
                  Failed at: {friendlyLabel(failedEntry.stage, failedEntry.stage)}
                </span>
                <span className="text-[10px] text-red-400/70 block truncate">{failedEntry.message}</span>
              </div>
            </div>
          </div>
        )}
        {isComplete && !failedEntry && (
          <div className="px-3 py-2 border-t border-border/30 pipeline-fade-in">
            <div className="flex items-center gap-1.5">
              {finalStatus === "FALLBACK_READY" ? (
                <>
                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                  <span className="text-[11px] text-amber-500 font-medium" data-testid="pipeline-status-fallback">Needs work — structural defects detected</span>
                </>
              ) : finalStatus === "READY_WITH_WARNINGS" ? (
                <>
                  <AlertTriangle className="h-3 w-3 text-amber-400" />
                  <span className="text-[11px] text-amber-400 font-medium" data-testid="pipeline-status-warnings">Ready with warnings</span>
                </>
              ) : (
                <>
                  <Check className="h-3 w-3 text-emerald-400" />
                  <span className="text-[11px] text-emerald-400 font-medium" data-testid="pipeline-status-ready">Ready to deploy</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const DOC_PROGRESS_STEPS: Record<string, string[]> = {
  UiPath: [
    "Reading SDD content...",
    "Generating package specification...",
    "AI-enriching XAML workflows...",
    "Applying Workflow Analyzer rules...",
    "Building project structure...",
    "Generating XAML sequences...",
    "Creating deployment artifacts...",
    "Packaging .nupkg file...",
  ],
  DHG: [
    "Analysing generated workflows...",
    "Documenting activity dependencies...",
    "Building go-live checklist...",
    "Writing deployment instructions...",
    "Generating test scenarios...",
    "Finalising handoff guide...",
  ],
};

const STAGE_GUIDANCE: Record<string, { action: string; hint: string }> = {
  Idea: {
    action: "Describe Your Process",
    hint: "Tell the assistant about the manual process you want to automate. Include who does it, how often, and what systems are involved.",
  },
  Design: {
    action: "Map Your Process",
    hint: "Work with the assistant to build the As-Is process map step by step. Once complete, approve it to advance to feasibility assessment.",
  },
  "Feasibility Assessment": {
    action: "Review Feasibility & To-Be",
    hint: "The automation type is being evaluated and the To-Be automated process map is being generated. Review and approve the To-Be map to proceed to Build.",
  },
  Build: {
    action: "Build in Progress",
    hint: "Development is underway. Track build progress, review test scenarios, and flag any process changes.",
  },
  Test: {
    action: "Validate & Test",
    hint: "Review test results, confirm edge cases are handled, and approve for governance review.",
  },
  "Governance / Security Scan": {
    action: "Governance Review",
    hint: "Security and compliance checks are running. Review findings and address any flagged items.",
  },
  "CoE Approval": {
    action: "Awaiting Approval",
    hint: "The CoE team is reviewing this automation. Respond to any questions or change requests.",
  },
  Deploy: {
    action: "Deploying",
    hint: "Deployment is in progress. Monitor rollout status and confirm production readiness.",
  },
  Maintenance: {
    action: "Monitor & Maintain",
    hint: "This automation is live. Track performance metrics, exception rates, and optimization opportunities.",
  },
};

const STAGE_ARTIFACTS: Record<string, string[]> = {
  "Design": ["as-is-map"],
  "Feasibility Assessment": ["as-is-map", "to-be-map"],
  "Build": ["as-is-map", "to-be-map", "pdd"],
  "Test": ["as-is-map", "to-be-map", "pdd", "sdd"],
  "Governance / Security Scan": ["as-is-map", "to-be-map", "pdd", "sdd"],
  "CoE Approval": ["as-is-map", "to-be-map", "pdd", "sdd"],
  "Deploy": ["as-is-map", "to-be-map", "pdd", "sdd"],
  "Maintenance": ["as-is-map", "to-be-map", "pdd", "sdd"],
};

const ARTIFACT_LABELS: Record<string, string> = {
  "as-is-map": "As-Is Map",
  "to-be-map": "To-Be Map",
  "pdd": "PDD",
  "sdd": "SDD",
};

function StageTracker({
  idea,
  onStageClick,
}: {
  idea: Idea;
  onStageClick: (stage: string) => void;
}) {
  const currentIndex = PIPELINE_STAGES.indexOf(idea.stage as PipelineStage);

  const { data: stageHistory } = useQuery<{ transitions: Array<{ stage: string; timestamp: string }> }>({
    queryKey: ["/api/ideas", idea.id, "stage-history"],
    queryFn: async () => {
      const res = await fetch(`/api/ideas/${idea.id}/stage-history`, { credentials: "include" });
      if (!res.ok) return { transitions: [] };
      return res.json();
    },
    staleTime: 30000,
  });

  const completedStages = useMemo(() => {
    const result: Record<string, { short: string; full: string }> = {};
    const createdFormatted = formatEST(new Date(idea.createdAt));
    result["Idea"] = createdFormatted;

    if (stageHistory?.transitions) {
      for (const t of stageHistory.transitions) {
        result[t.stage] = formatEST(new Date(t.timestamp));
      }
    }
    return result;
  }, [idea.createdAt, stageHistory]);

  const { data: approvalSummary } = useQuery<Record<string, any>>({
    queryKey: ["/api/ideas", idea.id, "approval-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/ideas/${idea.id}/approval-summary`, { credentials: "include" });
      if (!res.ok) return {};
      return res.json();
    },
    staleTime: 30000,
  });

  const getStageTooltip = (stage: string): ReactNode | null => {
    const artifacts = STAGE_ARTIFACTS[stage];
    if (!artifacts || !approvalSummary) return null;

    const items = artifacts.map(key => {
      const data = approvalSummary[key];
      if (!data) return { key, label: ARTIFACT_LABELS[key] || key, status: "pending" as const };
      return {
        key,
        label: ARTIFACT_LABELS[key] || key,
        status: data.invalidated ? "invalidated" as const : "approved" as const,
        version: data.version,
        userName: data.userName,
        approvedAt: data.approvedAt,
      };
    });

    if (items.every(i => i.status === "pending")) return null;

    return (
      <div className="space-y-1.5 text-left min-w-[180px]">
        <div className="text-[11px] font-semibold text-foreground border-b border-border pb-1 mb-1">{stage}</div>
        {items.map(item => (
          <div key={item.key} className="flex items-center justify-between gap-3">
            <span className="text-[10px] text-muted-foreground">{item.label}</span>
            {item.status === "approved" ? (
              <div className="flex items-center gap-1">
                <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
                  v{item.version || 1}
                </span>
                <span className="text-[9px] text-muted-foreground">{item.userName}</span>
              </div>
            ) : item.status === "invalidated" ? (
              <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-400">needs redo</span>
            ) : (
              <span className="text-[9px] text-muted-foreground/60">pending</span>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col h-full" data-testid="panel-stage-tracker">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Progress
          </h3>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4">
          <div className="relative">
            {PIPELINE_STAGES.map((stage, index) => {
              const isCompleted = index < currentIndex;
              const isCurrent = index === currentIndex;
              const isFuture = index > currentIndex;
              const tooltip = getStageTooltip(stage);

              const stageContent = (
                <div key={stage} className="relative flex group" data-testid={`stage-step-${index}`}>
                  <div className="flex flex-col items-center shrink-0 w-6 z-10">
                    <div className="flex items-center justify-center w-6 h-6 shrink-0">
                      {isCompleted && (
                        <button
                          onClick={() => onStageClick(stage)}
                          className="flex items-center justify-center w-5 h-5 rounded-full bg-cb-teal/20 border border-cb-teal/30 cursor-pointer hover:bg-cb-teal/30 transition-colors"
                          data-testid={`button-stage-${index}`}
                        >
                          <Check className="h-2.5 w-2.5 text-cb-teal" />
                        </button>
                      )}
                      {isCurrent && (
                        <div className="flex items-center justify-center w-5 h-5 rounded-full bg-primary/20 border-2 border-primary">
                          <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                        </div>
                      )}
                      {isFuture && (
                        <div className="flex items-center justify-center w-5 h-5 rounded-full bg-muted/30 border border-border/50">
                          <Lock className="h-2 w-2 text-muted-foreground/40" />
                        </div>
                      )}
                    </div>
                    {index < PIPELINE_STAGES.length - 1 && (
                      <div
                        className={`w-[2px] flex-1 ${
                          isCompleted
                            ? "bg-cb-teal/40"
                            : isCurrent
                              ? "bg-gradient-to-b from-primary/60 to-border/30"
                              : "bg-border/30"
                        }`}
                      />
                    )}
                  </div>

                  <div className="ml-2.5 pb-5 min-w-0 flex-1 pt-[3px]">
                    <span
                      className={`text-xs leading-tight block ${
                        isCurrent
                          ? "text-primary font-semibold"
                          : isCompleted
                            ? "text-foreground/80 font-medium"
                            : "text-muted-foreground/50"
                      }`}
                    >
                      {stage}
                    </span>
                    {isCompleted && completedStages[stage] && (
                      <span
                        className="text-[10px] text-muted-foreground/60 mt-0.5 block cursor-default"
                        title={completedStages[stage].full}
                      >
                        {completedStages[stage].short}
                      </span>
                    )}
                    {isCurrent && (
                      <span className="text-[10px] text-primary/70 mt-0.5 block">
                        In progress
                      </span>
                    )}
                  </div>
                </div>
              );

              if (tooltip && (isCompleted || isCurrent)) {
                return (
                  <Tooltip key={stage}>
                    <TooltipTrigger asChild>{stageContent}</TooltipTrigger>
                    <TooltipContent side="right" className="p-2.5 bg-popover border-border max-w-[260px]">
                      {tooltip}
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return stageContent;
            })}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  docType?: "PDD" | "SDD" | "DSD";
  docId?: number;
  uipathData?: any;
  deployReport?: any;
}

function stripStepTags(text: string): string {
  return text
    .replace(/\[STEP:\s*[^\]]*\]/g, "")
    .replace(/\[DOC:(PDD|SDD|DSD):\d+\]/g, "")
    .replace(/\[APPROVE:(PDD|SDD|DSD)\]/g, "")
    .replace(/\[DEPLOY_UIPATH\]/g, "")
    .replace(/\[DEPLOY_REPORT:[\s\S]*?\]/g, "")
    .replace(/\[STAGE_BACK:\s*[^\]]+\]/g, "")
    .replace(/\[AUTOMATION_TYPE:\s*[^\]]*\]/gi, "")
    .replace(/\[FEASIBILITY_SUMMARY\][\s\S]*?\[\/FEASIBILITY_SUMMARY\]/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseMessageMeta(content: string): { docType?: "PDD" | "SDD" | "DSD"; docId?: number; uipathData?: any; deployReport?: any; displayContent: string } {
  const docMatch = content.match(/^\[DOC:(PDD|SDD|DSD):(\d+)\]/);
  if (docMatch) {
    return {
      docType: docMatch[1] as "PDD" | "SDD" | "DSD",
      docId: parseInt(docMatch[2]),
      displayContent: stripStepTags(content.slice(docMatch[0].length)),
    };
  }
  const uipathMatch = content.match(/^\[UIPATH:([\s\S]*)\]$/);
  if (uipathMatch) {
    try {
      return {
        uipathData: JSON.parse(uipathMatch[1]),
        displayContent: "",
      };
    } catch {
      return { displayContent: stripStepTags(content) };
    }
  }
  const deployReportMatch = content.match(/\[DEPLOY_REPORT:([\s\S]*)\]$/);
  if (deployReportMatch) {
    try {
      const report = JSON.parse(deployReportMatch[1]);
      const displayContent = content.slice(0, deployReportMatch.index).trim();
      return {
        deployReport: report,
        displayContent: stripStepTags(displayContent),
      };
    } catch {
      return { displayContent: stripStepTags(content.replace(/\[DEPLOY_REPORT:[\s\S]*\]$/, "").trim()) };
    }
  }
  return { displayContent: stripStepTags(content) };
}

function ChatPanel({ idea, switchProcessMapViewRef, onMapApprovalReady }: { idea: Idea; switchProcessMapViewRef: MutableRefObject<((view: "as-is" | "to-be" | "sdd") => void) | null>; onMapApprovalReady?: (fn: (approvedView: string, isReapproval?: boolean) => void) => void }) {
  const { toast } = useToast();
  const [streamingMsg, setStreamingMsg] = useState<ChatMsg | null>(null);
  const [pendingUserMsg, setPendingUserMsg] = useState<ChatMsg | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [isGeneratingDoc, setIsGeneratingDoc] = useState(false);
  const [generatingDocType, setGeneratingDocType] = useState<string>("");
  const [docProgressSection, setDocProgressSection] = useState<string>("");
  const [deployStep, setDeployStep] = useState<string>("");
  const [classifiedIntent, setClassifiedIntent] = useState<string>("");
  const [liveStatusLocal, setLiveStatus] = useState<string>("");
  const {
    currentRun: currentUiPathRun,
    completedRuns: completedUiPathRuns,
    pipelineLogEntries,
    pipelineComplete,
    pipelineFinalStatus: uipathFinalStatus,
    isRunning: uipathIsRunning,
    showProgressPanel: uipathShowProgressPanel,
    dismissProgressPanel: uipathDismissProgressPanel,
    startRun: startUiPathRun,
    cancelRun: cancelUiPathRun,
    metaValidationChipStatus,
    metaValidationFixCount,
    liveStatus: uipathLiveStatus,
    cancelState: uipathCancelState,
    generationStartTime: uipathStartTime,
  } = useUiPathRun(idea.id);
  const liveStatus = uipathIsRunning ? uipathLiveStatus : liveStatusLocal;
  const [docMetaValidationChipStatus, setDocMetaValidationChipStatus] = useState<string>("ready");
  const [docMetaValidationFixCount, setDocMetaValidationFixCount] = useState(0);
  const effectiveMetaValidationChipStatus = (uipathIsRunning ? metaValidationChipStatus : docMetaValidationChipStatus) as "ready" | "assessing" | "will-validate" | "not-needed" | "active" | "validating" | "fixed" | "clean" | "warning";
  const effectiveMetaValidationFixCount = uipathIsRunning ? metaValidationFixCount : docMetaValidationFixCount;
  const [messageToRunId, setMessageToRunId] = useState<Map<string, string>>(new Map());
  const [deployPipelineLogEntries, setDeployPipelineLogEntries] = useState<PipelineLogEntry[]>([]);
  const [deployPipelineComplete, setDeployPipelineComplete] = useState(false);

  const [streamingDocContent, setStreamingDocContent] = useState<string>("");
  const [streamingDocElapsed, setStreamingDocElapsed] = useState(0);
  const streamingDocElapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [feasibilityData, setFeasibilityData] = useState<{ type: string; rationale: string; complexity?: string | null; effortEstimate?: string | null } | null>(null);
  const [messageQueue, setMessageQueue] = useState<Array<{ id: string; text: string; imageData?: { base64: string; mediaType: string } }>>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initialScrollDoneRef = useRef(false);

  useEffect(() => {
    initialScrollDoneRef.current = false;
    setMessageToRunId(new Map());
    uipathTriggeredRef.current = false;
  }, [idea.id]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamingMsgRef = useRef<string>("");
  const chatInitializedRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (chatInitializedRef.current) return;
    chatInitializedRef.current = true;
    fetch(`/api/ideas/${idea.id}/init-chat`, {
      method: "POST",
      credentials: "include",
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
    }).catch(() => {});
  }, [idea.id]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (streamingDocElapsedRef.current) {
        clearInterval(streamingDocElapsedRef.current);
        streamingDocElapsedRef.current = null;
      }
    };
  }, []);

  const isGeneratingDocRef = useRef(false);
  const generatingDocTypeRef = useRef("");
  const docGenIdRef = useRef(0);

  const startDocStreaming = useCallback((type: string) => {
    docGenIdRef.current++;
    setIsGeneratingDoc(true);
    setGeneratingDocType(type);
    isGeneratingDocRef.current = true;
    generatingDocTypeRef.current = type;
    setDocProgressSection("");
    setStreamingDocContent("");
    setStreamingDocElapsed(0);
    if (streamingDocElapsedRef.current) clearInterval(streamingDocElapsedRef.current);
    streamingDocElapsedRef.current = setInterval(() => setStreamingDocElapsed(p => p + 1), 1000);
    if (docGenSafetyTimerRef.current) clearTimeout(docGenSafetyTimerRef.current);
    const safetyMs = type === "SDD" ? 360_000 : 240_000;
    docGenSafetyTimerRef.current = setTimeout(() => {
      if (isGeneratingDocRef.current) {
        console.warn(`[DocGen] Safety timeout: isGeneratingDoc stuck for ${safetyMs / 1000}s, forcing reset`);
        isGeneratingDocRef.current = false;
        generatingDocTypeRef.current = "";
        setIsGeneratingDoc(false);
        setGeneratingDocType("");
        setDocProgressSection("");
        setStreamingDocContent("");
        setStreamingDocElapsed(0);
        if (streamingDocElapsedRef.current) {
          clearInterval(streamingDocElapsedRef.current);
          streamingDocElapsedRef.current = null;
        }
      }
    }, safetyMs);
  }, []);

  const stopDocStreaming = useCallback((opts?: { force?: boolean }) => {
    if (!opts?.force && !isGeneratingDocRef.current) return;
    isGeneratingDocRef.current = false;
    generatingDocTypeRef.current = "";
    setIsGeneratingDoc(false);
    setGeneratingDocType("");
    setDocProgressSection("");
    setStreamingDocContent("");
    setStreamingDocElapsed(0);
    if (streamingDocElapsedRef.current) {
      clearInterval(streamingDocElapsedRef.current);
      streamingDocElapsedRef.current = null;
    }
    if (docGenSafetyTimerRef.current) {
      clearTimeout(docGenSafetyTimerRef.current);
      docGenSafetyTimerRef.current = null;
    }
  }, []);

  const cancelDocGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    stopDocStreaming({ force: true });
    setIsStreaming(false);
    setStreamingMsg(null);
    setPendingUserMsg(null);
  }, [stopDocStreaming]);
  const toBeTriggeredRef = useRef(false);
  const toBeGeneratingRef = useRef(false);
  const pendingToBeGenerationRef = useRef(false);
  const pddTriggeredRef = useRef(false);
  const sddTriggeredRef = useRef(false);
  const uipathTriggeredRef = useRef(false);
  const pendingDocTriggerRef = useRef<"PDD" | "SDD" | null>(null);
  const toBeMapApprovedRef = useRef(false);
  const docGenSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generateDocRef = useRef<((type: "PDD" | "SDD") => void) | null>(null);
  const generateUiPathRef = useRef<((force?: boolean, source?: "chat" | "retry" | "approval" | "auto") => void) | null>(null);
  const generateToBeRef = useRef<(() => void) | null>(null);

  const dispatchGenerationForApproval = useCallback((viewType: "as-is" | "to-be", isReapproval: boolean) => {
    if (isReapproval) {
      if (viewType === "as-is") {
        toBeTriggeredRef.current = false;
        toBeMapApprovedRef.current = false;
        pddTriggeredRef.current = false;
        sddTriggeredRef.current = false;
        uipathTriggeredRef.current = false;
      } else {
        toBeMapApprovedRef.current = false;
        pddTriggeredRef.current = false;
        sddTriggeredRef.current = false;
        uipathTriggeredRef.current = false;
      }
    }

    if (viewType === "as-is") {
      toBeMapApprovedRef.current = false;
      if (toBeTriggeredRef.current) return;
      toBeTriggeredRef.current = true;
      setTimeout(() => generateToBeRef.current?.(), 500);
    } else {
      toBeMapApprovedRef.current = true;
      if (pddTriggeredRef.current) return;
      pddTriggeredRef.current = true;
      setTimeout(() => generateDocRef.current?.("PDD"), 500);
    }
  }, []);

  const guidance = STAGE_GUIDANCE[idea.stage];

  const { data: savedMessages, isLoading: loadingHistory } = useQuery<DBChatMessage[]>({
    queryKey: ["/api/ideas", idea.id, "messages"],
    queryFn: async () => {
      const res = await fetch(`/api/ideas/${idea.id}/messages`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load messages");
      return res.json();
    },
    enabled: !!idea.id,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const savedMessagesRef = useRef(savedMessages);
  savedMessagesRef.current = savedMessages;

  const isSystemTriggerMsg = (content: string) =>
    /^Generate the (Process Design Document|Solution Design Document|Detailed Solution Design Document).*\[DOC:(PDD|SDD|DSD):/.test(content) ||
    /^Generate the To-Be process map based on the approved As-Is map/.test(content) ||
    /^First, perform the feasibility assessment/.test(content);

  const displayMessages: ChatMsg[] = (() => {
    if (savedMessages && savedMessages.length > 0) {
      const loaded: ChatMsg[] = savedMessages
        .filter((m) => m.role !== "system" && !isSystemTriggerMsg(m.content))
        .filter((m) => !(m.role === "assistant" && (!m.content || m.content.trim().length === 0)))
        .map((m) => {
        const meta = parseMessageMeta(m.content);
        return {
          id: String(m.id),
          role: m.role as "user" | "assistant",
          content: meta.displayContent,
          timestamp: new Date(m.createdAt),
          docType: meta.docType,
          docId: meta.docId,
          uipathData: meta.uipathData,
          deployReport: meta.deployReport,
        };
      }).filter((m) => m.content || m.docType || m.uipathData || m.deployReport);
      const result = [...loaded];
      if (pendingUserMsg && !isSystemTriggerMsg(pendingUserMsg.content)) result.push(pendingUserMsg);
      if (streamingMsg) result.push(streamingMsg);
      return result;
    }
    if (!loadingHistory) {
      const result: ChatMsg[] = [];
      if (pendingUserMsg && !isSystemTriggerMsg(pendingUserMsg.content)) result.push(pendingUserMsg);
      if (streamingMsg) result.push(streamingMsg);
      return result;
    }
    return [];
  })();

  useEffect(() => {
    if (displayMessages.length === 0) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    } else {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [displayMessages]);

  useEffect(() => {
    if (!savedMessages || savedMessages.length === 0) return;
    if (isGeneratingDocRef.current) return;

    const asIsApprovalPatterns = ["As-Is process map approved", "As-Is process map re-approved"];
    const hasAsIsApproval = savedMessages.some(
      (m) => (m.role === "assistant" || m.role === "system") && asIsApprovalPatterns.some(p => m.content.includes(p))
    );
    const isAsIsReapproval = savedMessages.some(
      (m) => (m.role === "assistant" || m.role === "system") && m.content.includes("As-Is process map re-approved")
    );
    const hasToBeSteps = savedMessages.some(
      (m) => m.role === "assistant" && m.content.includes("TO-BE Process Map")
    );
    if (hasAsIsApproval && !hasToBeSteps && !toBeTriggeredRef.current && !toBeGeneratingRef.current && !isStreaming && !isGeneratingDoc) {
      dispatchGenerationForApproval("as-is", isAsIsReapproval);
      return;
    }

    const toBeApprovalPatterns = ["To-Be process map approved", "To-Be process map re-approved"];
    const hasToBeApproval = savedMessages.some(
      (m) => (m.role === "assistant" || m.role === "system") && toBeApprovalPatterns.some(p => m.content.includes(p))
    );
    const isToBeReapproval = savedMessages.some(
      (m) => (m.role === "assistant" || m.role === "system") && m.content.includes("To-Be process map re-approved")
    );
    const hasPdd = savedMessages.some(
      (m) => m.content.startsWith("[DOC:PDD:") || (m as any).docType === "PDD"
    );
    if (hasToBeApproval) {
      toBeMapApprovedRef.current = true;
    }
    if (hasToBeApproval && !hasPdd && !pddTriggeredRef.current && !isGeneratingDoc) {
      dispatchGenerationForApproval("to-be", isToBeReapproval);
      return;
    }

    const pddApprovalPatterns = ["PDD approved", "PDD has been approved", "approved the PDD", "[CHAT_APPROVAL] PDD approved"];
    const hasPddApproval = savedMessages.some(
      (m) => (m.role === "assistant" || m.role === "system") && pddApprovalPatterns.some(p => m.content.includes(p))
    );
    const hasSdd = savedMessages.some(
      (m) => m.content.startsWith("[DOC:SDD:") || (m as any).docType === "SDD"
    );
    if (hasPddApproval && !hasSdd && !sddTriggeredRef.current && !isGeneratingDoc) {
      sddTriggeredRef.current = true;
      generateDocRef.current?.("SDD");
      return;
    }

    const sddApprovalPatterns = ["SDD approved", "SDD has been approved", "approved the SDD", "[CHAT_APPROVAL] SDD approved"];
    const hasSddApproval = savedMessages.some(
      (m) => (m.role === "assistant" || m.role === "system") && sddApprovalPatterns.some(p => m.content.includes(p))
    );
    const hasUiPath = savedMessages.some(
      (m) => m.content.startsWith("[UIPATH:")
    );
    if (hasSddApproval && !hasUiPath && !uipathTriggeredRef.current && !isGeneratingDoc && !isStreaming) {
      uipathTriggeredRef.current = true;
      setTimeout(() => generateUiPathRef.current?.(false, "auto"), 500);
    }

    if (savedMessages && completedUiPathRuns.size > 0) {
      const uipathMessages = savedMessages.filter(m => m.content.startsWith("[UIPATH:"));
      let needsUpdate = false;
      const newMap = new Map(messageToRunId);
      const assignedRunIds = new Set(newMap.values());
      const unassignedRuns = Array.from(completedUiPathRuns.entries())
        .filter(([runId, run]) => !assignedRunIds.has(runId) && run.status !== "FAILED");
      const unassignedMsgs = uipathMessages.filter(m => !newMap.has(String(m.id)));
      const pairs = Math.min(unassignedRuns.length, unassignedMsgs.length);
      for (let i = 0; i < pairs; i++) {
        const msgIdx = unassignedMsgs.length - pairs + i;
        const runIdx = unassignedRuns.length - pairs + i;
        const msgId = String(unassignedMsgs[msgIdx].id);
        const [runId] = unassignedRuns[runIdx];
        newMap.set(msgId, runId);
        assignedRunIds.add(runId);
        needsUpdate = true;
      }
      if (needsUpdate) {
        setMessageToRunId(newMap);
      }
    }
  }, [savedMessages, isGeneratingDoc, isStreaming, completedUiPathRuns]);

  useEffect(() => {
    if (!isStreaming && !isGeneratingDoc && pendingToBeGenerationRef.current) {
      console.log(`[ProcessMap] Streaming ended — retrying deferred To-Be generation`);
      pendingToBeGenerationRef.current = false;
      dispatchGenerationForApproval("as-is", false);
    }
  }, [isStreaming, isGeneratingDoc, dispatchGenerationForApproval]);

  useEffect(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (!savedMessages || savedMessages.length === 0 || isStreaming || isGeneratingDoc) return;

    const lastMsg = savedMessages[savedMessages.length - 1];
    if (lastMsg.role === "assistant" && lastMsg.content.endsWith("?")) {
      idleTimerRef.current = setTimeout(async () => {
        try {
          await fetch(`/api/ideas/${idea.id}/nudge`, {
            method: "POST",
            credentials: "include",
          });
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
        } catch {}
      }, 60000);
    }

    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [savedMessages, isStreaming, isGeneratingDoc, idea.id]);

  const lastUserMessageRef = useRef<string>("");

  const isToBeRelatedMessage = useCallback((msg: string): boolean => {
    const lower = msg.toLowerCase();
    const toBeRef = /\bto[\s-]?be\b/.test(lower);
    const modifyKeywords = /\b(simplif|modif|change|update|regenerat|redo|revise|improv|refin|reduc|optimiz|streamlin|consolidat|merg|rework|redesign|adjust|alter|rearrang)/i.test(lower);
    if (toBeRef && modifyKeywords) return true;
    const stageIndex = PIPELINE_STAGES.indexOf(idea.stage as PipelineStage);
    const feasibilityIndex = PIPELINE_STAGES.indexOf("Feasibility Assessment");
    if (stageIndex >= feasibilityIndex && modifyKeywords) {
      const mapRef = /\b(map|process|steps?|workflow|flow)\b/.test(lower);
      if (mapRef && !(/\bas[\s-]?is\b/.test(lower))) return true;
    }
    return false;
  }, [idea.stage]);

  const sendMessageDirect = useCallback(async (text: string, imageData?: { base64: string; mediaType: string }, intentOverride?: string) => {
    lastUserMessageRef.current = text;
    setClassifiedIntent(intentOverride || guessIntentFromMessage(text));
    setDeployStep("");
    if (isToBeRelatedMessage(text)) {
      toBeGeneratingRef.current = true;
      console.log(`[ProcessMap] Detected TO-BE modification from user message, setting toBeGeneratingRef=true`);
    }

    if (isGeneratingDocRef.current && !abortControllerRef.current) {
      isGeneratingDocRef.current = false;
      generatingDocTypeRef.current = "";
    }

    let localClassifiedIntent = "";
    let localDeployStarted = false;
    let docGenIdAtStart = docGenIdRef.current;
    const userMsg: ChatMsg = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date(),
    };
    setPendingUserMsg(userMsg);
    setIsStreaming(true);

    const streamMsg: ChatMsg = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: "",
      timestamp: new Date(),
      isStreaming: true,
    };
    setStreamingMsg(streamMsg);
    streamingMsgRef.current = "";
    setLiveStatus("");

    const controller = new AbortController();
    abortControllerRef.current = controller;
    let didRetry = false;

    const handleSSEEvent = (data: any) => {
        if (data.token) {
          if (!streamingMsgRef.current) {
            setLiveStatus("");
          }
          streamingMsgRef.current += data.token;
          const docTagMatch = streamingMsgRef.current.match(/^\[DOC:(PDD|SDD|DSD):/);
          if (docTagMatch && !isGeneratingDocRef.current) {
            startDocStreaming(docTagMatch[1]);
            docGenIdAtStart = docGenIdRef.current;
          }
          if (isGeneratingDocRef.current && generatingDocTypeRef.current !== "DHG") {
            const raw = streamingMsgRef.current;
            const tagEnd = raw.match(/^\[DOC:(PDD|SDD|DSD):\d+\]/);
            const docText = tagEnd ? raw.slice(tagEnd[0].length) : raw;
            setStreamingDocContent(docText);
          }
          setStreamingMsg((prev) =>
            prev ? { ...prev, content: prev.content + data.token } : prev
          );
        }
        if (data.liveStatus) {
          setLiveStatus(data.liveStatus);
        }
        if (data.metaValidation) {
          const mv = data.metaValidation;
          if (mv.status === "started") {
            setDocMetaValidationChipStatus("validating");
          } else if (mv.status === "assessing") {
            setDocMetaValidationChipStatus("assessing");
          } else if (mv.status === "will-validate") {
            setDocMetaValidationChipStatus("will-validate");
          } else if (mv.status === "not-needed") {
            setDocMetaValidationChipStatus("not-needed");
          } else if (mv.status === "completed") {
            if (mv.correctionsApplied > 0) {
              setDocMetaValidationChipStatus("fixed");
              setDocMetaValidationFixCount(mv.correctionsApplied);
            } else {
              setDocMetaValidationChipStatus("clean");
            }
          } else if (mv.status === "warning") {
            setDocMetaValidationChipStatus("warning");
            setDocMetaValidationFixCount(mv.correctionsApplied || 0);
          }
        }
        if (data.triggerUiPathGen) {
          if (uipathIsRunning) {
            console.log("[UiPath Trigger] triggerUiPathGen received but generation already in flight — ignoring");
          } else {
            console.log("[UiPath Trigger] triggerUiPathGen received — calling new run endpoint");
            setTimeout(() => generateUiPathRef.current?.(true, "chat"), 500);
          }
        }
        if (data.intentClassified) {
          localClassifiedIntent = data.intentClassified;
          setClassifiedIntent(data.intentClassified);
          setLiveStatus("");
        }
        if (data.done) {
          setStreamingMsg((prev) =>
            prev ? { ...prev, isStreaming: false } : prev
          );
          setDocProgressSection("");
          setClassifiedIntent("");
          setLiveStatus("");
        }
        if (data.pipelineEvent) {
          const evt = data.pipelineEvent;
          setDeployPipelineLogEntries(prev => [...prev, {
            id: `pe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: evt.type,
            stage: evt.stage,
            message: evt.message,
            elapsed: evt.elapsed,
            context: evt.context,
            timestamp: Date.now(),
          }]);
          if (evt.stage === "complete" && evt.type === "completed") {
            setDeployPipelineComplete(true);
          }
          if (evt.stage === "complexity_classification" && evt.type === "completed" && evt.context?.complexityTier) {
            const pathLabel = evt.context.streamlined ? "streamlined" : "full pipeline";
            setLiveStatus(`Generating package (${pathLabel})...`);
          }
        }
        if (data.docProgress) {
          const docType = data.docProgress.docType || "PDD";
          if (data.docProgress.started && !isGeneratingDocRef.current) {
            if (docType === "UiPath") {
              console.log("[UiPath Trigger] docProgress started with docType=UiPath — treated as non-blocking (no startDocStreaming, no isGeneratingDoc)");
            } else {
              startDocStreaming(docType);
              docGenIdAtStart = docGenIdRef.current;
            }
          }
        }
        if (data.deployStatus) {
          if (data.deployComplete) {
            setDeployStep("");
            setClassifiedIntent("");
            setStreamingMsg(null);
            queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
          } else {
            if (!localDeployStarted) {
              localDeployStarted = true;
              setDeployPipelineLogEntries([]);
              setDeployPipelineComplete(false);

            }
            setDeployStep(data.deployStatus);
            setStreamingMsg((prev) => prev ? { ...prev } : prev);
          }
        }
        if (data.mapApproval) {
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "process-approval-history"] });
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "approval-summary"] });
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "process-map"] });
          const isReapproval = !!data.mapApproval.isReapproval;
          if (data.mapApproval.nextAction === "generate-to-be" || data.mapApproval.nextAction === "generate-feasibility-and-to-be") {
            dispatchGenerationForApproval("as-is", isReapproval);
          }
          if (data.mapApproval.nextAction === "generate-pdd") {
            dispatchGenerationForApproval("to-be", isReapproval);
          }
        }
        if (data.docTrigger) {
          const triggerType = data.docTrigger.type as "PDD" | "SDD";
          console.log(`[DocTrigger] Server requested ${triggerType} generation via dedicated endpoint`);
          pendingDocTriggerRef.current = triggerType;
        }
        if (data.transition) {
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id] });
          queryClient.invalidateQueries({ queryKey: ["/api/ideas"] });
          const { fromStage, toStage, reason } = data.transition;
          toast({
            title: fromStage && toStage && PIPELINE_STAGES.indexOf(fromStage) > PIPELINE_STAGES.indexOf(toStage)
              ? `Stage Moved Back: ${toStage}`
              : `Stage Advanced: ${toStage}`,
            description: reason || `Moved from ${fromStage}`,
          });
        }
        if (data.automationType) {
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id] });
        }
        if (data.feasibilityAssessment) {
          setFeasibilityData(data.feasibilityAssessment);
          setClassifiedIntent("TO_BE_MAP");
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id] });
        }
        if (data.dhgProgress) {
          if (data.dhgProgress.started) {
            startDocStreaming("DHG");
            docGenIdAtStart = docGenIdRef.current;
          }
        }
        if (data.error) {
          streamingMsgRef.current = "";
          setStreamingMsg(null);
          stopDocStreaming({ force: true });
          toast({
            title: "Message failed",
            description: "Something went wrong. Please try sending your message again.",
            variant: "destructive",
          });
        }
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        credentials: "include",
        body: JSON.stringify({ ideaId: idea.id, content: text, ...(imageData ? { imageData } : {}) }),
      });

      if (!res.ok) {
        throw new Error("Chat request failed");
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("No stream reader");

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSEEvent(data);
            } catch {}
          }
        }
      }
    } catch (err: any) {
      streamingMsgRef.current = "";
      setStreamingMsg(null);
      if (err?.name === "AbortError") {
        queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
        return;
      }
      if (!didRetry) {
        didRetry = true;
        console.log("[Chat] Connection error, attempting automatic retry in 2s...");
        setLiveStatus("Reconnecting...");
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const retryController = new AbortController();
          abortControllerRef.current = retryController;
          setStreamingMsg({
            id: `assistant-${Date.now()}`,
            role: "assistant",
            content: "",
            timestamp: new Date(),
            isStreaming: true,
          });
          streamingMsgRef.current = "";
          const retryRes = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: retryController.signal,
            credentials: "include",
            body: JSON.stringify({ ideaId: idea.id, content: text, ...(imageData ? { imageData } : {}) }),
          });
          if (!retryRes.ok) throw new Error("Retry request failed");
          const retryReader = retryRes.body?.getReader();
          if (!retryReader) throw new Error("No retry stream reader");
          const retryDecoder = new TextDecoder();
          let retryBuffer = "";
          while (true) {
            const { done: retryDone, value: retryValue } = await retryReader.read();
            if (retryDone) break;
            retryBuffer += retryDecoder.decode(retryValue, { stream: true });
            const retryLines = retryBuffer.split("\n");
            retryBuffer = retryLines.pop() || "";
            for (const retryLine of retryLines) {
              if (retryLine.startsWith("data: ")) {
                try {
                  const data = JSON.parse(retryLine.slice(6));
                  handleSSEEvent(data);
                } catch {}
              }
            }
          }
          return;
        } catch {
          setLiveStatus("");
        }
      }
      toast({
        title: "Connection error",
        description: "Couldn't reach the server. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
      setDeployStep("");
      setPendingUserMsg(null);
      const finalContent = streamingMsgRef.current;
      setStreamingMsg(null);

      try {
        await queryClient.refetchQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
      } catch {
        try {
          await queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
        } catch { /* best-effort */ }
      }
      queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "artifacts"] });

      stopDocStreaming({ force: true });

      if (pendingDocTriggerRef.current) {
        const pendingType = pendingDocTriggerRef.current;
        pendingDocTriggerRef.current = null;
        const triggerRef = pendingType === "PDD" ? pddTriggeredRef : sddTriggeredRef;
        if (!triggerRef.current) {
          triggerRef.current = true;
          setTimeout(() => generateDocRef.current?.(pendingType), 300);
        }
      }

      const isToBeRun = toBeGeneratingRef.current;
      const lastMsg = lastUserMessageRef.current;
      const isToBeFromMessage = isToBeRelatedMessage(lastMsg);
      const stageIndex = PIPELINE_STAGES.indexOf(idea.stage as PipelineStage);
      const designIndex = PIPELINE_STAGES.indexOf("Design");
      const isPastDesign = stageIndex > designIndex;
      const hasStepTags = finalContent ? /\[STEP:\s*[^|]+?\s*\|/.test(finalContent) : false;
      const isToBeContext = isToBeRun || isToBeFromMessage || (isPastDesign && hasStepTags);
      toBeGeneratingRef.current = false;

      if (finalContent) {
        const defaultView: "as-is" | "to-be" = (isToBeContext || isPastDesign) ? "to-be" : "as-is";
        const viewStepSets = parseStepsByView(finalContent, defaultView);

        if (isToBeContext || isPastDesign) {
          for (const entry of viewStepSets) {
            if (entry.viewType === "as-is") {
              console.log(`[ProcessMap] View pinning: forcing viewType from as-is to to-be (stage=${idea.stage}, isToBeContext=${isToBeContext}, isPastDesign=${isPastDesign})`);
              entry.viewType = "to-be";
            }
          }
        }

        let firstCreatedView: string | null = null;

        for (const { viewType, steps } of viewStepSets) {
          if (steps.length === 0) continue;

          const normalizeName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
          const hasStepNumbers = steps.some(s => s.stepNumber);

          let dedupedSteps: typeof steps;
          if (hasStepNumbers) {
            const stepMap = new Map();
            for (const step of steps) {
              const key = step.stepNumber || step.name;
              stepMap.set(key, step);
            }
            dedupedSteps = Array.from(stepMap.values());
          } else {
            dedupedSteps = steps.filter((step, idx, arr) => {
              const norm = normalizeName(step.name);
              return arr.findIndex(s => normalizeName(s.name) === norm) === idx;
            });
          }

          const endNameToFirst = new Map<string, number>();
          const endDupTargetRemap = new Map<number, number>();
          for (let i = 0; i < dedupedSteps.length; i++) {
            if (dedupedSteps[i].nodeType === "end") {
              const norm = normalizeName(dedupedSteps[i].name);
              if (endNameToFirst.has(norm)) {
                endDupTargetRemap.set(i, endNameToFirst.get(norm)!);
              } else {
                endNameToFirst.set(norm, i);
              }
            }
          }

          const hasStartNode = dedupedSteps.some(s => s.nodeType === "start");
          const hasEndNode = dedupedSteps.some(s => s.nodeType === "end");
          const clearExisting = hasStartNode && hasEndNode && dedupedSteps.length >= 3;

          const stepNumberToIndex: Record<string, number> = {};
          dedupedSteps.forEach((step, i) => {
            if (step.stepNumber) stepNumberToIndex[step.stepNumber] = i;
          });

          const seenEdgePairs = new Set<string>();
          const bulkEdges: { sourceIndex: number; targetIndex: number; label: string }[] = [];

          for (let i = 0; i < dedupedSteps.length; i++) {
            const step = dedupedSteps[i];
            let sourceIndex: number | null = null;
            let label = step.edgeLabel || "";

            if (step.fromStepNumber) {
              sourceIndex = stepNumberToIndex[step.fromStepNumber] ?? null;
              if (sourceIndex === null) {
                const fallback = dedupedSteps.findIndex(s => s.stepNumber === step.fromStepNumber);
                if (fallback >= 0) sourceIndex = fallback;
              }
            } else if (step.from) {
              const fromNorm = normalizeName(step.from);
              const match = dedupedSteps.findIndex(s => {
                const n = normalizeName(s.name);
                return n === fromNorm || n.includes(fromNorm) || fromNorm.includes(n);
              });
              if (match >= 0) sourceIndex = match;
            } else {
              if (i > 0) sourceIndex = i - 1;
            }

            if (sourceIndex !== null && sourceIndex !== i) {
              let targetIndex = i;
              if (endDupTargetRemap.has(targetIndex)) {
                targetIndex = endDupTargetRemap.get(targetIndex)!;
              }
              const pairKey = `${sourceIndex}->${targetIndex}`;
              if (!seenEdgePairs.has(pairKey)) {
                seenEdgePairs.add(pairKey);
                bulkEdges.push({ sourceIndex, targetIndex, label });
              }
            }
          }

          const dupIndices = new Set(endDupTargetRemap.keys());
          const filteredSteps = dedupedSteps.filter((_, i) => !dupIndices.has(i));
          const oldToNewIdx = new Map<number, number>();
          let newI = 0;
          for (let i = 0; i < dedupedSteps.length; i++) {
            if (!dupIndices.has(i)) {
              oldToNewIdx.set(i, newI++);
            } else {
              oldToNewIdx.set(i, oldToNewIdx.get(endDupTargetRemap.get(i)!)!);
            }
          }
          const remappedEdges = bulkEdges.map(e => ({
            sourceIndex: oldToNewIdx.get(e.sourceIndex) ?? e.sourceIndex,
            targetIndex: oldToNewIdx.get(e.targetIndex) ?? e.targetIndex,
            label: e.label,
          }));
          dedupedSteps = filteredSteps;

          const edgeSources = new Set(remappedEdges.map(e => e.sourceIndex));
          const firstEndIdx = dedupedSteps.findIndex(s => s.nodeType === "end");
          if (firstEndIdx >= 0) {
            let repairedCount = 0;
            for (let idx = 0; idx < dedupedSteps.length; idx++) {
              const s = dedupedSteps[idx];
              if (s.nodeType === "end" || s.nodeType === "start") continue;
              if (edgeSources.has(idx)) continue;
              const pairKey = `${idx}->${firstEndIdx}`;
              if (!seenEdgePairs.has(pairKey)) {
                seenEdgePairs.add(pairKey);
                remappedEdges.push({ sourceIndex: idx, targetIndex: firstEndIdx, label: "" });
                repairedCount++;
              }
            }
            if (repairedCount > 0) {
              console.log(`[ProcessMap] Auto-repaired ${repairedCount} dead-end branch(es) for view=${viewType}`);
            }
          }

          const bulkNodes = dedupedSteps.map((step, i) => ({
            name: step.name,
            role: step.role,
            system: step.system,
            nodeType: step.nodeType,
            orderIndex: i,
          }));

          if (endDupTargetRemap.size > 0) {
            console.log(`[ProcessMap] Merged ${endDupTargetRemap.size} duplicate end nodes for view=${viewType}`);
          }
          if (viewType === "as-is" && isPastDesign) {
            console.log(`[ProcessMap] Blocked bulk write to as-is view — stage is past Design (${idea.stage}), skipping to protect approved AS-IS map`);
            continue;
          }
          if (viewType === "to-be" && isPastDesign && toBeMapApprovedRef.current) {
            console.log(`[ProcessMap] Blocked bulk write to to-be view — stage is past Design (${idea.stage}) and To-Be map already approved, skipping to protect approved TO-BE map`);
            continue;
          }

          console.log(`[ProcessMap] Bulk creating ${bulkNodes.length} nodes, ${remappedEdges.length} edges for view=${viewType} (clear=${clearExisting})`);

          const bulkRes = await fetch(`/api/ideas/${idea.id}/process-map/bulk`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ viewType, nodes: bulkNodes, edges: remappedEdges, clearExisting }),
          });

          if (!bulkRes.ok) {
            console.error(`[ProcessMap] Bulk create failed for ${viewType}: ${bulkRes.status}`);
            continue;
          }

          if (!firstCreatedView) firstCreatedView = viewType;
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "process-map", viewType] });
        }

        if (firstCreatedView && switchProcessMapViewRef.current) {
          switchProcessMapViewRef.current(firstCreatedView as "as-is" | "to-be" | "sdd");
        }
      }
    }
  }, [idea.id, idea.stage, isToBeRelatedMessage]);

  const generateDocument = useCallback(async (type: "PDD" | "SDD") => {
    if (isGeneratingDoc || isGeneratingDocRef.current || isStreaming) {
      console.log(`[DocGen] Skipping ${type} generation — already generating (isGeneratingDoc=${isGeneratingDoc}, ref=${isGeneratingDocRef.current}, isStreaming=${isStreaming})`);
      const triggerRef = type === "PDD" ? pddTriggeredRef : sddTriggeredRef;
      triggerRef.current = false;
      return;
    }
    startDocStreaming(type);
    setClassifiedIntent(type);
    const abortController = new AbortController();
    const abortTimeoutMs = type === "SDD" ? 300_000 : 180_000;
    const timeoutId = setTimeout(() => abortController.abort(), abortTimeoutMs);
    try {
      const res = await fetch(`/api/ideas/${idea.id}/documents/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ type }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: "Generation failed" }));
        throw new Error(data.message || "Generation failed");
      }

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let sseError: string | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));

              if (data.stageEvent) {
                const evt = data.stageEvent;
                const label = STAGE_DISPLAY_LABELS[evt.stage] || `Processing ${evt.stage.replace(/_/g, " ")}...`;
                if (evt.type === "stage_start") {
                  setDocProgressSection(label);
                } else if (evt.type === "stage_end" && evt.outcome === "failed" && evt.error) {
                  setDocProgressSection(`Failed: ${evt.error.slice(0, 100)}`);
                }
              }

              if (data.error) {
                sseError = data.message || "Generation failed";
              }

              if (data.done) {
                break;
              }
            } catch {}
          }
        }

        if (sseError) {
          throw new Error(sseError);
        }
      }

      await queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id] });
    } catch (err: any) {
      const timeoutMinutes = Math.round(abortTimeoutMs / 60_000);
      const message = err?.name === "AbortError"
        ? `Document generation timed out after ${timeoutMinutes} minutes. Please try again.`
        : (err?.message || "Something went wrong. Please try again.");
      toast({
        title: `${type} generation failed`,
        description: message,
        variant: "destructive",
      });
    } finally {
      clearTimeout(timeoutId);
      setClassifiedIntent("");
      stopDocStreaming({ force: true });
      if (pendingDocTriggerRef.current) {
        const pendingType = pendingDocTriggerRef.current;
        pendingDocTriggerRef.current = null;
        const triggerRef = pendingType === "PDD" ? pddTriggeredRef : sddTriggeredRef;
        if (!triggerRef.current) {
          console.log(`[DocGen] Consuming pending doc trigger after generation completed: ${pendingType}`);
          triggerRef.current = true;
          setTimeout(() => generateDocRef.current?.(pendingType), 300);
        }
      }
    }
  }, [isGeneratingDoc, isStreaming, startDocStreaming, stopDocStreaming, idea.id, toast]);

  generateDocRef.current = generateDocument;

  const generateToBeMap = useCallback(() => {
    if (isStreaming || isGeneratingDoc) {
      console.log(`[ProcessMap] To-Be generation deferred — isStreaming=${isStreaming}, isGeneratingDoc=${isGeneratingDoc}`);
      pendingToBeGenerationRef.current = true;
      toBeTriggeredRef.current = false;
      return;
    }
    pendingToBeGenerationRef.current = false;
    toBeGeneratingRef.current = true;
    sendMessageDirect(
      "First, perform the feasibility assessment: evaluate the automation type (RPA vs Agent vs Hybrid) for this process and output the [AUTOMATION_TYPE:] tag. " +
      "Then generate the To-Be process map based on the approved As-Is map and the available UiPath services. " +
      "Show the automated future state. Use the section header 'TO-BE Process Map' followed by [STEP:] tags.",
      undefined,
      "FEASIBILITY"
    );
  }, [isStreaming, isGeneratingDoc, sendMessageDirect]);
  generateToBeRef.current = generateToBeMap;

  const handleMapApprovalFromPanel = useCallback((approvedView: string, isReapproval?: boolean) => {
    if (approvedView === "as-is" || approvedView === "to-be") {
      dispatchGenerationForApproval(approvedView, !!isReapproval);
    }
  }, [dispatchGenerationForApproval]);

  useEffect(() => {
    onMapApprovalReady?.(handleMapApprovalFromPanel);
  }, [onMapApprovalReady, handleMapApprovalFromPanel]);

  // NOTE: force=true bypasses the chat-message cache check in document-routes.ts but does NOT bypass
  // the fingerprint-based pipeline cache in uipath-pipeline.ts. If the user regenerates with identical
  // inputs (same SDD, same map, same spec), the pipeline returns the cached build artifact. This is a
  // known follow-up — if users expect force=true to produce a fresh build, pipeline cache eviction
  // logic will need a separate change.
  generateUiPathRef.current = (force?: boolean, source?: "chat" | "retry" | "approval" | "auto") => startUiPathRun(source || "auto", force);

  const [approvedDocIds, setApprovedDocIds] = useState<Set<number>>(new Set());

  const handleDocApproved = useCallback(async (docType: "PDD" | "SDD" | "DSD", docId?: number) => {
    if (docId) {
      setApprovedDocIds(prev => new Set(prev).add(docId));
    }
    queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "documents", "versions", docType] });
    queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "documents", "latest", "PDD"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "documents", "latest", "SDD"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "approval-summary"] });
    if (docType === "PDD" && !sddTriggeredRef.current) {
      sddTriggeredRef.current = true;
      setTimeout(() => generateDocRef.current?.("SDD"), 500);
    }
    if (docType === "SDD" && !uipathTriggeredRef.current) {
      uipathTriggeredRef.current = true;
      setTimeout(() => generateUiPathRef.current?.(false, "approval"), 500);
    }
  }, [idea.id]);

  const removeFromQueue = useCallback((queueId: string) => {
    setMessageQueue(prev => prev.filter(m => m.id !== queueId));
  }, []);

  useEffect(() => {
    if (!isStreaming && !isGeneratingDoc && messageQueue.length > 0) {
      const [next, ...rest] = messageQueue;
      setMessageQueue(rest);
      sendMessageDirect(next.text, next.imageData);
    }
  }, [isStreaming, isGeneratingDoc, messageQueue, sendMessageDirect]);

  const [isUploading, setIsUploading] = useState(false);
  const [bannerApproving, setBannerApproving] = useState(false);

  const hasPddDoc = useMemo(() => displayMessages.some(m => m.docType === "PDD" && m.docId), [displayMessages]);
  const hasSddDoc = useMemo(() => displayMessages.some(m => m.docType === "SDD" && m.docId), [displayMessages]);

  const packageCharacteristics = useMemo(() => {
    const latestUiPathMsg = [...displayMessages].reverse().find(m => m.uipathData);
    if (!latestUiPathMsg?.uipathData) return undefined;
    const pkg = latestUiPathMsg.uipathData;
    const workflows = pkg.workflows || [];
    const totalActivities = workflows.reduce((sum: number, wf: any) => sum + (wf.steps?.length || 0), 0);
    const uipathMessageCount = displayMessages.filter(m => m.uipathData).length;
    return {
      hasReFramework: pkg.internal?.useReFramework === true || workflows.some((wf: any) => wf.name?.includes("GetTransactionData") || wf.name?.includes("SetTransactionStatus")),
      hasDocumentUnderstanding: workflows.some((wf: any) => (wf.steps || []).some((s: any) => s.activityType?.includes("DigitizeDocument") || s.activityType?.includes("ClassifyDocument"))),
      workflowCount: workflows.length,
      activityCount: totalActivities,
      isFirstProductionDeploy: uipathMessageCount <= 1,
    };
  }, [displayMessages]);

  const { data: pddApprovalData } = useQuery<{ document: any; approval: any }>({
    queryKey: ["/api/ideas", idea.id, "documents", "latest", "PDD"],
    enabled: hasPddDoc,
  });
  const { data: sddApprovalData } = useQuery<{ document: any; approval: any }>({
    queryKey: ["/api/ideas", idea.id, "documents", "latest", "SDD"],
    enabled: hasSddDoc,
  });

  const pendingApprovalDoc = useMemo(() => {
    if (hasPddDoc && pddApprovalData?.document && !pddApprovalData?.approval) {
      const pddMsg = [...displayMessages].reverse().find(m => m.docType === "PDD" && m.docId);
      if (pddMsg && !approvedDocIds.has(pddMsg.docId!)) {
        return { docType: "PDD", docId: pddMsg.docId! };
      }
    }
    if (hasSddDoc && sddApprovalData?.document && !sddApprovalData?.approval) {
      if (getApprovalReadiness("SDD", sddApprovalData.document.artifactsValid) === "blocked") {
        return null;
      }
      const sddMsg = [...displayMessages].reverse().find(m => m.docType === "SDD" && m.docId);
      if (sddMsg && !approvedDocIds.has(sddMsg.docId!)) {
        return { docType: "SDD", docId: sddMsg.docId! };
      }
    }
    return null;
  }, [hasPddDoc, hasSddDoc, pddApprovalData, sddApprovalData, displayMessages, approvedDocIds]);

  const handleBannerApprove = useCallback(async () => {
    if (!pendingApprovalDoc) return;
    setBannerApproving(true);
    try {
      const res = await fetch(`/api/ideas/${idea.id}/documents/${pendingApprovalDoc.docId}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await res.text());
      handleDocApproved(pendingApprovalDoc.docType as "PDD" | "SDD" | "DSD", pendingApprovalDoc.docId);
    } catch (err: any) {
      toast({ title: "Approval failed", description: err.message, variant: "destructive" });
    } finally {
      setBannerApproving(false);
    }
  }, [pendingApprovalDoc, idea.id, handleDocApproved, toast]);

  const handleSend = useCallback(async () => {
    let text = inputValue.trim();
    if (!text && !attachedFile) return;
    let pendingImageData: { base64: string; mediaType: string } | null = null;

    if (attachedFile) {
      const extractableTypes = [
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel",
        "text/plain",
        "text/csv",
      ];

      if (extractableTypes.includes(attachedFile.type)) {
        setIsUploading(true);
        try {
          const formData = new FormData();
          formData.append("files", attachedFile);
          const uploadRes = await fetch("/api/upload", { method: "POST", body: formData, credentials: "include" });
          if (uploadRes.ok) {
            const data = await uploadRes.json();
            if (data.files?.[0]?.text) {
              const extracted = data.files[0];
              const contextNote = `[UPLOADED_FILE: ${attachedFile.name} (${extracted.type})]\n\nExtracted content from "${attachedFile.name}":\n---\n${extracted.text}\n---\n\nUse this document content to help drive the automation pipeline. Analyze it for process steps, business rules, and requirements. If appropriate, suggest creating a process map or generating PDD/SDD documents based on this content.`;
              text = text ? `${text}\n\n${contextNote}` : contextNote;
            } else {
              text = text ? `${text}\n\n(User uploaded "${attachedFile.name}" but content extraction returned empty.)` : `(User uploaded "${attachedFile.name}" but content extraction returned empty.)`;
            }
          } else {
            text = text ? `${text}\n\n(User uploaded "${attachedFile.name}" but server-side extraction failed.)` : `(User uploaded "${attachedFile.name}" but server-side extraction failed.)`;
          }
        } catch (err) {
          console.error("File upload error:", err);
          text = text ? `${text}\n\n(User uploaded "${attachedFile.name}" but extraction encountered an error.)` : `(User uploaded "${attachedFile.name}" but extraction encountered an error.)`;
        } finally {
          setIsUploading(false);
        }
      } else if (attachedFile.type.startsWith("image/")) {
        try {
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              resolve(result.split(",")[1]);
            };
            reader.onerror = reject;
            reader.readAsDataURL(attachedFile);
          });
          pendingImageData = { base64, mediaType: attachedFile.type };
          const fileNote = `[UPLOADED_FILE: ${attachedFile.name} (${attachedFile.type})] — Image attached for AI analysis`;
          text = text ? `${text}\n\n${fileNote}` : fileNote;
        } catch (err) {
          console.error("Image read error:", err);
          const fileNote = `[UPLOADED_FILE: ${attachedFile.name} (${attachedFile.type})]\n\n(User uploaded an image but it could not be read.)`;
          text = text ? `${text}\n\n${fileNote}` : fileNote;
        }
      } else {
        const fileNote = `[UPLOADED_FILE: ${attachedFile.name} (${attachedFile.type})]\n\n(User uploaded a media file: "${attachedFile.name}". This file type cannot be parsed as text. Please ask the user to describe the process or steps shown in this file so you can create a process map and documentation.)`;
        text = text ? `${text}\n\n${fileNote}` : fileNote;
      }
    }

    setInputValue("");
    clearAttachedFile();

    if (isStreaming || isGeneratingDoc) {
      setMessageQueue(prev => [...prev, { id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, text, ...(pendingImageData ? { imageData: pendingImageData } : {}) }]);
      return;
    }

    sendMessageDirect(text, pendingImageData || undefined);
  }, [inputValue, attachedFile, isStreaming, isGeneratingDoc, sendMessageDirect, clearAttachedFile]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function attachFile(file: File) {
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setAttachedFile(file);
    if (file.type.startsWith("image/")) {
      setFilePreviewUrl(URL.createObjectURL(file));
    } else {
      setFilePreviewUrl(null);
    }
  }

  function clearAttachedFile() {
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
    setAttachedFile(null);
    setFilePreviewUrl(null);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      attachFile(file);
    }
    e.target.value = "";
  }

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hasText = false;
    let imageItem: DataTransferItem | null = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type === "text/plain") hasText = true;
      if (items[i].type.startsWith("image/") && !imageItem) imageItem = items[i];
    }
    if (hasText) return;
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) {
        const named = new File([file], `screenshot-${Date.now()}.png`, { type: file.type });
        attachFile(named);
      }
    }
  }

  if (loadingHistory) {
    return (
      <div className="flex flex-col h-full items-center justify-center" data-testid="panel-chat">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <p className="text-xs text-muted-foreground mt-2">Loading conversation...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-testid="panel-chat">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-4 w-4 text-cb-teal shrink-0" />
          <h3
            className="text-sm font-semibold text-foreground truncate"
            data-testid="text-chat-title"
          >
            {idea.title}
          </h3>
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <Badge
            variant="outline"
            className={`text-[10px] shrink-0 ${getStageBadgeClass(idea.stage)}`}
          >
            {idea.stage}
          </Badge>
          {guidance && (
            <span className="text-[10px] text-muted-foreground truncate">
              {guidance.action}
            </span>
          )}
        </div>
      </div>

      <MetaValidationBar
        isGenerating={isStreaming}
        metaValidationStatus={effectiveMetaValidationChipStatus}
        fixCount={effectiveMetaValidationFixCount}
        packageCharacteristics={packageCharacteristics}
      />

      {guidance && (
        <div className="mx-3 mt-3 p-3 rounded-md bg-primary/5 border border-primary/10">
          <div className="flex items-start gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-[11px] font-medium text-primary">
                {guidance.action}
              </p>
              <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                {guidance.hint}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3 space-y-3" data-testid="chat-messages">
        {(() => {
          const effectiveFeasibility = feasibilityData
            ? { type: feasibilityData.type as "rpa" | "agent" | "hybrid", rationale: feasibilityData.rationale, complexity: feasibilityData.complexity, effortEstimate: feasibilityData.effortEstimate }
            : (idea.automationType && idea.automationTypeRationale)
              ? { type: idea.automationType as "rpa" | "agent" | "hybrid", rationale: idea.automationTypeRationale, complexity: (idea as any).feasibilityComplexity || null, effortEstimate: (idea as any).feasibilityEffortEstimate || null }
              : null;

          const asIsApprovalIndex = effectiveFeasibility ? displayMessages.findIndex(
            (m) => m.role === "assistant" && (m.content.includes("As-Is process map approved") || m.content.includes("As-Is process map re-approved") || m.content.includes("feasibility assessment"))
          ) : -1;
          const fallbackIndex = effectiveFeasibility ? Math.max(0, displayMessages.findIndex((m) => m.role === "assistant") + 1) : -1;
          const feasibilityInsertIndex = asIsApprovalIndex >= 0 ? asIsApprovalIndex + 1 : fallbackIndex;

          const rendered: JSX.Element[] = [];

          displayMessages.forEach((msg, idx) => {
            if (effectiveFeasibility && idx === feasibilityInsertIndex) {
              rendered.push(
                <div key="feasibility-card" className="flex justify-start" data-testid="chat-feasibility-card">
                  <div className="max-w-[95%] w-full">
                    <FeasibilityCard
                      automationType={effectiveFeasibility.type}
                      rationale={effectiveFeasibility.rationale}
                      complexity={effectiveFeasibility.complexity}
                      effortEstimate={effectiveFeasibility.effortEstimate}
                    />
                  </div>
                </div>
              );
            }

          if (msg.docType && msg.docId != null) {
            const latestDocOfType = [...displayMessages]
              .filter((m) => m.docType === msg.docType)
              .pop();
            const isLatest = latestDocOfType?.id === msg.id;
            rendered.push(
              <div key={msg.id} className="flex justify-start" data-testid={`chat-message-${msg.id}`}>
                <div className="max-w-[95%] w-full">
                  <DocumentCard
                    docType={msg.docType}
                    docId={msg.docId}
                    content={msg.content}
                    ideaId={idea.id}
                    isApproved={!isLatest || approvedDocIds.has(msg.docId)}
                    onApproved={() => handleDocApproved(msg.docType!, msg.docId)}
                    artifactsValid={msg.docType === "SDD" && isLatest ? sddApprovalData?.document?.artifactsValid : undefined}
                  />
                </div>
              </div>
            );
            return;
          }

          if (msg.uipathData) {
            const linkedRunId = messageToRunId.get(msg.id);
            const completedRun = linkedRunId ? completedUiPathRuns.get(linkedRunId) : undefined;
            const cardStatus = completedRun?.status as "BUILDING" | "READY" | "READY_WITH_WARNINGS" | "FALLBACK_READY" | "FAILED" | undefined;
            const cardWarnings = completedRun?.warnings;
            const cardComplianceScore = completedRun?.complianceScore;
            const cardCompletenessLevel = completedRun?.completenessLevel;
            const cardOutcomeSummary = completedRun?.outcomeSummary;
            const cardDependencyMap = completedRun?.dependencyMap;
            const isLatestUiPathMsg = displayMessages.filter(m => m.uipathData).pop()?.id === msg.id;
            rendered.push(
              <div key={msg.id} className="flex justify-start" data-testid={`chat-message-${msg.id}`}>
                <div className="max-w-[95%] w-full">
                  <UiPathPackageCard
                    packageData={msg.uipathData}
                    ideaId={idea.id}
                    onDeployProgress={(step) => setDeployStep(step)}
                    onDeployComplete={() => setDeployStep("")}
                    onRetry={isLatestUiPathMsg ? () => startUiPathRun("retry", true) : undefined}
                    status={cardStatus}
                    warnings={cardWarnings}
                    templateComplianceScore={cardComplianceScore}
                    completenessLevel={cardCompletenessLevel}
                    outcomeSummary={cardOutcomeSummary}
                    pipelineDependencyMap={cardDependencyMap}
                  />
                </div>
              </div>
            );
            return;
          }

          if (msg.deployReport && (msg.deployReport.results?.length > 0 || msg.deployReport.packageId || msg.deployReport.processName)) {
            rendered.push(
              <div key={msg.id} className="flex justify-start" data-testid={`chat-message-${msg.id}`}>
                <div className="max-w-[95%] w-full space-y-2">
                  {msg.content && (
                    <div className="rounded-lg px-3 py-2.5 bg-card border border-card-border rounded-bl-sm">
                      <div className="text-xs leading-relaxed prose-chat overflow-hidden break-words">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {stripStepTags(msg.content)}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                  <DeploymentReportCard report={msg.deployReport} onDismiss={undefined} />
                  {!msg.isStreaming && (
                    <span className="text-[9px] text-muted-foreground/60 block">
                      {msg.timestamp.toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </span>
                  )}
                </div>
              </div>
            );
            return;
          }

          if (msg.isStreaming && msg.role === "assistant") {
            if (deployStep && deployPipelineLogEntries.length > 0) {
              rendered.push(<PipelineLogPanel key={`${msg.id}-deploy-pipeline-log`} entries={deployPipelineLogEntries} isComplete={deployPipelineComplete} onCancel={undefined} />);
              return;
            }
            if (deployStep) {
              rendered.push(<StreamingProgressIndicator key={`${msg.id}-deploy`} mode="deploy" deployStep={deployStep} />);
              return;
            }
            if (uipathShowProgressPanel) {
              rendered.push(<UiPathProgressPanel key={`${msg.id}-uipath-progress`} entries={pipelineLogEntries} isComplete={pipelineComplete} onCancel={() => cancelUiPathRun()} cancelState={uipathCancelState} startTime={uipathStartTime} isRunning={uipathIsRunning} onDismiss={uipathDismissProgressPanel} finalStatus={uipathFinalStatus} />);
              return;
            }
            if (isGeneratingDoc || isGeneratingDocRef.current) {
              const docType = (generatingDocType || generatingDocTypeRef.current || "PDD") as "PDD" | "SDD";
              if (streamingDocContent && streamingDocContent.length > 10) {
                rendered.push(
                  <div key={`${msg.id}-streaming-doc`} className="flex justify-start" data-testid="streaming-doc-card">
                    <div className="max-w-[95%] w-full">
                      <DocumentCard
                        docType={docType}
                        docId={0}
                        content={streamingDocContent}
                        ideaId={idea.id}
                        streaming={true}
                        streamingElapsed={streamingDocElapsed}
                        onCancelStreaming={cancelDocGeneration}
                      />
                    </div>
                  </div>
                );
                return;
              }
              rendered.push(<StreamingProgressIndicator key={`${msg.id}-doc-${docType}`} mode="doc" docType={docType} currentSection={docProgressSection} onCancel={cancelDocGeneration} />);
              return;
            }
            if (!msg.content) {
              rendered.push(<StreamingProgressIndicator key={`${msg.id}-thinking`} mode="thinking" liveStatus={liveStatus} stage={idea.stage} classifiedIntent={classifiedIntent} />);
              return;
            }
          }

          rendered.push(
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              data-testid={`chat-message-${msg.id}`}
            >
              <div
                className={`max-w-[85%] rounded-lg px-3 py-2.5 overflow-hidden ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-card border border-card-border rounded-bl-sm"
                }`}
              >
                {msg.role === "assistant" ? (
                  <div className="text-xs leading-relaxed prose-chat overflow-hidden break-words">
                    {(
                      <>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {stripStepTags(msg.content)}
                        </ReactMarkdown>
                        {msg.isStreaming && (
                          <span className="inline-block w-1.5 h-3.5 bg-primary ml-0.5 animate-pulse rounded-sm" />
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-xs leading-relaxed whitespace-pre-wrap">
                    {msg.content}
                    {msg.isStreaming && (
                      <span className="inline-block w-1.5 h-3.5 bg-primary ml-0.5 animate-pulse rounded-sm" />
                    )}
                  </p>
                )}
                {!msg.isStreaming && (
                  <span
                    className={`text-[9px] mt-1.5 block ${
                      msg.role === "user"
                        ? "text-primary-foreground/60"
                        : "text-muted-foreground/60"
                    }`}
                  >
                    {msg.timestamp.toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                )}
              </div>
            </div>
          );
        });

        if (effectiveFeasibility && feasibilityInsertIndex >= displayMessages.length) {
            rendered.push(
              <div key="feasibility-card" className="flex justify-start" data-testid="chat-feasibility-card">
                <div className="max-w-[95%] w-full">
                  <FeasibilityCard
                    automationType={effectiveFeasibility.type}
                    rationale={effectiveFeasibility.rationale}
                    complexity={effectiveFeasibility.complexity}
                    effortEstimate={effectiveFeasibility.effortEstimate}
                  />
                </div>
              </div>
            );
          }

          return rendered;
        })()}
        {uipathShowProgressPanel && !streamingMsg && (
          <UiPathProgressPanel entries={pipelineLogEntries} isComplete={pipelineComplete} onCancel={() => cancelUiPathRun()} cancelState={uipathCancelState} startTime={uipathStartTime} isRunning={uipathIsRunning} onDismiss={uipathDismissProgressPanel} finalStatus={uipathFinalStatus} />
        )}
        {isGeneratingDoc && !streamingMsg && !uipathShowProgressPanel && (
          streamingDocContent && streamingDocContent.length > 10 ? (
            <div className="flex justify-start" data-testid="streaming-doc-card-bottom">
              <div className="max-w-[95%] w-full">
                <DocumentCard
                  docType={(generatingDocType || "PDD") as "PDD" | "SDD"}
                  docId={0}
                  content={streamingDocContent}
                  ideaId={idea.id}
                  streaming={true}
                  streamingElapsed={streamingDocElapsed}
                  onCancelStreaming={cancelDocGeneration}
                />
              </div>
            </div>
          ) : (
            <StreamingProgressIndicator mode="doc" docType={generatingDocType} currentSection={docProgressSection} onCancel={cancelDocGeneration} />
          )
        )}
        {deployStep && !streamingMsg && (
          <StreamingProgressIndicator mode="deploy" deployStep={deployStep} />
        )}

        {currentUiPathRun?.status === "STALLED" && !uipathIsRunning && (
          <div className="flex justify-center py-2" data-testid="uipath-stalled-indicator">
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-center gap-2 text-xs text-amber-500">
                <Package className="h-3.5 w-3.5 animate-pulse" />
                <span>Still processing — waiting for server updates...</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => cancelUiPathRun()}
                data-testid="button-cancel-stalled"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {currentUiPathRun?.status === "FAILED" && !isGeneratingDoc && (
          <div className="flex justify-center py-2" data-testid="uipath-failed-section">
            <div className="flex flex-col items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-500/15 text-red-500 text-xs font-medium" data-testid="badge-status-failed">
                Build Failed
              </span>
              <Button
                className="bg-amber-500 hover:bg-amber-600 text-white text-xs"
                onClick={() => startUiPathRun("retry", true)}
                data-testid="button-retry-build"
              >
                <Package className="h-3.5 w-3.5 mr-1.5" />
                Retry UiPath Package
              </Button>
            </div>
          </div>
        )}

        {(() => {
          const hasUiPath = displayMessages.some((m) => m.uipathData);
          const hasSddApproval = !!(sddApprovalData?.approval);
          if (hasSddApproval && !hasUiPath && !isGeneratingDoc && (!currentUiPathRun || (currentUiPathRun.status !== "BUILDING" && currentUiPathRun.status !== "STALLED" && currentUiPathRun.status !== "FAILED"))) {
            return (
              <div className="flex justify-center py-2" data-testid="uipath-generate-section">
                <Button
                  className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs"
                  onClick={() => startUiPathRun("retry")}
                  data-testid="button-generate-uipath"
                >
                  <Package className="h-3.5 w-3.5 mr-1.5" />
                  Generate UiPath Package
                </Button>
              </div>
            );
          }
          return null;
        })()}

        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-border">
        {pendingApprovalDoc && !isStreaming && !isGeneratingDoc && (
          <div className="mb-2 flex items-center gap-2 px-3 py-2 rounded-md bg-cb-teal/10 border border-cb-teal/30" data-testid="banner-pending-approval">
            <Check className="h-3.5 w-3.5 text-cb-teal shrink-0" />
            <span className="text-xs text-foreground/80 flex-1">
              {pendingApprovalDoc.docType} is ready for review
            </span>
            <Button
              size="sm"
              className="h-6 text-[11px] bg-cb-teal hover:bg-cb-teal/80 text-white px-3"
              onClick={handleBannerApprove}
              disabled={bannerApproving}
              data-testid="button-banner-approve"
            >
              {bannerApproving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
              Approve {pendingApprovalDoc.docType}
            </Button>
          </div>
        )}
        {messageQueue.length > 0 && (
          <div className="mb-2 space-y-1" data-testid="message-queue">
            <div className="flex items-center gap-1.5 mb-1">
              <ListPlus className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] text-muted-foreground font-medium">
                {messageQueue.length} queued message{messageQueue.length > 1 ? "s" : ""}
              </span>
            </div>
            {messageQueue.map((qMsg) => (
              <div key={qMsg.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-secondary/30 border border-border/40" data-testid={`queued-message-${qMsg.id}`}>
                <span className="text-[10px] text-foreground/70 truncate flex-1">{qMsg.text}</span>
                <button
                  onClick={() => removeFromQueue(qMsg.id)}
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                  data-testid={`button-remove-queued-${qMsg.id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {attachedFile && (
          <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-md bg-secondary/50 border border-border text-xs" data-testid="chip-attached-file">
            {filePreviewUrl ? (
              <img src={filePreviewUrl} alt="Preview" className="h-10 w-10 rounded object-cover shrink-0 border border-border" />
            ) : (
              <FileIcon className="h-3 w-3 text-muted-foreground shrink-0" />
            )}
            <span className="truncate text-foreground/80">{attachedFile.name}</span>
            <button
              onClick={clearAttachedFile}
              className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              data-testid="button-remove-file"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className={`flex items-end gap-2 rounded-lg bg-card border p-2 transition-colors duration-500 ${
          !isStreaming && displayMessages.length > 0 && displayMessages[displayMessages.length - 1]?.role === "assistant" && displayMessages[displayMessages.length - 1]?.content.endsWith("?")
            ? "border-primary/40 ring-1 ring-primary/20"
            : "border-card-border"
        }`}>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
            accept=".pdf,.docx,.xlsx,.xls,.txt,.csv,.png,.jpg,.jpeg,.gif,.webp,.mp4,.webm,.mov"
            data-testid="input-file-upload"
          />
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => fileInputRef.current?.click()}
            disabled={isStreaming}
            data-testid="button-attach-file"
          >
            <Paperclip className="h-4 w-4" />
          </Button>
          <Textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={deployStep ? "Deploying... Type to queue your next message" : isGeneratingDoc ? `Generating ${generatingDocType}... Type to queue your next message` : isStreaming ? "Type to queue your next message..." : "Describe your process..."}
            className="min-h-[36px] max-h-[200px] resize-y border-0 bg-transparent focus-visible:ring-0 p-0 text-xs placeholder:text-muted-foreground/50"
            rows={1}
            data-testid="input-chat-message"
          />
          <Button
            size="icon"
            className="shrink-0"
            onClick={handleSend}
            disabled={isUploading || (!inputValue.trim() && !attachedFile)}
            data-testid="button-send-message"
          >
            {isUploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isStreaming ? (
              <ListPlus className="h-3.5 w-3.5" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}


function ExportDialog({ ideaId, ideaTitle }: { ideaId: string; ideaTitle: string }) {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({
    "as-is": true,
    "to-be": true,
    pdd: true,
    sdd: true,
  });
  const ref = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const toggle = (key: string) => setSelected((prev) => ({ ...prev, [key]: !prev[key] }));
  const selectedTypes = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
  const allSelected = selectedTypes.length === 4;
  const noneSelected = selectedTypes.length === 0;

  async function doExport() {
    if (noneSelected) return;
    setExporting(true);
    setOpen(false);
    try {
      const query = `?types=${selectedTypes.join(",")}`;
      const resp = await fetch(`/api/ideas/${ideaId}/export${query}`, { credentials: "include" });
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_export.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Word document downloaded" });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
    setExporting(false);
  }

  const items = [
    { key: "as-is", label: "As-Is Process Map" },
    { key: "to-be", label: "To-Be Process Map" },
    { key: "pdd", label: "Process Design Document (PDD)" },
    { key: "sdd", label: "Solution Design Document (SDD)" },
  ];

  return (
    <div className="relative shrink-0" ref={ref}>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setOpen(!open)}
        disabled={exporting}
        data-testid="button-export-documents"
      >
        {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      </Button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-xl py-2 w-[260px]" data-testid="export-dialog">
          <div className="px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
            <span>Export to Word</span>
            <button
              className="text-[10px] text-primary hover:underline font-normal normal-case tracking-normal"
              onClick={() => {
                const newVal = !allSelected;
                setSelected({ "as-is": newVal, "to-be": newVal, pdd: newVal, sdd: newVal });
              }}
              data-testid="button-toggle-all-export"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div className="px-1 py-1 space-y-0.5">
            {items.map((item) => (
              <label
                key={item.key}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-accent/50 cursor-pointer transition-colors"
                data-testid={`export-check-${item.key}`}
              >
                <input
                  type="checkbox"
                  checked={!!selected[item.key]}
                  onChange={() => toggle(item.key)}
                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                />
                <span className="text-xs text-foreground">{item.label}</span>
              </label>
            ))}
          </div>
          <div className="px-3 pt-2 pb-1 border-t border-border/50 mt-1">
            <Button
              size="sm"
              className="w-full h-7 text-xs"
              onClick={doExport}
              disabled={noneSelected || exporting}
              data-testid="button-download-export"
            >
              {exporting ? (
                <>
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Download className="mr-1.5 h-3 w-3" />
                  Download .docx
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

type MobileTab = "stages" | "map" | "chat" | "artifacts";

export default function Workspace() {
  const [, params] = useRoute("/workspace/:id");
  const ideaId = params?.id;
  const [selectedCompletedStage, setSelectedCompletedStage] = useState<
    string | null
  >(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [showArtifactHub, setShowArtifactHub] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const switchProcessMapViewRef = useRef<((view: "as-is" | "to-be" | "sdd") => void) | null>(null);
  const mapApprovalHandlerRef = useRef<((approvedView: string, isReapproval?: boolean) => void) | null>(null);
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");
  const { user, activeRole } = useAuth();
  const [, navigate] = useLocation();

  const { data: idea, isLoading } = useQuery<Idea>({
    queryKey: ["/api/ideas", ideaId],
    enabled: !!ideaId,
  });

  const canDeleteIdea = activeRole === "Admin" || activeRole === "CoE" || (user && idea && user.email === idea.ownerEmail);

  const deleteIdeaMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", `/api/ideas/${ideaId}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ideas"] });
      toast({ title: "Idea deleted", description: `"${idea?.title}" has been removed.` });
      navigate("/");
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setConfirmingDelete(false);
    },
  });

  useEffect(() => {
    if (idea && !isEditingTitle) {
      setEditTitle(idea.title);
    }
  }, [idea?.title]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            Loading workspace...
          </p>
        </div>
      </div>
    );
  }

  if (!idea) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">Idea not found.</p>
      </div>
    );
  }

  const currentIndex = PIPELINE_STAGES.indexOf(idea.stage as PipelineStage);

  async function handleTitleSave() {
    const trimmed = editTitle.trim();
    if (!trimmed || trimmed === idea!.title) {
      setEditTitle(idea!.title);
      setIsEditingTitle(false);
      return;
    }
    try {
      await apiRequest("PATCH", `/api/ideas/${idea!.id}`, { title: trimmed });
      queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea!.id] });
      queryClient.invalidateQueries({ queryKey: ["/api/ideas"] });
      toast({ title: "Idea renamed", description: `Title updated to "${trimmed}"` });
    } catch {
      setEditTitle(idea!.title);
      toast({ title: "Failed to rename", variant: "destructive" });
    }
    setIsEditingTitle(false);
  }

  function handleStageClick(stage: string) {
    setSelectedCompletedStage((prev) => (prev === stage ? null : stage));
  }

  const stagePanel = (
    <div className="relative h-full">
      <StageTracker idea={idea} onStageClick={handleStageClick} />
      {selectedCompletedStage && (
        <div className="absolute inset-0 bg-card z-20 flex flex-col" data-testid="drawer-stage-summary">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h4 className="text-xs font-semibold text-foreground">
              {selectedCompletedStage}
            </h4>
            <button
              onClick={() => setSelectedCompletedStage(null)}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              data-testid="button-close-drawer"
            >
              Close
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Check className="h-3 w-3 text-cb-teal" />
              <span className="text-xs text-muted-foreground">
                Completed
              </span>
            </div>
            <div className="p-3 rounded-md bg-muted/20 border border-border/40">
              <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                Stage summary and artifacts will appear here
                once the AI assistant is connected.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const mapPanel = (
    <ProcessMapPanel
      ideaId={idea.id}
      onApproved={(approvedView?: string, isReapproval?: boolean) => {
        queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "messages"] });
        if (approvedView) {
          mapApprovalHandlerRef.current?.(approvedView, isReapproval);
        }
      }}
      onCompletenessChange={(pct) => {
        if (pct >= 85) {
          queryClient.invalidateQueries({ queryKey: ["/api/ideas", idea.id, "process-map"] });
        }
      }}
      onViewChange={(view) => { currentProcessView = view; }}
      onSwitchViewReady={(fn) => { switchProcessMapViewRef.current = fn; }}
    />
  );

  const chatPanel = <ChatPanel idea={idea} switchProcessMapViewRef={switchProcessMapViewRef} onMapApprovalReady={(fn) => { mapApprovalHandlerRef.current = fn; }} />;

  const mobileTabs = [
    { id: "stages" as MobileTab, label: "Stages", icon: ListChecks },
    { id: "map" as MobileTab, label: "Map", icon: MapIcon },
    { id: "chat" as MobileTab, label: "Chat", icon: MessageSquare },
    { id: "artifacts" as MobileTab, label: "Artifacts", icon: Archive },
  ];

  return (
    <div className="flex flex-col h-full" data-testid="page-workspace">
      <div className="px-3 sm:px-4 py-2 sm:py-2.5 border-b border-border bg-card/30">
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 sm:h-9 sm:w-9"
              data-testid="button-back-pipeline"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              {isEditingTitle ? (
                <input
                  ref={titleInputRef}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleTitleSave();
                    if (e.key === "Escape") { setEditTitle(idea.title); setIsEditingTitle(false); }
                  }}
                  className="text-xs sm:text-sm font-semibold text-foreground bg-transparent border-b border-primary outline-none px-0 py-0.5 min-w-[100px] max-w-[200px] sm:max-w-[300px]"
                  data-testid="input-edit-title"
                />
              ) : (
                <button
                  onClick={() => { setEditTitle(idea.title); setIsEditingTitle(true); }}
                  className="flex items-center gap-1.5 group cursor-pointer min-w-0"
                  data-testid="button-edit-title"
                >
                  <h1
                    className="text-xs sm:text-sm font-semibold text-foreground truncate"
                    data-testid="text-idea-title"
                  >
                    {idea.title}
                  </h1>
                  <Pencil className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </button>
              )}
              <Badge
                variant="outline"
                className={`shrink-0 text-[10px] ${getStageBadgeClass(idea.stage)} hidden sm:inline-flex`}
                data-testid="badge-idea-stage"
              >
                {idea.stage}
              </Badge>
              {(idea.automationType !== "rpa" || idea.automationTypeRationale) && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className={`shrink-0 text-[10px] hidden sm:inline-flex gap-1 ${
                          idea.automationType === "agent"
                            ? "bg-purple-500/15 text-purple-400 border-purple-500/25"
                            : idea.automationType === "hybrid"
                              ? "bg-teal-500/15 text-teal-400 border-teal-500/25"
                              : "bg-blue-500/15 text-blue-400 border-blue-500/25"
                        }`}
                        data-testid="badge-automation-type"
                      >
                        {idea.automationType === "agent" && <Brain className="h-3 w-3" />}
                        {idea.automationType === "agent" ? "Agent" : idea.automationType === "hybrid" ? "Hybrid" : "RPA"}
                      </Badge>
                    </TooltipTrigger>
                    {idea.automationTypeRationale && (
                      <TooltipContent side="bottom" className="max-w-[300px]">
                        <p className="text-xs" data-testid="text-automation-rationale">{idea.automationTypeRationale}</p>
                      </TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
            <span>{idea.owner}</span>
            {idea.tag && (
              <>
                <span className="text-border">|</span>
                <span>{idea.tag}</span>
              </>
            )}
          </div>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={showArtifactHub ? "default" : "ghost"}
                  size="icon"
                  className={`h-8 w-8 ${showArtifactHub ? "bg-primary/20 text-primary" : ""}`}
                  onClick={() => setShowArtifactHub(!showArtifactHub)}
                  data-testid="button-toggle-artifact-hub"
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p className="text-xs">Artifact Hub</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <ExportDialog ideaId={idea.id} ideaTitle={idea.title} />
          {canDeleteIdea && (
            <div className="relative shrink-0">
              {confirmingDelete ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Delete idea?</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="text-[10px] px-2"
                    disabled={deleteIdeaMutation.isPending}
                    onClick={() => deleteIdeaMutation.mutate()}
                    data-testid="button-confirm-delete-idea"
                  >
                    {deleteIdeaMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[10px] px-2"
                    onClick={() => setConfirmingDelete(false)}
                    data-testid="button-cancel-delete-idea"
                  >
                    No
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setConfirmingDelete(true)}
                  data-testid="button-delete-idea"
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {isMobile ? (
        <>
          <div className="flex-1 min-h-0 overflow-hidden">
            {mobileTab === "stages" && stagePanel}
            {mobileTab === "map" && <div className="h-full">{mapPanel}</div>}
            {mobileTab === "chat" && chatPanel}
            {mobileTab === "artifacts" && <ArtifactHub ideaId={idea.id} ideaTitle={idea.title} />}
          </div>
          <div className="flex items-center border-t border-border bg-card shrink-0" data-testid="mobile-tab-bar">
            {mobileTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setMobileTab(tab.id)}
                className={`flex-1 flex flex-col items-center gap-0.5 py-2 px-1 transition-colors ${
                  mobileTab === tab.id
                    ? "text-primary"
                    : "text-muted-foreground"
                }`}
                data-testid={`tab-${tab.id}`}
              >
                <tab.icon className="h-4 w-4" />
                <span className="text-[10px] font-medium">{tab.label}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="flex-1 min-h-0">
          <ResizablePanelGroup
            direction="horizontal"
            className="h-full"
            data-testid="workspace-panels"
          >
            <ResizablePanel
              defaultSize={showArtifactHub ? 12 : 15}
              minSize={12}
              maxSize={25}
              className="bg-card/20"
            >
              {stagePanel}
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel defaultSize={showArtifactHub ? 38 : 50} minSize={25}>
              {mapPanel}
            </ResizablePanel>

            <ResizableHandle withHandle />

            <ResizablePanel
              defaultSize={showArtifactHub ? 30 : 35}
              minSize={20}
              maxSize={50}
            >
              {chatPanel}
            </ResizablePanel>

            {showArtifactHub && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel
                  defaultSize={20}
                  minSize={15}
                  maxSize={30}
                  className="bg-card/20"
                >
                  <ArtifactHub ideaId={idea.id} ideaTitle={idea.title} />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  );
}
