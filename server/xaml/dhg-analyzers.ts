export interface CredentialAssetEntry {
  file: string;
  activityType: "GetCredential" | "GetAsset" | "SetCredential" | "SetAsset";
  assetName: string;
  isHardcoded: boolean;
  variableName?: string;
  lineNumber: number;
  assetValueType: "Text" | "Integer" | "Boolean" | "Credential" | "Unknown";
  consumingActivity?: string;
}

export interface CredentialAssetInventory {
  entries: CredentialAssetEntry[];
  hardcodedCount: number;
  variableCount: number;
  uniqueAssetNames: string[];
  uniqueCredentialNames: string[];
}

export interface ExceptionCoverageEntry {
  file: string;
  activityName: string;
  lineNumber: number;
  insideTryCatch: boolean;
  catchTypes: string[];
}

export interface ExceptionCoverageResult {
  entries: ExceptionCoverageEntry[];
  totalActivities: number;
  coveredActivities: number;
  coveragePercent: number;
  uncoveredHighRiskActivities: string[];
  filesWithoutTryCatch: string[];
}

export interface QueueUsageEntry {
  file: string;
  activityType: string;
  queueName: string;
  isHardcoded: boolean;
  lineNumber: number;
}

export interface QueueManagementResult {
  entries: QueueUsageEntry[];
  uniqueQueues: string[];
  hasAddQueueItem: boolean;
  hasGetTransaction: boolean;
  hasSetTransactionStatus: boolean;
  isTransactionalPattern: boolean;
  retryPolicy: {
    maxRetries: number;
    autoRetryEnabled: boolean;
    note: string;
  };
  slaGuidance: string;
  deadLetterHandling: string;
}

export interface EnvironmentRequirements {
  needsWindowsTarget: boolean;
  needsAttendedRobot: boolean;
  usesModernActivities: boolean;
  browserExtensions: string[];
  requiredPackages: string[];
  usesOrchestrator: boolean;
  usesActionCenter: boolean;
  usesAICenter: boolean;
  usesDocumentUnderstanding: boolean;
  usesDataService: boolean;
  machineTemplate: {
    recommendedType: "Standard" | "Server" | "Serverless";
    note: string;
  };
  orchestratorFolderGuidance: string;
  studioVersion: string;
}

export interface TriggerSuggestion {
  triggerType: "Schedule" | "Queue" | "API/Webhook" | "Attended" | "EventBased";
  reason: string;
  suggestedConfig?: string;
}

const ASSET_ACTIVITY_PATTERN = /<ui:(GetCredential|GetAsset|SetCredential|SetAsset)\b[^>]*>/g;
const ASSET_NAME_ATTR = /\bAssetName\s*=\s*"([^"]*)"/;
const CREDENTIAL_NAME_ATTR = /\bCredentialName\s*=\s*"([^"]*)"/;
const RESULT_ATTR = /\bResult\s*=\s*"\[([^\]]+)\]"/;
const ASSET_TYPE_ATTR = /\bAssetType\s*=\s*"([^"]*)"/;
const DISPLAY_NAME_ATTR = /DisplayName="([^"]*)"/;

const HIGH_RISK_ACTIVITIES = new Set([
  "ui:HttpClient", "uweb:HttpClient",
  "ui:ExecuteQuery", "udb:ExecuteQuery",
  "ui:SendSmtpMailMessage", "umail:SendSmtpMailMessage",
  "ui:InvokeCode",
  "ui:StartProcess",
  "ui:TypeInto", "ui:Click",
  "ui:GetCredential", "ui:GetAsset",
  "ui:AddQueueItem", "ui:GetTransactionItem", "ui:SetTransactionStatus",
  "ui:ExcelApplicationScope", "ui:UseExcel",
  "ui:ReadRange", "ui:WriteRange",
  "ui:ReadTextFile", "ui:WriteTextFile",
  "ui:ReadCsvFile", "ui:WriteCsvFile",
]);

const BROWSER_EXTENSION_INDICATORS: Array<{ pattern: RegExp; extension: string }> = [
  { pattern: /UseBrowser|OpenBrowser|NavigateTo/i, extension: "Chrome/Edge UiPath Extension" },
  { pattern: /UseApplicationCard.*chrome/i, extension: "Chrome UiPath Extension" },
  { pattern: /UseApplicationCard.*edge/i, extension: "Edge UiPath Extension" },
  { pattern: /UseApplicationCard.*firefox/i, extension: "Firefox UiPath Extension" },
  { pattern: /JavaScope|JavaElement/i, extension: "Java Bridge Extension" },
  { pattern: /CitrixScope|CitrixRecorder/i, extension: "Citrix Extension" },
];

const MODERN_ACTIVITY_INDICATORS = [
  "UseApplication", "UseBrowser", "UseExcel",
  "Target.Selector", "Target.Timeout",
  "ObjectContainer",
];

