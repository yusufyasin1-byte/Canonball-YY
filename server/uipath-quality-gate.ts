import {
  ACTIVITY_REGISTRY,
  DESIGNER_PROPERTIES,
  ACTIVITIES_SUPPORTING_CONTINUE_ON_ERROR,
  scanXamlForRequiredPackages,
  normalizeActivityName,
  type ActivityPropertyInfo,
  type VersionedProperty,
  type AutomationPattern,
} from "./uipath-activity-registry";
import { getBlockedActivities } from "./uipath-activity-policy";
import { catalogService } from "./catalog/catalog-service";
import type { StudioProfile } from "./catalog/metadata-service";
import { metadataService } from "./catalog/metadata-service";
import { lintXamlExpressions } from "./xaml/vbnet-expression-linter";
import { validateTypeCompatibility } from "./xaml/type-compatibility-validator";
import { scoreSelectorQuality, generateSelectorWarnings, injectResilienceDefaults } from "./xaml/selector-quality-scorer";
import { XAML_INFRASTRUCTURE_TYPE_ARGUMENTS } from "./xaml/xaml-compliance";

const KNOWN_ACTIVITIES = ACTIVITY_REGISTRY;

const KNOWN_ACTIVITIES_CI: Record<string, typeof ACTIVITY_REGISTRY[string]> = {};
for (const [key, value] of Object.entries(ACTIVITY_REGISTRY)) {
  KNOWN_ACTIVITIES_CI[key.toLowerCase()] = value;
}

function lookupActivity(activityName: string) {
  const normalized = normalizeActivityName(activityName);
  return KNOWN_ACTIVITIES[normalized] ?? KNOWN_ACTIVITIES_CI[normalized.toLowerCase()];
}

export type QualityGateViolation = {
  category: "blocked-pattern" | "completeness" | "accuracy" | "runtime-safety" | "logic-location";
  severity: "error" | "warning";
  check: string;
  file: string;
  detail: string;
  businessContext?: string;
  stubCategory?: "handoff" | "failure";
};

export type PositiveEvidence = {
  check: string;
  file: string;
  detail: string;
};

export type CompletenessLevel = "structural" | "functional" | "incomplete";

export type TypeRepairAction = {
  file: string;
  line?: number;
  activity?: string;
  property?: string;
  expectedType?: string;
  actualType?: string;
  repairKind?: string;
  boundVariable?: string;
  detail?: string;
  repair?: string;
};

export type PackageReadiness = "SUCCESS" | "READY_WITH_WARNINGS" | "NEEDS_ATTENTION";

export type QualityGateResult = {
  passed: boolean;
  violations: QualityGateViolation[];
  positiveEvidence: PositiveEvidence[];
  completenessLevel: CompletenessLevel;
  typeRepairs: TypeRepairAction[];
  readiness: PackageReadiness;
  summary: {
    blockedPatterns: number;
    completenessErrors: number;
    completenessWarnings: number;
    accuracyErrors: number;
    accuracyWarnings: number;
    runtimeSafetyErrors: number;
    runtimeSafetyWarnings: number;
    logicLocationWarnings: number;
    totalErrors: number;
    totalWarnings: number;
  };
};

export type QualityGateInput = {
  xamlEntries: { name: string; content: string }[];
  projectJsonContent: string;
  configData?: string;
  orchestratorArtifacts?: any;
  targetFramework: "Windows" | "Portable";
  archiveManifest?: string[];
  archiveContentHashes?: Record<string, string>;
  automationPattern?: AutomationPattern;
};

const VALID_XMLNS_PREFIXES = new Set([
  "x", "mc", "s", "sap", "sap2010", "scg", "scg2", "ui", "ua",
  "mca", "clr", "local", "p", "mva", "sads", "sapv",
  "uweb", "uds", "upers", "uexcel", "umail", "udb", "uml", "uocr",
  "sco",
]);

const VALID_EXCEPTION_TYPES = new Set([
  "System.Exception",
  "System.BusinessRuleException",
  "System.ApplicationException",
  "System.InvalidOperationException",
  "System.ArgumentException",
  "System.ArgumentNullException",
  "System.NullReferenceException",
  "System.TimeoutException",
  "System.IO.IOException",
  "System.IO.FileNotFoundException",
  "System.Net.WebException",
  "System.Net.Http.HttpRequestException",
  "System.Data.DataException",
  "System.FormatException",
  "System.OverflowException",
  "System.IndexOutOfRangeException",
  "System.Collections.Generic.KeyNotFoundException",
  "UiPath.Core.Activities.BusinessRuleException",
  "System.Activities.WorkflowApplicationAbortedException",
]);

const VALID_TYPE_ARGUMENTS = new Set([
  "x:String", "x:Int32", "x:Int64", "x:Boolean", "x:Double", "x:Decimal", "x:Object",
  "s:DateTime", "s:TimeSpan",
  "scg2:DataTable", "scg2:DataRow",
  "s:Security.SecureString", "s:Net.Mail.MailMessage",
  "s:Exception",
  "ui:QueueItem", "ui:QueueItemData",
  "System.String", "System.Int32", "System.Int64", "System.Boolean",
  "System.Double", "System.Decimal", "System.Object",
  "System.DateTime", "System.TimeSpan",
  "System.Data.DataTable", "System.Data.DataRow",
  "System.Exception",
  ...XAML_INFRASTRUCTURE_TYPE_ARGUMENTS,
]);

const CREDENTIAL_PATTERNS = [
  /password\s*[:=]\s*["'](?!\[)[^"']{4,}["']/i,
  /apikey\s*[:=]\s*["'](?!\[)[^"']{8,}["']/i,
  /api_key\s*[:=]\s*["'](?!\[)[^"']{8,}["']/i,
  /secret\s*[:=]\s*["'](?!\[)[^"']{8,}["']/i,
  /Bearer\s+[A-Za-z0-9\-_.~+/]{20,}/,
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/,
  /Data Source=[^;]*;.*Password=[^;]+/i,
  /Server=[^;]*;.*Password=[^;]+/i,
];

const PLACEHOLDER_PATTERNS = [
  /\bTODO\b/,
  /\bPLACEHOLDER\b/,
  /\bCHANGEME\b/,
  /\bexample\.com\b/,
];

const CRITICAL_WORKFLOW_PATTERNS = [
  /^Main\.xaml$/i,
  /^Process\.xaml$/i,
  /^Dispatcher\.xaml$/i,
  /^Performer\.xaml$/i,
  /^GetTransactionData\.xaml$/i,
  /^SetTransactionStatus\.xaml$/i,
  /^ContactResolver\.xaml$/i,
  /^MessageComposer\.xaml$/i,
  /^EmailSender\.xaml$/i,
  /^CalendarReader\.xaml$/i,
  /^InitAllSettings\.xaml$/i,
];

const CRITICAL_GENERATION_FAILURE_PATTERNS = [
  "IMPLEMENTATION_REPAIRED",
  "VB_EXPRESSION_BLOCKED",
  "ASSEMBLY_FAILED",
  "CONTAINER_VALIDATION_FAILED",
  "STUB_WORKFLOW_GENERATOR_FAILURE",
  "STUB_BLOCKING_FALLBACK",
  "Unknown activity template",
  "Unsupported activity:",
  "Manual implementation required",
];

function isCriticalWorkflowFile(fileName: string): boolean {
  return CRITICAL_WORKFLOW_PATTERNS.some(pattern => pattern.test(fileName));
}

function scanCriticalWorkflowIntegrity(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];
  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    if (!isCriticalWorkflowFile(shortName)) continue;

    for (const marker of CRITICAL_GENERATION_FAILURE_PATTERNS) {
      if (entry.content.includes(marker)) {
        violations.push({
          category: "completeness",
          severity: "error",
          check: "critical-workflow-generation-failure",
          file: shortName,
          detail: `Critical workflow contains generation-failure marker "${marker}" and cannot be considered near-production`,
        });
      }
    }

    if (/<ui:Comment[^>]*Text="\[(?:BLOCKED|TODO)/i.test(entry.content)) {
      violations.push({
        category: "completeness",
        severity: "error",
        check: "critical-workflow-placeholder-blocker",
        file: shortName,
        detail: "Critical workflow contains blocked/TODO comment stubs in the emitted XAML",
      });
    }
  }
  return violations;
}

function scanBlockedPatterns(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];

  if (input.automationPattern) {
    const blockedSet = getBlockedActivities(input.automationPattern);
    for (const entry of input.xamlEntries) {
      const shortName = entry.name.split("/").pop() || entry.name;
      for (const activity of blockedSet) {
        if (entry.content.includes(`<${activity}`) || entry.content.includes(`<${activity} `)) {
          violations.push({
            category: "blocked-pattern",
            severity: "warning",
            check: "policy-blocked-activity",
            file: shortName,
            detail: `Activity "${activity}" is blocked by policy for pattern "${input.automationPattern}"`,
          });
        }
      }
    }
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    if (content.includes("TakeScreenshot.Result") || content.includes("TakeScreenshot.OutputPath") || /TakeScreenshot[^>]*OutputPath=/.test(content) || content.includes("TakeScreenshot.FileName") || /TakeScreenshot[^>]*FileName=/.test(content)) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("TakeScreenshot.Result")) {
          violations.push({
            category: "blocked-pattern",
            severity: "error",
            check: "invalid-takescreenshot-result",
            file: shortName,
            detail: `Line ${i + 1}: TakeScreenshot.Result is not a valid property — TakeScreenshot has no Result output`,
          });
        }
        if (lines[i].includes("TakeScreenshot.OutputPath")) {
          violations.push({
            category: "blocked-pattern",
            severity: "error",
            check: "invalid-takescreenshot-outputpath",
            file: shortName,
            detail: `Line ${i + 1}: TakeScreenshot.OutputPath is not a valid property — strip OutputPath entirely`,
          });
        }
        if (/TakeScreenshot[^>]*OutputPath="/.test(lines[i])) {
          violations.push({
            category: "blocked-pattern",
            severity: "error",
            check: "invalid-takescreenshot-outputpath-attr",
            file: shortName,
            detail: `Line ${i + 1}: TakeScreenshot has invalid OutputPath attribute — this attribute is not supported`,
          });
        }
        if (lines[i].includes("TakeScreenshot.FileName")) {
          violations.push({
            category: "blocked-pattern",
            severity: "error",
            check: "invalid-takescreenshot-filename",
            file: shortName,
            detail: `Line ${i + 1}: TakeScreenshot.FileName is not a valid property — strip FileName entirely`,
          });
        }
        if (/TakeScreenshot[^>]*FileName="/.test(lines[i])) {
          violations.push({
            category: "blocked-pattern",
            severity: "error",
            check: "invalid-takescreenshot-filename-attr",
            file: shortName,
            detail: `Line ${i + 1}: TakeScreenshot has invalid FileName attribute — this attribute is not supported`,
          });
        }
      }
    }

    if (content.includes("[object Object]")) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("[object Object]")) {
          violations.push({
            category: "blocked-pattern",
            severity: "error",
            check: "object-object",
            file: shortName,
            detail: `Line ${i + 1}: contains "[object Object]" — serialization failure`,
          });
        }
      }
    }

    const pseudoXamlPattern = /\b(Then|Else|Cases|Body|Finally|Try|Catches)="([^"]*)"/g;
    let match;
    while ((match = pseudoXamlPattern.exec(content)) !== null) {
      const attrName = match[1];
      const attrValue = match[2];
      const contextBefore = content.substring(Math.max(0, match.index - 80), match.index);
      const isInChildElement = /\.\s*$/.test(contextBefore.trimEnd()) ||
        contextBefore.includes(`<If.${attrName}`) ||
        contextBefore.includes(`<Switch.${attrName}`) ||
        contextBefore.includes(`<TryCatch.${attrName}`) ||
        contextBefore.includes(`<ForEach.${attrName}`) ||
        contextBefore.includes(`<Sequence.${attrName}`) ||
        contextBefore.includes(`<ParallelForEach.${attrName}`);
      if (isInChildElement) continue;
      const isPartOfDisplayName = /DisplayName="[^"]*$/.test(contextBefore);
      if (isPartOfDisplayName) continue;
      if (attrValue.length > 0 && attrValue !== "True" && attrValue !== "False") {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "blocked-pattern",
          severity: "error",
          check: "pseudo-xaml",
          file: shortName,
          detail: `Line ${lineNum}: pseudo-XAML attribute ${attrName}="${attrValue.substring(0, 80)}${attrValue.length > 80 ? "..." : ""}"`,
        });
      }
    }

    const fakeTryCatchPattern = /TryCatch\s+[^>]*(?:Try|Catches|Finally)="[^"]+"/g;
    while ((match = fakeTryCatchPattern.exec(content)) !== null) {
      if (/DisplayName="[^"]*$/.test(content.substring(Math.max(0, match.index - 80), match.index))) continue;
      const lineNum = content.substring(0, match.index).split("\n").length;
      violations.push({
        category: "blocked-pattern",
        severity: "error",
        check: "fake-trycatch",
        file: shortName,
        detail: `Line ${lineNum}: TryCatch uses string attributes instead of nested elements`,
      });
    }

    if (input.targetFramework === "Portable" && content.includes("lib/net45")) {
      const lineNum = content.split("\n").findIndex(l => l.includes("lib/net45")) + 1;
      violations.push({
        category: "blocked-pattern",
        severity: "error",
        check: "net45-in-portable",
        file: shortName,
        detail: `Line ${lineNum}: references lib/net45 path in Portable/Serverless target`,
      });
    }
  }

  if (input.projectJsonContent) {
    if (input.projectJsonContent.includes("[object Object]")) {
      violations.push({
        category: "blocked-pattern",
        severity: "error",
        check: "object-object",
        file: "project.json",
        detail: `project.json contains "[object Object]"`,
      });
    }

    try {
      const pj = JSON.parse(input.projectJsonContent);
      if (pj.designOptions?.modernBehavior === false) {
        violations.push({
          category: "blocked-pattern",
          severity: "error",
          check: "legacy-modern-behavior",
          file: "project.json",
          detail: `modernBehavior is set to false — must be true for Modern projects`,
        });
      }
    } catch {}
  }

  return violations;
}

