export type ContractDefectType =
  | "unknown_target_argument"
  | "invalid_invoke_serialization";

export type ContractDefectSeverity = "execution_blocking" | "handoff_required";

export interface ContractIntegrityDefect {
  file: string;
  workflow: string;
  defectType: ContractDefectType;
  activityType: string;
  propertyName: string;
  targetWorkflow: string;
  targetArgument: string;
  offendingValue: string;
  severity: ContractDefectSeverity;
  detectionMethod: string;
  notes: string;
}

export type ExclusionCategory =
  | "designer_metadata"
  | "view_state"
  | "layout_hint"
  | "idref_reference"
  | "annotation"
  | "non_runtime_serialization";

export interface ContractExtractionExclusion {
  file: string;
  workflow: string;
  activityType: string;
  propertyName: string;
  exclusionCategory: ExclusionCategory;
  exclusionReason: string;
}

export interface ContractIntegritySummaryMetrics {
  totalContractDefects: number;
  totalExecutionBlocking: number;
  totalHandoffRequired: number;
  totalUnknownTargetArguments: number;
  totalInvalidInvokeSerialization: number;
  totalExcludedNonContractFields: number;
  exclusionsByCategory: Record<ExclusionCategory, number>;
}

export interface ContractIntegrityResult {
  contractIntegrityDefects: ContractIntegrityDefect[];
  hasContractIntegrityIssues: boolean;
  contractIntegritySummary?: string;
  contractIntegritySummaryMetrics: ContractIntegritySummaryMetrics;
  contractExtractionExclusions: ContractExtractionExclusion[];
}

interface WorkflowContract {
  file: string;
  workflow: string;
  arguments: Set<string>;
}

interface InvocationBinding {
  file: string;
  workflow: string;
  activityType: string;
  targetWorkflow: string;
  bindings: Array<{ propertyName: string; value: string }>;
}

const INVOKE_ACTIVITY_TYPES = ["ui:InvokeWorkflowFile", "InvokeWorkflowFile"];
const INVOKE_SYSTEM_ATTRS = new Set([
  "displayname",
  "workflowfilename",
  "continueonerror",
  "private",
  "sap2010:workflowviewstate.idref",
]);

const PSEUDO_PROPERTY_NAMES = new Set(["Then", "Body", "Variables"]);

const NON_CONTRACT_EXCLUSION_PATTERNS: Array<{ pattern: RegExp; category: ExclusionCategory; reason: string }> = [
  { pattern: /^sap2010:WorkflowViewState\./i, category: "view_state", reason: "WF designer view-state property" },
  { pattern: /^sap:WorkflowViewStateService\./i, category: "view_state", reason: "WF designer view-state service property" },
  { pattern: /^WorkflowViewState\./i, category: "view_state", reason: "WF designer view-state property" },
  { pattern: /^sap:VirtualizedContainerService\./i, category: "layout_hint", reason: "Designer virtualization layout hint" },
  { pattern: /^VirtualizedContainerService\./i, category: "layout_hint", reason: "Designer virtualization layout hint" },
  { pattern: /\.IdRef$/i, category: "idref_reference", reason: "Designer IdRef tracking reference" },
  { pattern: /^Annotation\./i, category: "annotation", reason: "Designer annotation-only field" },
  { pattern: /^sap2010:Annotation\./i, category: "annotation", reason: "Designer annotation field" },
  { pattern: /^mc:/i, category: "non_runtime_serialization", reason: "Markup compatibility attribute" },
  { pattern: /^mva:VisualBasic\.Settings$/i, category: "non_runtime_serialization", reason: "VB settings serialization artifact" },
  { pattern: /^TextExpression\./i, category: "non_runtime_serialization", reason: "Text expression metadata" },
];

const NON_CONTRACT_EXACT_NAMES = new Map<string, { category: ExclusionCategory; reason: string }>([
  ["HintSize", { category: "layout_hint", reason: "Designer layout sizing hint" }],
  ["WorkflowViewState.IdRef", { category: "idref_reference", reason: "Designer IdRef tracking reference" }],
]);