export function scanCredentialAssets(
  xamlEntries: { name: string; content: string }[],
): CredentialAssetInventory {
  const entries: CredentialAssetEntry[] = [];

  for (const entry of xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const lines = entry.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const activityMatch = line.match(/<ui:(GetCredential|GetAsset|SetCredential|SetAsset)\b/);
      if (!activityMatch) continue;

      const activityType = activityMatch[1] as CredentialAssetEntry["activityType"];
      const isCredential = activityType === "GetCredential" || activityType === "SetCredential";
      const nameAttr = isCredential ? CREDENTIAL_NAME_ATTR : ASSET_NAME_ATTR;

      const contextBlock = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
      const nameMatch = contextBlock.match(nameAttr) || contextBlock.match(ASSET_NAME_ATTR);
      let assetName = nameMatch ? nameMatch[1] : "UNKNOWN";
      assetName = assetName.replace(/&quot;/g, "").replace(/^"|"$/g, "");

      const isInitAllSettingsAssetContract = shortName.toLowerCase() === "initallsettings.xaml";
      const isHardcoded = !!nameMatch && !nameMatch[1].startsWith("[") && !nameMatch[1].includes("variable") && !isInitAllSettingsAssetContract;

      const resultMatch = contextBlock.match(RESULT_ATTR);
      const variableName = resultMatch ? resultMatch[1] : undefined;

      let assetValueType: CredentialAssetEntry["assetValueType"] = "Unknown";
      if (isCredential) {
        assetValueType = "Credential";
      } else {
        const typeMatch = contextBlock.match(ASSET_TYPE_ATTR);
        if (typeMatch) {
          const raw = typeMatch[1];
          if (raw === "Text" || raw === "Integer" || raw === "Boolean") assetValueType = raw;
        } else if (variableName) {
          if (/int|count|num/i.test(variableName)) assetValueType = "Integer";
          else if (/bool|flag|is[A-Z]/i.test(variableName)) assetValueType = "Boolean";
          else assetValueType = "Text";
        }
      }

      let consumingActivity: string | undefined;
      if (variableName) {
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
          if (lines[j].includes(`[${variableName}]`) || lines[j].includes(`${variableName}`)) {
            const consumerMatch = lines[j].match(DISPLAY_NAME_ATTR);
            if (consumerMatch) {
              consumingActivity = consumerMatch[1];
              break;
            }
          }
        }
      }

      entries.push({
        file: shortName,
        activityType,
        assetName,
        isHardcoded,
        variableName,
        lineNumber: i + 1,
        assetValueType,
        consumingActivity,
      });
    }
  }

  const hardcodedCount = entries.filter(e => e.isHardcoded).length;
  const variableCount = entries.filter(e => !e.isHardcoded).length;
  const uniqueAssetNames = [...new Set(
    entries.filter(e => e.activityType === "GetAsset" || e.activityType === "SetAsset")
      .map(e => e.assetName)
      .filter(n => n !== "UNKNOWN"),
  )];
  const uniqueCredentialNames = [...new Set(
    entries.filter(e => e.activityType === "GetCredential" || e.activityType === "SetCredential")
      .map(e => e.assetName)
      .filter(n => n !== "UNKNOWN"),
  )];

  return { entries, hardcodedCount, variableCount, uniqueAssetNames, uniqueCredentialNames };
}

export function analyzeExceptionCoverage(
  xamlEntries: { name: string; content: string }[],
): ExceptionCoverageResult {
  const entries: ExceptionCoverageEntry[] = [];
  const filesWithoutTryCatch: string[] = [];

  for (const entry of xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const content = entry.content;
    const hasTryCatch = /<TryCatch[\s>]/.test(content);

    if (!hasTryCatch) {
      filesWithoutTryCatch.push(shortName);
    }

    const tryCatchRanges = findTryCatchRanges(content);
    const catchTypesMap = extractCatchTypes(content);
    const lines = content.split("\n");

    const lineOffsets: number[] = [];
    let runningOffset = 0;
    for (let li = 0; li < lines.length; li++) {
      lineOffsets.push(runningOffset);
      runningOffset += lines[li].length + 1;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const actTag of HIGH_RISK_ACTIVITIES) {
        const prefix = actTag.split(":")[0];
        const name = actTag.split(":")[1];
        if (line.includes(`<${prefix}:${name}`) || line.includes(`<${prefix}:${name} `)) {
          const charOffset = lineOffsets[i];
          const insideTryCatch = tryCatchRanges.some(r => charOffset >= r.start && charOffset <= r.end);
          const catchTypes = insideTryCatch
            ? (catchTypesMap.find(c => charOffset >= c.start && charOffset <= c.end)?.types || [])
            : [];

          const displayNameMatch = line.match(/DisplayName="([^"]*)"/);

          entries.push({
            file: shortName,
            activityName: displayNameMatch ? displayNameMatch[1] : actTag,
            lineNumber: i + 1,
            insideTryCatch,
            catchTypes,
          });
          break;
        }
      }
    }
  }

  const totalActivities = entries.length;
  const coveredActivities = entries.filter(e => e.insideTryCatch).length;
  const coveragePercent = totalActivities > 0 ? Math.round((coveredActivities / totalActivities) * 100) : 100;
  const uncoveredHighRiskActivities = entries
    .filter(e => !e.insideTryCatch)
    .map(e => `${e.file}:${e.lineNumber} ${e.activityName}`);

  return {
    entries,
    totalActivities,
    coveredActivities,
    coveragePercent,
    uncoveredHighRiskActivities,
    filesWithoutTryCatch,
  };
}

interface TagRange {
  start: number;
  end: number;
}