function checkCompleteness(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];

  let projectJson: any = null;
  try {
    projectJson = JSON.parse(input.projectJsonContent);
  } catch {
    violations.push({
      category: "completeness",
      severity: "error",
      check: "project-json-parse",
      file: "project.json",
      detail: "project.json is not valid JSON",
    });
    return violations;
  }

  if (projectJson.designOptions?.modernBehavior !== true) {
    violations.push({
      category: "completeness",
      severity: "error",
      check: "modern-project",
      file: "project.json",
      detail: "Project must have modernBehavior: true",
    });
  }

  const tf = projectJson.targetFramework;
  if (tf !== "Windows" && tf !== "Portable") {
    violations.push({
      category: "completeness",
      severity: "error",
      check: "target-framework",
      file: "project.json",
      detail: `targetFramework "${tf}" is not valid — must be "Windows" or "Portable"`,
    });
  }

  const fileBasenames = new Set(input.xamlEntries.map(e => {
    const parts = e.name.split("/");
    return parts[parts.length - 1];
  }));
  const fileFullPaths = new Set(input.xamlEntries.map(e => e.name));

  if (!fileBasenames.has("Main.xaml")) {
    violations.push({
      category: "completeness",
      severity: "error",
      check: "main-xaml",
      file: "package",
      detail: "Main.xaml is missing from the package",
    });
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    const invokePattern = /WorkflowFileName="([^"]+)"/g;
    let match;
    while ((match = invokePattern.exec(content)) !== null) {
      const invokedFile = match[1];

      const basenameExists = fileBasenames.has(invokedFile);
      let pathExists = false;
      if (invokedFile.includes("/") || invokedFile.includes("\\")) {
        const normalized = invokedFile.replace(/\\/g, "/");
        pathExists = fileFullPaths.has(normalized) ||
          Array.from(fileFullPaths).some(fp => fp.endsWith("/" + normalized));
      } else {
        pathExists = basenameExists;
      }

      if (!pathExists) {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "completeness",
          severity: "error",
          check: "invoked-file",
          file: shortName,
          detail: `Line ${lineNum}: InvokeWorkflowFile references "${invokedFile}" which does not exist in the package`,
        });
      }

      if (invokedFile.includes("/") || invokedFile.includes("\\")) {
        const normalizedInvoke = invokedFile.replace(/\\/g, "/");
        const matchingEntry = Array.from(fileFullPaths).find(fp => {
          const fpBasename = fp.split("/").pop();
          return fpBasename === normalizedInvoke.split("/").pop();
        });
        if (matchingEntry && !matchingEntry.endsWith("/" + normalizedInvoke) && !matchingEntry.endsWith(normalizedInvoke)) {
          const lineNum = content.substring(0, match.index).split("\n").length;
          violations.push({
            category: "completeness",
            severity: "error",
            check: "invoke-path-mismatch",
            file: shortName,
            detail: `Line ${lineNum}: InvokeWorkflowFile path "${invokedFile}" does not match actual archive path "${matchingEntry}"`,
          });
        }
      }
    }
  }

  const deps = projectJson.dependencies;
  if (!deps || typeof deps !== "object" || Object.keys(deps).length === 0) {
    violations.push({
      category: "completeness",
      severity: "error",
      check: "dependencies",
      file: "project.json",
      detail: "No dependencies declared in project.json",
    });
  } else {
    for (const [depName, depVer] of Object.entries(deps)) {
      if (typeof depVer !== "string" || !depVer.match(/^\[?\d+\.\d+\.\d+/)) {
        violations.push({
          category: "completeness",
          severity: "error",
          check: "dependency-version",
          file: "project.json",
          detail: `Dependency "${depName}" has invalid version: "${depVer}"`,
        });
      }
    }
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(content)) {
        violations.push({
          category: "completeness",
          severity: "warning",
          check: "hardcoded-credential",
          file: shortName,
          detail: `Potential hardcoded credential detected (pattern: ${pattern.source.substring(0, 30)}...)`,
        });
        break;
      }
    }

    const commentPattern = /<!--[\s\S]*?-->/g;
    const contentWithoutComments = content.replace(commentPattern, "");

    for (const pattern of PLACEHOLDER_PATTERNS) {
      const matches = contentWithoutComments.match(new RegExp(pattern.source, "gi"));
      if (matches && matches.length > 0) {
        const hasFailureMarkers = /STUB_BLOCKING_FALLBACK|ASSEMBLY_FAILED|Generator failed|Generator could not|VB_EXPRESSION_BLOCKED|IMPLEMENTATION_REPAIRED/i.test(content);
        const stubCategory: "handoff" | "failure" = hasFailureMarkers ? "failure" : "handoff";
        const categoryLabel = stubCategory === "failure"
          ? "Generation Failure — Pipeline Error"
          : "Developer Implementation Required";
        violations.push({
          category: "completeness",
          severity: "warning",
          check: "placeholder-value",
          file: shortName,
          detail: `Contains ${matches.length} placeholder value(s) matching "${pattern.source}" [${categoryLabel}]`,
          stubCategory,
        });
      }
    }
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    const httpEndpointPattern = /<(?:ui|uweb):HttpClient\s[^>]*(?:Endpoint|Url)\s*=\s*""/g;
    const openBrowserPattern = /<ui:OpenBrowser\s[^>]*(?:Url|InputUrl)\s*=\s*""/g;
    const httpPropPattern = /<(?:ui|uweb):HttpClient\.(?:Endpoint|Url)>\s*<InArgument[^>]*>\s*<\/(?:ui|uweb):HttpClient\.(?:Endpoint|Url)>/g;
    const openBrowserPropPattern = /<ui:OpenBrowser\.(?:Url|InputUrl)>\s*<InArgument[^>]*>\s*<\/InArgument>\s*<\/ui:OpenBrowser\.(?:Url|InputUrl)>/g;

    let emMatch;
    while ((emMatch = httpEndpointPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, emMatch.index).split("\n").length;
      violations.push({
        category: "completeness",
        severity: "error",
        check: "empty-http-endpoint",
        file: shortName,
        detail: `Line ${lineNum}: HttpClient has an empty Endpoint/Url — HTTP request will fail at runtime`,
      });
    }
    while ((emMatch = openBrowserPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, emMatch.index).split("\n").length;
      violations.push({
        category: "completeness",
        severity: "error",
        check: "empty-http-endpoint",
        file: shortName,
        detail: `Line ${lineNum}: ui:OpenBrowser has an empty Url — browser will not navigate`,
      });
    }
    while ((emMatch = httpPropPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, emMatch.index).split("\n").length;
      violations.push({
        category: "completeness",
        severity: "error",
        check: "empty-http-endpoint",
        file: shortName,
        detail: `Line ${lineNum}: HttpClient has an empty Endpoint/Url property element — HTTP request will fail at runtime`,
      });
    }
    while ((emMatch = openBrowserPropPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, emMatch.index).split("\n").length;
      violations.push({
        category: "completeness",
        severity: "error",
        check: "empty-http-endpoint",
        file: shortName,
        detail: `Line ${lineNum}: ui:OpenBrowser has an empty Url property element — browser will not navigate`,
      });
    }
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;
    const flaggedVars = new Set<string>();

    const checkStatusVarAssignment = (expr: string, contextIndex: number, source: string) => {
      const statusVarPattern = /\b(int_\w*StatusCode\w*|\w*StatusCode\w*)\b/g;
      let varMatch;
      while ((varMatch = statusVarPattern.exec(expr)) !== null) {
        const varName = varMatch[1];
        if (!varName.startsWith("int_") && !varName.includes("StatusCode")) continue;
        if (flaggedVars.has(varName)) continue;

        const beforeContext = content.substring(0, contextIndex);
        const assignPattern = new RegExp(
          `<Assign\\.To>\\s*<OutArgument[^>]*>\\s*\\[${varName}\\]\\s*</OutArgument>|` +
          `<(?:ui|uweb):HttpClient[^>]*ResponseStatusCode[^>]*\\[${varName}\\]|` +
          `To="\\[${varName}\\]"`,
          "s"
        );
        if (!assignPattern.test(beforeContext)) {
          const lineNum = content.substring(0, contextIndex).split("\n").length;
          violations.push({
            category: "completeness",
            severity: "warning",
            check: "unassigned-decision-variable",
            file: shortName,
            detail: `Line ${lineNum}: variable "${varName}" is used in ${source} condition but is never assigned earlier in this workflow — decision gate may always take the same branch`,
          });
          flaggedVars.add(varName);
        }
      }
    };

    const conditionPattern = /Condition="\[([^\]]+)\]"/g;
    let condMatch;
    while ((condMatch = conditionPattern.exec(content)) !== null) {
      checkStatusVarAssignment(condMatch[1], condMatch.index, "If");
    }

    const switchExprPattern = /Expression="\[([^\]]+)\]"/g;
    let switchMatch;
    while ((switchMatch = switchExprPattern.exec(content)) !== null) {
      const contextBefore = content.substring(Math.max(0, switchMatch.index - 200), switchMatch.index);
      if (contextBefore.includes("<Switch") || contextBefore.includes("<Switch.")) {
        checkStatusVarAssignment(switchMatch[1], switchMatch.index, "Switch");
      }
    }

    const switchTypeArgPattern = /<Switch\s[^>]*x:TypeArguments="x:Int32"[^>]*>\s*<Switch\.Expression>\s*<InArgument[^>]*>\s*\[([^\]]+)\]/g;
    while ((switchMatch = switchTypeArgPattern.exec(content)) !== null) {
      checkStatusVarAssignment(switchMatch[1], switchMatch.index, "Switch");
    }
  }

  if (input.configData && input.xamlEntries.length > 0) {
    const allXamlContent = input.xamlEntries.map(e => e.content).join("\n");
    const configKeyPattern = /in_Config\("([^"]+)"\)/g;
    const referencedKeys = new Set<string>();
    let match;
    while ((match = configKeyPattern.exec(allXamlContent)) !== null) {
      referencedKeys.add(match[1]);
    }

    if (referencedKeys.size > 0 && input.configData) {
      for (const key of referencedKeys) {
        if (!input.configData.includes(key)) {
          violations.push({
            category: "completeness",
            severity: "warning",
            check: "config-key-missing",
            file: "Config.xlsx",
            detail: `Config key "${key}" is referenced in XAML but not found in config data`,
          });
        }
      }
    }
  }

  if (input.orchestratorArtifacts && input.xamlEntries.length > 0) {
    const allXamlContent = input.xamlEntries.map(e => e.content).join("\n");
    const assetPattern = /AssetName="([^"]+)"/g;
    const referencedAssets = new Set<string>();
    let match;
    while ((match = assetPattern.exec(allXamlContent)) !== null) {
      let name = match[1];
      name = name.replace(/&quot;/g, "").replace(/^"|"$/g, "");
      if (!name.startsWith("TODO") && !name.startsWith("PLACEHOLDER")) {
        referencedAssets.add(name);
      }
    }

    const vbExpressionAssetPatterns = [
      /GetAsset\s*\(\s*"([^"]+)"\s*\)/g,
      /GetCredential\s*\(\s*"([^"]+)"\s*\)/g,
      /in_Config\s*\(\s*"([^"]+)"\s*\)/g,
      /dict_Config\s*\(\s*"([^"]+)"\s*\)/g,
    ];
    for (const vbPattern of vbExpressionAssetPatterns) {
      let vbMatch;
      while ((vbMatch = vbPattern.exec(allXamlContent)) !== null) {
        let name = vbMatch[1];
        name = name.replace(/&quot;/g, "").replace(/^"|"$/g, "");
        if (!name.startsWith("TODO") && !name.startsWith("PLACEHOLDER")) {
          referencedAssets.add(name);
        }
      }
    }

    const escapedExprPatterns = [
      /GetAsset\s*\(\s*&quot;([^&]+)&quot;\s*\)/g,
      /GetCredential\s*\(\s*&quot;([^&]+)&quot;\s*\)/g,
      /in_Config\s*\(\s*&quot;([^&]+)&quot;\s*\)/g,
      /dict_Config\s*\(\s*&quot;([^&]+)&quot;\s*\)/g,
    ];
    for (const escPattern of escapedExprPatterns) {
      let escMatch;
      while ((escMatch = escPattern.exec(allXamlContent)) !== null) {
        let name = escMatch[1];
        if (!name.startsWith("TODO") && !name.startsWith("PLACEHOLDER")) {
          referencedAssets.add(name);
        }
      }
    }

    if (referencedAssets.size > 0 && input.orchestratorArtifacts) {
      const declaredArtifacts = new Set<string>();
      for (const asset of input.orchestratorArtifacts.assets || []) {
        if (asset?.name) declaredArtifacts.add(String(asset.name));
      }
      for (const queue of input.orchestratorArtifacts.queues || []) {
        if (queue?.name) declaredArtifacts.add(String(queue.name));
      }
      declaredArtifacts.add("OrchestratorQueueName");
      declaredArtifacts.add("NotificationRecipientEmail");
      declaredArtifacts.add("ReviewTaskCatalog");

      for (const asset of referencedAssets) {
        if (!declaredArtifacts.has(asset)) {
          violations.push({
            category: "completeness",
            severity: "warning",
            check: "undeclared-asset",
            file: "orchestrator",
            detail: `Asset "${asset}" is referenced in XAML but not declared in orchestrator artifacts`,
          });
        }
      }
    }
  }

  return violations;
}