function normalizeFilePath(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

function deriveWorkflowName(fileName: string): string {
  return normalizeFilePath(fileName).split("/").pop()?.replace(/\.xaml$/i, "") || fileName;
}

function normalizeTargetWorkflow(workflowFileName: string): string {
  const normalized = normalizeFilePath(workflowFileName);
  return normalized.toLowerCase().endsWith(".xaml") ? normalized : `${normalized}.xaml`;
}

function classifyNonContractProperty(attrName: string): { category: ExclusionCategory; reason: string } | null {
  const exact = NON_CONTRACT_EXACT_NAMES.get(attrName);
  if (exact) return exact;
  for (const { pattern, category, reason } of NON_CONTRACT_EXCLUSION_PATTERNS) {
    if (pattern.test(attrName)) return { category, reason };
  }
  if (/^sap\d*:/.test(attrName)) {
    return { category: "designer_metadata", reason: "SAP designer namespace property" };
  }
  return null;
}

function buildWorkflowContracts(entries: Array<{ name: string; content: string }>): Map<string, WorkflowContract> {
  const contracts = new Map<string, WorkflowContract>();
  const propertyPattern = /<x:Property\b[^>]*\bName="([^"]+)"[^>]*\bType="([^"]+)"[^>]*\/?>/g;
  for (const entry of entries) {
    const normalizedName = normalizeFilePath(entry.name);
    const argumentsSet = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = propertyPattern.exec(entry.content)) !== null) {
      const name = match[1];
      const type = match[2];
      if (/^InArgument\(/i.test(type) || /^OutArgument\(/i.test(type) || /^InOutArgument\(/i.test(type)) {
        argumentsSet.add(name);
      }
    }
    contracts.set(normalizedName.toLowerCase(), {
      file: normalizedName,
      workflow: deriveWorkflowName(normalizedName),
      arguments: argumentsSet,
    });
  }
  return contracts;
}

function extractInvocations(
  content: string,
  fileName: string,
  workflowName: string,
  exclusions: ContractExtractionExclusion[],
  defects: ContractIntegrityDefect[],
): InvocationBinding[] {
  const invocations: InvocationBinding[] = [];
  for (const activityType of INVOKE_ACTIVITY_TYPES) {
    const pattern = new RegExp(`<${activityType}\\b([\\s\\S]*?)(?:>([\\s\\S]*?)<\\/${activityType}>|\\/>)`, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const attrs = match[1] || "";
      const body = match[2] || "";
      const wfNameMatch = /WorkflowFileName="([^"]+)"/i.exec(attrs);
      if (!wfNameMatch) continue;
      const targetWorkflow = normalizeTargetWorkflow(wfNameMatch[1]);
      const bindings = new Map<string, string>();

      const attrPattern = /(?:^|\s)([A-Za-z_][\w.:]*)\s*=\s*"([^"]*)"/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrPattern.exec(attrs)) !== null) {
        const attrName = attrMatch[1];
        const attrValue = attrMatch[2];
        if (attrName.startsWith("xmlns") || attrName.startsWith("x:")) continue;
        if (INVOKE_SYSTEM_ATTRS.has(attrName.toLowerCase())) continue;

        const nonContract = classifyNonContractProperty(attrName);
        if (nonContract) {
          exclusions.push({
            file: fileName,
            workflow: workflowName,
            activityType,
            propertyName: attrName,
            exclusionCategory: nonContract.category,
            exclusionReason: nonContract.reason,
          });
          continue;
        }

        if (PSEUDO_PROPERTY_NAMES.has(attrName)) {
          defects.push({
            file: fileName,
            workflow: workflowName,
            defectType: "invalid_invoke_serialization",
            activityType,
            propertyName: attrName,
            targetWorkflow,
            targetArgument: "",
            offendingValue: attrValue.slice(0, 200),
            severity: "execution_blocking",
            detectionMethod: "invoke_attr_classification",
            notes: `Pseudo-property "${attrName}" on ${activityType} is not a valid contract carrier.`,
          });
          continue;
        }

        if (!bindings.has(attrName)) {
          bindings.set(attrName, attrValue);
        }
      }

      const argBlockPattern = /<[^>]*\.Arguments>\s*([\s\S]*?)\s*<\/[^>]*\.Arguments>/i;
      const argsMatch = argBlockPattern.exec(body);
      if (argsMatch) {
        const argEntryPattern = /x:Key="([^"]+)"[^>]*>([\s\S]*?)<\/(?:InArgument|OutArgument|InOutArgument)>/g;
        let argMatch: RegExpExecArray | null;
        while ((argMatch = argEntryPattern.exec(argsMatch[1])) !== null) {
          const key = argMatch[1];
          const value = argMatch[2].trim();
          if (!bindings.has(key)) {
            bindings.set(key, value);
          }
        }
      }

      invocations.push({
        file: fileName,
        workflow: workflowName,
        activityType,
        targetWorkflow,
        bindings: Array.from(bindings.entries()).map(([propertyName, value]) => ({ propertyName, value })),
      });
    }
  }
  return invocations;
}