interface CatchTypeRange extends TagRange {
  types: string[];
}

function findTryCatchRanges(content: string): TagRange[] {
  const ranges: TagRange[] = [];
  const openPattern = /<TryCatch[\s>]/g;
  const closeTag = "</TryCatch>";
  let match;

  while ((match = openPattern.exec(content)) !== null) {
    const start = match.index;
    let depth = 1;
    let pos = start + match[0].length;

    while (pos < content.length && depth > 0) {
      const nestedOpenPattern = /<TryCatch[\s>]/g;
      nestedOpenPattern.lastIndex = pos;
      const nextOpenMatch = nestedOpenPattern.exec(content);
      const nextCloseIdx = content.indexOf(closeTag, pos);

      if (nextCloseIdx === -1) break;

      if (nextOpenMatch && nextOpenMatch.index < nextCloseIdx) {
        depth++;
        pos = nextOpenMatch.index + nextOpenMatch[0].length;
      } else {
        depth--;
        if (depth === 0) {
          ranges.push({ start, end: nextCloseIdx + closeTag.length });
        }
        pos = nextCloseIdx + closeTag.length;
      }
    }
  }

  return ranges;
}

function extractCatchTypes(content: string): CatchTypeRange[] {
  const results: CatchTypeRange[] = [];
  const tryCatchRanges = findTryCatchRanges(content);

  for (const range of tryCatchRanges) {
    const block = content.slice(range.start, range.end);
    const types: string[] = [];
    const catchTypePattern = /TypeArgument="([^"]+)"/g;
    let m;
    while ((m = catchTypePattern.exec(block)) !== null) {
      const contextBefore = block.slice(Math.max(0, m.index - 100), m.index);
      if (contextBefore.includes("Catch") || contextBefore.includes("ActivityAction")) {
        types.push(m[1]);
      }
    }
    results.push({ ...range, types: [...new Set(types)] });
  }

  return results;
}

export function extractQueueManagement(
  xamlEntries: { name: string; content: string }[],
): QueueManagementResult {
  const entries: QueueUsageEntry[] = [];

  const queueActivities = [
    { pattern: /<ui:AddQueueItem\b/g, type: "AddQueueItem" },
    { pattern: /<ui:GetTransactionItem\b/g, type: "GetTransactionItem" },
    { pattern: /<ui:SetTransactionStatus\b/g, type: "SetTransactionStatus" },
    { pattern: /<ui:SetTransactionProgress\b/g, type: "SetTransactionProgress" },
    { pattern: /<ui:GetQueueItems\b/g, type: "GetQueueItems" },
    { pattern: /<ui:DeleteQueueItems\b/g, type: "DeleteQueueItems" },
    { pattern: /<ui:PostponeTransactionItem\b/g, type: "PostponeTransactionItem" },
    { pattern: /<ui:BulkAddQueueItems\b/g, type: "BulkAddQueueItems" },
  ];

  const queueNamePattern = /QueueName\s*=\s*"([^"]*)"/;

  for (const entry of xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    const lines = entry.content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      for (const qa of queueActivities) {
        qa.pattern.lastIndex = 0;
        if (qa.pattern.test(lines[i])) {
          const contextBlock = lines.slice(i, Math.min(i + 5, lines.length)).join("\n");
          const nameMatch = contextBlock.match(queueNamePattern);
          const queueName = nameMatch ? nameMatch[1] : "UNKNOWN";
          const isHardcoded = !!nameMatch && !nameMatch[1].startsWith("[");

          entries.push({
            file: shortName,
            activityType: qa.type,
            queueName,
            isHardcoded,
            lineNumber: i + 1,
          });
          break;
        }
      }
    }
  }

  const uniqueQueues = [...new Set(entries.map(e => e.queueName).filter(n => n !== "UNKNOWN"))];
  const hasAddQueueItem = entries.some(e => e.activityType === "AddQueueItem" || e.activityType === "BulkAddQueueItems");
  const hasGetTransaction = entries.some(e => e.activityType === "GetTransactionItem");
  const hasSetTransactionStatus = entries.some(e => e.activityType === "SetTransactionStatus");
  const isTransactionalPattern = hasGetTransaction && hasSetTransactionStatus;

  const hasPostpone = entries.some(e => e.activityType === "PostponeTransactionItem");

  const retryPolicy = isTransactionalPattern
    ? {
        maxRetries: 3,
        autoRetryEnabled: true,
        note: hasPostpone
          ? "Transactional pattern with postpone detected — configure Auto Retry with postpone-aware retry delay"
          : "Transactional pattern detected — configure Auto Retry (recommended: 3 retries) in Orchestrator Queue settings",
      }
    : {
        maxRetries: 0,
        autoRetryEnabled: false,
        note: hasAddQueueItem
          ? "Dispatcher pattern only — retry policies apply to the consumer process, not the dispatcher"
          : "No queue usage detected — retry policy not applicable",
      };

  const slaGuidance = isTransactionalPattern
    ? "Configure SLA in Orchestrator: set Maximum Execution Time per transaction item and monitor Queue SLA reports. Recommended: base SLA on observed P95 processing time + 20% buffer."
    : hasAddQueueItem
      ? "Monitor queue growth rate and dispatcher throughput. Set alerts for queue item age exceeding business SLA."
      : "No queue-based SLA applicable.";

  const deadLetterHandling = isTransactionalPattern
    ? "Items exceeding max retries are marked as Failed. Review failed items in Orchestrator Queues dashboard. Consider: (1) Create a separate cleanup/reprocessing workflow for DLQ items, (2) Set up email alerts for failed transaction counts exceeding threshold, (3) Log detailed failure context in SetTransactionStatus output for troubleshooting."
    : "No dead-letter handling applicable — process does not consume queue items.";

  return {
    entries,
    uniqueQueues,
    hasAddQueueItem,
    hasGetTransaction,
    hasSetTransactionStatus,
    isTransactionalPattern,
    retryPolicy,
    slaGuidance,
    deadLetterHandling,
  };
}