function extractDeclaredSymbols(content: string): { variables: Map<string, string>; arguments: Map<string, { type: string; direction: string }> } {
  const variables = new Map<string, string>();
  const arguments_ = new Map<string, { type: string; direction: string }>();

  const varPattern = /<Variable\s+x:TypeArguments="([^"]+)"\s+[^>]*Name="([^"]+)"/g;
  const varPattern2 = /<Variable\s+[^>]*Name="([^"]+)"[^>]*x:TypeArguments="([^"]+)"/g;
  let m;
  while ((m = varPattern.exec(content)) !== null) {
    variables.set(m[2], m[1]);
  }
  while ((m = varPattern2.exec(content)) !== null) {
    variables.set(m[1], m[2]);
  }

  const varFallbackPattern = /<Variable\s[^>]*\bName="([^"]+)"/g;
  while ((m = varFallbackPattern.exec(content)) !== null) {
    if (!variables.has(m[1])) {
      const typeMatch = content.substring(m.index, m.index + m[0].length + 200).match(/x:TypeArguments="([^"]+)"/);
      variables.set(m[1], typeMatch ? typeMatch[1] : "x:Object");
    }
  }

  const propPattern = /<x:Property\s+Name="([^"]+)"\s+Type="([^"]+)"/g;
  while ((m = propPattern.exec(content)) !== null) {
    const name = m[1];
    const typeStr = m[2];
    let direction = "InArgument";
    if (typeStr.includes("OutArgument")) direction = "OutArgument";
    else if (typeStr.includes("InOutArgument")) direction = "InOutArgument";
    const typeMatch = typeStr.match(/Argument\(([^)]+)\)/);
    const baseType = typeMatch ? typeMatch[1] : typeStr;
    arguments_.set(name, { type: baseType, direction });
  }

  const delegatePattern = /<DelegateInArgument[^>]*Name="([^"]+)"/g;
  while ((m = delegatePattern.exec(content)) !== null) {
    variables.set(m[1], "DelegateInArgument");
  }

  return { variables, arguments: arguments_ };
}

const STANDARD_ACTIVITY_TYPES = new Set([
  "TryCatch", "ForEach", "ParallelForEach", "If", "Switch",
  "While", "DoWhile", "Sequence", "Assign", "Delay", "Throw",
]);

function checkActivityProperties(content: string, shortName: string, violations: QualityGateViolation[]): void {
  const activityBlockPattern = /<(ui:[A-Za-z]+|TryCatch|ForEach|ParallelForEach|If|Switch|While|DoWhile|Sequence|Assign|Delay|Throw)\s+([^>]*?)(\s*\/?>)/g;
  let match;
  while ((match = activityBlockPattern.exec(content)) !== null) {
    const activityName = match[1];
    const attrsStr = match[2];
    const knownActivity = lookupActivity(activityName);
    if (!knownActivity) continue;

    const allAllowed = new Set([
      ...(knownActivity.properties.required || []),
      ...(knownActivity.properties.optional || []),
      "DisplayName", "Selector", "Target", "x:TypeArguments",
      ...Array.from(DESIGNER_PROPERTIES),
    ]);

    const strippedAttrsStr = attrsStr.replace(/"[^"]*"/g, '""');
    const attrPattern = /\b([A-Za-z][A-Za-z0-9_.]*)\s*=/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(strippedAttrsStr)) !== null) {
      const propName = attrMatch[1];
      if (propName.startsWith("xmlns") || propName.startsWith("sap2010:") ||
          propName.startsWith("sap:") || propName === "x:Class" ||
          propName === "mc:Ignorable" || propName === "TypeArguments") continue;
      if (!allAllowed.has(propName)) {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "accuracy",
          severity: "warning",
          check: "invalid-activity-property",
          file: shortName,
          detail: `Line ${lineNum}: property "${propName}" is not a known property of ${activityName}`,
        });
      }
      if (propName === "ContinueOnError" && !ACTIVITIES_SUPPORTING_CONTINUE_ON_ERROR.has(activityName)) {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "accuracy",
          severity: "error",
          check: "invalid-continue-on-error",
          file: shortName,
          detail: `Line ${lineNum}: ContinueOnError is not supported on ${activityName} — only UI Automation activities may use ContinueOnError`,
        });
      }
    }
  }
}

function checkVariableArgumentDeclarations(input: QualityGateInput, violations: QualityGateViolation[]): void {
  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;
    const { variables, arguments: args } = extractDeclaredSymbols(content);
    const allDeclared = new Set([...variables.keys(), ...args.keys()]);
    const isInitAllSettings = shortName.toLowerCase().includes("initallsettings");

    const keywords = new Set([
      "True", "False", "Nothing", "null", "New", "Not", "And", "Or", "If",
      "String", "Integer", "Boolean", "DateTime", "Math", "Convert", "CType",
      "CStr", "CInt", "CDbl", "Environment", "TimeSpan", "Now", "Today",
      "System", "Console", "Exception", "Array", "Type",
    ]);

    const exprPattern = /\[([^\[\]]+)\]/g;
    let match;
    while ((match = exprPattern.exec(content)) !== null) {
      const rawExpr = match[1];
      if (rawExpr.startsWith("&quot;") || rawExpr.startsWith("\"") || rawExpr.startsWith("'")) continue;
      if (/^\d+$/.test(rawExpr)) continue;

      const expr = rawExpr
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'");

      const stringPattern = /"(?:[^"\\]|\\.)*"/g;
      const exprWithoutStrings = expr.replace(stringPattern, (m) => " ".repeat(m.length));

      const identPattern = /\b([a-zA-Z_]\w*)\b/g;
      let idMatch;
      while ((idMatch = identPattern.exec(exprWithoutStrings)) !== null) {
        const ident = idMatch[1];
        if (keywords.has(ident)) continue;
        if (/^[A-Z][a-z]/.test(ident) && expr.includes(`${ident}.`) && !allDeclared.has(ident)) continue;
        const prefixes = ["str_", "int_", "bool_", "dt_", "qi_", "obj_", "dbl_", "sec_", "io_", "in_", "out_", "list_", "arr_", "dict_"];
        if (prefixes.some(p => ident.startsWith(p)) && !allDeclared.has(ident)) {
          if (ident === "dict_Config") {
            if (!isInitAllSettings && !allDeclared.has("in_Config")) {
              const lineNum = content.substring(0, match.index).split("\n").length;
              violations.push({
                category: "completeness",
                severity: "warning",
                check: "dict-config-scope",
                file: shortName,
                detail: `Line ${lineNum}: "dict_Config" is referenced but not declared — add an "in_Config" argument of type Dictionary(Of String, Object) to receive config from the parent workflow`,
              });
            }
            continue;
          }
          const lineNum = content.substring(0, match.index).split("\n").length;
          violations.push({
            category: "completeness",
            severity: "error",
            check: "undeclared-variable",
            file: shortName,
            detail: `Line ${lineNum}: variable "${ident}" is used in expression but not declared in this workflow`,
          });
        }
      }
    }
  }
}

function checkInvokeArgumentTypes(input: QualityGateInput, violations: QualityGateViolation[]): void {
  const workflowArgs = new Map<string, Map<string, { type: string; direction: string }>>();
  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const { arguments: args } = extractDeclaredSymbols(entry.content);
    workflowArgs.set(shortName, args);
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    const invokeBlockPattern = /<ui:InvokeWorkflowFile[^>]*WorkflowFileName="([^"]+)"[^>]*>[\s\S]*?<ui:InvokeWorkflowFile\.Arguments>([\s\S]*?)<\/ui:InvokeWorkflowFile\.Arguments>/g;
    let match;
    while ((match = invokeBlockPattern.exec(content)) !== null) {
      const targetFile = match[1];
      const argsContent = match[2];
      const targetArgs = workflowArgs.get(targetFile);
      if (!targetArgs) continue;

      const argPattern = /x:TypeArguments="([^"]+)"\s+x:Key="([^"]+)"/g;
      const argPattern2 = /x:Key="([^"]+)"[^>]*x:TypeArguments="([^"]+)"/g;
      let argMatch;
      while ((argMatch = argPattern.exec(argsContent)) !== null) {
        const passedType = argMatch[1];
        const argName = argMatch[2];
        const declaredArg = targetArgs.get(argName);
        if (declaredArg) {
          const normalizedPassed = normalizeTypeName(passedType);
          const normalizedDeclared = normalizeTypeName(declaredArg.type);
          if (normalizedPassed !== normalizedDeclared && normalizedPassed !== "x:Object") {
            const lineNum = content.substring(0, match.index).split("\n").length;
            violations.push({
              category: "accuracy",
              severity: "error",
              check: "invoke-arg-type-mismatch",
              file: shortName,
              detail: `Line ${lineNum}: argument "${argName}" passed as ${passedType} to "${targetFile}" but declared as ${declaredArg.type}`,
            });
          }
        }
      }
      while ((argMatch = argPattern2.exec(argsContent)) !== null) {
        const argName = argMatch[1];
        const passedType = argMatch[2];
        const declaredArg = targetArgs.get(argName);
        if (declaredArg) {
          const normalizedPassed = normalizeTypeName(passedType);
          const normalizedDeclared = normalizeTypeName(declaredArg.type);
          if (normalizedPassed !== normalizedDeclared && normalizedPassed !== "x:Object") {
            const lineNum = content.substring(0, match.index).split("\n").length;
            violations.push({
              category: "accuracy",
              severity: "error",
              check: "invoke-arg-type-mismatch",
              file: shortName,
              detail: `Line ${lineNum}: argument "${argName}" passed as ${passedType} to "${targetFile}" but declared as ${declaredArg.type}`,
            });
          }
        }
      }
    }
  }
}