export function validateContractIntegrity(entries: Array<{ name: string; content: string }>): ContractIntegrityResult {
  const defects: ContractIntegrityDefect[] = [];
  const exclusions: ContractExtractionExclusion[] = [];
  const contracts = buildWorkflowContracts(entries);

  for (const entry of entries) {
    const normalizedName = normalizeFilePath(entry.name);
    const workflowName = deriveWorkflowName(normalizedName);
    const invocations = extractInvocations(entry.content, normalizedName, workflowName, exclusions, defects);
    for (const invocation of invocations) {
      const childContract = contracts.get(invocation.targetWorkflow.toLowerCase());
      if (!childContract) continue;

      for (const binding of invocation.bindings) {
        if (!childContract.arguments.has(binding.propertyName)) {
          defects.push({
            file: invocation.file,
            workflow: invocation.workflow,
            defectType: "unknown_target_argument",
            activityType: invocation.activityType,
            propertyName: binding.propertyName,
            targetWorkflow: childContract.file,
            targetArgument: binding.propertyName,
            offendingValue: binding.value.slice(0, 200),
            severity: "execution_blocking",
            detectionMethod: "parent_child_contract_match",
            notes: `Invocation passes "${binding.propertyName}" but ${childContract.workflow} does not declare it.`,
          });
        }
      }
    }
  }

  const exclusionsByCategory: Record<ExclusionCategory, number> = {
    designer_metadata: 0,
    view_state: 0,
    layout_hint: 0,
    idref_reference: 0,
    annotation: 0,
    non_runtime_serialization: 0,
  };
  for (const exclusion of exclusions) {
    exclusionsByCategory[exclusion.exclusionCategory]++;
  }

  const summaryMetrics: ContractIntegritySummaryMetrics = {
    totalContractDefects: defects.length,
    totalExecutionBlocking: defects.filter((d) => d.severity === "execution_blocking").length,
    totalHandoffRequired: defects.filter((d) => d.severity === "handoff_required").length,
    totalUnknownTargetArguments: defects.filter((d) => d.defectType === "unknown_target_argument").length,
    totalInvalidInvokeSerialization: defects.filter((d) => d.defectType === "invalid_invoke_serialization").length,
    totalExcludedNonContractFields: exclusions.length,
    exclusionsByCategory,
  };

  const parts: string[] = [];
  if (summaryMetrics.totalExecutionBlocking > 0) parts.push(`${summaryMetrics.totalExecutionBlocking} execution-blocking`);
  if (summaryMetrics.totalHandoffRequired > 0) parts.push(`${summaryMetrics.totalHandoffRequired} handoff-required`);
  if (summaryMetrics.totalExcludedNonContractFields > 0) parts.push(`${summaryMetrics.totalExcludedNonContractFields} non-contract field(s) excluded`);
  const summary = parts.length > 0
    ? `Contract integrity: ${parts.join(", ")}`
    : "Contract integrity: clean";

  return {
    contractIntegrityDefects: defects,
    hasContractIntegrityIssues: defects.length > 0,
    contractIntegritySummary: summary,
    contractIntegritySummaryMetrics: summaryMetrics,
    contractExtractionExclusions: exclusions,
  };
}