export function detectEnvironmentRequirements(
  xamlEntries: { name: string; content: string }[],
  projectJsonContent?: string,
): EnvironmentRequirements {
  const allContent = xamlEntries.map(e => e.content).join("\n");

  const needsWindowsTarget =
    allContent.includes("ExcelApplicationScope") ||
    allContent.includes("OutlookScope") ||
    allContent.includes("WordApplicationScope") ||
    allContent.includes("SAP.") ||
    allContent.includes("CitrixScope");

  const needsAttendedRobot =
    allContent.includes("InputDialog") ||
    allContent.includes("MessageBox") ||
    allContent.includes("SelectFile") ||
    allContent.includes("SelectFolder") ||
    allContent.includes("CalloutScope");

  const usesModernActivities = MODERN_ACTIVITY_INDICATORS.some(ind => allContent.includes(ind));

  const browserExtensions: string[] = [];
  for (const indicator of BROWSER_EXTENSION_INDICATORS) {
    if (indicator.pattern.test(allContent)) {
      browserExtensions.push(indicator.extension);
    }
  }

  let requiredPackages: string[] = [];
  let studioVersion = "25.10.0";
  if (projectJsonContent) {
    try {
      const pj = JSON.parse(projectJsonContent);
      requiredPackages = Object.keys(pj.dependencies || {});
      if (pj.studioVersion) studioVersion = pj.studioVersion;
      if (pj.toolVersion) studioVersion = pj.toolVersion;
    } catch {}
  }

  const usesOrchestrator =
    allContent.includes("GetCredential") ||
    allContent.includes("GetAsset") ||
    allContent.includes("SetAsset") ||
    allContent.includes("AddQueueItem") ||
    allContent.includes("GetTransactionItem") ||
    allContent.includes("SetTransactionStatus");

  const usesActionCenter =
    allContent.includes("CreateFormTask") ||
    allContent.includes("WaitForFormTaskAndResume") ||
    allContent.includes("CreateExternalTask");

  const usesAICenter =
    allContent.includes("MLSkill") ||
    allContent.includes("MachineLearningScope") ||
    allContent.includes("MLModel");

  const usesDocumentUnderstanding =
    allContent.includes("DocumentUnderstanding") ||
    allContent.includes("DigitizeDocument") ||
    allContent.includes("ClassifyDocument") ||
    allContent.includes("ExtractData");

  const usesDataService =
    allContent.includes("DataService") ||
    allContent.includes("QueryEntity") ||
    allContent.includes("CreateEntity") ||
    allContent.includes("UpdateEntity") ||
    allContent.includes("DeleteEntity");

  let machineType: EnvironmentRequirements["machineTemplate"]["recommendedType"] = "Standard";
  let machineNote = "Standard unattended machine template";
  if (usesAICenter || usesDocumentUnderstanding) {
    machineType = "Server";
    machineNote = "Server machine recommended for AI/DU workloads — allocate GPU resources if using local ML models";
  } else if (!needsWindowsTarget && usesModernActivities && !needsAttendedRobot) {
    machineType = "Serverless";
    machineNote = "Cross-platform modern activities — eligible for Serverless Cloud Robot execution";
  } else if (needsAttendedRobot) {
    machineNote = "Standard machine with interactive session — user must be logged in for attended robot";
  }

  const orchestratorFolderGuidance = needsAttendedRobot
    ? "Create a Modern Folder with attended robot assignments. Ensure user accounts are mapped to the folder with appropriate permissions."
    : isTransactional(allContent)
      ? "Create a Modern Folder with unattended robot pool (2+ robots recommended for queue-based processing). Enable Auto-scaling if available."
      : "Create a Modern Folder with at least one unattended robot assignment. Use folder-level credential stores for asset isolation.";

  return {
    needsWindowsTarget,
    needsAttendedRobot,
    usesModernActivities,
    browserExtensions: [...new Set(browserExtensions)],
    requiredPackages,
    usesOrchestrator,
    usesActionCenter,
    usesAICenter,
    usesDocumentUnderstanding,
    usesDataService,
    machineTemplate: { recommendedType: machineType, note: machineNote },
    orchestratorFolderGuidance,
    studioVersion,
  };
}

function isTransactional(content: string): boolean {
  return content.includes("GetTransactionItem") && content.includes("SetTransactionStatus");
}