function normalizeTypeName(t: string): string {
  const lower = t.toLowerCase().trim();
  if (lower === "x:string" || lower === "system.string" || lower === "string") return "x:String";
  if (lower === "x:int32" || lower === "system.int32" || lower === "int32" || lower === "integer") return "x:Int32";
  if (lower === "x:int64" || lower === "system.int64" || lower === "int64") return "x:Int64";
  if (lower === "x:boolean" || lower === "system.boolean" || lower === "boolean" || lower === "bool") return "x:Boolean";
  if (lower === "x:double" || lower === "system.double" || lower === "double") return "x:Double";
  if (lower === "x:decimal" || lower === "system.decimal" || lower === "decimal") return "x:Decimal";
  if (lower === "x:object" || lower === "system.object" || lower === "object") return "x:Object";
  if (lower.includes("dictionary(") || lower.includes("dictionary<") || lower.includes("clr-namespace:system.collections.generic")) {
    return "Dictionary<String,Object>";
  }
  if (lower.includes("list(") || lower.includes("list<")) return "List";
  if (lower.includes("datatable")) return "DataTable";
  if (lower.includes("datarow")) return "DataRow";
  return t;
}

function checkTryCatchStructure(content: string, shortName: string, violations: QualityGateViolation[]): void {
  const tryCatchPattern = /<TryCatch\s/g;
  let match;
  while ((match = tryCatchPattern.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split("\n").length;
    const after = content.substring(match.index, Math.min(content.length, match.index + 5000));

    const closingIdx = after.indexOf("</TryCatch>");
    if (closingIdx === -1) continue;
    const tryCatchBlock = after.substring(0, closingIdx + 11);

    if (!tryCatchBlock.includes("<TryCatch.Try>") && !tryCatchBlock.includes("<TryCatch.Catches>")) {
      violations.push({
        category: "accuracy",
        severity: "warning",
        check: "invalid-trycatch-structure",
        file: shortName,
        detail: `Line ${lineNum}: TryCatch is missing <TryCatch.Try> and/or <TryCatch.Catches> child elements`,
      });
    }

    if (tryCatchBlock.includes("<TryCatch.Catches>")) {
      const catchesStart = tryCatchBlock.indexOf("<TryCatch.Catches>");
      const catchesEnd = tryCatchBlock.indexOf("</TryCatch.Catches>");
      if (catchesStart !== -1 && catchesEnd !== -1) {
        const catchesBlock = tryCatchBlock.substring(catchesStart, catchesEnd);
        if (!catchesBlock.includes("<Catch")) {
          violations.push({
            category: "accuracy",
            severity: "warning",
            check: "empty-catches",
            file: shortName,
            detail: `Line ${lineNum}: TryCatch has <TryCatch.Catches> but no <Catch> elements inside`,
          });
        }

        const catchExceptionPattern = /<Catch\s+x:TypeArguments="([^"]+)"/g;
        let catchMatch;
        while ((catchMatch = catchExceptionPattern.exec(catchesBlock)) !== null) {
          const exType = catchMatch[1];
          if (!VALID_EXCEPTION_TYPES.has(exType) && !exType.startsWith("System.") && !exType.includes("Exception")) {
            violations.push({
              category: "accuracy",
              severity: "warning",
              check: "invalid-catch-type",
              file: shortName,
              detail: `Line ${lineNum}: Catch uses x:TypeArguments="${exType}" which is not a valid exception type`,
            });
          }
        }
      }
    }
  }
}

function checkDefaultValueSyntax(content: string, shortName: string, targetFramework: "Windows" | "Portable", violations: QualityGateViolation[]): void {
  const varDefaultPattern = /<Variable\s+x:TypeArguments="([^"]+)"[^>]*Default="([^"]*)"[^>]*Name="([^"]+)"/g;
  const varDefaultPattern2 = /<Variable\s+[^>]*Name="([^"]+)"[^>]*x:TypeArguments="([^"]+)"[^>]*Default="([^"]*)"/g;
  let match;

  const checkDefault = (typeName: string, defaultVal: string, varName: string, idx: number) => {
    if (!defaultVal || defaultVal.startsWith("[") || defaultVal === "") return;
    const lower = typeName.toLowerCase();

    if ((lower === "x:int32" || lower === "x:int64" || lower === "int32" || lower === "int64") && !/^-?\d+$/.test(defaultVal)) {
      const lineNum = content.substring(0, idx).split("\n").length;
      violations.push({
        category: "accuracy",
        severity: "warning",
        check: "invalid-default-value",
        file: shortName,
        detail: `Line ${lineNum}: variable "${varName}" type ${typeName} has non-numeric default: "${defaultVal}"`,
      });
    }
    if ((lower === "x:boolean" || lower === "boolean") && !["True", "False", "true", "false"].includes(defaultVal)) {
      const lineNum = content.substring(0, idx).split("\n").length;
      violations.push({
        category: "accuracy",
        severity: "warning",
        check: "invalid-default-value",
        file: shortName,
        detail: `Line ${lineNum}: variable "${varName}" type ${typeName} has non-boolean default: "${defaultVal}"`,
      });
    }
    if ((lower === "x:double" || lower === "x:decimal" || lower === "double" || lower === "decimal") && !/^-?\d+\.?\d*$/.test(defaultVal)) {
      const lineNum = content.substring(0, idx).split("\n").length;
      violations.push({
        category: "accuracy",
        severity: "warning",
        check: "invalid-default-value",
        file: shortName,
        detail: `Line ${lineNum}: variable "${varName}" type ${typeName} has non-numeric default: "${defaultVal}"`,
      });
    }
  };

  while ((match = varDefaultPattern.exec(content)) !== null) {
    checkDefault(match[1], match[2], match[3] || "unknown", match.index);
  }
  while ((match = varDefaultPattern2.exec(content)) !== null) {
    checkDefault(match[2], match[3], match[1] || "unknown", match.index);
  }
}

function checkAccuracy(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];

  let projectJson: any = null;
  try {
    projectJson = JSON.parse(input.projectJsonContent);
  } catch {
    return violations;
  }

  const declaredDeps = new Set(Object.keys(projectJson.dependencies || {}));

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    const activityPattern = /<(ui:[A-Za-z]+)\s/g;
    let match;
    while ((match = activityPattern.exec(content)) !== null) {
      const activityName = match[1];
      const knownActivity = lookupActivity(activityName);

      if (!knownActivity) {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "accuracy",
          severity: "error",
          check: "unknown-activity",
          file: shortName,
          detail: `Line ${lineNum}: unknown activity "${activityName}" — not in known activity registry (may be hallucinated)`,
        });
        continue;
      }

      if (knownActivity.package && !declaredDeps.has(knownActivity.package)) {
        violations.push({
          category: "accuracy",
          severity: "warning",
          check: "missing-package-dep",
          file: shortName,
          detail: `Activity "${activityName}" requires package "${knownActivity.package}" which is not in project.json dependencies`,
        });
      }
    }

    checkActivityProperties(content, shortName, violations);

    const xmlnsDeclared = new Set<string>();
    const xmlnsPattern = /xmlns:([a-zA-Z0-9]+)="([^"]+)"/g;
    while ((match = xmlnsPattern.exec(content)) !== null) {
      xmlnsDeclared.add(match[1]);
    }

    const prefixUsagePattern = /<([a-zA-Z0-9]+):[A-Za-z]+[\s/>]/g;
    const usedPrefixes = new Set<string>();
    while ((match = prefixUsagePattern.exec(content)) !== null) {
      usedPrefixes.add(match[1]);
    }

    for (const prefix of usedPrefixes) {
      if (prefix === "xmlns") continue;
      if (!xmlnsDeclared.has(prefix)) {
        violations.push({
          category: "accuracy",
          severity: "error",
          check: "undeclared-namespace",
          file: shortName,
          detail: `Namespace prefix "${prefix}:" is used in the XAML body but has no xmlns declaration on the root element`,
        });
      }
    }

    const BUILTIN_XAML_ELEMENTS = new Set([
      "Activity", "Sequence", "If", "Assign", "TryCatch", "Catch", "ForEach", "While", "DoWhile",
      "Switch", "Throw", "Rethrow", "Delay", "Flowchart", "FlowStep", "FlowDecision", "FlowSwitch",
      "StateMachine", "State", "Transition", "ParallelForEach", "TransactionScope",
      "Variable", "Argument", "ActivityAction", "DelegateInArgument", "DelegateOutArgument",
      "InArgument", "OutArgument", "InOutArgument", "Literal",
      "VisualBasicValue", "VisualBasicReference", "CSharpValue", "CSharpReference",
      "TextExpression", "ExpressionServices",
    ]);
    const unprefixedActivityPattern = /<([A-Z][a-zA-Z]+)\s+[^>]*(?:DisplayName|WorkflowFileName)="[^"]*"/g;
    let unprefixedMatch;
    while ((unprefixedMatch = unprefixedActivityPattern.exec(content)) !== null) {
      const tagName = unprefixedMatch[1];
      if (tagName.includes(":") || tagName.includes(".")) continue;
      if (BUILTIN_XAML_ELEMENTS.has(tagName)) continue;
      if (/^(Sequence|Variable|Argument|Activity)/.test(tagName)) continue;
      const lineNum = content.substring(0, unprefixedMatch.index).split("\n").length;
      violations.push({
        category: "accuracy",
        severity: "error",
        check: "unprefixed-activity",
        file: shortName,
        detail: `Line ${lineNum}: Activity "${tagName}" has no namespace prefix — Studio will fail to resolve it. Expected a prefix like "ui:${tagName}"`,
      });
    }

    if (input.targetFramework === "Windows") {
      const csharpInterpolation = /\$"[^"]*\{[^}]+\}[^"]*"/g;
      while ((match = csharpInterpolation.exec(content)) !== null) {
        const contextBefore = content.substring(Math.max(0, match.index - 100), match.index);
        if (contextBefore.includes("<!--") && !contextBefore.includes("-->")) continue;
        if (/ExpressionLanguage="CSharp"/.test(content)) continue;
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "accuracy",
          severity: "error",
          check: "expression-syntax-mismatch",
          file: shortName,
          detail: `Line ${lineNum}: C# string interpolation $"..." found in Windows/VB.NET project — use String.Format or & concatenation`,
        });
      }
    }

    if (input.targetFramework === "Portable") {
      const vbConcatPattern = /"\s*&\s*[a-zA-Z_]\w*/g;
      while ((match = vbConcatPattern.exec(content)) !== null) {
        const contextBefore = content.substring(Math.max(0, match.index - 100), match.index);
        if (contextBefore.includes("<!--") && !contextBefore.includes("-->")) continue;
        if (/ExpressionLanguage="VisualBasic"/.test(content)) continue;
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "accuracy",
          severity: "error",
          check: "expression-syntax-mismatch",
          file: shortName,
          detail: `Line ${lineNum}: VB.NET & concatenation found in Portable/C# project — use + or string interpolation`,
        });
      }
    }

    const typeArgsPattern = /x:TypeArguments="([^"]+)"/g;
    while ((match = typeArgsPattern.exec(content)) !== null) {
      const typeArg = match[1];
      if (!VALID_TYPE_ARGUMENTS.has(typeArg) &&
          !typeArg.includes("List") &&
          !typeArg.includes("Dictionary") &&
          !typeArg.includes(",") &&
          !typeArg.startsWith("scg:") &&
          !typeArg.startsWith("s:") &&
          !typeArg.startsWith("ui:") &&
          !typeArg.startsWith("x:") &&
          !typeArg.startsWith("System.")) {
        const contextBefore = content.substring(Math.max(0, match.index - 100), match.index);
        if (contextBefore.includes("<Catch")) continue;
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "accuracy",
          severity: "warning",
          check: "invalid-type-argument",
          file: shortName,
          detail: `Line ${lineNum}: x:TypeArguments="${typeArg}" may not be a valid .NET type`,
        });
      }
    }

    checkTryCatchStructure(content, shortName, violations);

    checkDefaultValueSyntax(content, shortName, input.targetFramework, violations);

    const emptySequencePattern = /<Sequence\s[^>]*DisplayName="([^"]*)"[^>]*>\s*<\/Sequence>/g;
    while ((match = emptySequencePattern.exec(content)) !== null) {
      const displayName = match[1];
      const lineNum = content.substring(0, match.index).split("\n").length;
      violations.push({
        category: "accuracy",
        severity: "error",
        check: "empty-container",
        file: shortName,
        detail: `Line ${lineNum}: empty <Sequence> "${displayName}" — may indicate dropped generation output`,
      });
    }

    const emptyFlowchartPattern = /<Flowchart\s[^>]*DisplayName="([^"]*)"[^>]*>\s*<\/Flowchart>/g;
    while ((match = emptyFlowchartPattern.exec(content)) !== null) {
      const displayName = match[1];
      const lineNum = content.substring(0, match.index).split("\n").length;
      violations.push({
        category: "accuracy",
        severity: "error",
        check: "empty-container",
        file: shortName,
        detail: `Line ${lineNum}: empty <Flowchart> "${displayName}" — may indicate dropped generation output`,
      });
    }

    const emptySequenceWithVarsPattern = /<Sequence\s[^>]*DisplayName="([^"]*)"[^>]*>\s*<Sequence\.Variables\s*\/>\s*<\/Sequence>/g;
    while ((match = emptySequenceWithVarsPattern.exec(content)) !== null) {
      const displayName = match[1];
      const lineNum = content.substring(0, match.index).split("\n").length;
      violations.push({
        category: "accuracy",
        severity: "error",
        check: "empty-container",
        file: shortName,
        detail: `Line ${lineNum}: <Sequence> "${displayName}" has only an empty Variables block — no actual activities`,
      });
    }
  }

  checkVariableArgumentDeclarations(input, violations);
  checkInvokeArgumentTypes(input, violations);
  checkVersionCompatibility(input, violations);

  return violations;
}

