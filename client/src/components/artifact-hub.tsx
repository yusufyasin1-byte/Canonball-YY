import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Map,
  FileText,
  Package,
  BookOpen,
  Download,
  Eye,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
  Check,
  AlertCircle,
  Clock,
  Archive,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessMapViewerModal } from "./process-map-viewer-modal";

interface ArtifactSummary {
  type: "as-is" | "to-be" | "pdd" | "sdd" | "dsd" | "uipath" | "test-automation" | "dhg";
  label: string;
  exists: boolean;
  status: string;
  version: number | null;
  nodeCount?: number;
  artifactsValid?: boolean | null;
  artifactWarnings?: string[];
  blockedReason?: string;
  meta?: {
    projectName?: string;
    workflowCount?: number;
    dependencyCount?: number;
    solutionAvailable?: boolean;
  } | null;
}

const ARTIFACT_ICONS: Record<string, typeof Map> = {
  "as-is": Map,
  "to-be": Map,
  pdd: FileText,
  sdd: FileText,
  dsd: FileText,
  uipath: Package,
  "test-automation": Package,
  dhg: BookOpen,
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case "Approved":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/25";
    case "Draft":
      return "bg-amber-500/15 text-amber-400 border-amber-500/25";
    case "Generated":
    case "Available":
      return "bg-blue-500/15 text-blue-400 border-blue-500/25";
    default:
      return "bg-muted/50 text-muted-foreground border-border/50";
  }
}

function statusIcon(status: string) {
  switch (status) {
    case "Approved":
      return <Check className="h-3 w-3" />;
    case "Draft":
      return <Clock className="h-3 w-3" />;
    case "Generated":
    case "Available":
      return <Check className="h-3 w-3" />;
    default:
      return <AlertCircle className="h-3 w-3" />;
  }
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-12 gap-2">
      <XCircle className="h-5 w-5 text-destructive" />
      <span className="text-sm text-destructive">{message}</span>
    </div>
  );
}