export function suggestTriggers(
  queueResult: QueueManagementResult,
  envResult: EnvironmentRequirements,
  automationType?: string,
  sddTriggers?: Array<{ name: string; type: string; cron?: string; queueName?: string; enabled?: boolean; description?: string }>,
): TriggerSuggestion[] {
  const suggestions: TriggerSuggestion[] = [];

  if (sddTriggers && sddTriggers.length > 0) {
    for (const t of sddTriggers) {
      const normalizedType = (t.type || "").toLowerCase().trim();
      const triggerType: TriggerSuggestion["triggerType"] =
        normalizedType === "queue" ? "Queue"
        : normalizedType === "time" || normalizedType === "schedule" || normalizedType === "cron" ? "Schedule"
        : normalizedType === "api" || normalizedType === "webhook" || normalizedType === "api/webhook" ? "API/Webhook"
        : normalizedType === "event" || normalizedType === "eventbased" || normalizedType === "event-based" ? "EventBased"
        : normalizedType === "attended" ? "Attended"
        : "Schedule";

      let config = `SDD-specified: ${t.name}`;
      if (t.cron) config += ` | Cron: ${t.cron}`;
      if (t.queueName) config += ` | Queue: ${t.queueName}`;
      if (t.enabled === false) config += ` | Disabled by default`;
      if (t.description) config += ` | ${t.description}`;

      suggestions.push({
        triggerType,
        reason: `Defined in SDD orchestrator_artifacts: ${t.name}`,
        suggestedConfig: config,
      });
    }
    return suggestions;
  }

  if (queueResult.isTransactionalPattern) {
    suggestions.push({
      triggerType: "Queue",
      reason: "Process uses GetTransactionItem/SetTransactionStatus — configure a queue trigger in Orchestrator",
      suggestedConfig: queueResult.uniqueQueues.length > 0
        ? `Queue: ${queueResult.uniqueQueues[0]} | Min items to trigger: 1 | Max concurrent jobs: 2 | Unique Reference: Optional`
        : "Configure queue name in Orchestrator | Min items to trigger: 1",
    });
  }

  if (envResult.needsAttendedRobot) {
    suggestions.push({
      triggerType: "Attended",
      reason: "Process uses UI dialogs (InputDialog/MessageBox) — requires attended robot with user interaction",
      suggestedConfig: "Trigger from UiPath Assistant or Action Center task completion",
    });
  }

  if (automationType === "agent" || automationType === "hybrid") {
    suggestions.push({
      triggerType: "API/Webhook",
      reason: "Agent/hybrid automation — consider API trigger or webhook for on-demand invocation",
      suggestedConfig: "POST /odata/Jobs/UiPath.Server.Configuration.OData.StartJobs | Include InputArguments in request body",
    });
  }

  if (envResult.usesActionCenter) {
    suggestions.push({
      triggerType: "EventBased",
      reason: "Process uses Action Center tasks — configure event trigger on task completion",
      suggestedConfig: "Event type: FormTaskCompleted | Source: Action Center",
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      triggerType: "Schedule",
      reason: "Standard unattended process — configure a time-based schedule trigger in Orchestrator",
      suggestedConfig: "Cron: 0 8 * * 1-5 (weekdays at 8am) — adjust per business requirement | Timezone: UTC or local business timezone | Non-working days: Exclude via Orchestrator calendar",
    });
  }

  return suggestions;
}

export interface ReadinessScore {
  section: string;
  score: number;
  maxScore: number;
  notes: string[];
}

export interface OverallReadiness {
  sections: ReadinessScore[];
  totalScore: number;
  maxTotalScore: number;
  percent: number;
  rating: "Ready" | "Mostly Ready" | "Needs Work" | "Not Ready";
}