function checkArchiveParity(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];
  if (!input.archiveManifest || input.archiveManifest.length === 0) return violations;

  const validatedBasenames = new Set<string>();
  for (const entry of input.xamlEntries) {
    const basename = entry.name.split("/").pop() || entry.name;
    validatedBasenames.add(basename);
  }
  validatedBasenames.add("project.json");

  const archiveBasenames = new Set<string>();
  const archivePathByBasename = new Map<string, string>();
  for (const archivePath of input.archiveManifest) {
    const basename = archivePath.split("/").pop() || archivePath;
    archiveBasenames.add(basename);
    archivePathByBasename.set(basename, archivePath);
  }

  for (const entry of input.xamlEntries) {
    const basename = entry.name.split("/").pop() || entry.name;
    if (!archiveBasenames.has(basename)) {
      violations.push({
        category: "completeness",
        severity: "error",
        check: "archive-parity-missing-from-archive",
        file: basename,
        detail: `Validated file "${basename}" is not present in the final archive`,
      });
    }
  }

  if (input.archiveContentHashes && Object.keys(input.archiveContentHashes).length > 0) {
    for (const entry of input.xamlEntries) {
      const basename = entry.name.split("/").pop() || entry.name;
      const archivePath = archivePathByBasename.get(basename);
      if (!archivePath) continue;
      const archiveHash = input.archiveContentHashes[archivePath];
      const validatedHash = input.archiveContentHashes[`__validated__${archivePath}`]
        || input.archiveContentHashes[`__validated__${basename}`];
      if (!archiveHash) {
        violations.push({
          category: "completeness",
          severity: "error",
          check: "archive-content-hash-missing",
          file: basename,
          detail: `No content hash recorded for archive path "${archivePath}" — cannot verify byte-for-byte parity`,
        });
        continue;
      }
      if (!validatedHash) {
        violations.push({
          category: "completeness",
          severity: "error",
          check: "archive-content-hash-missing",
          file: basename,
          detail: `No validated content hash found for "${basename}" — cannot verify byte-for-byte parity`,
        });
        continue;
      }
      if (validatedHash !== archiveHash) {
        violations.push({
          category: "completeness",
          severity: "error",
          check: "archive-content-hash-mismatch",
          file: basename,
          detail: `Content hash mismatch: validated content for "${basename}" differs from archive content at "${archivePath}" — file may have been modified after validation`,
        });
      }
    }
  }

  const requiredNonXamlFiles = ["project.json", "Config.xlsx", "DeveloperHandoffGuide.md"];
  for (const required of requiredNonXamlFiles) {
    if (!archiveBasenames.has(required)) {
      violations.push({
        category: "completeness",
        severity: "warning",
        check: "archive-parity-missing-artifact",
        file: required,
        detail: `Expected artifact "${required}" is not present in the archive manifest`,
      });
    }
  }

  const hasNuspec = input.archiveManifest.some(p => p.endsWith(".nuspec"));
  if (!hasNuspec) {
    violations.push({
      category: "completeness",
      severity: "error",
      check: "archive-parity-missing-artifact",
      file: "*.nuspec",
      detail: `No .nuspec file found in the archive — package metadata is missing`,
    });
  }

  for (const archivePath of input.archiveManifest) {
    const basename = archivePath.split("/").pop() || archivePath;
    const isNugetMeta = archivePath.startsWith("_rels/") ||
      archivePath.startsWith("package/") ||
      archivePath === "[Content_Types].xml" ||
      archivePath.endsWith(".nuspec") ||
      archivePath.endsWith(".psmdcp");
    if (isNugetMeta) continue;

    if (!basename.endsWith(".xaml")) continue;
    if (!validatedBasenames.has(basename)) {
      violations.push({
        category: "completeness",
        severity: "error",
        check: "archive-parity-not-validated",
        file: basename,
        detail: `Archive contains XAML file "${archivePath}" that was not validated through the quality gate`,
      });
    }
  }

  return violations;
}

const PACKAGE_MAJOR_VERSION_RANGES: Record<string, { windowsMajors: number[]; portableMajors: number[] }> = {
  "UiPath.UIAutomation.Activities": { windowsMajors: [25], portableMajors: [25] },
  "UiPath.System.Activities": { windowsMajors: [25], portableMajors: [25] },
  "UiPath.Web.Activities": { windowsMajors: [1], portableMajors: [2] },
  "UiPath.Excel.Activities": { windowsMajors: [2], portableMajors: [3] },
  "UiPath.Mail.Activities": { windowsMajors: [1], portableMajors: [2] },
  "UiPath.Database.Activities": { windowsMajors: [1], portableMajors: [2] },
  "UiPath.Persistence.Activities": { windowsMajors: [25], portableMajors: [25] },
  "UiPath.MLActivities": { windowsMajors: [25], portableMajors: [25] },
};

function checkVersionCompatibility(input: QualityGateInput, violations: QualityGateViolation[]): void {
  let projectJson: any;
  try {
    projectJson = JSON.parse(input.projectJsonContent);
  } catch {
    return;
  }

  const deps = projectJson.dependencies || {};
  const isPortable = input.targetFramework === "Portable";
  const _studioProfile = catalogService.getStudioProfile();

  for (const [pkgName, versionStr] of Object.entries(deps)) {
    if (typeof versionStr !== "string") continue;
    const versionNum = (versionStr as string).replace(/[\[\]]/g, "");
    const majorVersion = parseInt(versionNum.split(".")[0], 10);
    if (isNaN(majorVersion)) continue;

    if (_studioProfile) {
      const preferred = metadataService.getPreferredVersion(pkgName);
      if (preferred && !metadataService.isVersionPreferred(pkgName, versionNum)) {
        violations.push({
          category: "accuracy",
          severity: "error",
          check: "version-framework-mismatch",
          file: "project.json",
          detail: `Package "${pkgName}" version ${versionStr} differs from preferred version ${preferred} for Studio ${_studioProfile.studioLine} ${_studioProfile.targetFramework}`,
        });
      }
      continue;
    }

    const versionRange = PACKAGE_MAJOR_VERSION_RANGES[pkgName];
    if (!versionRange) continue;

    const expectedMajors = isPortable ? versionRange.portableMajors : versionRange.windowsMajors;
    if (!expectedMajors.includes(majorVersion)) {
      violations.push({
        category: "accuracy",
        severity: "error",
        check: "version-framework-mismatch",
        file: "project.json",
        detail: `Package "${pkgName}" version ${versionStr} (major ${majorVersion}) is not compatible with ${input.targetFramework} target — expected major version(s): ${expectedMajors.join(", ")}`,
      });
    }
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;
    const activityPattern = /<(ui:[A-Za-z]+)\s/g;
    let match;
    while ((match = activityPattern.exec(content)) !== null) {
      const activityName = match[1];
      const knownActivity = lookupActivity(activityName);
      if (!knownActivity) continue;

      const declaredVersion = deps[knownActivity.package];
      if (!declaredVersion || typeof declaredVersion !== "string") continue;

      const versionNum = (declaredVersion as string).replace(/[\[\]]/g, "");
      const majorVersion = parseInt(versionNum.split(".")[0], 10);
      if (isNaN(majorVersion)) continue;

      if (!knownActivity.versionedProperties || knownActivity.versionedProperties.length === 0) continue;

      const attrStr = content.substring(match.index, Math.min(content.length, match.index + 2000));
      const closingIdx = attrStr.indexOf(">");
      if (closingIdx === -1) continue;
      const tagStr = attrStr.substring(0, closingIdx + 1);

      const strippedTagStr = tagStr.replace(/"[^"]*"/g, '""');
      const attrPattern = /\b([A-Za-z][A-Za-z0-9_]*)\s*=/g;
      let attrMatch;
      while ((attrMatch = attrPattern.exec(strippedTagStr)) !== null) {
        const propName = attrMatch[1];
        if (propName === "DisplayName" || propName.startsWith("xmlns") ||
            propName.startsWith("sap") || propName === "x:Class" ||
            propName === "mc:Ignorable" || propName === "Selector" ||
            propName === "Target") continue;

        const versionedProp = knownActivity.versionedProperties.find(vp => vp.name === propName);
        if (!versionedProp) continue;

        if (versionedProp.addedInMajor !== undefined && majorVersion < versionedProp.addedInMajor) {
          const lineNum = content.substring(0, match.index).split("\n").length;
          violations.push({
            category: "accuracy",
            severity: "error",
            check: "version-property-unavailable",
            file: shortName,
            detail: `Line ${lineNum}: property "${propName}" on ${activityName} requires ${knownActivity.package} major version ${versionedProp.addedInMajor}+, but declared version is ${declaredVersion} (major ${majorVersion})`,
          });
        }

        if (versionedProp.removedInMajor !== undefined && majorVersion >= versionedProp.removedInMajor) {
          const lineNum = content.substring(0, match.index).split("\n").length;
          violations.push({
            category: "accuracy",
            severity: "error",
            check: "version-property-removed",
            file: shortName,
            detail: `Line ${lineNum}: property "${propName}" on ${activityName} was removed in ${knownActivity.package} major version ${versionedProp.removedInMajor}, but declared version is ${declaredVersion} (major ${majorVersion})`,
          });
        }
      }
    }
  }
}

