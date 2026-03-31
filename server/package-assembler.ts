import archiver from "archiver";
  import AdmZip from "adm-zip";
  import { createHash } from "crypto";
  import { PassThrough } from "stream";
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
    normalizeXaml as makeUiPathCompliant,
    ensureBracketWrapped,
    normalizeAssignArgumentNesting,
    validateXamlContent,
    generateStubWorkflow,
    selectGenerationMode,
    applyActivityPolicy,
    isReFrameworkFile,
    preserveStructureAndStubLeaves,
    type GenerationMode,
    type GenerationModeConfig,
    type XamlGeneratorResult,
    type XamlGap,
    type TargetFramework,
    type XamlValidationViolation,
    type DhgQualityIssue,
  } from "./xaml-generator";
  import type { XamlGenerationContext, UiPathPackage } from "./types/uipath-package";
  import { enrichWithAITree, type EnrichmentResult, type TreeEnrichmentResult } from "./ai-xaml-enricher";
  import { assembleWorkflowFromSpec } from "./workflow-tree-assembler";
  import type { WorkflowSpec as TreeWorkflowSpec, WorkflowNode as TreeWorkflowNode } from "./workflow-spec-types";
  import { analyzeAndFix, setGovernancePolicies, type AnalysisReport } from "./workflow-analyzer";
  import { runQualityGate, validatePackage, formatQualityGateViolations, classifyQualityIssues, getBlockingFiles, hasOnlyWarnings, hasBlockingIssues, type QualityGateResult, type ClassifiedIssue, type PackageReadiness } from "./uipath-quality-gate";
  import { escapeXml } from "./lib/xml-utils";
  import { computePackageFingerprint, computeEnrichmentFingerprint, computeXamlFingerprint, computeQualityGateFingerprint } from "./lib/utils";
  import { computeDhgAccuracy } from "./pipeline-health";
  import { scanXamlForRequiredPackages, classifyAutomationPattern, shouldUseReFramework, type AutomationPattern, ACTIVITY_NAME_ALIAS_MAP, normalizeActivityName, NAMESPACE_PREFIX_TO_PACKAGE, getActivityPackage } from "./uipath-activity-registry";
  import { filterBlockedActivitiesFromXaml } from "./uipath-activity-policy";
  import { catalogService, type ProcessType } from "./catalog/catalog-service";
  import type { StudioProfile } from "./catalog/metadata-service";
  import { validateWorkflowSpec as validateSpec, type SpecValidationReport } from "./catalog/spec-validator";
  import { UIPATH_PACKAGE_ALIAS_MAP, QualityGateError, isFrameworkAssembly, type UiPathConfig } from "./uipath-shared";
  import { metadataService as _metadataService } from "./catalog/metadata-service";
  import { PACKAGE_NAMESPACE_MAP, validateXmlWellFormedness } from "./xaml/xaml-compliance";
  import type { ComplexityTier } from "./complexity-classifier";
  import { generateDhgFromOutcomeReport, type DhgContext } from "./dhg-generator";
  import { runDhgAnalysis } from "./xaml/dhg-analyzers";

async function getProbeCache() {
  const { getProbeCache: _getProbeCache } = await import("./uipath-integration");
  return _getProbeCache();
}

function getBaselineFallbackVersion(pkgName: string, _framework: "Windows" | "Portable"): string | null {
  const validated = _metadataService.getValidatedVersion(pkgName);
  if (validated) return validated;
  if (!_metadataService.getStudioTarget()) {
    _metadataService.load();
    return _metadataService.getValidatedVersion(pkgName);
  }
  return null;
}
  
function resolveExpressionLanguage(
  profile: StudioProfile | null | undefined,
  metaTarget: { expressionLanguage: string } | null | undefined,
): string {
  const lang = profile?.expressionLanguage || metaTarget?.expressionLanguage;
  if (!lang) {
    throw new Error("Cannot assemble package: expression language is unavailable from MetadataService");
  }
  return lang;
}

function clrToXamlType(clrType: string): string {
  const map: Record<string, string> = {
    "System.Object": "x:Object",
    "System.String": "x:String",
    "System.Boolean": "x:Boolean",
    "System.Int32": "x:Int32",
    "System.Int64": "x:Int64",
    "System.Double": "x:Double",
    "System.DateTime": "s:DateTime",
    "System.TimeSpan": "s:TimeSpan",
    "System.Exception": "s:Exception",
  };
  return map[clrType] || "x:String";
}

export function isValidNuGetVersion(version: string): boolean {
  return /^\[?\d+\.\d+(\.\d+){0,2}(,\s*\))?\]?$/.test(version);
}

function getPreferredVersionFromMeta(pkgName: string): string | null {
  if (!_metadataService.getStudioTarget()) {
    _metadataService.load();
  }
  return _metadataService.getPreferredVersion(pkgName);
}

const KNOWN_TRANSITIVE_COLLISION_PAIRS: Array<{
  packages: [string, string];
  conflictingTransitive: string;
  resolution: string;
}> = [
  {
    packages: ["UiPath.Mail.Activities", "UiPath.System.Activities"],
    conflictingTransitive: "Microsoft.Office.Interop.Outlook",
    resolution: "align-system-version",
  },
];

function extractExactVersion(versionStr: string): string {
  let v = versionStr.trim();
  v = v.replace(/^\[/, "").replace(/[,)\]]/g, "").trim();
  const match = v.match(/^(\d+\.\d+(\.\d+){0,2})/);
  return match ? match[1] : v;
}

function validateAndEnforceDependencyCompatibility(
  deps: Record<string, string>,
  warnings: DependencyResolutionResult["warnings"],
): void {
  for (const [pkgName, version] of Object.entries(deps)) {
    const preferredVersion = getPreferredVersionFromMeta(pkgName);
    if (!preferredVersion) continue;

    const cleanVersion = extractExactVersion(version);

    if (cleanVersion !== preferredVersion) {
      const oldVersion = deps[pkgName];
      deps[pkgName] = `[${preferredVersion}]`;
      warnings.push({
        code: "DEPENDENCY_VERSION_PINNED_TO_VERIFIED",
        message: `Package ${pkgName} version ${oldVersion} differs from preferred version — pinned to [${preferredVersion}]`,
        stage: "dependency-compatibility",
        recoverable: true,
      });
      console.log(`[Dependency Compatibility] Pinned ${pkgName} from ${oldVersion} to [${preferredVersion}]`);
    }
  }

  const depKeys = Object.keys(deps);
  for (const collision of KNOWN_TRANSITIVE_COLLISION_PAIRS) {
    const [pkg1, pkg2] = collision.packages;
    if (depKeys.includes(pkg1) && depKeys.includes(pkg2)) {
      if (collision.resolution === "align-system-version") {
        const systemPkg = collision.packages.find(p => p === "UiPath.System.Activities") || pkg2;
        const otherPkg = systemPkg === pkg1 ? pkg2 : pkg1;

        const systemPreferred = getPreferredVersionFromMeta(systemPkg);
        const otherPreferred = getPreferredVersionFromMeta(otherPkg);

        if (systemPreferred && deps[systemPkg]) {
          const currentSysVer = extractExactVersion(deps[systemPkg]);
          if (currentSysVer !== systemPreferred) {
            deps[systemPkg] = `[${systemPreferred}]`;
            console.log(`[Dependency Compatibility] Aligned ${systemPkg} to [${systemPreferred}] to prevent transitive collision with ${otherPkg} via ${collision.conflictingTransitive}`);
          }
        }
        if (otherPreferred && deps[otherPkg]) {
          const currentOtherVer = extractExactVersion(deps[otherPkg]);
          if (currentOtherVer !== otherPreferred) {
            deps[otherPkg] = `[${otherPreferred}]`;
            console.log(`[Dependency Compatibility] Aligned ${otherPkg} to [${otherPreferred}] to prevent transitive collision with ${systemPkg} via ${collision.conflictingTransitive}`);
          }
        }

        warnings.push({
          code: "TRANSITIVE_COLLISION_RESOLVED",
          message: `${pkg1} and ${pkg2} aligned to verified versions to prevent transitive collision via ${collision.conflictingTransitive}`,
          stage: "dependency-compatibility",
          recoverable: true,
        });
      }
    }
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

const VALID_STUDIO_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function validateStudioVersion(version: string): boolean {
  if (!VALID_STUDIO_VERSION_PATTERN.test(version)) return false;
  const parts = version.split(".").map(Number);
  if (parts[0] < 20 || parts[0] > 30) return false;
  return true;
}

function isVersionFromValidatedSource(
  _studioProfile: StudioProfile | null,
  metaTarget: { version: string } | null,
): string | null {
  if (metaTarget?.version && validateStudioVersion(metaTarget.version)) {
    return metaTarget.version;
  }
  if (_studioProfile?.studioVersion && validateStudioVersion(_studioProfile.studioVersion)) {
    return _studioProfile.studioVersion;
  }
  return null;
}

function normalizeXamlPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^[./]+/, "");
}

interface StudioLoadabilityResult {
  loadable: boolean;
  reason?: string;
  repairable?: boolean;
}

function checkStudioLoadability(xamlContent: string): StudioLoadabilityResult {
  if (!xamlContent || xamlContent.trim().length === 0) {
    return { loadable: false, reason: "Empty XAML content" };
  }

  const hasActivityRoot = /<Activity\b[^.]/i.test(xamlContent);
  if (!hasActivityRoot) {
    return { loadable: false, reason: "Missing root <Activity> element" };
  }

  const isEmptyActivity = /<Activity\b[^.][^>]*>\s*<\/Activity>/s.test(xamlContent);
  if (isEmptyActivity) {
    return { loadable: false, reason: "Empty <Activity> element — no Implementation child" };
  }

  if (/\[ASSEMBLY_FAILED\]/.test(xamlContent)) {
    return { loadable: false, reason: "Workflow contains [ASSEMBLY_FAILED] marker — tree assembly produced malformed XML" };
  }

  const implPattern = /<(?:Sequence|Flowchart|StateMachine)\b(?!\.)(?:\s|>|\/)/i;
  const hasImplementation = implPattern.test(xamlContent);
  if (!hasImplementation) {
    return { loadable: false, reason: "No <Sequence>, <Flowchart>, or <StateMachine> child — Studio will report DynamicActivity/Implementation is null", repairable: true };
  }

  const openTags: string[] = [];
  const structuralTagPattern = /<\/?(?:Activity|Sequence|Flowchart|StateMachine|TryCatch|If|While|DoWhile|ForEach|Switch|Pick|Parallel)\b(?!\.)[^>]*\/?>/gi;
  let match;
  while ((match = structuralTagPattern.exec(xamlContent)) !== null) {
    const tag = match[0];
    if (tag.endsWith("/>")) continue;
    if (tag.startsWith("</")) {
      const closeName = tag.match(/<\/(\w+)/)?.[1]?.toLowerCase();
      if (closeName && openTags.length > 0 && openTags[openTags.length - 1] === closeName) {
        openTags.pop();
      }
    } else {
      const openName = tag.match(/<(\w+)/)?.[1]?.toLowerCase();
      if (openName) openTags.push(openName);
    }
  }
  if (openTags.length > 0) {
    return { loadable: false, reason: `Unclosed structural element(s): ${openTags.join(", ")}` };
  }

  return { loadable: true };
}

function repairMissingImplementation(xamlContent: string, fileName: string): { repaired: boolean; content: string } {
  const loadResult = checkStudioLoadability(xamlContent);
  if (loadResult.loadable || !loadResult.repairable) {
    return { repaired: false, content: xamlContent };
  }

  const activityOpenMatch = xamlContent.match(/<Activity\b[\s\S]*?>/);
  const activityCloseIdx = xamlContent.lastIndexOf("</Activity>");
  if (!activityOpenMatch || activityCloseIdx < 0) {
    return { repaired: false, content: xamlContent };
  }

  const activityOpenEnd = activityOpenMatch.index! + activityOpenMatch[0].length;
  const innerContent = xamlContent.substring(activityOpenEnd, activityCloseIdx).trim();

  const xMembersMatch = innerContent.match(/<x:Members\b[\s\S]*?<\/x:Members>/);
  const xMembersBlock = xMembersMatch ? xMembersMatch[0] : "";
  const remainingInner = xMembersMatch
    ? innerContent.replace(xMembersBlock, "").trim()
    : innerContent;

  const className = fileName.replace(/\.xaml$/i, "").replace(/[^A-Za-z0-9_]/g, "_");
  const hasUiNamespace = /xmlns:ui=/.test(xamlContent);

  let sequenceBody: string;
  if (remainingInner.length > 0) {
    sequenceBody = `  <Sequence DisplayName="${className}">\n    ${remainingInner}\n  </Sequence>`;
  } else {
    const stubComment = hasUiNamespace
      ? `<ui:Comment Text="[IMPLEMENTATION_REPAIRED] Root container was missing — this stub Sequence was injected to prevent DynamicActivity/Implementation null. Implement the actual logic here." DisplayName="Implementation Repair Stub" />`
      : `<!-- [IMPLEMENTATION_REPAIRED] Root container was missing — this stub Sequence was injected to prevent DynamicActivity/Implementation null. Implement the actual logic here. -->`;
    sequenceBody = `  <Sequence DisplayName="${className}">\n    ${stubComment}\n  </Sequence>`;
  }

  const repairedXaml =
    xamlContent.substring(0, activityOpenEnd) +
    "\n" +
    (xMembersBlock ? xMembersBlock + "\n" : "") +
    sequenceBody +
    "\n" +
    xamlContent.substring(activityCloseIdx);

  const recheckResult = checkStudioLoadability(repairedXaml);
  if (recheckResult.loadable) {
    console.log(`[UiPath] Implementation repair succeeded for "${fileName}" — injected root Sequence`);
    return { repaired: true, content: repairedXaml };
  }

  return { repaired: false, content: xamlContent };
}

function classifyStubFailureCategory(
  file: string,
  remediations: Array<{ file: string; remediationCode: string; classifiedCheck?: string; reason?: string }>,
  qualityViolations: Array<{ file: string; check: string; severity: string; detail?: string }>,
): { category: import("./uipath-pipeline").StubFailureCategory; summary: string; developerAction: string } {
  const fileRemediations = remediations.filter(r => r.file === file || r.file === file.replace(/\.xaml$/i, ""));
  const fileViolations = qualityViolations.filter(v => v.file === file);

  const checks = new Set([
    ...fileRemediations.map(r => r.classifiedCheck).filter(Boolean),
    ...fileViolations.filter(v => v.severity === "error").map(v => v.check),
  ]);

  if (checks.has("xml-wellformedness") || fileRemediations.some(r => r.remediationCode === "STUB_WORKFLOW_BLOCKING" && r.reason?.includes("well-formedness"))) {
    return {
      category: "xml-wellformedness",
      summary: "XML well-formedness failure in tree assembler",
      developerAction: "Regenerate the workflow from the SDD spec, or manually fix XML structure (proper nesting and closing tags)",
    };
  }

  if (checks.has("EXPRESSION_SYNTAX_UNFIXABLE") || checks.has("EXPRESSION_SYNTAX")) {
    const hasVarDefaults = fileViolations.some(v => v.detail?.includes("variable default") || v.detail?.includes("Variable.Default"));
    if (hasVarDefaults) {
      return {
        category: "quality-gate-escalation",
        summary: "Quality gate escalation — variable defaults treated as expressions",
        developerAction: "Manually set variable default values in Studio — the pipeline incorrectly flagged literal defaults as invalid expressions",
      };
    }
    return {
      category: "expression-syntax",
      summary: "Expression syntax errors that could not be auto-corrected",
      developerAction: "Open in Studio and fix VB.NET expression syntax in flagged activities",
    };
  }

  if (checks.has("TYPE_MISMATCH") || checks.has("FOREACH_TYPE_MISMATCH") || checks.has("LITERAL_TYPE_ERROR") || checks.has("invalid-type-argument")) {
    return {
      category: "type-mismatch",
      summary: "Type mismatch — x:Object or incorrect types used where specific types needed",
      developerAction: "Change variable types to match expected types in Studio (e.g., replace x:Object with System.Data.DataTable)",
    };
  }

  if (checks.has("undeclared-variable")) {
    return {
      category: "undeclared-variable",
      summary: "References to variables not declared in the workflow scope",
      developerAction: "Declare missing variables in the Variables panel in Studio, or fix variable name references",
    };
  }

  if (checks.has("unknown-activity") || checks.has("undeclared-namespace") || checks.has("policy-blocked-activity")) {
    return {
      category: "unknown-activity",
      summary: "Unknown or policy-blocked activities referenced in XAML",
      developerAction: "Install required NuGet packages or replace blocked activities with approved alternatives",
    };
  }

  if (fileRemediations.some(r => r.remediationCode === "STUB_WORKFLOW_GENERATOR_FAILURE")) {
    return {
      category: "generation-failure",
      summary: "Workflow generation failed — LLM output could not be parsed into valid XAML",
      developerAction: "Re-implement the workflow from scratch using the SDD specification as reference",
    };
  }

  const loadabilityFailure = fileRemediations.some(r => r.reason?.includes("not Studio-loadable") || r.reason?.includes("Implementation is null"));
  if (loadabilityFailure) {
    return {
      category: "structural-invalid",
      summary: "Structural preservation — valid XML but not Studio-loadable (missing Implementation)",
      developerAction: "Rebuild the workflow from scratch — the preserved XML structure lacks required XAML semantics",
    };
  }

  return {
    category: "compliance-failure",
    summary: "Compliance or quality gate failure requiring manual remediation",
    developerAction: "Review quality gate findings and fix each issue in Studio",
  };
}

function buildReachabilityGraph(
  deferredWrites: Map<string, string>,
  xamlEntries: Array<{ name: string; content: string }>,
  libPath: string,
): { reachable: Set<string>; unreachable: Set<string>; graph: Map<string, string[]> } {
  const allFiles = new Map<string, string>();
  const filenameToKey = new Map<string, string>();
  const prefix = libPath + "/";

  Array.from(deferredWrites.entries()).forEach(([path, content]) => {
    if (path.endsWith(".xaml")) {
      const relPath = path.startsWith(prefix) ? path.slice(prefix.length) : (path.split("/").pop() || path);
      const normalizedKey = normalizeXamlPath(relPath);
      allFiles.set(normalizedKey, content);
      const basename = normalizedKey.split("/").pop() || normalizedKey;
      if (!filenameToKey.has(basename)) {
        filenameToKey.set(basename, normalizedKey);
      }
    }
  });
  for (const entry of xamlEntries) {
    const relPath = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : (entry.name.split("/").pop() || entry.name);
    const normalizedKey = normalizeXamlPath(relPath);
    if (normalizedKey.endsWith(".xaml") && !allFiles.has(normalizedKey)) {
      allFiles.set(normalizedKey, entry.content);
      const basename = normalizedKey.split("/").pop() || normalizedKey;
      if (!filenameToKey.has(basename)) {
        filenameToKey.set(basename, normalizedKey);
      }
    }
  }

  const graph = new Map<string, string[]>();

  Array.from(allFiles.entries()).forEach(([file, content]) => {
    const refs: string[] = [];
    const invokePattern = /WorkflowFileName="([^"]+)"/g;
    let match;
    while ((match = invokePattern.exec(content)) !== null) {
      const rawRef = normalizeXamlPath(match[1]);
      if (allFiles.has(rawRef)) {
        refs.push(rawRef);
      } else {
        const refBasename = rawRef.split("/").pop() || rawRef;
        const mappedKey = filenameToKey.get(refBasename);
        if (mappedKey) {
          refs.push(mappedKey);
        } else {
          refs.push(rawRef);
        }
      }
    }
    graph.set(file, refs);
  });

  const reachable = new Set<string>();
  const mainKey = allFiles.has("Main.xaml") ? "Main.xaml" : (filenameToKey.get("Main.xaml") || "Main.xaml");
  const queue = [mainKey];
  reachable.add(mainKey);

  const processKey = allFiles.has("Process.xaml") ? "Process.xaml" : filenameToKey.get("Process.xaml");
  if (processKey && !reachable.has(processKey)) {
    reachable.add(processKey);
    queue.push(processKey);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const refs = graph.get(current) || [];
    for (const ref of refs) {
      if (!reachable.has(ref) && allFiles.has(ref)) {
        reachable.add(ref);
        queue.push(ref);
      }
    }
  }

  const INFRASTRUCTURE_FILES = new Set([
    "InitAllSettings.xaml",
    "CloseAllApplications.xaml",
    "KillAllProcesses.xaml",
  ]);

  const unreachable = new Set<string>();
  Array.from(allFiles.keys()).forEach(file => {
    const basename = file.split("/").pop() || file;
    if (!reachable.has(file) && !INFRASTRUCTURE_FILES.has(basename)) {
      unreachable.add(file);
    }
  });

  return { reachable, unreachable, graph };
}

function filterUnreachableBySpecDecomposition(
  unreachable: Set<string>,
  generatedWorkflowNames: Set<string>,
): { trulyOrphaned: Set<string>; specRetained: Set<string> } {
  const trulyOrphaned = new Set<string>();
  const specRetained = new Set<string>();

  Array.from(unreachable).forEach(file => {
    const basename = (file.split("/").pop() || file).replace(/\.xaml$/i, "");
    if (generatedWorkflowNames.has(basename)) {
      specRetained.add(file);
    } else {
      trulyOrphaned.add(file);
    }
  });

  return { trulyOrphaned, specRetained };
}

function removeUnreachableFiles(
  deferredWrites: Map<string, string>,
  xamlEntries: Array<{ name: string; content: string }>,
  unreachable: Set<string>,
  libPath: string,
): { removedFiles: string[]; reasons: string[] } {
  const removedFiles: string[] = [];
  const reasons: string[] = [];

  Array.from(unreachable).forEach(file => {
    if (file === "Main.xaml" || file === "Process.xaml" || file === "InitAllSettings.xaml") {
      console.log(`[Structural Dedup] Protected "${file}" from removal — critical entry-point file`);
      return;
    }
    const archivePath = `${libPath}/${file}`;
    if (deferredWrites.has(archivePath)) {
      deferredWrites.delete(archivePath);
      removedFiles.push(file);
      reasons.push(`Removed "${file}": unreachable from Main.xaml entry-point graph — no InvokeWorkflowFile reference chain leads to this file`);
      console.log(`[Structural Dedup] Removed unreachable file: ${file}`);
    }
  });

  const prefix = libPath + "/";
  for (let i = xamlEntries.length - 1; i >= 0; i--) {
    const entryName = xamlEntries[i].name;
    const relPath = entryName.startsWith(prefix) ? entryName.slice(prefix.length) : (entryName.split("/").pop() || entryName);
    if (unreachable.has(relPath)) {
      if (relPath === "Main.xaml" || relPath === "Process.xaml" || relPath === "InitAllSettings.xaml") continue;
      if (!removedFiles.includes(relPath)) {
        removedFiles.push(relPath);
        reasons.push(`Removed "${relPath}" from xamlEntries: unreachable from Main.xaml entry-point graph`);
      }
      xamlEntries.splice(i, 1);
      console.log(`[Structural Dedup] Removed unreachable xamlEntry: ${relPath}`);
    }
  }

  return { removedFiles, reasons };
}

const INFRASTRUCTURE_WORKFLOW_NAMES = new Set([
  "main",
  "initallsettings",
  "closeallapplications",
  "gettransactiondata",
  "settransactionstatus",
  "killallprocesses",
]);

function normalizeWorkflowBasename(name: string): string {
  return name.replace(/\.xaml$/i, "").replace(/[_\s.]+/g, "").toLowerCase();
}

function isInfrastructureWorkflowName(name: string): boolean {
  return INFRASTRUCTURE_WORKFLOW_NAMES.has(normalizeWorkflowBasename(name));
}

function chooseMainEntryWorkflowNames(
  candidates: Iterable<string>,
  preferredName?: string | null,
): string[] {
  const unique = Array.from(new Set(Array.from(candidates)
    .map(name => name.replace(/\.xaml$/i, ""))
    .filter(name => !!name)
    .filter(name => normalizeWorkflowBasename(name) !== "main")
    .filter(name => !isInfrastructureWorkflowName(name))));

  if (unique.length === 0) return [];

  const priority = [
    preferredName || "",
    "Process",
    "Dispatcher",
    "Performer",
    "CalendarReader",
    "ContactResolver",
    "MessageComposer",
    "EmailSender",
    "ReviewHandler",
    "AuditPersistence",
  ].filter(Boolean);

  const selected: string[] = [];
  for (const target of priority) {
    const match = unique.find(name => normalizeWorkflowBasename(name) === normalizeWorkflowBasename(target));
    if (match && !selected.includes(match)) {
      selected.push(match);
    }
  }

  if (selected.length > 0) return selected;
  return [unique[0]];
}

type CredentialStrategy = "GetAsset" | "GetCredential" | "mixed" | "none";

function detectCredentialStrategy(xamlContent: string): CredentialStrategy {
  const hasGetAsset = /<ui:GetAsset[\s>]/.test(xamlContent);
  const hasGetCredential = /<ui:GetCredential[\s>]/.test(xamlContent);
  if (hasGetAsset && hasGetCredential) return "mixed";
  if (hasGetAsset) return "GetAsset";
  if (hasGetCredential) return "GetCredential";
  return "none";
}

function determineCredentialStrategy(orchestratorArtifacts?: any): CredentialStrategy {
  const assets = orchestratorArtifacts?.assets || [];
  const hasCredentials = assets.some((a: any) => a.type === "Credential");
  const hasTextAssets = assets.some((a: any) => a.type !== "Credential");
  if (hasCredentials && !hasTextAssets) return "GetCredential";
  if (!hasCredentials && hasTextAssets) return "GetAsset";
  if (hasCredentials && hasTextAssets) return "mixed";
  return "none";
}

function reconcileCredentialStrategy(
  deferredWrites: Map<string, string>,
  xamlEntries: Array<{ name: string; content: string }>,
  predeterminedStrategy?: CredentialStrategy,
): { strategy: CredentialStrategy; reconciled: boolean; warnings: string[] } {
  const warnings: string[] = [];

  if (predeterminedStrategy && predeterminedStrategy !== "none") {
    if (predeterminedStrategy === "mixed") {
      console.log(`[Credential Reconciliation] Pre-determined mixed strategy (both credential and text assets declared) — both GetCredential and GetAsset are intentional, skipping reconciliation`);
    } else {
      console.log(`[Credential Reconciliation] Using pre-determined strategy: ${predeterminedStrategy} — skipping reconciliation`);
    }
    const effectiveStrategy = predeterminedStrategy === "mixed" ? "GetCredential" : predeterminedStrategy;
    return { strategy: effectiveStrategy, reconciled: false, warnings };
  }

  let globalHasAsset = false;
  let globalHasCredential = false;

  Array.from(deferredWrites.entries()).forEach(([path, content]) => {
    if (path.endsWith(".xaml")) {
      const strategy = detectCredentialStrategy(content);
      if (strategy === "GetAsset" || strategy === "mixed") globalHasAsset = true;
      if (strategy === "GetCredential" || strategy === "mixed") globalHasCredential = true;
    }
  });

  for (const entry of xamlEntries) {
    const strategy = detectCredentialStrategy(entry.content);
    if (strategy === "GetAsset" || strategy === "mixed") globalHasAsset = true;
    if (strategy === "GetCredential" || strategy === "mixed") globalHasCredential = true;
  }

  if (!globalHasAsset || !globalHasCredential) {
    const strategy = globalHasCredential ? "GetCredential" : (globalHasAsset ? "GetAsset" : "none");
    return { strategy, reconciled: false, warnings };
  }

  const targetStrategy: CredentialStrategy = "GetCredential";
  warnings.push(
    `Mixed credential strategies detected (both GetAsset and GetCredential). ` +
    `Reconciled to "${targetStrategy}" for consistency across all workflows.`
  );
  console.log(`[Credential Reconciliation] Mixed strategies detected — reconciling to ${targetStrategy}`);

  return { strategy: targetStrategy, reconciled: true, warnings };
}

interface PostAssemblyValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

function runPostAssemblyValidation(
  deps: Record<string, string>,
  studioVersion: string,
  xamlEntries: Array<{ name: string; content: string }>,
  deferredWrites: Map<string, string>,
  libPath: string,
  studioProfile: StudioProfile | null,
  metaTarget: { version: string } | null,
): PostAssemblyValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const [pkgName, version] of Object.entries(deps)) {
    const metaVersion = _metadataService.getPreferredVersion(pkgName);
    if (!metaVersion) {
      errors.push(`Dependency "${pkgName}" version "${version}" is not in the validated version registry`);
    }
  }

  if (!validateStudioVersion(studioVersion)) {
    errors.push(`studioVersion "${studioVersion}" does not match a valid Studio version format`);
  } else {
    const validatedVersion = isVersionFromValidatedSource(studioProfile, metaTarget);
    if (!validatedVersion) {
      errors.push(`studioVersion "${studioVersion}" is not from a validated source (studio profile or metadata service)`);
    } else if (validatedVersion !== studioVersion) {
      warnings.push(`studioVersion "${studioVersion}" differs from validated source version "${validatedVersion}"`);
    }
  }

  const { reachable, unreachable } = buildReachabilityGraph(deferredWrites, xamlEntries, libPath);

  const fileRelPaths = new Set<string>();
  const valPrefix = libPath + "/";
  Array.from(deferredWrites.entries()).forEach(([path]) => {
    if (path.endsWith(".xaml")) {
      const relPath = path.startsWith(valPrefix) ? path.slice(valPrefix.length) : (path.split("/").pop() || path);
      fileRelPaths.add(relPath);
    }
  });
  for (const entry of xamlEntries) {
    const relPath = entry.name.startsWith(valPrefix) ? entry.name.slice(valPrefix.length) : (entry.name.split("/").pop() || entry.name);
    if (relPath.endsWith(".xaml")) fileRelPaths.add(relPath);
  }

  if (!fileRelPaths.has("Main.xaml")) {
    errors.push("Entry point file Main.xaml does not exist in the package");
  }

  if (unreachable.size > 0) {
    warnings.push(`${unreachable.size} XAML file(s) unreachable from Main.xaml: ${Array.from(unreachable).join(", ")}`);
  }

  const allXamlContent = [
    ...xamlEntries.map(e => e.content),
    ...Array.from(deferredWrites.entries())
      .filter(([p]) => p.endsWith(".xaml"))
      .map(([, c]) => c),
  ].join("\n");

  const objectDefaultPattern = /<Variable\s+x:TypeArguments="x:Object"[^>]*Default="[^"]*"/g;
  let objDefaultMatch;
  while ((objDefaultMatch = objectDefaultPattern.exec(allXamlContent)) !== null) {
    const nameMatch = objDefaultMatch[0].match(/Name="([^"]+)"/);
    const varName = nameMatch ? nameMatch[1] : "unknown";
    warnings.push(`Variable "${varName}" has Default value on x:Object type — may cause "Literal only supports value types" error`);
  }

  const csharpPatterns = [
    { pattern: /\bnew\s+[A-Z]\w*\s*</g, desc: "C# new with generic angle bracket" },
    { pattern: /!=\s*null/g, desc: "C# != null" },
    { pattern: /&&/g, desc: "C# &&" },
    { pattern: /\|\|/g, desc: "C# ||" },
    { pattern: /=>\s*\{/g, desc: "C# lambda =>" },
    { pattern: /\$"/g, desc: "C# string interpolation $\"" },
  ];
  const exprContentOnly = allXamlContent.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  for (const { pattern, desc } of csharpPatterns) {
    const attrContext = new RegExp(`(?:Condition|Value|Expression|Message|Text)="[^"]*${pattern.source}`, "g");
    if (attrContext.test(exprContentOnly)) {
      warnings.push(`C# expression leakage detected: ${desc} found in XAML expression attributes`);
    }
  }

  if (/<If\.Then>\s*<\/If\.Then>/.test(allXamlContent)) {
    errors.push("Container structure error: Empty If.Then element — Studio requires exactly one child activity");
  }
  if (/<TryCatch\.Try>\s*<\/TryCatch\.Try>/.test(allXamlContent)) {
    errors.push("Container structure error: Empty TryCatch.Try element — Studio requires exactly one child activity");
  }
  const forEachPattern = /<ForEach\s[^>]*>[\s\S]*?<\/ForEach>/g;
  let feCheckMatch;
  while ((feCheckMatch = forEachPattern.exec(allXamlContent)) !== null) {
    if (!feCheckMatch[0].includes("<ActivityAction")) {
      errors.push("Container structure error: ForEach missing ActivityAction child — required by Studio");
    }
  }

  if (allXamlContent.includes("<StateMachine") || allXamlContent.includes("<State ")) {
    if (!allXamlContent.includes("System.Activities.Statements") && !allXamlContent.includes("sads:")) {
      warnings.push("StateMachine/State used but System.Activities.Statements namespace not declared");
    }
  }

  if (allXamlContent.includes("<ui:RetryScope")) {
    if (allXamlContent.includes("<ui:RetryScope.Body>")) {
      errors.push("RetryScope uses explicit .Body property element — Studio 25.10 requires default content property");
    }
    const retryScopeBlocks = /<ui:RetryScope\s[^>]*>[\s\S]*?<\/ui:RetryScope>/g;
    let rsMatch;
    while ((rsMatch = retryScopeBlocks.exec(allXamlContent)) !== null) {
      const block = rsMatch[0];
      if (!block.includes("<ui:RetryScope.Condition>") && !block.includes("<ui:ShouldRetry")) {
        warnings.push("RetryScope is missing Condition element (ui:RetryScope.Condition with ui:ShouldRetry)");
      }
      const directChildren = block.match(/<Sequence\s/g) || [];
      if (directChildren.length === 0 && !block.includes("<ui:RetryScope.Body>")) {
        warnings.push("RetryScope has no Sequence child as default content — body activities may not execute");
      }
    }
  }

  if (allXamlContent.includes("<ui:GetAsset")) {
    const getAssetBlockPattern = /<ui:GetAsset[\s\S]*?<\/ui:GetAsset>/g;
    const getAssetVarPattern = /<ui:GetAsset\.AssetValue>[\s\S]*?<OutArgument[^>]*>\[([^\]]+)\]/;
    let gaMatch;
    while ((gaMatch = getAssetBlockPattern.exec(allXamlContent)) !== null) {
      const assetBlock = gaMatch[0];
      const outputMatch = getAssetVarPattern.exec(assetBlock);
      if (!outputMatch) continue;
      const varName = outputMatch[1];
      const varDeclared = allXamlContent.includes(`Name="${varName}"`);
      if (!varDeclared) {
        warnings.push(`GetAsset output variable "${varName}" is not declared in workflow variables`);
      }
    }
  }

  const activityFamilyChecks = [
    {
      tag: "ui:GetTransactionItem",
      requiredProps: ["QueueName"],
      outputProps: ["TransactionItem"],
      desc: "GetTransactionItem",
    },
    {
      tag: "ui:AddQueueItem",
      requiredProps: ["QueueName", "ItemInformation"],
      outputProps: [],
      desc: "AddQueueItem",
    },
    {
      tag: "ui:SetTransactionStatus",
      requiredProps: ["TransactionItem", "Status"],
      outputProps: [],
      desc: "SetTransactionStatus",
    },
    {
      tag: "ui:GetCredential",
      requiredProps: ["AssetName"],
      outputProps: ["Username", "Password"],
      desc: "GetCredential",
    },
    {
      tag: "ui:GetAsset",
      requiredProps: ["AssetName"],
      outputProps: ["AssetValue"],
      desc: "GetAsset",
    },
  ];

  for (const check of activityFamilyChecks) {
    const tagPattern = new RegExp(`<${check.tag}\\s[^>]*>`, "g");
    let familyMatch;
    while ((familyMatch = tagPattern.exec(allXamlContent)) !== null) {
      const tagStr = familyMatch[0];
      for (const reqProp of check.requiredProps) {
        if (!tagStr.includes(`${reqProp}="`)) {
          const endIdx = allXamlContent.indexOf(`</${check.tag}>`, familyMatch.index);
          const bodySection = endIdx > 0 ? allXamlContent.substring(familyMatch.index, endIdx) : tagStr;
          if (!bodySection.includes(`${check.tag}.${reqProp}`)) {
            warnings.push(`${check.desc} activity is missing required property "${reqProp}"`);
          }
        }
      }
    }
  }

  const transitionTags = /<Transition\s[^>]*>/g;
  let transValidMatch;
  while ((transValidMatch = transitionTags.exec(allXamlContent)) !== null) {
    const tag = transValidMatch[0];
    if (!tag.includes('To="{x:Reference')) {
      if (!tag.includes('To="')) {
        warnings.push("Transition is missing To attribute — every Transition must specify a target State");
      }
    }
  }

  if (allXamlContent.includes("<State ")) {
    const stateBlocks = /<State\s[^>]*DisplayName="([^"]*)"[^>]*>[\s\S]*?<\/State>/g;
    let stValidMatch;
    while ((stValidMatch = stateBlocks.exec(allXamlContent)) !== null) {
      const stateName = stValidMatch[1];
      const block = stValidMatch[0];
      const isFinal = /IsFinal="True"/i.test(block);
      if (!isFinal && !block.includes("<State.Entry>")) {
        warnings.push(`State "${stateName}" is missing State.Entry — non-final states require entry activities`);
      }
    }
  }

  console.log(`[Post-Assembly Validation] Activity family checks complete: ${warnings.length} warning(s), ${errors.length} error(s)`);

  return {
    passed: errors.length === 0,
    errors,
    warnings,
  };
}

function buildAssemblyToPackageMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [packageId, info] of Object.entries(PACKAGE_NAMESPACE_MAP)) {
    if (info.assembly && !isFrameworkAssembly(packageId)) {
      map.set(info.assembly, packageId);
    }
  }
  return map;
}

function extractXamlNamespaceAndAssemblyPackages(allXamlContent: string): Set<string> {
  const packages = new Set<string>();
  const assemblyToPackage = buildAssemblyToPackageMap();

  const xmlnsPattern = /xmlns:\w+="clr-namespace:[^;]*;assembly=([^"]+)"/g;
  let match;
  while ((match = xmlnsPattern.exec(allXamlContent)) !== null) {
    const assemblyName = match[1].trim();
    const pkgId = assemblyToPackage.get(assemblyName);
    if (pkgId) {
      packages.add(pkgId);
    }
  }

  const assemblyRefPattern = /<AssemblyReference>([^<]+)<\/AssemblyReference>/g;
  while ((match = assemblyRefPattern.exec(allXamlContent)) !== null) {
    const assemblyName = match[1].trim();
    const pkgId = assemblyToPackage.get(assemblyName);
    if (pkgId) {
      packages.add(pkgId);
    }
  }

  return packages;
}

function validateNamespaceCoverage(
  allXamlContent: string,
  deps: Record<string, string>,
): string[] {
  const warnings: string[] = [];
  const assemblyToPackage = buildAssemblyToPackageMap();
  const depPackages = new Set(Object.keys(deps));

  const xmlnsPattern = /xmlns:(\w+)="clr-namespace:([^;]*);assembly=([^"]+)"/g;
  let match;
  while ((match = xmlnsPattern.exec(allXamlContent)) !== null) {
    const [, prefix, , assemblyName] = match;
    const trimmedAssembly = assemblyName.trim();
    if (isFrameworkAssembly(trimmedAssembly)) continue;
    if (trimmedAssembly === "System.Activities" || trimmedAssembly === "mscorlib" || trimmedAssembly === "System" || trimmedAssembly === "System.Core" || trimmedAssembly === "System.Data") continue;

    const pkgId = assemblyToPackage.get(trimmedAssembly);
    if (pkgId) {
      if (!depPackages.has(pkgId)) {
        warnings.push(`Namespace prefix "${prefix}" references assembly "${trimmedAssembly}" (package: ${pkgId}) which is not in project.json dependencies`);
      }
    }
  }

  const assemblyRefPattern = /<AssemblyReference>([^<]+)<\/AssemblyReference>/g;
  while ((match = assemblyRefPattern.exec(allXamlContent)) !== null) {
    const assemblyName = match[1].trim();
    if (isFrameworkAssembly(assemblyName)) continue;
    if (assemblyName === "System.Activities" || assemblyName === "mscorlib" || assemblyName === "System" || assemblyName === "System.Core" || assemblyName === "System.Data") continue;

    const pkgId = assemblyToPackage.get(assemblyName);
    if (pkgId && !depPackages.has(pkgId)) {
      warnings.push(`AssemblyReference "${assemblyName}" (package: ${pkgId}) is not covered by project.json dependencies`);
    }
  }

  return warnings;
}

function sanitizeDeps(deps: Record<string, string>): void {
  for (const [key, val] of Object.entries(deps)) {
    if (isFrameworkAssembly(key)) {
      console.log(`[UiPath Sanitize] Removing framework assembly from dependencies: ${key}`);
      delete deps[key];
    } else if (val === "*" || val === "[*]") {
      console.log(`[UiPath Sanitize] Removing wildcard dependency version: ${key}=${val}`);
      delete deps[key];
    } else if (!isValidNuGetVersion(val)) {
      console.log(`[UiPath Sanitize] Removing malformed dependency version: ${key}=${val}`);
      delete deps[key];
    }
  }
}

export function normalizePackageName(name: string): string {
  return UIPATH_PACKAGE_ALIAS_MAP[name] || name;
}

export interface DependencyResolutionResult {
  deps: Record<string, string>;
  warnings: Array<{ code: string; message: string; stage: string; recoverable: boolean; affectedFiles?: string[] }>;
  specPredictedPackages: Set<string>;
}

function collectActivityTemplatesFromNode(node: TreeWorkflowNode): string[] {
  const templates: string[] = [];
  if (node.kind === "activity") {
    templates.push(node.template);
  } else if (node.kind === "sequence" && node.children) {
    for (const child of node.children) {
      templates.push(...collectActivityTemplatesFromNode(child));
    }
  } else if (node.kind === "tryCatch") {
    for (const child of [...(node.tryChildren || []), ...(node.catchChildren || []), ...(node.finallyChildren || [])]) {
      templates.push(...collectActivityTemplatesFromNode(child));
    }
  } else if (node.kind === "if") {
    for (const child of [...(node.thenChildren || []), ...(node.elseChildren || [])]) {
      templates.push(...collectActivityTemplatesFromNode(child));
    }
  } else if (node.kind === "while" || node.kind === "forEach" || node.kind === "retryScope") {
    for (const child of (node.bodyChildren || [])) {
      templates.push(...collectActivityTemplatesFromNode(child));
    }
  }
  return templates;
}

function collectActivityTemplatesFromSpec(spec: TreeWorkflowSpec): Set<string> {
  const templates = new Set<string>();
  templates.add("LogMessage");
  if (spec.rootSequence?.children) {
    for (const child of spec.rootSequence.children) {
      for (const t of collectActivityTemplatesFromNode(child)) {
        templates.add(t);
      }
    }
  }
  return templates;
}

function collectActivityTypesFromWorkflows(workflows: Array<{ steps?: Array<{ activityType?: string; activityPackage?: string }> }>): Set<string> {
  const packages = new Set<string>();
  packages.add("UiPath.System.Activities");
  for (const wf of workflows) {
    for (const step of wf.steps || []) {
      if (step.activityPackage) {
        packages.add(step.activityPackage);
      }
      if (step.activityType) {
        const pkg = catalogService.getPackageForActivity(step.activityType);
        if (pkg) {
          packages.add(pkg);
        } else {
          const registryPkg = getActivityPackage(step.activityType);
          if (registryPkg) {
            packages.add(registryPkg);
            console.log(`[Dependency Resolution] Proactively resolved ${step.activityType} → ${registryPkg} via activity registry (catalog miss)`);
          }
        }
      }
    }
  }
  return packages;
}

export function resolveDependencies(
  pkg: { workflows?: Array<{ name?: string; steps?: Array<{ activityType?: string; activityPackage?: string }> }> },
  studioProfile: StudioProfile | null,
  treeSpecs: TreeWorkflowSpec | TreeWorkflowSpec[] | null,
  targetFramework?: "Windows" | "Portable",
): DependencyResolutionResult {
  const deps: Record<string, string> = {};
  const warnings: DependencyResolutionResult["warnings"] = [];
  const referencedPackages = new Set<string>();
  const specPredictedPackages = new Set<string>();
  const tf = targetFramework || (studioProfile?.targetFramework) || "Windows";

  referencedPackages.add("UiPath.System.Activities");
  referencedPackages.add("UiPath.Excel.Activities");
  if (tf !== "Portable") {
    referencedPackages.add("UiPath.UIAutomation.Activities");
  }

  const specArray: TreeWorkflowSpec[] = treeSpecs
    ? (Array.isArray(treeSpecs) ? treeSpecs : [treeSpecs])
    : [];

  const NEWTONSOFT_TRIGGER_ACTIVITIES = new Set(["DeserializeJson", "SerializeJson", "HttpClient", "DeserializeJsonArray"]);
  const NEWTONSOFT_TYPE_PATTERNS = ["JObject", "JToken", "JArray", "JValue", "JsonConvert", "Newtonsoft"];

  for (const treeSpec of specArray) {
    const activityTemplates = collectActivityTemplatesFromSpec(treeSpec);
    for (const template of activityTemplates) {
      let pkgId = catalogService.getPackageForActivity(template);
      if (!pkgId) {
        pkgId = getActivityPackage(template) || null;
        if (pkgId) {
          console.log(`[Dependency Resolution] Proactively resolved tree spec activity ${template} → ${pkgId} via registry fallback`);
        }
      }
      if (pkgId) {
        const normalized = normalizePackageName(pkgId);
        referencedPackages.add(normalized);
        specPredictedPackages.add(normalized);
      }
      if (NEWTONSOFT_TRIGGER_ACTIVITIES.has(template)) {
        referencedPackages.add("Newtonsoft.Json");
        specPredictedPackages.add("Newtonsoft.Json");
        console.log(`[Dependency Resolution] Proactively added Newtonsoft.Json — spec references JSON activity "${template}"`);
      }
    }

    const specJson = JSON.stringify(treeSpec);
    for (const typePattern of NEWTONSOFT_TYPE_PATTERNS) {
      if (specJson.includes(typePattern)) {
        referencedPackages.add("Newtonsoft.Json");
        specPredictedPackages.add("Newtonsoft.Json");
        console.log(`[Dependency Resolution] Proactively added Newtonsoft.Json — spec contains type reference "${typePattern}"`);
        break;
      }
    }
  }

  if (pkg.workflows) {
    const legacyPackages = collectActivityTypesFromWorkflows(pkg.workflows);
    for (const p of legacyPackages) {
      referencedPackages.add(normalizePackageName(p));
    }
  }

  if (studioProfile) {
    for (const requiredPkg of studioProfile.minimumRequiredPackages) {
      referencedPackages.add(normalizePackageName(requiredPkg));
    }
  }

  Array.from(referencedPackages).forEach(fwAsm => {
    if (isFrameworkAssembly(fwAsm)) {
      referencedPackages.delete(fwAsm);
      console.log(`[Dependency Resolution] Excluded framework assembly from dependencies: ${fwAsm}`);
    }
  });

  const packageProvenance: Record<string, { activities: string[]; workflows: string[] }> = {};
  if (pkg.workflows) {
    for (const wf of pkg.workflows) {
      const wfName = wf.name || "unknown-workflow";
      for (const step of wf.steps || []) {
        const pkgs: string[] = [];
        if (step.activityPackage) pkgs.push(normalizePackageName(step.activityPackage));
        if (step.activityType) {
          const resolved = catalogService.getPackageForActivity(step.activityType);
          if (resolved) pkgs.push(normalizePackageName(resolved));
        }
        for (const p of pkgs) {
          if (!packageProvenance[p]) packageProvenance[p] = { activities: [], workflows: [] };
          if (step.activityType && !packageProvenance[p].activities.includes(step.activityType)) {
            packageProvenance[p].activities.push(step.activityType);
          }
          if (!packageProvenance[p].workflows.includes(wfName)) {
            packageProvenance[p].workflows.push(wfName);
          }
        }
      }
    }
  }

  for (const rawPkgName of referencedPackages) {
    const pkgName = normalizePackageName(rawPkgName);
    if (isFrameworkAssembly(pkgName)) {
      console.log(`[Dependency Resolution] Excluded framework assembly (post-normalize) from dependencies: ${pkgName}`);
      continue;
    }
    let version: string | null = null;
    let source: string = "";

    const preferred = getPreferredVersionFromMeta(pkgName);
    if (preferred) {
      version = preferred;
      source = "generation-metadata";
    }

    if (!version && catalogService.isLoaded()) {
      const catalogVersion = catalogService.getConfirmedVersion(pkgName);
      if (catalogVersion) {
        version = catalogVersion;
        source = "catalog";
      }
    }

    if (!version) {
      const prov = packageProvenance[pkgName];
      const activityInfo = prov?.activities.length ? ` Referenced by activities: [${prov.activities.join(", ")}].` : "";
      const workflowInfo = prov?.workflows.length ? ` Found in workflows: [${prov.workflows.join(", ")}].` : "";
      const layersChecked = [
        "generation-metadata (packageVersionRanges): no match",
        catalogService.isLoaded() ? "activity-catalog (getConfirmedVersion): no match" : "activity-catalog: not loaded",
      ].join("; ");
      throw new Error(
        `[Dependency Resolution] FATAL: Package "${pkgName}" is referenced by activities but has no validated version.${activityInfo}${workflowInfo} ` +
        `Authority layers checked: [${layersChecked}]. ` +
        `Cannot emit a fabricated version — build aborted. Add this package to the generation-metadata.json packageVersionRanges to resolve.`
      );
    }

    deps[pkgName] = version;
  }

  validateAndEnforceDependencyCompatibility(deps, warnings);

  console.log(`[Dependency Resolution] Resolved ${Object.keys(deps).length} dependencies proactively from ${referencedPackages.size} referenced packages (${specPredictedPackages.size} spec-predicted)`);
  return { deps, warnings, specPredictedPackages };
}

type CachedStageEnrichment = {
  fingerprint: string;
  enrichment: EnrichmentResult | null;
  treeEnrichment: TreeEnrichmentResult | null;
  usedAIFallback: boolean;
};

type CachedStageXaml = {
  fingerprint: string;
  xamlEntries: { name: string; content: string }[];
  gaps: XamlGap[];
  usedPackages: string[];
  dependencyMap: Record<string, string>;
  archiveManifest: string[];
  referencedMLSkillNames: string[];
  projectJsonContent?: string;
  configCsv?: string;
  targetFramework?: string;
  automationPattern?: string;
  buffer: Buffer;
};

type CachedStageQualityGate = {
  fingerprint: string;
  qualityGatePassed: boolean;
  qualityGateResult?: QualityGateResult;
};

type CachedBuild = {
  overallFingerprint: string;
  version: string;
  buffer: Buffer;
  gaps: XamlGap[];
  usedPackages: string[];
  enrichment: EnrichmentResult | null;
  qualityGatePassed: boolean;
  qualityGateResult?: QualityGateResult;
  xamlEntries: { name: string; content: string }[];
  dependencyMap: Record<string, string>;
  archiveManifest: string[];
  referencedMLSkillNames?: string[];
  usedAIFallback?: boolean;
  projectJsonContent?: string;
  stageEnrichment?: CachedStageEnrichment;
  stageXaml?: CachedStageXaml;
  stageQualityGate?: CachedStageQualityGate;
  complexityTier?: string;
};

const packageBuildCache = new Map<string, CachedBuild>();
const CACHE_MAX_ENTRIES = 20;

console.log("[UiPath Cache] Clearing build cache on module load");
packageBuildCache.clear();

function evictOldestCacheEntry(): void {
  if (packageBuildCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = packageBuildCache.keys().next().value;
    if (oldest) {
      packageBuildCache.delete(oldest);
      console.log(`[UiPath Cache] Evicted oldest entry: ${oldest}`);
    }
  }
}

export function clearPackageCache(ideaId: string): void {
  let cleared = false;
  for (const key of Array.from(packageBuildCache.keys())) {
    if (key === ideaId || key.startsWith(`${ideaId}:`)) {
      packageBuildCache.delete(key);
      cleared = true;
    }
  }
  if (cleared) {
    console.log(`[UiPath Cache] Cleared cache for ${ideaId}`);
  }
}

function buildXaml(className: string, displayName: string, activities: string, variablesBlock?: string): string {
  const vars = variablesBlock || "<Sequence.Variables />";
  return `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${escapeXml(className)}"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Data;assembly=System.Data"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="${escapeXml(displayName)}">
    ${vars}${activities}
  </Sequence>
</Activity>`;
}

function generateUuid(): string {
  const hex = "0123456789abcdef";
  let uuid = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) uuid += "-";
    else if (i === 14) uuid += "4";
    else uuid += hex[Math.floor(Math.random() * 16)];
  }
  return uuid;
}

export function generateConfigXlsx(projectName: string, sddContent?: string, orchestratorArtifacts?: any): string {
  const settingsRows: string[][] = [["Name", "Value", "Description"]];
  const constantsRows: string[][] = [["Name", "Value", "Description"]];

  if (orchestratorArtifacts) {
    if (orchestratorArtifacts.assets) {
      for (const asset of orchestratorArtifacts.assets) {
        if (asset.type === "Credential") {
          settingsRows.push([asset.name, "", asset.description || `Credential: ${asset.name}`]);
        } else {
          settingsRows.push([asset.name, asset.value || "", asset.description || ""]);
        }
      }
    }
    if (orchestratorArtifacts.queues) {
      for (const q of orchestratorArtifacts.queues) {
        constantsRows.push([`QueueName_${q.name}`, q.name, q.description || `Queue: ${q.name}`]);
      }
    }
  } else if (sddContent) {
    const section9Match = sddContent.match(/## 9[\.\s][^\n]+\n([\s\S]*?)(?=## \d+\.|$)/);
    if (section9Match) {
      const artifactMatch = section9Match[1].match(/```orchestrator_artifacts\s*\n([\s\S]*?)\n```/);
      if (artifactMatch) {
        try {
          const artifacts = JSON.parse(artifactMatch[1]);
          if (artifacts.assets) {
            for (const asset of artifacts.assets) {
              if (asset.type === "Credential") {
                settingsRows.push([asset.name, "", asset.description || `Credential: ${asset.name}`]);
              } else {
                settingsRows.push([asset.name, asset.value || "", asset.description || ""]);
              }
            }
          }
        } catch { /* parse error */ }
      }
    }
  }

  if (sddContent) {
    const section4Match = sddContent.match(/## 4[\.\s][^\n]+\n([\s\S]*?)(?=## \d+\.|$)/);
    if (section4Match) {
      const urlMatches = section4Match[1].match(/https?:\/\/[^\s)>"]+/g);
      if (urlMatches) {
        const seen = new Set<string>();
        for (const url of urlMatches) {
          if (!seen.has(url)) {
            seen.add(url);
            constantsRows.push([`URL_${seen.size}`, url, `Integration endpoint`]);
          }
        }
      }
    }
  }

  settingsRows.push(["OrchestratorURL", "", "Orchestrator base URL"]);
  settingsRows.push(["ProcessTimeout", "30", "Max process timeout in minutes"]);
  settingsRows.push(["MaxRetries", "3", "Maximum retry attempts"]);
  settingsRows.push(["LogLevel", "Info", "Logging level (Info/Warn/Error)"]);

  const hasQueues = orchestratorArtifacts?.queues?.length > 0;
  if (hasQueues) {
    settingsRows.push(["OrchestratorQueueName", orchestratorArtifacts.queues[0].name, "Primary transaction queue"]);
    settingsRows.push(["MaxRetryNumber", "3", "REFramework max retry attempts per transaction"]);
    settingsRows.push(["ProcessName", projectName || "Automation", "REFramework process name"]);
  }

  constantsRows.push(["ApplicationName", projectName || "Automation", "Process name"]);
  constantsRows.push(["Version", "1.0.0", "Package version"]);
  constantsRows.push(["MaxWaitTime", "30000", "Max wait time in milliseconds"]);
  constantsRows.push(["RetryInterval", "5000", "Retry interval in milliseconds"]);

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Settings" sheetId="1" r:id="rId1"/>
    <sheet name="Constants" sheetId="2" r:id="rId2"/>
  </sheets>
  <definedNames/>
</workbook>
<!-- CONFIG DATA (Tab-separated for import into Excel) -->
<!-- Settings Sheet -->
`;

  for (const row of settingsRows) {
    xml += `<!-- ${row.join("\t")} -->\n`;
  }
  xml += `<!-- Constants Sheet -->\n`;
  for (const row of constantsRows) {
    xml += `<!-- ${row.join("\t")} -->\n`;
  }

  let csvSettings = settingsRows.map(r => r.join(",")).join("\n");
  let csvConstants = constantsRows.map(r => r.join(",")).join("\n");

  return `Settings\n${csvSettings}\n\nConstants\n${csvConstants}`;
}

import type {
  PipelineOutcomeReport,
  RemediationEntry,
  AutoRepairEntry,
  RemediationCode,
  RepairCode,
  StructuralPreservationMetrics,
  PerWorkflowStudioCompatibility,
  StudioCompatibilityLevel,
} from "./uipath-pipeline";

export type BuildResult = {
  buffer: Buffer;
  gaps: XamlGap[];
  usedPackages: string[];
  cacheHit?: boolean;
  qualityGateResult?: QualityGateResult;
  xamlEntries: { name: string; content: string }[];
  dependencyMap: Record<string, string>;
  archiveManifest: string[];
  usedFallbackStubs: boolean;
  generationMode: GenerationMode;
  referencedMLSkillNames: string[];
  dependencyWarnings?: Array<{ code: string; message: string; stage: string; recoverable: boolean; affectedFiles?: string[] }>;
  usedAIFallback: boolean;
  outcomeReport?: PipelineOutcomeReport;
  projectJsonContent?: string;
};

export function fixMixedLiteralExpressionSyntax(content: string): { content: string; fixes: string[] } {
  const fixes: string[] = [];
  const attrPattern = /((?:Message|Default|Value)=")([^"]+)(")/g;

  const result = content.replace(attrPattern, (match, prefix, val, suffix) => {
    if (!val.includes("[") || !val.includes("]")) return match;
    if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.substring(1, val.length - 1);
      let innerDepth = 0;
      let isFullyBracketed = true;
      for (let ci = 0; ci < inner.length; ci++) {
        if (inner[ci] === "[") innerDepth++;
        else if (inner[ci] === "]") {
          if (innerDepth === 0) { isFullyBracketed = false; break; }
          innerDepth--;
        }
      }
      if (isFullyBracketed) return match;
    }

    const hasLiteralBeforeBracket = /^[^[&\d]/.test(val) &&
      !val.startsWith("True") && !val.startsWith("False") &&
      !val.startsWith("Nothing") && !val.startsWith("PLACEHOLDER");
    const hasLiteralAfterBracket = val.startsWith("[") && !val.endsWith("]");
    const hasBracketThenLiteralThenBracket = val.startsWith("[") && val.endsWith("]") && !hasLiteralBeforeBracket;
    if (!hasLiteralBeforeBracket && !hasLiteralAfterBracket && !hasBracketThenLiteralThenBracket) return match;

    const bracketSegments: { start: number; end: number; content: string }[] = [];
    let depth = 0;
    let segStart = -1;
    for (let i = 0; i < val.length; i++) {
      if (val[i] === "[") {
        if (depth === 0) segStart = i;
        depth++;
      } else if (val[i] === "]") {
        depth--;
        if (depth === 0 && segStart >= 0) {
          bracketSegments.push({ start: segStart, end: i, content: val.substring(segStart + 1, i) });
          segStart = -1;
        } else if (depth < 0) {
          return match;
        }
      }
    }
    if (depth !== 0) return match;
    if (bracketSegments.length === 0) return match;

    const vbExpressionPattern = /^[a-zA-Z_]\w*(\.\w+)*(\(.*\))?(\.\w+(\(.*\))?)*$/;
    for (const seg of bracketSegments) {
      if (seg.content.length === 0) return match;
      const decoded = seg.content.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const trimmed = decoded.trim();
      if (!vbExpressionPattern.test(trimmed)) return match;
      const looksLikeVbExpression = trimmed.includes("_") || trimmed.includes(".") || trimmed.includes("(");
      if (!looksLikeVbExpression) return match;
    }

    const vbOperatorPattern = /[+\-*/%=<>^\\]/;
    const parts: string[] = [];
    let lastIdx = 0;
    for (const seg of bracketSegments) {
      if (seg.start > lastIdx) {
        const literal = val.substring(lastIdx, seg.start);
        if (literal.includes("&quot;") || literal.includes("&amp;")) return match;
        if (vbOperatorPattern.test(literal.trim())) return match;
        parts.push(`&quot;${literal}&quot;`);
      }
      parts.push(seg.content);
      lastIdx = seg.end + 1;
    }
    if (lastIdx < val.length) {
      const literal = val.substring(lastIdx);
      if (literal.includes("&quot;") || literal.includes("&amp;")) return match;
      if (vbOperatorPattern.test(literal.trim())) return match;
      parts.push(`&quot;${literal}&quot;`);
    }

    const corrected = `[${parts.join(" &amp; ")}]`;
    fixes.push(`${val} → ${corrected}`);
    return prefix + corrected + suffix;
  });

  return { content: result, fixes };
}

export function removeDuplicateAttributes(content: string): { content: string; changed: boolean; fixedTags: string[] } {
  const fixedTags: string[] = [];
  const result = content.replace(/<([a-zA-Z_][\w.:]*)\s([^>]*?)(\s*\/?>)/g, (match, tag, attrStr, closing) => {
    const seen = new Set<string>();
    let hasDuplicates = false;
    const cleaned = attrStr.replace(/([a-zA-Z_][\w.:]*)\s*=\s*"[^"]*"/g, (attrMatch: string, attrName: string) => {
      if (seen.has(attrName)) {
        hasDuplicates = true;
        return "";
      }
      seen.add(attrName);
      return attrMatch;
    });
    if (hasDuplicates) {
      fixedTags.push(tag);
      return `<${tag} ${cleaned.replace(/\s{2,}/g, " ").trim()}${closing}`;
    }
    return match;
  });
  return { content: result, changed: fixedTags.length > 0, fixedTags };
}

function extractVariablesFromSDD(sddContent: string): Array<{ name: string; type: string; default?: string }> {
  const vars: Array<{ name: string; type: string; default?: string }> = [];
  const seen = new Set<string>();

  const queueMatch = sddContent.match(/queue[:\s]+["']?([A-Za-z_]\w*)["']?/i);
  if (queueMatch && !seen.has("str_QueueName")) {
    vars.push({ name: "str_QueueName", type: "String", default: `"${queueMatch[1]}"` });
    seen.add("str_QueueName");
  }

  const assetRegex = /asset[:\s]+["']?([A-Za-z_]\w*)["']?/gi;
  let assetMatch;
  while ((assetMatch = assetRegex.exec(sddContent)) !== null) {
    const varName = `str_Asset_${assetMatch[1]}`;
    if (!seen.has(varName)) {
      vars.push({ name: varName, type: "String", default: `"${assetMatch[1]}"` });
      seen.add(varName);
    }
  }

  const configMatch = sddContent.match(/config\s*(?:file|path|sheet)[:\s]+["']?([^\s"']+)["']?/i);
  if (configMatch && !seen.has("str_ConfigPath")) {
    vars.push({ name: "str_ConfigPath", type: "String", default: `"${configMatch[1]}"` });
    seen.add("str_ConfigPath");
  }

  const urlRegex = /(?:url|endpoint)[:\s]+["']?(https?:\/\/[^\s"']+)["']?/gi;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(sddContent)) !== null) {
    const varName = `str_URL`;
    if (!seen.has(varName)) {
      vars.push({ name: varName, type: "String", default: `"${urlMatch[1]}"` });
      seen.add(varName);
    }
  }

  return vars;
}

function selectSystemActivity(system: string, description: string): { template: string; displayName: string; properties: Record<string, string> } | null {
  const sysLower = (system || "").toLowerCase();
  const descLower = (description || "").toLowerCase();
  const makeBindPoint = (displayName: string, message: string) => ({
    template: "LogMessage",
    displayName,
    properties: { Level: "Info", Message: `"${message.replace(/"/g, '""')}"` },
  });

  if (sysLower.includes("google calendar")) {
    return makeBindPoint(`Calendar Reader Bind Point - ${system}`, `Bind Google Calendar connector for ${system}`);
  }
  if (sysLower.includes("google contacts")) {
    return makeBindPoint(`Contact Resolver Bind Point - ${system}`, `Bind Google Contacts lookup for ${system}`);
  }
  if (sysLower.includes("orchestrator queue")) {
    return makeBindPoint(`Queue Activity Bind Point - ${system}`, `Implement Orchestrator queue interaction for ${system}`);
  }
  if (sysLower.includes("genai")) {
    return makeBindPoint(`GenAI Bind Point - ${system}`, `Bind UiPath GenAI activity for ${system}`);
  }
  if (sysLower.includes("action center")) {
    return makeBindPoint(`Action Center Bind Point - ${system}`, `Bind Action Center task creation for ${system}`);
  }
  if (sysLower.includes("data service")) {
    return makeBindPoint(`Data Service Bind Point - ${system}`, `Bind Data Service entity write for ${system}`);
  }
  if (sysLower.includes("gmail")) {
    return makeBindPoint(`Gmail Delivery Bind Point - ${system}`, `Bind Gmail delivery for ${system}`);
  }
  if (
    sysLower.includes("api") ||
    sysLower.includes("rest") ||
    sysLower.includes("web service") ||
    sysLower.includes("webhook") ||
    descLower.includes("api call") ||
    descLower.includes("http request")
  ) {
    return makeBindPoint(`HTTP Bind Point - ${system}`, `Bind HTTP or webhook call for ${system}`);
  }
  if (sysLower.includes("excel") || sysLower.includes("spreadsheet")) {
    return { template: "ExcelApplicationScope", displayName: `Open Excel - ${system}`, properties: { WorkbookPath: '"C:\\Data\\Workbook.xlsx"' } };
  }
  if (sysLower.includes("email") || sysLower.includes("outlook") || sysLower.includes("mail")) {
    return makeBindPoint(`Outbound Communication Bind Point - ${system}`, `Bind outbound email or notification step for ${system}`);
  }
  if (sysLower.includes("sap")) {
    return { template: "TypeInto", displayName: `Type Into SAP - ${system}`, properties: { Text: '""', Target: '{ "type": "selector", "value": "<wnd app=\'saplogon.exe\' />" }' } };
  }
  if (sysLower.includes("browser") || sysLower.includes("web") || sysLower.includes("chrome") || sysLower.includes("portal") || sysLower.includes("website")) {
    return makeBindPoint(`Browser Automation Bind Point - ${system}`, `Bind browser-based lookup or navigation for ${system}`);
  }
  if (sysLower.includes("database") || sysLower.includes("sql") || sysLower.includes("db")) {
    return { template: "ExecuteQuery", displayName: `Query Database - ${system}`, properties: { Sql: '"SELECT * FROM table"', ConnectionString: '""' } };
  }
  if (descLower.includes("click") || descLower.includes("type") || descLower.includes("enter") || descLower.includes("input") || descLower.includes("fill")) {
    return { template: "TypeInto", displayName: `Type Into - ${system}`, properties: { Text: '""' } };
  }
  if (descLower.includes("download") || descLower.includes("save file") || descLower.includes("export")) {
    return { template: "MoveFile", displayName: `Save File - ${system}`, properties: { Path: '""', Destination: '""' } };
  }
  return null;
}

function buildDeterministicScaffold(
  processNodes: any[],
  projectName: string,
  sddContent?: string,
  processEdges?: any[],
): { treeEnrichment: TreeEnrichmentResult; usedAIFallback: boolean } {
  const actionNodes = processNodes.filter((n: any) => n.nodeType !== "start" && n.nodeType !== "end");
  const children: TreeWorkflowSpec["rootSequence"]["children"] = [];
  const variables: Array<{ name: string; type: string; default?: string }> = [];
  const decomposition: Array<{ name: string; nodeIds: number[]; description?: string; isDispatcher?: boolean; isPerformer?: boolean }> = [];

  variables.push({ name: "str_Status", type: "String", default: '"Success"' });
  variables.push({ name: "int_RetryCount", type: "Int32", default: "0" });
  variables.push({ name: "bool_ProcessComplete", type: "Boolean", default: "False" });

  if (sddContent) {
    const sddVars = extractVariablesFromSDD(sddContent);
    for (const v of sddVars) {
      if (!variables.find(ev => ev.name === v.name)) {
        variables.push(v);
      }
    }
  }

  const edges = processEdges || [];
  const edgeMap = new Map<number, Array<{ targetNodeId: number; label: string }>>();
  for (const edge of edges) {
    const sourceId = edge.sourceNodeId;
    if (!edgeMap.has(sourceId)) edgeMap.set(sourceId, []);
    edgeMap.get(sourceId)!.push({ targetNodeId: edge.targetNodeId, label: edge.label || "" });
  }

  const nodeMap = new Map<number, any>();
  for (const node of processNodes) {
    nodeMap.set(node.id, node);
  }

  children.push({
    kind: "activity" as const,
    template: "LogMessage",
    displayName: "Log Process Start",
    properties: { Level: "Info", Message: `"Starting ${projectName} process"` },
    outputVar: null,
    outputType: null,
    errorHandling: "none" as const,
  });

  const namedDecomposition = new Map<string, number[]>();

  let todoCount = 0;
  const complexNodeThreshold = 5;
  for (const node of actionNodes) {
    const outEdges = edgeMap.get(node.id) || [];
    const labeledEdges = outEdges.filter(e => e.label && e.label.trim().length > 0);

    if (node.nodeType === "decision") {
      const yesEdge = labeledEdges.find(e => /yes|true|approve|success|valid/i.test(e.label));
      const noEdge = labeledEdges.find(e => /no|false|reject|fail|invalid/i.test(e.label));
      const conditionHint = node.description || node.name;

      const thenTarget = yesEdge ? nodeMap.get(yesEdge.targetNodeId) : null;
      const elseTarget = noEdge ? nodeMap.get(noEdge.targetNodeId) : null;

      const thenChildren: any[] = [{
        kind: "activity" as const,
        template: "LogMessage",
        displayName: `Log: ${yesEdge?.label || "Yes"} path`,
        properties: { Level: "Info", Message: `"Decision '${node.name}' — taking ${yesEdge?.label || "Yes"} path${thenTarget ? " → " + thenTarget.name : ""}"` },
        outputVar: null,
        outputType: null,
        errorHandling: "none" as const,
      }];

      const elseChildren: any[] = [{
        kind: "activity" as const,
        template: "LogMessage",
        displayName: `Log: ${noEdge?.label || "No"} path`,
        properties: { Level: "Info", Message: `"Decision '${node.name}' — taking ${noEdge?.label || "No"} path${elseTarget ? " → " + elseTarget.name : ""}"` },
        outputVar: null,
        outputType: null,
        errorHandling: "none" as const,
      }];

      children.push({
        kind: "activity" as const,
        template: "Comment",
        displayName: `Review Decision Condition for ${node.name}`,
        properties: { Text: `Replace the deterministic [True] decision with the real business condition for: ${conditionHint}` },
        outputVar: null,
        outputType: null,
        errorHandling: "none" as const,
      });

      children.push({
        kind: "if" as const,
        displayName: `Decision: ${node.name}`,
        condition: "True",
        thenChildren,
        elseChildren,
      });
      continue;
    }

    const isLoopPattern = /loop|iterate|for each|repeat|batch|process all|process each/i.test(
      `${node.name} ${node.description || ""}`
    );

    if (isLoopPattern) {
      const collectionVar = `col_${node.name.replace(/\s+/g, "_")}`;
      if (!variables.find(v => v.name === collectionVar)) {
        variables.push({ name: collectionVar, type: "String[]", default: "New String(){}" });
      }

      const bodyChildren: any[] = [{
        kind: "activity" as const,
        template: "LogMessage",
        displayName: `Log: Processing item in ${node.name}`,
        properties: { Level: "Info", Message: `"Processing item in ${node.name}: " & item.ToString()` },
        outputVar: null,
        outputType: null,
        errorHandling: "none" as const,
      }];

      const sysActivity = selectSystemActivity(node.system || "", node.description || "");
      if (sysActivity) {
        bodyChildren.push({
          kind: "activity" as const,
          template: sysActivity.template,
          displayName: sysActivity.displayName,
          properties: sysActivity.properties,
          outputVar: null,
          outputType: null,
          errorHandling: "none" as const,
        });
      }

      children.push({
        kind: "forEach" as const,
        displayName: `ForEach: ${node.name}`,
        itemType: "x:String",
        valuesExpression: collectionVar,
        iteratorName: "item",
        bodyChildren,
      });
      continue;
    }

    const sysActivity = selectSystemActivity(node.system || "", node.description || "");

    if (sysActivity) {
      const nodeChildren: any[] = [
        {
          kind: "activity" as const,
          template: "LogMessage",
          displayName: `Log: ${node.name}`,
          properties: { Level: "Info", Message: `"Executing step: ${node.name}"` },
          outputVar: null,
          outputType: null,
          errorHandling: "none" as const,
        },
        {
          kind: "activity" as const,
          template: sysActivity.template,
          displayName: sysActivity.displayName,
          properties: sysActivity.properties,
          outputVar: null,
          outputType: null,
          errorHandling: "none" as const,
        },
      ];

      children.push({
        kind: "tryCatch" as const,
        displayName: `TryCatch: ${node.name}`,
        tryChildren: nodeChildren,
        catchChildren: [
          {
            kind: "activity" as const,
            template: "LogMessage",
            displayName: `Log Error: ${node.name}`,
            properties: { Level: "Error", Message: `"Error in step ${node.name}: " & exception.Message` },
            outputVar: null,
            outputType: null,
            errorHandling: "none" as const,
          },
          {
            kind: "activity" as const,
            template: "Assign",
            displayName: "Set Status to Failed",
            properties: { To: "str_Status", Value: '"Failed"' },
            outputVar: null,
            outputType: null,
            errorHandling: "none" as const,
          },
        ],
        finallyChildren: [],
      });

      if (actionNodes.length > complexNodeThreshold) {
        const role = classifyDeterministicWorkflowRole(node);
        const suggestedName = deterministicWorkflowNameForRole(role, node, 1);
        const existing = namedDecomposition.get(suggestedName) || [];
        existing.push(node.id);
        namedDecomposition.set(suggestedName, existing);
      }
      continue;
    }

    todoCount++;
    const stepDesc = `TODO: Implement ${node.name}${node.description ? " - " + node.description : ""}${node.system ? " (System: " + node.system + ")" : ""}`;
    children.push({
      kind: "activity" as const,
      template: "Comment",
      displayName: `Step: ${node.name}`,
      properties: { Text: stepDesc.replace(/^TODO:\s*/i, "Review: ") },
      outputVar: null,
      outputType: null,
      errorHandling: "none" as const,
    });
    children.push({
      kind: "activity" as const,
      template: "LogMessage",
      displayName: `Log: ${node.name}`,
      properties: { Level: "Info", Message: `"Executing step: ${node.name}"` },
      outputVar: null,
      outputType: null,
      errorHandling: "none" as const,
    });
  }

  for (const [name, nodeIds] of namedDecomposition.entries()) {
    decomposition.push({
      name,
      nodeIds,
      description: `Deterministic bind-point workflow for ${name}`,
      isDispatcher: name === "Dispatcher" || undefined,
      isPerformer: name === "Performer" || undefined,
    });
  }

  children.push({
    kind: "activity" as const,
    template: "LogMessage",
    displayName: "Log Process Complete",
    properties: { Level: "Info", Message: `"${projectName} process completed with status: " & str_Status` },
    outputVar: null,
    outputType: null,
    errorHandling: "none" as const,
  });

  const dhgNotes = ["This workflow was generated as a deterministic scaffold because AI enrichment was unavailable"];
  if (sddContent) {
    dhgNotes.push("SDD context was available but could not be processed by AI — review SDD for implementation details");
  }
  if (todoCount > 0) {
    dhgNotes.push(`${todoCount} of ${actionNodes.length} nodes could not be mapped to specific activities — search for TODO comments`);
  } else {
    dhgNotes.push(`All ${actionNodes.length} action nodes were mapped to system-specific activities or control flow structures`);
  }

  const spec: TreeWorkflowSpec = {
    name: projectName,
    description: `Deterministic scaffold for ${projectName}`,
    variables,
    arguments: [],
    rootSequence: {
      kind: "sequence" as const,
      displayName: `${projectName} - Main Sequence`,
      children,
    },
    useReFramework: false,
    dhgNotes,
    decomposition,
  };

  console.log(`[UiPath] Built deterministic scaffold for "${projectName}": ${actionNodes.length} action nodes → ${children.length} tree nodes, ${todoCount} TODO stubs, ${variables.length} variables, ${decomposition.length} sub-workflows`);

  return {
    treeEnrichment: { status: "success", workflowSpec: spec, processType: "general" as ProcessType },
    usedAIFallback: true,
  };
}

function makeDeterministicActivity(
  template: string,
  displayName: string,
  properties: Record<string, string> = {},
): TreeWorkflowNode {
  return {
    kind: "activity",
    template,
    displayName,
    properties,
    outputVar: null,
    outputType: null,
    errorHandling: "none",
  };
}

function makeDeterministicInvoke(
  workflowName: string,
  displayName: string,
  argumentsMap: Record<string, string> = {},
): TreeWorkflowNode {
  return makeDeterministicActivity("InvokeWorkflowFile", displayName, {
    WorkflowFileName: `${workflowName}.xaml`,
    ...argumentsMap,
  });
}

type DeterministicWorkflowRole =
  | "intake_dispatcher"
  | "entity_resolution"
  | "document_extraction"
  | "validation_matching"
  | "communication_drafting"
  | "review_exception"
  | "outbound_communication"
  | "approval_routing"
  | "persistence_audit"
  | "generic_step_group";

type DeterministicWorkflowContext = {
  projectName: string;
  domainLabel: string;
  primaryEntityLabel: string;
  queueName: string;
};

function slugifyDeterministicSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

function titleCaseDeterministic(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function inferPrimaryEntityLabel(projectName: string, processNodes: any[], sddContent?: string): string {
  const corpus = `${projectName} ${sddContent || ""} ${processNodes.map(node => `${node.name || ""} ${node.description || ""}`).join(" ")}`.toLowerCase();
  if (/\binvoice\b/.test(corpus)) return "Invoice";
  if (/\b(po|purchase order)\b/.test(corpus)) return "PurchaseOrder";
  if (/\bbirthday\b/.test(corpus) || /\brecipient\b/.test(corpus) || /\bcontact\b/.test(corpus)) return "Recipient";
  if (/\bclaim\b/.test(corpus)) return "Claim";
  if (/\bemployee\b/.test(corpus)) return "Employee";
  return "WorkItem";
}

function inferDomainLabel(projectName: string, processNodes: any[], sddContent?: string): string {
  const corpus = `${projectName} ${sddContent || ""} ${processNodes.map(node => `${node.name || ""} ${node.system || ""}`).join(" ")}`.toLowerCase();
  if (/\bbirthday\b/.test(corpus)) return "birthday greetings";
  if (/\binvoice\b/.test(corpus) || /\bcoupa\b/.test(corpus)) return "invoice processing";
  if (/\bclaim\b/.test(corpus)) return "claims processing";
  if (/\bonboarding\b/.test(corpus)) return "employee onboarding";
  return projectName.replace(/_/g, " ");
}

function buildDeterministicContext(
  projectName: string,
  processNodes: any[],
  orchestratorArtifacts?: any,
  sddContent?: string,
): DeterministicWorkflowContext {
  return {
    projectName,
    domainLabel: inferDomainLabel(projectName, processNodes, sddContent),
    primaryEntityLabel: inferPrimaryEntityLabel(projectName, processNodes, sddContent),
    queueName: orchestratorArtifacts?.queues?.[0]?.name || `${projectName}_Queue`,
  };
}

function classifyDeterministicWorkflowRole(node: any): DeterministicWorkflowRole {
  const text = `${node.name || ""} ${node.description || ""} ${node.system || ""}`.toLowerCase();
  if (/(trigger|ingest|dispatcher|queue|calendar|fetch|create work item|build .*worklist)/.test(text)) return "intake_dispatcher";
  if (/(audit|persist|data service|history|summary|mark .*progressed)/.test(text)) return "persistence_audit";
  if (/(review|action center|correct|exception|triage)/.test(text)) return "review_exception";
  if (/(validate|match|tolerance|reconcile|compare|confidence sufficient)/.test(text)) return "validation_matching";
  if (/(extract|document understanding|ocr|classif)/.test(text)) return "document_extraction";
  if (/(contact|lookup|resolve|recipient|directory|preferred email)/.test(text)) return "entity_resolution";
  if (/(send|notify|email|gmail|mail|post supplier)/.test(text)) return "outbound_communication";
  if (/(compose|generate|draft|message subject|message body|supplier message)/.test(text)) return "communication_drafting";
  if (/(approve|approval|route .*approval|rejected|reject invoice|doa)/.test(text)) return "approval_routing";
  return "generic_step_group";
}

function deterministicWorkflowNameForRole(role: DeterministicWorkflowRole, firstNode: any, sequence: number): string {
  const roleNames: Record<DeterministicWorkflowRole, string> = {
    intake_dispatcher: "IntakeDispatcher",
    entity_resolution: "EntityResolution",
    document_extraction: "DocumentExtraction",
    validation_matching: "ValidationMatching",
    communication_drafting: "CommunicationDrafting",
    review_exception: "ReviewAndExceptionHandling",
    outbound_communication: "OutboundCommunication",
    approval_routing: "ApprovalRouting",
    persistence_audit: "AuditAndPersistence",
    generic_step_group: `${titleCaseDeterministic(firstNode?.name || `StepGroup${sequence}`)}Workflow`,
  };
  const base = slugifyDeterministicSegment(roleNames[role] || `Workflow${sequence}`);
  return sequence > 1 && role !== "generic_step_group" ? `${base}${sequence}` : base;
}

function buildDeterministicRoleSummary(role: DeterministicWorkflowRole, context: DeterministicWorkflowContext): string {
  const summaryByRole: Record<DeterministicWorkflowRole, string> = {
    intake_dispatcher: `Prepare ${context.primaryEntityLabel.toLowerCase()} intake and queue handoff for ${context.domainLabel}`,
    entity_resolution: `Resolve ${context.primaryEntityLabel.toLowerCase()} reference data and routing inputs`,
    document_extraction: `Extract structured data needed for ${context.primaryEntityLabel.toLowerCase()} processing`,
    validation_matching: `Validate ${context.primaryEntityLabel.toLowerCase()} data against documented business rules`,
    communication_drafting: `Draft communication payloads required by the process`,
    review_exception: `Handle review, correction, and exception paths`,
    outbound_communication: `Execute outbound communication or notification bind points`,
    approval_routing: `Route the ${context.primaryEntityLabel.toLowerCase()} through approval and disposition steps`,
    persistence_audit: `Persist audit and outcome records`,
    generic_step_group: `Execute grouped process steps for ${context.domainLabel}`,
  };
  return summaryByRole[role];
}

function buildDeterministicStatusLiteral(role: DeterministicWorkflowRole): string {
  const statusByRole: Record<DeterministicWorkflowRole, string> = {
    intake_dispatcher: "Dispatched",
    entity_resolution: "Resolved",
    document_extraction: "Extracted",
    validation_matching: "Validated",
    communication_drafting: "Drafted",
    review_exception: "Reviewed",
    outbound_communication: "PreparedForDelivery",
    approval_routing: "ApprovalCompleted",
    persistence_audit: "AuditPrepared",
    generic_step_group: "Completed",
  };
  return statusByRole[role];
}

function buildContextSeedJson(context: DeterministicWorkflowContext, role: DeterministicWorkflowRole): string {
  return `"{""EntityType"":""${context.primaryEntityLabel}"",""WorkflowRole"":""${role}"",""QueueName"":""${context.queueName}"",""Domain"":""${context.domainLabel.replace(/"/g, '""')}""}"`;
}

function buildGenericDeterministicSubWorkflowSpec(
  childWorkflowName: string,
  projectName: string,
  childNodes: any[],
  context: DeterministicWorkflowContext,
): TreeWorkflowSpec | null {
  if (!childNodes.length) return null;
  const normalized = childWorkflowName.replace(/\s+/g, "_");
  const role = classifyDeterministicWorkflowRole(childNodes[0]);
  const argumentsList: Array<{ name: string; direction: string; type: string }> = [
    { name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" },
    { name: "in_ContextJson", direction: "InArgument", type: "x:String" },
    { name: "out_ContextJson", direction: "OutArgument", type: "x:String" },
    { name: "out_WorkflowStatus", direction: "OutArgument", type: "x:String" },
  ];
  if (role === "intake_dispatcher") argumentsList.push({ name: "out_ItemCount", direction: "OutArgument", type: "x:Int32" });
  if (role === "review_exception") argumentsList.push({ name: "in_RequiresReview", direction: "InArgument", type: "x:Boolean" });

  const children: TreeWorkflowNode[] = [
    makeDeterministicActivity("LogMessage", `Start ${normalized}`, { Level: "Info", Message: `Starting ${normalized}` }),
    makeDeterministicActivity("LogMessage", "Workflow Purpose", { Level: "Info", Message: buildDeterministicRoleSummary(role, context) }),
  ];

  for (const node of childNodes) {
    children.push(makeDeterministicActivity("LogMessage", `Step: ${node.name}`, {
      Level: "Info",
      Message: `["Execute step: ${String(node.description || node.name || "process step").replace(/"/g, '""')}"]`,
    }));
    const systemActivity = selectSystemActivity(node.system || "", node.description || "");
    if (systemActivity) {
      children.push({
        kind: "activity",
        template: systemActivity.template,
        displayName: systemActivity.displayName,
        properties: systemActivity.properties,
        outputVar: null,
        outputType: null,
        errorHandling: "none",
      });
    }
  }

  if (role === "review_exception") {
    children.push({
      kind: "if",
      displayName: "Decision: Review Required",
      condition: "[in_RequiresReview]",
      thenChildren: [
        makeDeterministicActivity("Assign", "Set Workflow Status", { To: "out_WorkflowStatus", Value: "ReviewRequired" }),
        makeDeterministicActivity("Assign", "Pass Through Context", { To: "out_ContextJson", Value: "[in_ContextJson]" }),
      ],
      elseChildren: [
        makeDeterministicActivity("Assign", "Set Workflow Status", { To: "out_WorkflowStatus", Value: buildDeterministicStatusLiteral(role) }),
        makeDeterministicActivity("Assign", "Pass Through Context", { To: "out_ContextJson", Value: "[in_ContextJson]" }),
      ],
    });
  } else {
    children.push(makeDeterministicActivity("Assign", "Seed Output Context", { To: "out_ContextJson", Value: buildContextSeedJson(context, role) }));
    children.push(makeDeterministicActivity("Assign", "Set Workflow Status", { To: "out_WorkflowStatus", Value: buildDeterministicStatusLiteral(role) }));
  }
  if (role === "intake_dispatcher") {
    children.push(makeDeterministicActivity("Assign", "Set Item Count", { To: "out_ItemCount", Value: "1" }));
  }
  children.push(makeDeterministicActivity("LogMessage", `Complete ${normalized}`, { Level: "Info", Message: `Completed ${normalized}` }));

  return {
    name: normalized,
    description: `${titleCaseDeterministic(normalized)} deterministic workflow for ${projectName}`,
    variables: [],
    arguments: argumentsList as any,
    rootSequence: {
      kind: "sequence",
      displayName: `${normalized} - Sequence`,
      children,
    },
    useReFramework: false,
    dhgNotes: [
      `Deterministic ${role.replace(/_/g, " ")} workflow derived from documented process steps`,
      "Replace bind-point logging and placeholders with tenant-specific connector activities while preserving the workflow contract",
    ],
    decomposition: [],
  };
}

function buildGenericDeterministicMainWorkflowSpec(
  projectName: string,
  decompositionWorkflowNames: string[],
  workflowRoleMap: Map<string, DeterministicWorkflowRole>,
): TreeWorkflowSpec {
  const variables = [
    { name: "dict_Config", type: "Dictionary<String, Object>", default: "[New Dictionary(Of String, Object)]" },
    { name: "str_ProcessContextJson", type: "String", default: '""' },
    { name: "str_ProcessStatus", type: "String", default: '"Pending"' },
    { name: "str_LastWorkflowStatus", type: "String", default: '"Pending"' },
    { name: "int_WorkItemCount", type: "Int32", default: "0" },
    { name: "bool_RequiresReview", type: "Boolean", default: "False" },
  ];
  const children: TreeWorkflowNode[] = [
    makeDeterministicActivity("LogMessage", "Log Process Start", { Level: "Info", Message: `Starting ${projectName} process` }),
    makeDeterministicInvoke("InitAllSettings", "Initialize All Settings", { out_Config: "[dict_Config]" }),
  ];
  const workflowOrder: DeterministicWorkflowRole[] = [
    "intake_dispatcher",
    "entity_resolution",
    "document_extraction",
    "validation_matching",
    "communication_drafting",
    "review_exception",
    "outbound_communication",
    "approval_routing",
    "persistence_audit",
    "generic_step_group",
  ];
  const sortedWorkflowNames = [...decompositionWorkflowNames].sort((left, right) => {
    const leftRole = workflowRoleMap.get(left) || "generic_step_group";
    const rightRole = workflowRoleMap.get(right) || "generic_step_group";
    return workflowOrder.indexOf(leftRole) - workflowOrder.indexOf(rightRole);
  });
  for (const workflowName of sortedWorkflowNames) {
    const role = workflowRoleMap.get(workflowName) || "generic_step_group";
    const args: Record<string, string> = {
      in_Config: "[dict_Config]",
      in_ContextJson: "[str_ProcessContextJson]",
      out_ContextJson: "[str_ProcessContextJson]",
      out_WorkflowStatus: "[str_LastWorkflowStatus]",
    };
    if (role === "intake_dispatcher") args.out_ItemCount = "[int_WorkItemCount]";
    if (role === "review_exception") args.in_RequiresReview = "[bool_RequiresReview]";
    children.push(makeDeterministicInvoke(workflowName, `Run ${titleCaseDeterministic(workflowName)}`, args));
  }
  children.push(makeDeterministicActivity("Assign", "Set Final Process Status", { To: "str_ProcessStatus", Value: "[str_LastWorkflowStatus]" }));
  children.push(makeDeterministicActivity("LogMessage", "Log Process Complete", {
    Level: "Info",
    Message: `["${projectName} process completed. WorkflowStatus=" & str_ProcessStatus & ", ItemCount=" & int_WorkItemCount.ToString()]`,
  }));
  return {
    name: "Main",
    description: `Deterministic orchestrator for ${projectName}`,
    variables,
    arguments: [],
    rootSequence: {
      kind: "sequence",
      displayName: "Main - Deterministic Sequence",
      children,
    },
    useReFramework: false,
    dhgNotes: [
      "Deterministic orchestrator generated from process-derived workflow contracts",
      "Replace bind-point activities inside sub-workflows with tenant-specific connectors while preserving the shared context contract",
    ],
    decomposition: [],
  };
}

function createDeterministicSubWorkflowSpec(
  childWorkflowName: string,
  projectName: string,
): TreeWorkflowSpec | null {
  const normalized = childWorkflowName.replace(/\s+/g, "_");
  switch (normalized) {
    case "Dispatcher":
      return {
        name: normalized,
        description: `Deterministic dispatcher for ${projectName}`,
        variables: [],
        arguments: [
          { name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" },
          { name: "out_RecipientCount", direction: "OutArgument", type: "x:Int32" },
          { name: "out_WorkItemsJson", direction: "OutArgument", type: "x:String" },
        ],
        rootSequence: {
          kind: "sequence",
          displayName: `${normalized} - Sequence`,
          children: [
            makeDeterministicActivity("LogMessage", "Start Dispatcher", { Level: "Info", Message: "Starting Dispatcher" }),
            makeDeterministicActivity("LogMessage", "Load Birthday Calendar Events", { Level: "Info", Message: "Deterministic fallback reading todays birthday events from configured calendar bind point" }),
            makeDeterministicActivity("Assign", "Set Recipient Count", { To: "out_RecipientCount", Value: "1" }),
            makeDeterministicActivity("Assign", "Set Work Item Payload", {
              To: "out_WorkItemsJson",
              Value: `"{""FullName"":""Sample Birthday Person"",""BirthDate"":""2026-03-31"",""CalendarSource"":""Birthdays""}"`,
            }),
            makeDeterministicActivity("LogMessage", "Queue Bind Point", { Level: "Info", Message: "Bind Orchestrator queue creation using BirthdayGreetingsV9_Queue and the generated work item payload" }),
            makeDeterministicActivity("LogMessage", "Complete Dispatcher", { Level: "Info", Message: "Completed Dispatcher" }),
          ],
        },
        useReFramework: false,
        dhgNotes: [
          "Deterministic dispatcher fallback generated from process documentation",
          "Replace bind-point logging with Google Calendar read and Add Queue Item activities for final implementation",
        ],
        decomposition: [],
      };
    case "ContactResolver":
      return {
        name: normalized,
        description: `Deterministic contact resolution for ${projectName}`,
        variables: [],
        arguments: [
          { name: "in_WorkItemsJson", direction: "InArgument", type: "x:String" },
          { name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" },
          { name: "out_FullName", direction: "OutArgument", type: "x:String" },
          { name: "out_PreferredEmail", direction: "OutArgument", type: "x:String" },
          { name: "out_ContactStatus", direction: "OutArgument", type: "x:String" },
        ],
        rootSequence: {
          kind: "sequence",
          displayName: `${normalized} - Sequence`,
          children: [
            makeDeterministicActivity("LogMessage", "Start Contact Resolver", { Level: "Info", Message: "Starting ContactResolver" }),
            makeDeterministicActivity("Assign", "Set Recipient Name", { To: "out_FullName", Value: "Sample Birthday Person" }),
            makeDeterministicActivity("Assign", "Set Preferred Email", { To: "out_PreferredEmail", Value: `["birthday.friend@contoso.com"]` }),
            makeDeterministicActivity("Assign", "Set Contact Status", { To: "out_ContactStatus", Value: "Resolved" }),
            makeDeterministicActivity("LogMessage", "Preferred Email Rule", { Level: "Info", Message: "Deterministic fallback applies the Personal greater than Home email preference rule" }),
            makeDeterministicActivity("LogMessage", "Contacts Bind Point", { Level: "Info", Message: "Bind Google Contacts lookup and replace deterministic recipient defaults" }),
            makeDeterministicActivity("LogMessage", "Complete Contact Resolver", { Level: "Info", Message: "Completed ContactResolver" }),
          ],
        },
        useReFramework: false,
        dhgNotes: [
          "Deterministic fallback resolves a safe sample contact contract",
          "Replace deterministic outputs with Google Contacts data retrieval and selection logic",
        ],
        decomposition: [],
      };
    case "MessageComposer":
      return {
        name: normalized,
        description: `Deterministic message composition for ${projectName}`,
        variables: [],
        arguments: [
          { name: "in_FullName", direction: "InArgument", type: "x:String" },
          { name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" },
          { name: "out_MessageSubject", direction: "OutArgument", type: "x:String" },
          { name: "out_MessageBody", direction: "OutArgument", type: "x:String" },
          { name: "out_RequiresReview", direction: "OutArgument", type: "x:Boolean" },
        ],
        rootSequence: {
          kind: "sequence",
          displayName: `${normalized} - Sequence`,
          children: [
            makeDeterministicActivity("LogMessage", "Start Message Composer", { Level: "Info", Message: "Starting MessageComposer" }),
            makeDeterministicActivity("Assign", "Set Message Subject", { To: "out_MessageSubject", Value: `["Happy Birthday, " & in_FullName & "!"]` }),
            makeDeterministicActivity("Assign", "Set Message Body", { To: "out_MessageBody", Value: `["Wishing you a wonderful birthday and a fantastic year ahead, " & in_FullName & "."]` }),
            makeDeterministicActivity("Assign", "Set Review Flag", { To: "out_RequiresReview", Value: "False" }),
            makeDeterministicActivity("LogMessage", "GenAI Bind Point", { Level: "Info", Message: "Bind UiPath GenAI message generation and keep the deterministic message as a safe fallback" }),
            makeDeterministicActivity("LogMessage", "Complete Message Composer", { Level: "Info", Message: "Completed MessageComposer" }),
          ],
        },
        useReFramework: false,
        dhgNotes: [
          "Deterministic fallback emits a complete subject/body contract",
          "Replace deterministic message text with tenant-approved GenAI generation if desired",
        ],
        decomposition: [],
      };
    case "ReviewHandler":
      return {
        name: normalized,
        description: `Deterministic review handling for ${projectName}`,
        variables: [],
        arguments: [
          { name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" },
          { name: "in_MessageSubject", direction: "InArgument", type: "x:String" },
          { name: "in_MessageBody", direction: "InArgument", type: "x:String" },
          { name: "in_RequiresReview", direction: "InArgument", type: "x:Boolean" },
          { name: "out_FinalMessageBody", direction: "OutArgument", type: "x:String" },
          { name: "out_ReviewStatus", direction: "OutArgument", type: "x:String" },
        ],
        rootSequence: {
          kind: "sequence",
          displayName: `${normalized} - Sequence`,
          children: [
            makeDeterministicActivity("LogMessage", "Start Review Handler", { Level: "Info", Message: "Starting ReviewHandler" }),
            {
              kind: "if",
              displayName: "Decision: Human Review Required",
              condition: "[in_RequiresReview]",
              thenChildren: [
                makeDeterministicActivity("Assign", "Mark Review Required", { To: "out_ReviewStatus", Value: "ReviewRequired" }),
                makeDeterministicActivity("Assign", "Carry Message Body Forward", { To: "out_FinalMessageBody", Value: "[in_MessageBody]" }),
                makeDeterministicActivity("LogMessage", "Action Center Bind Point", { Level: "Info", Message: "Bind Action Center review task creation when human review is enabled" }),
              ],
              elseChildren: [
                makeDeterministicActivity("Assign", "Mark Review Not Needed", { To: "out_ReviewStatus", Value: "NotRequired" }),
                makeDeterministicActivity("Assign", "Carry Message Body Forward", { To: "out_FinalMessageBody", Value: "[in_MessageBody]" }),
              ],
            },
            makeDeterministicActivity("LogMessage", "Complete Review Handler", { Level: "Info", Message: "Completed ReviewHandler" }),
          ],
        },
        useReFramework: false,
        dhgNotes: [
          "Deterministic fallback bypasses human review unless bind points are implemented",
        ],
        decomposition: [],
      };
    case "EmailSender":
      return {
        name: normalized,
        description: `Deterministic email sending for ${projectName}`,
        variables: [],
        arguments: [
          { name: "in_To", direction: "InArgument", type: "x:String" },
          { name: "in_Subject", direction: "InArgument", type: "x:String" },
          { name: "in_Body", direction: "InArgument", type: "x:String" },
          { name: "out_SendStatus", direction: "OutArgument", type: "x:String" },
        ],
        rootSequence: {
          kind: "sequence",
          displayName: `${normalized} - Sequence`,
          children: [
            makeDeterministicActivity("LogMessage", "Start Email Sender", { Level: "Info", Message: "Starting EmailSender" }),
            makeDeterministicActivity("LogMessage", "Gmail Bind Point", { Level: "Info", Message: `["Bind Gmail send using recipient " & in_To & " and keep the deterministic subject/body contract intact"]` }),
            makeDeterministicActivity("Assign", "Set Send Status", { To: "out_SendStatus", Value: "ReadyToSend" }),
            makeDeterministicActivity("LogMessage", "Complete Email Sender", { Level: "Info", Message: "Completed EmailSender" }),
          ],
        },
        useReFramework: false,
        dhgNotes: [
          "Deterministic fallback preserves the final email contract without sending mail automatically",
          "Replace bind-point logging with Gmail/Integration Service send activity",
        ],
        decomposition: [],
      };
    case "AuditPersistence":
      return {
        name: normalized,
        description: `Deterministic audit persistence for ${projectName}`,
        variables: [],
        arguments: [
          { name: "in_FullName", direction: "InArgument", type: "x:String" },
          { name: "in_PreferredEmail", direction: "InArgument", type: "x:String" },
          { name: "in_SendStatus", direction: "InArgument", type: "x:String" },
          { name: "in_ReviewStatus", direction: "InArgument", type: "x:String" },
          { name: "out_AuditStatus", direction: "OutArgument", type: "x:String" },
        ],
        rootSequence: {
          kind: "sequence",
          displayName: `${normalized} - Sequence`,
          children: [
            makeDeterministicActivity("LogMessage", "Start Audit Persistence", { Level: "Info", Message: "Starting AuditPersistence" }),
            makeDeterministicActivity("LogMessage", "Audit Summary", { Level: "Info", Message: `["Audit record prepared for " & in_FullName & " (" & in_PreferredEmail & ") with send status " & in_SendStatus]` }),
            makeDeterministicActivity("Assign", "Set Audit Status", { To: "out_AuditStatus", Value: "AuditPrepared" }),
            makeDeterministicActivity("LogMessage", "Data Service Bind Point", { Level: "Info", Message: "Bind Data Service persistence for BirthdayGreetingRun and BirthdayGreetingMessage entities" }),
            makeDeterministicActivity("LogMessage", "Complete Audit Persistence", { Level: "Info", Message: "Completed AuditPersistence" }),
          ],
        },
        useReFramework: false,
        dhgNotes: [
          "Deterministic fallback preserves audit payload semantics",
          "Replace bind-point logging with Data Service entity writes",
        ],
        decomposition: [],
      };
    default:
      return null;
  }
}

function createDeterministicMainWorkflowSpec(
  projectName: string,
  childWorkflowNames: string[],
): TreeWorkflowSpec {
  const variables = [
    { name: "dict_Config", type: "Dictionary<String, Object>", default: "[New Dictionary(Of String, Object)]" },
    { name: "int_RecipientCount", type: "Int32", default: "0" },
    { name: "str_WorkItemsJson", type: "String", default: '""' },
    { name: "str_FullName", type: "String", default: '""' },
    { name: "str_PreferredEmail", type: "String", default: '""' },
    { name: "str_ContactStatus", type: "String", default: '"Pending"' },
    { name: "str_MessageSubject", type: "String", default: '""' },
    { name: "str_MessageBody", type: "String", default: '""' },
    { name: "bool_RequiresReview", type: "Boolean", default: "False" },
    { name: "str_FinalMessageBody", type: "String", default: '""' },
    { name: "str_ReviewStatus", type: "String", default: '"NotRequired"' },
    { name: "str_SendStatus", type: "String", default: '"Pending"' },
    { name: "str_AuditStatus", type: "String", default: '"Pending"' },
  ];

  const children: TreeWorkflowNode[] = [
    makeDeterministicActivity("LogMessage", "Log Process Start", { Level: "Info", Message: `Starting ${projectName} process` }),
    makeDeterministicInvoke("InitAllSettings", "Initialize All Settings", {
      out_Config: "[dict_Config]",
    }),
  ];

  if (childWorkflowNames.includes("Dispatcher")) {
    children.push(makeDeterministicInvoke("Dispatcher", "Run Dispatcher", {
      in_Config: "[dict_Config]",
      out_RecipientCount: "[int_RecipientCount]",
      out_WorkItemsJson: "[str_WorkItemsJson]",
    }));
  }
  if (childWorkflowNames.includes("ContactResolver")) {
    children.push(makeDeterministicInvoke("ContactResolver", "Resolve Contact", {
      in_WorkItemsJson: "[str_WorkItemsJson]",
      in_Config: "[dict_Config]",
      out_FullName: "[str_FullName]",
      out_PreferredEmail: "[str_PreferredEmail]",
      out_ContactStatus: "[str_ContactStatus]",
    }));
  }
  const thenChildren: TreeWorkflowNode[] = [];
  if (childWorkflowNames.includes("MessageComposer")) {
    thenChildren.push(makeDeterministicInvoke("MessageComposer", "Compose Birthday Message", {
      in_FullName: "[str_FullName]",
      in_Config: "[dict_Config]",
      out_MessageSubject: "[str_MessageSubject]",
      out_MessageBody: "[str_MessageBody]",
      out_RequiresReview: "[bool_RequiresReview]",
    }));
  }
  if (childWorkflowNames.includes("ReviewHandler")) {
    thenChildren.push(makeDeterministicInvoke("ReviewHandler", "Review Message", {
      in_Config: "[dict_Config]",
      in_MessageSubject: "[str_MessageSubject]",
      in_MessageBody: "[str_MessageBody]",
      in_RequiresReview: "[bool_RequiresReview]",
      out_FinalMessageBody: "[str_FinalMessageBody]",
      out_ReviewStatus: "[str_ReviewStatus]",
    }));
  }
  if (childWorkflowNames.includes("EmailSender")) {
    thenChildren.push(makeDeterministicInvoke("EmailSender", "Send Birthday Email", {
      in_To: "[str_PreferredEmail]",
      in_Subject: "[str_MessageSubject]",
      in_Body: "[str_FinalMessageBody]",
      out_SendStatus: "[str_SendStatus]",
    }));
  }
  children.push({
    kind: "if",
    displayName: "Decision: Contact Resolved",
    condition: `[str_ContactStatus = "Resolved"]`,
    thenChildren,
    elseChildren: [
      makeDeterministicActivity("Assign", "Mark Missing Email Status", { To: "str_SendStatus", Value: "SkippedNoEmailFound" }),
      makeDeterministicActivity("Assign", "Mark Missing Review Status", { To: "str_ReviewStatus", Value: "NotNeeded" }),
      makeDeterministicActivity("LogMessage", "Skip Missing Email", { Level: "Warn", Message: "Skipping recipient because no Personal Home email was resolved" }),
    ],
  });
  if (childWorkflowNames.includes("AuditPersistence")) {
    children.push(makeDeterministicInvoke("AuditPersistence", "Persist Audit", {
      in_FullName: "[str_FullName]",
      in_PreferredEmail: "[str_PreferredEmail]",
      in_SendStatus: "[str_SendStatus]",
      in_ReviewStatus: "[str_ReviewStatus]",
      out_AuditStatus: "[str_AuditStatus]",
    }));
  }
  children.push(makeDeterministicActivity("LogMessage", "Log Process Complete", {
    Level: "Info",
    Message: `["${projectName} process completed. Recipients=" & int_RecipientCount.ToString() & ", SendStatus=" & str_SendStatus & ", AuditStatus=" & str_AuditStatus]`,
  }));

  return {
    name: "Main",
    description: `Deterministic orchestrator for ${projectName}`,
    variables,
    arguments: [],
    rootSequence: {
      kind: "sequence",
      displayName: "Main - Deterministic Sequence",
      children,
    },
    useReFramework: false,
    dhgNotes: [
      "Deterministic orchestrator generated from the documented process flow",
      "Replace bind-point activities inside sub-workflows with tenant-specific connectors while preserving the typed workflow contracts",
    ],
    decomposition: [],
  };
}

function buildDeterministicInitAllSettingsXaml(
  orchestratorArtifacts?: any,
  targetFramework?: TargetFramework,
  credentialStrategy?: string,
): string {
  const isCSharp = targetFramework === "Portable";
  const nsS = isCSharp ? "System.Runtime" : "mscorlib";
  const nsScg = isCSharp ? "System.Runtime" : "mscorlib";
  const assets = orchestratorArtifacts?.assets || [];
  const queues = orchestratorArtifacts?.queues || [];

  let assetActivities = `
    <!-- InitAllSettings.xaml - Auto-generated by CannonBall -->
    <!-- Deterministic baseline configuration initializer -->`;

  for (const asset of assets) {
    const dictKey = isCSharp ? `"${escapeXml(asset.name)}"` : `&quot;${escapeXml(asset.name)}&quot;`;
    const placeholderValue = asset.type === "Credential"
      ? "Credential bind point"
      : `Asset bind point: ${asset.name}`;
    assetActivities += `
    <ui:LogMessage Level="Info" Message="[&quot;Bind asset ${escapeXml(asset.name)} in Orchestrator and replace the deterministic placeholder value&quot;]" DisplayName="Asset Bind Point ${escapeXml(asset.name)}" />
    <Assign DisplayName="Store ${escapeXml(asset.name)} Placeholder in Config">
      <Assign.To><OutArgument x:TypeArguments="x:Object">[dict_Config(${dictKey})]</OutArgument></Assign.To>
      <Assign.Value><InArgument x:TypeArguments="x:Object">["${escapeXml(placeholderValue).replace(/"/g, '""')}"]</InArgument></Assign.Value>
    </Assign>`;
  }

  for (const queue of queues) {
    const dictKey = isCSharp ? `"${escapeXml(queue.name)}"` : `&quot;${escapeXml(queue.name)}&quot;`;
    assetActivities += `
    <Assign DisplayName="Store Queue ${escapeXml(queue.name)} in Config">
      <Assign.To><OutArgument x:TypeArguments="x:Object">[dict_Config(${dictKey})]</OutArgument></Assign.To>
      <Assign.Value><InArgument x:TypeArguments="x:Object">["${escapeXml(queue.name).replace(/"/g, '""')}"]</InArgument></Assign.Value>
    </Assign>`;
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="InitAllSettings"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=${nsS}"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=${nsScg}"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <x:Members>
    <x:Property Name="out_Config" Type="OutArgument(scg:Dictionary(x:String, x:Object))" />
  </x:Members>
  <Sequence DisplayName="Initialize All Settings">
    <Sequence.Variables>
      <Variable x:TypeArguments="scg:Dictionary(x:String, x:Object)" Name="dict_Config" Default="[${isCSharp ? "new Dictionary&lt;string, object&gt;()" : "New Dictionary(Of String, Object)"}]" />
    </Sequence.Variables>
    <ui:LogMessage Level="Info" Message="[&quot;Initializing deterministic configuration dictionary&quot;]" DisplayName="Log Config Start" />${assetActivities}
    <Assign DisplayName="Output Config Dictionary">
      <Assign.To><OutArgument x:TypeArguments="scg:Dictionary(x:String, x:Object)">[out_Config]</OutArgument></Assign.To>
      <Assign.Value><InArgument x:TypeArguments="scg:Dictionary(x:String, x:Object)">[dict_Config]</InArgument></Assign.Value>
    </Assign>
    <ui:LogMessage Level="Info" Message="[&quot;Configuration loaded successfully&quot;]" DisplayName="Log Config Complete" />
  </Sequence>
</Activity>`;
}

function expandDeterministicScaffoldToWorkflowMap(
  scaffoldSpec: TreeWorkflowSpec,
  processNodes: any[],
  projectName: string,
): Map<string, { spec: TreeWorkflowSpec; processType: ProcessType }> {
  const results = new Map<string, { spec: TreeWorkflowSpec; processType: ProcessType }>();
  const context = buildDeterministicContext(projectName, processNodes);
  const workflowRoleMap = new Map<string, DeterministicWorkflowRole>();
  const decompositionWorkflowNames = (scaffoldSpec.decomposition || [])
    .map(d => d.name.replace(/\s+/g, "_"))
    .filter(Boolean);
  for (const decomp of scaffoldSpec.decomposition || []) {
    const childNodes = (decomp.nodeIds || [])
      .map(id => processNodes.find(node => String(node.id) === String(id)))
      .filter(Boolean);
    if (!childNodes.length) continue;
    workflowRoleMap.set(decomp.name.replace(/\s+/g, "_"), classifyDeterministicWorkflowRole(childNodes[0]));
  }
  const mainSpec: TreeWorkflowSpec = decompositionWorkflowNames.length > 0
    ? buildGenericDeterministicMainWorkflowSpec(projectName, decompositionWorkflowNames, workflowRoleMap)
    : {
        ...scaffoldSpec,
        name: "Main",
        rootSequence: {
          ...scaffoldSpec.rootSequence,
          displayName: "Main - Deterministic Sequence",
        },
      };
  results.set("Main", { spec: mainSpec, processType: "general" as ProcessType });

  const nodeMap = new Map<string, any>();
  for (const node of processNodes) {
    nodeMap.set(String(node.id), node);
  }

  for (const decomp of scaffoldSpec.decomposition || []) {
    const childNodes = (decomp.nodeIds || [])
      .map(id => nodeMap.get(String(id)))
      .filter(Boolean);
    if (childNodes.length === 0) continue;

    const childWorkflowName = decomp.name.replace(/\s+/g, "_");
    const role = classifyDeterministicWorkflowRole(childNodes[0]);
    workflowRoleMap.set(childWorkflowName, role);
    const explicitSpec = buildGenericDeterministicSubWorkflowSpec(childWorkflowName, projectName, childNodes, context);
    if (explicitSpec) {
      results.set(childWorkflowName, {
        spec: explicitSpec,
        processType: "general" as ProcessType,
      });
      continue;
    }

    const childChildren: TreeWorkflowSpec["rootSequence"]["children"] = [];
    childChildren.push({
      kind: "activity" as const,
      template: "LogMessage",
      displayName: `Start ${childWorkflowName}`,
      properties: { Level: "Info", Message: `"Starting ${childWorkflowName}"` },
      outputVar: null,
      outputType: null,
      errorHandling: "none" as const,
    });

    for (const node of childNodes) {
      const systemActivity = selectSystemActivity(node.system || "", node.description || "");
      if (systemActivity) {
        childChildren.push({
          kind: "activity" as const,
          template: systemActivity.template,
          displayName: systemActivity.displayName,
          properties: systemActivity.properties,
          outputVar: null,
          outputType: null,
          errorHandling: "none" as const,
        });
      } else {
        childChildren.push({
          kind: "activity" as const,
          template: "Comment",
          displayName: `TODO: ${node.name}`,
          properties: {
            Text: `Deterministic scaffold bind-point for ${node.name}${node.description ? " - " + node.description : ""}`,
          },
          outputVar: null,
          outputType: null,
          errorHandling: "none" as const,
        });
      }
    }

    childChildren.push({
      kind: "activity" as const,
      template: "LogMessage",
      displayName: `Complete ${childWorkflowName}`,
      properties: { Level: "Info", Message: `"Completed ${childWorkflowName}"` },
      outputVar: null,
      outputType: null,
      errorHandling: "none" as const,
    });

    results.set(childWorkflowName, {
      spec: {
        name: childWorkflowName,
        description: decomp.description || `Deterministic sub-workflow for ${projectName}`,
        variables: [],
        arguments: [],
        rootSequence: {
          kind: "sequence" as const,
          displayName: `${childWorkflowName} - Sequence`,
          children: childChildren,
        },
        useReFramework: false,
        dhgNotes: [
          "Generated from deterministic scaffold decomposition",
          "Review connector bindings and replace deterministic placeholders as needed",
        ],
        decomposition: [],
      },
      processType: "general" as ProcessType,
    });
  }

  return results;
}



export async function buildNuGetPackage(pkg: UiPathPackage, version: string = "1.0.0", ideaId?: string, generationMode: GenerationMode = "full_implementation", onProgress?: (event: { type: "started" | "heartbeat" | "completed" | "warning" | "failed"; stage: string; message: string }) => void, studioProfile?: StudioProfile | null, complexityTier?: ComplexityTier): Promise<BuildResult> {
  const _probeCacheSnapshot = await getProbeCache();
  const _studioProfile = studioProfile !== undefined ? studioProfile : catalogService.getStudioProfile();
  const requestedGenerationMode = generationMode;
  const projectName = (pkg.projectName || "Automation").replace(/\s+/g, "_");
  const sddContent = pkg.internal?.sddContent || "";
  const orchestratorArtifacts = pkg.internal?.orchestratorArtifacts || null;
  const processNodes = pkg.internal?.processNodes || [];
  const processEdges = pkg.internal?.processEdges || [];
  const explicitAutomationPattern = (() => {
    const raw = pkg.internal?.automationType;
    return raw === "simple-linear" || raw === "api-data-driven" || raw === "ui-automation" || raw === "transactional-queue" || raw === "hybrid"
      ? raw
      : undefined;
  })();

  let fingerprint: string | undefined;
  const buildCacheKey = ideaId ? `${ideaId}:${generationMode}` : undefined;
  const forceRebuild = !!pkg.internal?.forceRebuild;
  const tierStr: string | undefined = complexityTier || pkg.internal?.complexityTier || undefined;
  const enrichmentFp = ideaId ? computeEnrichmentFingerprint(processNodes, processEdges, sddContent, orchestratorArtifacts, projectName, tierStr, pkg.workflows) : undefined;
  let cachedEntry: CachedBuild | undefined;
  if (ideaId && buildCacheKey) {
    fingerprint = computePackageFingerprint(pkg, sddContent, processNodes, processEdges, orchestratorArtifacts, UIPATH_PACKAGE_ALIAS_MAP, tierStr);
    cachedEntry = packageBuildCache.get(buildCacheKey);
    if (forceRebuild) {
      console.log(`[UiPath Cache] FORCE REBUILD requested for ${buildCacheKey} — bypassing all stage caches`);
      packageBuildCache.delete(buildCacheKey);
      cachedEntry = undefined;
    } else if (cachedEntry && cachedEntry.overallFingerprint === fingerprint && cachedEntry.version === version) {
      if (!cachedEntry.qualityGatePassed) {
        console.log(`[UiPath Cache] HIT for ${buildCacheKey} but quality gate was not passed — rebuilding`);
        packageBuildCache.delete(buildCacheKey);
        cachedEntry = packageBuildCache.get(buildCacheKey);
      } else {
        console.log(`[UiPath Cache] FULL HIT for ${buildCacheKey} — all stages cached (enrichment, XAML, quality gate)`);
        return { buffer: cachedEntry.buffer, gaps: cachedEntry.gaps, usedPackages: cachedEntry.usedPackages, cacheHit: true, qualityGateResult: cachedEntry.qualityGateResult, xamlEntries: cachedEntry.xamlEntries, dependencyMap: cachedEntry.dependencyMap, archiveManifest: cachedEntry.archiveManifest, usedFallbackStubs: false, generationMode, referencedMLSkillNames: cachedEntry.referencedMLSkillNames || [], usedAIFallback: cachedEntry.usedAIFallback || false, projectJsonContent: cachedEntry.projectJsonContent };
      }
    } else if (cachedEntry) {
      const enrichHit = cachedEntry.stageEnrichment && cachedEntry.stageEnrichment.fingerprint === enrichmentFp;
      const reasons: string[] = [];
      if (cachedEntry.overallFingerprint !== fingerprint) reasons.push("overall fingerprint changed");
      if (cachedEntry.version !== version) reasons.push(`version changed (${cachedEntry.version} → ${version})`);
      if (cachedEntry.complexityTier !== tierStr) reasons.push(`complexity tier changed (${cachedEntry.complexityTier || "none"} → ${tierStr || "none"})`);
      console.log(`[UiPath Cache] PARTIAL for ${buildCacheKey} — ${reasons.join(", ")}${enrichHit ? "; enrichment stage still valid" : "; enrichment stage invalidated"}`);
    } else {
      console.log(`[UiPath Cache] MISS for ${buildCacheKey} (no cache)`);
    }
  }

  const hasQueues = orchestratorArtifacts?.queues?.length > 0;
  let automationPattern = classifyAutomationPattern(
    processNodes,
    sddContent,
    hasQueues,
    undefined,
  );

  let enrichment: EnrichmentResult | null = null;
  let treeEnrichment: TreeEnrichmentResult | null = null;
  let allTreeEnrichments: Map<string, { spec: TreeWorkflowSpec; processType: ProcessType }> = new Map();
  let _usedAIFallback = false;
  if (generationMode === "baseline_openable") {
    console.log(`[UiPath] baseline_openable mode — skipping AI enrichment, using flat scaffold`);
    if (processNodes.length > 0) {
      const scaffold = buildDeterministicScaffold(processNodes, projectName, sddContent || undefined, processEdges);
      treeEnrichment = scaffold.treeEnrichment;
      _usedAIFallback = scaffold.usedAIFallback;
      if (treeEnrichment.status === "success") {
        allTreeEnrichments = expandDeterministicScaffoldToWorkflowMap(treeEnrichment.workflowSpec, processNodes, projectName);
      }
    }
  } else {
    const hasDecomposedSpecs = pkg.workflows && pkg.workflows.length > 0 &&
      pkg.workflows.some(w => w.steps && w.steps.length > 0);
    let mappedTreeFallback: typeof treeEnrichment = null;
    let mappedAllTreeEnrichments: typeof allTreeEnrichments | null = null;
    if (hasDecomposedSpecs) {
      try {
        const { mapPackageSpecToTreeEnrichments } = await import("./spec-to-tree-mapper");
        const mapped = mapPackageSpecToTreeEnrichments(pkg);
        if (mapped.size > 0) {
          mappedAllTreeEnrichments = mapped;
          const mainEntry = mapped.get("Main") || mapped.values().next().value;
          if (mainEntry) {
            mappedTreeFallback = { status: "success", workflowSpec: mainEntry.spec, processType: mainEntry.processType };
          }
          const wfNames = Array.from(mapped.keys());
          console.log(`[UiPath] Mapped ${mapped.size} decomposed spec(s) to tree enrichments (held as fallback for AI refinement): ${wfNames.join(", ")}`);
          if (onProgress) onProgress({ type: "completed", stage: "spec_mapping", message: `Mapped ${mapped.size} decomposed spec(s) — proceeding to AI enrichment refinement` });
        }
      } catch (err: any) {
        console.log(`[UiPath] Spec-to-tree mapping failed: ${err.message} — continuing with normal enrichment`);
      }
    }

    const canReuseEnrichment = !treeEnrichment && !forceRebuild && cachedEntry?.stageEnrichment && enrichmentFp && cachedEntry.stageEnrichment.fingerprint === enrichmentFp;
    if (canReuseEnrichment) {
      enrichment = cachedEntry!.stageEnrichment!.enrichment;
      treeEnrichment = cachedEntry!.stageEnrichment!.treeEnrichment;
      _usedAIFallback = cachedEntry!.stageEnrichment!.usedAIFallback;
      if (enrichment || treeEnrichment) {
        console.log(`[UiPath Cache] Enrichment cache HIT — enrichment fingerprint unchanged (reusing ${enrichment ? `legacy enrichment with ${enrichment.nodes.length} nodes` : "tree enrichment"})`);
      } else {
        console.log(`[UiPath Cache] Enrichment cache HIT — previously attempted, cached as null`);
      }
    } else if (!treeEnrichment && cachedEntry?.stageEnrichment && enrichmentFp) {
      console.log(`[UiPath Cache] Enrichment cache MISS — enrichment fingerprint changed`);
    }
    if (!treeEnrichment && !canReuseEnrichment && processNodes.length > 0 && sddContent) {
      try {
        const isSimpleTier = complexityTier === "simple";
        const enrichmentLabel = mappedAllTreeEnrichments ? "AI refinement of mapped specs" : (isSimpleTier ? "single-pass" : "tree-based");
        const nodeCount = processNodes.filter(n => n.nodeType !== "start" && n.nodeType !== "end").length;
        const treeTimeout = isSimpleTier ? 60000 : (nodeCount >= 12 ? 180000 : 120000);
        console.log(`[UiPath] Requesting ${enrichmentLabel} AI enrichment for ${processNodes.length} process nodes${mappedAllTreeEnrichments ? ` (refining ${mappedAllTreeEnrichments.size} pre-mapped specs)` : ""}${isSimpleTier ? " (simple tier — no retry)" : ""} (timeout: ${treeTimeout}ms)...`);
        if (onProgress) onProgress({ type: "started", stage: "ai_enrichment_tree", message: `Starting ${enrichmentLabel} AI enrichment` });
        const treeHeartbeat = onProgress ? setInterval(() => {
          onProgress({ type: "heartbeat", stage: "ai_enrichment_tree", message: isSimpleTier ? "AI is generating workflow structure (streamlined)..." : "AI is building the workflow tree structure — this may take a minute for complex processes..." });
        }, 10000) : null;
        try {
          const treeResult = await enrichWithAITree(
            processNodes,
            processEdges,
            sddContent,
            orchestratorArtifacts,
            projectName,
            treeTimeout,
            automationPattern,
            isSimpleTier,
            mappedAllTreeEnrichments || undefined,
          );
          if (treeResult && treeResult.status === "success") {
            treeEnrichment = treeResult;
            if (mappedAllTreeEnrichments && mappedAllTreeEnrichments.size > 0) {
              allTreeEnrichments = new Map(mappedAllTreeEnrichments);
              const aiMainName = treeResult.workflowSpec.name || "Main";
              allTreeEnrichments.set(aiMainName, { spec: treeResult.workflowSpec, processType: treeResult.processType });
              console.log(`[UiPath] Tree enrichment successful: AI refined "${aiMainName}" (${treeResult.workflowSpec.variables.length} variables), preserving ${mappedAllTreeEnrichments.size} mapped workflow decomposition(s)`);
            } else {
              console.log(`[UiPath] Tree enrichment successful: "${treeResult.workflowSpec.name}", ${treeResult.workflowSpec.variables.length} variables`);
            }
            if (onProgress) onProgress({ type: "completed", stage: "ai_enrichment_tree", message: `Tree enrichment complete — ${treeResult.workflowSpec.variables.length} variables mapped` });
          } else if (treeResult && treeResult.status === "validation_failed") {
            const errorSummary = treeResult.validationErrors.join("; ");
            console.log(`[UiPath] Tree enrichment validation failed: ${errorSummary} — ${mappedTreeFallback ? "falling back to mapped specs" : "falling through to deterministic scaffold"}`);
            if (onProgress) onProgress({ type: "warning", stage: "ai_enrichment_tree", message: `Tree enrichment validation failed — ${mappedTreeFallback ? "using mapped spec fallback" : "falling back to deterministic scaffold"}` });
          }
        } finally {
          if (treeHeartbeat) clearInterval(treeHeartbeat);
        }
      } catch (err: any) {
        console.log(`[UiPath] Tree enrichment error: ${err.message} — ${mappedTreeFallback ? "falling back to mapped specs" : "falling back to deterministic scaffold"}`);
        if (onProgress) onProgress({ type: "warning", stage: "ai_enrichment_tree", message: `Tree enrichment failed — ${mappedTreeFallback ? "using mapped spec fallback" : "falling back to deterministic scaffold"}` });
      }

      if (!treeEnrichment && mappedTreeFallback) {
        console.log(`[UiPath] AI enrichment did not succeed — using mapped spec fallback with ${mappedAllTreeEnrichments?.size || 0} pre-mapped workflow(s)`);
        treeEnrichment = mappedTreeFallback;
        allTreeEnrichments = mappedAllTreeEnrichments || new Map();
        if (onProgress) onProgress({ type: "completed", stage: "ai_enrichment_tree", message: `Using mapped spec fallback — ${mappedAllTreeEnrichments?.size || 0} workflow(s)` });
      }

      if (!treeEnrichment && processNodes.length > 0) {
        console.log(`[UiPath] Tree enrichment failed — generating deterministic scaffold from ${processNodes.length} process nodes`);
        if (onProgress) onProgress({ type: "started", stage: "deterministic_scaffold", message: "Generating deterministic scaffold" });
        const scaffold = buildDeterministicScaffold(processNodes, projectName, sddContent || undefined, processEdges);
        treeEnrichment = scaffold.treeEnrichment;
        _usedAIFallback = scaffold.usedAIFallback;
        if (onProgress) onProgress({ type: "completed", stage: "deterministic_scaffold", message: "Deterministic scaffold generated" });
      }
    } else if (processNodes.length > 0 && !sddContent) {
      console.log(`[UiPath] No SDD content available — generating map-only deterministic scaffold from ${processNodes.length} process nodes`);
      const scaffold = buildDeterministicScaffold(processNodes, projectName, undefined, processEdges);
      treeEnrichment = scaffold.treeEnrichment;
      _usedAIFallback = scaffold.usedAIFallback;
    }
  }

  automationPattern = explicitAutomationPattern || classifyAutomationPattern(
    processNodes,
    sddContent,
    hasQueues,
    enrichment?.useReFramework,
  );
  const inferredModeConfig = selectGenerationMode(automationPattern, undefined, _studioProfile);
  const modeConfig: GenerationModeConfig = {
    ...inferredModeConfig,
    mode: requestedGenerationMode,
    flatScaffold: requestedGenerationMode === "baseline_openable" ? true : inferredModeConfig.flatScaffold,
    blockReFramework: requestedGenerationMode === "baseline_openable" ? true : inferredModeConfig.blockReFramework,
    blockForbiddenActivities: requestedGenerationMode === "baseline_openable" ? true : inferredModeConfig.blockForbiddenActivities,
    reason: requestedGenerationMode === inferredModeConfig.mode
      ? inferredModeConfig.reason
      : `Caller requested ${requestedGenerationMode}; classifier inferred ${inferredModeConfig.mode} for pattern "${automationPattern}". ${inferredModeConfig.reason}`,
  };
  generationMode = requestedGenerationMode;
  let useReFramework = modeConfig.blockReFramework ? false : shouldUseReFramework(automationPattern);
  const genCtx: XamlGenerationContext = {
    generationMode,
    automationPattern,
    aiCenterSkills: pkg.internal?.aiCenterSkills || [],
    referencedMLSkillNames: [],
  };
  console.log(`[UiPath] Automation pattern: ${automationPattern}, generationMode: ${generationMode}, useReFramework: ${useReFramework}, reason: ${modeConfig.reason}`);

  if (!forceRebuild && cachedEntry && buildCacheKey) {
    const _earlyMetaTarget = _metadataService.getStudioTarget();
    const explicitFw = pkg.internal?.targetFramework;
    const earlyIsServerless = explicitFw === "Portable" || !!pkg.internal?.isServerless || (!explicitFw && !!(_probeCacheSnapshot?.serverlessDetected) && !_probeCacheSnapshot?.flags?.hasUnattendedSlots);
    const earlyTf: TargetFramework = _studioProfile ? _studioProfile.targetFramework : (_earlyMetaTarget?.targetFramework || (earlyIsServerless ? "Portable" : "Windows"));
    const earlyTreeSpecs: TreeWorkflowSpec[] = [];
    if (allTreeEnrichments.size > 0) {
      Array.from(allTreeEnrichments.values()).forEach(entry => earlyTreeSpecs.push(entry.spec));
    } else if (treeEnrichment?.status === "success") {
      earlyTreeSpecs.push(treeEnrichment.workflowSpec);
    }
    const earlyDepRes = resolveDependencies(pkg, _studioProfile, earlyTreeSpecs.length > 0 ? earlyTreeSpecs : null, earlyTf as "Windows" | "Portable");
    const currentDepMap = earlyDepRes.deps;
    const xamlFpCheck = computeXamlFingerprint(enrichment, treeEnrichment, pkg, orchestratorArtifacts, generationMode, tierStr, currentDepMap, earlyTf);
    const xamlStageHit = cachedEntry.stageXaml && cachedEntry.stageXaml.fingerprint === xamlFpCheck;
    const versionMatch = cachedEntry.version === version;
    if (xamlStageHit && !versionMatch) {
      console.log(`[UiPath Cache] XAML cache HIT but version changed (${cachedEntry.version} → ${version}) — must rebuild archive with new version metadata`);
    } else if (xamlStageHit) {
      const qgFpCheck = computeQualityGateFingerprint(
        cachedEntry.stageXaml!.xamlEntries,
        cachedEntry.stageXaml!.projectJsonContent || "",
        cachedEntry.stageXaml!.configCsv || "",
        orchestratorArtifacts,
        earlyTf,
        tierStr,
        automationPattern,
      );
      const qgStageHit = cachedEntry.stageQualityGate && cachedEntry.stageQualityGate.fingerprint === qgFpCheck && cachedEntry.stageQualityGate.qualityGatePassed;
      if (qgStageHit) {
        console.log(`[UiPath Cache] XAML cache HIT — XAML fingerprint unchanged (artifacts/enrichment stable)`);
        console.log(`[UiPath Cache] Quality gate cache HIT — QG fingerprint unchanged (XAML + validation inputs stable)`);
        console.log(`[UiPath Cache] All stages cached — returning cached result for ${buildCacheKey}`);
        return {
          buffer: cachedEntry.buffer,
          gaps: cachedEntry.gaps,
          usedPackages: cachedEntry.usedPackages,
          cacheHit: true,
          qualityGateResult: cachedEntry.qualityGateResult,
          xamlEntries: cachedEntry.xamlEntries,
          dependencyMap: cachedEntry.dependencyMap,
          archiveManifest: cachedEntry.archiveManifest,
          usedFallbackStubs: false,
          generationMode,
          referencedMLSkillNames: cachedEntry.referencedMLSkillNames || [],
          usedAIFallback: cachedEntry.usedAIFallback || false,
          projectJsonContent: cachedEntry.projectJsonContent,
        };
      } else {
        const qgReason = !cachedEntry.stageQualityGate
          ? "no cached QG stage"
          : !cachedEntry.stageQualityGate.qualityGatePassed
            ? "previous QG did not pass"
            : "QG fingerprint changed";
        console.log(`[UiPath Cache] XAML cache HIT — XAML fingerprint unchanged`);
        console.log(`[UiPath Cache] Quality gate cache MISS — ${qgReason}; re-running quality gate with cached XAML`);
        const cachedXaml = cachedEntry.stageXaml!;
        const rerunQG = runQualityGate({
          xamlEntries: cachedXaml.xamlEntries,
          projectJsonContent: cachedXaml.projectJsonContent || "",
          configData: cachedXaml.configCsv || "",
          orchestratorArtifacts,
          targetFramework: earlyTf as "Windows" | "Portable",
          archiveManifest: cachedXaml.archiveManifest,
          archiveContentHashes: {},
          automationPattern: (cachedXaml.automationPattern || "attended") as AutomationPattern,
        });
        if (rerunQG.passed) {
          console.log(`[UiPath Cache] Quality gate re-run PASSED — updating cache and returning cached XAML with fresh QG result`);
          const freshQgFp = computeQualityGateFingerprint(
            cachedXaml.xamlEntries,
            cachedXaml.projectJsonContent || "",
            cachedXaml.configCsv || "",
            orchestratorArtifacts,
            earlyTf,
            tierStr,
            automationPattern,
          );
          cachedEntry.qualityGatePassed = true;
          cachedEntry.qualityGateResult = rerunQG;
          cachedEntry.stageQualityGate = {
            fingerprint: freshQgFp,
            qualityGatePassed: true,
            qualityGateResult: rerunQG,
          };
          return {
            buffer: cachedXaml.buffer,
            gaps: cachedXaml.gaps,
            usedPackages: cachedXaml.usedPackages,
            cacheHit: true,
            qualityGateResult: rerunQG,
            xamlEntries: cachedXaml.xamlEntries,
            dependencyMap: cachedXaml.dependencyMap,
            archiveManifest: cachedXaml.archiveManifest,
            usedFallbackStubs: false,
            generationMode,
            referencedMLSkillNames: cachedXaml.referencedMLSkillNames || [],
            usedAIFallback: cachedEntry.usedAIFallback || false,
            projectJsonContent: cachedXaml.projectJsonContent,
          };
        } else {
          console.log(`[UiPath Cache] Quality gate re-run FAILED (${rerunQG.summary?.totalErrors || 0} error(s)) — proceeding with full rebuild`);
        }
      }
    } else {
      const xamlReason = !cachedEntry.stageXaml ? "no cached XAML stage" : "XAML fingerprint changed (enrichment or pkg spec changed)";
      console.log(`[UiPath Cache] XAML cache MISS — ${xamlReason}`);
      console.log(`[UiPath Cache] Quality gate cache MISS — upstream XAML stage invalidated`);
    }
  }

  const queueName = enrichment?.reframeworkConfig?.queueName
    || orchestratorArtifacts?.queues?.[0]?.name
    || "TransactionQueue";

  const trackedArchive = createTrackedArchive();
  const _archiveManifestTracker = trackedArchive.manifest;
  const _appendedContentHashes = trackedArchive.contentHashes;
  const archive = trackedArchive;

  const explicitFramework = pkg.internal?.targetFramework;
  const isServerless = explicitFramework === "Portable"
    || !!pkg.internal?.isServerless
    || (!explicitFramework && !!(_probeCacheSnapshot?.serverlessDetected) && !_probeCacheSnapshot?.flags?.hasUnattendedSlots);
    const libPath = _studioProfile
      ? (_studioProfile.targetFramework === "Portable" ? "lib/net6.0" : "lib/net45")
      : (isServerless ? "lib/net6.0" : "lib/net45");
    const xamlResults: XamlGeneratorResult[] = [];

    const contentTypesXml = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="nuspec" ContentType="application/octet" />
  <Default Extension="psmdcp" ContentType="application/vnd.openxmlformats-package.core-properties+xml" />
  <Default Extension="xaml" ContentType="application/octet" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="csv" ContentType="text/csv" />
  <Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
</Types>`;
    archive.append(contentTypesXml, { name: "[Content_Types].xml" });

    const corePropsId = generateUuid();
    const relsXml = `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="/${projectName}.nuspec" Id="R1" />
  <Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/package/services/metadata/core-properties/${corePropsId}.psmdcp" Id="R2" />
</Relationships>`;
    archive.append(relsXml, { name: "_rels/.rels" });

    const coreProps = `<?xml version="1.0" encoding="utf-8"?>
<coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">
  <dc:creator>CannonBall</dc:creator>
  <dc:description>${escapeXml(pkg.description || projectName)}</dc:description>
  <dc:identifier>${projectName}</dc:identifier>
  <version>${version}</version>
</coreProperties>`;
    archive.append(coreProps, { name: `package/services/metadata/core-properties/${corePropsId}.psmdcp` });

    const _metaTarget2 = _metadataService.getStudioTarget();
    const tf: TargetFramework = _studioProfile ? _studioProfile.targetFramework : (_metaTarget2?.targetFramework || (isServerless ? "Portable" : "Windows"));
    const allTreeSpecsForDeps: TreeWorkflowSpec[] = [];
    if (allTreeEnrichments.size > 0) {
      Array.from(allTreeEnrichments.values()).forEach(entry => {
        allTreeSpecsForDeps.push(entry.spec);
      });
    } else if (treeEnrichment?.status === "success") {
      allTreeSpecsForDeps.push(treeEnrichment.workflowSpec);
    }
    const depResolution = resolveDependencies(pkg, _studioProfile, allTreeSpecsForDeps.length > 0 ? allTreeSpecsForDeps : null, tf as "Windows" | "Portable");
    const deps = depResolution.deps;
    const dependencyWarnings = depResolution.warnings;
    const proactivelyResolvedPackages = new Set(Object.keys(deps));
    const specPredictedPackages = depResolution.specPredictedPackages;

    const analysisReports: { fileName: string; report: AnalysisReport }[] = [];
    const xamlEntries: { name: string; content: string }[] = [];
    const deferredWrites = new Map<string, string>();
    const apEnabled = !!pkg.internal?.autopilotEnabled || !!(_probeCacheSnapshot?.flags?.autopilot);
    const earlyStubFallbacks: string[] = [];
    const complianceFallbacks: Array<{ file: string; reason: string; wasFullStub: boolean }> = [];
    const allPolicyBlocked: Array<{ file: string; activities: string[] }> = [];
    const collectedQualityIssues: DhgQualityIssue[] = [];
    const priorCompliantWorkflows = pkg.internal?.priorCompliantWorkflows || [];
    const priorCompliantMap = new Map<string, string>();
    if (priorCompliantWorkflows.length > 0) {
      for (const pw of priorCompliantWorkflows) {
        const shortName = pw.name.split("/").pop() || pw.name;
        const baseName = shortName.replace(/\.xaml$/i, "");
        priorCompliantMap.set(baseName, pw.content);
      }
      console.log(`[UiPath] ${priorCompliantMap.size} prior compliant workflow(s) available for reuse: ${Array.from(priorCompliantMap.keys()).join(", ")}`);
    }
    type CatalogPropertySnapshot = Map<string, Map<string, string>>;

    const COMPLIANCE_EXPECTED_TRANSFORMS: Record<string, Set<string>> = {
      "Assign": new Set(["To", "Value"]),
      "InvokeWorkflowFile": new Set(["Input", "Output"]),
    };

    function snapshotCatalogValidProperties(xml: string): CatalogPropertySnapshot {
      const snapshot: CatalogPropertySnapshot = new Map();
      const elementRegex = /<((?:[\w]+:)?[\w]+)(\s[^>]*?|\s*)(\/?>)/g;
      let elMatch;
      while ((elMatch = elementRegex.exec(xml)) !== null) {
        const fullTag = elMatch[1];
        if (fullTag.includes(".") || fullTag.startsWith("x:") || fullTag.startsWith("sap") || fullTag.startsWith("mc:")) continue;
        const className = fullTag.includes(":") ? fullTag.split(":").pop()! : fullTag;
        const schema = catalogService.getActivitySchema(className);
        if (!schema) continue;

        const expectedTransforms = COMPLIANCE_EXPECTED_TRANSFORMS[className];
        const attrString = elMatch[2];
        const attrRegex2 = /([\w]+(?:\.[\w]+)?)="([^"]*)"/g;
        let attrMatch;
        const validAttrs = new Map<string, string>();
        while ((attrMatch = attrRegex2.exec(attrString)) !== null) {
          if (attrMatch[1].startsWith("xmlns") || attrMatch[1].includes(":")) continue;
          const propName = attrMatch[1];
          if (expectedTransforms && expectedTransforms.has(propName)) continue;
          const propVal = attrMatch[2];
          const knownProp = schema.activity.properties.find(p => p.name === propName);
          if (knownProp && knownProp.xamlSyntax === "attribute") {
            validAttrs.set(propName, propVal);
          }
        }
        if (validAttrs.size > 0) {
          const key = `${fullTag}@${elMatch.index}`;
          snapshot.set(key, validAttrs);
        }
      }
      return snapshot;
    }

    function enforcePreCompliancePropertyProtection(preComplianceXml: string, postComplianceXml: string, snapshot: CatalogPropertySnapshot, fileName: string): string {
      if (snapshot.size === 0) return postComplianceXml;
      let result = postComplianceXml;
      let protectedCount = 0;
      let damagedCount = 0;

      Array.from(snapshot.entries()).forEach(([key, validAttrs]) => {
        const tagName = key.split("@")[0];
        Array.from(validAttrs.entries()).forEach(([propName, propVal]) => {
          const escapedPropName = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedPropVal = propVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const attrPattern = new RegExp(`${escapedPropName}="${escapedPropVal}"`);
          if (attrPattern.test(result)) {
            protectedCount++;
            return;
          }
          damagedCount++;
          const escapedPropValXml = propVal.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const nsPrefix = tagName.includes(":") ? tagName.split(":")[0] + ":" : "";
          const localTag = tagName.includes(":") ? tagName.split(":")[1] : tagName;
          const childElPatterns = [
            new RegExp(`<${nsPrefix}${localTag}\\.${escapedPropName}>\\s*<(?:In|Out|InOut)Argument[^>]*>\\s*${escapedPropValXml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</(?:In|Out|InOut)Argument>\\s*</${nsPrefix}${localTag}\\.${escapedPropName}>`, "s"),
            new RegExp(`<${localTag}\\.${escapedPropName}>\\s*<(?:In|Out|InOut)Argument[^>]*>\\s*${escapedPropValXml.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</(?:In|Out|InOut)Argument>\\s*</${localTag}\\.${escapedPropName}>`, "s"),
          ];
          let restored = false;
          for (const pat of childElPatterns) {
            const childMatch = pat.exec(result);
            if (childMatch) {
              const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const tagOpenPat = new RegExp(`<${escapedTag}\\s[^>]*?>`, "g");
              const searchRegion = result.substring(0, childMatch.index);
              let lastTagMatch: RegExpExecArray | null = null;
              let m;
              while ((m = tagOpenPat.exec(searchRegion)) !== null) {
                lastTagMatch = m;
              }
              if (lastTagMatch) {
                const childStr = childMatch[0];
                const childIdx = childMatch.index;
                result = result.substring(0, childIdx) + result.substring(childIdx + childStr.length);
                const tagOpenStr = lastTagMatch[0];
                const tagOpenEnd = lastTagMatch.index + tagOpenStr.length - 1;
                result = result.substring(0, tagOpenEnd) + ` ${propName}="${propVal}"` + result.substring(tagOpenEnd);
                restored = true;
                console.log(`[Compliance Preservation] ${fileName}: restored "${propName}" on <${tagName}> from child-element back to attribute form`);
              }
              break;
            }
          }
          if (!restored) {
            console.warn(`[Compliance Preservation] ${fileName}: catalog-valid property "${propName}" on <${tagName}> was damaged by compliance pass and could not be auto-restored`);
          }
        });
      });

      if (damagedCount > 0) {
        console.log(`[Compliance Preservation] ${fileName}: ${damagedCount} damaged, ${protectedCount} preserved; auto-restored where possible`);
      } else if (protectedCount > 0) {
        console.log(`[Compliance Preservation] ${fileName}: all ${protectedCount} catalog-valid property(ies) preserved through compliance pass`);
      }
      return result;
    }

    let totalPostComplianceReCorrections = 0;

    function compliancePass(rawXaml: string, fileName: string, skipTracking?: boolean): string {
      const preCatalogSnapshot = catalogService.isLoaded() ? snapshotCatalogValidProperties(rawXaml) : null;
      let compliant = makeUiPathCompliant(rawXaml, tf);
      if (preCatalogSnapshot && preCatalogSnapshot.size > 0) {
        compliant = enforcePreCompliancePropertyProtection(rawXaml, compliant, preCatalogSnapshot, fileName);
      }
      const { filtered, removed } = filterBlockedActivitiesFromXaml(compliant, automationPattern);
      compliant = filtered;
      if (removed.length > 0) {
        console.log(`[UiPath Policy] ${fileName}: removed ${removed.length} blocked activit(ies) for pattern "${automationPattern}": ${removed.join(", ")}`);
      }
      const policyResult = applyActivityPolicy(compliant, modeConfig, fileName);
      compliant = policyResult.content;
      if (policyResult.blocked.length > 0) {
        allPolicyBlocked.push({ file: fileName, activities: policyResult.blocked });
        console.log(`[UiPath Policy] ${fileName}: blocked ${policyResult.blocked.join(", ")} (${generationMode} mode)`);
      }
      const { fixed, report } = analyzeAndFix(compliant);
      analysisReports.push({ fileName, report });
      if (!skipTracking) {
        xamlEntries.push({ name: fileName, content: fixed });
      }
      if (report.totalAutoFixed > 0) {
        console.log(`[UiPath Analyzer] ${fileName}: ${report.totalAutoFixed} auto-fixed, ${report.totalRemaining} remaining`);
      }

      let convergedOutput = fixed;
      const MAX_CONVERGENCE_PASSES = 3;
      try {
        for (let pass = 1; pass <= MAX_CONVERGENCE_PASSES; pass++) {
          const reCompliant = makeUiPathCompliant(convergedOutput, tf);
          if (reCompliant === convergedOutput) {
            if (pass > 1) {
              console.log(`[Compliance Idempotency] ${fileName}: converged after ${pass} pass(es)`);
            }
            break;
          }
          if (pass === 1) {
            const diffLines: string[] = [];
            const fixedLines = convergedOutput.split("\n");
            const reLines = reCompliant.split("\n");
            const maxLen = Math.max(fixedLines.length, reLines.length);
            for (let i = 0; i < maxLen && diffLines.length < 5; i++) {
              if (fixedLines[i] !== reLines[i]) {
                diffLines.push(`  line ${i + 1}: "${(fixedLines[i] || "").slice(0, 120)}" → "${(reLines[i] || "").slice(0, 120)}"`);
              }
            }
            console.warn(`[Compliance Idempotency] ${fileName}: compliance pass was NOT idempotent — running convergence loop (max ${MAX_CONVERGENCE_PASSES} passes). First differences:\n${diffLines.join("\n")}`);
          }
          convergedOutput = reCompliant;
          totalPostComplianceReCorrections++;
          if (pass === MAX_CONVERGENCE_PASSES) {
            console.warn(`[Compliance Idempotency] ${fileName}: did not converge after ${MAX_CONVERGENCE_PASSES} passes — using last result`);
          }
        }
        if (convergedOutput !== fixed && !skipTracking) {
          const idx = xamlEntries.findIndex(e => e.name === fileName);
          if (idx >= 0) {
            xamlEntries[idx].content = convergedOutput;
          }
        }
      } catch (idempotencyErr: any) {
        console.warn(`[Compliance Idempotency] ${fileName}: convergence pass failed — ${idempotencyErr.message}`);
      }

      return convergedOutput;
    }

    function tryStructuralPreservationOrStub(
      rawXaml: string,
      wfName: string,
      compErrMessage: string,
    ): { content: string; wasFullStub: boolean } {
      const spResult = preserveStructureAndStubLeaves(
        rawXaml,
        [{ file: `${wfName}.xaml`, check: "compliance-crash", detail: `Compliance transform failed: ${compErrMessage}` }],
        { isMainXaml: wfName === "Main" || wfName === "Process" },
      );
      if (spResult.preserved || spResult.parseableXml) {
        console.log(`[UiPath] Structural preservation succeeded for "${wfName}" after compliance failure: ${spResult.preservedActivities} preserved, ${spResult.stubbedActivities} stubbed`);
        try {
          const preserved = compliancePass(spResult.content, `${wfName}.xaml`, true);
          return { content: preserved, wasFullStub: false };
        } catch {
          console.log(`[UiPath] Structural preservation output failed compliance for "${wfName}" — falling back to full stub`);
        }
      }
      return { content: compliancePass(generateStubWorkflow(wfName, { reason: `Compliance transform failed — ${compErrMessage}` }), `${wfName}.xaml`, true), wasFullStub: true };
    }

    function tryGenerateOrStub(
      generateFn: () => XamlGeneratorResult,
      wfName: string,
      description: string,
    ): XamlGeneratorResult | null {
      try {
        const result = generateFn();
        if (modeConfig.blockReFramework && isReFrameworkFile(`${wfName}.xaml`)) {
          console.log(`[UiPath Early Stub] Skipping REFramework file ${wfName}.xaml in ${generationMode} mode`);
          return null;
        }
        return result;
      } catch (err: any) {
        console.log(`[UiPath Early Stub] Generator failed for ${wfName}: ${err.message} — emitting stub`);
        const stubXaml = generateStubWorkflow(wfName, {
          reason: `Generator could not safely produce this workflow: ${err.message}`,
          isBlockingFallback: true,
        });
        const stubCompliant = compliancePass(stubXaml, `${wfName}.xaml`);
        deferredWrites.set(`${libPath}/${wfName}.xaml`, stubCompliant);
        earlyStubFallbacks.push(`${wfName}.xaml`);
        collectedQualityIssues.push({
          severity: "blocking",
          file: `${wfName}.xaml`,
          check: "generator-failure",
          detail: `Generator failed: ${err.message} — replaced with Studio-openable stub`,
          stubbedWorkflow: `${wfName}.xaml`,
        });
        outcomeRemediations.push({
          level: "workflow",
          file: `${wfName}.xaml`,
          remediationCode: "STUB_WORKFLOW_BLOCKING",
          reason: `Generator failed: ${err.message} — replaced with stub`,
          classifiedCheck: "generator-failure",
          developerAction: `Re-implement ${wfName}.xaml — generator could not produce valid XAML`,
          estimatedEffortMinutes: 60,
        });
        return null;
      }
    }

    const workflows = pkg.workflows || [];
    let hasMain = false;
    const generatedWorkflowNames = new Set<string>();

    let specValidationReport: SpecValidationReport | null = null;
    const enrichmentsToProcess: Array<{ name: string; spec: TreeWorkflowSpec; processType: ProcessType }> = [];
    if (allTreeEnrichments.size > 0) {
      Array.from(allTreeEnrichments.entries()).forEach(([name, entry]) => {
        enrichmentsToProcess.push({ name, spec: entry.spec, processType: entry.processType });
      });
    } else if (treeEnrichment && treeEnrichment.status === "success") {
      enrichmentsToProcess.push({ name: treeEnrichment.workflowSpec.name || "Main", spec: treeEnrichment.workflowSpec, processType: treeEnrichment.processType });
    }

    const nonMainWorkflowNames: string[] = [];
    let deferredHallucinatedRecoveries: Array<{ template: string; displayName: string; file: string }> = [];

    if (enrichmentsToProcess.length > 0) {
      const mainIdx = enrichmentsToProcess.findIndex(e => e.name === "Main");
      if (mainIdx > 0) {
        const [mainEntry] = enrichmentsToProcess.splice(mainIdx, 1);
        enrichmentsToProcess.unshift(mainEntry);
      }

      let totalStrippedProperties = 0;
      let totalExcessiveStripping = 0;
      const excessiveStrippingFiles = new Set<string>();

      for (const enrichEntry of enrichmentsToProcess) {
        let spec = enrichEntry.spec;
        const validationResult = validateSpec(spec, _studioProfile);
        spec = validationResult.spec;
        const report = validationResult.report;
        totalStrippedProperties += report.strippedProperties;
        totalExcessiveStripping += report.excessiveStrippingCount;
        const wfFileName = ((spec.name || enrichEntry.name || "").replace(/\s+/g, "_")) + ".xaml";
        if (report.excessiveStrippingCount > 0) {
          excessiveStrippingFiles.add(wfFileName);
          const perFileHallucinated = report.issues.filter(
            i => i.code === "EXCESSIVE_PROPERTIES_STRIPPED" && i.severity === "error"
          );
          for (const hi of perFileHallucinated) {
            deferredHallucinatedRecoveries.push({
              template: hi.activityTemplate,
              displayName: hi.activityDisplayName,
              file: wfFileName,
            });
          }
        }

        if (!specValidationReport) {
          specValidationReport = { ...report };
          treeEnrichment = { status: "success", workflowSpec: spec, processType: enrichEntry.processType };
        } else {
          specValidationReport.totalActivities += report.totalActivities;
          specValidationReport.validActivities += report.validActivities;
          specValidationReport.unknownActivities += report.unknownActivities;
          specValidationReport.strippedProperties += report.strippedProperties;
          specValidationReport.enumCorrections += report.enumCorrections;
          specValidationReport.missingRequiredFilled += report.missingRequiredFilled;
          specValidationReport.commentConversions += report.commentConversions;
          specValidationReport.excessiveStrippingCount += report.excessiveStrippingCount;
          specValidationReport.issues = specValidationReport.issues.concat(report.issues);
        }

        const specJson = JSON.stringify(spec, null, 2);
        const truncatedSpec = specJson.length > 5000 ? specJson.slice(0, 5000) + "\n... [truncated]" : specJson;
        console.log(`[UiPath] WorkflowSpec tree (validated) before assembly for "${enrichEntry.name}":\n${truncatedSpec}`);
        console.log(`[UiPath] Using tree-based assembly for "${spec.name}"`);

        const wfName = (spec.name || enrichEntry.name || projectName).replace(/"/g, "").replace(/&quot;/g, "").replace(/\s+/g, "_");
        if (priorCompliantMap.has(wfName)) {
          const priorContent = priorCompliantMap.get(wfName)!;
          deferredWrites.set(`${libPath}/${wfName}.xaml`, priorContent);
          generatedWorkflowNames.add(wfName);
          if (wfName === "Main" || wfName === "Process") {
            hasMain = true;
          } else {
            nonMainWorkflowNames.push(wfName);
          }
          xamlResults.push({ xaml: priorContent, gaps: [], usedPackages: ["UiPath.System.Activities"], variables: [] });
          xamlEntries.push({ name: `${wfName}.xaml`, content: priorContent });
          console.log(`[UiPath] Reused prior compliant workflow "${wfName}" — skipping regeneration`);
          continue;
        }
        try {
          const { xaml, variables } = assembleWorkflowFromSpec(spec, enrichEntry.processType);
          let compliant: string;
          let complianceFailed = false;
          try {
            compliant = compliancePass(xaml, `${wfName}.xaml`);
          } catch (compErr: any) {
            complianceFailed = true;
            console.warn(`[UiPath] Compliance pass failed for tree-assembled "${wfName}": ${compErr.message} — attempting structural preservation`);
            const spResult = tryStructuralPreservationOrStub(xaml, wfName, compErr.message);
            compliant = spResult.content;
            complianceFallbacks.push({ file: `${wfName}.xaml`, reason: compErr.message, wasFullStub: spResult.wasFullStub });
          }
          const implRepair = repairMissingImplementation(compliant, `${wfName}.xaml`);
          if (implRepair.repaired) {
            compliant = implRepair.content;
          }
          deferredWrites.set(`${libPath}/${wfName}.xaml`, compliant);
          generatedWorkflowNames.add(wfName);
          if ((wfName === "Main" || wfName === "Process") && !complianceFailed) {
            hasMain = true;
          } else if (wfName !== "Main" && wfName !== "Process") {
            nonMainWorkflowNames.push(wfName);
          }
          xamlResults.push({
            xaml: compliant,
            gaps: [],
            usedPackages: ["UiPath.System.Activities"],
            variables: variables.map(v => ({ name: v.name, type: v.type, defaultValue: v.default || "" })),
          });
          console.log(`[UiPath] Tree assembly produced XAML for "${wfName}" (${variables.length} variables)`);
        } catch (err: any) {
          console.warn(`[UiPath] Tree assembly failed for "${wfName}": ${err.message} — attempting structural preservation before stub`);
          const spResult = tryStructuralPreservationOrStub("", wfName, `Tree assembly failed — ${err.message}`);
          deferredWrites.set(`${libPath}/${wfName}.xaml`, spResult.content);
          generatedWorkflowNames.add(wfName);
          complianceFallbacks.push({ file: `${wfName}.xaml`, reason: `Tree assembly failed — ${err.message}`, wasFullStub: spResult.wasFullStub });
          if (wfName !== "Main" && wfName !== "Process") {
            nonMainWorkflowNames.push(wfName);
          }
          xamlResults.push({
            xaml: spResult.content,
            gaps: [],
            usedPackages: ["UiPath.System.Activities"],
            variables: [],
          });
          if (enrichEntry.name === enrichmentsToProcess[0]?.name) {
            treeEnrichment = null;
          }
        }
      }

      if (totalStrippedProperties > 0) {
        dependencyWarnings.push({
          code: "CATALOG_PROPERTY_STRIPPED",
          message: `Pre-emission validation stripped ${totalStrippedProperties} non-catalog properties across ${enrichmentsToProcess.length} workflow(s)`,
          stage: "spec-validation",
          recoverable: true,
        });
      }

      if (totalExcessiveStripping > 0) {
        const affectedFileList = Array.from(excessiveStrippingFiles).join(", ");
        if (deferredHallucinatedRecoveries.length > 0) {
          console.log(`[UiPath Recovery] Identified ${deferredHallucinatedRecoveries.length} potentially hallucinated activit(ies) for targeted recovery:`);
          for (const ha of deferredHallucinatedRecoveries) {
            console.log(`  - ${ha.template} ("${ha.displayName}") in ${ha.file} — converted to Comment stub at spec-validator level`);
          }
        }
        dependencyWarnings.push({
          code: "EXCESSIVE_PROPERTY_STRIPPING",
          message: `${totalExcessiveStripping} activit(ies) had 5+ non-catalog properties stripped (structural breaks only) in [${affectedFileList}] — indicates generation hallucination for uncataloged activity types. ${deferredHallucinatedRecoveries.length} converted to Comment stubs at spec-validator level.`,
          stage: "spec-validation",
          recoverable: true,
          affectedFiles: Array.from(excessiveStrippingFiles),
        });
        console.warn(`[UiPath] EXCESSIVE PROPERTY STRIPPING: ${totalExcessiveStripping} activities exceeded the stripping threshold in ${affectedFileList} — ${deferredHallucinatedRecoveries.length} converted to Comment stubs via spec-level recovery`);
      }

      const mainWfName = generatedWorkflowNames.has("Main") ? "Main" : (generatedWorkflowNames.has("Process") ? "Process" : (enrichmentsToProcess[0]?.name || "Main").replace(/\s+/g, "_"));
      const mainXamlPath = `${libPath}/${mainWfName}.xaml`;
      if (nonMainWorkflowNames.length > 0 && deferredWrites.has(mainXamlPath)) {
        let mainXaml = deferredWrites.get(mainXamlPath)!;
        const invokeRefs: string[] = [];
        const entryWorkflowNames = chooseMainEntryWorkflowNames(nonMainWorkflowNames, projectName);
        const initInvokeRef = `<ui:InvokeWorkflowFile DisplayName="Initialize All Settings" WorkflowFileName="InitAllSettings.xaml" />`;
        if (!mainXaml.includes('WorkflowFileName="InitAllSettings.xaml"')) {
          invokeRefs.push(`      ${initInvokeRef}`);
        }
        for (const subWfName of entryWorkflowNames) {
          const subFileName = `${subWfName}.xaml`;
          if (!mainXaml.includes(`WorkflowFileName="${subFileName}"`)) {
            invokeRefs.push(`      <ui:InvokeWorkflowFile DisplayName="${subWfName}" WorkflowFileName="${subFileName}" />`);
          }
        }
        if (invokeRefs.length > 0) {
          const seqVarsEndMatch = mainXaml.match(/<\/Sequence\.Variables>\s*\n/);
          const rootSeqMatch = mainXaml.match(/<Sequence\s[^>]*DisplayName="[^"]*"[^>]*>\s*\n/);
          const insertMatch = seqVarsEndMatch || rootSeqMatch;
          if (insertMatch) {
            const insertPos = insertMatch.index! + insertMatch[0].length;
            mainXaml = mainXaml.slice(0, insertPos) + invokeRefs.join("\n") + "\n" + mainXaml.slice(insertPos);
            deferredWrites.set(mainXamlPath, mainXaml);
            const existingIdx = xamlEntries.findIndex(e => {
              const bn = e.name.split("/").pop() || e.name;
              return bn === `${mainWfName}.xaml`;
            });
            if (existingIdx >= 0) {
              xamlEntries[existingIdx] = { name: xamlEntries[existingIdx].name, content: mainXaml };
            }
            console.log(`[UiPath] Injected ${invokeRefs.length} InvokeWorkflowFile reference(s) into ${mainWfName}.xaml using entry workflow selection: InitAllSettings${entryWorkflowNames.length > 0 ? ", " + entryWorkflowNames.join(", ") : ""}`);
          }
        }
      } else if (nonMainWorkflowNames.length === 0 && deferredWrites.has(mainXamlPath)) {
        let mainXaml = deferredWrites.get(mainXamlPath)!;
        if (!mainXaml.includes('WorkflowFileName="InitAllSettings.xaml"')) {
          const seqVarsEndMatch = mainXaml.match(/<\/Sequence\.Variables>\s*\n/);
          const rootSeqMatch = mainXaml.match(/<Sequence\s[^>]*DisplayName="[^"]*"[^>]*>\s*\n/);
          const insertMatch = seqVarsEndMatch || rootSeqMatch;
          if (insertMatch) {
            const insertPos = insertMatch.index! + insertMatch[0].length;
            mainXaml = mainXaml.slice(0, insertPos) + `      ${`<ui:InvokeWorkflowFile DisplayName="Initialize All Settings" WorkflowFileName="InitAllSettings.xaml" />`}\n` + mainXaml.slice(insertPos);
            deferredWrites.set(mainXamlPath, mainXaml);
            console.log(`[UiPath] Injected InitAllSettings.xaml reference into tree-assembled ${mainWfName}.xaml`);
          }
        }
      }

      if (hasMain) {
        console.log(`[UiPath] Multi-workflow tree assembly complete: ${generatedWorkflowNames.size} workflow(s) assembled (${nonMainWorkflowNames.length} non-Main)`);
      }
    }

    if (enrichment?.decomposition?.length && !treeEnrichment) {
      console.log(`[UiPath] Using AI decomposition: ${enrichment.decomposition.length} sub-workflows`);
      for (const decomp of enrichment.decomposition) {
        const wfName = decomp.name.replace(/\s+/g, "_");
        if (priorCompliantMap.has(wfName)) {
          const priorContent = priorCompliantMap.get(wfName)!;
          deferredWrites.set(`${libPath}/${wfName}.xaml`, priorContent);
          generatedWorkflowNames.add(wfName);
          if (wfName === "Main") hasMain = true;
          xamlResults.push({ xaml: priorContent, gaps: [], usedPackages: ["UiPath.System.Activities"], variables: [] });
          console.log(`[UiPath] Reused prior compliant workflow "${wfName}" in decomposition — skipping regeneration`);
          continue;
        }
        const decompNodes = processNodes.filter((n: any) => decomp.nodeIds.includes(n.id));
        const decompEdges = processEdges.filter((e: any) =>
          decomp.nodeIds.includes(e.sourceNodeId) || decomp.nodeIds.includes(e.targetNodeId)
        );
        if (decompNodes.length > 0) {
          const result = tryGenerateOrStub(
            () => generateRichXamlFromNodes(decompNodes, decompEdges, wfName, decomp.description || "", enrichment, tf, apEnabled, genCtx),
            wfName,
            decomp.description || "",
          );
          if (result) {
            xamlResults.push(result);
            let decompCompliant: string;
            let decompComplianceFailed = false;
            try {
              decompCompliant = compliancePass(result.xaml, `${wfName}.xaml`);
            } catch (compErr: any) {
              decompComplianceFailed = true;
              console.warn(`[UiPath] Compliance pass failed for decomposed "${wfName}": ${compErr.message} — attempting structural preservation`);
              const spResult = tryStructuralPreservationOrStub(result.xaml, wfName, compErr.message);
              decompCompliant = spResult.content;
              complianceFallbacks.push({ file: `${wfName}.xaml`, reason: compErr.message, wasFullStub: spResult.wasFullStub });
            }
            deferredWrites.set(`${libPath}/${wfName}.xaml`, decompCompliant);
            generatedWorkflowNames.add(wfName);
            if (wfName === "Main" && !decompComplianceFailed) hasMain = true;
            console.log(`[UiPath] Generated decomposed workflow "${wfName}": ${decompNodes.length} nodes, ${result.gaps.length} gaps`);
          }
        } else {
          const specFallback = { name: decomp.name, description: decomp.description || "", steps: [] as Array<{ name: string; description: string }> };
          const result = tryGenerateOrStub(
            () => generateRichXamlFromSpec(specFallback, sddContent || undefined, undefined, tf, apEnabled, genCtx),
            wfName,
            decomp.description || "",
          );
          if (result) {
            xamlResults.push(result);
            let specCompliant: string;
            let specComplianceFailed = false;
            try {
              specCompliant = compliancePass(result.xaml, `${wfName}.xaml`);
            } catch (compErr: any) {
              specComplianceFailed = true;
              console.warn(`[UiPath] Compliance pass failed for spec-decomposed "${wfName}": ${compErr.message} — attempting structural preservation`);
              const spResult = tryStructuralPreservationOrStub(result.xaml, wfName, compErr.message);
              specCompliant = spResult.content;
              complianceFallbacks.push({ file: `${wfName}.xaml`, reason: compErr.message, wasFullStub: spResult.wasFullStub });
            }
            deferredWrites.set(`${libPath}/${wfName}.xaml`, specCompliant);
            generatedWorkflowNames.add(wfName);
            if (wfName === "Main" && !specComplianceFailed) hasMain = true;
            console.log(`[UiPath] Generated decomposed workflow "${wfName}" from spec (no matching nodes): ${result.gaps.length} gaps`);
          }
        }
      }
    }

    if (!treeEnrichment) {
      for (const wf of workflows) {
        const wfName = (wf.name || "Workflow").replace(/\s+/g, "_");
        if (generatedWorkflowNames.has(wfName)) continue;
        if (priorCompliantMap.has(wfName)) {
          const priorContent = priorCompliantMap.get(wfName)!;
          deferredWrites.set(`${libPath}/${wfName}.xaml`, priorContent);
          generatedWorkflowNames.add(wfName);
          if (wfName === "Main") hasMain = true;
          xamlResults.push({ xaml: priorContent, gaps: [], usedPackages: ["UiPath.System.Activities"], variables: [] });
          console.log(`[UiPath] Reused prior compliant workflow "${wfName}" — skipping regeneration`);
          continue;
        }
        const result = tryGenerateOrStub(
          () => generateRichXamlFromSpec(wf, sddContent || undefined, undefined, tf, apEnabled, genCtx),
          wfName,
          wf.name || "Workflow",
        );
        if (result) {
          xamlResults.push(result);
          let richCompliant: string;
          let richComplianceFailed = false;
          try {
            richCompliant = compliancePass(result.xaml, `${wfName}.xaml`);
          } catch (compErr: any) {
            richComplianceFailed = true;
            console.warn(`[UiPath] Compliance pass failed for rich XAML "${wfName}": ${compErr.message} — attempting structural preservation`);
            const spResult = tryStructuralPreservationOrStub(result.xaml, wfName, compErr.message);
            richCompliant = spResult.content;
            complianceFallbacks.push({ file: `${wfName}.xaml`, reason: compErr.message, wasFullStub: spResult.wasFullStub });
          }
          deferredWrites.set(`${libPath}/${wfName}.xaml`, richCompliant);
          generatedWorkflowNames.add(wfName);
          if (wfName === "Main" && !richComplianceFailed) hasMain = true;
          console.log(`[UiPath] Generated rich XAML for "${wfName}": ${result.gaps.length} gaps, ${result.usedPackages.length} packages`);
        }
      }
    } else {
      for (const wf of workflows) {
        const wfName = (wf.name || "Workflow").replace(/\s+/g, "_");
        if (generatedWorkflowNames.has(wfName)) continue;
        if (priorCompliantMap.has(wfName)) {
          const priorContent = priorCompliantMap.get(wfName)!;
          deferredWrites.set(`${libPath}/${wfName}.xaml`, priorContent);
          generatedWorkflowNames.add(wfName);
          if (wfName === "Main") hasMain = true;
          xamlResults.push({ xaml: priorContent, gaps: [], usedPackages: ["UiPath.System.Activities"], variables: [] });
          console.log(`[UiPath] Reused prior compliant workflow "${wfName}" — skipping regeneration`);
          continue;
        }
        const result = tryGenerateOrStub(
          () => generateRichXamlFromSpec(wf, sddContent || undefined, undefined, tf, apEnabled, genCtx),
          wfName,
          wf.name || "Workflow",
        );
        if (result) {
          xamlResults.push(result);
          let richCompliant: string;
          let remainingComplianceFailed = false;
          try {
            richCompliant = compliancePass(result.xaml, `${wfName}.xaml`);
          } catch (compErr: any) {
            remainingComplianceFailed = true;
            console.warn(`[UiPath] Compliance pass failed for remaining rich XAML "${wfName}": ${compErr.message} — attempting structural preservation`);
            const spResult = tryStructuralPreservationOrStub(result.xaml, wfName, compErr.message);
            richCompliant = spResult.content;
            complianceFallbacks.push({ file: `${wfName}.xaml`, reason: compErr.message, wasFullStub: spResult.wasFullStub });
          }
          deferredWrites.set(`${libPath}/${wfName}.xaml`, richCompliant);
          generatedWorkflowNames.add(wfName);
          if (wfName === "Main" && !remainingComplianceFailed) hasMain = true;
          console.log(`[UiPath] Generated remaining workflow "${wfName}" alongside tree-assembled workflows`);
        }
      }
    }

    if (!hasMain && processNodes.length > 0 && !enrichment?.decomposition?.length && !treeEnrichment) {
      const processFileName = useReFramework ? "Process" : projectName;
      const processResult = tryGenerateOrStub(
        () => generateRichXamlFromNodes(processNodes, processEdges, processFileName, pkg.description || "", enrichment, tf, apEnabled, genCtx),
        processFileName,
        pkg.description || "",
      );
      if (processResult) {
        xamlResults.push(processResult);
        let processCompliant: string;
        try {
          processCompliant = compliancePass(processResult.xaml, `${processFileName}.xaml`);
        } catch (compErr: any) {
          console.warn(`[UiPath] Compliance pass failed for process "${processFileName}": ${compErr.message} — attempting structural preservation`);
          const spResult = tryStructuralPreservationOrStub(processResult.xaml, processFileName, compErr.message);
          processCompliant = spResult.content;
          complianceFallbacks.push({ file: `${processFileName}.xaml`, reason: compErr.message, wasFullStub: spResult.wasFullStub });
        }
        deferredWrites.set(`${libPath}/${processFileName}.xaml`, processCompliant);
        console.log(`[UiPath] Generated process XAML from ${processNodes.length} map nodes: ${processResult.gaps.length} gaps`);
      }
    }

    const packageCredentialStrategy = determineCredentialStrategy(orchestratorArtifacts);
    console.log(`[UiPath] Package-level credential strategy determined: ${packageCredentialStrategy}`);
    const initXaml = buildDeterministicInitAllSettingsXaml(orchestratorArtifacts, tf, packageCredentialStrategy);
    deferredWrites.set(`${libPath}/InitAllSettings.xaml`, compliancePass(initXaml, "InitAllSettings.xaml"));

    if (useReFramework && !hasMain) {
      const preRefXamlLen = xamlEntries.length;
      const preRefReportsLen = analysisReports.length;
      const preRefBlockedLen = allPolicyBlocked.length;
      const refDeferredKeys = [
        `${libPath}/Main.xaml`,
        `${libPath}/GetTransactionData.xaml`,
        `${libPath}/SetTransactionStatus.xaml`,
        `${libPath}/CloseAllApplications.xaml`,
        `${libPath}/KillAllProcesses.xaml`,
      ];
      try {
        console.log(`[UiPath] Generating REFramework structure (queue: ${queueName})`);
        const mainXaml = generateReframeworkMainXaml(projectName, queueName, tf);
        deferredWrites.set(`${libPath}/Main.xaml`, compliancePass(mainXaml, "Main.xaml"));
        hasMain = true;

        const getTransXaml = generateGetTransactionDataXaml(queueName, tf);
        deferredWrites.set(`${libPath}/GetTransactionData.xaml`, compliancePass(getTransXaml, "GetTransactionData.xaml"));

        const setStatusXaml = generateSetTransactionStatusXaml(tf);
        deferredWrites.set(`${libPath}/SetTransactionStatus.xaml`, compliancePass(setStatusXaml, "SetTransactionStatus.xaml"));

        const closeAppsXaml = generateCloseAllApplicationsXaml(tf);
        deferredWrites.set(`${libPath}/CloseAllApplications.xaml`, compliancePass(closeAppsXaml, "CloseAllApplications.xaml"));

        const killXaml = generateKillAllProcessesXaml(tf);
        deferredWrites.set(`${libPath}/KillAllProcesses.xaml`, compliancePass(killXaml, "KillAllProcesses.xaml"));

        if (!deferredWrites.has(`${libPath}/Process.xaml`)) {
          const infrastructureFiles = new Set(["main", "initallsettings", "closeallapplications", "gettransactiondata", "settransactionstatus", "killallprocesses", "process"]);
          let processInvocations = "";
          const invokedInProcess = new Set<string>();
          if (enrichment?.decomposition?.length) {
            for (const decomp of enrichment.decomposition) {
              const wfName = decomp.name.replace(/\s+/g, "_");
              if (infrastructureFiles.has(wfName.toLowerCase())) continue;
              if (invokedInProcess.has(wfName)) continue;
              invokedInProcess.add(wfName);
              processInvocations += `
        <ui:InvokeWorkflowFile DisplayName="Run ${escapeXml(decomp.name)}" WorkflowFileName="${wfName}.xaml" />`;
            }
          }
          if (!processInvocations) {
            const processEntryWorkflows = chooseMainEntryWorkflowNames(generatedWorkflowNames, projectName)
              .filter(name => !infrastructureFiles.has(name.toLowerCase()));
            for (const gwfName of processEntryWorkflows) {
              if (invokedInProcess.has(gwfName)) continue;
              invokedInProcess.add(gwfName);
              processInvocations += `
        <ui:InvokeWorkflowFile DisplayName="Run ${escapeXml(gwfName)}" WorkflowFileName="${gwfName}.xaml" />`;
            }
          }
          if (!processInvocations) {
            processInvocations = `
        <ui:LogMessage DisplayName="Log Process Placeholder" Level="Info" Message="[&quot;Process transaction logic goes here&quot;]" />`;
          }
          const processXaml = buildXaml("Process", `${projectName} - Process Transaction`, processInvocations);
          deferredWrites.set(`${libPath}/Process.xaml`, compliancePass(processXaml, "Process.xaml"));
          console.log(`[UiPath] Generated Process.xaml wiring ${invokedInProcess.size} sub-workflow(s) for REFramework`);
        }
      } catch (reframeworkErr: any) {
        console.error(`[UiPath] REFramework compliance failed, falling back to simple linear Main.xaml: ${reframeworkErr.message}`);
        const rolledBackXaml = xamlEntries.length - preRefXamlLen;
        const rolledBackReports = analysisReports.length - preRefReportsLen;
        const rolledBackBlocked = allPolicyBlocked.length - preRefBlockedLen;
        xamlEntries.length = preRefXamlLen;
        analysisReports.length = preRefReportsLen;
        allPolicyBlocked.length = preRefBlockedLen;
        let rolledBackDeferred = 0;
        for (const key of refDeferredKeys) {
          if (deferredWrites.delete(key)) rolledBackDeferred++;
        }
        console.log(`[UiPath] REFramework rollback: removed ${rolledBackXaml} xamlEntries, ${rolledBackReports} analysisReports, ${rolledBackBlocked} allPolicyBlocked, ${rolledBackDeferred} deferredWrites keys`);
        hasMain = false;
        useReFramework = false;
      }
    }
    if (!hasMain) {
      let mainActivities = `
        <ui:InvokeWorkflowFile DisplayName="Initialize Settings" WorkflowFileName="InitAllSettings.xaml" />`;

      const invokedNames = new Set<string>();
      const isMainVariant = (name: string): boolean => {
        const normalized = name.replace(/\.xaml$/i, "").replace(/[_\s.]+/g, "").toLowerCase();
        return normalized === "main";
      };

      if (enrichment?.decomposition?.length) {
        for (const decomp of enrichment.decomposition) {
          const wfName = decomp.name.replace(/\s+/g, "_");
          if (isMainVariant(wfName)) continue;
          invokedNames.add(wfName);
          mainActivities += `
        <ui:InvokeWorkflowFile DisplayName="Run ${escapeXml(decomp.name)}" WorkflowFileName="${wfName}.xaml" />`;
        }
      }
      if (workflows.length > 0) {
        for (const wf of workflows) {
          const wfName = (wf.name || "Workflow").replace(/\s+/g, "_");
          if (isMainVariant(wfName)) continue;
          if (invokedNames.has(wfName)) continue;
          invokedNames.add(wfName);
          mainActivities += `
        <ui:InvokeWorkflowFile DisplayName="Run ${escapeXml(wf.name || wfName)}" WorkflowFileName="${wfName}.xaml" />`;
        }
      }

      if (invokedNames.size === 0 && processNodes.length > 0 && !isMainVariant(projectName)) {
        const entryWorkflowNames = chooseMainEntryWorkflowNames(generatedWorkflowNames, projectName);
        for (const entryName of entryWorkflowNames) {
          if (invokedNames.has(entryName)) continue;
          invokedNames.add(entryName);
          mainActivities += `
        <ui:InvokeWorkflowFile DisplayName="Run ${escapeXml(entryName)}" WorkflowFileName="${entryName}.xaml" />`;
        }
      } else if (invokedNames.size === 0) {
        mainActivities += `
        <ui:Comment DisplayName="Auto-generated by CannonBall" Text="This automation package was generated from the CannonBall pipeline. Open this project in UiPath Studio to build out the workflow logic." />`;
      }

      const closeAppsXaml = generateCloseAllApplicationsXaml(tf);
      deferredWrites.set(`${libPath}/CloseAllApplications.xaml`, compliancePass(closeAppsXaml, "CloseAllApplications.xaml"));

      mainActivities += `
        <ui:InvokeWorkflowFile DisplayName="Close All Applications" WorkflowFileName="CloseAllApplications.xaml" />`;
      mainActivities += `
        <ui:LogMessage Level="Info" Message="[&quot;Process completed successfully&quot;]" DisplayName="Log Completion" />`;

      let mainXaml = buildXaml("Main", `${projectName} - Main Workflow`, mainActivities);
      const selfRefBefore = mainXaml;
      mainXaml = mainXaml.replace(/<ui:InvokeWorkflowFile[^>]*WorkflowFileName\s*=\s*"(?:[.\/\\]*(?:lib[.\/\\])?)?Main\.xaml"[^>]*\/>/gi, "");
      if (mainXaml !== selfRefBefore) {
        console.warn(`[UiPath] Removed Main.xaml self-reference from simple Main fallback`);
      }
      deferredWrites.set(`${libPath}/Main.xaml`, compliancePass(mainXaml, "Main.xaml"));
    }

    {
      const existingFiles = new Set<string>();
      const prefix = libPath + "/";
      for (const [path] of deferredWrites) {
        if (path.endsWith(".xaml")) {
          const relPath = path.startsWith(prefix) ? path.slice(prefix.length) : (path.split("/").pop() || path);
          existingFiles.add(relPath);
        }
      }
      for (const entry of xamlEntries) {
        const relPath = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : (entry.name.split("/").pop() || entry.name);
        if (relPath.endsWith(".xaml")) existingFiles.add(relPath);
      }

      const referencedFiles = new Set<string>();
      for (const [path, content] of deferredWrites) {
        if (!path.endsWith(".xaml")) continue;
        const pattern = /WorkflowFileName="([^"]+)"/g;
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const ref = match[1].replace(/\\/g, "/").replace(/^[./]+/, "");
          referencedFiles.add(ref);
        }
      }
      for (const entry of xamlEntries) {
        const pattern = /WorkflowFileName="([^"]+)"/g;
        let match;
        while ((match = pattern.exec(entry.content)) !== null) {
          const ref = match[1].replace(/\\/g, "/").replace(/^[./]+/, "");
          referencedFiles.add(ref);
        }
      }

      let stubCount = 0;
      let retryCount = 0;
      for (const ref of referencedFiles) {
        if (!existingFiles.has(ref)) {
          const baseName = ref.split("/").pop() || ref;
          const className = baseName.replace(/\.xaml$/i, "");
          let generated = false;
          const matchingWfSpec = workflows.find(w => {
            const wfSanitized = (w.name || "").replace(/\s+/g, "_");
            return wfSanitized === className || w.name === className;
          });
          if (matchingWfSpec && matchingWfSpec.steps && matchingWfSpec.steps.length > 0) {
            try {
              const retryResult = tryGenerateOrStub(
                () => generateRichXamlFromSpec(matchingWfSpec, sddContent || undefined, undefined, tf, apEnabled, genCtx),
                className,
                matchingWfSpec.description || className,
              );
              if (retryResult) {
                let retryCompliant: string;
                try {
                  retryCompliant = compliancePass(retryResult.xaml, `${className}.xaml`);
                } catch (compErr: any) {
                  retryCompliant = tryStructuralPreservationOrStub(retryResult.xaml, className, compErr.message).content;
                }
                deferredWrites.set(`${libPath}/${ref}`, retryCompliant);
                existingFiles.add(ref);
                retryCount++;
                generated = true;
                console.log(`[Scaffold] Retry-generated XAML for missing referenced workflow: ${ref} (${matchingWfSpec.steps.length} steps)`);
              }
            } catch (retryErr: any) {
              console.log(`[Scaffold] Retry generation failed for ${ref}: ${retryErr.message} — falling back to stub`);
            }
          }
          if (!generated) {
            const stubXaml = buildXaml(className, `${className} - Stub Workflow`, `
        <ui:Comment DisplayName="TODO: Implement ${escapeXml(className)}" Text="This workflow was auto-generated as a stub. Open in UiPath Studio to implement the logic." />`);
            deferredWrites.set(`${libPath}/${ref}`, compliancePass(stubXaml, ref));
            existingFiles.add(ref);
            stubCount++;
            console.log(`[Scaffold] Generated stub XAML for referenced workflow: ${ref}`);
          }
        }
      }
      if (retryCount > 0) {
        console.log(`[Scaffold] Retry-generated ${retryCount} XAML file(s) for missing referenced workflows`);
      }
      if (stubCount > 0) {
        console.log(`[Scaffold] Generated ${stubCount} stub XAML file(s) for missing referenced workflows`);
      }
    }

    const prePruningXamlParts: string[] = xamlEntries.map(e => e.content);
    Array.from(deferredWrites.entries()).forEach(([path, content]) => {
      if (path.endsWith(".xaml")) {
        prePruningXamlParts.push(content);
      }
    });
    const prePruningXamlContent = prePruningXamlParts.join("\n");

    {
      const mainDeferredKey = Array.from(deferredWrites.keys()).find(k => (k.split("/").pop() || k) === "Main.xaml");
      const mainContent = mainDeferredKey ? deferredWrites.get(mainDeferredKey) || "" : "";
      const mainIsFullStub = earlyStubFallbacks.includes("Main.xaml") ||
        mainContent.includes("STUB_BLOCKING_FALLBACK") || mainContent.includes("STUB: Main") ||
        complianceFallbacks.some(fb => (fb.file === "Main.xaml" || fb.file === "Process.xaml") && fb.wasFullStub);

      const subWorkflowCount = Array.from(generatedWorkflowNames).filter(n => n !== "Main" && n !== "Process").length;
      const mainHasInvokeRefs = mainContent.includes("InvokeWorkflowFile");
      const mainIsFunctionallyEmpty = !mainHasInvokeRefs && subWorkflowCount > 0 && (() => {
        const bodyOnlyPlaceholders = (() => {
          const activityPattern = /<([\w:]+)\s[^>]*DisplayName="[^"]*"/g;
          const activities: string[] = [];
          let m;
          while ((m = activityPattern.exec(mainContent)) !== null) {
            const tag = m[1].replace(/^[a-zA-Z]+:/, "");
            if (tag !== "Sequence" && tag !== "Variable") activities.push(tag);
          }
          const placeholderTags = new Set(["LogMessage", "Comment", "WriteLine"]);
          return activities.length > 0 && activities.every(a => placeholderTags.has(a));
        })();

        const hasFallbackMarkers = mainContent.includes("TODO:") || mainContent.includes("STUB") ||
          mainContent.includes("Placeholder") || mainContent.includes("stub");

        const varMatches = mainContent.match(/<Variable\s/g);
        const varCount = varMatches ? varMatches.length : 0;
        const activityMatches = mainContent.match(/<([\w:]+)\s[^>]*DisplayName="/g);
        const activityCount = activityMatches ? activityMatches.length : 0;
        const triviallyLowActivities = varCount > 5 && activityCount <= Math.max(3, Math.floor(varCount / 10));

        return bodyOnlyPlaceholders || hasFallbackMarkers || triviallyLowActivities;
      })();

      if (mainIsFunctionallyEmpty && !mainIsFullStub) {
        console.log(`[UiPath] Main.xaml is functionally empty (no InvokeWorkflowFile refs, ${subWorkflowCount} sub-workflows exist) — injecting references and skipping reachability pruning`);
      }

      const mainHadFallback = mainIsFullStub || mainIsFunctionallyEmpty ||
        complianceFallbacks.some(fb => fb.file === "Main.xaml" || fb.file === "Process.xaml");
      const processDeferredKeyForCheck = Array.from(deferredWrites.keys()).find(k => (k.split("/").pop() || k) === "Process.xaml");
      const processContent = processDeferredKeyForCheck ? deferredWrites.get(processDeferredKeyForCheck) || "" : "";
      const processIsFullStub = earlyStubFallbacks.includes("Process.xaml") ||
        processContent.includes("STUB_BLOCKING_FALLBACK") || processContent.includes("STUB: Process") ||
        complianceFallbacks.some(fb => fb.file === "Process.xaml" && fb.wasFullStub);
      const processHadFallback = processIsFullStub ||
        complianceFallbacks.some(fb => fb.file === "Process.xaml");
      if ((mainIsFullStub || mainIsFunctionallyEmpty) && mainDeferredKey) {
        let stubbedMainXaml = deferredWrites.get(mainDeferredKey) || "";
        const entryWorkflowNames = chooseMainEntryWorkflowNames(
          [...nonMainWorkflowNames, ...Array.from(generatedWorkflowNames).filter(n => n !== "Main" && n !== "Process")],
          projectName,
        );
        const invokeRefsToInject: string[] = [];
        if (!stubbedMainXaml.includes('WorkflowFileName="InitAllSettings.xaml"')) {
          invokeRefsToInject.push(`      <ui:InvokeWorkflowFile DisplayName="Initialize All Settings" WorkflowFileName="InitAllSettings.xaml" />`);
        }
        for (const subWfName of entryWorkflowNames) {
          const subFileName = `${subWfName}.xaml`;
          if (!stubbedMainXaml.includes(`WorkflowFileName="${subFileName}"`)) {
            invokeRefsToInject.push(`      <ui:InvokeWorkflowFile DisplayName="${subWfName}" WorkflowFileName="${subFileName}" />`);
          }
        }
        if (invokeRefsToInject.length > 0) {
          const seqVarsEndMatch = stubbedMainXaml.match(/<\/Sequence\.Variables>\s*\n/);
          const rootSeqMatch = stubbedMainXaml.match(/<Sequence\s[^>]*DisplayName="[^"]*"[^>]*>\s*\n/);
          const insertMatch = seqVarsEndMatch || rootSeqMatch;
          if (insertMatch) {
            const insertPos = insertMatch.index! + insertMatch[0].length;
            stubbedMainXaml = stubbedMainXaml.slice(0, insertPos) + invokeRefsToInject.join("\n") + "\n" + stubbedMainXaml.slice(insertPos);
            deferredWrites.set(mainDeferredKey, stubbedMainXaml);
            const existingIdx = xamlEntries.findIndex(e => {
              const bn = e.name.split("/").pop() || e.name;
              return bn === "Main.xaml";
            });
            if (existingIdx >= 0) {
              xamlEntries[existingIdx] = { name: xamlEntries[existingIdx].name, content: stubbedMainXaml };
            }
            console.log(`[UiPath] Injected ${invokeRefsToInject.length} InvokeWorkflowFile reference(s) into stubbed Main.xaml using entry workflow selection`);
          }
        }
      }
      if (processIsFullStub) {
        const processDeferredKey = Array.from(deferredWrites.keys()).find(k => (k.split("/").pop() || k) === "Process.xaml");
        if (processDeferredKey) {
          let stubbedProcessXaml = deferredWrites.get(processDeferredKey) || "";
          const processWorkflowNames = Array.from(generatedWorkflowNames).filter(n => n !== "Main" && n !== "Process" && n !== "InitAllSettings");
          const processInvokeRefs: string[] = [];
          for (const subWfName of processWorkflowNames) {
            const subFileName = `${subWfName}.xaml`;
            if (!stubbedProcessXaml.includes(`WorkflowFileName="${subFileName}"`)) {
              processInvokeRefs.push(`      <ui:InvokeWorkflowFile DisplayName="Run ${subWfName}" WorkflowFileName="${subFileName}" />`);
            }
          }
          if (processInvokeRefs.length > 0) {
            const seqVarsEndMatch = stubbedProcessXaml.match(/<\/Sequence\.Variables>\s*\n/);
            const rootSeqMatch = stubbedProcessXaml.match(/<Sequence\s[^>]*DisplayName="[^"]*"[^>]*>\s*\n/);
            const insertMatch = seqVarsEndMatch || rootSeqMatch;
            if (insertMatch) {
              const insertPos = insertMatch.index! + insertMatch[0].length;
              stubbedProcessXaml = stubbedProcessXaml.slice(0, insertPos) + processInvokeRefs.join("\n") + "\n" + stubbedProcessXaml.slice(insertPos);
              deferredWrites.set(processDeferredKey, stubbedProcessXaml);
              const existingIdx = xamlEntries.findIndex(e => {
                const bn = e.name.split("/").pop() || e.name;
                return bn === "Process.xaml";
              });
              if (existingIdx >= 0) {
                xamlEntries[existingIdx] = { name: xamlEntries[existingIdx].name, content: stubbedProcessXaml };
              }
              console.log(`[UiPath] Injected ${processInvokeRefs.length} InvokeWorkflowFile reference(s) into stubbed Process.xaml to preserve invocation graph`);
            }
          }
        }
      }
      if (mainHadFallback || processHadFallback) {
        console.log(`[Structural Dedup] ${mainHadFallback ? "Main.xaml" : ""}${mainHadFallback && processHadFallback ? " and " : ""}${processHadFallback ? "Process.xaml" : ""} had fallback — skipping reachability pruning to preserve child workflows`);
        const { graph } = buildReachabilityGraph(deferredWrites, xamlEntries, libPath);
        Array.from(graph.entries()).forEach(([file, refs]) => {
          if (refs.length > 0) {
            console.log(`[Structural Dedup] ${file} -> ${refs.join(", ")}`);
          }
        });
      } else {
        console.log(`[Structural Dedup] Building reachability graph from Main.xaml entry point...`);
        const { reachable, unreachable, graph } = buildReachabilityGraph(deferredWrites, xamlEntries, libPath);
        console.log(`[Structural Dedup] Reachability analysis: ${reachable.size} reachable, ${unreachable.size} unreachable out of ${reachable.size + unreachable.size} total XAML files`);

        if (unreachable.size > 0) {
          const { trulyOrphaned, specRetained } = filterUnreachableBySpecDecomposition(unreachable, generatedWorkflowNames);

          if (specRetained.size > 0) {
            console.log(`[Structural Dedup] Retained ${specRetained.size} spec-decomposed workflow(s) despite being unreachable from fallback Main.xaml: ${Array.from(specRetained).join(", ")}`);
            Array.from(specRetained).forEach(retained => {
              dependencyWarnings.push({
                code: "SPEC_WORKFLOW_NOT_WIRED",
                message: `"${retained}" was generated from spec decomposition but is not reachable from current Main.xaml — flagged as "generated but not wired"`,
                stage: "structural-deduplication",
                recoverable: true,
              });
            });
          }

          if (trulyOrphaned.size > 0) {
            const { removedFiles, reasons } = removeUnreachableFiles(deferredWrites, xamlEntries, trulyOrphaned, libPath);
            for (const reason of reasons) {
              console.log(`[Structural Dedup] ${reason}`);
              dependencyWarnings.push({
                code: "STRUCTURAL_DEDUP_REMOVED",
                message: reason,
                stage: "structural-deduplication",
                recoverable: true,
              });
            }
            console.log(`[Structural Dedup] Removed ${removedFiles.length} truly orphaned file(s): ${removedFiles.join(", ")}`);
          } else {
            console.log(`[Structural Dedup] All unreachable files are spec-decomposed — no files removed`);
          }
        } else {
          console.log(`[Structural Dedup] All XAML files are reachable from Main.xaml — no orphaned files detected`);
        }

        Array.from(graph.entries()).forEach(([file, refs]) => {
          if (refs.length > 0) {
            console.log(`[Structural Dedup] ${file} -> ${refs.join(", ")}`);
          }
        });
      }
    }

    {
      const credResult = reconcileCredentialStrategy(deferredWrites, xamlEntries, packageCredentialStrategy);
      if (credResult.reconciled) {
        for (const warning of credResult.warnings) {
          dependencyWarnings.push({
            code: "CREDENTIAL_STRATEGY_RECONCILED",
            message: warning,
            stage: "credential-reconciliation",
            recoverable: true,
          });
        }
        console.log(`[Credential Reconciliation] Reconciled to strategy: ${credResult.strategy}`);
      } else if (credResult.strategy !== "none") {
        console.log(`[Credential Reconciliation] Consistent strategy detected: ${credResult.strategy}`);
      }
    }

    const configCsv = generateConfigXlsx(projectName, sddContent || undefined, orchestratorArtifacts);
    archive.append(configCsv, { name: `${libPath}/Data/Config.xlsx` });

    const allXamlParts: string[] = xamlEntries.map(e => e.content);
    Array.from(deferredWrites.entries()).forEach(([path, content]) => {
      if (path.endsWith(".xaml")) {
        allXamlParts.push(content);
      }
    });
    const allXamlContent = allXamlParts.join("\n");
    const depAlignmentXamlContent = prePruningXamlContent;
    const scannedPackages = scanXamlForRequiredPackages(depAlignmentXamlContent);

    {
      const DEPENDENCY_SAFE_LIST = new Set([
        "UiPath.System.Activities",
        "UiPath.Excel.Activities",
        "UiPath.Mail.Activities",
        "UiPath.Testing.Activities",
      ]);

      if (tf === "Windows") {
        DEPENDENCY_SAFE_LIST.add("UiPath.UIAutomation.Activities");
      }

      for (const [prefix, pkgName] of Object.entries(NAMESPACE_PREFIX_TO_PACKAGE)) {
        const prefixPattern = new RegExp(`<${prefix}:[A-Za-z]+[\\s/>]`);
        if (prefixPattern.test(depAlignmentXamlContent)) {
          DEPENDENCY_SAFE_LIST.add(pkgName);
          console.log(`[Dependency Alignment] Dynamically added ${pkgName} to safe list — namespace prefix "${prefix}:" detected in XAML`);
        }
      }

      const usedPackages = new Set(Array.from(scannedPackages));
      usedPackages.add("UiPath.System.Activities");

      const nsAndAsmPackages = extractXamlNamespaceAndAssemblyPackages(depAlignmentXamlContent);
      for (const pkg of nsAndAsmPackages) {
        usedPackages.add(pkg);
      }

      try {
        const { catalogService } = await import("./catalog/catalog-service");
        if (catalogService.isLoaded()) {
          const activityTagPattern = /<([a-zA-Z]+):([A-Za-z]+)[\s/>]/g;
          let actMatch;
          while ((actMatch = activityTagPattern.exec(depAlignmentXamlContent)) !== null) {
            const activityTag = actMatch[2];
            const catalogPkg = catalogService.getPackageForActivity(activityTag);
            if (catalogPkg && !usedPackages.has(catalogPkg)) {
              usedPackages.add(catalogPkg);
              console.log(`[Dependency Alignment] Catalog-based addition: ${catalogPkg} — activity "${activityTag}" found in XAML`);
            }
          }
        }
      } catch (catalogErr: any) {
        console.log(`[Dependency Alignment] Catalog-based dependency resolution skipped: ${catalogErr.message}`);
      }

      for (const safePkg of DEPENDENCY_SAFE_LIST) {
        if (deps[safePkg] && !usedPackages.has(safePkg)) {
          console.log(`[Dependency Alignment] Safe list preserved dependency: ${safePkg} — would have been pruned without safe list`);
        }
        usedPackages.add(safePkg);
      }

      const hasStubbedWorkflows = earlyStubFallbacks.length > 0 || complianceFallbacks.some(fb => fb.wasFullStub);
      let stubbedWorkflowActivityPackages: Set<string> | null = null;
      if (hasStubbedWorkflows) {
        stubbedWorkflowActivityPackages = new Set<string>();
        const stubbedFileNames = new Set([
          ...earlyStubFallbacks,
          ...complianceFallbacks.filter(fb => fb.wasFullStub).map(fb => fb.file),
        ]);
        if (allTreeEnrichments && allTreeEnrichments.size > 0) {
          for (const [wfName, entry] of allTreeEnrichments.entries()) {
            const wfFile = `${wfName}.xaml`;
            if (stubbedFileNames.has(wfFile)) {
              const templates = collectActivityTemplatesFromSpec(entry.spec);
              for (const template of templates) {
                const pkg = catalogService.getPackageForActivity(template) || getActivityPackage(template) || null;
                if (pkg) {
                  stubbedWorkflowActivityPackages.add(normalizePackageName(pkg));
                }
              }
            }
          }
        }
      }
      const unusedDeps: string[] = [];
      for (const pkgName of Object.keys(deps)) {
        if (!usedPackages.has(pkgName)) {
          unusedDeps.push(pkgName);
        }
      }
      const proactiveRemovals: string[] = [];
      for (const pkgName of unusedDeps) {
        if (hasStubbedWorkflows && specPredictedPackages.has(pkgName) && !proactivelyResolvedPackages.has(pkgName)) {
          const hasActivityEvidence = stubbedWorkflowActivityPackages ? stubbedWorkflowActivityPackages.has(pkgName) : true;
          if (hasActivityEvidence) {
            console.log(`[Dependency Alignment] Preserving spec-predicted dependency ${pkgName} — stubbed workflows reference activities from this package`);
            continue;
          }
          console.log(`[Dependency Alignment] Removing spec-predicted dependency ${pkgName} — no concrete activity evidence from stubbed workflows`);
        }
        delete deps[pkgName];
        if (proactivelyResolvedPackages.has(pkgName) || specPredictedPackages.has(pkgName)) {
          proactiveRemovals.push(pkgName);
          console.log(`[Dependency Alignment] Silently removing proactively-resolved dependency: ${pkgName} — predicted from spec but not used in emitted XAML`);
        } else {
          console.log(`[Dependency Alignment] Removing unused dependency: ${pkgName} — not referenced in any emitted XAML (activity tags, namespace imports, or assembly references)`);
          dependencyWarnings.push({
            code: "DEPENDENCY_UNUSED_REMOVED",
            message: `Package ${pkgName} was in dependencies but not referenced in any emitted XAML (activity tags, namespace imports, assembly references, TypeArguments, or expressions) — removed`,
            stage: "dependency-alignment",
            recoverable: true,
          });
        }
      }
      if (unusedDeps.length > 0) {
        console.log(`[Dependency Alignment] Removed ${unusedDeps.length} unused dependenc(ies): ${unusedDeps.join(", ")}${proactiveRemovals.length > 0 ? ` (${proactiveRemovals.length} silently from proactive resolution)` : ""}`);
      }

      const BASELINE_PACKAGES: Record<string, boolean> = {
        "UiPath.System.Activities": true,
        "UiPath.Excel.Activities": true,
      };
      if (tf === "Windows") {
        BASELINE_PACKAGES["UiPath.UIAutomation.Activities"] = true;
      }
      for (const baselinePkg of Object.keys(BASELINE_PACKAGES)) {
        if (!deps[baselinePkg]) {
          let version: string | null = null;
          const preferred = getPreferredVersionFromMeta(baselinePkg);
          if (preferred) {
            version = preferred;
          } else if (catalogService.isLoaded()) {
            const catalogVersion = catalogService.getPreferredVersion(baselinePkg);
            if (catalogVersion) version = catalogVersion;
          }
          if (!version) {
            const fallback = getBaselineFallbackVersion(baselinePkg, tf as "Windows" | "Portable");
            if (fallback) version = fallback;
          }
          if (version) {
            deps[baselinePkg] = version;
            console.log(`[Dependency Enforcement] Re-added baseline package ${baselinePkg}@${version} after alignment pruned it`);
          }
        }
      }
    }
    for (const rawPkgName of scannedPackages) {
      const pkgName = normalizePackageName(rawPkgName);
      if (deps[pkgName]) continue;
      if (isFrameworkAssembly(pkgName)) {
        console.log(`[Dependency CrossCheck] Rejected framework assembly from XAML scan: ${pkgName}`);
        continue;
      }
      let resolved = false;
      if (catalogService.isLoaded()) {
        const catalogVersion = catalogService.getPreferredVersion(pkgName);
        if (catalogVersion) {
          deps[pkgName] = catalogVersion;
          dependencyWarnings.push({
            code: "DEPENDENCY_DISCOVERED_IN_XAML",
            message: `Package ${pkgName} was not resolved proactively but was discovered in emitted XAML — added from catalog preferred version (v${catalogVersion}). This indicates a gap in the activity catalog mapping.`,
            stage: "dependency-crosscheck",
            recoverable: true,
          });
          console.warn(`[Dependency CrossCheck] Gap detected: ${pkgName} found in XAML but not in proactive resolution — added from catalog preferred v${catalogVersion}`);
          resolved = true;
        }
      }
      if (!resolved) {
        const fallback = getBaselineFallbackVersion(pkgName, tf as "Windows" | "Portable");
        if (fallback) {
          deps[pkgName] = fallback;
          dependencyWarnings.push({
            code: "DEPENDENCY_DISCOVERED_IN_XAML",
            message: `Package ${pkgName} was discovered in emitted XAML but not in catalog — using validated metadata service version ${fallback}`,
            stage: "dependency-crosscheck",
            recoverable: true,
          });
          console.warn(`[Dependency CrossCheck] Using validated metadata service version for ${pkgName}: ${fallback}`);
        } else {
          const xamlFiles = xamlEntries
            ? xamlEntries.filter((e: { name: string; content: string }) => e.content.includes(pkgName)).map((e: { name: string; content: string }) => e.name)
            : [];
          const xamlContext = xamlFiles.length ? ` Found in XAML files: [${xamlFiles.join(", ")}].` : "";
          const layersChecked = [
            catalogService.isLoaded() ? "activity-catalog (getPreferredVersion): no match" : "activity-catalog: not loaded",
            "generation-metadata (getBaselineFallbackVersion): no match",
          ].join("; ");
          throw new Error(
            `[Dependency CrossCheck] FATAL: Package "${pkgName}" is referenced in emitted XAML but has no validated version.${xamlContext} ` +
            `Authority layers checked: [${layersChecked}]. ` +
            `Cannot emit a fabricated version — build aborted. Add this package to the generation-metadata.json packageVersionRanges or activity catalog to resolve.`
          );
        }
      }
    }

    validateAndEnforceDependencyCompatibility(deps, dependencyWarnings);

    {
      const feedValidationIssues: string[] = [];
      const allReferencedPackages = new Set(Array.from(scannedPackages));
      const nsAndAsmPkgs = extractXamlNamespaceAndAssemblyPackages(depAlignmentXamlContent);
      nsAndAsmPkgs.forEach(p => allReferencedPackages.add(p));
      for (const [pkgName, version] of Object.entries(deps)) {
        const versionRange = _metadataService.getPackageVersionRange(pkgName);
        if (!versionRange) {
          const referencedInXaml = allReferencedPackages.has(pkgName) || scannedPackages.has(pkgName);
          if (referencedInXaml) {
            feedValidationIssues.push(`${pkgName}@${version}`);
            dependencyWarnings.push({
              code: "DEPENDENCY_VERSION_UNVERIFIED",
              message: `Package ${pkgName}@${version} has no verified metadata entry — version may not exist on any NuGet feed. Workflows referencing this package may fail to restore.`,
              stage: "dependency-feed-validation",
              recoverable: false,
            });
            console.warn(`[Dependency Feed Validation] UNVERIFIED: ${pkgName}@${version} — no metadata entry, version existence cannot be confirmed`);
          }
          continue;
        }
        const cleanVersion = extractExactVersion(version);
        if (cleanVersion !== versionRange.preferred) {
          feedValidationIssues.push(`${pkgName}@${version} (preferred: ${versionRange.preferred})`);
          dependencyWarnings.push({
            code: "DEPENDENCY_VERSION_MISMATCH",
            message: `Package ${pkgName} resolved to ${version} but preferred verified version is ${versionRange.preferred} (source: ${versionRange.verificationSource}) — version may be stale`,
            stage: "dependency-feed-validation",
            recoverable: true,
          });
          console.warn(`[Dependency Feed Validation] VERSION MISMATCH: ${pkgName}@${version} vs preferred ${versionRange.preferred}`);
        }
        if (versionRange.verificationSource === "studio-bundled") {
          const catalogVersion = catalogService.isLoaded() ? catalogService.getPreferredVersion(pkgName) : null;
          if (catalogVersion && catalogVersion !== versionRange.preferred) {
            dependencyWarnings.push({
              code: "DEPENDENCY_STUDIO_BUNDLED_STALE",
              message: `Package ${pkgName}@${versionRange.preferred} uses studio-bundled version but catalog suggests ${catalogVersion} — consider verifying against NuGet feed`,
              stage: "dependency-feed-validation",
              recoverable: true,
            });
            console.warn(`[Dependency Feed Validation] STUDIO-BUNDLED STALE: ${pkgName}@${versionRange.preferred} — catalog suggests ${catalogVersion}`);
          }
        }
      }
      const unverifiedBlockingPkgs = dependencyWarnings.filter(w => w.code === "DEPENDENCY_VERSION_UNVERIFIED");
      if (unverifiedBlockingPkgs.length > 0) {
        const unverifiedNames = unverifiedBlockingPkgs.map(w => w.message.split(" ")[1] || "unknown").join(", ");
        console.error(`[Dependency Feed Validation] BLOCKING: ${unverifiedBlockingPkgs.length} XAML-referenced package(s) have no verified metadata: ${unverifiedNames}`);
        throw new Error(
          `Dependency feed validation failed: ${unverifiedBlockingPkgs.length} XAML-referenced package(s) have unverified versions that may not exist on any NuGet feed. Affected: ${feedValidationIssues.filter(i => !i.includes("preferred")).join(", ")}`
        );
      }
      if (feedValidationIssues.length > 0) {
        console.log(`[Dependency Feed Validation] ${feedValidationIssues.length} package(s) flagged (non-blocking): ${feedValidationIssues.join(", ")}`);
      } else {
        console.log(`[Dependency Feed Validation] All ${Object.keys(deps).length} package versions verified against metadata`);
      }
    }

    const allGaps = aggregateGaps(xamlResults);

    const entryPointId = generateUuid();
    const _metaTarget = _metadataService.getStudioTarget();
    if (!_studioProfile && !_metaTarget) {
      console.error("[PackageAssembler] DEGRADED MODE: No StudioProfile or MetadataService target available. Package metadata will be incomplete — this indicates a startup failure in MetadataService.");
    }
    const studioVer = _studioProfile?.studioVersion || _metaTarget?.version;
    if (!studioVer) {
      throw new Error("Cannot assemble package: Studio version is unavailable. MetadataService and StudioProfile both failed to load.");
    }
    const validatedStudioVer = isVersionFromValidatedSource(_studioProfile, _metaTarget);
    if (!validatedStudioVer) {
      throw new Error(
        `Cannot assemble package: Studio version "${studioVer}" is not from a validated source. ` +
        `Ensure generation-metadata.json is properly configured with a valid studioVersion.`
      );
    }
    if (validatedStudioVer !== studioVer) {
      console.warn(`[Studio Version] Using validated version ${validatedStudioVer} instead of derived version ${studioVer}`);
    }
    const projectJson: Record<string, any> = {
      name: projectName,
      description: pkg.description || "",
      main: "Main.xaml",
      dependencies: deps,
      webServices: [],
      entitiesStores: [],
      schemaVersion: "4.0",
      studioVersion: validatedStudioVer,
      projectVersion: version,
      runtimeOptions: {
        autoDispose: false,
        netFrameworkLazyLoading: false,
        isPausable: true,
        isAttended: false,
        requiresUserInteraction: false,
        supportsPersistence: false,
        executionType: "Workflow",
        readyForPiP: false,
        startsInPiP: false,
        mustRestoreAllDependencies: true,
      },
      designOptions: {
        projectProfile: "Development",
        outputType: "Process",
        libraryOptions: { includeOriginalXaml: false, privateWorkflows: [] },
        processOptions: { ignoredFiles: [] },
        fileInfoCollection: [],
        modernBehavior: true,
      },
      expressionLanguage: resolveExpressionLanguage(_studioProfile, _metaTarget),
      entryPoints: [
        {
          filePath: "Main.xaml",
          uniqueId: entryPointId,
          input: [],
          output: [],
        },
      ],
      isTemplate: false,
      templateProjectData: {},
      publishData: {},
    };
    if (_studioProfile) {
      projectJson.targetFramework = _studioProfile.targetFramework;
      projectJson.sourceLanguage = _studioProfile.expressionLanguage;
    } else if (_metaTarget) {
      projectJson.targetFramework = _metaTarget.targetFramework;
      projectJson.sourceLanguage = _metaTarget.expressionLanguage;
    } else if (isServerless) {
      projectJson.targetFramework = "Portable";
      projectJson.sourceLanguage = "CSharp";
    }
    if (apEnabled) {
      projectJson.designOptions.autopilotEnabled = true;
      projectJson.designOptions.selfHealingSelectors = true;
    }
    sanitizeDeps(deps);

    for (const [key, val] of Object.entries(deps)) {
      if (!isValidNuGetVersion(val)) {
        console.log(`[UiPath Final Check] Removing invalid dependency after sanitize: ${key}=${val}`);
        delete deps[key];
      }
    }

    {
      const nsCoverageWarnings = validateNamespaceCoverage(allXamlContent, deps);
      const autoAddedPackages = new Set<string>();
      for (const warning of nsCoverageWarnings) {
        const pkgMatch = warning.match(/\(package: ([^)]+)\)/);
        if (pkgMatch) {
          const missingPkg = pkgMatch[1];
          if (!deps[missingPkg] && !isFrameworkAssembly(missingPkg)) {
            let version: string | null = null;
            if (catalogService.isLoaded()) {
              version = catalogService.getPreferredVersion(missingPkg);
            }
            if (!version) {
              version = getBaselineFallbackVersion(missingPkg, tf as "Windows" | "Portable");
            }
            if (version) {
              deps[missingPkg] = version;
              autoAddedPackages.add(missingPkg);
              console.log(`[Namespace Coverage] Auto-added missing dependency ${missingPkg}@${version} to satisfy namespace/assembly reference`);
            }
          }
        }
      }
      for (const warning of nsCoverageWarnings) {
        const pkgMatch = warning.match(/\(package: ([^)]+)\)/);
        if (pkgMatch && autoAddedPackages.has(pkgMatch[1])) {
          continue;
        }
        console.warn(`[Namespace Coverage] ${warning}`);
        dependencyWarnings.push({
          code: "NAMESPACE_MISSING_DEPENDENCY",
          message: warning,
          stage: "namespace-coverage-validation",
          recoverable: true,
        });
      }
    }

    const projectJsonStr = JSON.stringify(projectJson, null, 2);
    const parsedCheck = JSON.parse(projectJsonStr);
    if (parsedCheck.dependencies) {
      for (const [key, val] of Object.entries(parsedCheck.dependencies as Record<string, string>)) {
        if (typeof val === "string" && (val.includes("*") || !isValidNuGetVersion(val))) {
          console.error(`[UiPath JSON Check] Found invalid version in serialized project.json: ${key}=${val}, removing`);
          delete deps[key];
        }
      }
    }

    const allUsedPkgs = Object.keys(deps);

    const workflowNames: string[] = [];
    if (useReFramework) {
      workflowNames.push("Main", "GetTransactionData", "Process", "SetTransactionStatus", "CloseAllApplications", "KillAllProcesses");
    }
    if (enrichment?.decomposition?.length) {
      for (const d of enrichment.decomposition) {
        const n = d.name.replace(/\s+/g, "_");
        if (!workflowNames.includes(n)) workflowNames.push(n);
      }
    }
    for (const wf of workflows) {
      const n = (wf.name || "Workflow").replace(/\s+/g, "_");
      if (!workflowNames.includes(n)) workflowNames.push(n);
    }
    if (!workflowNames.includes("Main")) workflowNames.unshift("Main");
    if (!workflowNames.includes(projectName) && processNodes.length > 0 && !enrichment?.decomposition?.length && !useReFramework) {
      workflowNames.push(projectName);
    }

    const painPoints = processNodes
      .filter((n: any) => n.isPainPoint)
      .map((n: any) => ({ name: n.name, description: n.description || "" }));

    for (const pb of allPolicyBlocked) {
      for (const act of pb.activities) {
        collectedQualityIssues.push({
          severity: "warning",
          file: pb.file,
          check: "activity-policy-blocked",
          detail: `Activity ${act} was blocked by ${generationMode} mode activity policy`,
        });
      }
    }

    console.log(`[UiPath] DHG generation deferred until after quality gate processing`);

    const preArchiveViolations = validateXamlContent(xamlEntries);

    const missingFileViolations = preArchiveViolations.filter(v => v.check === "invoked-file");
    const stubsGenerated: string[] = [];
    if (missingFileViolations.length > 0) {
      const missingFiles = new Set<string>();
      for (const v of missingFileViolations) {
        const m = v.detail.match(/references "([^"]+)"/);
        if (m) missingFiles.add(m[1]);
      }
      for (const rawMissingFile of Array.from(missingFiles)) {
        const missingFile = rawMissingFile.replace(/\\/g, "/").replace(/^[./]+/, "");
        const stubXaml = generateStubWorkflow(missingFile);
        const stubCompliant = compliancePass(stubXaml, missingFile, true);
        deferredWrites.set(`${libPath}/${missingFile}`, stubCompliant);
        xamlEntries.push({ name: missingFile, content: stubCompliant });
        stubsGenerated.push(missingFile);
        console.log(`[UiPath Validation] Generated stub workflow for missing file: ${missingFile} (tracked in xamlEntries)`);
      }
    }

    const manifestBasenames = new Set(_archiveManifestTracker.filter(p => p.endsWith(".xaml")).map(p => p.split("/").pop() || p));
    const entryBasenames = new Set(xamlEntries.map(e => (e.name.split("/").pop() || e.name)));
    for (const mb of manifestBasenames) {
      if (!entryBasenames.has(mb)) {
        const stubXaml = generateStubWorkflow(mb.replace(".xaml", ""));
        const stubCompliant = compliancePass(stubXaml, mb, true);
        deferredWrites.set(`${libPath}/${mb}`, stubCompliant);
        xamlEntries.push({ name: mb, content: stubCompliant });
        stubsGenerated.push(mb);
        console.log(`[UiPath Pre-Package Check] Archive manifest had ${mb} without validated entry — generated stub`);
      }
    }
    const placeholderCleanupRepairs: { repairCode: "REPAIR_PLACEHOLDER_CLEANUP"; file: string; description: string; developerAction: string; estimatedEffortMinutes: number }[] = [];
    for (let i = 0; i < xamlEntries.length; i++) {
      const content = xamlEntries[i].content;
      if (content.includes("PLACEHOLDER_") || content.includes("TODO_")) {
        const placeholderCount = (content.match(/PLACEHOLDER_|TODO_/g) || []).length;
        const commentReplacement = '<ui:Comment Text="REVIEW: Unknown activity type was generated here — implement manually" />';
        const afterTagSafety = content
          .replace(/<(ui:)?(?:TODO_|PLACEHOLDER_)(\w+)\b[^>]*?>[\s\S]*?<\/\1?(?:TODO_|PLACEHOLDER_)\2>/g, commentReplacement)
          .replace(/<(ui:)?(?:TODO_|PLACEHOLDER_)\w+\b[^>]*?\/>/g, commentReplacement);
        const cleaned = afterTagSafety
          .replace(/\[(?:PLACEHOLDER_\w*|TODO_\w*)\]/g, '[Nothing]')
          .replace(/="(?:PLACEHOLDER_\w*|TODO_\w*)"/g, '="[Nothing]"')
          .replace(/PLACEHOLDER_\w*/g, '')
          .replace(/TODO_\w*/g, '');
        xamlEntries[i] = { ...xamlEntries[i], content: cleaned };
        const archivePath = Array.from(deferredWrites.keys()).find(
          p => (p.split("/").pop() || p) === (xamlEntries[i].name.split("/").pop() || xamlEntries[i].name)
        );
        if (archivePath) {
          deferredWrites.set(archivePath, cleaned);
        } else {
          console.warn(`[UiPath Parity] No deferredWrites key found for basename "${xamlEntries[i].name}" during placeholder cleanup — skipping deferred update`);
        }
        const fileName = xamlEntries[i].name.split("/").pop() || xamlEntries[i].name;
        placeholderCleanupRepairs.push({
          repairCode: "REPAIR_PLACEHOLDER_CLEANUP" as const,
          file: fileName,
          description: `Stripped ${placeholderCount} placeholder token(s) from ${fileName}`,
          developerAction: `Review ${fileName} for Comment elements marking where placeholder activities were removed`,
          estimatedEffortMinutes: 5,
        });
        console.log(`[UiPath Pre-Package Check] ${xamlEntries[i].name}: stripped ${placeholderCount} placeholder token(s)`);
      }
    }
    for (const [depName, depVer] of Object.entries(deps)) {
      if (/^\[\d+\.\d+(\.\d+){0,2},\s*\)$/.test(String(depVer))) {
        continue;
      }
      const cleanVer = String(depVer).replace(/[\[\]]/g, "");
      if (cleanVer !== depVer) {
        deps[depName] = cleanVer;
        console.log(`[UiPath Pre-Package Check] Stripped brackets from dependency version: ${depName} ${depVer} -> ${cleanVer}`);
      }
    }

    const projectJsonPath = `${libPath}/project.json`;
    const nuspecPath = `${projectName}.nuspec`;

    const buildContentHashRecord = () => {
      const hashRecord: Record<string, string> = {};
      _appendedContentHashes.forEach((hash, path) => { hashRecord[path] = hash; });
      for (const [path, content] of deferredWrites.entries()) {
        hashRecord[path] = createHash("sha256").update(content).digest("hex");
        hashRecord[`__validated__${path}`] = hashRecord[path];
      }
      const pjContent = JSON.stringify(projectJson, null, 2);
      hashRecord[projectJsonPath] = createHash("sha256").update(pjContent).digest("hex");
      hashRecord[`__validated__${projectJsonPath}`] = hashRecord[projectJsonPath];
      return hashRecord;
    };

    const allArchivePaths = [
      ..._archiveManifestTracker,
      ...Array.from(deferredWrites.keys()),
      projectJsonPath,
      nuspecPath,
      `${libPath}/DeveloperHandoffGuide.md`,
    ];

    const autoFixSummary: string[] = [];
    const outcomeRemediations: RemediationEntry[] = [];
    for (const fb of complianceFallbacks) {
      const wfBaseName = fb.file.replace(/\.xaml$/, "");
      const matchingSpec = allTreeEnrichments.get(wfBaseName);
      const wfPurpose = matchingSpec?.spec?.description || "";
      const targetSystem = (() => {
        if (!matchingSpec?.spec?.rootSequence?.children) return "";
        for (const child of matchingSpec.spec.rootSequence.children) {
          if (child.kind === "activity" && child.properties) {
            const sys = child.properties.Application || child.properties.BrowserType || child.properties.Target || "";
            if (sys) return sys;
          }
        }
        return "";
      })();
      const actionDescription = wfPurpose
        ? `TODO: Implement ${wfPurpose}${targetSystem ? ` (System: ${targetSystem})` : ""}`
        : `TODO: Implement ${wfBaseName}${targetSystem ? ` (System: ${targetSystem})` : ""} — review SDD for workflow requirements`;
      outcomeRemediations.push({
        level: "workflow",
        file: fb.file,
        remediationCode: "STUB_WORKFLOW_GENERATOR_FAILURE",
        reason: `Compliance transform failed — ${fb.reason}`,
        classifiedCheck: "compliance-crash",
        developerAction: actionDescription,
        estimatedEffortMinutes: 15,
      });
    }
    if (deferredHallucinatedRecoveries.length > 0) {
      for (const ha of deferredHallucinatedRecoveries) {
        outcomeRemediations.push({
          level: "activity",
          file: ha.file,
          remediationCode: "HALLUCINATED_ACTIVITY_STUBBED",
          originalTag: ha.template,
          originalDisplayName: ha.displayName,
          reason: `Activity template "${ha.template}" had >50% properties stripped — likely hallucinated or wrong activity type`,
          classifiedCheck: "EXCESSIVE_PROPERTIES_STRIPPED",
          developerAction: `Replace "${ha.template}" ("${ha.displayName}") with the correct UiPath activity from the catalog. The generated activity template does not match any known catalog entry well enough to be used directly.`,
          estimatedEffortMinutes: 15,
        });
      }
      console.log(`[UiPath Recovery] Registered ${deferredHallucinatedRecoveries.length} hallucinated activity remediation(s) — targeted for per-activity recovery instead of package-level downgrade`);
    }
    const outcomeAutoRepairs: AutoRepairEntry[] = [...placeholderCleanupRepairs];
    const structuralPreservationMetrics: StructuralPreservationMetrics[] = [];

    function mapCheckToRemediationCode(check: string): RemediationCode {
      const codeMap: Record<string, RemediationCode> = {
        "CATALOG_VIOLATION": "STUB_ACTIVITY_CATALOG_VIOLATION",
        "CATALOG_STRUCTURAL_VIOLATION": "STUB_ACTIVITY_CATALOG_VIOLATION",
        "ENUM_VIOLATION": "STUB_ACTIVITY_CATALOG_VIOLATION",
        "catalog-violation": "STUB_ACTIVITY_CATALOG_VIOLATION",
        "policy-blocked-activity": "STUB_ACTIVITY_BLOCKED_PATTERN",
        "object-object": "STUB_ACTIVITY_OBJECT_OBJECT",
        "pseudo-xaml": "STUB_ACTIVITY_PSEUDO_XAML",
        "fake-trycatch": "STUB_ACTIVITY_PSEUDO_XAML",
        "xml-wellformedness": "STUB_ACTIVITY_WELLFORMEDNESS",
        "unknown-activity": "STUB_ACTIVITY_UNKNOWN",
        "invalid-takescreenshot-result": "STUB_ACTIVITY_BLOCKED_PATTERN",
        "invalid-takescreenshot-outputpath": "STUB_ACTIVITY_BLOCKED_PATTERN",
        "invalid-takescreenshot-outputpath-attr": "STUB_ACTIVITY_BLOCKED_PATTERN",
      };
      return codeMap[check] || "STUB_ACTIVITY_UNKNOWN";
    }

    function estimateEffortForCheck(check: string): number {
      const effortMap: Record<string, number> = {
        "CATALOG_VIOLATION": 10,
        "CATALOG_STRUCTURAL_VIOLATION": 15,
        "ENUM_VIOLATION": 5,
        "catalog-violation": 10,
        "policy-blocked-activity": 15,
        "object-object": 20,
        "pseudo-xaml": 30,
        "fake-trycatch": 20,
        "xml-wellformedness": 30,
        "unknown-activity": 15,
      };
      return effortMap[check] || 15;
    }

    function developerActionForCheck(check: string, file: string, displayName?: string): string {
      const actLabel = displayName ? `"${displayName}" activity` : "activity";
      const actions: Record<string, string> = {
        "catalog-violation": `Review ${actLabel} in ${file} — validate property values against UiPath catalog`,
        "CATALOG_VIOLATION": `Review ${actLabel} in ${file} — validate property values against UiPath catalog`,
        "CATALOG_STRUCTURAL_VIOLATION": `Fix property syntax for ${actLabel} in ${file} — move attribute to child-element or vice versa per UiPath catalog`,
        "ENUM_VIOLATION": `Fix enum value for ${actLabel} in ${file} — use valid enum from UiPath documentation`,
        "policy-blocked-activity": `Replace blocked ${actLabel} in ${file} with an allowed alternative`,
        "object-object": `Fix serialization failure for ${actLabel} in ${file} — replace [object Object] with actual values`,
        "pseudo-xaml": `Convert pseudo-XAML string attributes to proper nested XAML elements in ${file}`,
        "fake-trycatch": `Restructure TryCatch in ${file} to use nested elements instead of string attributes`,
        "xml-wellformedness": `Fix XML structure in ${file} — ensure proper nesting and closing tags`,
        "unknown-activity": `Replace unknown ${actLabel} in ${file} with a valid UiPath activity`,
      };
      return actions[check] || `Manually implement ${actLabel} in ${file} — estimated ${estimateEffortForCheck(check)} min`;
    }

    const catalogViolations: Array<{ file: string; detail: string }> = [];
    if (catalogService.isLoaded()) {
      try {
        for (let i = 0; i < xamlEntries.length; i++) {
          let content = xamlEntries[i].content;
          let modified = false;
          const fileName = xamlEntries[i].name.split("/").pop() || xamlEntries[i].name;

          const nsMap = new Map<string, string>();
          const nsRegex = /xmlns:(\w+)="([^"]+)"/g;
          let nsMatch;
          while ((nsMatch = nsRegex.exec(content)) !== null) {
            nsMap.set(nsMatch[1], nsMatch[2]);
          }

          const activityPrefixes = new Set<string>();
          for (const [prefix, uri] of nsMap.entries()) {
            if (uri.includes("clr-namespace:") || uri.includes("UiPath") || prefix === "ui") {
              activityPrefixes.add(prefix);
            }
          }

          const collectChildPropertyNames = (tagName: string, xmlContent: string, startPos: number): string[] => {
            const className = tagName.includes(":") ? tagName.split(":").pop()! : tagName;
            const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            const openTagRegex = new RegExp(`<${escapedTag}[\\s>]`);
            const closeTagRegex = new RegExp(`</${escapedTag}>`);
            const afterStart = xmlContent.slice(startPos);
            const closeMatch = closeTagRegex.exec(afterStart);
            if (!closeMatch) return [];

            const elementBlock = afterStart.slice(0, closeMatch.index + closeMatch[0].length);

            const childPropRegex = new RegExp(`<${escapedClassName}\\.([\\w]+)[\\s>]`, "g");
            const children: string[] = [];
            let cm;
            while ((cm = childPropRegex.exec(elementBlock)) !== null) {
              children.push(cm[1]);
              children.push(`${className}.${cm[1]}`);
            }
            return children;
          };

          const elementRegex = /<((?:[\w]+:)?[\w]+)(\s[^>]*?|\s*)(\/?>)/g;
          let elMatch;

          while ((elMatch = elementRegex.exec(content)) !== null) {
            const fullTag = elMatch[1];
            const attrString = elMatch[2];

            if (fullTag.includes(".")) continue;
            if (fullTag.startsWith("x:") || fullTag.startsWith("sap") || fullTag.startsWith("mc:")) continue;

            const prefix = fullTag.includes(":") ? fullTag.split(":")[0] : null;
            const isActivityCandidate = !prefix || activityPrefixes.has(prefix) ||
              ["Assign", "Throw", "Sequence", "If", "ForEach", "Switch", "TryCatch", "Delay"].includes(fullTag);

            if (!isActivityCandidate) continue;

            const schema = catalogService.getActivitySchema(fullTag);
            if (!schema) continue;

            const attrs: Record<string, string> = {};
            const attrRegex = /([\w]+(?:\.[\w]+)?)="([^"]*)"/g;
            let attrMatch;
            while ((attrMatch = attrRegex.exec(attrString)) !== null) {
              if (attrMatch[1].startsWith("xmlns") || attrMatch[1].includes(":")) continue;
              attrs[attrMatch[1]] = attrMatch[2];
            }

            const children = collectChildPropertyNames(fullTag, content, elMatch.index);
            const validation = catalogService.validateEmittedActivity(fullTag, attrs, children);

            if (validation.corrections.length > 0 || !validation.valid) {
              const correctedProperties = new Set<string>();

              for (const correction of validation.corrections) {
                if (correction.type === "move-to-child-element") {
                  const propName = correction.property;
                  const className2 = fullTag.includes(":") ? fullTag.split(":").pop()! : fullTag;
                  if (className2 === "Assign" && (propName === "To" || propName === "Value")) {
                    continue;
                  }
                  const propVal = attrs[propName];
                  if (propVal !== undefined) {
                    const wrapper = correction.argumentWrapper || "InArgument";
                    const xType = correction.typeArguments || clrToXamlType("System.String");

                    const escapedTag = fullTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const escapedVal = propVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const wrappedVal = ensureBracketWrapped(propVal);
                    const childElement = `<${fullTag}.${propName}>\n            <${wrapper} x:TypeArguments="${xType}">${wrappedVal}</${wrapper}>\n          </${fullTag}.${propName}>`;

                    const selfClosingRegex = new RegExp(`(<${escapedTag}\\s[^>]*?)${propName}="${escapedVal}"([^>]*?)(\\s*\\/>)`);
                    const openTagRegex = new RegExp(`(<${escapedTag}\\s[^>]*?)${propName}="${escapedVal}"([^>]*?>)`);

                    const contentLenBefore = content.length;
                    if (selfClosingRegex.test(content)) {
                      content = content.replace(selfClosingRegex, `$1 $2>\n          ${childElement}\n        </${fullTag}>`);
                      correctedProperties.add(propName);
                      modified = true;
                      autoFixSummary.push(`Catalog: Moved ${fullTag}.${propName} from attribute to child-element in ${fileName}`);
                      const contentLenDelta = content.length - contentLenBefore;
                      elementRegex.lastIndex = Math.max(0, elementRegex.lastIndex + contentLenDelta);
                    } else if (openTagRegex.test(content)) {
                      content = content.replace(openTagRegex, `$1 $2\n          ${childElement}`);
                      correctedProperties.add(propName);
                      modified = true;
                      autoFixSummary.push(`Catalog: Moved ${fullTag}.${propName} from attribute to child-element in ${fileName}`);
                      const contentLenDelta = content.length - contentLenBefore;
                      elementRegex.lastIndex = Math.max(0, elementRegex.lastIndex + contentLenDelta);
                    }
                  }
                } else if (correction.type === "fix-invalid-value" && correction.correctedValue) {
                  const propName = correction.property;
                  const oldVal = attrs[propName];
                  if (oldVal !== undefined) {
                    const escapedTag = fullTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const escapedOldVal = oldVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const attrRegex = new RegExp(`(<${escapedTag}\\s[^>]*?)${propName}="${escapedOldVal}"`, "g");
                    const contentLenBefore2 = content.length;
                    const newContent = content.replace(attrRegex, `$1${propName}="${correction.correctedValue}"`);
                    if (newContent !== content) {
                      content = newContent;
                      correctedProperties.add(propName);
                      modified = true;
                      autoFixSummary.push(`Catalog: Corrected ${fullTag}.${propName} value from "${oldVal}" to "${correction.correctedValue}" in ${fileName}`);
                      const contentLenDelta2 = content.length - contentLenBefore2;
                      if (contentLenDelta2 !== 0) {
                        elementRegex.lastIndex = Math.max(0, elementRegex.lastIndex + contentLenDelta2);
                      }
                    }
                  }
                } else if (correction.type === "wrap-in-argument" && correction.argumentWrapper) {
                  const propName = correction.property;
                  const className = fullTag.includes(":") ? fullTag.split(":").pop()! : fullTag;

                  if (className === "Assign" && (propName === "To" || propName === "Value")) {
                    continue;
                  }

                  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                  const wrapper = correction.argumentWrapper;
                  const xType = correction.typeArguments || clrToXamlType("System.String");

                  const childTagRegex = new RegExp(
                    `(<${escapedClassName}\\.${propName}>)\\s*(?!<(?:InArgument|OutArgument|InOutArgument)[\\s>\\n])([\\s\\S]*?)\\s*(<\\/${escapedClassName}\\.${propName}>)`,
                  );
                  const alreadyWrappedRegex = new RegExp(
                    `<${escapedClassName}\\.${propName}>[\\s\\n]*<(?:InArgument|OutArgument|InOutArgument)[\\s>]`,
                  );
                  if (childTagRegex.test(content) && !alreadyWrappedRegex.test(content)) {
                    const contentLenBefore3 = content.length;
                    content = content.replace(childTagRegex,
                      `$1\n            <${wrapper} x:TypeArguments="${xType}">$2</${wrapper}>\n          $3`
                    );
                    correctedProperties.add(propName);
                    modified = true;
                    autoFixSummary.push(`Catalog: Wrapped ${fullTag}.${propName} child content in <${wrapper}> in ${fileName}`);
                    const contentLenDelta3 = content.length - contentLenBefore3;
                    if (contentLenDelta3 !== 0) {
                      elementRegex.lastIndex = Math.max(0, elementRegex.lastIndex + contentLenDelta3);
                    }
                  }
                }
              }

              for (const v of validation.violations) {
                const propMatch = v.match(/"([^"]+)"/);
                const violationProp = propMatch ? propMatch[1] : null;
                if (!violationProp || !correctedProperties.has(violationProp)) {
                  catalogViolations.push({ file: fileName, detail: v });
                }
              }
            }
          }

          if (modified) {
            xamlEntries[i] = { name: xamlEntries[i].name, content };
            const archivePath = Array.from(deferredWrites.keys()).find(
              p => (p.split("/").pop() || p) === fileName
            );
            if (archivePath) {
              deferredWrites.set(archivePath, content);
            } else {
              console.warn(`[UiPath Parity] No deferredWrites key found for basename "${fileName}" during catalog conformance — skipping deferred update`);
            }
          }
        }

        if (catalogViolations.length > 0) {
          console.log(`[Activity Catalog] ${catalogViolations.length} unfixable catalog violation(s) found`);
        }
      } catch (err: any) {
        console.warn(`[Activity Catalog] Post-generation validation failed: ${err.message}`);
      }
    }

    for (let i = 0; i < xamlEntries.length; i++) {
      const entry = xamlEntries[i];
      const normalized = normalizeAssignArgumentNesting(entry.content);
      if (normalized !== entry.content) {
        console.log(`[XAML Post-Pass] ${entry.name}: normalized nested Assign argument wrappers`);
        xamlEntries[i] = { name: entry.name, content: normalized };
        const archivePath = Array.from(deferredWrites.keys()).find(
          p => (p.split("/").pop() || p) === entry.name
        );
        if (archivePath) {
          deferredWrites.set(archivePath, normalized);
        } else {
          console.warn(`[UiPath Parity] No deferredWrites key found for basename "${entry.name}" during assign normalization — skipping deferred update`);
        }
      }
    }

    for (let i = 0; i < xamlEntries.length; i++) {
      let content = xamlEntries[i].content;
      let wasFixed = false;

      const logLevelMap: Record<string, string> = {
        "Information": "Info",
        "Warning": "Warn",
        "Debug": "Trace",
        "Critical": "Fatal",
      };
      for (const [badLevel, goodLevel] of Object.entries(logLevelMap)) {
        const logLevelRegex = new RegExp(`(<ui:LogMessage\\s[^>]*?)Level="${badLevel}"`, "g");
        if (logLevelRegex.test(content)) {
          content = content.replace(new RegExp(`(<ui:LogMessage\\s[^>]*?)Level="${badLevel}"`, "g"), `$1Level="${goodLevel}"`);
          autoFixSummary.push(`Normalised LogMessage Level="${badLevel}" → "${goodLevel}" in ${xamlEntries[i].name}`);
          wasFixed = true;
        }
      }

      content = content.replace(/<sap:WorkflowViewState\.ViewStateManager>[\s\S]*?<\/sap:WorkflowViewState\.ViewStateManager>/g, "");
      content = content.replace(/<WorkflowViewState\.ViewStateManager>[\s\S]*?<\/WorkflowViewState\.ViewStateManager>/g, "");

      const ampersandRegex = /&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g;
      if (ampersandRegex.test(content)) {
        content = content.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-fA-F]+;)/g, "&amp;");
        autoFixSummary.push(`Escaped raw ampersands in ${xamlEntries[i].name}`);
        wasFixed = true;
      }

      const bareLtRegex = /(<(?:In|Out)Argument[^>]*>)([\s\S]*?)(<\/(?:In|Out)Argument>)/g;
      const bareLtFixed = content.replace(bareLtRegex, (_match: string, open: string, inner: string, close: string) => {
        const escapedInner = inner.replace(/<(?![\/a-zA-Z!?])/g, "&lt;").replace(/&lt;>/g, "&lt;&gt;");
        return open + escapedInner + close;
      });
      if (bareLtFixed !== content) {
        content = bareLtFixed;
        autoFixSummary.push(`Escaped bare < in argument content in ${xamlEntries[i].name}`);
        wasFixed = true;
      }

      const dupResult = removeDuplicateAttributes(content);
      if (dupResult.changed) {
        content = dupResult.content;
        for (const tag of dupResult.fixedTags) {
          autoFixSummary.push(`Removed duplicate attributes on <${tag}> in ${xamlEntries[i].name}`);
        }
        wasFixed = true;
      }

      content = content.replace(/<ui:TakeScreenshot\s+([^>]*?)OutputPath="([^"]*)"([^>]*?)\/>/g, (_match, before, _outputPathVal, after) => {
        const attrs = (before + after).trim();
        autoFixSummary.push(`Stripped TakeScreenshot OutputPath in ${xamlEntries[i].name}`);
        return `<ui:TakeScreenshot ${attrs} />`;
      });
      content = content.replace(/<ui:TakeScreenshot\s+([^>]*?)FileName="([^"]*)"([^>]*?)\/>/g, (_match, before, _fileNameVal, after) => {
        const attrs = (before + after).trim();
        autoFixSummary.push(`Stripped TakeScreenshot FileName in ${xamlEntries[i].name}`);
        return `<ui:TakeScreenshot ${attrs} />`;
      });

      const continueOnErrorWhitelist = new Set([
        "ui:Click", "ui:TypeInto", "ui:GetText", "ui:ElementExists",
        "ui:OpenBrowser", "ui:NavigateTo", "ui:AttachBrowser", "ui:AttachWindow",
        "ui:UseBrowser", "ui:UseApplicationBrowser",
      ]);
      content = content.replace(/<(ui:\w+)\s+([^>]*?)ContinueOnError="[^"]*"([^>]*?)(\s*\/?>)/g, (match, tag, before, after, closing) => {
        if (continueOnErrorWhitelist.has(tag)) return match;
        return `<${tag} ${(before + after).trim()}${closing}`;
      });

      content = content.replace(/Message="'([^"]*)(?<!')]"/g, (match, val) => {
        if (val.endsWith("'")) return match;
        return `Message="[&quot;${val}&quot;]"`;
      });

      const mixedExprResult = fixMixedLiteralExpressionSyntax(content);
      if (mixedExprResult.fixes.length > 0) {
        content = mixedExprResult.content;
        for (const fix of mixedExprResult.fixes) {
          autoFixSummary.push(`Mixed-expression: ${fix} in ${xamlEntries[i].name}`);
        }
        wasFixed = true;
      }

      if (content !== xamlEntries[i].content) {
        xamlEntries[i] = { name: xamlEntries[i].name, content };
        const basename = xamlEntries[i].name.split("/").pop() || xamlEntries[i].name;
        const archivePath = Array.from(deferredWrites.keys()).find(p => (p.split("/").pop() || p) === basename);
        if (archivePath) {
          deferredWrites.set(archivePath, content);
        } else {
          console.warn(`[UiPath Parity] No deferredWrites key found for basename "${basename}" during XAML sanitization — skipping deferred update`);
        }
        if (!wasFixed) autoFixSummary.push(`Applied XAML sanitization fixes to ${xamlEntries[i].name}`);
      }
    }

    const usedFallback = false;

    for (let i = 0; i < xamlEntries.length; i++) {
      let content = xamlEntries[i].content;
      let wasFixed = false;

      for (const [aliasName, canonicalName] of Object.entries(ACTIVITY_NAME_ALIAS_MAP)) {
        const escapedAlias = aliasName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const aliasRegex = new RegExp(`<${escapedAlias}(\\s|>|\\/)`, "g");
        const closingRegex = new RegExp(`</${escapedAlias}>`, "g");
        if (aliasRegex.test(content)) {
          content = content.replace(new RegExp(`<${escapedAlias}(\\s|>|\\/)`, "g"), `<${canonicalName}$1`);
          content = content.replace(closingRegex, `</${canonicalName}>`);
          autoFixSummary.push(`Normalised activity alias ${aliasName} → ${canonicalName} in ${xamlEntries[i].name}`);
          wasFixed = true;
        }
      }

      content = content.replace(/<ui:Assign\s/g, "<Assign ");
      content = content.replace(/<\/ui:Assign>/g, "</Assign>");

      content = content.replace(/WorkflowFileName="Workflows\\([^"]+)"/g, 'WorkflowFileName="$1"');
      content = content.replace(/WorkflowFileName="Workflows\/([^"]+)"/g, 'WorkflowFileName="$1"');
      content = content.replace(/WorkflowFileName="([^"]+)"/g, (_match, p1) => {
        const cleaned = p1.replace(/\\/g, "/").replace(/^[./]+/, "");
        return `WorkflowFileName="${cleaned}"`;
      });

      content = content.replace(/Dictionary<String,\s*ui:InArgument>/g, 'Dictionary<x:String, x:Object>');
      content = content.replace(/x:TypeArguments="x:String, ui:InArgument"/g, 'x:TypeArguments="x:String, x:Object"');

      if (content !== xamlEntries[i].content) {
        xamlEntries[i] = { name: xamlEntries[i].name, content };
        if (!wasFixed) autoFixSummary.push(`Applied XAML fixes to ${xamlEntries[i].name}`);
      }
    }

    for (const entry of xamlEntries) {
      const basename = entry.name.split("/").pop() || entry.name;
      const archivePath = Array.from(deferredWrites.keys()).find(p => (p.split("/").pop() || p) === basename);
      if (archivePath) {
        deferredWrites.set(archivePath, entry.content);
      } else {
        console.warn(`[UiPath Parity] No deferredWrites key found for basename "${basename}" during quality gate sync — skipping deferred update`);
      }
    }

    const qualityGateRunCount = 1;
    let qualityGateResult = runQualityGate({
      xamlEntries,
      projectJsonContent: projectJsonStr,
      configData: configCsv,
      orchestratorArtifacts,
      targetFramework: tf,
      archiveManifest: allArchivePaths,
      archiveContentHashes: buildContentHashRecord(),
      automationPattern,
    });
    const initialQGViolationCount = qualityGateResult.violations?.length || 0;

    if (catalogViolations.length > 0) {
      const existingKeys = new Set(
        qualityGateResult.violations
          .filter(v => v.check === "CATALOG_VIOLATION" || v.check === "ENUM_VIOLATION" || v.check === "CATALOG_STRUCTURAL_VIOLATION")
          .map(v => `${v.file}::${v.detail}`)
      );
      let addedWarnings = 0;
      let addedErrors = 0;
      for (const cv of catalogViolations) {
        const key = `${cv.file}::${cv.detail}`;
        if (!existingKeys.has(key)) {
          const isEnumViolation = cv.detail.includes("ENUM_VIOLATION");
          const isStructuralViolation = cv.detail.includes("must be a child element") ||
            cv.detail.includes("should be an attribute") ||
            cv.detail.includes("move-to-child-element") ||
            cv.detail.includes("move-to-attribute");
          const severity = (isEnumViolation || isStructuralViolation) ? "error" as const : "warning" as const;
          const check = isEnumViolation ? "ENUM_VIOLATION" :
            isStructuralViolation ? "CATALOG_STRUCTURAL_VIOLATION" : "CATALOG_VIOLATION";
          qualityGateResult.violations.push({
            category: "accuracy",
            severity,
            check,
            file: cv.file,
            detail: cv.detail,
          });
          existingKeys.add(key);
          if (severity === "error") {
            addedErrors++;
          } else {
            addedWarnings++;
          }
        }
      }
      if (addedWarnings > 0) {
        qualityGateResult.summary.accuracyWarnings = (qualityGateResult.summary.accuracyWarnings || 0) + addedWarnings;
        qualityGateResult.summary.totalWarnings += addedWarnings;
      }
      if (addedErrors > 0) {
        qualityGateResult.summary.accuracyErrors = (qualityGateResult.summary.accuracyErrors || 0) + addedErrors;
        qualityGateResult.summary.totalErrors = (qualityGateResult.summary.totalErrors || 0) + addedErrors;
        qualityGateResult.passed = false;
      }
    }

    {
      const classifiedIssues = classifyQualityIssues(qualityGateResult);
      for (const ci of classifiedIssues) {
        collectedQualityIssues.push({
          severity: ci.severity,
          file: ci.file,
          check: ci.check,
          detail: ci.detail,
        });
        if (ci.severity === "blocking") {
          outcomeRemediations.push({
            level: "validation-finding",
            file: ci.file,
            remediationCode: mapCheckToRemediationCode(ci.check),
            reason: ci.detail,
            classifiedCheck: ci.check,
            developerAction: developerActionForCheck(ci.check, ci.file),
            estimatedEffortMinutes: estimateEffortForCheck(ci.check),
          });
        }
      }
      if (!qualityGateResult.passed) {
        console.log(`[UiPath Quality Gate] Validation found ${qualityGateResult.summary.totalErrors} error(s), ${qualityGateResult.summary.totalWarnings} warning(s) — reporting in DHG without remediation`);
      }
    }

    {
      const depsAfterScan = scanXamlForRequiredPackages(xamlEntries.map(e => e.content).join("\n"));
      for (const rawPkgName of depsAfterScan) {
        const pkgName = normalizePackageName(rawPkgName);
        if (deps[pkgName]) continue;
        if (isFrameworkAssembly(pkgName)) {
          console.log(`[Dependency CrossCheck] Rejected framework assembly from post-meta-validation scan: ${pkgName}`);
          continue;
        }
        if (catalogService.isLoaded()) {
          const catalogVersion = catalogService.getPreferredVersion(pkgName);
          if (catalogVersion) {
            deps[pkgName] = catalogVersion;
            autoFixSummary.push(`Added dependency from catalog crosscheck: ${pkgName}@${catalogVersion}`);
            console.warn(`[Dependency CrossCheck] Post-fix gap: ${pkgName} discovered in XAML after meta-validation — added from catalog preferred v${catalogVersion}`);
            continue;
          }
        }
        const fallback = getBaselineFallbackVersion(pkgName, tf as "Windows" | "Portable");
        if (fallback) {
          deps[pkgName] = fallback;
          autoFixSummary.push(`Added dependency from validated metadata service: ${pkgName}@${fallback}`);
          console.warn(`[Dependency CrossCheck] Post-fix: using validated metadata service version for ${pkgName}: ${fallback}`);
        } else {
          const postRemXamlFiles = xamlEntries
            ? xamlEntries.filter((e: { name: string; content: string }) => e.content.includes(pkgName)).map((e: { name: string; content: string }) => e.name)
            : [];
          const postRemXamlContext = postRemXamlFiles.length ? ` Found in XAML files: [${postRemXamlFiles.join(", ")}].` : "";
          const postRemLayersChecked = [
            catalogService.isLoaded() ? "activity-catalog (getPreferredVersion): no match" : "activity-catalog: not loaded",
            "generation-metadata (getBaselineFallbackVersion): no match",
          ].join("; ");
          throw new Error(
            `[Dependency CrossCheck] FATAL: Package "${pkgName}" is referenced in post-remediation XAML but has no validated version.${postRemXamlContext} ` +
            `Authority layers checked: [${postRemLayersChecked}]. ` +
            `Build aborted. Add this package to the generation-metadata.json packageVersionRanges or activity catalog.`
          );
        }
      }

      {
        const allXamlForNewtonsoftCheck = xamlEntries.map(e => e.content).join("\n");
        const hasNewtonsoftTypes = /JObject|JToken|JArray|JsonConvert|Newtonsoft/i.test(allXamlForNewtonsoftCheck);
        if (hasNewtonsoftTypes && !deps["Newtonsoft.Json"]) {
          const newtonsoftVersion = catalogService.isLoaded()
            ? catalogService.getPreferredVersion("Newtonsoft.Json")
            : null;
          const resolvedVersion = newtonsoftVersion || "13.0.3";
          deps["Newtonsoft.Json"] = resolvedVersion;
          autoFixSummary.push(`Proactively added Newtonsoft.Json@${resolvedVersion} — Newtonsoft types detected in XAML`);
          console.log(`[Dependency Proactive] Added Newtonsoft.Json@${resolvedVersion} — JObject/JToken/JArray/JsonConvert types detected in XAML`);
        }
        if ((deps["UiPath.Web.Activities"] || deps["UiPath.WebAPI.Activities"]) && !deps["Newtonsoft.Json"]) {
          const newtonsoftVersion = catalogService.isLoaded()
            ? catalogService.getPreferredVersion("Newtonsoft.Json")
            : null;
          const resolvedVersion = newtonsoftVersion || "13.0.3";
          deps["Newtonsoft.Json"] = resolvedVersion;
          autoFixSummary.push(`Proactively added Newtonsoft.Json@${resolvedVersion} — required by UiPath.Web.Activities`);
          console.log(`[Dependency Proactive] Added Newtonsoft.Json@${resolvedVersion} — required by UiPath.Web.Activities dependency`);
        }
      }

      validateAndEnforceDependencyCompatibility(deps, dependencyWarnings);
    }

    if (autoFixSummary.length > 0) {
      console.log(`[UiPath Auto-Fix] Applied ${autoFixSummary.length} proven-safe fix(es):\n${autoFixSummary.map(s => `  - ${s}`).join("\n")}`);
    }

    if (!qualityGateResult.passed) {
      const formattedViolations = formatQualityGateViolations(qualityGateResult);
      if (generationMode === "baseline_openable") {
        console.warn(`[UiPath Quality Gate] baseline_openable mode — ${qualityGateResult.summary.totalErrors} error(s) reported as validation issues (non-blocking):\n${formattedViolations}`);
      } else {
        console.warn(`[UiPath Quality Gate] Validation found ${qualityGateResult.summary.totalErrors} error(s) — reported in DHG without remediation:\n${formattedViolations}`);
      }
    }

    {
      const warnCount = qualityGateResult.summary.totalWarnings;
      const errorCount = qualityGateResult.summary.totalErrors;
      const evidenceCount = qualityGateResult.positiveEvidence?.length || 0;
      const readiness = qualityGateResult.readiness;
      const status = readiness === "SUCCESS" ? "PASSED"
        : readiness === "READY_WITH_WARNINGS" ? "PASSED_WITH_WARNINGS"
        : "NEEDS_ATTENTION";
      console.log(`[UiPath Quality Gate] ${status} (readiness: ${readiness})${errorCount > 0 ? `, ${errorCount} error(s)` : ""}${warnCount > 0 ? `, ${warnCount} warning(s)` : ""}${stubsGenerated.length > 0 ? `, ${stubsGenerated.length} stub(s) generated` : ""}, ${evidenceCount} positive evidence item(s)`);

      const totalActivities = xamlEntries.reduce((sum, e) => {
        const matches = e.content.match(/<([\w:]+)\s[^>]*DisplayName="/g);
        return sum + (matches ? matches.length : 0);
      }, 0);
      const postComplianceDefectCount = totalPostComplianceReCorrections;

      const convergenceMetrics = {
        qualityGateRunCount,
        cascadeAmplificationRatio: 1.0,
        stubRatio: 0,
        stubbedActivities: 0,
        totalActivities,
        qualityGateStatus: status,
        readiness,
        autoRepairsApplied: autoFixSummary.length,
        initialViolationCount: initialQGViolationCount,
        finalViolationCount: qualityGateResult.violations?.length || 0,
        dhgAccuracy: computeDhgAccuracy({
          usedFallbackStubs: stubsGenerated.length > 0,
          outcomeReport: qualityGateResult ? {
            remediations: qualityGateResult.violations?.map(v => ({ level: v.severity || "warning" })) || [],
            studioCompatibility: qualityGateResult.violations?.filter(v => v.category === "studio-blocked").map(v => ({ level: "studio-blocked" })) || [],
            fullyGeneratedFiles: xamlEntries.filter(e => !stubsGenerated.includes(e.name)).map(e => e.name),
          } : undefined,
          xamlEntries,
        }),
        usedFallbackStubs: stubsGenerated.length > 0,
        postComplianceDefectCount,
        complianceIdempotencyRate: postComplianceDefectCount === 0 ? 1.0 : Math.max(0, 1 - (postComplianceDefectCount / Math.max(1, totalActivities))),
      };
      console.log(`[Pipeline Convergence Metrics] ${JSON.stringify(convergenceMetrics)}`);
    }

    if (orchestratorArtifacts?.agents?.length > 0) {
      for (const agent of orchestratorArtifacts.agents) {
        const agentFileName = `Agent_${(agent.name || "Unnamed").replace(/\s+/g, "_")}.json`;
        const agentConfig = JSON.stringify({
          name: agent.name,
          agentType: agent.agentType || "autonomous",
          description: agent.description || "",
          systemPrompt: agent.systemPrompt || "",
          tools: agent.tools || [],
          contextGrounding: agent.contextGrounding || undefined,
          knowledgeBases: agent.knowledgeBases || [],
          guardrails: agent.guardrails || [],
          escalationRules: agent.escalationRules || [],
          inputSchema: agent.inputSchema || undefined,
          outputSchema: agent.outputSchema || undefined,
          maxIterations: agent.maxIterations || 10,
          temperature: agent.temperature ?? 0.3,
          provisionedBy: "CannonBall",
          provisionedAt: new Date().toISOString(),
        }, null, 2);
        archive.append(agentConfig, { name: `${libPath}/Agents/${agentFileName}` });
        console.log(`[UiPath] Included agent config "${agentFileName}" in package for Agent Builder import`);
      }
    }

    const finalValidation = validateXamlContent(xamlEntries);
    const malformedQuotes = finalValidation.filter(v => v.check === "malformed-quote");
    const pseudoXaml = finalValidation.filter(v => v.check === "pseudo-xaml");
    const placeholders = finalValidation.filter(v => v.check === "placeholder");
    const invokedFiles = finalValidation.filter(v => v.check === "invoked-file");
    const duplicateFiles = finalValidation.filter(v => v.check === "duplicate-file");
    const xmlWellformedness = finalValidation.filter(v => v.check === "xml-wellformedness");
    console.log(`[UiPath Pre-Package Validation Report]`);
    console.log(`  No malformed quotes:       ${malformedQuotes.length === 0 ? "PASS" : `FAIL (${malformedQuotes.length} violation(s))`}`);
    console.log(`  No pseudo-XAML:             ${pseudoXaml.length === 0 ? "PASS" : `FAIL (${pseudoXaml.length} violation(s))`}`);
    console.log(`  No placeholder values:      ${placeholders.length === 0 ? "PASS" : `FAIL (${placeholders.length} violation(s))`}`);
    console.log(`  Every invoked file exists:  ${invokedFiles.length === 0 ? "PASS" : `FAIL (${invokedFiles.length} violation(s))`}`);
    console.log(`  No duplicate files:         ${duplicateFiles.length === 0 ? "PASS" : `FAIL (${duplicateFiles.length} violation(s))`}`);
    console.log(`  All XAML well-formed:       ${xmlWellformedness.length === 0 ? "PASS" : `FAIL (${xmlWellformedness.length} violation(s))`}`);
    for (const v of finalValidation) {
      if (v.check === "malformed-quote" || v.check === "xml-wellformedness" || v.check === "duplicate-file") {
        console.warn(`  [${v.check}] ${v.file}: ${v.detail}`);
      }
    }

    const severeValidationErrors = [...xmlWellformedness, ...duplicateFiles, ...malformedQuotes];
    if (severeValidationErrors.length > 0) {
      const details = severeValidationErrors.map(v => `  [${v.check}] ${v.file}: ${v.detail}`).join("\n");
      console.error(`[UiPath Pre-Package Validation] ${severeValidationErrors.length} severe violation(s) found — attempting per-file remediation:\n${details}`);

      const corruptedFiles = new Set(severeValidationErrors.map(v => v.file));
      const allCorrupted = corruptedFiles.size >= xamlEntries.length;

      if (allCorrupted) {
        throw new Error(
          `UiPath pre-package validation failed with ${severeValidationErrors.length} severe violation(s) (all files corrupted):\n${details}`
        );
      }

      let remediationFailed = false;
      for (const corruptedFile of corruptedFiles) {
        const stubName = corruptedFile.replace(/\.xaml$/i, "");
        const corruptedEntry = xamlEntries.find(e => e.name === corruptedFile || (e.name.split("/").pop() || e.name) === corruptedFile);
        const corruptedContent = corruptedEntry?.content || "";
        const extractedArgs: Array<{ name: string; direction: string; type: string }> = [];
        const extractedVars: Array<{ name: string; type: string; defaultValue?: string }> = [];
        const propPattern = /<x:Property\s+Name="([^"]+)"\s+Type="([^"]+)"/g;
        let propMatch;
        while ((propMatch = propPattern.exec(corruptedContent)) !== null) {
          const argName = propMatch[1];
          const typeStr = propMatch[2];
          let direction = "InArgument";
          if (typeStr.includes("OutArgument")) direction = "OutArgument";
          else if (typeStr.includes("InOutArgument")) direction = "InOutArgument";
          const typeMatch = typeStr.match(/Argument\(([^)]+)\)/);
          const baseType = typeMatch ? typeMatch[1] : "x:String";
          extractedArgs.push({ name: argName, direction, type: baseType });
        }
        const varPattern = /<Variable\s+(?:x:TypeArguments="([^"]+)"\s+Name="([^"]+)"|Name="([^"]+)"\s+x:TypeArguments="([^"]+)")(?:\s+Default="([^"]*)")?/g;
        let varMatch;
        while ((varMatch = varPattern.exec(corruptedContent)) !== null) {
          const varType = varMatch[1] || varMatch[4] || "x:String";
          const varName = varMatch[2] || varMatch[3] || "";
          const defVal = varMatch[5];
          if (varName) extractedVars.push({ name: varName, type: varType, ...(defVal ? { defaultValue: defVal } : {}) });
        }
        let finalArgs = extractedArgs;
        let finalVars = extractedVars;
        if (finalVars.length === 0) {
          const matchingSpec = workflows.find(wf => {
            const specName = (wf.name || "").replace(/\s+/g, "_");
            return specName === stubName || specName + ".xaml" === corruptedFile;
          });
          if (matchingSpec && matchingSpec.variables && matchingSpec.variables.length > 0) {
            finalVars = matchingSpec.variables.map(v => ({
              name: v.name,
              type: v.type || "x:String",
              ...(v.defaultValue ? { defaultValue: v.defaultValue } : {}),
            }));
          }
        }
        if (finalArgs.length === 0) {
          const specArgs = treeEnrichment?.status === "success" && treeEnrichment.workflowSpec?.arguments?.length
            ? treeEnrichment.workflowSpec.arguments
            : enrichment?.arguments?.length ? enrichment.arguments : null;
          if (specArgs) {
            finalArgs = specArgs.map(a => ({
              name: a.name,
              direction: a.direction || "InArgument",
              type: a.type || "x:String",
            }));
          }
        }
        const isMainFile = corruptedFile === "Main.xaml" || corruptedFile === `${mainWfName}.xaml`;
        let invokeWorkflows: Array<{ displayName: string; fileName: string }> | undefined;
        if (isMainFile && nonMainWorkflowNames.length > 0) {
          const seenFiles = new Set<string>();
          invokeWorkflows = [];
          const initFile = "InitAllSettings.xaml";
          if (!seenFiles.has(initFile)) {
            seenFiles.add(initFile);
            invokeWorkflows.push({ displayName: "Initialize All Settings", fileName: initFile });
          }
          for (const name of nonMainWorkflowNames) {
            const fn = `${name}.xaml`;
            if (!seenFiles.has(fn) && name !== stubName) {
              seenFiles.add(fn);
              invokeWorkflows.push({ displayName: name, fileName: fn });
            }
          }
          console.log(`[UiPath Pre-Package Validation] Main.xaml stub will preserve ${invokeWorkflows.length} InvokeWorkflowFile reference(s) to maintain sub-workflow reachability`);
        }
        const stubXaml = generateStubWorkflow(stubName, {
          reason: `Final validation remediation — original XAML had well-formedness violations`,
          arguments: finalArgs.length > 0 ? finalArgs : undefined,
          variables: finalVars.length > 0 ? finalVars : undefined,
          invokeWorkflows: invokeWorkflows && invokeWorkflows.length > 0 ? invokeWorkflows : undefined,
        });
        let stubCompliant: string;
        try {
          stubCompliant = compliancePass(stubXaml, corruptedFile, true);
        } catch (stubCompErr: any) {
          if (corruptedFile === "Main.xaml") {
            remediationFailed = true;
            console.error(`[UiPath Pre-Package Validation] Cannot remediate entry-point Main.xaml — stub compliance also failed: ${stubCompErr.message}`);
            continue;
          }
          stubCompliant = stubXaml;
        }
        const entryIdx = xamlEntries.findIndex(e => e.name === corruptedFile || (e.name.split("/").pop() || e.name) === corruptedFile);
        if (entryIdx >= 0) {
          xamlEntries[entryIdx] = { ...xamlEntries[entryIdx], content: stubCompliant };
        }
        const archivePath = Array.from(deferredWrites.keys()).find(
          p => (p.split("/").pop() || p) === corruptedFile
        );
        if (archivePath) {
          deferredWrites.set(archivePath, stubCompliant);
        } else {
          console.warn(`[UiPath Parity] No deferredWrites key found for basename "${corruptedFile}" during final validation remediation — skipping deferred update`);
        }
        outcomeRemediations.push({
          level: "workflow",
          file: corruptedFile,
          remediationCode: "STUB_WORKFLOW_BLOCKING",
          reason: `Final validation: XAML well-formedness violations — replaced with stub`,
          classifiedCheck: "xml-wellformedness",
          developerAction: `Fix XML structure in ${corruptedFile} — ensure proper nesting and closing tags`,
          estimatedEffortMinutes: 15,
        });
        console.warn(`[UiPath Pre-Package Validation] Remediated corrupted file "${corruptedFile}" with stub workflow`);
      }

      if (remediationFailed) {
        throw new Error(
          `UiPath pre-package validation failed — entry-point Main.xaml corrupted and stub remediation failed:\n${details}`
        );
      }
    }

    const archiveWfNames = Array.from(deferredWrites.keys())
      .filter(k => k.endsWith(".xaml"))
      .map(k => {
        const baseName = (k.split("/").pop() || k);
        return baseName.replace(/\.xaml$/i, "");
      });

    const stubRemediationFiles = new Set(
      outcomeRemediations
        .filter(r => r.remediationCode === "STUB_WORKFLOW_BLOCKING" || r.remediationCode === "STUB_WORKFLOW_GENERATOR_FAILURE")
        .map(r => r.file.replace(/\.xaml$/i, ""))
    );
    const complianceFallbackFiles = new Set(complianceFallbacks.map(fb => fb.file.replace(/\.xaml$/i, "")));
    for (const cf of complianceFallbackFiles) stubRemediationFiles.add(cf);
    const entryPointStubbed = stubRemediationFiles.has("Main") || earlyStubFallbacks.includes("Main.xaml") || complianceFallbackFiles.has("Main");
    const stubCount = stubRemediationFiles.size + earlyStubFallbacks.filter(f => !stubRemediationFiles.has(f.replace(/\.xaml$/i, ""))).length;
    const archiveWfSet = new Set(archiveWfNames);
    const plannedButMissingCount = workflowNames.filter(n => !archiveWfSet.has(n)).length;

    let assemblerStudioBlockedCount = stubCount;
    let assemblerStudioLoadableCount = Math.max(0, archiveWfSet.size - stubCount);
    for (const entry of xamlEntries) {
      const shortName = (entry.name.split("/").pop() || entry.name).replace(/\.xaml$/i, "");
      if (stubRemediationFiles.has(shortName) || earlyStubFallbacks.includes(shortName + ".xaml")) continue;
      let loadability = checkStudioLoadability(entry.content);
      if (!loadability.loadable && loadability.repairable) {
        const repair = repairMissingImplementation(entry.content, entry.name.split("/").pop() || entry.name);
        if (repair.repaired) {
          entry.content = repair.content;
          const archivePath = Array.from(deferredWrites.keys()).find(k => (k.split("/").pop() || k) === (entry.name.split("/").pop() || entry.name));
          if (archivePath) deferredWrites.set(archivePath, repair.content);
          loadability = checkStudioLoadability(entry.content);
        }
      }
      if (!loadability.loadable) {
        assemblerStudioBlockedCount++;
        assemblerStudioLoadableCount = Math.max(0, assemblerStudioLoadableCount - 1);
      }
    }

    const stubAwareness = {
      entryPointStubbed,
      stubCount,
      totalWorkflowCount: archiveWfSet.size,
      plannedButMissingCount,
      studioLoadableCount: assemblerStudioLoadableCount,
      studioBlockedCount: assemblerStudioBlockedCount,
    };

    const qualityWarningCount = qualityGateResult.violations.filter(v => v.severity === "warning").length;
    const remediationCount = outcomeRemediations.length;
    const emptyContainerCount = qualityGateResult.violations.filter(v => v.check === "empty-container" && v.severity === "error").length;

    const archiveXamlEntries = Array.from(deferredWrites.entries())
      .filter(([k]) => k.endsWith(".xaml"))
      .map(([name, content]) => ({ name, content }));

    const dhgAllFiles = new Set(
      Array.from(deferredWrites.keys())
        .filter(k => k.endsWith(".xaml"))
        .map(k => (k.split("/").pop() || k))
    );
    const dhgRemediatedFileSet = new Set(outcomeRemediations.map(r => r.file));
    const dhgStructuralDefectChecks = new Set([
      "placeholder-value",
      "empty-container",
      "empty-http-endpoint",
      "unassigned-decision-variable",
      "expression-syntax-mismatch",
      "invalid-type-argument",
      "invalid-default-value",
      "invalid-trycatch-structure",
      "invalid-catch-type",
      "invalid-activity-property",
      "invalid-continue-on-error",
      "invoke-arg-type-mismatch",
      "undeclared-variable",
      "unknown-activity",
      "undeclared-namespace",
      "policy-blocked-activity",
      "invalid-takescreenshot-result",
      "invalid-takescreenshot-outputpath",
      "invalid-takescreenshot-outputpath-attr",
      "invalid-takescreenshot-filename",
      "invalid-takescreenshot-filename-attr",
      "object-object",
      "pseudo-xaml",
      "fake-trycatch",
      "EXPRESSION_SYNTAX",
      "EXPRESSION_SYNTAX_UNFIXABLE",
      "TYPE_MISMATCH",
      "FOREACH_TYPE_MISMATCH",
      "LITERAL_TYPE_ERROR",
    ]);
    const dhgFilesWithStructuralDefects = new Set(
      qualityGateResult.violations
        .filter(v => v.severity === "error" && dhgStructuralDefectChecks.has(v.check))
        .map(v => v.file)
    );
    const DHG_STUB_CONTENT_PATTERNS = [
      "STUB_BLOCKING_FALLBACK",
      "STUB: ",
      "STUB_WORKFLOW_GENERATOR_FAILURE",
      "stub — Final validation remediation",
      "stub due to generation/compliance failure",
      "Manual implementation required",
    ];
    const dhgFilesWithStubContent = new Set<string>();
    const dhgStudioNonLoadableFiles = new Set<string>();
    const dhgStudioLoadabilityReasons = new Map<string, string>();
    for (const entry of xamlEntries) {
      const shortName = entry.name.split("/").pop() || entry.name;
      if (DHG_STUB_CONTENT_PATTERNS.some(pattern => entry.content.includes(pattern))) {
        dhgFilesWithStubContent.add(shortName);
      }
      let loadability = checkStudioLoadability(entry.content);
      if (!loadability.loadable && loadability.repairable) {
        const repair = repairMissingImplementation(entry.content, shortName);
        if (repair.repaired) {
          entry.content = repair.content;
          const archivePath = Array.from(deferredWrites.keys()).find(k => (k.split("/").pop() || k) === shortName);
          if (archivePath) deferredWrites.set(archivePath, repair.content);
          loadability = checkStudioLoadability(entry.content);
        }
      }
      if (!loadability.loadable) {
        dhgStudioNonLoadableFiles.add(shortName);
        dhgStudioLoadabilityReasons.set(shortName, loadability.reason || "Unknown Studio-loadability failure");
        console.log(`[Studio-Loadability] ${shortName}: NOT loadable — ${loadability.reason}`);
      }
    }
    const dhgFilesWithBlockingFindings = new Set<string>();
    for (const v of qualityGateResult.violations) {
      if (v.severity === "error") {
        dhgFilesWithBlockingFindings.add(v.file || "unknown");
      }
    }
    const dhgFilesWithCatalogViolations = new Set<string>();
    for (const v of qualityGateResult.violations) {
      if (v.check === "CATALOG_STRUCTURAL_VIOLATION" || v.check === "CATALOG_VIOLATION") {
        dhgFilesWithCatalogViolations.add(v.file || "unknown");
      }
    }
    const dhgFullyGenerated = Array.from(dhgAllFiles).filter(f =>
      !dhgRemediatedFileSet.has(f) &&
      !earlyStubFallbacks.includes(f) &&
      !dhgFilesWithStructuralDefects.has(f) &&
      !dhgFilesWithStubContent.has(f) &&
      !dhgStudioNonLoadableFiles.has(f) &&
      !dhgFilesWithBlockingFindings.has(f) &&
      !dhgFilesWithCatalogViolations.has(f)
    );

    const dhgQualityWarnings = qualityGateResult.violations
      .filter(v => v.severity === "warning")
      .map(v => ({
        check: v.check,
        file: v.file || "unknown",
        detail: v.detail,
        severity: v.severity as "warning",
        businessContext: v.businessContext,
        stubCategory: v.stubCategory,
      }));

    const dhgStudioBlockingChecks = new Set([
      "empty-container", "empty-http-endpoint", "invalid-trycatch-structure",
      "invalid-catch-type", "invalid-activity-property", "undeclared-variable",
      "unknown-activity", "undeclared-namespace", "invalid-type-argument",
      "invalid-default-value", "policy-blocked-activity", "pseudo-xaml",
      "fake-trycatch", "object-object", "EXPRESSION_SYNTAX_UNFIXABLE",
      "TYPE_MISMATCH", "FOREACH_TYPE_MISMATCH", "LITERAL_TYPE_ERROR",
      "CATALOG_STRUCTURAL_VIOLATION", "STRING_FORMAT_OVERFLOW",
      "EXPRESSION_IN_LITERAL_SLOT", "UNDECLARED_ARGUMENT",
    ]);
    const dhgStudioWarningChecks = new Set([
      "placeholder-value", "expression-syntax-mismatch", "invoke-arg-type-mismatch",
      "invalid-continue-on-error", "EXPRESSION_SYNTAX", "UNSAFE_VARIABLE_NAME", "empty-catches",
    ]);
    const dhgStubbedFiles = new Set(complianceFallbacks.map(fb => fb.file));
    for (const esf of earlyStubFallbacks) dhgStubbedFiles.add(esf);
    for (const r of outcomeRemediations) {
      if (r.remediationCode === "STUB_WORKFLOW_BLOCKING" || r.remediationCode === "STUB_WORKFLOW_GENERATOR_FAILURE") {
        dhgStubbedFiles.add(r.file);
      }
    }
    for (const f of dhgFilesWithStubContent) dhgStubbedFiles.add(f);
    const dhgStudioCompatibility: PerWorkflowStudioCompatibility[] = Array.from(dhgAllFiles).map(file => {
      if (dhgStudioNonLoadableFiles.has(file) && !dhgStubbedFiles.has(file)) {
        const reason = dhgStudioLoadabilityReasons.get(file) || "Not Studio-loadable";
        return {
          file,
          level: "studio-blocked" as StudioCompatibilityLevel,
          blockers: [`[STUDIO_LOADABILITY] ${reason}`],
          failureCategory: "structural-invalid" as import("./uipath-pipeline").StubFailureCategory,
          failureSummary: "Structural preservation — valid XML but not Studio-loadable",
        };
      }
      if (dhgStubbedFiles.has(file)) {
        const classified = classifyStubFailureCategory(file, outcomeRemediations, qualityGateResult.violations);
        return {
          file,
          level: "studio-blocked" as StudioCompatibilityLevel,
          blockers: [`[${classified.category.toUpperCase()}] ${classified.summary}`],
          failureCategory: classified.category,
          failureSummary: classified.summary,
        };
      }
      const fileViolations = qualityGateResult.violations.filter(v => v.file === file);
      const blockingViolations = fileViolations.filter(v => v.severity === "error" && dhgStudioBlockingChecks.has(v.check));
      const warningViolations = fileViolations.filter(v =>
        (v.severity === "error" && dhgStudioWarningChecks.has(v.check)) ||
        (v.severity === "warning" && (dhgStudioBlockingChecks.has(v.check) || dhgStudioWarningChecks.has(v.check)))
      );
      const blockers = blockingViolations.map(v => `[${v.check}] ${v.detail}`);
      let level: StudioCompatibilityLevel = blockingViolations.length > 0
        ? "studio-blocked"
        : warningViolations.length > 0
          ? "studio-warnings"
          : "studio-clean";
      const loadability = dhgStudioNonLoadableFiles.has(file);
      if (level === "studio-clean" && loadability) {
        level = "studio-blocked";
        blockers.push(`[STUDIO_LOADABILITY] ${dhgStudioLoadabilityReasons.get(file) || "Not Studio-loadable"}`);
      }
      return { file, level, blockers };
    });

    const assemblerOutcomeReport: PipelineOutcomeReport = {
      fullyGeneratedFiles: dhgFullyGenerated,
      autoRepairs: [],
      remediations: outcomeRemediations,
      propertyRemediations: [],
      downgradeEvents: [],
      qualityWarnings: dhgQualityWarnings,
      totalEstimatedEffortMinutes: outcomeRemediations.reduce((s, r) => s + (r.estimatedEffortMinutes || 0), 0),
      studioCompatibility: dhgStudioCompatibility,
    };

    if (xamlEntries.length > 0) {
      let parityMatches = 0;
      let parityMismatches = 0;
      const mismatchedFiles: string[] = [];
      for (const entry of xamlEntries) {
        const basename = entry.name.split("/").pop() || entry.name;
        const deferredKey = Array.from(deferredWrites.keys()).find(p => (p.split("/").pop() || p) === basename);
        const deferredContent = deferredKey ? deferredWrites.get(deferredKey) : undefined;
        const entriesHash = createHash("sha256").update(entry.content).digest("hex").substring(0, 12);
        const deferredHash = deferredContent ? createHash("sha256").update(deferredContent).digest("hex").substring(0, 12) : "MISSING";
        const match = deferredContent === entry.content;
        if (match) {
          parityMatches++;
        } else {
          parityMismatches++;
          mismatchedFiles.push(basename);
          const entryLen = entry.content.length;
          const deferredLen = deferredContent ? deferredContent.length : 0;
          let firstDiffPos = -1;
          if (deferredContent) {
            const minLen = Math.min(entryLen, deferredLen);
            for (let c = 0; c < minLen; c++) {
              if (entry.content[c] !== deferredContent[c]) {
                firstDiffPos = c;
                break;
              }
            }
            if (firstDiffPos === -1 && entryLen !== deferredLen) {
              firstDiffPos = minLen;
            }
          }
          console.log(`[Parity Pre-Check] MISMATCH ${basename}: entryLen=${entryLen}, deferredLen=${deferredLen}, firstDiffPos=${firstDiffPos}`);
        }
        console.log(`[Parity Pre-Check] ${basename}: entries=${entriesHash}, deferred=${deferredHash}, match=${match ? "true" : "FALSE"}`);
      }
      const mismatchSuffix = parityMismatches > 0 ? `, ${parityMismatches} mismatch(es): ${mismatchedFiles.join(", ")}` : "";
      console.log(`[Parity Pre-Check] Summary: ${parityMatches}/${xamlEntries.length} files match${mismatchSuffix}`);

      if (parityMismatches > 0) {
        console.log(`[Parity Pre-Check] Syncing xamlEntries from deferredWrites to resolve drift...`);
        for (let i = 0; i < xamlEntries.length; i++) {
          const basename = xamlEntries[i].name.split("/").pop() || xamlEntries[i].name;
          const deferredKey = Array.from(deferredWrites.keys()).find(p => (p.split("/").pop() || p) === basename);
          if (deferredKey) {
            const deferredContent = deferredWrites.get(deferredKey)!;
            if (xamlEntries[i].content !== deferredContent) {
              xamlEntries[i] = { name: xamlEntries[i].name, content: deferredContent };
              console.log(`[Parity Pre-Check] Synced ${basename} from deferredWrites`);
            }
          }
        }
      }

      const xamlBasenames = new Set(xamlEntries.map(e => (e.name.split("/").pop() || e.name)));
      const deferredXamlKeys = Array.from(deferredWrites.keys()).filter(p => p.endsWith(".xaml"));
      for (const dKey of deferredXamlKeys) {
        const dBasename = dKey.split("/").pop() || dKey;
        if (!xamlBasenames.has(dBasename)) {
          console.warn(`[Parity Pre-Check] XAML "${dBasename}" exists in deferredWrites but not in xamlEntries — adding to xamlEntries`);
          xamlEntries.push({ name: dKey, content: deferredWrites.get(dKey)! });
          xamlBasenames.add(dBasename);
        }
      }
      for (const entry of xamlEntries) {
        const basename = entry.name.split("/").pop() || entry.name;
        const hasDeferredKey = deferredXamlKeys.some(p => (p.split("/").pop() || p) === basename);
        if (!hasDeferredKey) {
          console.warn(`[Parity Pre-Check] XAML "${basename}" exists in xamlEntries but not in deferredWrites — orphaned entry`);
        }
      }
    }

    {
      console.log(`[Tier 2 Argument Reconciliation] Scanning InvokeWorkflowFile argument bindings across all workflows...`);
      const invokeArgContracts = new Map<string, Set<string>>();
      for (const [_path, content] of deferredWrites.entries()) {
        if (!_path.endsWith(".xaml")) continue;
        const invokePattern = /<ui:InvokeWorkflowFile[^>]*WorkflowFileName="([^"]+)"[^]*?<\/ui:InvokeWorkflowFile>/g;
        let invokeMatch;
        while ((invokeMatch = invokePattern.exec(content)) !== null) {
          const targetFile = invokeMatch[1].replace(/^.*[\\/]/, "");
          const argBlock = invokeMatch[0];
          const argKeyPattern = /x:Key="((?:in_|out_|io_)[A-Za-z]\w*)"/g;
          let akm;
          while ((akm = argKeyPattern.exec(argBlock)) !== null) {
            if (!invokeArgContracts.has(targetFile)) invokeArgContracts.set(targetFile, new Set());
            invokeArgContracts.get(targetFile)!.add(akm[1]);
          }
        }
        const fileName = _path.split("/").pop() || _path;
        const bodyArgRefs = /\b(in_[A-Za-z]\w*|out_[A-Za-z]\w*|io_[A-Za-z]\w*)\b/g;
        let bodyArg;
        while ((bodyArg = bodyArgRefs.exec(content)) !== null) {
          const xMemberCheck = new RegExp(`<x:Property\\s+Name="${bodyArg[1]}"`);
          const varCheck = new RegExp(`<Variable[^>]*\\bName="${bodyArg[1]}"`);
          if (!xMemberCheck.test(content) && !varCheck.test(content)) {
            if (!invokeArgContracts.has(fileName)) invokeArgContracts.set(fileName, new Set());
            invokeArgContracts.get(fileName)!.add(bodyArg[1]);
          }
        }
      }
      let tier2Injections = 0;
      for (const [dPath, dContent] of deferredWrites.entries()) {
        if (!dPath.endsWith(".xaml")) continue;
        const fileName = dPath.split("/").pop() || dPath;
        const neededArgs = invokeArgContracts.get(fileName);
        if (!neededArgs || neededArgs.size === 0) continue;
        let updatedContent = dContent;
        for (const argName of neededArgs) {
          const alreadyDeclared = new RegExp(`<x:Property\\s+Name="${argName}"`).test(updatedContent);
          const isVariable = new RegExp(`<Variable[^>]*\\bName="${argName}"`).test(updatedContent);
          if (alreadyDeclared || isVariable) continue;
          const direction = argName.startsWith("out_") ? "OutArgument"
            : argName.startsWith("io_") ? "InOutArgument"
            : "InArgument";
          const typeMap: Record<string, string> = {
            "str_": "x:String", "int_": "x:Int32", "bool_": "x:Boolean",
            "dt_": "scg2:DataTable", "dict_": "scg:Dictionary(x:String, x:Object)",
            "sec_": "x:String", "dbl_": "x:Double",
          };
          const prefix = argName.replace(/^(?:in_|out_|io_)/, "").match(/^[a-z]+_/)?.[0] || "";
          const argType = typeMap[prefix] || "x:String";
          const propXml = `    <x:Property Name="${argName}" Type="${direction}(${argType})" />\n`;
          const membersEnd = updatedContent.indexOf("</x:Members>");
          if (membersEnd >= 0) {
            updatedContent = updatedContent.slice(0, membersEnd) + propXml + updatedContent.slice(membersEnd);
            tier2Injections++;
            console.log(`[Tier 2 Argument Reconciliation] Injected ${direction} "${argName}" into ${fileName}`);
          }
        }
        if (updatedContent !== dContent) {
          deferredWrites.set(dPath, updatedContent);
          const matchingEntry = xamlEntries.find(e => (e.name.split("/").pop() || e.name) === fileName);
          if (matchingEntry) matchingEntry.content = updatedContent;
        }
      }
      console.log(`[Tier 2 Argument Reconciliation] Complete: ${tier2Injections} argument(s) injected across ${invokeArgContracts.size} workflow(s)`);
      if (tier2Injections > 0) {
        const beforeCount = qualityGateResult.violations.length;
        qualityGateResult.violations = qualityGateResult.violations.filter(v => {
          if (v.check !== "UNDECLARED_ARGUMENT") return true;
          const argMatch = v.detail.match(/Argument "([^"]+)"/);
          if (!argMatch) return true;
          const argName = argMatch[1];
          const fileName = v.file;
          const dKey = Array.from(deferredWrites.keys()).find(p => (p.split("/").pop() || p) === fileName);
          if (!dKey) return true;
          const currentContent = deferredWrites.get(dKey)!;
          return !new RegExp(`<x:Property\\s+Name="${argName}"`).test(currentContent);
        });
        const removed = beforeCount - qualityGateResult.violations.length;
        if (removed > 0) {
          console.log(`[Tier 2 Argument Reconciliation] Removed ${removed} stale UNDECLARED_ARGUMENT violation(s) resolved by injection`);
        }
      }
    }

    {
      console.log(`[Post-Repair Validation] Running final XAML validation pass after all post-processing...`);
      const postRepairViolations: Array<{ category: "blocked-pattern" | "completeness" | "accuracy" | "runtime-safety" | "logic-location"; severity: "error" | "warning"; check: string; file: string; detail: string }> = [];

      for (const [dPath, content] of deferredWrites.entries()) {
        if (!dPath.endsWith(".xaml")) continue;
        const shortName = dPath.split("/").pop() || dPath;

        const xmlWellFormed = validateXmlWellFormedness(content);
        if (!xmlWellFormed.valid) {
          postRepairViolations.push({ category: "accuracy", severity: "error", check: "INVALID_XML_CONTENT", file: shortName, detail: `Post-repair: XML is not well-formed: ${xmlWellFormed.errors.slice(0, 2).join("; ")}` });
        }

        const bareExprPattern = /Default="([^"]+)"/g;
        let bem;
        while ((bem = bareExprPattern.exec(content)) !== null) {
          const val = bem[1];
          if (val === "True" || val === "False" || val === "Nothing" || val === "null") continue;
          if (/^[0-9]+(\.[0-9]+)?$/.test(val)) continue;
          if (val.startsWith("[") && val.endsWith("]")) continue;
          if (val.startsWith("&quot;") || val.startsWith('"')) continue;
          if (/^\d{1,2}:\d{2}:\d{2}/.test(val)) continue;
          if (/^[a-zA-Z][\w\s.,!?;:'-]*$/.test(val) && !/[()]/.test(val) && !/^(in_|out_|io_)/.test(val)) continue;
          const looksLikeExpr = /^(in_|out_|io_|str_|int_|bool_|dict_|dt_|sec_)\w+$/.test(val) ||
            /\w+\.\w+\(/.test(val) || /\bNew\s/.test(val) || /\bDirectCast\b/.test(val) ||
            (/\(.*\)/.test(val) && /^[a-zA-Z_]\w*/.test(val));
          if (looksLikeExpr) {
            postRepairViolations.push({ category: "accuracy", severity: "error", check: "EXPRESSION_IN_LITERAL_SLOT", file: shortName, detail: `Post-repair: Variable Default="${val}" still contains an unwrapped VB expression` });
          }
        }

        const xPropNames = new Set<string>();
        const xpp = /<x:Property\s+Name="([^"]+)"/g;
        let xppm;
        while ((xppm = xpp.exec(content)) !== null) {
          xPropNames.add(xppm[1]);
        }
        const varNames = new Set<string>();
        const vp = /<Variable[^>]*\bName="([^"]+)"/g;
        let vpm;
        while ((vpm = vp.exec(content)) !== null) {
          varNames.add(vpm[1]);
        }
        const argScanContent = content.replace(/<ui:InvokeWorkflowFile\.Arguments>[\s\S]*?<\/ui:InvokeWorkflowFile\.Arguments>/g, "");
        const argRefs = /\b(in_[A-Za-z]\w*|out_[A-Za-z]\w*|io_[A-Za-z]\w*)\b/g;
        let arm;
        while ((arm = argRefs.exec(argScanContent)) !== null) {
          if (!xPropNames.has(arm[1]) && !varNames.has(arm[1])) {
            postRepairViolations.push({ category: "accuracy", severity: "error", check: "UNDECLARED_ARGUMENT", file: shortName, detail: `Post-repair: Argument "${arm[1]}" referenced but not declared in x:Members or Variables` });
            break;
          }
        }

        const prefixedStructuralPattern = /<[A-Za-z]+:?[A-Za-z]*\.(_(?:Try|Then|Else|Body|Condition|Catches|Finally|Cases|Default))\b/g;
        let psm;
        while ((psm = prefixedStructuralPattern.exec(content)) !== null) {
          postRepairViolations.push({ category: "accuracy", severity: "error", check: "STRUCTURAL_NAME_MUTATED", file: shortName, detail: `Post-repair: XAML structural member name mutated to "${psm[1]}" — Studio will fail to load this element` });
        }

        const retryIntervalPattern = /RetryInterval="([^"]+)"/g;
        let rim;
        while ((rim = retryIntervalPattern.exec(content)) !== null) {
          const riVal = rim[1];
          if (riVal === "00:00:05") {
            postRepairViolations.push({ category: "accuracy", severity: "warning", check: "RETRY_INTERVAL_DEFAULTED", file: shortName, detail: `Post-repair: RetryInterval defaulted to "00:00:05" — verify this is appropriate for the workflow context` });
          } else if (riVal.startsWith("[") && riVal.endsWith("]")) {
            postRepairViolations.push({ category: "accuracy", severity: "warning", check: "RETRY_INTERVAL_EXPRESSION_WRAPPED", file: shortName, detail: `Post-repair: RetryInterval="${riVal}" was bracket-wrapped from a variable/expression — verify the referenced variable is declared` });
          }
        }
      }

      if (postRepairViolations.length > 0) {
        console.warn(`[Post-Repair Validation] Found ${postRepairViolations.length} issue(s) — injecting into quality gate violations`);
        for (const v of postRepairViolations) {
          qualityGateResult.violations.push(v);
        }
        for (const compat of dhgStudioCompatibility) {
          const filePostRepairBlockers = postRepairViolations.filter(v => v.file === compat.file && v.severity === "error");
          if (filePostRepairBlockers.length > 0 && compat.level !== "studio-blocked") {
            compat.level = "studio-blocked" as StudioCompatibilityLevel;
            for (const b of filePostRepairBlockers) {
              compat.blockers.push(`[${b.check}] ${b.detail}`);
            }
          }
        }
        assemblerOutcomeReport.studioCompatibility = dhgStudioCompatibility;
        const postRepairBlockedFiles = new Set(
          postRepairViolations.filter(v => v.severity === "error").map(v => v.file)
        );
        if (postRepairBlockedFiles.size > 0) {
          const beforeCount = assemblerOutcomeReport.fullyGeneratedFiles.length;
          assemblerOutcomeReport.fullyGeneratedFiles = assemblerOutcomeReport.fullyGeneratedFiles.filter(
            f => !postRepairBlockedFiles.has(f.split("/").pop() || f)
          );
          const removedCount = beforeCount - assemblerOutcomeReport.fullyGeneratedFiles.length;
          if (removedCount > 0) {
            console.log(`[Post-Repair Validation] Removed ${removedCount} file(s) from fullyGeneratedFiles due to post-repair blocking violations`);
          }
        }
        console.log(`[Post-Repair Validation] Studio compatibility recomputed from post-repair violations`);
      }
      console.log(`[Post-Repair Validation] Complete: ${postRepairViolations.length} issue(s) found across deferred XAML entries`);
    }

    {
      console.log(`[Post-Repair Dependency Reconciliation] Re-scanning packages after all cleanup/repair passes...`);
      const allDeferredXaml = Array.from(deferredWrites.entries()).filter(([p]) => p.endsWith(".xaml")).map(([_, c]) => c).join("\n");
      const finalDeps = scanXamlForRequiredPackages(allDeferredXaml);
      const removedDeps: string[] = [];
      for (const depName of Object.keys(deps)) {
        if (depName === "UiPath.System.Activities" || depName === "UiPath.UIAutomation.Activities") continue;
        const isUsed = Array.from(finalDeps).some(d => normalizePackageName(d) === depName);
        const isRefInXaml = allDeferredXaml.includes(depName.split(".").pop() || depName);
        if (!isUsed && !isRefInXaml) {
          removedDeps.push(depName);
        }
      }
      if (removedDeps.length > 0) {
        for (const rd of removedDeps) {
          console.log(`[Post-Repair Dependency Reconciliation] Removing unused dependency: ${rd}`);
          delete deps[rd];
        }
      }
    }

    for (const [path, content] of deferredWrites.entries()) {
      if (path.endsWith(".xaml")) {
        let sanitized = content;

        sanitized = sanitized.replace(/\s+[a-zA-Z_][\w]*="No auto-correction[^"]*"/g, "");
        sanitized = sanitized.replace(/\s+[a-zA-Z_][\w]*="[^"]*;\s*(?:do not|must not|should not|cannot)[^"]*"/gi, "");

        const wellFormed = validateXmlWellFormedness(sanitized);
        if (!wellFormed.valid) {
          const fileName = path.split("/").pop() || path;
          console.error(`[XML Well-Formedness Gate] ${fileName}: ${wellFormed.errors.join("; ")}`);

          let prevSanitized = "";
          while (prevSanitized !== sanitized) {
            prevSanitized = sanitized;
            sanitized = sanitized.replace(/<ui:TakeScreenshot\s+([^>]*?)(?:FileName|OutputPath)="([^"]*)"([^>]*?)\/>/g, (_m, before, _val, after) => {
              return `<ui:TakeScreenshot ${(before + after).trim()} />`;
            });
          }

          const recheck = validateXmlWellFormedness(sanitized);
          if (!recheck.valid) {
            console.error(`[XML Well-Formedness Gate] ${fileName}: still invalid after targeted fix — replacing with Studio-openable stub`);
            const stubName = fileName.replace(/\.xaml$/i, "");
            const isMainStub = fileName === "Main.xaml" || fileName === `${mainWfName}.xaml`;
            let stubInvokes: Array<{ displayName: string; fileName: string }> | undefined;
            if (isMainStub && nonMainWorkflowNames.length > 0) {
              const seenFiles = new Set<string>();
              stubInvokes = [];
              const initFile = "InitAllSettings.xaml";
              if (!seenFiles.has(initFile)) {
                seenFiles.add(initFile);
                stubInvokes.push({ displayName: "Initialize All Settings", fileName: initFile });
              }
              for (const name of nonMainWorkflowNames) {
                const fn = `${name}.xaml`;
                if (!seenFiles.has(fn) && fn !== fileName) {
                  seenFiles.add(fn);
                  stubInvokes.push({ displayName: name, fileName: fn });
                }
              }
              console.log(`[XML Well-Formedness Gate] Main.xaml stub preserving ${stubInvokes.length} InvokeWorkflowFile reference(s)`);
            }
            const stubXaml = generateStubWorkflow(stubName, {
              reason: `Original XAML failed XML well-formedness validation: ${wellFormed.errors.join("; ")}`,
              invokeWorkflows: stubInvokes && stubInvokes.length > 0 ? stubInvokes : undefined,
            });
            sanitized = stubXaml;
            autoFixSummary.push(`Replaced ${fileName} with Studio-openable stub due to XML well-formedness failure`);
          } else {
            autoFixSummary.push(`Fixed XML well-formedness issues in ${fileName} via targeted repair`);
          }
        }
        archive.append(sanitized, { name: path });
      } else {
        archive.append(content, { name: path });
      }
    }

    sanitizeDeps(deps);
    for (const [key, val] of Object.entries(deps)) {
      if (isFrameworkAssembly(key)) {
        console.log(`[Dependency FinalGuard] Rejected late-surviving framework assembly before emit: ${key}`);
        delete deps[key];
      } else if (!isValidNuGetVersion(val)) {
        console.log(`[Dependency FinalGuard] Rejected invalid version before emit: ${key}=${val}`);
        delete deps[key];
      } else {
        const knownByCatalog = catalogService.isLoaded() && catalogService.getConfirmedVersion(key) !== null;
        const knownByMetadata = _metadataService.getPreferredVersion(key) !== null;
        const knownByBaseline = getBaselineFallbackVersion(key, tf as "Windows" | "Portable") !== null;
        if (!knownByCatalog && !knownByMetadata && !knownByBaseline) {
          console.log(`[Dependency FinalGuard] Rejected unrecognized package before emit: ${key}=${val}`);
          delete deps[key];
        }
      }
    }
    projectJson.dependencies = { ...deps };

    {
      console.log(`[Post-Assembly Validation] Running final validation pass...`);
      const postValidation = runPostAssemblyValidation(
        deps,
        projectJson.studioVersion,
        xamlEntries,
        deferredWrites,
        libPath,
        _studioProfile,
        _metaTarget,
      );

      for (const warning of postValidation.warnings) {
        console.warn(`[Post-Assembly Validation] WARNING: ${warning}`);
        dependencyWarnings.push({
          code: "POST_ASSEMBLY_WARNING",
          message: warning,
          stage: "post-assembly-validation",
          recoverable: true,
        });
      }

      if (!postValidation.passed) {
        const errorDetails = postValidation.errors.map(e => `  - ${e}`).join("\n");
        console.error(`[Post-Assembly Validation] FAILED with ${postValidation.errors.length} error(s):\n${errorDetails}`);
        throw new Error(
          `Post-assembly validation failed with ${postValidation.errors.length} error(s):\n${errorDetails}`
        );
      }

      console.log(`[Post-Assembly Validation] PASSED — all dependency versions validated, entry point verified, studio version confirmed`);
    }

    const finalProjectJsonStr = JSON.stringify(projectJson, null, 2);
    archive.append(finalProjectJsonStr, { name: `${libPath}/project.json` });

    {
      const dhgAnalysis = runDhgAnalysis(
        archiveXamlEntries,
        finalProjectJsonStr,
        qualityWarningCount,
        remediationCount,
        pkg.internal?.automationType || undefined,
        undefined,
        undefined,
        stubAwareness,
        emptyContainerCount,
      );
      dhgAnalysis.hasBlockedWorkflows = dhgStudioCompatibility.some(sc => sc.level === "studio-blocked");
      const dhgContext: DhgContext = {
        projectName,
        workflowNames: archiveWfNames,
        generationMode: generationMode || undefined,
        generationModeReason: modeConfig.reason,
        analysis: dhgAnalysis,
        xamlEntries: archiveXamlEntries,
      };
      const dhg = generateDhgFromOutcomeReport(assemblerOutcomeReport, dhgContext);
      archive.append(dhg, { name: `${libPath}/DeveloperHandoffGuide.md` });
      console.log(`[UiPath] Generated Developer Handoff Guide (structured): ${archiveWfNames.length} workflows, ${outcomeRemediations.length} remediations, REFramework=${useReFramework}`);
    }

    const depEntries = Object.entries(deps).map(
      ([id, ver]) => `      <dependency id="${id}" version="${ver}" />`
    ).join("\n");

    const nuspecXml = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>${projectName}</id>
    <version>${version}</version>
    <title>${escapeXml(pkg.projectName || projectName)}</title>
    <description>${escapeXml(pkg.description || projectName)}</description>
    <authors>CannonBall</authors>
    <owners>CannonBall</owners>
    <requireLicenseAcceptance>false</requireLicenseAcceptance>
    <dependencies>
${depEntries}
    </dependencies>
  </metadata>
</package>`;
    archive.append(nuspecXml, { name: `${projectName}.nuspec` });

  const buffer = await archive.finalize();

  runPostArchiveParityCheck(buffer, _archiveManifestTracker, _appendedContentHashes, xamlEntries, libPath);

  const finalXamlEntries = xamlEntries.map(e => ({ name: e.name, content: e.content }));
  const finalDependencyMap = { ...deps };
  const finalArchiveManifest = allArchivePaths;

  for (const fix of autoFixSummary) {
    let repairCode: RepairCode = "REPAIR_GENERIC";
    if (fix.includes("Catalog: Moved")) repairCode = "REPAIR_CATALOG_PROPERTY_SYNTAX";
    else if (fix.includes("Catalog: Corrected")) repairCode = "REPAIR_CATALOG_PROPERTY_VALUE";
    else if (fix.includes("Catalog: Wrapped")) repairCode = "REPAIR_CATALOG_WRAPPER";
    else if (fix.includes("Normalised LogMessage")) repairCode = "REPAIR_LOG_LEVEL_NORMALIZE";
    else if (fix.includes("Escaped raw ampersand")) repairCode = "REPAIR_AMPERSAND_ESCAPE";
    else if (fix.includes("Escaped bare <")) repairCode = "REPAIR_BARE_ANGLE_ESCAPE";
    else if (fix.includes("Removed duplicate attr")) repairCode = "REPAIR_DUPLICATE_ATTRIBUTE";
    else if (fix.includes("TakeScreenshot OutputPath") || fix.includes("TakeScreenshot FileName")) repairCode = "REPAIR_TAKESCREENSHOT_STRIP";
    else if (fix.includes("Mixed-expression:")) repairCode = "REPAIR_MIXED_EXPRESSION_SYNTAX";
    else if (fix.includes("Per-activity stub") || fix.includes("Per-sequence stub") || fix.includes("per-workflow")) continue;

    const fileMatch = fix.match(/in\s+([\w/.-]+\.xaml)/);
    outcomeAutoRepairs.push({
      repairCode,
      file: fileMatch ? fileMatch[1] : "unknown",
      description: fix,
    });
  }

  if (qualityGateResult.typeRepairs) {
    for (const tr of qualityGateResult.typeRepairs) {
      let repairCode = "REPAIR_TYPE_MISMATCH";
      if (tr.repairKind === "conversion-wrap") repairCode = "REPAIR_TYPE_CONVERSION_WRAP";
      else if (tr.repairKind === "variable-type-change") repairCode = "REPAIR_TYPE_VARIABLE_CHANGE";
      outcomeAutoRepairs.push({
        repairCode,
        file: tr.file,
        description: tr.detail,
      });
    }
  }

  const allFiles = new Set(xamlEntries.map(e => (e.name.split("/").pop() || e.name)));
  const remediatedFiles = new Set(outcomeRemediations.map(r => r.file));
  const structuralDefectChecks = new Set([
    "placeholder-value",
    "empty-container",
    "empty-http-endpoint",
    "unassigned-decision-variable",
    "expression-syntax-mismatch",
    "invalid-type-argument",
    "invalid-default-value",
    "invalid-trycatch-structure",
    "invalid-catch-type",
    "invalid-activity-property",
    "invalid-continue-on-error",
    "invoke-arg-type-mismatch",
    "undeclared-variable",
    "unknown-activity",
    "undeclared-namespace",
    "policy-blocked-activity",
    "invalid-takescreenshot-result",
    "invalid-takescreenshot-outputpath",
    "invalid-takescreenshot-outputpath-attr",
    "invalid-takescreenshot-filename",
    "invalid-takescreenshot-filename-attr",
    "object-object",
    "pseudo-xaml",
    "fake-trycatch",
    "EXPRESSION_SYNTAX",
    "EXPRESSION_SYNTAX_UNFIXABLE",
    "TYPE_MISMATCH",
    "FOREACH_TYPE_MISMATCH",
    "LITERAL_TYPE_ERROR",
  ]);
  const filesWithStructuralDefects = new Set(
    qualityGateResult.violations
      .filter(v => v.severity === "error" && structuralDefectChecks.has(v.check))
      .map(v => v.file)
  );

  const STUB_CONTENT_PATTERNS = [
    "STUB_BLOCKING_FALLBACK",
    "STUB: ",
    "STUB_WORKFLOW_GENERATOR_FAILURE",
    "stub — Final validation remediation",
    "stub due to generation/compliance failure",
    "Manual implementation required",
  ];

  const filesWithStubContent = new Set<string>();
  const studioNonLoadableFiles = new Set<string>();
  const studioLoadabilityReasons = new Map<string, string>();
  for (const entry of xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    if (STUB_CONTENT_PATTERNS.some(pattern => entry.content.includes(pattern))) {
      filesWithStubContent.add(shortName);
    }
    let loadability = checkStudioLoadability(entry.content);
    if (!loadability.loadable && loadability.repairable) {
      const repair = repairMissingImplementation(entry.content, shortName);
      if (repair.repaired) {
        entry.content = repair.content;
        const archivePath = Array.from(deferredWrites.keys()).find(k => (k.split("/").pop() || k) === shortName);
        if (archivePath) deferredWrites.set(archivePath, repair.content);
        loadability = checkStudioLoadability(entry.content);
      }
    }
    if (!loadability.loadable) {
      studioNonLoadableFiles.add(shortName);
      studioLoadabilityReasons.set(shortName, loadability.reason || "Unknown Studio-loadability failure");
      console.log(`[Studio-Loadability] ${shortName}: NOT loadable — ${loadability.reason}`);
    }
  }

  const filesWithBlockingFindings = new Set<string>();
  for (const v of qualityGateResult.violations) {
    if (v.severity === "error") {
      const file = v.file || "unknown";
      filesWithBlockingFindings.add(file);
    }
  }

  const filesWithCatalogViolations = new Set<string>();
  for (const v of qualityGateResult.violations) {
    if (v.check === "CATALOG_STRUCTURAL_VIOLATION" || v.check === "CATALOG_VIOLATION") {
      filesWithCatalogViolations.add(v.file || "unknown");
    }
  }

  const fullyGenerated = Array.from(allFiles).filter(f =>
    !remediatedFiles.has(f) &&
    !earlyStubFallbacks.includes(f) &&
    !filesWithStructuralDefects.has(f) &&
    !filesWithStubContent.has(f) &&
    !studioNonLoadableFiles.has(f) &&
    !filesWithBlockingFindings.has(f) &&
    !filesWithCatalogViolations.has(f)
  );

  const qualityWarnings = qualityGateResult.violations
    .filter(v => v.severity === "warning")
    .map(v => ({
      check: v.check,
      file: v.file || "unknown",
      detail: v.detail,
      severity: v.severity as "warning",
      businessContext: v.businessContext,
      stubCategory: v.stubCategory,
    }));

  const studioBlockingChecks = new Set([
    "empty-container",
    "empty-http-endpoint",
    "invalid-trycatch-structure",
    "invalid-catch-type",
    "invalid-activity-property",
    "undeclared-variable",
    "unknown-activity",
    "undeclared-namespace",
    "invalid-type-argument",
    "invalid-default-value",
    "policy-blocked-activity",
    "pseudo-xaml",
    "fake-trycatch",
    "object-object",
    "EXPRESSION_SYNTAX_UNFIXABLE",
    "TYPE_MISMATCH",
    "FOREACH_TYPE_MISMATCH",
    "LITERAL_TYPE_ERROR",
    "CATALOG_STRUCTURAL_VIOLATION",
    "STRING_FORMAT_OVERFLOW",
    "EXPRESSION_IN_LITERAL_SLOT",
    "UNDECLARED_ARGUMENT",
    "CSHARP_DYNAMIC_TYPE",
    "VB_KEYWORD_AS_VARIABLE",
    "CSHARP_LAMBDA_VARIABLE",
    "STRUCTURAL_NAME_MUTATED",
  ]);
  const studioWarningChecks = new Set([
    "placeholder-value",
    "expression-syntax-mismatch",
    "invoke-arg-type-mismatch",
    "invalid-continue-on-error",
    "EXPRESSION_SYNTAX",
    "UNSAFE_VARIABLE_NAME",
    "empty-catches",
  ]);
  const stubbedFiles = new Set(complianceFallbacks.map(fb => fb.file));
  for (const esf of earlyStubFallbacks) stubbedFiles.add(esf);
  for (const r of outcomeRemediations) {
    if (r.remediationCode === "STUB_WORKFLOW_BLOCKING" || r.remediationCode === "STUB_WORKFLOW_GENERATOR_FAILURE") {
      stubbedFiles.add(r.file);
    }
  }
  for (const f of filesWithStubContent) stubbedFiles.add(f);
  const studioCompatibility: PerWorkflowStudioCompatibility[] = Array.from(allFiles).map(file => {
    if (studioNonLoadableFiles.has(file) && !stubbedFiles.has(file)) {
      const reason = studioLoadabilityReasons.get(file) || "Not Studio-loadable";
      return {
        file,
        level: "studio-blocked" as StudioCompatibilityLevel,
        blockers: [`[STUDIO_LOADABILITY] ${reason}`],
        failureCategory: "structural-invalid" as import("./uipath-pipeline").StubFailureCategory,
        failureSummary: "Structural preservation — valid XML but not Studio-loadable",
      };
    }
    if (stubbedFiles.has(file)) {
      const classified = classifyStubFailureCategory(file, outcomeRemediations, qualityGateResult.violations);
      return {
        file,
        level: "studio-blocked" as StudioCompatibilityLevel,
        blockers: [`[${classified.category.toUpperCase()}] ${classified.summary}`],
        failureCategory: classified.category,
        failureSummary: classified.summary,
      };
    }
    const fileViolations = qualityGateResult.violations.filter(v => v.file === file);
    const blockingViolations = fileViolations.filter(v => v.severity === "error" && studioBlockingChecks.has(v.check));
    const warningViolations = fileViolations.filter(v =>
      (v.severity === "error" && studioWarningChecks.has(v.check)) ||
      (v.severity === "warning" && (studioBlockingChecks.has(v.check) || studioWarningChecks.has(v.check)))
    );
    const blockers = blockingViolations.map(v => `[${v.check}] ${v.detail}`);
    let level: StudioCompatibilityLevel = blockingViolations.length > 0
      ? "studio-blocked"
      : warningViolations.length > 0
        ? "studio-warnings"
        : "studio-clean";
    if (level === "studio-clean" && studioNonLoadableFiles.has(file)) {
      level = "studio-blocked";
      blockers.push(`[STUDIO_LOADABILITY] ${studioLoadabilityReasons.get(file) || "Not Studio-loadable"}`);
    }
    return { file, level, blockers };
  });

  const outcomeReport: PipelineOutcomeReport = {
    fullyGeneratedFiles: fullyGenerated,
    autoRepairs: outcomeAutoRepairs,
    remediations: outcomeRemediations,
    propertyRemediations: [],
    downgradeEvents: [],
    qualityWarnings,
    totalEstimatedEffortMinutes: outcomeRemediations.reduce((s, r) => s + (r.estimatedEffortMinutes || 0), 0),
    structuralPreservationMetrics: structuralPreservationMetrics.length > 0 ? structuralPreservationMetrics : undefined,
    studioCompatibility,
    preEmissionValidation: specValidationReport ? {
      totalActivities: specValidationReport.totalActivities,
      validActivities: specValidationReport.validActivities,
      unknownActivities: specValidationReport.unknownActivities,
      strippedProperties: specValidationReport.strippedProperties,
      enumCorrections: specValidationReport.enumCorrections,
      missingRequiredFilled: specValidationReport.missingRequiredFilled,
      commentConversions: specValidationReport.commentConversions,
      issueCount: specValidationReport.issues.length,
    } : undefined,
  };

  if (buildCacheKey && fingerprint) {
    evictOldestCacheEntry();
    const stageEnrichment: CachedStageEnrichment = {
      fingerprint: enrichmentFp || fingerprint,
      enrichment,
      treeEnrichment,
      usedAIFallback: _usedAIFallback,
    };
    const xamlFp = computeXamlFingerprint(enrichment, treeEnrichment, pkg, orchestratorArtifacts, generationMode, tierStr, finalDependencyMap, tf);
    const stageXaml: CachedStageXaml = {
      fingerprint: xamlFp,
      xamlEntries: finalXamlEntries,
      gaps: allGaps,
      usedPackages: allUsedPkgs,
      dependencyMap: finalDependencyMap,
      archiveManifest: finalArchiveManifest,
      referencedMLSkillNames: [...genCtx.referencedMLSkillNames],
      projectJsonContent: finalProjectJsonStr,
      configCsv: configCsv,
      targetFramework: tf,
      automationPattern,
      buffer,
    };
    const qgFp = computeQualityGateFingerprint(finalXamlEntries, finalProjectJsonStr, configCsv, orchestratorArtifacts, tf, tierStr, automationPattern);
    const stageQualityGate: CachedStageQualityGate = {
      fingerprint: qgFp,
      qualityGatePassed: qualityGateResult.passed,
      qualityGateResult,
    };
    packageBuildCache.set(buildCacheKey, {
      overallFingerprint: fingerprint,
      version,
      buffer,
      gaps: allGaps,
      usedPackages: allUsedPkgs,
      enrichment,
      qualityGatePassed: qualityGateResult.passed,
      qualityGateResult,
      xamlEntries: finalXamlEntries,
      dependencyMap: finalDependencyMap,
      archiveManifest: finalArchiveManifest,
      referencedMLSkillNames: [...genCtx.referencedMLSkillNames],
      usedAIFallback: _usedAIFallback,
      projectJsonContent: finalProjectJsonStr,
      stageEnrichment,
      stageXaml,
      stageQualityGate,
      complexityTier: tierStr,
    });
    console.log(`[UiPath Cache] Stored build for ${buildCacheKey} (${buffer.length} bytes, v${version}) with per-stage fingerprints [enrichment=${stageEnrichment.fingerprint.slice(0, 8)}, xaml=${xamlFp.slice(0, 8)}, qg=${qgFp.slice(0, 8)}]`);
  }
  return { buffer, gaps: allGaps, usedPackages: allUsedPkgs, qualityGateResult, xamlEntries: finalXamlEntries, dependencyMap: finalDependencyMap, archiveManifest: finalArchiveManifest, usedFallbackStubs: usedFallback, generationMode, referencedMLSkillNames: [...genCtx.referencedMLSkillNames], dependencyWarnings: dependencyWarnings.length > 0 ? dependencyWarnings : undefined, usedAIFallback: _usedAIFallback, outcomeReport, projectJsonContent: finalProjectJsonStr };
}

export function createTrackedArchive() {
  const buffers: Buffer[] = [];
  const passthrough = new PassThrough();
  passthrough.on("data", (chunk: Buffer) => buffers.push(chunk));

  const streamDone = new Promise<Buffer>((resolve, reject) => {
    passthrough.on("end", () => resolve(Buffer.concat(buffers)));
    passthrough.on("error", reject);
  });

  const _archive = archiver("zip", { zlib: { level: 9 } });
  _archive.pipe(passthrough);

  const manifest: string[] = [];
  const contentHashes = new Map<string, string>();
  const tracked = {
    append(data: Buffer | string, opts: { name: string }) {
      opts.name = opts.name.replace(/\\/g, "/").replace(/^[./]+/, "");
      manifest.push(opts.name);
      const hashBuffer = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
      contentHashes.set(opts.name, createHash("sha256").update(hashBuffer).digest("hex"));
      return _archive.append(data, opts);
    },
    async finalize(): Promise<Buffer> {
      await _archive.finalize();
      return streamDone;
    },
    manifest,
    contentHashes,
  };

  return tracked;
}

export function runPostArchiveParityCheck(
  buffer: Buffer,
  archiveManifest: string[],
  appendedContentHashes: Map<string, string>,
  xamlEntries?: Array<{ name: string; content: string }>,
  libPath?: string,
): void {
  const parityErrors: string[] = [];
  const appendedPathSet = new Set(archiveManifest);

  const zip = new AdmZip(buffer);
  const zipEntries = zip.getEntries();
  const zipPathSet = new Set<string>();

  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName;
    zipPathSet.add(entryName);

    const expectedHash = appendedContentHashes.get(entryName);
    if (expectedHash) {
      const rawData = entry.getData();
      const actualHash = createHash("sha256").update(rawData).digest("hex");
      if (actualHash !== expectedHash) {
        const utf8Hash = createHash("sha256").update(rawData.toString("utf-8")).digest("hex");
        if (utf8Hash === expectedHash) {
          continue;
        }
        parityErrors.push(`Content mismatch for "${entryName}": expected hash ${expectedHash.substring(0, 12)}..., got ${actualHash.substring(0, 12)}...`);
      }
    }

    if (!appendedPathSet.has(entryName)) {
      parityErrors.push(`Unexpected file "${entryName}" found in final ZIP archive but was not in the appended manifest`);
    }
  }

  for (const appendedPath of archiveManifest) {
    if (!zipPathSet.has(appendedPath)) {
      parityErrors.push(`Appended file "${appendedPath}" is missing from the final ZIP archive`);
    }
  }

  if (xamlEntries && libPath) {
    for (const entry of xamlEntries) {
      const normalizedName = entry.name.replace(/\\/g, "/").replace(/^[./]+/, "");
      const basename = normalizedName.split("/").pop() || normalizedName;
      const archivePath = `${libPath}/${basename}`;
      if (!zipPathSet.has(archivePath)) {
        const altMatch = Array.from(zipPathSet).find(p => p.endsWith("/" + basename) || p === basename);
        if (!altMatch) {
          parityErrors.push(`Validated XAML "${basename}" not found in final archive at expected path "${archivePath}"`);
        }
      } else {
        const expectedHash = appendedContentHashes.get(archivePath);
        if (expectedHash) {
          const entryData = zip.getEntry(archivePath)?.getData();
          if (entryData) {
            const actualHash = createHash("sha256").update(entryData).digest("hex");
            if (actualHash !== expectedHash) {
              const entryContentHash = createHash("sha256").update(entry.content).digest("hex");
              if (entryContentHash === expectedHash) {
                console.log(`[UiPath Post-Archive Parity] "${basename}": cross-library encoding divergence detected (appended hash matches xamlEntry, AdmZip read differs) — treating as pass`);
              } else {
                parityErrors.push(`Content mismatch for validated XAML "${basename}": appended hash ${expectedHash.substring(0, 12)}..., archive hash ${actualHash.substring(0, 12)}..., xamlEntry hash ${entryContentHash.substring(0, 12)}...`);
              }
            }
          }
        } else {
          console.warn(`[UiPath Post-Archive Parity] No appended hash found for "${archivePath}" — skipping content verification`);
        }
      }
    }
  }

  if (parityErrors.length > 0) {
    const details = parityErrors.map(e => `  - ${e}`).join("\n");
    console.error(`[UiPath Post-Archive Parity] FAILED with ${parityErrors.length} mismatch(es):\n${details}`);
    throw new Error(`UiPath post-archive parity check failed with ${parityErrors.length} mismatch(es):\n${details}`);
  } else {
    console.log(`[UiPath Post-Archive Parity] PASSED — all ${archiveManifest.length} appended files verified, ${zipPathSet.size} ZIP entries checked bidirectionally`);
  }
}

export async function rebuildNupkgWithEntries(
  originalBuffer: Buffer,
  xamlEntries: Array<{ name: string; content: string }>,
  archiveManifest: string[],
): Promise<Buffer | null> {
  try {
    if (!originalBuffer || originalBuffer.length === 0) {
      console.warn("[Nupkg Rebuild] Original buffer is empty — cannot rebuild");
      return null;
    }

    const zip = new AdmZip(originalBuffer);

    const xamlOverrides = new Map<string, string>();
    for (const entry of xamlEntries) {
      const archivePaths = archiveManifest.filter(
        p => p === entry.name || p.endsWith(`/${entry.name}`) || p.endsWith(`\\${entry.name}`)
      );
      for (const archivePath of archivePaths) {
        xamlOverrides.set(archivePath, entry.content);
      }
      if (archivePaths.length === 0) {
        console.warn(`[Nupkg Rebuild] No archive path found for XAML entry: ${entry.name}`);
      }
    }

    const arc = createTrackedArchive();
    let overriddenCount = 0;

    const missingEntries: string[] = [];
    for (const entryPath of archiveManifest) {
      let data: Buffer | string;
      if (xamlOverrides.has(entryPath)) {
        data = xamlOverrides.get(entryPath)!;
        overriddenCount++;
      } else {
        const zipEntry = zip.getEntry(entryPath);
        if (zipEntry) {
          data = zipEntry.getData();
        } else {
          missingEntries.push(entryPath);
          console.error(`[Nupkg Rebuild] Manifest entry not found in original archive: ${entryPath}`);
          continue;
        }
      }
      arc.append(data, { name: entryPath });
    }

    if (missingEntries.length > 0) {
      console.error(`[Nupkg Rebuild] ${missingEntries.length} manifest entries missing from original archive — rebuild aborted`);
      return null;
    }

    const rebuilt = await arc.finalize();

    if (rebuilt.length === 0) {
      console.warn("[Nupkg Rebuild] Rebuilt buffer is empty");
      return null;
    }

    const libPath = archiveManifest.find(p => p.startsWith("lib/net6.0/"))
      ? "lib/net6.0"
      : "lib/net45";

    try {
      runPostArchiveParityCheck(rebuilt, archiveManifest, arc.contentHashes, xamlEntries, libPath);
    } catch (parityErr: unknown) {
      const msg = parityErr instanceof Error ? parityErr.message : String(parityErr);
      console.error(`[Nupkg Rebuild] Post-rebuild parity check failed: ${msg}`);
      return null;
    }

    console.log(`[Nupkg Rebuild] Success — ${arc.manifest.length} entries (${overriddenCount} overridden), ${rebuilt.length} bytes`);
    return rebuilt;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Nupkg Rebuild] Failed: ${msg}`);
    return null;
  }
}

export async function uploadNupkgBuffer(
  config: UiPathConfig,
  token: string,
  nupkgBuffer: Buffer,
  projectName: string,
  version: string
): Promise<{ ok: boolean; status: number; responseText: string }> {
  const fileName = `${projectName}.${version}.nupkg`;
  const boundary = `----FormBoundary${Date.now()}`;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const headerBuf = Buffer.from(header, "utf-8");
  const footerBuf = Buffer.from(footer, "utf-8");
  const body = Buffer.concat([headerBuf, nupkgBuffer, footerBuf]);

  const orchUrl = _metadataService.getServiceUrl("OR", config);
  const uploadUrl = `${orchUrl}/odata/Processes/UiPath.Server.Configuration.OData.UploadPackage`;

  console.log(`[UiPath] Uploading to: ${uploadUrl}`);
  console.log(`[UiPath] Package size: ${body.length} bytes, filename: ${fileName}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  };

  if (config.folderId) {
    headers["X-UIPATH-OrganizationUnitId"] = config.folderId;
    console.log(`[UiPath] Targeting folder: ${config.folderName || config.folderId} (ID: ${config.folderId})`);
  }

  const uploadController = new AbortController();
  const uploadTimeout = setTimeout(() => uploadController.abort(), 120000);
  try {
    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers,
      body,
      signal: uploadController.signal,
    });

    const responseText = await uploadRes.text();
    console.log(`[UiPath] Upload response status: ${uploadRes.status}`);
    console.log(`[UiPath] Upload response body: ${responseText.slice(0, 1000)}`);

    return { ok: uploadRes.ok, status: uploadRes.status, responseText };
  } catch (err: any) {
    if (err.name === "AbortError") {
      console.log(`[UiPath] Upload timed out after 120s`);
      return { ok: false, status: 408, responseText: "Upload timed out after 120 seconds" };
    }
    throw err;
  } finally {
    clearTimeout(uploadTimeout);
  }
}