export function calculateReadiness(
  credentialInventory: CredentialAssetInventory,
  exceptionCoverage: ExceptionCoverageResult,
  queueManagement: QueueManagementResult,
  envRequirements: EnvironmentRequirements,
  qualityWarningCount: number,
  remediationCount: number,
  stubAwareness?: {
    entryPointStubbed: boolean;
    stubCount: number;
    totalWorkflowCount: number;
    plannedButMissingCount: number;
    studioLoadableCount?: number;
    studioBlockedCount?: number;
  },
  emptyContainerCount?: number,
): OverallReadiness {
  const sections: ReadinessScore[] = [];

  {
    let score = 10;
    const notes: string[] = [];
    if (credentialInventory.hardcodedCount > 0) {
      score -= Math.min(5, credentialInventory.hardcodedCount * 2);
      notes.push(`${credentialInventory.hardcodedCount} hardcoded asset name(s) — use Orchestrator assets/config`);
    }
    if (credentialInventory.entries.length === 0 && envRequirements.usesOrchestrator) {
      score -= 2;
      notes.push("No credential/asset activities found despite Orchestrator usage");
    }
    if (notes.length === 0) notes.push("All credentials/assets properly configured");
    sections.push({ section: "Credentials & Assets", score: Math.max(0, score), maxScore: 10, notes });
  }

  {
    let score = 10;
    const notes: string[] = [];
    if (exceptionCoverage.totalActivities === 0) {
      notes.push("No high-risk activities detected — exception handling not scored");
    } else {
      if (exceptionCoverage.coveragePercent < 50) {
        score -= 5;
        notes.push(`Only ${exceptionCoverage.coveragePercent}% of high-risk activities covered by TryCatch`);
      } else if (exceptionCoverage.coveragePercent < 80) {
        score -= 3;
        notes.push(`${exceptionCoverage.coveragePercent}% coverage — consider wrapping remaining activities`);
      }
      if (exceptionCoverage.filesWithoutTryCatch.length > 0) {
        score -= Math.min(3, exceptionCoverage.filesWithoutTryCatch.length);
        notes.push(`${exceptionCoverage.filesWithoutTryCatch.length} file(s) with no TryCatch blocks`);
      }
    }
    if (notes.length === 0) notes.push("Good exception handling coverage");
    sections.push({ section: "Exception Handling", score: Math.max(0, score), maxScore: 10, notes });
  }

  {
    let score = 10;
    const notes: string[] = [];
    if (queueManagement.hasGetTransaction && !queueManagement.hasSetTransactionStatus) {
      score -= 5;
      notes.push("GetTransactionItem found without SetTransactionStatus — incomplete transaction handling");
    }
    const hardcodedQueues = queueManagement.entries.filter(e => e.isHardcoded).length;
    if (hardcodedQueues > 0) {
      score -= Math.min(3, hardcodedQueues);
      notes.push(`${hardcodedQueues} hardcoded queue name(s) — externalize to config`);
    }
    if (queueManagement.entries.length === 0) {
      score = 10;
      notes.length = 0;
      notes.push("No queue activities — section not applicable");
    }
    if (notes.length === 0) notes.push("Queue configuration looks good");
    sections.push({ section: "Queue Management", score: Math.max(0, score), maxScore: 10, notes });
  }

  {
    let score = 10;
    const notes: string[] = [];
    if (qualityWarningCount > 10) {
      score -= 5;
      notes.push(`${qualityWarningCount} quality warnings — significant remediation needed`);
    } else if (qualityWarningCount > 3) {
      score -= 2;
      notes.push(`${qualityWarningCount} quality warnings to address`);
    }
    if (remediationCount > 5) {
      score -= 4;
      notes.push(`${remediationCount} remediations — stub replacements need developer attention`);
    } else if (remediationCount > 0) {
      score -= 2;
      notes.push(`${remediationCount} remediation(s) to complete`);
    }
    if (stubAwareness) {
      if (stubAwareness.entryPointStubbed) {
        score -= 10;
        notes.push("Entry point (Main.xaml) is stubbed — package has no runnable entry point");
      }
      const effectiveBlockedCount = stubAwareness.studioBlockedCount !== undefined
        ? stubAwareness.studioBlockedCount
        : stubAwareness.stubCount;
      const effectiveLoadableCount = stubAwareness.studioLoadableCount !== undefined
        ? stubAwareness.studioLoadableCount
        : (stubAwareness.totalWorkflowCount - stubAwareness.stubCount);
      if (stubAwareness.totalWorkflowCount > 0 && effectiveBlockedCount > 0) {
        const blockedProportion = effectiveBlockedCount / stubAwareness.totalWorkflowCount;
        const perBlockedPenalty = effectiveBlockedCount * 3;
        const proportionalPenalty = Math.round(blockedProportion * 10);
        const blockedDeduction = Math.max(perBlockedPenalty, proportionalPenalty);
        score -= blockedDeduction;
        notes.push(`${effectiveLoadableCount}/${stubAwareness.totalWorkflowCount} workflow(s) are Studio-loadable (${effectiveBlockedCount} blocked — ${Math.round(blockedProportion * 100)}% not loadable)`);
      }
      if (stubAwareness.plannedButMissingCount > 0) {
        score -= Math.min(5, stubAwareness.plannedButMissingCount * 2);
        notes.push(`${stubAwareness.plannedButMissingCount} planned workflow(s) missing from archive`);
      }
    }
    if (emptyContainerCount && emptyContainerCount > 0) {
      score -= Math.min(4, emptyContainerCount);
      notes.push(`${emptyContainerCount} empty container(s) — workflows with empty sequences are structurally incomplete`);
    }
    if (notes.length === 0) notes.push("Build quality is clean");
    sections.push({ section: "Build Quality", score: Math.max(0, score), maxScore: 10, notes });
  }

  {
    let score = 10;
    const notes: string[] = [];
    if (envRequirements.requiredPackages.length === 0) {
      score -= 3;
      notes.push("No dependency packages detected in project.json");
    }
    if (envRequirements.browserExtensions.length > 0) {
      score -= 1;
      notes.push(`Browser extensions required: ${envRequirements.browserExtensions.join(", ")}`);
    }
    if (notes.length === 0) notes.push("Environment requirements are straightforward");
    sections.push({ section: "Environment Setup", score: Math.max(0, score), maxScore: 10, notes });
  }

  const totalScore = sections.reduce((s, sec) => s + sec.score, 0);
  const maxTotalScore = sections.reduce((s, sec) => s + sec.maxScore, 0);
  let percent = maxTotalScore > 0 ? Math.round((totalScore / maxTotalScore) * 100) : 0;

  if (stubAwareness?.entryPointStubbed && percent >= 20) {
    percent = 19;
  } else if (stubAwareness) {
    const blockedCount = stubAwareness.studioBlockedCount !== undefined
      ? stubAwareness.studioBlockedCount
      : stubAwareness.stubCount;
    if (blockedCount > 0) {
      const blockedFraction = stubAwareness.totalWorkflowCount > 0
        ? blockedCount / stubAwareness.totalWorkflowCount
        : 0;
      const blockedCap = blockedCount >= 4
        ? Math.min(29, Math.round(30 * (1 - blockedFraction)))
        : blockedCount >= 2
          ? Math.min(34, Math.round(40 * (1 - blockedFraction)))
          : 39;
      if (percent > blockedCap) {
        percent = blockedCap;
      }
    }
  }

  let rating: OverallReadiness["rating"];
  if (percent >= 85) rating = "Ready";
  else if (percent >= 65) rating = "Mostly Ready";
  else if (percent >= 40) rating = "Needs Work";
  else rating = "Not Ready";

  return { sections, totalScore, maxTotalScore, percent, rating };
}