function checkRuntimeSafety(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];

  const unguardedArrayPattern = /\.Rows\(\s*\d+\s*\)/;
  const unguardedJsonParseAccess = /JObject\.Parse\s*\([^)]*\)\s*\(\s*"[^"]*"\s*\)/;
  const selectTokenPattern = /\.SelectToken\s*\(/;
  const jTokenAccessPattern = /\.\s*\(\s*"[^"]*"\s*\)/;
  const itemAccessPattern = /\.Item\(\s*\d+\s*\)/;

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    const exprPattern = /\[([^\[\]]{3,})\]/g;
    let match;
    while ((match = exprPattern.exec(content)) !== null) {
      const expr = match[1];
      if (expr.startsWith("&quot;") || expr.startsWith("\"") || expr.startsWith("'")) continue;
      if (/^\d+$/.test(expr)) continue;

      const lineNum = content.substring(0, match.index).split("\n").length;

      if (unguardedArrayPattern.test(expr)) {
        const surroundingContext = content.substring(
          Math.max(0, match.index - 500), match.index
        );
        const hasRowCountCheck = /\.Rows\.Count\s*>\s*0/.test(surroundingContext) ||
          /If.*\.Rows\.Count/.test(surroundingContext) ||
          /\.Rows\.Count\s*>\s*0/.test(expr);
        if (!hasRowCountCheck) {
          violations.push({
            category: "runtime-safety",
            severity: "warning",
            check: "unguarded-array-index",
            file: shortName,
            detail: `Line ${lineNum}: array indexing ".Rows(N)" without a preceding row count check — may throw IndexOutOfRangeException at runtime`,
          });
        }
      }

      if (unguardedJsonParseAccess.test(expr)) {
        violations.push({
          category: "runtime-safety",
          severity: "warning",
          check: "unguarded-json-access",
          file: shortName,
          detail: `Line ${lineNum}: JObject.Parse(...)("key") without null/existence check — may throw NullReferenceException if key missing`,
        });
      }

      if (selectTokenPattern.test(expr)) {
        const hasNullCheck = /If\s*\(.*SelectToken/.test(expr) ||
          /IsNot Nothing/.test(expr) ||
          /!= null/.test(expr) ||
          /\?\s*\./.test(expr);
        if (!hasNullCheck) {
          const surroundingContext = content.substring(
            Math.max(0, match.index - 500), match.index
          );
          const hasExternalGuard = /If.*SelectToken/.test(surroundingContext) ||
            /IsNot Nothing/.test(surroundingContext);
          if (!hasExternalGuard) {
            violations.push({
              category: "runtime-safety",
              severity: "warning",
              check: "unguarded-selecttoken",
              file: shortName,
              detail: `Line ${lineNum}: .SelectToken() without null check — use If(token IsNot Nothing, ...) or ?.`,
            });
          }
        }
      }

      if (jTokenAccessPattern.test(expr)) {
        const hasGuard = /If\s*\(/.test(expr) ||
          /IsNot Nothing/.test(expr) ||
          /!= null/.test(expr);
        if (!hasGuard) {
          violations.push({
            category: "runtime-safety",
            severity: "warning",
            check: "unguarded-jtoken-access",
            file: shortName,
            detail: `Line ${lineNum}: JToken("key") access without null guard — may throw KeyNotFoundException`,
          });
        }
      }

      if (itemAccessPattern.test(expr)) {
        const surroundingContext = content.substring(
          Math.max(0, match.index - 500), match.index
        );
        const hasCountCheck = /\.Count\s*>/.test(surroundingContext) || /\.Count\s*>/.test(expr);
        if (!hasCountCheck) {
          violations.push({
            category: "runtime-safety",
            severity: "warning",
            check: "unguarded-item-access",
            file: shortName,
            detail: `Line ${lineNum}: .Item(N) access without count/bounds check — may throw IndexOutOfRangeException`,
          });
        }
      }

      const memberAccessPattern = /(\w+)\.(\w+)/g;
      let memberMatch;
      while ((memberMatch = memberAccessPattern.exec(expr)) !== null) {
        const varName = memberMatch[1];
        if (["String", "Integer", "Math", "Convert", "DateTime", "TimeSpan",
             "Environment", "System", "Console", "Array", "Type", "Int32",
             "Boolean", "Double", "Decimal", "CType", "CStr", "CInt", "CDbl",
             "JObject", "JToken", "JArray", "Newtonsoft"].includes(varName)) continue;

        const propName = memberMatch[2];
        if (["ToString", "GetType", "Equals", "GetHashCode", "Length", "Count",
             "Message", "StackTrace", "InnerException"].includes(propName)) continue;

        const surroundingContext = content.substring(
          Math.max(0, match.index - 800), match.index + match[0].length
        );
        const nullCheckPatterns = [
          new RegExp(`${varName}\\s+IsNot\\s+Nothing`),
          new RegExp(`${varName}\\s*!=\\s*null`),
          new RegExp(`If.*${varName}\\s+IsNot\\s+Nothing`),
          new RegExp(`Condition="\\[${varName}\\s+IsNot\\s+Nothing`),
          new RegExp(`Condition="\\[${varName}\\s*!=\\s*null`),
        ];
        const hasNullGuard = nullCheckPatterns.some(p => p.test(surroundingContext));
        if (!hasNullGuard) {
          const prefixes = ["out_", "qi_", "obj_", "jobj_"];
          if (prefixes.some(p => varName.startsWith(p))) {
            violations.push({
              category: "runtime-safety",
              severity: "warning",
              check: "potentially-null-dereference",
              file: shortName,
              detail: `Line ${lineNum}: "${varName}.${propName}" accessed without visible null guard in scope — verify null check exists in enclosing If/TryCatch`,
            });
          }
        }
      }
    }
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    const exprAttrPattern = /(Message|Default|Value)="([^"]*)"/g;
    let exprMatch;
    while ((exprMatch = exprAttrPattern.exec(content)) !== null) {
      const attr = exprMatch[1];
      const val = exprMatch[2];
      if (!val || val.length === 0) continue;

      const hasBracketOpen = val.includes("[");
      const hasBracketClose = val.includes("]");

      if (hasBracketOpen || hasBracketClose) {
        const openCount = (val.match(/\[/g) || []).length;
        const closeCount = (val.match(/\]/g) || []).length;
        if (openCount !== closeCount) {
          const lineNum = content.substring(0, exprMatch.index).split("\n").length;
          violations.push({
            category: "runtime-safety",
            severity: "error",
            check: "malformed-expression",
            file: shortName,
            detail: `Line ${lineNum}: ${attr} has unbalanced brackets (${openCount} open, ${closeCount} close) — expression will fail at runtime`,
          });
        }
      }

      const hasLiteralText = /^[^[&\d]/.test(val) && !val.startsWith("True") && !val.startsWith("False") && !val.startsWith("Nothing") && !val.startsWith("PLACEHOLDER");
      if (hasLiteralText && hasBracketOpen) {
        const lineNum = content.substring(0, exprMatch.index).split("\n").length;
        violations.push({
          category: "runtime-safety",
          severity: "error",
          check: "malformed-expression",
          file: shortName,
          detail: `Line ${lineNum}: ${attr} contains mixed literal/expression syntax — will produce a compile error in Studio`,
        });
      }

      const valWithoutApostrophes = val.replace(/[a-zA-Z]'[a-zA-Z]/g, "xxx");
      if (/'[^']*'/.test(valWithoutApostrophes) && !val.startsWith("[")) {
        const lineNum = content.substring(0, exprMatch.index).split("\n").length;
        violations.push({
          category: "runtime-safety",
          severity: "error",
          check: "malformed-expression",
          file: shortName,
          detail: `Line ${lineNum}: ${attr} contains single-quoted VB expression syntax that was not canonicalized — must use bracket-wrapped &quot; form`,
        });
      }
    }
  }

  return violations;
}

function checkLogicLocation(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];

  const retryCountPattern = /NumberOfRetries="(\d+)"/g;
  const retryIntervalPattern = /RetryInterval="([^"]+)"/g;
  const hardcodedQueuePattern = /QueueName="\[?&quot;([^&"]+)&quot;\]?"/g;
  const hardcodedQueuePattern2 = /QueueName="([^"[\]]+)"/g;
  const hardcodedAssetPattern = /AssetName="([^"[\]]+)"/g;

  const configRefPattern = /in_Config\s*\(\s*"[^"]+"\s*\)/;

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;

    let match;
    while ((match = retryCountPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split("\n").length;
      const val = match[1];
      violations.push({
        category: "logic-location",
        severity: "warning",
        check: "hardcoded-retry-count",
        file: shortName,
        detail: `Line ${lineNum}: retry count hardcoded as ${val} — consider externalizing to Config.xlsx (e.g., in_Config("MaxRetryNumber"))`,
      });
    }

    while ((match = retryIntervalPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split("\n").length;
      const val = match[1];
      if (val !== "00:00:00") {
        violations.push({
          category: "logic-location",
          severity: "warning",
          check: "hardcoded-retry-interval",
          file: shortName,
          detail: `Line ${lineNum}: retry interval hardcoded as "${val}" — consider externalizing to Config.xlsx`,
        });
      }
    }

    while ((match = hardcodedQueuePattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split("\n").length;
      const val = match[1];
      const surroundingContext = content.substring(
        Math.max(0, match.index - 200), Math.min(content.length, match.index + 200)
      );
      if (configRefPattern.test(surroundingContext)) continue;
      if (val === "in_QueueName" || val.startsWith("[")) continue;
      violations.push({
        category: "logic-location",
        severity: "warning",
        check: "hardcoded-queue-name",
        file: shortName,
        detail: `Line ${lineNum}: queue name "${val}" is hardcoded — consider using a Config.xlsx entry or workflow argument`,
      });
    }

    while ((match = hardcodedQueuePattern2.exec(content)) !== null) {
      const val = match[1];
      if (val.startsWith("[") || val === "in_QueueName" || val.includes("in_Config")) continue;
      if (val === "TransactionQueue") {
        const lineNum = content.substring(0, match.index).split("\n").length;
        violations.push({
          category: "logic-location",
          severity: "warning",
          check: "hardcoded-queue-name",
          file: shortName,
          detail: `Line ${lineNum}: queue name "${val}" is hardcoded — consider using a Config.xlsx entry or workflow argument`,
        });
      }
    }

    while ((match = hardcodedAssetPattern.exec(content)) !== null) {
      const val = match[1];
      if (val.startsWith("[") || val.startsWith("TODO") || val.startsWith("PLACEHOLDER")) continue;
      if (val.includes("in_Config") || val.includes("in_")) continue;
      if (/^InitAllSettings\.xaml$/i.test(shortName)) continue;
      const lineNum = content.substring(0, match.index).split("\n").length;
      violations.push({
        category: "logic-location",
        severity: "warning",
        check: "hardcoded-asset-name",
        file: shortName,
        detail: `Line ${lineNum}: asset name "${val}" is hardcoded — consider using a Config.xlsx entry or workflow argument`,
      });
    }

    const timeIntervalPattern = /(?:Delay|Timeout|Duration)="(?:00:)?(\d{2}:\d{2}(?::\d{2})?)"/g;
    while ((match = timeIntervalPattern.exec(content)) !== null) {
      const contextBefore = content.substring(Math.max(0, match.index - 60), match.index);
      if (contextBefore.includes("RetryInterval")) continue;
      const lineNum = content.substring(0, match.index).split("\n").length;
      const val = match[1];
      if (val !== "00:00" && val !== "00:00:00") {
        violations.push({
          category: "logic-location",
          severity: "warning",
          check: "hardcoded-time-interval",
          file: shortName,
          detail: `Line ${lineNum}: time interval "${match[0].split("=")[0]}=${val}" is hardcoded — consider externalizing to Config.xlsx`,
        });
      }
    }
  }

  return violations;
}

function collectPositiveEvidence(input: QualityGateInput): PositiveEvidence[] {
  const evidence: PositiveEvidence[] = [];

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const lineCount = entry.content.split("\n").length;
    const hasActivityRoot = entry.content.includes("<Activity");
    evidence.push({
      check: "xaml-valid",
      file: shortName,
      detail: `${shortName} found with ${lineCount} lines${hasActivityRoot ? ", valid <Activity> root element present" : ""}`,
    });
  }

  const fileBasenames = new Set(input.xamlEntries.map(e => {
    const parts = e.name.split("/");
    return parts[parts.length - 1];
  }));

  if (fileBasenames.has("Main.xaml")) {
    evidence.push({
      check: "main-xaml-present",
      file: "Main.xaml",
      detail: "Main.xaml entry point found in package",
    });
  }

  let projectJson: any = null;
  try {
    projectJson = JSON.parse(input.projectJsonContent);
    evidence.push({
      check: "project-json-valid",
      file: "project.json",
      detail: `project.json parsed successfully with ${Object.keys(projectJson.dependencies || {}).length} dependencies declared`,
    });

    if (projectJson.targetFramework) {
      evidence.push({
        check: "target-framework-set",
        file: "project.json",
        detail: `targetFramework is "${projectJson.targetFramework}"`,
      });
    }

    if (projectJson.expressionLanguage) {
      evidence.push({
        check: "expression-language-set",
        file: "project.json",
        detail: `expressionLanguage is "${projectJson.expressionLanguage}"`,
      });
    }

    if (projectJson.entryPoints?.length > 0) {
      evidence.push({
        check: "entry-point-defined",
        file: "project.json",
        detail: `${projectJson.entryPoints.length} entry point(s) defined: ${projectJson.entryPoints.map((ep: any) => ep.filePath).join(", ")}`,
      });
    }
  } catch {}

  let invokeCount = 0;
  let resolvedCount = 0;
  for (const entry of input.xamlEntries) {
    const invokePattern = /WorkflowFileName="([^"]+)"/g;
    let match;
    while ((match = invokePattern.exec(entry.content)) !== null) {
      invokeCount++;
      const invokedFile = match[1];
      const basename = invokedFile.split("/").pop() || invokedFile;
      if (fileBasenames.has(basename)) {
        resolvedCount++;
      }
    }
  }
  if (invokeCount > 0) {
    evidence.push({
      check: "invoke-targets-resolved",
      file: "package",
      detail: `${resolvedCount}/${invokeCount} InvokeWorkflowFile targets resolve to existing files in the package`,
    });
  }

  const declaredDeps = projectJson?.dependencies ? Object.keys(projectJson.dependencies) : [];
  const usedPackages = new Set<string>();
  for (const entry of input.xamlEntries) {
    const activityPattern = /<(ui:[A-Za-z]+)\s/g;
    let match;
    while ((match = activityPattern.exec(entry.content)) !== null) {
      const knownActivity = lookupActivity(match[1]);
      if (knownActivity) {
        usedPackages.add(knownActivity.package);
      }
    }
  }
  const allUsedDeclared = [...usedPackages].every(p => declaredDeps.includes(p));
  if (usedPackages.size > 0) {
    evidence.push({
      check: "activity-packages-declared",
      file: "project.json",
      detail: `${usedPackages.size} activity packages used, ${allUsedDeclared ? "all" : "not all"} declared in project.json dependencies`,
    });
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;
    const xmlnsPattern = /xmlns:([a-zA-Z0-9]+)="([^"]+)"/g;
    const declaredNs = new Set<string>();
    let match;
    while ((match = xmlnsPattern.exec(content)) !== null) {
      declaredNs.add(match[1]);
    }
    if (declaredNs.size > 0) {
      evidence.push({
        check: "namespaces-declared",
        file: shortName,
        detail: `${declaredNs.size} XML namespace(s) declared: ${[...declaredNs].join(", ")}`,
      });
    }
  }

  if (input.archiveManifest && input.archiveManifest.length > 0) {
    const xamlInArchive = input.archiveManifest.filter(p => p.endsWith(".xaml")).length;
    const validatedBasenames = new Set(input.xamlEntries.map(e => (e.name.split("/").pop() || e.name)));
    const archiveXamlBasenames = input.archiveManifest
      .filter(p => p.endsWith(".xaml"))
      .map(p => p.split("/").pop() || p);
    const allValidated = archiveXamlBasenames.every(b => validatedBasenames.has(b));
    const allInArchive = Array.from(validatedBasenames).every(b => 
      input.archiveManifest!.some(p => (p.split("/").pop() || p) === b)
    );
    const parityStatus = allValidated && allInArchive ? "parity confirmed" : "parity check performed (see violations)";
    evidence.push({
      check: "archive-parity-checked",
      file: "package",
      detail: `Archive manifest checked: ${input.archiveManifest.length} total files, ${xamlInArchive} XAML files, ${input.xamlEntries.length} validated entries — ${parityStatus}`,
    });

    const archiveBasenameLookup = new Set(input.archiveManifest.map(p => p.split("/").pop() || p));
    const requiredArtifacts = ["project.json", "Config.xlsx", "DeveloperHandoffGuide.md"];
    for (const artifact of requiredArtifacts) {
      if (archiveBasenameLookup.has(artifact)) {
        const archivePath = input.archiveManifest.find(p => (p.split("/").pop() || p) === artifact);
        evidence.push({
          check: "artifact-present",
          file: artifact,
          detail: `${artifact} found in archive at "${archivePath}"`,
        });
      }
    }

    const nuspecPath = input.archiveManifest.find(p => p.endsWith(".nuspec"));
    if (nuspecPath) {
      evidence.push({
        check: "nuspec-present",
        file: nuspecPath,
        detail: `NuSpec package metadata found at "${nuspecPath}"`,
      });
    }

    if (input.archiveContentHashes && Object.keys(input.archiveContentHashes).length > 0) {
      let matchCount = 0;
      let missingCount = 0;
      const totalValidated = input.xamlEntries.length;
      for (const entry of input.xamlEntries) {
        const basename = entry.name.split("/").pop() || entry.name;
        const archivePath = input.archiveManifest.find(p => (p.split("/").pop() || p) === basename);
        if (!archivePath) { missingCount++; continue; }
        const archiveHash = input.archiveContentHashes[archivePath];
        const validatedHash = input.archiveContentHashes[`__validated__${archivePath}`]
          || input.archiveContentHashes[`__validated__${basename}`];
        if (archiveHash && validatedHash && archiveHash === validatedHash) {
          matchCount++;
        } else {
          missingCount++;
        }
      }
      evidence.push({
        check: "content-hash-verified",
        file: "package",
        detail: `${matchCount}/${totalValidated} validated file(s) have matching archive content hashes (byte-for-byte parity${matchCount === totalValidated ? " fully confirmed" : `, ${missingCount} unverified`})`,
      });
    }

  }

  return evidence;
}