function DocumentViewerModal({ open, onClose, title, ideaId, artifactType }: { open: boolean; onClose: () => void; title: string; ideaId: string; artifactType: string }) {
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set([0]));

  const { data: docData, isLoading, isError } = useQuery<{ content: string; version: number; status: string }>({
    queryKey: ["/api/ideas", ideaId, "artifacts-view", artifactType],
    queryFn: async () => {
      const type = artifactType.toUpperCase();
      const res = await fetch(`/api/ideas/${ideaId}/documents/versions/${type}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load document");
      const versions: { content: string; version: number; status: string }[] = await res.json();
      if (!versions || versions.length === 0) throw new Error("No document found");
      return { content: versions[0].content, version: versions[0].version, status: versions[0].status };
    },
    enabled: open && (artifactType === "pdd" || artifactType === "sdd" || artifactType === "dsd"),
  });

  if (!open) return null;

  const sections = docData ? parseDocumentSections(docData.content) : [];

  function toggleSection(index: number) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid={`modal-view-${artifactType}`} onClick={onClose}>
      <div className="relative w-[90vw] max-w-4xl max-h-[85vh] bg-card rounded-xl border border-border shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-cb-teal" />
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            {docData && (
              <Badge variant="outline" className="text-[10px]">v{docData.version}</Badge>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors" data-testid={`button-close-modal-${artifactType}`}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-cb-teal" />
              <span className="ml-2 text-sm text-muted-foreground">Loading document...</span>
            </div>
          ) : isError ? (
            <ErrorMessage message="Failed to load document." />
          ) : sections.length > 0 ? (
            <div className="divide-y divide-border/20">
              {sections.map((section, idx) => (
                <div key={idx}>
                  <button
                    className="w-full flex items-center gap-2 px-5 py-2.5 text-left hover:bg-muted/50 transition-colors"
                    onClick={() => toggleSection(idx)}
                    data-testid={`button-hub-section-toggle-${idx}`}
                  >
                    {expandedSections.has(idx) ? (
                      <ChevronDown className="h-3 w-3 text-cb-teal shrink-0" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-xs font-medium text-foreground">{section.title}</span>
                  </button>
                  {expandedSections.has(idx) && (
                    <div className="px-5 pb-3 pl-10">
                      <div className="text-[11px] text-muted-foreground/90 leading-relaxed prose-doc">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {section.content}
                        </ReactMarkdown>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No content available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function DhgViewerModal({ open, onClose, ideaId }: { open: boolean; onClose: () => void; ideaId: string }) {
  const { data: dhgData, isLoading, isError } = useQuery<{ content: string }>({
    queryKey: ["/api/ideas", ideaId, "dhg"],
    queryFn: async () => {
      const res = await fetch(`/api/ideas/${ideaId}/dhg`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load DHG");
      return res.json();
    },
    enabled: open,
  });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="modal-view-dhg" onClick={onClose}>
      <div className="relative w-[90vw] max-w-4xl max-h-[85vh] bg-card rounded-xl border border-border shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-cb-teal" />
            <h3 className="text-sm font-semibold text-foreground">Developer Handoff Guide</h3>
          </div>
          <div className="flex items-center gap-2">
            {dhgData?.content && (
              <button
                onClick={() => {
                  const blob = new Blob([dhgData.content], { type: "text/markdown" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = "DeveloperHandoffGuide.md";
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                data-testid="button-hub-download-dhg-md"
              >
                <Download className="h-3 w-3" />
                Download .md
              </button>
            )}
            <button onClick={onClose} className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors" data-testid="button-close-modal-dhg">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-cb-teal" />
              <span className="ml-2 text-sm text-muted-foreground">Generating Handoff Guide...</span>
            </div>
          ) : isError ? (
            <ErrorMessage message="Failed to load Developer Handoff Guide." />
          ) : dhgData?.content ? (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-headings:text-foreground prose-p:text-muted-foreground prose-strong:text-foreground prose-code:text-cb-teal prose-code:bg-muted/50 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-li:text-muted-foreground prose-table:text-xs" data-testid="hub-dhg-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{dhgData.content}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No content available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

interface UiPathWorkflowStep {
  activity: string;
  notes?: string;
}

interface UiPathWorkflow {
  name: string;
  description: string;
  steps?: UiPathWorkflowStep[];
}

interface UiPathPackageData {
  projectName: string;
  description: string;
  dependencies?: string[];
  workflows?: UiPathWorkflow[];
  preferredFormat?: "package" | "solution";
  solution?: {
    fileName?: string;
    solutionName: string;
    displayName: string;
    version: string;
    automationType: string;
    recommendation?: {
      recommendedOutput: "package" | "solution";
      recommendedModality: "unattended_robot" | "attended_assistant" | "app_fronted_process" | "agent_orchestrated" | "api_workflow";
      recommendedExecutionModel: "unattended" | "attended" | "hybrid";
      recommendedProducts: string[];
      connectorRecommendations: Array<{
        connectorName: string;
        sourceSystems: string[];
        rationale: string;
        usedActions?: string[];
      }>;
      rationale: string[];
      signals: {
        automationType: string;
        workflowCount: number;
        queueCount: number;
        assetCount: number;
        storageBucketCount: number;
        actionCatalogCount: number;
        integrationCount: number;
        sharedResourceCount: number;
        uiInteractionSignalCount: number;
        assistantSignalCount: number;
        appSignalCount: number;
        apiSignalCount: number;
        humanInLoopSignalCount: number;
        triggerCount: number;
        appCount: number;
        dataFabricEntityCount: number;
      };
    } | null;
    operatingModel?: {
      runtimeProfile: string;
      recommendedFolderStrategy: string;
      recommendedRobotType: string;
      triggerStrategy: string;
      supportModel: string;
      deploymentReadinessNotes: string[];
      integrationServiceConnectors: string[];
      apps: string[];
      dataFabricEntities: string[];
      triggerNames: string[];
      governanceArtifacts: string[];
    } | null;
    releaseReadiness?: {
      score: number;
      status: "ready" | "mostly_ready" | "needs_work";
      strengths: string[];
      outstandingItems: string[];
      releaseGates: string[];
    } | null;
    testRelease?: {
      projectName: string;
      smokeTestSetName?: string;
      automatedCoveragePercent: number;
      nextActions: string[];
    } | null;
    reporting?: {
      businessKpis: string[];
      operationalKpis: string[];
      dashboards: string[];
      alerts: string[];
    } | null;
    executiveSummary?: {
      overview: string;
      lifecycleCoverage: string[];
      keyOutputs: string[];
      deploymentStory: string[];
    } | null;
    testCases?: Array<{
      name: string;
      description: string;
      steps: Array<{ action: string; expected: string }>;
    }>;
    testSets?: Array<{
      name: string;
      description: string;
      testCaseNames: string[];
    }>;
    componentCount: number;
    components: Array<{ type: string; name: string; path: string; description?: string }>;
    resources: {
      queues: string[];
      assets: string[];
      storageBuckets: string[];
      actionCatalogs: string[];
      processes: string[];
      integrations: string[];
    };
    deploymentSupport: {
      packageDeploySupported: boolean;
      solutionDeploySupported: string;
      notes: string[];
    };
  } | null;
}

const MAX_DESC_LENGTH = 300;
function capDescription(text: string): string {
  if (text.length <= MAX_DESC_LENGTH) return text;
  const cut = text.lastIndexOf(" ", MAX_DESC_LENGTH);
  return text.slice(0, cut > 0 ? cut : MAX_DESC_LENGTH) + "…";
}

function UiPathViewerModal({ open, onClose, ideaId }: { open: boolean; onClose: () => void; ideaId: string }) {
  const [expandedWf, setExpandedWf] = useState(true);
  const [expandedTests, setExpandedTests] = useState(false);
  const [expandedWfItems, setExpandedWfItems] = useState<Set<number>>(new Set());
  const [descExpanded, setDescExpanded] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);
  const checkDescClamped = useCallback(() => {
    const el = descRef.current;
    if (el) setDescClamped(el.scrollHeight > el.clientHeight);
  }, []);

  useEffect(() => {
    if (open) {
      setExpandedWfItems(new Set());
      setExpandedTests(false);
      setDescExpanded(false);
      setDescClamped(false);
    }
  }, [open, ideaId]);

  const toggleWfItem = (index: number) => {
    setExpandedWfItems((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const { data: packageData, isLoading, isError } = useQuery<UiPathPackageData>({
    queryKey: ["/api/ideas", ideaId, "artifacts-view", "uipath-meta"],
    queryFn: async () => {
      const res = await fetch(`/api/ideas/${ideaId}/uipath-artifact-meta`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load UiPath artifact metadata");
      return res.json();
    },
    enabled: open,
  });

  useEffect(() => {
    if (packageData?.description) {
      requestAnimationFrame(checkDescClamped);
    }
  }, [packageData?.description, checkDescClamped]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" data-testid="modal-view-uipath" onClick={onClose}>
      <div className="relative w-[90vw] max-w-3xl max-h-[85vh] bg-card rounded-xl border border-border shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
          <div className="flex items-center gap-2">
            <Package className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">UiPath Solution Output</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors" data-testid="button-close-modal-uipath">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span className="ml-2 text-sm text-muted-foreground">Loading package data...</span>
            </div>
          ) : isError ? (
            <ErrorMessage message="Failed to load UiPath package data." />
          ) : packageData ? (
            <div className="space-y-4">
              <div>
                <h4 className="text-xs font-semibold text-foreground">{packageData.projectName}</h4>
                {packageData.description && (
                  <div className="mt-1">
                    <p ref={descRef} className={`text-[11px] text-muted-foreground/90 ${!descExpanded ? "line-clamp-2" : ""}`} data-testid="text-modal-package-description">
                      {descExpanded ? capDescription(packageData.description) : packageData.description}
                    </p>
                    {(descClamped || descExpanded) && (
                      <button
                        className="text-[10px] text-primary hover:underline mt-0.5"
                        onClick={() => setDescExpanded(!descExpanded)}
                        data-testid="button-modal-toggle-description"
                      >
                        {descExpanded ? "show less" : "show more"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {packageData.solution && (
                <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-2" data-testid="uipath-solution-summary">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h5 className="text-[11px] font-semibold text-foreground">{packageData.solution.displayName}</h5>
                      <p className="text-[10px] text-muted-foreground">
                        {packageData.solution.componentCount} components · {packageData.solution.automationType} · v{packageData.solution.version}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-[9px]">Native .uis</Badge>
                  </div>
                  <div className="text-[10px] text-muted-foreground space-y-1">
                    {packageData.solution.recommendation && (
                      <>
                        <p>
                          Recommended output: <span className="font-medium text-foreground">{packageData.solution.recommendation.recommendedOutput}</span>
                        </p>
                        <p>
                          Recommended modality: <span className="font-medium text-foreground">{packageData.solution.recommendation.recommendedModality}</span>
                          {" "}Â· Execution: <span className="font-medium text-foreground">{packageData.solution.recommendation.recommendedExecutionModel}</span>
                        </p>
                        {packageData.solution.recommendation.recommendedProducts.length > 0 && (
                          <p>
                            UiPath products: <span className="font-medium text-foreground">{packageData.solution.recommendation.recommendedProducts.join(", ")}</span>
                          </p>
                        )}
                        {packageData.solution.recommendation.connectorRecommendations.length > 0 && (
                          <p>
                            Recommended connectors: <span className="font-medium text-foreground">{packageData.solution.recommendation.connectorRecommendations.map((connector) => connector.connectorName).join(", ")}</span>
                          </p>
                        )}
                        {packageData.solution.recommendation.rationale.map((reason, index) => (
                          <p key={index}>• {reason}</p>
                        ))}
                      </>
                    )}
                    {packageData.solution.operatingModel && (
                      <>
                        <p>
                          Runtime profile: <span className="font-medium text-foreground">{packageData.solution.operatingModel.runtimeProfile}</span>
                        </p>
                        <p>
                          Trigger strategy: <span className="font-medium text-foreground">{packageData.solution.operatingModel.triggerStrategy}</span>
                        </p>
                      </>
                    )}
                    <p>Use Studio Web or UiPath CLI to deploy the solution. The underlying package is included inside the bundle.</p>
                    {packageData.solution.resources.queues.length > 0 && (
                      <p>Queues: {packageData.solution.resources.queues.join(", ")}</p>
                    )}
                    {packageData.solution.resources.assets.length > 0 && (
                      <p>Assets: {packageData.solution.resources.assets.join(", ")}</p>
                    )}
                    {(packageData.solution.operatingModel?.deploymentReadinessNotes?.length ?? 0) > 0 && (
                      <p>Deployment readiness: {packageData.solution.operatingModel?.deploymentReadinessNotes?.[0]}</p>
                    )}
                    {packageData.solution.releaseReadiness && (
                      <p>
                        Release readiness: <span className="font-medium text-foreground">{packageData.solution.releaseReadiness.score}/100 ({packageData.solution.releaseReadiness.status})</span>
                      </p>
                    )}
                    {packageData.solution.executiveSummary?.overview && (
                      <p>
                        Executive summary: <span className="font-medium text-foreground">{packageData.solution.executiveSummary.overview}</span>
                      </p>
                    )}
                    {packageData.solution.testRelease?.smokeTestSetName && (
                      <p>
                        Smoke release test: <span className="font-medium text-foreground">{packageData.solution.testRelease.smokeTestSetName}</span>
                      </p>
                    )}
                    {(packageData.solution.reporting?.businessKpis?.length ?? 0) > 0 && (
                      <p>
                        Primary KPI: <span className="font-medium text-foreground">{packageData.solution.reporting?.businessKpis?.[0]}</span>
                      </p>
                    )}
                  </div>
                </div>
              )}

              {packageData.solution && ((packageData.solution.testCases?.length || 0) > 0 || (packageData.solution.testSets?.length || 0) > 0) && (
                <div>
                  <button
                    className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5"
                    onClick={() => setExpandedTests(!expandedTests)}
                    data-testid="button-hub-toggle-test-cases"
                  >
                    {expandedTests ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Test Cases ({packageData.solution.testCases?.length || 0})
                  </button>
                  {expandedTests && (
                    <div className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-3">
                      {(packageData.solution.testCases || []).map((testCase, index) => (
                        <div key={index} className="space-y-1">
                          <p className="text-[11px] font-medium text-foreground">{testCase.name}</p>
                          <p className="text-[10px] text-muted-foreground">{testCase.description}</p>
                        </div>
                      ))}
                      {(packageData.solution.testSets || []).length > 0 && (
                        <div className="pt-1 border-t border-border/40">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Test Sets</p>
                          {(packageData.solution.testSets || []).map((testSet, index) => (
                            <p key={index} className="text-[10px] text-muted-foreground mt-1">
                              {testSet.name}: {testSet.testCaseNames.join(", ")}
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {packageData.dependencies && packageData.dependencies.length > 0 && (
                <div>
                  <h5 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Dependencies</h5>
                  <div className="flex flex-wrap gap-1">
                    {packageData.dependencies.map((dep, i) => (
                      <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                        {dep}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {packageData.workflows && packageData.workflows.length > 0 && (
                <div>
                  <button
                    className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5"
                    onClick={() => setExpandedWf(!expandedWf)}
                    data-testid="button-hub-toggle-workflows"
                  >
                    {expandedWf ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Workflows ({packageData.workflows.length})
                  </button>
                  {expandedWf && (
                    <div className="space-y-1">
                      {packageData.workflows.map((wf, i) => {
                        const isOpen = expandedWfItems.has(i);
                        const hasDetails = wf.description || (wf.steps && wf.steps.length > 0);
                        return (
                          <div key={i} className="rounded bg-muted border border-border/20" data-testid={`hub-workflow-item-${i}`}>
                            <button
                              className="flex items-center gap-1.5 w-full px-2.5 py-1.5 text-left"
                              onClick={() => hasDetails && toggleWfItem(i)}
                              data-testid={`button-hub-toggle-workflow-${i}`}
                            >
                              {hasDetails ? (
                                isOpen ? <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              ) : (
                                <span className="w-3 shrink-0" />
                              )}
                              <span className="text-[11px] font-medium text-foreground">{wf.name}</span>
                            </button>
                            {isOpen && hasDetails && (
                              <div className="px-2.5 pb-2 pl-[30px]">
                                {wf.description && (
                                  <p className="text-[10px] text-muted-foreground">{wf.description}</p>
                                )}
                                {wf.steps && wf.steps.length > 0 && (
                                  <div className="mt-1.5 space-y-0.5">
                                    {wf.steps.map((step, j) => (
                                      <p key={j} className="text-[10px] text-muted-foreground/70 pl-2 border-l border-border/30">
                                        {step.activity}{step.notes ? ` — ${step.notes}` : ""}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-8">No package data available.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function parseDocumentSections(content: string): { title: string; content: string }[] {
  const cleaned = content
    .replace(/\[AUTOMATION_TYPE:\s*[^\]]+\]/gi, "")
    .replace(/\[STEP:\s*[\d.]+\s+[^\]]*\]/g, "")
    .replace(/\[DOC:(PDD|SDD):\d+\]/g, "")
    .replace(/\[DEPLOY_UIPATH\]/g, "")
    .replace(/\[STAGE_BACK:\s*[^\]]+\]/g, "")
    .replace(/^###\s+(\d+\.?\s*(?:Orchestrator|Deployment))/gim, '## $1');
  const lines = cleaned.split("\n");
  const sections: { title: string; content: string }[] = [];
  let currentTitle = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+\d*\.?\s*(.*)/);
    if (headingMatch) {
      if (currentTitle) {
        sections.push({ title: currentTitle, content: currentContent.join("\n").trim() });
      }
      currentTitle = headingMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentTitle) {
    sections.push({ title: currentTitle, content: currentContent.join("\n").trim() });
  }

  if (sections.length === 0 && cleaned.trim()) {
    sections.push({ title: "Document Content", content: cleaned.trim() });
  }

  return sections;
}

interface ArtifactHubProps {
  ideaId: string;
  ideaTitle: string;
}

export function ArtifactHub({ ideaId, ideaTitle }: ArtifactHubProps) {
  const { toast } = useToast();
  const [viewingArtifact, setViewingArtifact] = useState<string | null>(null);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const { data, isLoading } = useQuery<{ artifacts: ArtifactSummary[] }>({
    queryKey: ["/api/ideas", ideaId, "artifacts"],
    staleTime: 10000,
  });

  const artifacts = data?.artifacts || [];

  async function downloadArtifact(type: string) {
    try {
      if (type === "uipath") {
        const metaRes = await fetch(`/api/ideas/${ideaId}/uipath-artifact-meta`, { credentials: "include" });
        const meta = metaRes.ok ? await metaRes.json() : null;
        const preferredFormat = meta?.preferredFormat === "package" ? "package" : "solution";
        const res = await fetch(`/api/ideas/${ideaId}/download-uipath`, { credentials: "include" });
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          throw new Error(errBody?.message || "Failed to download UiPath artifact");
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = preferredFormat === "package"
          ? `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}.nupkg`
          : `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_solution.uis`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }

      if (type === "dhg") {
        const res = await fetch(`/api/ideas/${ideaId}/dhg`, { credentials: "include" });
        if (!res.ok) throw new Error("Failed to download DHG");
        const dhgJson = await res.json();
        const blob = new Blob([dhgJson.content], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "DeveloperHandoffGuide.md";
        a.click();
        URL.revokeObjectURL(url);
        return;
      }

      if (type === "test-automation") {
        const res = await fetch(`/api/ideas/${ideaId}/download-uipath-tests`, { credentials: "include" });
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          throw new Error(errBody?.message || "Failed to download UiPath test automation");
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_tests.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }

      const resp = await fetch(`/api/ideas/${ideaId}/export?types=${type}`, { credentials: "include" });
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_${type}.docx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast({ title: "Download started" });
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    }
  }

  async function downloadAll() {
    setDownloadingAll(true);
    try {
      const hasUipath = artifacts.find(a => a.type === "uipath")?.exists;
      const hasTestAutomation = artifacts.find(a => a.type === "test-automation")?.exists;
      const hasDhg = artifacts.find(a => a.type === "dhg")?.exists;

      const resp = await fetch(`/api/ideas/${ideaId}/export?types=as-is,to-be,pdd,sdd,dsd`, { credentials: "include" });
      if (resp.ok) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_full_export.docx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      if (hasUipath) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const metaRes = await fetch(`/api/ideas/${ideaId}/uipath-artifact-meta`, { credentials: "include" });
          const meta = metaRes.ok ? await metaRes.json() : null;
          const preferredFormat = meta?.preferredFormat === "package" ? "package" : "solution";
          const res = await fetch(`/api/ideas/${ideaId}/download-uipath`, { credentials: "include" });
          if (!res.ok) throw new Error("UiPath solution download failed");
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = preferredFormat === "package"
            ? `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}.nupkg`
            : `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_solution.uis`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch {
          toast({ title: "UiPath solution download failed", variant: "destructive" });
        }
      }

      if (hasDhg) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const dhgRes = await fetch(`/api/ideas/${ideaId}/dhg`, { credentials: "include" });
          if (dhgRes.ok) {
            const dhgJson: { content: string } = await dhgRes.json();
            const blob = new Blob([dhgJson.content], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "DeveloperHandoffGuide.md";
            a.click();
            URL.revokeObjectURL(url);
          }
        } catch { /* best effort for DHG */ }
      }

      if (hasTestAutomation) {
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const res = await fetch(`/api/ideas/${ideaId}/download-uipath-tests`, { credentials: "include" });
          if (res.ok) {
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_tests.zip`;
            a.click();
            URL.revokeObjectURL(url);
          }
        } catch { /* best effort for tests */ }
      }

      toast({ title: "Downloads started" });
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    }
    setDownloadingAll(false);
  }

  const anyExists = artifacts.some(a => a.exists);

  return (
    <div className="flex flex-col h-full" data-testid="panel-artifact-hub">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-primary" />
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Artifacts
          </h3>
        </div>
        {anyExists && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-[10px] gap-1"
            onClick={downloadAll}
            disabled={downloadingAll}
            data-testid="button-download-all-artifacts"
          >
            {downloadingAll ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            Download All
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-3 space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          artifacts.map((artifact) => {
            const Icon = ARTIFACT_ICONS[artifact.type] || FileText;
            const isDisabled = !artifact.exists;

            return (
              <div
                key={artifact.type}
                className={`rounded-lg border p-3 transition-colors ${
                  isDisabled
                    ? "border-border/30 bg-muted/10 opacity-50"
                    : "border-border/50 bg-card hover:border-border"
                }`}
                data-testid={`artifact-card-${artifact.type}`}
              >
                <div className="flex items-start gap-3">
                  <div className={`p-2 rounded-md shrink-0 ${isDisabled ? "bg-muted/20" : "bg-primary/10"}`}>
                    <Icon className={`h-4 w-4 ${isDisabled ? "text-muted-foreground/40" : "text-primary"}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`text-xs font-medium ${isDisabled ? "text-muted-foreground/60" : "text-foreground"}`}>
                        {artifact.label}
                      </span>
                      <Badge
                        variant="outline"
                        className={`text-[9px] px-1.5 py-0 h-4 ${statusBadgeClass(artifact.status)}`}
                        data-testid={`badge-status-${artifact.type}`}
                      >
                        {statusIcon(artifact.status)}
                        <span className="ml-0.5">{artifact.status}</span>
                      </Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground/70">
                      {artifact.version !== null && <span>Version {artifact.version}</span>}
                      {artifact.nodeCount !== undefined && artifact.nodeCount > 0 && (
                        <span>{artifact.version ? " · " : ""}{artifact.nodeCount} steps</span>
                      )}
                      {artifact.meta?.projectName && (
                        <span>{artifact.meta.projectName} · {artifact.meta.workflowCount} workflows{artifact.meta.solutionAvailable ? " · solution ready" : ""}</span>
                      )}
                      {!artifact.exists && <span>Not yet generated</span>}
                    </div>
                    {artifact.type === "sdd" && artifact.artifactWarnings && artifact.artifactWarnings.length > 0 && (
                      <div className="mt-1.5 flex items-start gap-1.5 text-[10px] text-amber-400/80" data-testid="sdd-artifact-warnings">
                        <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
                        <div>
                          <span className="font-medium">Minor warnings:</span>
                          {artifact.artifactWarnings.map((w, i) => (
                            <div key={i} className="text-amber-400/60 ml-1">{w}</div>
                          ))}
                        </div>
                      </div>
                    )}
                    {artifact.type === "sdd" && artifact.blockedReason && (
                      <div className="mt-1.5 flex items-start gap-1.5 text-[10px] text-red-400/80" data-testid="sdd-artifact-blocked">
                        <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                        <span>{artifact.blockedReason}</span>
                      </div>
                    )}
                  </div>
                  {!isDisabled && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setViewingArtifact(artifact.type)}
                        data-testid={`button-view-${artifact.type}`}
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => downloadArtifact(artifact.type)}
                        data-testid={`button-download-${artifact.type}`}
                      >
                        <Download className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {(viewingArtifact === "as-is" || viewingArtifact === "to-be") && (
        <ProcessMapViewerModal
          open={true}
          onClose={() => setViewingArtifact(null)}
          ideaId={ideaId}
          viewType={viewingArtifact}
        />
      )}

      {(viewingArtifact === "pdd" || viewingArtifact === "sdd") && (
        <DocumentViewerModal
          open={true}
          onClose={() => setViewingArtifact(null)}
          title={viewingArtifact === "pdd" ? "Process Design Document" : "Solution Design Document"}
          ideaId={ideaId}
          artifactType={viewingArtifact}
        />
      )}

      {viewingArtifact === "dhg" && (
        <DhgViewerModal
          open={true}
          onClose={() => setViewingArtifact(null)}
          ideaId={ideaId}
        />
      )}

      {viewingArtifact === "uipath" && (
        <UiPathViewerModal
          open={true}
          onClose={() => setViewingArtifact(null)}
          ideaId={ideaId}
        />
      )}
    </div>
  );
}