export interface ProcessStepSummary {
  name: string;
  role: string;
  system: string;
  nodeType: string;
  isPainPoint: boolean;
  description: string;
}

export interface DecisionBranch {
  decisionNodeName: string;
  branches: Array<{ label: string; targetNodeName: string }>;
}

export interface UpstreamContext {
  ideaDescription?: string;
  pddSummary?: string;
  sddSummary?: string;
  automationType?: string;
  automationTypeRationale?: string;
  feasibilityScore?: number;
  feasibilityComplexity?: string;
  feasibilityEffortEstimate?: string;
  qualityWarnings?: Array<{ code: string; message: string; severity: string }>;
  processSteps?: ProcessStepSummary[];
  painPoints?: string[];
  systems?: string[];
  roles?: string[];
  decisionBranches?: DecisionBranch[];
}

export type ArtifactReconciliationStatus = "aligned" | "sdd-only" | "xaml-only";

export interface ArtifactReconciliationEntry {
  name: string;
  type: "asset" | "credential" | "queue";
  status: ArtifactReconciliationStatus;
  sddConfig?: Record<string, any>;
  xamlFile?: string;
  xamlLineNumber?: number;
  valueType?: string;
}

export interface SddArtifactCrossReference {
  entries: ArtifactReconciliationEntry[];
  alignedCount: number;
  sddOnlyCount: number;
  xamlOnlyCount: number;
  sddTriggers?: Array<{ name: string; type: string; cron?: string; queueName?: string; enabled?: boolean; description?: string }>;
  sddQueueConfigs?: Array<{ name: string; maxRetries?: number; uniqueReference?: boolean; sla?: string; description?: string }>;
}