function computeCompletenessLevel(violations: QualityGateViolation[]): CompletenessLevel {
  const hasEmptyEndpoint = violations.some(v => v.check === "empty-http-endpoint");
  const hasUnassignedDecision = violations.some(v => v.check === "unassigned-decision-variable");
  const hasPlaceholder = violations.some(v => v.check === "placeholder-value");
  const hasEmptyContainer = violations.some(v => v.check === "empty-container" && v.severity === "error");
  const hasBlockedPattern = violations.some(v => v.category === "blocked-pattern" && v.severity === "error");

  if (hasEmptyEndpoint || hasUnassignedDecision || hasEmptyContainer) {
    return "incomplete";
  }

  const hasExpressionError = violations.some(v =>
    (v.check === "EXPRESSION_SYNTAX" || v.check === "EXPRESSION_SYNTAX_UNFIXABLE" || v.check === "expression-syntax-mismatch") && v.severity === "error"
  );
  const hasTypeError = violations.some(v =>
    (v.check === "TYPE_MISMATCH" || v.check === "FOREACH_TYPE_MISMATCH" || v.check === "invoke-arg-type-mismatch" || v.check === "invalid-type-argument") && v.severity === "error"
  );

  if (hasPlaceholder || hasExpressionError || hasTypeError || hasBlockedPattern) {
    return "structural";
  }
  return "functional";
}

function computeReadiness(violations: QualityGateViolation[]): PackageReadiness {
  const hasBlockingErrors = violations.some(v => v.severity === "error" && BLOCKING_CHECKS.has(v.check));
  if (hasBlockingErrors) return "NEEDS_ATTENTION";
  const hasAnyIssues = violations.some(v => v.severity === "error" || v.severity === "warning");
  if (hasAnyIssues) return "READY_WITH_WARNINGS";
  return "SUCCESS";
}

function checkTransitiveDependencies(input: QualityGateInput): QualityGateViolation[] {
  const violations: QualityGateViolation[] = [];

  let declaredPackages: Set<string>;
  try {
    const projectJson = JSON.parse(input.projectJsonContent);
    declaredPackages = new Set(Object.keys(projectJson.dependencies || {}));
  } catch {
    return violations;
  }

  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const requiredPackages = scanXamlForRequiredPackages(entry.content);

    for (const pkg of requiredPackages) {
      if (pkg === "UiPath.System.Activities") continue;
      const exactMatch = declaredPackages.has(pkg);
      if (!exactMatch) {
        const fuzzyMatch = Array.from(declaredPackages).some(d =>
          d.toLowerCase() === pkg.toLowerCase()
        );
        if (!fuzzyMatch) {
          violations.push({
            category: "accuracy",
            severity: "warning",
            check: "transitive-dependency-missing",
            file: shortName,
            detail: `Activity requires package "${pkg}" but it is not declared in project.json dependencies`,
          });
        }
      }
    }

    const errorActivityPattern = /<([\w:]*ErrorActivity[\w]*)\s/g;
    let errorMatch;
    while ((errorMatch = errorActivityPattern.exec(entry.content)) !== null) {
      violations.push({
        category: "accuracy",
        severity: "error",
        check: "error-activity-reference",
        file: shortName,
        detail: `ErrorActivity-class reference "${errorMatch[1]}" detected — indicates a failed activity resolution at design time`,
      });
    }

    const unknownTypePattern = /TypeArgument="([^"]+)"/g;
    let typeMatch;
    while ((typeMatch = unknownTypePattern.exec(entry.content)) !== null) {
      const typeArg = typeMatch[1];
      if (typeArg.includes("ErrorActivity") || typeArg.includes("UnknownType")) {
        violations.push({
          category: "accuracy",
          severity: "warning",
          check: "unresolved-type-argument",
          file: shortName,
          detail: `Unresolved type argument "${typeArg}" — likely indicates missing transitive dependency`,
        });
      }
    }
  }

  return violations;
}

export function validatePackage(input: QualityGateInput): QualityGateResult {
  const blockedViolations = scanBlockedPatterns(input);
  const criticalWorkflowViolations = scanCriticalWorkflowIntegrity(input);
  const completenessViolations = checkCompleteness(input);
  const accuracyViolations = checkAccuracy(input);
  const runtimeSafetyViolations = checkRuntimeSafety(input);
  const logicLocationViolations = checkLogicLocation(input);
  const archiveParityViolations = checkArchiveParity(input);
  const expressionLintResult = lintXamlExpressions(input.xamlEntries);
  const positiveEvidence = collectPositiveEvidence(input);

  if (expressionLintResult.correctedEntries.length > 0) {
    for (let i = 0; i < input.xamlEntries.length; i++) {
      const corrected = expressionLintResult.correctedEntries.find(
        ce => ce.name === input.xamlEntries[i].name
      );
      if (corrected) {
        input.xamlEntries[i] = corrected;
      }
    }
  }

  const typeCompatResult = validateTypeCompatibility(input.xamlEntries);

  if (typeCompatResult.correctedEntries.length > 0) {
    for (let i = 0; i < input.xamlEntries.length; i++) {
      const corrected = typeCompatResult.correctedEntries.find(
        ce => ce.name === input.xamlEntries[i].name
      );
      if (corrected) {
        input.xamlEntries[i] = corrected;
      }
    }
  }

  const selectorScores = scoreSelectorQuality(input.xamlEntries);
  const selectorWarnings = generateSelectorWarnings(selectorScores);

  const doubleEncodingViolations: QualityGateViolation[] = [];
  const doubleEncodePatterns = [
    { pattern: /&amp;quot;/g, label: "&amp;quot;" },
    { pattern: /&amp;amp;/g, label: "&amp;amp;" },
    { pattern: /&amp;lt;/g, label: "&amp;lt;" },
    { pattern: /&amp;gt;/g, label: "&amp;gt;" },
  ];
  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const lines = entry.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const bracketExprMatch = /="\[([^\]]*)\]"/g;
      let bm;
      while ((bm = bracketExprMatch.exec(line)) !== null) {
        const exprContent = bm[1];
        for (const dp of doubleEncodePatterns) {
          if (dp.pattern.test(exprContent)) {
            dp.pattern.lastIndex = 0;
            doubleEncodingViolations.push({
              category: "accuracy",
              severity: "error",
              check: "DOUBLE_ENCODED_EXPRESSION",
              file: shortName,
              detail: `Line ${i + 1}: Double-encoded ${dp.label} found in expression: ${exprContent.substring(0, 80)}`,
            });
          }
        }
      }
    }
  }

  const BUILTIN_XAML_ACTIVITIES = new Set([
    "Activity", "Sequence", "If", "Assign", "Flowchart", "FlowDecision", "FlowStep",
    "FlowSwitch", "While", "DoWhile", "ForEach", "ParallelForEach", "Switch",
    "TryCatch", "Catch", "Throw", "Rethrow", "Delay", "WriteLine", "Persist",
    "TerminateWorkflow", "NoPersistScope", "InvokeMethod", "AddToCollection",
    "RemoveFromCollection", "ClearCollection", "ExistsInCollection",
    "TransactionScope", "CompensableActivity", "Compensate", "Confirm",
    "Variable", "Literal", "StateMachine", "State", "FinalState", "Transition",
    "InArgument", "OutArgument", "InOutArgument", "ActivityAction",
    "DelegateInArgument", "DelegateOutArgument",
    "AssemblyReference", "Collection", "String",
  ]);
  const unprefixedActivityViolations: QualityGateViolation[] = [];
  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const lines = entry.content.split("\n");
    const unprefixedTagRegex = /^(\s*)<([A-Z][A-Za-z]+)([\s>\/])/;
    let insideMetadataBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.includes("<TextExpression.ReferencesForImplementation") ||
          trimmed.includes("<TextExpression.NamespacesForImplementation")) {
        insideMetadataBlock = true;
      }
      if (trimmed.includes("</TextExpression.ReferencesForImplementation") ||
          trimmed.includes("</TextExpression.NamespacesForImplementation")) {
        insideMetadataBlock = false;
        continue;
      }
      if (insideMetadataBlock) continue;
      const match = unprefixedTagRegex.exec(lines[i]);
      if (!match) continue;
      const tagName = match[2];
      if (BUILTIN_XAML_ACTIVITIES.has(tagName)) continue;
      if (tagName.includes(".")) continue;
      if (/^(True|False|Null)$/.test(tagName)) continue;
      unprefixedActivityViolations.push({
        category: "accuracy",
        severity: "error",
        check: "UNPREFIXED_ACTIVITY_TAG",
        file: shortName,
        detail: `Line ${i + 1}: Activity tag <${tagName}> is missing a namespace prefix (e.g., ui:${tagName}) and will fail namespace resolution in Studio`,
      });
    }
  }

  const expressionInLiteralViolations: QualityGateViolation[] = [];
  for (const entry of input.xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const lines = entry.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const defaultMatch = /Default="([^"]+)"/g;
      let dm;
      while ((dm = defaultMatch.exec(line)) !== null) {
        const val = dm[1];
        if (val === "True" || val === "False" || val === "Nothing" || val === "null") continue;
        if (/^[0-9]+(\.[0-9]+)?$/.test(val)) continue;
        if (val.startsWith("[") && val.endsWith("]")) continue;
        if (val.startsWith("&quot;") && val.endsWith("&quot;")) continue;
        if (val.startsWith('"') && val.endsWith('"')) continue;
        if (/^\d{1,2}:\d{2}:\d{2}/.test(val)) continue;
        if (/^[a-zA-Z][\w\s.,!?;:'-]*$/.test(val) && !/[()]/.test(val) && !/^(in_|out_|io_)/.test(val)) continue;

        const looksLikeExpression = /^(in_|out_|io_|str_|int_|bool_|dict_|dt_|sec_)\w+$/.test(val) ||
          /\w+\.\w+\(/.test(val) ||
          /\bNew\s/.test(val) ||
          /\bDirectCast\b/.test(val) ||
          /\bCType\b/.test(val) ||
          /\bCStr\b/.test(val) ||
          /\bCInt\b/.test(val) ||
          /\bNothing\b/.test(val) ||
          (/\(.*\)/.test(val) && /^[a-zA-Z_]\w*/.test(val));
        if (looksLikeExpression) {
          expressionInLiteralViolations.push({
            category: "accuracy",
            severity: "error",
            check: "EXPRESSION_IN_LITERAL_SLOT",
            file: shortName,
            detail: `Line ${i + 1}: Variable Default="${val}" contains a VB expression that is not bracket-wrapped — Studio will treat it as a literal string, not an expression`,
          });
        }
      }
      const retryMatch = /RetryInterval="([^"]+)"/g;
      let rm;
      while ((rm = retryMatch.exec(line)) !== null) {
        const val = rm[1];
        if (/^\d{1,2}:\d{2}:\d{2}(\.\d+)?$/.test(val)) continue;
        if (val.startsWith("[") && val.endsWith("]")) continue;
        if (/[a-zA-Z_]/.test(val) && !/^\d/.test(val)) {
          expressionInLiteralViolations.push({
            category: "accuracy",
            severity: "error",
            check: "EXPRESSION_IN_LITERAL_SLOT",
            file: shortName,
            detail: `Line ${i + 1}: RetryInterval="${val}" contains a VB expression or variable that is not bracket-wrapped — must be hh:mm:ss literal or [expression]`,
          });
        }
      }
    }
    const xPropNames = new Set<string>();
    const xPropPattern = /<x:Property\s+Name="([^"]+)"/g;
    let xpm;
    while ((xpm = xPropPattern.exec(entry.content)) !== null) {
      xPropNames.add(xpm[1]);
    }
    const argScanContent = entry.content.replace(/<ui:InvokeWorkflowFile\.Arguments>[\s\S]*?<\/ui:InvokeWorkflowFile\.Arguments>/g, "");
    const argRefPattern = /\b(in_[A-Za-z]\w*|out_[A-Za-z]\w*|io_[A-Za-z]\w*)\b/g;
    const allArgRefs = new Set<string>();
    let argRefM;
    while ((argRefM = argRefPattern.exec(argScanContent)) !== null) {
      allArgRefs.add(argRefM[1]);
    }
    for (const argRef of allArgRefs) {
      if (!xPropNames.has(argRef)) {
        const varDeclared = new RegExp(`Name="${argRef}"`).test(entry.content);
        if (!varDeclared) {
          expressionInLiteralViolations.push({
            category: "accuracy",
            severity: "error",
            check: "UNDECLARED_ARGUMENT",
            file: shortName,
            detail: `Argument "${argRef}" is referenced in expressions but not declared in <x:Members> or as a <Variable>`,
          });
        }
      }
    }
  }

  const transitiveDependencyViolations = checkTransitiveDependencies(input);

  const allViolations = [
    ...blockedViolations,
    ...criticalWorkflowViolations,
    ...completenessViolations,
    ...accuracyViolations,
    ...runtimeSafetyViolations,
    ...logicLocationViolations,
    ...archiveParityViolations,
    ...expressionLintResult.violations,
    ...typeCompatResult.violations,
    ...selectorWarnings,
    ...doubleEncodingViolations,
    ...unprefixedActivityViolations,
    ...transitiveDependencyViolations,
    ...expressionInLiteralViolations,
  ];

  const hasErrors = allViolations.some(v => v.severity === "error");
  const summary = buildSummary(allViolations);
  const completenessLevel = computeCompletenessLevel(allViolations);
  const readiness = computeReadiness(allViolations);

  return {
    passed: !hasErrors,
    violations: allViolations,
    positiveEvidence,
    completenessLevel,
    typeRepairs: typeCompatResult.repairs,
    readiness,
    summary,
  };
}

export function runQualityGate(input: QualityGateInput): QualityGateResult {
  const resilienceCorrected = injectResilienceDefaults(input.xamlEntries);
  if (resilienceCorrected.length > 0) {
    for (let i = 0; i < input.xamlEntries.length; i++) {
      const corrected = resilienceCorrected.find(
        ce => ce.name === input.xamlEntries[i].name
      );
      if (corrected) {
        input.xamlEntries[i] = corrected;
      }
    }
  }

  return validatePackage(input);
}

function buildSummary(violations: QualityGateViolation[]): QualityGateResult["summary"] {
  const blockedPatterns = violations.filter(v => v.category === "blocked-pattern" && v.severity === "error").length;
  const completenessErrors = violations.filter(v => v.category === "completeness" && v.severity === "error").length;
  const completenessWarnings = violations.filter(v => v.category === "completeness" && v.severity === "warning").length;
  const accuracyErrors = violations.filter(v => v.category === "accuracy" && v.severity === "error").length;
  const accuracyWarnings = violations.filter(v => v.category === "accuracy" && v.severity === "warning").length;
  const runtimeSafetyErrors = violations.filter(v => v.category === "runtime-safety" && v.severity === "error").length;
  const runtimeSafetyWarnings = violations.filter(v => v.category === "runtime-safety" && v.severity === "warning").length;
  const logicLocationWarnings = violations.filter(v => v.category === "logic-location" && v.severity === "warning").length;
  return {
    blockedPatterns,
    completenessErrors,
    completenessWarnings,
    accuracyErrors,
    accuracyWarnings,
    runtimeSafetyErrors,
    runtimeSafetyWarnings,
    logicLocationWarnings,
    totalErrors: blockedPatterns + completenessErrors + accuracyErrors + runtimeSafetyErrors,
    totalWarnings: completenessWarnings + accuracyWarnings + runtimeSafetyWarnings + logicLocationWarnings,
  };
}

export type QualityIssueSeverity = "blocking" | "warning";

export interface ClassifiedIssue {
  severity: QualityIssueSeverity;
  file: string;
  check: string;
  detail: string;
  originalViolation: QualityGateViolation;
}

const BLOCKING_CHECKS = new Set([
  "xml-wellformedness",
  "object-object",
  "pseudo-xaml",
  "fake-trycatch",
  "project-json-parse",
  "main-xaml",
  "archive-manifest-parity",
  "archive-content-parity",
  "ENUM_VIOLATION",
  "CATALOG_STRUCTURAL_VIOLATION",
  "EXPRESSION_SYNTAX_UNFIXABLE",
  "unprefixed-activity",
  "error-activity-reference",
  "OBJECT_TO_IENUMERABLE",
  "UNDECLARED_VARIABLE",
  "TYPE_MISMATCH",
  "FOREACH_TYPE_MISMATCH",
  "LITERAL_TYPE_ERROR",
  "critical-workflow-generation-failure",
  "critical-workflow-placeholder-blocker",
]);

const WARNING_CHECKS = new Set([
  "hardcoded-credential",
  "placeholder-value",
  "config-key-missing",
  "undeclared-asset",
  "invalid-activity-property",
  "invalid-continue-on-error",
  "invalid-trycatch-structure",
  "empty-catches",
  "invalid-catch-type",
  "invalid-default-value",
  "missing-required-property",
  "legacy-selector-format",
  "missing-retry-scope",
  "logic-location",
  "CATALOG_VIOLATION",
  "missing-package-dep",
  "unknown-activity",
  "undeclared-variable",
  "net45-in-portable",
  "legacy-modern-behavior",
  "modern-project",
  "target-framework",
  "invoked-file",
  "invoke-path-mismatch",
  "dependencies",
  "dependency-version",
  "invoke-arg-type-mismatch",
  "duplicate-file",
  "empty-http-endpoint",
  "unassigned-decision-variable",
  "EXPRESSION_SYNTAX",
  "SELECTOR_PLACEHOLDER",
  "SELECTOR_LOW_QUALITY",
  "transitive-dependency-missing",
  "unresolved-type-argument",
]);

export function classifyQualityIssues(result: QualityGateResult): ClassifiedIssue[] {
  const issues: ClassifiedIssue[] = [];
  for (const v of result.violations) {
    const isBlocking = v.severity === "error" && BLOCKING_CHECKS.has(v.check);
    issues.push({
      severity: isBlocking ? "blocking" : "warning",
      file: v.file,
      check: v.check,
      detail: v.detail,
      originalViolation: v,
    });
  }
  return issues;
}

export function getBlockingFiles(issues: ClassifiedIssue[]): Set<string> {
  const files = new Set<string>();
  for (const issue of issues) {
    if (issue.severity === "blocking" && issue.file !== "project.json" && issue.file !== "package" && issue.file !== "orchestrator") {
      files.add(issue.file);
    }
  }
  return files;
}

export function hasOnlyWarnings(issues: ClassifiedIssue[]): boolean {
  return issues.every(i => i.severity === "warning");
}

export function hasBlockingIssues(issues: ClassifiedIssue[]): boolean {
  return issues.some(i => i.severity === "blocking");
}

export function formatQualityGateViolations(result: QualityGateResult): string {
  const lines: string[] = [];

  if (result.passed && result.violations.length === 0) {
    lines.push("Quality gate passed — no violations found.");
  } else if (!result.passed) {
    lines.push(`Quality gate FAILED — ${result.summary.totalErrors} error(s), ${result.summary.totalWarnings} warning(s)`);
  } else {
    lines.push(`Quality gate passed with ${result.summary.totalWarnings} warning(s)`);
  }

  const levelLabels: Record<CompletenessLevel, string> = {
    functional: "Functional (all endpoints filled, all decision variables assigned, no dead logic gates)",
    structural: "Structural (opens in Studio, may have placeholders)",
    incomplete: "Incomplete (has empty required values or unassigned decision variables)",
  };
  lines.push(`Completeness level: ${levelLabels[result.completenessLevel]}`);

  if (result.violations.length > 0) {
    const grouped: Record<string, QualityGateViolation[]> = {};
    for (const v of result.violations) {
      const key = `${v.category}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(v);
    }

    const categoryLabels: Record<string, string> = {
      "blocked-pattern": "Blocked Patterns",
      "completeness": "Completeness",
      "accuracy": "Technical Accuracy",
      "runtime-safety": "Runtime Safety",
      "logic-location": "Logic Location",
    };

    for (const [cat, items] of Object.entries(grouped)) {
      lines.push(`\n[${categoryLabels[cat] || cat}]`);
      for (const v of items) {
        const severity = v.severity === "error" ? "ERROR" : "WARN";
        lines.push(`  ${severity} [${v.check}] ${v.file}: ${v.detail}`);
      }
    }
  }

  if (result.positiveEvidence && result.positiveEvidence.length > 0) {
    lines.push(`\n[Positive Evidence (${result.positiveEvidence.length} items)]`);
    for (const e of result.positiveEvidence) {
      lines.push(`  PASS [${e.check}] ${e.file}: ${e.detail}`);
    }
  }

  return lines.join("\n");
}