export function crossReferenceArtifacts(
  sddArtifacts: Record<string, any> | null,
  credentialInventory: CredentialAssetInventory,
  queueManagement: QueueManagementResult,
): SddArtifactCrossReference {
  const entries: ArtifactReconciliationEntry[] = [];

  const sddAssets: Array<{ name: string; type?: string; value?: string; description?: string }> = [];
  const sddCredentials: Array<{ name: string; description?: string }> = [];
  const sddQueues: Array<{ name: string; maxRetries?: number; uniqueReference?: boolean; description?: string }> = [];
  const sddTriggers: SddArtifactCrossReference["sddTriggers"] = [];
  const sddQueueConfigs: SddArtifactCrossReference["sddQueueConfigs"] = [];

  if (sddArtifacts) {
    if (Array.isArray(sddArtifacts.assets)) {
      for (const a of sddArtifacts.assets) {
        if (a && typeof a === "object" && a.name) {
          sddAssets.push(a);
        }
      }
    }
    if (Array.isArray(sddArtifacts.queues)) {
      for (const q of sddArtifacts.queues) {
        if (q && typeof q === "object" && q.name) {
          sddQueues.push(q);
          sddQueueConfigs.push({
            name: q.name,
            maxRetries: q.maxRetries,
            uniqueReference: q.uniqueReference,
            sla: q.sla,
            description: q.description,
          });
        }
      }
    }
    if (Array.isArray(sddArtifacts.triggers)) {
      for (const t of sddArtifacts.triggers) {
        if (t && typeof t === "object" && t.name) {
          sddTriggers.push({
            name: t.name,
            type: t.type || "Unknown",
            cron: t.cron,
            queueName: t.queueName,
            enabled: t.enabled,
            description: t.description,
          });
        }
      }
    }
  }

  const sddAssetNames = new Set(sddAssets.map(a => a.name.trim()));
  const xamlAssetNames = new Set(credentialInventory.uniqueAssetNames.map(n => n.trim()));
  const xamlCredNames = new Set(credentialInventory.uniqueCredentialNames.map(n => n.trim()));
  const sddQueueNames = new Set(sddQueues.map(q => q.name.trim()));
  const xamlQueueNames = new Set(queueManagement.uniqueQueues.map(n => n.trim()));

  for (const asset of sddAssets) {
    const assetType = (asset.type || "").toLowerCase();
    const isCredential = assetType === "credential";

    if (isCredential) {
      sddCredentials.push(asset);
      const inXaml = xamlCredNames.has(asset.name.trim());
      const xamlEntry = inXaml ? credentialInventory.entries.find(e => e.assetName.trim() === asset.name.trim()) : undefined;
      entries.push({
        name: asset.name,
        type: "credential",
        status: inXaml ? "aligned" : "sdd-only",
        sddConfig: { type: asset.type, description: asset.description },
        xamlFile: xamlEntry?.file,
        xamlLineNumber: xamlEntry?.lineNumber,
        valueType: "Credential",
      });
    } else {
      const inXaml = xamlAssetNames.has(asset.name.trim());
      const xamlEntry = inXaml ? credentialInventory.entries.find(e => e.assetName.trim() === asset.name.trim()) : undefined;
      entries.push({
        name: asset.name,
        type: "asset",
        status: inXaml ? "aligned" : "sdd-only",
        sddConfig: { type: asset.type, value: asset.value, description: asset.description },
        xamlFile: xamlEntry?.file,
        xamlLineNumber: xamlEntry?.lineNumber,
        valueType: asset.type || xamlEntry?.assetValueType || "Unknown",
      });
    }
  }

  for (const name of credentialInventory.uniqueAssetNames) {
    if (!sddAssetNames.has(name.trim())) {
      const xamlEntry = credentialInventory.entries.find(e => e.assetName === name);
      entries.push({
        name,
        type: "asset",
        status: "xaml-only",
        xamlFile: xamlEntry?.file,
        xamlLineNumber: xamlEntry?.lineNumber,
        valueType: xamlEntry?.assetValueType || "Unknown",
      });
    }
  }

  for (const name of credentialInventory.uniqueCredentialNames) {
    const alreadyFromSdd = entries.some(e => e.name.trim() === name.trim() && e.type === "credential");
    if (!alreadyFromSdd) {
      const xamlEntry = credentialInventory.entries.find(e => e.assetName === name);
      entries.push({
        name,
        type: "credential",
        status: "xaml-only",
        xamlFile: xamlEntry?.file,
        xamlLineNumber: xamlEntry?.lineNumber,
        valueType: "Credential",
      });
    }
  }

  for (const q of sddQueues) {
    const inXaml = xamlQueueNames.has(q.name.trim());
    const xamlEntry = inXaml ? queueManagement.entries.find(e => e.queueName.trim() === q.name.trim()) : undefined;
    entries.push({
      name: q.name,
      type: "queue",
      status: inXaml ? "aligned" : "sdd-only",
      sddConfig: { maxRetries: q.maxRetries, uniqueReference: q.uniqueReference, description: q.description },
      xamlFile: xamlEntry?.file,
      xamlLineNumber: xamlEntry?.lineNumber,
    });
  }

  for (const name of queueManagement.uniqueQueues) {
    if (!sddQueueNames.has(name.trim())) {
      const xamlEntry = queueManagement.entries.find(e => e.queueName === name);
      entries.push({
        name,
        type: "queue",
        status: "xaml-only",
        xamlFile: xamlEntry?.file,
        xamlLineNumber: xamlEntry?.lineNumber,
      });
    }
  }

  const alignedCount = entries.filter(e => e.status === "aligned").length;
  const sddOnlyCount = entries.filter(e => e.status === "sdd-only").length;
  const xamlOnlyCount = entries.filter(e => e.status === "xaml-only").length;

  return { entries, alignedCount, sddOnlyCount, xamlOnlyCount, sddTriggers, sddQueueConfigs };
}

export interface DhgAnalysisResult {
  credentialInventory: CredentialAssetInventory;
  exceptionCoverage: ExceptionCoverageResult;
  queueManagement: QueueManagementResult;
  environmentRequirements: EnvironmentRequirements;
  triggerSuggestions: TriggerSuggestion[];
  readiness: OverallReadiness;
  hasBlockedWorkflows?: boolean;
  upstreamContext?: UpstreamContext;
  sddCrossReference?: SddArtifactCrossReference;
}

export function runDhgAnalysis(
  xamlEntries: { name: string; content: string }[],
  projectJsonContent?: string,
  qualityWarningCount?: number,
  remediationCount?: number,
  automationType?: string,
  upstreamContext?: UpstreamContext,
  sddArtifacts?: Record<string, any> | null,
  stubAwareness?: {
    entryPointStubbed: boolean;
    stubCount: number;
    totalWorkflowCount: number;
    plannedButMissingCount: number;
  },
  emptyContainerCount?: number,
): DhgAnalysisResult {
  const credentialInventory = scanCredentialAssets(xamlEntries);
  const exceptionCoverage = analyzeExceptionCoverage(xamlEntries);
  const queueManagement = extractQueueManagement(xamlEntries);
  const environmentRequirements = detectEnvironmentRequirements(xamlEntries, projectJsonContent);
  const effectiveAutomationType = automationType || upstreamContext?.automationType;

  const sddCrossReference = sddArtifacts
    ? crossReferenceArtifacts(sddArtifacts, credentialInventory, queueManagement)
    : undefined;

  const triggerSuggestions = suggestTriggers(
    queueManagement,
    environmentRequirements,
    effectiveAutomationType,
    sddCrossReference?.sddTriggers,
  );

  const readiness = calculateReadiness(
    credentialInventory,
    exceptionCoverage,
    queueManagement,
    environmentRequirements,
    qualityWarningCount || 0,
    remediationCount || 0,
    stubAwareness,
    emptyContainerCount,
  );

  return {
    credentialInventory,
    exceptionCoverage,
    queueManagement,
    environmentRequirements,
    triggerSuggestions,
    readiness,
    upstreamContext,
    sddCrossReference,
  };
}
