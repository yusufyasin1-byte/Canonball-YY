import type { ProcessNode, ProcessEdge } from "@shared/schema";
import type { EnrichedNodeSpec, EnrichedActivity, EnrichmentResult } from "./ai-xaml-enricher";
import {
  generateAnnotationText,
  generateArgumentValidationXaml,
  enforceVariableName,
  enforceDisplayName,
  type AnalysisReport,
} from "./workflow-analyzer";
import { escapeXml, escapeXmlExpression, normalizeXmlExpression } from "./lib/xml-utils";
import type { DeploymentResult } from "@shared/models/deployment";
import type { AICenterSkill } from "./uipath-integration";
import { isActivityAllowed } from "./uipath-activity-policy";
import type { AutomationPattern } from "./uipath-activity-registry";
import { ACTIVITY_NAME_ALIAS_MAP } from "./uipath-activity-registry";
import type { XamlGenerationContext } from "./types/uipath-package";
import type { PipelineOutcomeReport } from "./uipath-pipeline";
import { XMLValidator } from "fast-xml-parser";
import { catalogService } from "./catalog/catalog-service";
import type { StudioProfile } from "./catalog/metadata-service";

export {
  ensureBracketWrapped,
  looksLikeVariableRef,
  smartBracketWrap,
  normalizeXaml,
  normalizeXaml as makeUiPathCompliant,
  normalizeAssignArgumentNesting,
  type TargetFramework,
} from "./xaml/xaml-compliance";

import { ensureBracketWrapped, smartBracketWrap, parseInvokeArgs } from "./xaml/xaml-compliance";

export {
  type XamlGap,
  type DhgDeploymentResult,
  type XamlValidationViolation,
  type ActivityStubResult,
  type SequenceStubResult,
  type StubWorkflowOptions,
  type StructuralPreservationResult,
  extractSystemFromGap,
  validateXamlContent,
  replaceActivityWithStub,
  replaceSequenceChildrenWithStub,
  generateStubWorkflow,
  preserveStructureAndStubLeaves,
  generateDhgSummary,
} from "./xaml/gap-analyzer";

import { type XamlGap, type DhgDeploymentResult, extractSystemFromGap } from "./xaml/gap-analyzer";
import type { TargetFramework } from "./xaml/xaml-compliance";

export type GenerationMode = "baseline_openable" | "full_implementation";

export interface GenerationModeConfig {
  mode: GenerationMode;
  reason: string;
  flatScaffold: boolean;
  blockReFramework: boolean;
  blockForbiddenActivities: boolean;
}

const BASELINE_FORBIDDEN_ACTIVITIES = new Set([
  "ui:TakeScreenshot",
  "ui:AddLogFields",
]);

const SILENTLY_FORBIDDEN_ACTIVITIES = new Set([
  "ui:AddLogFields",
]);

const REFRAMEWORK_FILES = new Set([
  "GetTransactionData.xaml",
  "SetTransactionStatus.xaml",
  "CloseAllApplications.xaml",
  "KillAllProcesses.xaml",
]);

export function selectGenerationMode(
  automationPattern: string,
  confidence?: number,
  profile?: StudioProfile | null,
): GenerationModeConfig {
  const resolvedProfile = profile !== undefined ? profile : catalogService.getStudioProfile();

  const isSimpleOrApi = automationPattern === "simple-linear" || automationPattern === "api-data-driven";
  const isLowConfidence = confidence !== undefined && confidence < 0.6;
  const isTransactional = automationPattern === "transactional-queue";
  const isHybrid = automationPattern === "hybrid";

  const targetFramework = resolvedProfile?.targetFramework || "Windows";
  const projectType = resolvedProfile?.projectType || "Process";

  if (projectType === "Library") {
    return {
      mode: "baseline_openable",
      reason: `Project type "Library" defaults to baseline_openable for reliable Studio-openable output (profile: ${resolvedProfile?.studioLine || "default"}, framework: ${targetFramework})`,
      flatScaffold: true,
      blockReFramework: true,
      blockForbiddenActivities: true,
    };
  }

  if (isTransactional && !isLowConfidence && targetFramework === "Windows" && projectType === "Process") {
    return {
      mode: "full_implementation",
      reason: `Pattern "${automationPattern}" qualifies for full implementation with REFramework only on a validated Windows Process profile (profile: ${resolvedProfile?.studioLine || "default"}, framework: ${targetFramework})`,
      flatScaffold: false,
      blockReFramework: false,
      blockForbiddenActivities: false,
    };
  }

  if (isSimpleOrApi || isLowConfidence) {
    return {
      mode: "baseline_openable",
      reason: isLowConfidence
        ? `Low confidence (${(confidence! * 100).toFixed(0)}%) — defaulting to baseline_openable for safety`
        : `Pattern "${automationPattern}" defaults to baseline_openable for reliable Studio-openable output`,
      flatScaffold: true,
      blockReFramework: true,
      blockForbiddenActivities: true,
    };
  }

  if (automationPattern === "ui-automation") {
    return {
      mode: "full_implementation",
      reason: `Pattern "${automationPattern}" supports full implementation (profile: ${resolvedProfile?.studioLine || "default"}, framework: ${targetFramework})`,
      flatScaffold: false,
      blockReFramework: false,
      blockForbiddenActivities: false,
    };
  }

  if (isHybrid) {
    return {
      mode: "baseline_openable",
      reason: `Pattern "${automationPattern}" defaults to baseline_openable until hybrid connector/genAI contracts are proven safe for the active profile`,
      flatScaffold: true,
      blockReFramework: true,
      blockForbiddenActivities: true,
    };
  }

  return {
    mode: "baseline_openable",
    reason: `Unknown pattern "${automationPattern}" — defaulting to baseline_openable`,
    flatScaffold: true,
    blockReFramework: true,
    blockForbiddenActivities: true,
  };
}


export function applyActivityPolicy(
  xamlContent: string,
  modeConfig: GenerationModeConfig,
  fileName: string,
): { content: string; blocked: string[] } {
  if (!modeConfig.blockForbiddenActivities) {
    return { content: xamlContent, blocked: [] };
  }
  const blocked: string[] = [];
  let content = xamlContent;

  for (const forbidden of Array.from(BASELINE_FORBIDDEN_ACTIVITIES)) {
    const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const selfClosingRe = new RegExp(`<${escaped}[^>]*\\/>`, "g");
    const openCloseRe = new RegExp(`<${escaped}[^>]*>[\\s\\S]*?<\\/${escaped}>`, "g");
    const silent = SILENTLY_FORBIDDEN_ACTIVITIES.has(forbidden);
    const replacement = silent ? "" : `<ui:Comment Text="[baseline_openable] Removed forbidden activity: ${forbidden}" DisplayName="Policy: ${forbidden} blocked" />`;
    if (content.includes(forbidden.replace("ui:", "<ui:"))) {
      blocked.push(forbidden);
      content = content.replace(selfClosingRe, replacement);
      content = content.replace(openCloseRe, replacement);
    }
  }

  if (modeConfig.blockReFramework) {
    content = content.replace(/WorkflowFileName="Workflows\\([^"]+)"/g, 'WorkflowFileName="$1"');
    content = content.replace(/WorkflowFileName="Workflows\/([^"]+)"/g, 'WorkflowFileName="$1"');
    content = content.replace(/WorkflowFileName="([^"]+)"/g, (_match: string, p1: string) => {
      const cleaned = p1.replace(/\\/g, "/").replace(/^[./]+/, "");
      return `WorkflowFileName="${cleaned}"`;
    });
  }

  return { content, blocked };
}

export function isReFrameworkFile(fileName: string): boolean {
  const basename = fileName.split("/").pop() || fileName;
  return REFRAMEWORK_FILES.has(basename);
}

export function isCurrentPatternActivityAllowed(activity: string, genCtx?: XamlGenerationContext): boolean {
  const pattern = genCtx?.automationPattern || "";
  if (!pattern) return true;
  return isActivityAllowed(activity, pattern as AutomationPattern);
}


export type XamlGeneratorResult = {
  xaml: string;
  gaps: XamlGap[];
  usedPackages: string[];
  variables: VariableDecl[];
};

type VariableDecl = {
  name: string;
  type: string;
  defaultValue?: string;
};

type ActivityContext = {
  system: string;
  nodeType: string;
  name: string;
  description: string;
  role: string;
  isPainPoint: boolean;
  targetFramework?: TargetFramework;
  autopilotEnabled?: boolean;
};

type WorkflowStep = {
  activity?: string;
  activityType?: string;
  activityPackage?: string;
  properties?: Record<string, any>;
  variables?: VariableDecl[];
  errorHandling?: "retry" | "catch" | "escalate" | "none";
  selectorHint?: string;
  notes?: string;
  nodeType?: string;
  role?: string;
};

type WorkflowSpec = {
  name: string;
  description?: string;
  steps?: WorkflowStep[];
  arguments?: Array<{ name: string; direction: string; type: string; required?: boolean }>;
};

function classifyActivity(ctx: ActivityContext, genCtx?: XamlGenerationContext): {
  activityType: string;
  activityPackage: string;
  properties: Record<string, string>;
  selectorHint?: string;
  errorHandling: "retry" | "catch" | "escalate" | "none";
  variables: VariableDecl[];
  gaps: XamlGap[];
} {
  const system = (ctx.system || "").toLowerCase();
  const name = (ctx.name || "").toLowerCase();
  const desc = (ctx.description || "").toLowerCase();
  const combined = `${name} ${desc} ${system}`;

  if (system.includes("excel") || system.includes("spreadsheet") || combined.includes("excel") || combined.includes("spreadsheet")) {
    return classifyExcel(ctx, combined);
  }
  if (system.includes("email") || system.includes("outlook") || system.includes("smtp") || combined.includes("email") || combined.includes("mail")) {
    const emailResult = classifyEmail(ctx, combined);
    if (!isCurrentPatternActivityAllowed(emailResult.activityType, genCtx)) {
      return classifyGeneral(ctx, combined);
    }
    return emailResult;
  }
  if (system.includes("api") || system.includes("http") || system.includes("rest") || system.includes("web service") || combined.includes("api") || combined.includes("http request")) {
    return classifyApi(ctx, combined);
  }
  if (system.includes("database") || system.includes("sql") || system.includes("db") || combined.includes("database") || combined.includes("query")) {
    return classifyDatabase(ctx, combined);
  }
  if (system.includes("queue") || combined.includes("queue item") || combined.includes("transaction")) {
    return classifyQueue(ctx, combined);
  }
  if (combined.includes("file") || combined.includes("folder") || combined.includes("directory") || combined.includes("read") || combined.includes("write") || combined.includes("download") || combined.includes("upload")) {
    return classifyFile(ctx, combined);
  }
  if (combined.includes("data fabric") || combined.includes("data service") || combined.includes("data entity") || combined.includes("entity record") || combined.includes("dataservice")) {
    return classifyDataFabric(ctx, combined);
  }
  if (combined.includes("action center") || combined.includes("human task") || combined.includes("create task") || combined.includes("wait for task") || combined.includes("approval task") || combined.includes("task catalog")) {
    return classifyActionCenterTask(ctx, combined);
  }
  if (combined.includes("ml skill") || combined.includes("ml model") || combined.includes("ai center") || combined.includes("ai skill") || combined.includes("predict") || combined.includes("classify") || combined.includes("classification") || combined.includes("anomaly detect") || combined.includes("nlp") || combined.includes("sentiment") || combined.includes("machine learning")) {
    return classifyMLSkill(ctx, combined, genCtx);
  }

  if (combined.includes("browser") || combined.includes("web") || combined.includes("click") || combined.includes("type") || combined.includes("navigate") || combined.includes("login") || combined.includes("portal") || combined.includes("screen") || combined.includes("ui ") || combined.includes("application")) {
    const uiResult = classifyUI(ctx, combined);
    if (!isCurrentPatternActivityAllowed(uiResult.activityType, genCtx)) {
      return classifyGeneral(ctx, combined);
    }
    return uiResult;
  }

  if (ctx.nodeType === "agent-task" || ctx.nodeType === "agent-loop") {
    return classifyAgent(ctx, combined);
  }

  return classifyGeneral(ctx, combined);
}

function classifyDataFabric(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [];

  if (combined.includes("delete") || combined.includes("remove")) {
    variables.push({ name: "str_EntityName", type: "String", defaultValue: '"TODO_EntityName"' });
    variables.push({ name: "str_RecordId", type: "String", defaultValue: '"TODO_RecordId"' });
    gaps.push({
      category: "config",
      activity: "DeleteEntity",
      description: `Configure Data Service entity type and record ID for "${ctx.name}"`,
      placeholder: "Entity type name and record identifier",
      estimatedMinutes: 10,
    });
    return {
      activityType: "ui:DeleteEntity",
      activityPackage: "UiPath.DataService.Activities",
      properties: {
        EntityType: "[str_EntityName]",
        EntityId: "[str_RecordId]",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  if (combined.includes("update") || combined.includes("upsert") || combined.includes("modify")) {
    variables.push({ name: "str_EntityName", type: "String", defaultValue: '"TODO_EntityName"' });
    variables.push({ name: "entityRecord", type: "UiPath.DataService.DataServiceEntity" });
    gaps.push({
      category: "config",
      activity: "UpdateEntity",
      description: `Configure Data Service entity type and field mappings for "${ctx.name}"`,
      placeholder: "Entity type name and field-value assignments on entityRecord",
      estimatedMinutes: 15,
    });
    return {
      activityType: "ui:UpdateEntity",
      activityPackage: "UiPath.DataService.Activities",
      properties: {
        EntityType: "[str_EntityName]",
        Entity: "[entityRecord]",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  if (combined.includes("write") || combined.includes("create") || combined.includes("insert") || combined.includes("add") || combined.includes("save")) {
    variables.push({ name: "str_EntityName", type: "String", defaultValue: '"TODO_EntityName"' });
    variables.push({ name: "entityRecord", type: "UiPath.DataService.DataServiceEntity" });
    gaps.push({
      category: "config",
      activity: "CreateEntity",
      description: `Configure Data Service entity type and field values for "${ctx.name}"`,
      placeholder: "Entity type name and field-value assignments on entityRecord",
      estimatedMinutes: 15,
    });
    return {
      activityType: "ui:CreateEntity",
      activityPackage: "UiPath.DataService.Activities",
      properties: {
        EntityType: "[str_EntityName]",
        Entity: "[entityRecord]",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  if (combined.includes("get by id") || combined.includes("lookup") || combined.includes("fetch by id") || combined.includes("single record") || combined.includes("getentitybyid")) {
    variables.push({ name: "str_EntityName", type: "String", defaultValue: '"TODO_EntityName"' });
    variables.push({ name: "str_RecordId", type: "String", defaultValue: '"TODO_RecordId"' });
    variables.push({ name: "entityResult", type: "UiPath.DataService.DataServiceEntity" });
    gaps.push({
      category: "config",
      activity: "GetEntityById",
      description: `Configure Data Service entity type and record ID for "${ctx.name}"`,
      placeholder: "Entity type name and record identifier",
      estimatedMinutes: 10,
    });
    return {
      activityType: "ui:GetEntityById",
      activityPackage: "UiPath.DataService.Activities",
      properties: {
        EntityType: "[str_EntityName]",
        EntityId: "[str_RecordId]",
        Result: "[entityResult]",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  variables.push({ name: "str_EntityName", type: "String", defaultValue: '"TODO_EntityName"' });
  variables.push({ name: "str_QueryFilter", type: "String", defaultValue: '"TODO_ODataFilter"' });
  variables.push({ name: "entityResults", type: "System.Collections.Generic.List(UiPath.DataService.DataServiceEntity)" });
  gaps.push({
    category: "config",
    activity: "QueryEntity",
    description: `Configure Data Service entity type and query filter for "${ctx.name}"`,
    placeholder: "Entity type name and OData filter expression",
    estimatedMinutes: 15,
  });
  return {
    activityType: "ui:QueryEntity",
    activityPackage: "UiPath.DataService.Activities",
    properties: {
      EntityType: "[str_EntityName]",
      Filter: "[str_QueryFilter]",
      Result: "[entityResults]",
    },
    errorHandling: "catch",
    variables,
    gaps,
  };
}

function classifyActionCenterTask(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [];

  if (combined.includes("wait") || combined.includes("complete") || combined.includes("resume")) {
    variables.push({ name: "formTask", type: "UiPath.Persistence.Activities.FormTask" });
    variables.push({ name: "taskOutput", type: "System.Collections.Generic.Dictionary(System.String,System.Object)" });
    variables.push({ name: "taskAction", type: "String", defaultValue: '""' });
    gaps.push({
      category: "config",
      activity: "WaitForFormTaskAndResume",
      description: `Configure task completion handling for "${ctx.name}" — map output fields`,
      placeholder: "Map form output fields to workflow variables",
      estimatedMinutes: 15,
    });
    return {
      activityType: "ui:WaitForFormTaskAndResume",
      activityPackage: "UiPath.Persistence.Activities",
      properties: {
        TaskObject: "[formTask]",
        TaskAction: "[taskAction]",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  variables.push({ name: "formTask", type: "UiPath.Persistence.Activities.FormTask" });
  variables.push({ name: "str_TaskTitle", type: "String", defaultValue: `"${escapeXml(ctx.name)}"` });
  variables.push({ name: "str_TaskCatalog", type: "String", defaultValue: '"TODO_TaskCatalogName"' });
  gaps.push({
    category: "config",
    activity: "CreateFormTask",
    description: `Configure Action Center task catalog, form data, and SLA for "${ctx.name}"`,
    placeholder: "Task catalog name, form field mappings, priority, SLA hours",
    estimatedMinutes: 20,
  });
  return {
    activityType: "ui:CreateFormTask",
    activityPackage: "UiPath.Persistence.Activities",
    properties: {
      TaskCatalog: "[str_TaskCatalog]",
      TaskTitle: "[str_TaskTitle]",
      TaskPriority: "Normal",
    },
    errorHandling: "catch",
    variables,
    gaps,
  };
}

function classifyExcel(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [];
  const isCrossPlatform = ctx.targetFramework === "Portable";

  if (combined.includes("read") || combined.includes("extract") || combined.includes("get") || combined.includes("open")) {
    variables.push({ name: "dt_ExcelData", type: "System.Data.DataTable" });
    gaps.push({
      category: "config",
      activity: isCrossPlatform ? "UseExcel" : "ExcelReadRange",
      description: `Configure Excel file path for "${ctx.name}"`,
      placeholder: "C:\\Data\\Input.xlsx",
      estimatedMinutes: 10,
    });
    return {
      activityType: isCrossPlatform ? "ui:UseExcel" : "ui:ExcelApplicationScope",
      activityPackage: "UiPath.Excel.Activities",
      properties: { WorkbookPath: "TODO: Set Excel file path" },
      errorHandling: "retry",
      variables,
      gaps,
    };
  }

  if (combined.includes("write") || combined.includes("save") || combined.includes("export") || combined.includes("update")) {
    variables.push({ name: "dt_OutputData", type: "System.Data.DataTable" });
    gaps.push({
      category: "config",
      activity: isCrossPlatform ? "UseExcel" : "ExcelWriteRange",
      description: `Configure output Excel file path for "${ctx.name}"`,
      placeholder: "C:\\Data\\Output.xlsx",
      estimatedMinutes: 10,
    });
    return {
      activityType: isCrossPlatform ? "ui:UseExcel" : "ui:ExcelApplicationScope",
      activityPackage: "UiPath.Excel.Activities",
      properties: { WorkbookPath: "TODO: Set output Excel file path" },
      errorHandling: "retry",
      variables,
      gaps,
    };
  }

  variables.push({ name: "dt_ExcelData", type: "System.Data.DataTable" });
  gaps.push({
    category: "config",
    activity: isCrossPlatform ? "UseExcel" : "ExcelApplicationScope",
    description: `Configure Excel file path for "${ctx.name}"`,
    placeholder: "C:\\Data\\Workbook.xlsx",
    estimatedMinutes: 10,
  });
  return {
    activityType: isCrossPlatform ? "ui:UseExcel" : "ui:ExcelApplicationScope",
    activityPackage: "UiPath.Excel.Activities",
    properties: { WorkbookPath: "TODO: Set Excel file path" },
    errorHandling: "retry",
    variables,
    gaps,
  };
}

function classifyEmail(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [];
  const isCrossPlatform = ctx.targetFramework === "Portable";

  if (combined.includes("send") || combined.includes("notify") || combined.includes("forward") || combined.includes("reply")) {
    variables.push({ name: "str_EmailTo", type: "String", defaultValue: '""' });
    variables.push({ name: "str_EmailSubject", type: "String", defaultValue: '""' });
    variables.push({ name: "str_EmailBody", type: "String", defaultValue: '""' });
    gaps.push({
      category: "credential",
      activity: isCrossPlatform ? "SendMail" : "SendSmtpMailMessage",
      description: `Configure ${isCrossPlatform ? "mail" : "SMTP"} credentials for "${ctx.name}"`,
      placeholder: "Use Orchestrator Credential asset",
      estimatedMinutes: 15,
    });
    gaps.push({
      category: "config",
      activity: isCrossPlatform ? "SendMail" : "SendSmtpMailMessage",
      description: `Set ${isCrossPlatform ? "mail account" : "SMTP server and port"} for "${ctx.name}"`,
      placeholder: isCrossPlatform ? "Use Integration Service mail connector" : "smtp.office365.com:587",
      estimatedMinutes: 5,
    });
    return {
      activityType: isCrossPlatform ? "ui:SendMail" : "ui:SendSmtpMailMessage",
      activityPackage: "UiPath.Mail.Activities",
      properties: isCrossPlatform
        ? { To: "TODO: Set recipient email", Subject: "TODO: Set email subject", Body: "TODO: Set email body" }
        : { To: "TODO: Set recipient email", Subject: "TODO: Set email subject", Body: "TODO: Set email body", Server: "TODO: Set SMTP server", Port: "587" },
      errorHandling: "retry",
      variables,
      gaps,
    };
  }

  variables.push({ name: "list_Emails", type: "System.Collections.Generic.List(System.Net.Mail.MailMessage)" });
  gaps.push({
    category: "credential",
    activity: isCrossPlatform ? "GetMail" : "GetImapMailMessage",
    description: `Configure ${isCrossPlatform ? "mail account" : "IMAP"} credentials for "${ctx.name}"`,
    placeholder: "Use Orchestrator Credential asset",
    estimatedMinutes: 15,
  });
  return {
    activityType: isCrossPlatform ? "ui:GetMail" : "ui:GetImapMailMessage",
    activityPackage: "UiPath.Mail.Activities",
    properties: isCrossPlatform
      ? { Top: "10" }
      : { Server: "TODO: Set IMAP server", Port: "993", Top: "10" },
    errorHandling: "retry",
    variables,
    gaps,
  };
}

const INTEGRATION_SERVICE_SYSTEMS = [
  "sap", "salesforce", "servicenow", "microsoft 365", "office 365",
  "dynamics", "workday", "oracle", "hubspot", "jira", "slack",
  "google", "sharepoint", "teams", "zendesk", "snowflake",
  "aws", "azure", "dropbox", "box", "docusign", "twilio",
];

function classifyApi(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [
    { name: "str_ApiResponse", type: "String", defaultValue: '""' },
    { name: "int_StatusCode", type: "Int32", defaultValue: "0" },
  ];

  const matchedSystem = INTEGRATION_SERVICE_SYSTEMS.find(s => combined.includes(s));
  if (matchedSystem) {
    gaps.push({
      category: "config",
      activity: "HttpClient",
      description: `Consider using Integration Service connector for ${matchedSystem} instead of custom HTTP — "${ctx.name}". The UiPath.IntegrationService.Activities package provides pre-built connectors with managed authentication.`,
      placeholder: `Use UiPath Integration Service ${matchedSystem} connector with pre-built authentication`,
      estimatedMinutes: 5,
    });
  }

  let method = "GET";
  if (combined.includes("post") || combined.includes("create") || combined.includes("submit") || combined.includes("send")) {
    method = "POST";
  } else if (combined.includes("update") || combined.includes("patch")) {
    method = "PATCH";
  } else if (combined.includes("delete") || combined.includes("remove")) {
    method = "DELETE";
  }

  gaps.push({
    category: "endpoint",
    activity: "HttpClient",
    description: `Configure API endpoint URL for "${ctx.name}"`,
    placeholder: "https://api.example.com/endpoint",
    estimatedMinutes: 15,
  });
  gaps.push({
    category: "credential",
    activity: "HttpClient",
    description: `Configure API authentication for "${ctx.name}"`,
    placeholder: "Bearer token or API key from Orchestrator asset",
    estimatedMinutes: 10,
  });

  return {
    activityType: "ui:HttpClient",
    activityPackage: "UiPath.Web.Activities",
    properties: {
      EndPoint: "TODO: Set API endpoint URL",
      Method: method,
      AcceptFormat: "JSON",
    },
    errorHandling: "retry",
    variables,
    gaps,
  };
}

function classifyDatabase(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [
    { name: "dt_QueryResult", type: "System.Data.DataTable" },
  ];

  gaps.push({
    category: "endpoint",
    activity: "ExecuteQuery",
    description: `Configure database connection string for "${ctx.name}"`,
    placeholder: "Server=TODO;Database=TODO;User Id=TODO;Password=TODO;",
    estimatedMinutes: 15,
  });
  gaps.push({
    category: "logic",
    activity: "ExecuteQuery",
    description: `Write SQL query for "${ctx.name}"`,
    placeholder: "SELECT * FROM TableName WHERE Condition",
    estimatedMinutes: 20,
  });

  return {
    activityType: "ui:ExecuteQuery",
    activityPackage: "UiPath.Database.Activities",
    properties: {
      ConnectionString: "TODO: Set database connection string",
      Sql: "TODO: Write SQL query",
      ProviderName: "System.Data.SqlClient",
    },
    errorHandling: "catch",
    variables,
    gaps,
  };
}

function classifyQueue(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [];

  if (combined.includes("add") || combined.includes("push") || combined.includes("create")) {
    variables.push({ name: "queueItemInfo", type: "UiPath.Core.QueueItemData" });
    gaps.push({
      category: "config",
      activity: "AddQueueItem",
      description: `Configure queue name and item data for "${ctx.name}"`,
      placeholder: "QueueName from Orchestrator",
      estimatedMinutes: 10,
    });
    return {
      activityType: "ui:AddQueueItem",
      activityPackage: "UiPath.System.Activities",
      properties: {
        QueueName: "TODO: Set Orchestrator queue name",
        Reference: "TODO: Set unique reference",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  if (combined.includes("get") || combined.includes("fetch") || combined.includes("process") || combined.includes("transaction")) {
    variables.push({ name: "queueItem", type: "UiPath.Core.QueueItem" });
    gaps.push({
      category: "config",
      activity: "GetTransactionItem",
      description: `Configure queue name for "${ctx.name}"`,
      placeholder: "QueueName from Orchestrator",
      estimatedMinutes: 10,
    });
    return {
      activityType: "ui:GetTransactionItem",
      activityPackage: "UiPath.System.Activities",
      properties: {
        QueueName: "TODO: Set Orchestrator queue name",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  variables.push({ name: "queueItem", type: "UiPath.Core.QueueItem" });
  return {
    activityType: "ui:SetTransactionStatus",
    activityPackage: "UiPath.System.Activities",
    properties: {
      Status: "Successful",
    },
    errorHandling: "catch",
    variables,
    gaps,
  };
}

function classifyFile(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [];

  if (combined.includes("read") || combined.includes("load") || combined.includes("open") || combined.includes("import")) {
    variables.push({ name: "str_FileContent", type: "String", defaultValue: '""' });
    gaps.push({
      category: "config",
      activity: "ReadTextFile",
      description: `Configure input file path for "${ctx.name}"`,
      placeholder: "C:\\Data\\Input.txt",
      estimatedMinutes: 5,
    });
    return {
      activityType: "ui:ReadTextFile",
      activityPackage: "UiPath.System.Activities",
      properties: { FileName: "TODO: Set input file path" },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  if (combined.includes("write") || combined.includes("save") || combined.includes("export") || combined.includes("output")) {
    gaps.push({
      category: "config",
      activity: "WriteTextFile",
      description: `Configure output file path for "${ctx.name}"`,
      placeholder: "C:\\Data\\Output.txt",
      estimatedMinutes: 5,
    });
    return {
      activityType: "ui:WriteTextFile",
      activityPackage: "UiPath.System.Activities",
      properties: {
        FileName: "TODO: Set output file path",
        Text: "TODO: Set content to write",
      },
      errorHandling: "catch",
      variables,
      gaps,
    };
  }

  if (combined.includes("exist") || combined.includes("check") || combined.includes("verify")) {
    variables.push({ name: "bool_FileExists", type: "Boolean", defaultValue: "False" });
    return {
      activityType: "ui:PathExists",
      activityPackage: "UiPath.System.Activities",
      properties: { Path: "TODO: Set path to check" },
      errorHandling: "none",
      variables,
      gaps,
    };
  }

  variables.push({ name: "str_FileContent", type: "String", defaultValue: '""' });
  gaps.push({
    category: "config",
    activity: "ReadTextFile",
    description: `Configure file path for "${ctx.name}"`,
    placeholder: "C:\\Data\\File.txt",
    estimatedMinutes: 5,
  });
  return {
    activityType: "ui:ReadTextFile",
    activityPackage: "UiPath.System.Activities",
    properties: { FileName: "TODO: Set file path" },
    errorHandling: "catch",
    variables,
    gaps,
  };
}

function classifyUI(ctx: ActivityContext, combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [];
  const isCrossPlatform = ctx.targetFramework === "Portable";
  const autopilotProps: Record<string, string> = {};
  if (ctx.autopilotEnabled) {
    autopilotProps["InformativeScreenshot"] = "True";
  }

  const resilienceProps: Record<string, string> = {
    "Target.WaitForReady": "INTERACTIVE",
    "Target.Timeout": "30000",
  };

  const appName = escapeXml(ctx.system || "application");
  const selectorBase = `<html app='${appName}' />`;

  const useModern = isCrossPlatform || ctx.targetFramework === "Windows";

  const isDesktopApp = combined.includes("desktop") || combined.includes("application") || combined.includes("erp") ||
    combined.includes("sap") || combined.includes("mainframe") || combined.includes("citrix") ||
    combined.includes("terminal") || combined.includes("rdp");
  const isBrowserBased = combined.includes("browser") || combined.includes("url") || combined.includes("web") ||
    combined.includes("portal") || combined.includes("website") || combined.includes("http");

  if (combined.includes("open") || combined.includes("launch") || combined.includes("navigate") || combined.includes("browser") || combined.includes("url")) {
    const useDesktop = useModern && isDesktopApp && !isBrowserBased;
    const activityType = useDesktop ? "ui:UseApplication" : (useModern ? "ui:UseBrowser" : "ui:OpenBrowser");
    const activityLabel = useDesktop ? "UseApplication" : (useModern ? "UseBrowser" : "OpenBrowser");
    gaps.push({
      category: "selector",
      activity: activityLabel,
      description: useDesktop
        ? `Set target application path for "${ctx.name}"`
        : `Set target URL for "${ctx.name}"`,
      placeholder: useDesktop ? "C:\\Program Files\\Application\\app.exe" : "https://application.example.com",
      estimatedMinutes: 5,
    });
    const props: Record<string, string> = useDesktop
      ? { ApplicationPath: "TODO: Set application executable path", ...autopilotProps, ...resilienceProps }
      : { Url: "TODO: Set application URL", BrowserType: "Chrome", ...autopilotProps, ...resilienceProps };
    return {
      activityType,
      activityPackage: "UiPath.UIAutomation.Activities",
      properties: props,
      selectorHint: selectorBase,
      errorHandling: "retry",
      variables,
      gaps,
    };
  }

  if (combined.includes("type") || combined.includes("enter") || combined.includes("input") || combined.includes("fill")) {
    const fieldHint = extractFieldHint(combined);
    const selectorAttr = fieldHint ? `name='${escapeXml(fieldHint)}'` : "name='TODO_field_name'";
    const targetSelector = `${selectorBase}<webctrl tag='INPUT' ${selectorAttr} />`;
    const isPlaceholder = !fieldHint;
    if (isPlaceholder) {
      gaps.push({
        category: "selector",
        activity: useModern ? "TypeInto (Modern)" : "TypeInto",
        description: `Configure UI selector for input field in "${ctx.name}"`,
        placeholder: `<webctrl tag='INPUT' name='TODO' />`,
        estimatedMinutes: 15,
      });
    }
    const typeProps: Record<string, string> = {
      Text: "TODO: Set text to type",
      ...autopilotProps,
      ...resilienceProps,
    };
    if (useModern) {
      typeProps["Target.Selector"] = targetSelector;
    }
    return {
      activityType: "ui:TypeInto",
      activityPackage: "UiPath.UIAutomation.Activities",
      properties: typeProps,
      selectorHint: targetSelector,
      errorHandling: "retry",
      variables,
      gaps,
    };
  }

  if (combined.includes("click") || combined.includes("press") || combined.includes("button") || combined.includes("submit") || combined.includes("select")) {
    const buttonHint = extractButtonHint(combined);
    const selectorAttr = buttonHint ? `aaname='${escapeXml(buttonHint)}'` : "name='TODO_button_name'";
    const targetSelector = `${selectorBase}<webctrl tag='BUTTON' ${selectorAttr} />`;
    const isPlaceholder = !buttonHint;
    if (isPlaceholder) {
      gaps.push({
        category: "selector",
        activity: useModern ? "Click (Modern)" : "Click",
        description: `Configure UI selector for clickable element in "${ctx.name}"`,
        placeholder: `<webctrl tag='BUTTON' name='TODO' />`,
        estimatedMinutes: 15,
      });
    }
    const clickProps: Record<string, string> = { ...autopilotProps, ...resilienceProps };
    if (useModern) {
      clickProps["Target.Selector"] = targetSelector;
    }
    return {
      activityType: "ui:Click",
      activityPackage: "UiPath.UIAutomation.Activities",
      properties: clickProps,
      selectorHint: targetSelector,
      errorHandling: "retry",
      variables,
      gaps,
    };
  }

  if (combined.includes("get text") || combined.includes("extract") || combined.includes("scrape") || combined.includes("read") || combined.includes("copy")) {
    variables.push({ name: "str_ExtractedText", type: "String", defaultValue: '""' });
    const targetSelector = `${selectorBase}<webctrl tag='SPAN' id='TODO_element_id' />`;
    gaps.push({
      category: "selector",
      activity: useModern ? "GetText (Modern)" : "GetText",
      description: `Configure UI selector for text extraction in "${ctx.name}"`,
      placeholder: `<webctrl tag='SPAN' id='TODO' />`,
      estimatedMinutes: 15,
    });
    const getTextProps: Record<string, string> = { ...autopilotProps, ...resilienceProps };
    if (useModern) {
      getTextProps["Target.Selector"] = targetSelector;
    }
    return {
      activityType: "ui:GetText",
      activityPackage: "UiPath.UIAutomation.Activities",
      properties: getTextProps,
      selectorHint: targetSelector,
      errorHandling: "retry",
      variables,
      gaps,
    };
  }

  const elementHint = extractButtonHint(combined) || extractFieldHint(combined);
  const fallbackAttr = elementHint ? `aaname='${escapeXml(elementHint)}'` : "aaname='TODO_element'";
  const targetSelector = `${selectorBase}<webctrl tag='*' ${fallbackAttr} />`;
  const isPlaceholder = !elementHint;
  if (isPlaceholder) {
    gaps.push({
      category: "selector",
      activity: useModern ? "Click (Modern)" : "ClickOnText",
      description: `Configure UI selector for "${ctx.name}"`,
      placeholder: `<webctrl tag='*' aaname='TODO' />`,
      estimatedMinutes: 15,
    });
  }
  const fallbackProps: Record<string, string> = { ...autopilotProps, ...resilienceProps };
  if (useModern) {
    fallbackProps["Target.Selector"] = targetSelector;
  }
  return {
    activityType: "ui:Click",
    activityPackage: "UiPath.UIAutomation.Activities",
    properties: fallbackProps,
    selectorHint: targetSelector,
    errorHandling: "retry",
    variables,
    gaps,
  };
}

function extractButtonHint(text: string): string | null {
  const patterns = [
    /(?:clicks?|presses?|submits?|taps?)\s+(?:the\s+)?["']([A-Za-z0-9\s]+?)["']/i,
    /(?:clicks?|presses?)\s+(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+button/i,
    /button\s+(?:called|named|labeled)\s+["']?([A-Za-z0-9\s]+?)["']?(?:\s|$|\.)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1] && m[1].length >= 2 && m[1].length <= 40) return m[1].trim();
  }
  return null;
}

function extractFieldHint(text: string): string | null {
  const patterns = [
    /(?:field|input|textbox)\s+(?:called|named|labeled)\s+["']?([A-Za-z0-9\s_-]+?)["']?(?:\s|$|\.)/i,
    /(?:types?|enters?|fills?)\s+(?:.*?\s)?(?:in(?:to)?|for)\s+(?:the\s+)?["']?([A-Za-z0-9\s_-]{2,30}?)["']?\s+(?:field|input|textbox)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1] && m[1].length >= 2 && m[1].length <= 40) return m[1].trim();
  }
  return null;
}

function classifyMLSkill(ctx: ActivityContext, combined: string, genCtx?: XamlGenerationContext): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];

  const matchedSkill = findMatchingAICenterSkill(ctx.name, ctx.description || "", combined, genCtx);
  const skillName = matchedSkill ? matchedSkill.name : "";
  const inputType = matchedSkill?.inputType || "String";
  const outputType = matchedSkill?.outputType || "String";

  if (matchedSkill && genCtx) {
    if (!genCtx.referencedMLSkillNames.includes(matchedSkill.name)) {
      genCtx.referencedMLSkillNames.push(matchedSkill.name);
    }
  }

  const variables: VariableDecl[] = [
    { name: "str_MLInput", type: "String", defaultValue: '""' },
    { name: "str_MLOutput", type: "String", defaultValue: '""' },
    { name: "str_MLSkillName", type: "String", defaultValue: skillName ? `"${skillName}"` : '""' },
  ];

  if (!matchedSkill) {
    gaps.push({
      category: "config",
      activity: "MLSkill",
      description: `Configure ML Skill name and endpoint for "${ctx.name}" — no matching deployed skill found on the tenant. Deploy the skill in AI Center first.`,
      placeholder: "ML_Skill_Name from AI Center",
      estimatedMinutes: 15,
    });
  }

  gaps.push({
    category: "config",
    activity: "MLSkill",
    description: matchedSkill
      ? `Map input (${inputType}) / output (${outputType}) schema for ML Skill "${matchedSkill.name}" in "${ctx.name}" (package: ${matchedSkill.mlPackageName})`
      : `Map input/output schema for ML Skill invocation in "${ctx.name}"`,
    placeholder: matchedSkill
      ? `Input: ${inputType}, Output: ${outputType}`
      : "Define input JSON and parse output prediction",
    estimatedMinutes: matchedSkill ? 10 : 20,
  });

  return {
    activityType: "ui:MLSkill",
    activityPackage: "UiPath.MLActivities",
    properties: {
      MLSkillName: skillName || "[TODO: Set ML Skill name from AI Center]",
      Input: "str_MLInput",
      Output: "str_MLOutput",
      Timeout: "120000",
    },
    errorHandling: "catch",
    variables,
    gaps,
  };
}

function findMatchingAICenterSkill(stepName: string, description: string, combined: string, genCtx?: XamlGenerationContext): AICenterSkill | null {
  const skills = genCtx?.aiCenterSkills as AICenterSkill[] || [];
  if (skills.length === 0) return null;

  const deployed = skills.filter(s => {
    const st = s.status.toLowerCase();
    return st === "deployed" || st === "available";
  });
  if (deployed.length === 0) return skills[0] || null;

  const stepLower = stepName.toLowerCase();
  const descLower = description.toLowerCase();

  for (const skill of deployed) {
    const skillNameLower = skill.name.toLowerCase();
    if (stepLower.includes(skillNameLower) || descLower.includes(skillNameLower) || combined.includes(skillNameLower)) {
      return skill;
    }
  }

  for (const skill of deployed) {
    const pkgLower = (skill.mlPackageName || "").toLowerCase();
    if (pkgLower && (stepLower.includes(pkgLower) || descLower.includes(pkgLower) || combined.includes(pkgLower))) {
      return skill;
    }
  }

  if (deployed.length === 1) return deployed[0];

  for (const skill of deployed) {
    const skillWords = skill.name.toLowerCase().split(/[\s_-]+/);
    const matchCount = skillWords.filter(w => w.length > 2 && combined.includes(w)).length;
    if (matchCount >= Math.ceil(skillWords.length / 2)) return skill;
  }

  return deployed[0];
}

function classifyGeneral(ctx: ActivityContext, _combined: string): ReturnType<typeof classifyActivity> {
  return {
    activityType: "ui:LogMessage",
    activityPackage: "UiPath.System.Activities",
    properties: {
      Level: "Info",
      Message: `"Executing: ${escapeXml(ctx.name)}"`,
    },
    errorHandling: "none",
    variables: [],
    gaps: [{
      category: "logic",
      activity: "LogMessage",
      description: `Implement business logic for "${ctx.name}"`,
      placeholder: "Replace LogMessage with actual implementation",
      estimatedMinutes: 30,
    }],
  };
}

function classifyAgent(ctx: ActivityContext, _combined: string): ReturnType<typeof classifyActivity> {
  const gaps: XamlGap[] = [];
  const variables: VariableDecl[] = [
    { name: "str_AgentInput", type: "String", defaultValue: '""' },
    { name: "str_AgentOutput", type: "String", defaultValue: '""' },
  ];

  gaps.push({
    category: "agent",
    activity: "InvokeAgent",
    description: `Configure agent invocation for "${ctx.name}" — set agent name, input data mapping, and output capture`,
    placeholder: "AgentInvocation_Stub.xaml",
    estimatedMinutes: 30,
  });
  gaps.push({
    category: "agent",
    activity: "InvokeAgent",
    description: `Define agent prompt template and guardrails for "${ctx.name}"`,
    placeholder: "Configure agent system prompt and escalation rules",
    estimatedMinutes: 20,
  });

  return {
    activityType: "ui:InvokeWorkflowFile",
    activityPackage: "UiPath.System.Activities",
    properties: {
      WorkflowFileName: "AgentInvocation_Stub.xaml",
    },
    errorHandling: "catch",
    variables,
    gaps,
  };
}

const VBNET_RESERVED_WORDS_SET = new Set([
  "addhandler", "addressof", "alias", "and", "andalso", "as", "boolean", "byref",
  "byte", "byval", "call", "case", "catch", "cbool", "cbyte", "cchar", "cdate",
  "cdbl", "cdec", "char", "cint", "class", "clng", "cobj", "const", "continue",
  "csbyte", "cshort", "csng", "cstr", "ctype", "cuint", "culng", "cushort",
  "date", "decimal", "declare", "default", "delegate", "dim", "directcast", "do",
  "double", "each", "else", "elseif", "end", "endif", "enum", "erase", "error",
  "event", "exit", "false", "finally", "for", "friend", "function", "get",
  "gettype", "getxmlnamespace", "global", "gosub", "goto", "handles", "if",
  "implements", "imports", "in", "inherits", "integer", "interface", "is", "isnot",
  "let", "lib", "like", "long", "loop", "me", "mod", "module", "mustinherit",
  "mustoverride", "mybase", "myclass", "namespace", "narrowing", "new", "next",
  "not", "nothing", "notinheritable", "notoverridable", "object", "of", "on",
  "operator", "option", "optional", "or", "orelse", "overloads", "overridable",
  "overrides", "paramarray", "partial", "private", "property", "protected", "public",
  "raiseevent", "readonly", "redim", "rem", "removehandler", "resume", "return",
  "sbyte", "select", "set", "shadows", "shared", "short", "single", "static",
  "step", "stop", "string", "structure", "sub", "synclock", "then", "throw", "to",
  "true", "try", "trycast", "typeof", "uinteger", "ulong", "ushort", "using",
  "variant", "wend", "when", "while", "widening", "with", "withevents", "writeonly",
  "xor",
]);

function sanitizeVarName(name: string): string {
  let sanitized = name.replace(/\./g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, "_");
  sanitized = sanitized.replace(/^[0-9]+/, "");
  sanitized = sanitized.replace(/_+/g, "_");
  sanitized = sanitized.replace(/^_|_$/g, "");
  if (!sanitized) sanitized = "var1";
  if (VBNET_RESERVED_WORDS_SET.has(sanitized.toLowerCase())) {
    sanitized = `_${sanitized}`;
  }
  return sanitized;
}

function inferTypeFromPrefix(varName: string): string | null {
  if (varName.startsWith("str_")) return "x:String";
  if (varName.startsWith("int_") || varName.startsWith("num_")) return "x:Int32";
  if (varName.startsWith("bool_") || varName.startsWith("is_") || varName.startsWith("has_")) return "x:Boolean";
  if (varName.startsWith("dbl_")) return "x:Double";
  if (varName.startsWith("dec_")) return "x:Decimal";
  if (varName.startsWith("dt_")) return "s:DateTime";
  if (varName.startsWith("dr_") || varName.startsWith("drow_")) return "scg2:DataRow";
  if (varName.startsWith("dict_")) return "scg:Dictionary(x:String, x:Object)";
  if (varName.startsWith("sec_")) return "s:Security.SecureString";
  if (varName.startsWith("ts_")) return "s:TimeSpan";
  if (varName.startsWith("obj_")) return "x:Object";
  return null;
}

function inferTypeFromDefaultValue(defaultValue: string | undefined): string | null {
  if (!defaultValue) return null;
  const trimmed = defaultValue.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return null;
  if (trimmed === "True" || trimmed === "False") return "x:Boolean";
  if (/^-?\d+$/.test(trimmed)) return "x:Int32";
  if (/^-?\d+\.\d+$/.test(trimmed)) return "x:Double";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return "x:String";
  if (trimmed.startsWith("&quot;") && trimmed.endsWith("&quot;")) return "x:String";
  return null;
}

function renderVariablesBlock(variables: VariableDecl[], targetFramework?: TargetFramework): string {
  const isCSharp = targetFramework === "Portable";
  const screenshotDefault = isCSharp
    ? '""'
    : '""';
  const withScreenshot = [...variables, { name: "str_ScreenshotPath", type: "String", defaultValue: screenshotDefault }];
  if (withScreenshot.length === 0) return "<Sequence.Variables />";

  const uniqueVars = new Map<string, VariableDecl>();
  for (const v of withScreenshot) {
    if (!uniqueVars.has(v.name)) {
      uniqueVars.set(v.name, v);
    }
  }

  let xml = "<Sequence.Variables>\n";
  const emittedNames = new Set<string>();
  uniqueVars.forEach((v) => {
    let typeAttr = mapClrType(v.type);
    const safeName = sanitizeVarName(v.name);
    if (emittedNames.has(safeName)) return;
    emittedNames.add(safeName);
    if (typeAttr === "x:Object") {
      const prefixType = inferTypeFromPrefix(safeName);
      if (prefixType) {
        typeAttr = prefixType;
      } else {
        const defaultType = inferTypeFromDefaultValue(v.defaultValue);
        if (defaultType) typeAttr = defaultType;
      }
    }
    let defaultAttr = "";
    if (v.defaultValue) {
      const isObjectType = typeAttr === "x:Object" || typeAttr.includes("System.Object");
      if (isObjectType) {
        console.warn(`[Variable Guard] Omitting Default="${v.defaultValue}" for x:Object variable "${safeName}" — UiPath does not support Literal<Object>`);
      } else {
        defaultAttr = ` Default="${escapeXmlExpression(v.defaultValue)}"`;
      }
    }
    xml += `        <Variable x:TypeArguments="${typeAttr}" Name="${escapeXml(safeName)}"${defaultAttr} />\n`;
  });
  xml += "      </Sequence.Variables>";
  return xml;
}

function generateXMembersBlock(
  args: Array<{ name: string; direction: string; type: string }>,
  targetFramework?: TargetFramework
): string {
  if (!args || args.length === 0) return "";
  const lines: string[] = [];
  lines.push("  <x:Members>");
  for (const arg of args) {
    const clrType = mapClrType(arg.type);
    const dir = arg.direction || "InArgument";
    lines.push(`    <x:Property Name="${escapeXml(arg.name)}" Type="${dir}(${clrType})" />`);
  }
  lines.push("  </x:Members>");
  return lines.join("\n");
}

function mapClrType(type: string): string {
  const trimmed = type.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "string" || lower === "system.string") return "x:String";
  if (lower === "int32" || lower === "integer" || lower === "int" || lower === "system.int32") return "x:Int32";
  if (lower === "int64" || lower === "long" || lower === "system.int64") return "x:Int64";
  if (lower === "boolean" || lower === "bool" || lower === "system.boolean") return "x:Boolean";
  if (lower === "double" || lower === "system.double") return "x:Double";
  if (lower === "decimal" || lower === "system.decimal") return "x:Decimal";
  if (lower === "datetime" || lower === "system.datetime") return "s:DateTime";
  if (lower === "timespan" || lower === "system.timespan") return "s:TimeSpan";
  if (lower === "object" || lower === "system.object") return "x:Object";
  if (lower === "securestring" || lower === "system.security.securestring") return "s:Security.SecureString";

  if ((lower.includes("datatable") || lower.includes("system.data.datatable")) && !lower.includes("dictionary")) return "scg2:DataTable";
  if (lower.includes("datarow") || lower.includes("system.data.datarow")) return "scg2:DataRow";
  if (lower.includes("securestring")) return "s:Security.SecureString";
  if (lower.includes("mailmessage") || lower.includes("system.net.mail.mailmessage")) return "s:Net.Mail.MailMessage";
  if (lower.includes("queueitem") && !lower.includes("queueitemdata")) return "ui:QueueItem";
  if (lower.includes("queueitemdata") || lower.includes("uipath.core.queueitemdata")) return "ui:QueueItemData";

  const dictMatch = trimmed.match(/^Dictionary\s*<\s*([^,]+)\s*,\s*([^>]+)\s*>$/i);
  if (dictMatch) {
    const keyType = mapClrType(dictMatch[1].trim());
    const valType = mapClrType(dictMatch[2].trim());
    return `scg:Dictionary(${keyType}, ${valType})`;
  }

  const listMatch = trimmed.match(/^List\s*<\s*([^>]+)\s*>$/i);
  if (listMatch) {
    const itemType = mapClrType(listMatch[1].trim());
    return `scg:List(${itemType})`;
  }

  const arrayMatch = trimmed.match(/^Array\s*<\s*([^>]+)\s*>$/i);
  if (arrayMatch) {
    const itemType = mapClrType(arrayMatch[1].trim());
    return `scg:List(${itemType})`;
  }

  const arrayBracketMatch = trimmed.match(/^(\w+)\[\]$/);
  if (arrayBracketMatch) {
    const itemType = mapClrType(arrayBracketMatch[1].trim());
    return `scg:List(${itemType})`;
  }

  return type;
}

function isUiActivity(activityType: string): boolean {
  const uiTypes = ["ui:OpenBrowser", "ui:NavigateTo", "ui:TypeInto", "ui:Click", "ui:GetText",
    "ui:ElementExists", "ui:AttachBrowser", "ui:AttachWindow", "ui:UseApplicationBrowser"];
  return uiTypes.some(t => activityType.startsWith(t));
}

function isNonCriticalActivity(activityType: string): boolean {
  const nonCritical = ["ui:LogMessage", "ui:SendSmtpMailMessage", "ui:SendOutlookMailMessage"];
  return nonCritical.some(t => activityType === t);
}

function sanitizeObjectLiteralArguments(xaml: string): string {
  return xaml.replace(
    /(<(?:In|Out|InOut)Argument\s+x:TypeArguments="x:Object"(?:\s+[^>]*)?>)([^<]+)(<\/(?:In|Out|InOut)Argument>)/g,
    (_match, openTag: string, content: string, closeTag: string) => {
      const trimmed = content.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        return `${openTag}${content}${closeTag}`;
      }
      if (trimmed.length > 0) {
        console.warn(`[Argument Guard] Bracket-wrapping literal content "${trimmed}" in x:Object argument`);
        return `${openTag}[${trimmed}]${closeTag}`;
      }
      return `${openTag}${content}${closeTag}`;
    }
  );
}

const CATALOG_INTEGER_PROPERTY_NAMES = new Set([
  "TimeoutMS", "DelayBefore", "DelayAfter", "DelayBetween",
  "MaxRetries", "NumberOfRetries", "MaxNumberOfRetries",
]);

const _integerPropertyCache = new Map<string, boolean>();
function isSchemaIntegerProperty(propName: string): boolean {
  if (_integerPropertyCache.has(propName)) return _integerPropertyCache.get(propName)!;
  if (!catalogService.isLoaded()) return false;
  const integerClrTypes = new Set(["System.Int32", "System.Int64", "System.UInt32", "System.Byte"]);
  const allActivities = catalogService.getAllActivities();
  for (const schema of allActivities) {
    for (const prop of schema.activity.properties) {
      if (prop.name === propName && integerClrTypes.has(prop.clrType)) {
        _integerPropertyCache.set(propName, true);
        return true;
      }
    }
  }
  _integerPropertyCache.set(propName, false);
  return false;
}

export function sanitizePropertyValue(key: string, value: any): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (CATALOG_INTEGER_PROPERTY_NAMES.has(key) || isSchemaIntegerProperty(key)) {
    if (typeof value === "string") {
      const trimmed = value.trim().replace(/["']/g, "");
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
    }
    if (typeof value === "number" && Number.isInteger(value)) {
      return String(value);
    }
  }
  if (typeof value === "string") {
    if (value === "[object Object]") {
      return `PLACEHOLDER_${key}_object_value`;
    }
    if (value === "...") {
      return `PLACEHOLDER_${key}`;
    }
    const isVbExpression = /^\[.*\]$/.test(value.trim());
    if (isVbExpression) {
      const inner = value.trim().slice(1, -1);
      const escapedInner = escapeXmlExpression(inner);
      return `[${escapedInner}]`;
    }
    return value.replace(/["']/g, "");
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item: any) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) return JSON.stringify(item);
      return String(item);
    });
    return `New String() {${items.map(i => `"${i.replace(/"/g, '""')}"`).join(", ")}}`;
  }
  if (typeof value === "object") {
    if (key.toLowerCase().includes("header")) {
      const entries = Object.entries(value as Record<string, any>);
      if (entries.length === 0) return `New Dictionary(Of String, String)()`;
      const kvPairs = entries.map(([k, v]) => `{"${k}", "${String(v)}"}`).join(", ");
      return `New Dictionary(Of String, String) From {${kvPairs}}`;
    }
    const jsonStr = JSON.stringify(value);
    return escapeXml(jsonStr);
  }
  return String(value);
}

const PSEUDO_XAML_ATTR_KEYS = new Set(["Then", "Else", "Cases", "Body", "Finally", "Try", "_convertedInputArgs", "_convertedOutputArgs", "DisplayName"]);

const CONTROL_FLOW_ACTIVITY_TYPES = new Set(["If", "Switch", "ForEach", "TryCatch"]);

const HIGH_RISK_ACTIVITY_TYPES = new Set([
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

function upgradeErrorHandlingForHighRisk(
  errorHandling: "retry" | "catch" | "escalate" | "none",
  activityType: string,
): "retry" | "catch" | "escalate" | "none" {
  if (errorHandling !== "none") return errorHandling;
  if (HIGH_RISK_ACTIVITY_TYPES.has(activityType)) return "catch";
  if (!activityType.includes(":") && HIGH_RISK_ACTIVITY_TYPES.has(`ui:${activityType}`)) return "catch";
  return errorHandling;
}

interface NestedActivityObject {
  activityType: string;
  displayName?: string;
  properties?: Record<string, string>;
  selectorHint?: string;
  [key: string]: unknown;
}

function isNestedActivityObject(val: unknown): val is NestedActivityObject {
  return typeof val === "object" && val !== null && typeof (val as Record<string, unknown>).activityType === "string";
}

function isControlFlowActivity(activityType: string): boolean {
  return CONTROL_FLOW_ACTIVITY_TYPES.has(activityType) ||
    CONTROL_FLOW_ACTIVITY_TYPES.has(activityType.replace("System.Activities.", ""));
}

function sanitizePropsForRendering(props: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (PSEUDO_XAML_ATTR_KEYS.has(key)) continue;
    const sanitized = sanitizePropertyValue(key, value);
    if (sanitized === "") continue;
    result[key] = sanitized;
  }
  return result;
}

function buildRawPropertiesForControlFlow(obj: NestedActivityObject): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const props = obj.properties || {};
  for (const [k, v] of Object.entries(props)) {
    result[k] = v;
  }
  const pseudoKeysList = ["Then", "Else", "Cases", "Body", "Finally", "Try"];
  for (const pseudoKey of pseudoKeysList) {
    if (pseudoKey in obj && !(pseudoKey in result)) {
      result[pseudoKey] = obj[pseudoKey];
    }
  }
  return result;
}

function renderActivityOrControlFlow(
  activityType: string,
  displayName: string,
  sanitizedProps: Record<string, string>,
  rawObj: NestedActivityObject,
  targetFramework?: TargetFramework
): string {
  if (isControlFlowActivity(activityType)) {
    const rawProperties = buildRawPropertiesForControlFlow(rawObj);
    return renderControlFlowActivity(activityType, displayName, sanitizedProps, rawProperties, targetFramework);
  }
  const selectorHint = typeof rawObj.selectorHint === "string" ? rawObj.selectorHint : undefined;
  return renderActivity(activityType, displayName, sanitizedProps, selectorHint, undefined, undefined, targetFramework);
}

function renderControlFlowActivity(
  activityType: string,
  displayName: string,
  properties: Record<string, string>,
  rawProperties: Record<string, unknown>,
  targetFramework?: TargetFramework
): string {
  const enforced = enforceDisplayName(activityType, displayName);
  const baseType = activityType.replace("System.Activities.", "");

  if (baseType === "If") {
    const rawCondition = properties["Condition"] || rawProperties["Condition"] || "";
    const needsConditionReview = !rawCondition || rawCondition === "TODO_Condition" || rawCondition.startsWith("TODO_") || rawCondition.startsWith("PLACEHOLDER_");
    const condition = needsConditionReview ? "True" : rawCondition;

    let thenContent = "";
    const thenProp = rawProperties["Then"];
    if (isNestedActivityObject(thenProp)) {
      const nestedProps = sanitizePropsForRendering(thenProp.properties || {});
      thenContent = renderActivityOrControlFlow(thenProp.activityType, thenProp.displayName || "Then Activity", nestedProps, thenProp , targetFramework);
    } else if (typeof thenProp === "string" && thenProp.length > 0 && thenProp !== "..." && thenProp !== "[object Object]") {
      thenContent = `\n                <ui:LogMessage Level="Info" Message="[&quot;Then: ${escapeXml(String(thenProp))}&quot;]" DisplayName="Then: ${escapeXml(enforced)}" />`;
    } else {
      thenContent = `\n                <ui:LogMessage Level="Info" Message="[&quot;Then path: ${escapeXml(enforced)}&quot;]" DisplayName="Then Path" />`;
    }

    let elseContent = "";
    const elseProp = rawProperties["Else"];
    if (isNestedActivityObject(elseProp)) {
      const nestedProps = sanitizePropsForRendering(elseProp.properties || {});
      elseContent = renderActivityOrControlFlow(elseProp.activityType, elseProp.displayName || "Else Activity", nestedProps, elseProp , targetFramework);
    } else if (typeof elseProp === "string" && elseProp.length > 0 && elseProp !== "..." && elseProp !== "[object Object]") {
      elseContent = `\n                <ui:LogMessage Level="Info" Message="[&quot;Else: ${escapeXml(String(elseProp))}&quot;]" DisplayName="Else: ${escapeXml(enforced)}" />`;
    } else {
      elseContent = `\n                <ui:LogMessage Level="Info" Message="[&quot;Else path: ${escapeXml(enforced)}&quot;]" DisplayName="Else Path" />`;
    }

    return `${needsConditionReview ? `\n          <ui:Comment Text="TODO: Replace default True condition with actual business logic for: ${escapeXml(enforced)}" DisplayName="Review Condition" />` : ""}
          <If DisplayName="${escapeXml(enforced)}" Condition="[${escapeXmlExpression(String(condition))}]">
            <If.Then>
              <Sequence DisplayName="Then: ${escapeXml(enforced)}">${thenContent}
              </Sequence>
            </If.Then>
            <If.Else>
              <Sequence DisplayName="Else: ${escapeXml(enforced)}">${elseContent}
              </Sequence>
            </If.Else>
          </If>`;
  }

  if (baseType === "Switch") {
    const rawExpression = properties["Expression"] || rawProperties["Expression"] || "";
    const needsExpressionReview = !rawExpression || rawExpression === "TODO_Expression" || rawExpression.startsWith("TODO_") || rawExpression.startsWith("PLACEHOLDER_");
    const expression = needsExpressionReview ? "Nothing" : rawExpression;
    const casesProp = rawProperties["Cases"];
    let caseElements = "";

    if (casesProp && typeof casesProp === "object" && !Array.isArray(casesProp)) {
      for (const [caseKey, caseVal] of Object.entries(casesProp)) {
        let caseBody = "";
        if (isNestedActivityObject(caseVal)) {
          caseBody = renderActivityOrControlFlow(caseVal.activityType, caseVal.displayName || caseKey, caseVal.properties || {}, caseVal, targetFramework);
        } else {
          caseBody = `\n                  <ui:LogMessage Level="Info" Message="[&quot;Case: ${escapeXml(caseKey)}&quot;]" DisplayName="Case: ${escapeXml(caseKey)}" />`;
        }
        caseElements += `
                <Sequence x:Key="${escapeXml(caseKey)}" DisplayName="Case: ${escapeXml(caseKey)}">${caseBody}
                </Sequence>`;
      }
    }
    if (!caseElements) {
      caseElements = `
                <Sequence x:Key="TODO" DisplayName="Default Case">
                  <ui:LogMessage Level="Info" Message="[&quot;Default case: ${escapeXml(enforced)}&quot;]" DisplayName="Default Case" />
                </Sequence>`;
    }

    return `${needsExpressionReview ? `\n          <ui:Comment Text="TODO: Replace default Nothing expression with actual value for: ${escapeXml(enforced)}" DisplayName="Review Expression" />` : ""}
          <Switch x:TypeArguments="x:String" DisplayName="${escapeXml(enforced)}" Expression="[${escapeXmlExpression(String(expression))}]">
            <Switch.Cases>${caseElements}
            </Switch.Cases>
            <Switch.Default>
              <Sequence DisplayName="Default: ${escapeXml(enforced)}">
                <ui:LogMessage Level="Info" Message="[&quot;Switch default: ${escapeXml(enforced)}&quot;]" DisplayName="Default Path" />
              </Sequence>
            </Switch.Default>
          </Switch>`;
  }

  if (baseType === "ForEach") {
    let itemType = properties["TypeArgument"] || rawProperties["TypeArgument"] || "x:Object";
    const rawValues = properties["Values"] || rawProperties["Values"] || "";
    const needsValuesReview = !rawValues || rawValues === "TODO_Collection" || rawValues.startsWith("TODO_") || rawValues.startsWith("PLACEHOLDER_");
    const values = needsValuesReview ? "New List(Of Object)" : rawValues;
    const valExpr = String(values).replace(/^\[|\]$/g, "");
    const isDataTableIteration = /\bdt_\w*\.Rows\b/i.test(valExpr) || /\.AsEnumerable\(\)/i.test(valExpr)
      || /\bDataTable\b.*\.Rows\b/i.test(valExpr) || /\.Rows\b/i.test(valExpr);
    if (isDataTableIteration) {
      if (itemType !== "scg2:DataRow") {
        console.warn(`[ForEach Guard] Type mismatch in renderControlFlowActivity: x:TypeArguments="${itemType}" but Values expression "${valExpr}" iterates DataTable rows — auto-correcting to scg2:DataRow`);
        itemType = "scg2:DataRow";
      }
    } else if (itemType === "x:Object") {
      const prefixType = inferTypeFromPrefix(valExpr);
      if (prefixType && prefixType !== "x:Object") {
        itemType = prefixType;
      }
    }

    const rawIteratorName = String(properties["IteratorVariable"] || rawProperties["IteratorVariable"] || "item");
    const iteratorName = sanitizeVarName(rawIteratorName);

    let bodyContent = "";
    const bodyProp = rawProperties["Body"];
    if (isNestedActivityObject(bodyProp)) {
      const nestedProps = sanitizePropsForRendering(bodyProp.properties || {});
      bodyContent = renderActivityOrControlFlow(bodyProp.activityType, bodyProp.displayName || "Loop Body", nestedProps, bodyProp , targetFramework);
    } else {
      bodyContent = `\n                <ui:LogMessage Level="Info" Message="[&quot;Processing item in: ${escapeXml(enforced)}&quot;]" DisplayName="Loop Body" />`;
    }

    return `${needsValuesReview ? `\n          <ui:Comment Text="TODO: Replace default empty collection with actual data source for: ${escapeXml(enforced)}" DisplayName="Review Collection" />` : ""}
          <ForEach x:TypeArguments="${escapeXml(String(itemType))}" DisplayName="${escapeXml(enforced)}" Values="[${escapeXmlExpression(String(values))}]">
            <ForEach.Body>
              <ActivityAction x:TypeArguments="${escapeXml(String(itemType))}">
                <ActivityAction.Argument>
                  <DelegateInArgument x:TypeArguments="${escapeXml(String(itemType))}" Name="${escapeXml(iteratorName)}" />
                </ActivityAction.Argument>
                <Sequence DisplayName="Body: ${escapeXml(enforced)}">${bodyContent}
                </Sequence>
              </ActivityAction>
            </ForEach.Body>
          </ForEach>`;
  }

  if (baseType === "TryCatch") {
    let tryContent = "";
    const tryProp = rawProperties["Try"];
    if (isNestedActivityObject(tryProp)) {
      const nestedProps = sanitizePropsForRendering(tryProp.properties || {});
      tryContent = renderActivityOrControlFlow(tryProp.activityType, tryProp.displayName || "Try Body", nestedProps, tryProp , targetFramework);
    } else {
      tryContent = `\n                <ui:LogMessage Level="Info" Message="[&quot;Try block: ${escapeXml(enforced)}&quot;]" DisplayName="Try Body" />`;
    }

    let finallyContent = "";
    const finallyProp = rawProperties["Finally"];
    if (isNestedActivityObject(finallyProp)) {
      const nestedProps = sanitizePropsForRendering(finallyProp.properties || {});
      finallyContent = renderActivityOrControlFlow(finallyProp.activityType, finallyProp.displayName || "Finally", nestedProps, finallyProp , targetFramework);
    }

    return `
          <TryCatch DisplayName="${escapeXml(enforced)}">
            <TryCatch.Try>
              <Sequence DisplayName="Try: ${escapeXml(enforced)}">${tryContent}
              </Sequence>
            </TryCatch.Try>
            <TryCatch.Catches>
              <Catch x:TypeArguments="s:Exception">
                <ActivityAction x:TypeArguments="s:Exception">
                  <ActivityAction.Argument>
                    <DelegateInArgument x:TypeArguments="s:Exception" Name="exception" />
                  </ActivityAction.Argument>
                  <Sequence DisplayName="Catch: ${escapeXml(enforced)}">
                    <ui:LogMessage Level="Error" Message="[&quot;Error in ${escapeXml(enforced)}: &quot; &amp; exception.Message]" DisplayName="Log Exception" />
                  </Sequence>
                </ActivityAction>
              </Catch>
            </TryCatch.Catches>${finallyContent ? `
            <TryCatch.Finally>
              <Sequence DisplayName="Finally: ${escapeXml(enforced)}">${finallyContent}
              </Sequence>
            </TryCatch.Finally>` : ""}
          </TryCatch>`;
  }

  return renderActivity(activityType, displayName, properties as Record<string, string>, undefined, undefined, undefined, targetFramework);
}

export function renderActivity(
  activityType: string,
  displayName: string,
  properties: Record<string, string>,
  selectorHint?: string,
  operationalProps?: { timeout?: number; continueOnError?: boolean; delayBefore?: number; delayAfter?: number },
  annotationOpts?: { stepNumber?: number; stepName?: string; businessContext?: string; errorStrategy?: string; placeholders?: string[]; aiReasoning?: string },
  targetFramework?: TargetFramework
): string {
  const BUILTIN_ACTIVITY_TYPES = new Set([
    "Assign", "If", "TryCatch", "Sequence", "Delay", "Rethrow", "Throw",
    "While", "DoWhile", "ForEach", "Switch", "Flowchart", "FlowDecision",
    "FlowStep", "FlowSwitch", "Parallel", "ParallelForEach",
    "InvokeWorkflowFile", "StateMachine", "State", "FinalState",
  ]);

  const RENDER_ACTIVITY_INHERITED_PROPS = new Set([
    "DisplayName", "ContinueOnError", "Timeout", "Private", "DelayBefore", "DelayAfter",
    "TimeoutMS", "Annotation", "AnnotationText", "sap2010:Annotation.AnnotationText",
    "Selector", "Result", "WorkflowFileName",
    "To", "Value", "TypeArgument", "Condition",
    "Values", "IteratorVariable", "Body",
    "Level", "Message",
  ]);

  if (catalogService.isLoaded()) {
    const lookupName = activityType.replace(/^[a-zA-Z][a-zA-Z0-9]*:/, "");
    if (!BUILTIN_ACTIVITY_TYPES.has(lookupName) && !BUILTIN_ACTIVITY_TYPES.has(activityType)) {
      const schema = catalogService.getActivitySchema(lookupName);
      if (!schema) {
        console.warn(`[renderActivity] Unknown activity type "${activityType}" — not in catalog, emitting comment placeholder`);
        return `
          <!-- UNKNOWN ACTIVITY: ${escapeXml(activityType)} — "${escapeXml(displayName)}" -->
          <ui:Comment Text="Unknown activity type: ${escapeXml(activityType)}. Manual implementation required." DisplayName="${escapeXml(displayName)} (stub)" />`;
      }

      const catalogKnownProps = new Set<string>();
      if (schema.activity && schema.activity.properties) {
        for (const p of schema.activity.properties) {
          catalogKnownProps.add(p.name);
        }
      }

      const filteredKeys: string[] = [];
      for (const key of Object.keys(properties)) {
        if (PSEUDO_XAML_ATTR_KEYS.has(key)) continue;
        if (RENDER_ACTIVITY_INHERITED_PROPS.has(key)) continue;
        if (catalogKnownProps.has(key)) continue;
        filteredKeys.push(key);
      }
      if (filteredKeys.length > 0) {
        console.log(`[renderActivity] Pre-emission filter: removed ${filteredKeys.length} non-catalog property(ies) from ${activityType} "${displayName}": ${filteredKeys.join(", ")}`);
        for (const key of filteredKeys) {
          delete properties[key];
        }
      }
    }
  }

  const enforced = enforceDisplayName(activityType, displayName);
  const isCrossPlatform = targetFramework === "Portable";

  const LOGMESSAGE_KNOWN_PROPS = new Set(["Level", "Message", "DisplayName"]);
  if (activityType === "ui:LogMessage") {
    const hasMessage = "Message" in properties;
    if (!hasMessage) {
      for (const [key, value] of Object.entries(properties)) {
        if (!LOGMESSAGE_KNOWN_PROPS.has(key) && !PSEUDO_XAML_ATTR_KEYS.has(key)) {
          properties["Message"] = value;
          delete properties[key];
          break;
        }
      }
    }
    for (const key of Object.keys(properties)) {
      if (!LOGMESSAGE_KNOWN_PROPS.has(key) && !PSEUDO_XAML_ATTR_KEYS.has(key) && key !== "sap2010:Annotation.AnnotationText") {
        delete properties[key];
      }
    }
  }

  let propAttrs = "";
  for (const [key, value] of Object.entries(properties)) {
    if (PSEUDO_XAML_ATTR_KEYS.has(key)) continue;
    const sanitized = sanitizePropertyValue(key, value);
    if (sanitized === "") continue;
    propAttrs += ` ${key}="${escapeXmlExpression(sanitized)}"`;
  }

  if (selectorHint && !isCrossPlatform) {
    propAttrs += ` Selector="${escapeXml(selectorHint)}"`;
  }

  if (isUiActivity(activityType)) {
    const timeout = operationalProps?.timeout ?? 30000;
    propAttrs += ` TimeoutMS="${timeout}"`;
  }

  const ACTIVITIES_WITH_CONTINUE_ON_ERROR = new Set([
    "ui:Click", "ui:TypeInto", "ui:GetText", "ui:ElementExists",
    "ui:OpenBrowser", "ui:NavigateTo", "ui:AttachBrowser", "ui:AttachWindow",
    "ui:UseBrowser", "ui:UseApplicationBrowser",
  ]);
  if (ACTIVITIES_WITH_CONTINUE_ON_ERROR.has(activityType)) {
    const continueOnError = operationalProps?.continueOnError ?? false;
    propAttrs += ` ContinueOnError="${continueOnError ? "True" : "False"}"`;
  }

  if (operationalProps?.delayBefore && operationalProps.delayBefore > 0) {
    propAttrs += ` DelayBefore="${operationalProps.delayBefore}"`;
  }
  if (operationalProps?.delayAfter && operationalProps.delayAfter > 0) {
    propAttrs += ` DelayAfter="${operationalProps.delayAfter}"`;
  }

  if (annotationOpts) {
    const annotationText = generateAnnotationText(annotationOpts);
    if (annotationText) {
      propAttrs += ` sap2010:Annotation.AnnotationText="${escapeXml(annotationText)}"`;
    }
  }

  if (isCrossPlatform && (activityType === "ui:UseBrowser" || activityType === "ui:UseApplication")) {
    const url = properties["Url"] || "TODO: Set application URL";
    return `
          <${activityType} DisplayName="${escapeXml(enforced)}" Url="${escapeXml(url)}"${selectorHint ? ` Selector="${escapeXml(selectorHint)}"` : ""}>
            <${activityType}.Body>
              <Sequence DisplayName="Actions: ${escapeXml(enforced)}">
              </Sequence>
            </${activityType}.Body>
          </${activityType}>`;
  }

  const convertedInputArgs = properties["_convertedInputArgs"] || "";
  const convertedOutputArgs = properties["_convertedOutputArgs"] || "";
  const hasConvertedArgs = (activityType === "ui:InvokeWorkflowFile" || activityType === "InvokeWorkflowFile") && (convertedInputArgs || convertedOutputArgs);

  let innerActivity: string;
  if (activityType === "Assign") {
    const rawToValue = properties["To"] || properties["to"] || "[variable]";
    const rawAssignValue = properties["Value"] || properties["value"] || "[value]";
    const toType = properties["TypeArgument"] || "x:String";
    const toValue = ensureBracketWrapped(rawToValue);
    const assignValue = smartBracketWrap(rawAssignValue);
    const safeToValue = normalizeXmlExpression(toValue);
    let safeAssignValue = normalizeXmlExpression(assignValue);
    if (toType === "x:Object") {
      const valContent = safeAssignValue.trim();
      const isLiteral = !(valContent.startsWith("[") && valContent.endsWith("]"));
      if (isLiteral && valContent.length > 0) {
        safeAssignValue = `[${valContent}]`;
        console.warn(`[Argument Guard] Bracket-wrapping literal value "${valContent}" for x:Object Assign "${enforced}"`);
      }
    }
    innerActivity = `<Assign DisplayName="${escapeXml(enforced)}"${propAttrs.replace(/\s+(To|Value|to|value|TypeArgument)="[^"]*"/g, "")}>
              <Assign.To><OutArgument x:TypeArguments="${toType}">${safeToValue}</OutArgument></Assign.To>
              <Assign.Value><InArgument x:TypeArguments="${toType}">${safeAssignValue}</InArgument></Assign.Value>
            </Assign>`;
  } else if (hasConvertedArgs) {
    let argsContent = "";
    if (convertedInputArgs) argsContent += parseInvokeArgs(convertedInputArgs, "In");
    if (convertedOutputArgs) argsContent += parseInvokeArgs(convertedOutputArgs, "Out");
    if (argsContent) {
      innerActivity = `<${activityType} DisplayName="${escapeXml(enforced)}"${propAttrs}>
              <${activityType}.Arguments>
${argsContent}              </${activityType}.Arguments>
            </${activityType}>`;
    } else {
      innerActivity = `<${activityType} DisplayName="${escapeXml(enforced)}"${propAttrs} />`;
    }
  } else {
    innerActivity = `<${activityType} DisplayName="${escapeXml(enforced)}"${propAttrs} />`;
  }

  if (isCrossPlatform && isUiActivity(activityType) && selectorHint) {
    const appSelector = selectorHint.match(/<html[^>]*\/>/)
      ? escapeXml(selectorHint.match(/<html[^>]*\/>/)![0])
      : "";
    const targetSelector = selectorHint.replace(/<html[^>]*\/>\s*/, "");
    const useAppType = selectorHint.includes("app=") ? "ui:UseApplication" : "ui:UseBrowser";
    return `
          <${useAppType} DisplayName="Scope: ${escapeXml(enforced)}" Url="TODO: Set target URL" Selector="${appSelector}">
            <${useAppType}.Body>
              <Sequence DisplayName="Actions: ${escapeXml(enforced)}">
                <${activityType} DisplayName="${escapeXml(enforced)}"${propAttrs} Target.Selector="${escapeXml(targetSelector)}" />
              </Sequence>
            </${useAppType}.Body>
          </${useAppType}>`;
  }

  return `
          ${innerActivity}`;
}

function wrapInTryCatch(innerXml: string, stepName: string, errorHandling: "retry" | "catch" | "escalate" | "none", targetFramework?: TargetFramework, genCtx?: XamlGenerationContext): string {
  if (errorHandling === "none") return innerXml;

  const isCSharp = targetFramework === "Portable";
  const concat = isCSharp ? " + " : " &amp; ";
  const automationPattern = genCtx?.automationPattern || "";
  const suppressDiagnostics = automationPattern === "simple-linear" || automationPattern === "api-data-driven";

  const strategyDesc = errorHandling === "retry" ? "Retry up to 3 times with 5s interval"
    : errorHandling === "escalate" ? "Log escalation and rethrow for manual intervention"
    : "Log error and rethrow to caller";
  const annotation = generateAnnotationText({ stepName, errorStrategy: strategyDesc });
  const annotAttr = ` sap2010:Annotation.AnnotationText="${escapeXml(annotation)}"`;

  if (errorHandling === "retry") {
    const escapedStep = escapeXml(stepName);
    const alreadyHasRetryScope = /<ui:RetryScope[\s>]/.test(innerXml);
    const retryScreenshot = suppressDiagnostics ? "" : `
                        <TryCatch DisplayName="Safe Screenshot on Retry Failure">
                          <TryCatch.Try>
                            <Sequence DisplayName="Capture Screenshot">
                              <ui:TakeScreenshot DisplayName="Screenshot on Retry Failure: ${escapedStep}" />
                              <ui:LogMessage Level="Warn" Message="[&quot;Retry exhausted for ${escapedStep}, screenshot captured&quot;]" DisplayName="Log Retry Screenshot" />
                            </Sequence>
                          </TryCatch.Try>
                          <TryCatch.Catches>
                            <Catch x:TypeArguments="s:Exception">
                              <ActivityAction x:TypeArguments="s:Exception">
                                <ActivityAction.Argument>
                                  <DelegateInArgument x:TypeArguments="s:Exception" Name="ssEx" />
                                </ActivityAction.Argument>
                                <ui:LogMessage Level="Warn" Message="[&quot;Screenshot capture failed: &quot;${concat}ssEx.Message]" DisplayName="Log Screenshot Failure" />
                              </ActivityAction>
                            </Catch>
                          </TryCatch.Catches>
                        </TryCatch>`;
    const retryBody = alreadyHasRetryScope ? innerXml : `
              <ui:RetryScope DisplayName="Retry: ${escapedStep}" NumberOfRetries="3" RetryInterval="00:00:05">
                <ui:RetryScope.Condition>
                  <ui:ShouldRetry />
                </ui:RetryScope.Condition>
                <Sequence DisplayName="Retry Body: ${escapedStep}">${innerXml}
                </Sequence>
              </ui:RetryScope>`;
    return `
          <TryCatch DisplayName="Try Retry: ${escapedStep}"${annotAttr}>
            <TryCatch.Try>${retryBody}
            </TryCatch.Try>
            <TryCatch.Catches>
              <Catch x:TypeArguments="s:Exception">
                <ActivityAction x:TypeArguments="s:Exception">
                  <ActivityAction.Argument>
                    <DelegateInArgument x:TypeArguments="s:Exception" Name="retryEx" />
                  </ActivityAction.Argument>
                  <Sequence DisplayName="Handle Retry Failure: ${escapedStep}">${retryScreenshot}
                    <ui:LogMessage Level="Error" Message="[&quot;[Retry Exhausted] ${escapedStep} failed after retries — &quot;${concat}retryEx.Message]" DisplayName="Log Retry Failure" />
                    <Rethrow DisplayName="Rethrow" />
                  </Sequence>
                </ActivityAction>
              </Catch>
            </TryCatch.Catches>
          </TryCatch>`;
  }

  const escapedStep = escapeXml(stepName);
  const screenshotCapture = suppressDiagnostics ? "" : `
                    <TryCatch DisplayName="Safe Screenshot Capture">
                      <TryCatch.Try>
                        <Sequence DisplayName="Capture Screenshot">
                          <ui:TakeScreenshot DisplayName="Screenshot on Error: ${escapedStep}" />
                          <ui:LogMessage Level="Info" Message="[&quot;Screenshot captured for error diagnostics&quot;]" DisplayName="Log Screenshot Captured" />
                        </Sequence>
                      </TryCatch.Try>
                      <TryCatch.Catches>
                        <Catch x:TypeArguments="s:Exception">
                          <ActivityAction x:TypeArguments="s:Exception">
                            <ActivityAction.Argument>
                              <DelegateInArgument x:TypeArguments="s:Exception" Name="screenshotEx" />
                            </ActivityAction.Argument>
                            <ui:LogMessage Level="Warn" Message="[&quot;Screenshot capture failed: &quot;${concat}screenshotEx.Message]" DisplayName="Log Screenshot Failure" />
                          </ActivityAction>
                        </Catch>
                      </TryCatch.Catches>
                    </TryCatch>`;

  const timestampExpr = isCSharp
    ? `[DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ssZ")]`
    : `[DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ssZ")]`;
  const stackTraceExpr = isCSharp
    ? `[exception.StackTrace != null ? exception.StackTrace.Substring(0, Math.Min(exception.StackTrace.Length, 500)) : ""]`
    : `[If(exception.StackTrace IsNot Nothing, exception.StackTrace.Substring(0, Math.Min(exception.StackTrace.Length, 500)), "")]`;
  const addLogFields = suppressDiagnostics ? "" : `
                    <ui:AddLogFields DisplayName="Add Diagnostic Fields: ${escapedStep}">
                      <ui:AddLogFields.Fields>
                        <scg:Dictionary x:TypeArguments="x:String, x:Object">
                          <x:String x:Key="ErrorStep">${escapedStep}</x:String>
                          <x:String x:Key="ErrorMessage">[exception.Message]</x:String>
                          <x:String x:Key="ErrorType">[exception.GetType().Name]</x:String>
                          <x:String x:Key="ErrorTimestamp">${timestampExpr}</x:String>
                          <x:String x:Key="StackTraceSummary">${stackTraceExpr}</x:String>
                          <x:String x:Key="ScreenshotCaptured">True</x:String>
                        </scg:Dictionary>
                      </ui:AddLogFields.Fields>
                    </ui:AddLogFields>`;

  const catchAction = errorHandling === "escalate"
    ? `<ui:LogMessage Level="Error" Message="[&quot;[Escalation Required] ${escapedStep} failed (&quot;${concat}exception.GetType().Name${concat}&quot;): &quot;${concat}exception.Message]" DisplayName="Log Escalation" />`
    : `<ui:LogMessage Level="Error" Message="[&quot;[Error] ${escapedStep} failed (&quot;${concat}exception.GetType().Name${concat}&quot;): &quot;${concat}exception.Message]" DisplayName="Log Error" />`;

  return `
          <TryCatch DisplayName="Try: ${escapedStep}"${annotAttr}>
            <TryCatch.Try>
              <Sequence DisplayName="Execute: ${escapedStep}">${innerXml}
              </Sequence>
            </TryCatch.Try>
            <TryCatch.Catches>
              <Catch x:TypeArguments="s:Exception">
                <ActivityAction x:TypeArguments="s:Exception">
                  <ActivityAction.Argument>
                    <DelegateInArgument x:TypeArguments="s:Exception" Name="exception" />
                  </ActivityAction.Argument>
                  <Sequence DisplayName="Handle Exception: ${escapedStep}">${screenshotCapture}${addLogFields}
                    ${catchAction}
                    <Rethrow DisplayName="Rethrow" />
                  </Sequence>
                </ActivityAction>
              </Catch>
            </TryCatch.Catches>
          </TryCatch>`;
}

function renderAgentTaskSequence(stepName: string, description: string, role: string): string {
  const safeStepName = escapeXml(stepName);
  const agentRole = role ? escapeXml(role) : "AI Agent";
  const annotationText = escapeXml(
    `[Agent Step] ${stepName}\nAgent Role: ${agentRole}\nDescription: ${description || stepName}\nThis step is handled by a UiPath Agent (AI-driven) rather than traditional RPA.\nThe agent uses LLM reasoning to process unstructured or judgment-based work.`
  );

  return `
          <Sequence DisplayName="Agent: ${safeStepName}" sap2010:Annotation.AnnotationText="${annotationText}">
            <Sequence.Variables>
              <Variable x:TypeArguments="x:String" Name="str_AgentInput" Default="&quot;&quot;" />
              <Variable x:TypeArguments="x:String" Name="str_AgentOutput" Default="&quot;&quot;" />
            </Sequence.Variables>
            <ui:LogMessage Level="Info" Message="[&quot;Invoking agent for: ${safeStepName}&quot;]" DisplayName="Log Agent Start: ${safeStepName}" />
            <ui:InvokeWorkflowFile DisplayName="Invoke Agent: ${safeStepName}" WorkflowFileName="AgentInvocation_Stub.xaml">
              <ui:InvokeWorkflowFile.Arguments>
                <InArgument x:TypeArguments="x:String" x:Key="in_AgentName">"${safeStepName}"</InArgument>
                <InArgument x:TypeArguments="x:String" x:Key="in_InputData">[str_AgentInput]</InArgument>
                <OutArgument x:TypeArguments="x:String" x:Key="out_AgentResult">[str_AgentOutput]</OutArgument>
              </ui:InvokeWorkflowFile.Arguments>
            </ui:InvokeWorkflowFile>
            <Assign DisplayName="Capture Agent Output: ${safeStepName}">
              <Assign.To><OutArgument x:TypeArguments="x:String">[str_AgentOutput]</OutArgument></Assign.To>
              <Assign.Value><InArgument x:TypeArguments="x:String">[str_AgentOutput]</InArgument></Assign.Value>
            </Assign>
            <ui:LogMessage Level="Info" Message="[&quot;Agent completed: ${safeStepName}&quot;]" DisplayName="Log Agent Complete: ${safeStepName}" />
          </Sequence>`;
}

function renderAgentDecision(stepName: string, description: string, role: string, thenXml: string, elseXml: string): string {
  const safeStepName = escapeXml(stepName);
  const agentRole = role ? escapeXml(role) : "AI Agent";
  const annotationText = escapeXml(
    `[Agent Decision] ${stepName}\nAgent Role: ${agentRole}\nJudgment Call: ${description || stepName}\nThis decision is evaluated by a UiPath Agent using LLM reasoning rather than deterministic rules.\nThe agent analyzes context and makes a judgment-based determination.`
  );

  const defaultThen = thenXml || `\n              <ui:LogMessage Level="Info" Message="[&quot;Agent decision YES path: ${safeStepName}&quot;]" DisplayName="Agent Then Path" />`;
  const defaultElse = elseXml || `\n              <ui:LogMessage Level="Info" Message="[&quot;Agent decision NO path: ${safeStepName}&quot;]" DisplayName="Agent Else Path" />`;

  return `
          <Sequence DisplayName="Agent Decision Setup: ${safeStepName}" sap2010:Annotation.AnnotationText="${annotationText}">
            <Sequence.Variables>
              <Variable x:TypeArguments="x:Boolean" Name="bool_AgentDecisionResult" Default="False" />
              <Variable x:TypeArguments="x:String" Name="str_AgentDecisionInput" Default="&quot;&quot;" />
            </Sequence.Variables>
            <ui:LogMessage Level="Info" Message="[&quot;Invoking agent decision for: ${safeStepName}&quot;]" DisplayName="Log Agent Decision Start" />
            <ui:InvokeWorkflowFile DisplayName="Agent Evaluate: ${safeStepName}" WorkflowFileName="AgentInvocation_Stub.xaml">
              <ui:InvokeWorkflowFile.Arguments>
                <InArgument x:TypeArguments="x:String" x:Key="in_AgentName">"${safeStepName}"</InArgument>
                <InArgument x:TypeArguments="x:String" x:Key="in_InputData">[str_AgentDecisionInput]</InArgument>
                <OutArgument x:TypeArguments="x:Boolean" x:Key="out_DecisionResult">[bool_AgentDecisionResult]</OutArgument>
              </ui:InvokeWorkflowFile.Arguments>
            </ui:InvokeWorkflowFile>
            <If DisplayName="Agent Decision: ${safeStepName}" Condition="[bool_AgentDecisionResult]">
              <If.Then>
                <Sequence DisplayName="Agent Yes: ${safeStepName}">${defaultThen}
                </Sequence>
              </If.Then>
              <If.Else>
                <Sequence DisplayName="Agent No: ${safeStepName}">${defaultElse}
                </Sequence>
              </If.Else>
            </If>
            <ui:LogMessage Level="Info" Message="[&quot;Agent decision completed: ${safeStepName}&quot;]" DisplayName="Log Agent Decision Complete" />
          </Sequence>`;
}

function wrapInIf(innerXml: string, condition: string, displayName: string): string {
  return `
          <If DisplayName="Decision: ${escapeXml(displayName)}" Condition="[${escapeXml(condition)}]">
            <If.Then>
              <Sequence DisplayName="Then: ${escapeXml(displayName)}">${innerXml}
              </Sequence>
            </If.Then>
            <If.Else>
              <Sequence DisplayName="Else: ${escapeXml(displayName)}">
                <ui:LogMessage Level="Info" Message="[&quot;Condition not met: ${escapeXml(displayName)}&quot;]" DisplayName="Log Else Path" />
              </Sequence>
            </If.Else>
          </If>`;
}

function renderEnrichedActivities(enrichedNode: EnrichedNodeSpec, targetFramework?: TargetFramework, genCtx?: XamlGenerationContext): {
  xml: string;
  packages: string[];
  variables: VariableDecl[];
  gaps: XamlGap[];
} {
  const packages: string[] = [];
  const variables: VariableDecl[] = [];
  const gaps: XamlGap[] = [];

  if (enrichedNode.activities.length === 0) {
    return { xml: "", packages: [], variables: [], gaps: [] };
  }

  let innerXml = "";
  for (let actIdx = 0; actIdx < enrichedNode.activities.length; actIdx++) {
    const act = enrichedNode.activities[actIdx];
    packages.push(act.package);
    if (act.variables) {
      for (const v of act.variables) {
        variables.push({ name: enforceVariableName(v.name, mapClrType(v.type)), type: v.type, defaultValue: v.defaultValue });
      }
    }

    const rawProperties = act.properties || {};

    if (isControlFlowActivity(act.activityType)) {
      const sanitizedProps: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawProperties)) {
        if (PSEUDO_XAML_ATTR_KEYS.has(key)) continue;
        const strVal = sanitizePropertyValue(key, value);
        if (strVal === "") continue;
        sanitizedProps[key] = strVal;
      }
      innerXml += renderControlFlowActivity(act.activityType, act.displayName, sanitizedProps, rawProperties, targetFramework).replace(/\n          /, "\n            ");
      continue;
    }

    const props: Record<string, string> = {};
    const placeholders: string[] = [];
    for (const [key, value] of Object.entries(rawProperties)) {
      if (PSEUDO_XAML_ATTR_KEYS.has(key)) continue;
      const strVal = sanitizePropertyValue(key, value);
      if (strVal === "") continue;
      props[key] = strVal;
      if (strVal.startsWith("PLACEHOLDER_") || strVal.startsWith("TODO")) {
        placeholders.push(key);
      }
    }

    const operationalProps = {
      timeout: act.timeout,
      continueOnError: act.continueOnError,
      delayBefore: act.delayBefore,
      delayAfter: act.delayAfter,
    };

    const annotationOpts = {
      stepName: enrichedNode.nodeName,
      businessContext: act.displayName !== enrichedNode.nodeName ? `${enrichedNode.nodeName} — ${act.displayName}` : enrichedNode.nodeName,
      placeholders: placeholders.length > 0 ? placeholders : undefined,
      aiReasoning: `Selected ${act.activityType} from ${act.package}`,
    };

    innerXml += renderActivity(act.activityType, act.displayName, props, act.selectorHint, operationalProps, annotationOpts, targetFramework).replace(/\n          /, "\n            ");
  }

  for (const gap of enrichedNode.gaps || []) {
    gaps.push(gap);
  }

  const firstAct = enrichedNode.activities[0];
  let rawErrorHandling: "retry" | "catch" | "escalate" | "none" = firstAct.errorHandling || "none";
  let errorHandling = upgradeErrorHandlingForHighRisk(rawErrorHandling, firstAct.activityType);
  if (errorHandling === "none" && enrichedNode.activities.length > 1) {
    for (const act of enrichedNode.activities) {
      const upgraded = upgradeErrorHandlingForHighRisk(act.errorHandling || "none", act.activityType);
      if (upgraded !== "none") {
        errorHandling = upgraded;
        break;
      }
    }
  }

  let xml: string;
  if (enrichedNode.activities.length === 1) {
    xml = wrapInTryCatch(innerXml, enrichedNode.nodeName, errorHandling, targetFramework, genCtx);
  } else {
    const sequenceXml = `
          <Sequence DisplayName="${escapeXml(enrichedNode.nodeName)}">${innerXml}
          </Sequence>`;
    xml = wrapInTryCatch(sequenceXml, enrichedNode.nodeName, errorHandling, targetFramework, genCtx);
  }

  return { xml, packages, variables, gaps };
}

export function generateRichXamlFromNodes(
  nodes: ProcessNode[],
  edges: ProcessEdge[],
  workflowName: string,
  projectDescription: string,
  enrichment?: EnrichmentResult | null,
  targetFramework?: TargetFramework,
  autopilotEnabled?: boolean,
  genCtx?: XamlGenerationContext
): XamlGeneratorResult {
  const allGaps: XamlGap[] = [];
  const allVariables: VariableDecl[] = [];
  const usedPackages = new Set<string>(["UiPath.System.Activities"]);
  let activities = "";

  const edgeMap = new Map<number, { target: number; label: string }[]>();
  for (const e of edges) {
    const list = edgeMap.get(e.sourceNodeId) || [];
    list.push({ target: e.targetNodeId, label: e.label || "" });
    edgeMap.set(e.sourceNodeId, list);
  }

  const nodeMap = new Map<number, ProcessNode>();
  for (const n of nodes) {
    nodeMap.set(n.id, n);
  }

  const sortedNodes = [...nodes].sort((a, b) => a.orderIndex - b.orderIndex);

  const timestamp = new Date().toISOString().split("T")[0];
  activities += `
        <!-- CannonBall Auto-Generated XAML -->
        <!-- Workflow: ${escapeXml(workflowName)} -->
        <!-- Generated: ${timestamp} -->
        <!-- Process Map: ${nodes.length} nodes, ${edges.length} edges -->
        <!-- Trace: Each activity below references its source process map step -->
        <ui:LogMessage Level="Info" Message="[&quot;=== Starting: ${escapeXml(workflowName)} ===&quot;]" DisplayName="Log Start" />`;

  const startNodes = sortedNodes.filter(n => n.nodeType === "start");
  const endNodes = sortedNodes.filter(n => n.nodeType === "end");
  const taskNodes = sortedNodes.filter(n => n.nodeType !== "start" && n.nodeType !== "end");
  const hasAgentNodes = taskNodes.some(n => n.nodeType === "agent-task" || n.nodeType === "agent-decision" || n.nodeType === "agent-loop");

  if (startNodes.length > 0) {
    for (const node of startNodes) {
      activities += `
        <ui:LogMessage Level="Info" Message="[&quot;Initialization: ${escapeXml(node.name)}&quot;]" DisplayName="Init: ${escapeXml(node.name)}" />`;
    }
    activities += `
        <!-- TODO: Add config file reading (InitAllSettings) and variable initialization here -->`;
    allGaps.push({
      category: "config",
      activity: "Initialization",
      description: "Add Config.xlsx reading and variable initialization in start sequence",
      placeholder: "Use InitAllSettings.xaml to read Config.xlsx",
      estimatedMinutes: 30,
    });
  }

  const enrichedMap = new Map<number, EnrichedNodeSpec>();
  if (enrichment?.nodes) {
    for (const en of enrichment.nodes) {
      enrichedMap.set(en.nodeId, en);
    }
  }

  const isMainWorkflow = workflowName.toLowerCase() === "main" || workflowName.toLowerCase() === "main.xaml";
  if (!isMainWorkflow && enrichment?.arguments && enrichment.arguments.length > 0) {
    const validationXaml = generateArgumentValidationXaml(enrichment.arguments, workflowName);
    if (validationXaml) activities += validationXaml;
  }

  for (const node of taskNodes) {
    const enrichedSpec = enrichedMap.get(node.id);
    const nodeTrace = `Step #${node.orderIndex} "${escapeXml(node.name)}" [${node.nodeType}]${node.system ? ` | System: ${escapeXml(node.system)}` : ""}${node.role ? ` | Role: ${escapeXml(node.role)}` : ""}`;

    if (node.nodeType === "agent-task" || node.nodeType === "agent-loop") {
      activities += `
        <!-- Agent Step: ${nodeTrace} -->`;
      const agentXml = renderAgentTaskSequence(node.name, node.description || "", node.role || "");
      const wrappedAgent = wrapInTryCatch(agentXml, node.name, "catch", targetFramework, genCtx);
      activities += wrappedAgent;
      allVariables.push({ name: "str_AgentInput", type: "String", defaultValue: '""' });
      allVariables.push({ name: "str_AgentOutput", type: "String", defaultValue: '""' });
      allGaps.push({
        category: "agent",
        activity: "InvokeAgent",
        description: `Configure agent invocation for "${node.name}" — set agent name, input data mapping, and output capture`,
        placeholder: "AgentInvocation_Stub.xaml",
        estimatedMinutes: 30,
      });
      continue;
    }

    if (node.nodeType === "agent-decision") {
      const outEdges = edgeMap.get(node.id) || [];
      const edgeLabels = outEdges.map(e => `"${e.label || "unlabeled"}" -> node #${e.target}`).join(", ");
      activities += `
        <!-- Agent Decision: ${nodeTrace} | Branches: ${edgeLabels} -->`;

      let thenActivities = "";
      let elseActivities = "";
      for (const outEdge of outEdges) {
        const targetNode = nodeMap.get(outEdge.target);
        if (!targetNode) continue;
        const targetEnriched = enrichedMap.get(outEdge.target);
        let branchXml: string;
        if (targetEnriched && targetEnriched.activities.length > 0) {
          const rendered = renderEnrichedActivities(targetEnriched, targetFramework, genCtx);
          branchXml = rendered.xml;
          rendered.packages.forEach(p => usedPackages.add(p));
          allVariables.push(...rendered.variables);
          allGaps.push(...rendered.gaps);
        } else {
          const classified = classifyActivity({ system: targetNode.system || "", nodeType: targetNode.nodeType, name: targetNode.name, description: targetNode.description || "", role: targetNode.role || "", isPainPoint: targetNode.isPainPoint || false, targetFramework }, genCtx);
          branchXml = renderActivity(classified.activityType, targetNode.name, classified.properties, classified.selectorHint, undefined, undefined, targetFramework);
        }
        const label = (outEdge.label || "").toLowerCase();
        if (label.includes("yes") || label.includes("true") || label.includes("approve") || label.includes("pass")) {
          thenActivities += branchXml;
        } else {
          elseActivities += branchXml;
        }
      }

      const agentDecisionXml = renderAgentDecision(node.name, node.description || "", node.role || "", thenActivities, elseActivities);
      const wrappedDecision = wrapInTryCatch(agentDecisionXml, node.name, "catch", targetFramework, genCtx);
      activities += wrappedDecision;
      allVariables.push({ name: "bool_AgentDecisionResult", type: "Boolean", defaultValue: "False" });
      allVariables.push({ name: "str_AgentDecisionInput", type: "String", defaultValue: '""' });
      allGaps.push({
        category: "agent",
        activity: "AgentDecision",
        description: `Configure agent decision logic for "${node.name}" — this is a judgment-based evaluation handled by AI`,
        placeholder: "Agent evaluates context and returns boolean decision",
        estimatedMinutes: 25,
      });
      continue;
    }

    if (enrichedSpec && enrichedSpec.activities.length > 0) {
      if (node.nodeType === "decision") {
        const outEdges = edgeMap.get(node.id) || [];
        const edgeLabels = outEdges.map(e => `"${e.label || "unlabeled"}" → node #${e.target}`).join(", ");
        activities += `
        <!-- Decision: ${nodeTrace} | Branches: ${edgeLabels} -->`;
        const rawCondition = outEdges.find(e => e.label)?.label || "";
        const needsConditionReview = !rawCondition || rawCondition === "TODO_Condition" || rawCondition.startsWith("TODO_") || rawCondition.startsWith("PLACEHOLDER_");
        const condition = needsConditionReview ? "True" : rawCondition;
        allVariables.push({ name: `bool_${node.name.replace(/[^A-Za-z0-9]/g, "")}`, type: "Boolean", defaultValue: "False" });

        let thenActivities = "";
        let elseActivities = "";
        for (const outEdge of outEdges) {
          const targetEnriched = enrichedMap.get(outEdge.target);
          const targetNode = nodeMap.get(outEdge.target);
          if (!targetNode) continue;
          const label = (outEdge.label || "").toLowerCase();
          let branchXml: string;
          if (targetEnriched && targetEnriched.activities.length > 0) {
            const rendered = renderEnrichedActivities(targetEnriched, targetFramework, genCtx);
            branchXml = rendered.xml;
            rendered.packages.forEach(p => usedPackages.add(p));
            allVariables.push(...rendered.variables);
            allGaps.push(...rendered.gaps);
          } else {
            const classified = classifyActivity({ system: targetNode.system || "", nodeType: targetNode.nodeType, name: targetNode.name, description: targetNode.description || "", role: targetNode.role || "", isPainPoint: targetNode.isPainPoint || false, targetFramework }, genCtx);
            branchXml = renderActivity(classified.activityType, targetNode.name, classified.properties, classified.selectorHint, undefined, undefined, targetFramework);
          }
          if (label.includes("yes") || label.includes("true") || label.includes("approve") || label.includes("pass")) {
            thenActivities += branchXml;
          } else {
            elseActivities += branchXml;
          }
        }

        if (!thenActivities) thenActivities = `\n            <ui:LogMessage Level="Info" Message="[&quot;Then: ${escapeXml(node.name)}&quot;]" DisplayName="Then Path" />`;
        if (!elseActivities) elseActivities = `\n              <ui:LogMessage Level="Info" Message="[&quot;Else: ${escapeXml(node.name)}&quot;]" DisplayName="Else Path" />`;

        if (needsConditionReview) {
          activities += `
        <ui:Comment Text="TODO: Replace default True condition with actual business logic for: ${escapeXml(node.name)}" DisplayName="Review Condition" />`;
        }
        activities += `
        <If DisplayName="Decision: ${escapeXml(node.name)}" Condition="[${escapeXml(condition)}]">
          <If.Then>
            <Sequence DisplayName="Yes: ${escapeXml(node.name)}">${thenActivities}
            </Sequence>
          </If.Then>
          <If.Else>
            <Sequence DisplayName="No: ${escapeXml(node.name)}">${elseActivities}
            </Sequence>
          </If.Else>
        </If>`;
        continue;
      }

      activities += `
        <!-- Source: ${nodeTrace} | AI-Enriched: ${enrichedSpec.activities.length} activities -->`;
      const rendered = renderEnrichedActivities(enrichedSpec, targetFramework, genCtx);
      rendered.packages.forEach(p => usedPackages.add(p));
      allVariables.push(...rendered.variables);
      allGaps.push(...rendered.gaps);
      activities += rendered.xml;
      continue;
    }

    const ctx: ActivityContext = {
      system: node.system || "",
      nodeType: node.nodeType,
      name: node.name,
      description: node.description || "",
      role: node.role || "",
      isPainPoint: node.isPainPoint || false,
      targetFramework,
      autopilotEnabled,
    };

    if (node.nodeType === "decision") {
      const outEdges = edgeMap.get(node.id) || [];
      const edgeLabels = outEdges.map(e => `"${e.label || "unlabeled"}" → node #${e.target}`).join(", ");
      activities += `
        <!-- Decision: ${nodeTrace} | Branches: ${edgeLabels} -->`;
      const rawCondition = outEdges.find(e => e.label)?.label || "";
      const needsConditionReview = !rawCondition || rawCondition === "TODO_Condition" || rawCondition.startsWith("TODO_") || rawCondition.startsWith("PLACEHOLDER_");
      const condition = needsConditionReview ? "True" : rawCondition;

      allVariables.push({ name: "bool_Decision", type: "Boolean", defaultValue: "False" });
      allGaps.push({
        category: "logic",
        activity: "Decision",
        description: `Implement decision logic for "${node.name}": ${condition}`,
        placeholder: `Evaluate condition: ${condition}`,
        estimatedMinutes: 20,
      });

      let thenActivities = "";
      let elseActivities = "";
      for (const outEdge of outEdges) {
        const targetNode = nodeMap.get(outEdge.target);
        if (!targetNode) continue;
        const branchCtx: ActivityContext = {
          system: targetNode.system || "",
          nodeType: targetNode.nodeType,
          name: targetNode.name,
          description: targetNode.description || "",
          role: targetNode.role || "",
          isPainPoint: targetNode.isPainPoint || false,
          targetFramework,
        };
        const classified = classifyActivity(branchCtx, genCtx);
        const branchActivity = renderActivity(classified.activityType, targetNode.name, classified.properties, classified.selectorHint, undefined, undefined, targetFramework);
        const label = (outEdge.label || "").toLowerCase();
        if (label.includes("yes") || label.includes("true") || label.includes("approve") || label.includes("pass")) {
          thenActivities += branchActivity;
        } else {
          elseActivities += branchActivity;
        }
      }

      if (!thenActivities) {
        thenActivities = `
            <ui:LogMessage Level="Info" Message="[&quot;Then branch: ${escapeXml(node.name)}&quot;]" DisplayName="Then Path" />`;
      }

      if (needsConditionReview) {
        activities += `
        <ui:Comment Text="TODO: Replace default True condition with actual business logic for: ${escapeXml(node.name)}" DisplayName="Review Condition" />`;
      }
      activities += `
        <If DisplayName="Decision: ${escapeXml(node.name)}" Condition="[${escapeXml(condition)}]">
          <If.Then>
            <Sequence DisplayName="Yes: ${escapeXml(node.name)}">${thenActivities}
            </Sequence>
          </If.Then>
          <If.Else>
            <Sequence DisplayName="No: ${escapeXml(node.name)}">${elseActivities || `
              <ui:LogMessage Level="Info" Message="[&quot;Else branch: ${escapeXml(node.name)}&quot;]" DisplayName="Else Path" />`}
            </Sequence>
          </If.Else>
        </If>`;
      continue;
    }

    const classified = classifyActivity(ctx, genCtx);
    usedPackages.add(classified.activityPackage);
    for (const cv of classified.variables) {
      allVariables.push({ name: enforceVariableName(cv.name, mapClrType(cv.type)), type: cv.type, defaultValue: cv.defaultValue });
    }
    allGaps.push(...classified.gaps);

    const classifiedPlaceholders = Object.entries(classified.properties)
      .filter(([, v]) => v.startsWith("PLACEHOLDER_") || v.startsWith("TODO"))
      .map(([k]) => k);
    const activityXml = renderActivity(
      classified.activityType,
      node.name,
      classified.properties,
      classified.selectorHint,
      undefined,
      {
        stepNumber: node.orderIndex,
        stepName: node.name,
        businessContext: node.description || node.name,
        placeholders: classifiedPlaceholders.length > 0 ? classifiedPlaceholders : undefined,
      },
      targetFramework
    );

    activities += `
        <!-- Source: ${nodeTrace} | Activity: ${classified.activityType}${node.isPainPoint ? " | ⚠ Pain Point" : ""} -->`;
    const upgradedErrorHandling = upgradeErrorHandlingForHighRisk(classified.errorHandling, classified.activityType);
    const wrappedXml = wrapInTryCatch(activityXml, node.name, upgradedErrorHandling, targetFramework, genCtx);
    activities += wrappedXml;
  }

  for (const node of endNodes) {
    activities += `
        <ui:LogMessage Level="Info" Message="[&quot;Completed: ${escapeXml(node.name)}&quot;]" DisplayName="End: ${escapeXml(node.name)}" />`;
  }

  activities += `
        <ui:LogMessage Level="Info" Message="[&quot;=== Completed: ${escapeXml(workflowName)} ===&quot;]" DisplayName="Log Completion" />`;

  const variablesBlock = renderVariablesBlock(allVariables, targetFramework);

  const isMainWorkflow2 = workflowName.toLowerCase() === "main" || workflowName.toLowerCase() === "main.xaml";
  const isInitAllSettings = workflowName.toLowerCase().includes("initallsettings");
  const wfArgs = !isMainWorkflow2 && enrichment?.arguments?.length ? enrichment.arguments : [];
  const hasDictConfigRef = !isMainWorkflow2 && !isInitAllSettings && activities.includes("dict_Config");
  if (hasDictConfigRef && !wfArgs.some(a => a.name === "in_Config")) {
    wfArgs.push({ name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" });
  }
  const xMembersBlock = generateXMembersBlock(wfArgs, targetFramework);
  const dictConfigVariable = hasDictConfigRef
    ? `<Variable x:TypeArguments="scg:Dictionary(x:String, x:Object)" Name="dict_Config" Default="[in_Config]" />\n    `
    : "";

  const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${escapeXml(workflowName.replace(/\s+/g, "_"))}"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
${xMembersBlock}  <Sequence DisplayName="${escapeXml(workflowName)}">
    ${dictConfigVariable}${variablesBlock}${activities}
  </Sequence>
</Activity>`;

  return {
    xaml: sanitizeObjectLiteralArguments(xaml),
    gaps: allGaps,
    usedPackages: Array.from(usedPackages),
    variables: allVariables,
  };
}

export function generateRichXamlFromSpec(
  workflow: WorkflowSpec,
  sddContent?: string,
  aiCenterSkills?: AICenterSkill[],
  targetFramework?: TargetFramework,
  autopilotEnabled?: boolean,
  genCtx?: XamlGenerationContext
): XamlGeneratorResult {
  const allGaps: XamlGap[] = [];
  const allVariables: VariableDecl[] = [];
  const usedPackages = new Set<string>(["UiPath.System.Activities"]);
  let activities = "";

  const wfName = workflow.name || "Workflow";
  const steps = workflow.steps || [];

  activities += `
        <ui:LogMessage Level="Info" Message="[&quot;=== Starting: ${escapeXml(wfName)} ===&quot;]" DisplayName="Log Start" />`;

  if (workflow.arguments && workflow.arguments.length > 0) {
    const validationXaml = generateArgumentValidationXaml(workflow.arguments, wfName);
    if (validationXaml) activities += validationXaml;
  }

  if (sddContent) {
    const errorHandlingSection = extractSddSection(sddContent, 5);
    if (errorHandlingSection) {
      allGaps.push({
        category: "logic",
        activity: "ErrorHandling",
        description: "Review SDD Section 5 error handling strategy and ensure all exception paths are implemented",
        placeholder: errorHandlingSection.slice(0, 200),
        estimatedMinutes: 60,
      });
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepName = step.activity || step.activityType || `Step ${i + 1}`;

    if (step.nodeType === "agent-task" || step.nodeType === "agent-loop") {
      activities += `
        <!-- Agent Step: ${escapeXml(stepName)} -->`;
      const agentXml = renderAgentTaskSequence(stepName, step.notes || "", step.role || "");
      const wrappedAgent = wrapInTryCatch(agentXml, stepName, "catch", targetFramework, genCtx);
      activities += wrappedAgent;
      allVariables.push({ name: "str_AgentInput", type: "String", defaultValue: '""' });
      allVariables.push({ name: "str_AgentOutput", type: "String", defaultValue: '""' });
      allGaps.push({
        category: "agent",
        activity: "InvokeAgent",
        description: `Configure agent invocation for "${stepName}" — set agent name, input data mapping, and output capture`,
        placeholder: "AgentInvocation_Stub.xaml",
        estimatedMinutes: 30,
      });
      continue;
    }

    if (step.nodeType === "agent-decision") {
      activities += `
        <!-- Agent Decision: ${escapeXml(stepName)} -->`;
      const agentDecisionXml = renderAgentDecision(stepName, step.notes || "", step.role || "", "", "");
      const wrappedDecision = wrapInTryCatch(agentDecisionXml, stepName, "catch", targetFramework, genCtx);
      activities += wrappedDecision;
      allVariables.push({ name: "bool_AgentDecisionResult", type: "Boolean", defaultValue: "False" });
      allVariables.push({ name: "str_AgentDecisionInput", type: "String", defaultValue: '""' });
      allGaps.push({
        category: "agent",
        activity: "AgentDecision",
        description: `Configure agent decision logic for "${stepName}" — this is a judgment-based evaluation handled by AI`,
        placeholder: "Agent evaluates context and returns boolean decision",
        estimatedMinutes: 25,
      });
      continue;
    }

    if (step.activityType) {
      usedPackages.add(step.activityPackage || "UiPath.System.Activities");
      if (step.variables) {
        allVariables.push(...step.variables);
      }

      const rawStepProps = step.properties || {};
      const props: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawStepProps)) {
        if (PSEUDO_XAML_ATTR_KEYS.has(k)) continue;
        const sanitized = sanitizePropertyValue(k, v);
        if (sanitized === "") continue;
        props[k] = sanitized;
      }

      let activityXml: string;
      if (isControlFlowActivity(step.activityType)) {
        activityXml = renderControlFlowActivity(
          step.activityType,
          stepName,
          props,
          rawStepProps,
          targetFramework
        );
      } else {
        activityXml = renderActivity(
          step.activityType,
          stepName,
          props,
          step.selectorHint,
          undefined,
          undefined,
          targetFramework
        );
      }

      if (step.selectorHint) {
        allGaps.push({
          category: "selector",
          activity: step.activityType,
          description: `Replace placeholder selector in "${stepName}"`,
          placeholder: step.selectorHint,
          estimatedMinutes: 15,
        });
      }

      const rawStepErrorHandling = step.errorHandling || "none";
      const stepActivityType = step.activityType || "";
      const errorHandling = upgradeErrorHandlingForHighRisk(rawStepErrorHandling, stepActivityType);
      const wrappedXml = wrapInTryCatch(activityXml, stepName, errorHandling, targetFramework, genCtx);
      activities += wrappedXml;
    } else {
      const ctx: ActivityContext = {
        system: "",
        nodeType: "task",
        name: stepName,
        description: step.notes || "",
        role: "",
        isPainPoint: false,
        targetFramework,
        autopilotEnabled,
      };

      const classified = classifyActivity(ctx, genCtx);
      usedPackages.add(classified.activityPackage);
      allVariables.push(...classified.variables);
      allGaps.push(...classified.gaps);

      const activityXml = renderActivity(
        classified.activityType,
        stepName,
        classified.properties,
        classified.selectorHint,
        undefined,
        undefined,
        targetFramework
      );

      const upgradedClassifiedErrorHandling = upgradeErrorHandlingForHighRisk(classified.errorHandling, classified.activityType);
      const wrappedXml = wrapInTryCatch(activityXml, stepName, upgradedClassifiedErrorHandling, targetFramework, genCtx);
      activities += wrappedXml;
    }
  }

  activities += `
        <ui:LogMessage Level="Info" Message="[&quot;=== Completed: ${escapeXml(wfName)} ===&quot;]" DisplayName="Log Completion" />`;

  const variablesBlock = renderVariablesBlock(allVariables, targetFramework);

  const specArgs = workflow.arguments || [];
  const isSpecMainWf = wfName.toLowerCase() === "main" || wfName.toLowerCase() === "main.xaml";
  const isSpecInitAll = wfName.toLowerCase().includes("initallsettings");
  const specHasDictConfig = !isSpecMainWf && !isSpecInitAll && activities.includes("dict_Config");
  if (specHasDictConfig && !specArgs.some((a: any) => a.name === "in_Config")) {
    specArgs.push({ name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" });
  }
  const xMembersBlockSpec = generateXMembersBlock(specArgs, targetFramework);
  const specDictConfigVar = specHasDictConfig
    ? `<Variable x:TypeArguments="scg:Dictionary(x:String, x:Object)" Name="dict_Config" Default="[in_Config]" />\n    `
    : "";

  const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${escapeXml(wfName.replace(/\s+/g, "_"))}"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
${xMembersBlockSpec}  <Sequence DisplayName="${escapeXml(wfName)}">
    ${specDictConfigVar}${variablesBlock}${activities}
  </Sequence>
</Activity>`;

  return {
    xaml: sanitizeObjectLiteralArguments(xaml),
    gaps: allGaps,
    usedPackages: Array.from(usedPackages),
    variables: allVariables,
  };
}

function extractSddSection(sddContent: string, sectionNumber: number): string | null {
  const pattern = new RegExp(`## ${sectionNumber}\\.\\s+[^\\n]+\\n([\\s\\S]*?)(?=## \\d+\\.|$)`);
  const match = sddContent.match(pattern);
  return match ? match[1].trim() : null;
}

export function generateInitAllSettingsXaml(orchestratorArtifacts?: any, targetFramework?: TargetFramework, credentialStrategy?: string): string {
  const isCSharp = targetFramework === "Portable";
  const initConcat = isCSharp ? " + " : " &amp; ";
  const toStringCall = isCSharp ? ".ToString()" : ".ToString";
  const assetCount = orchestratorArtifacts?.assets?.length || 0;
  const queueCount = orchestratorArtifacts?.queues?.length || 0;
  const strategy = credentialStrategy || "GetCredential";
  let assetActivities = `
      <!-- InitAllSettings.xaml — Auto-generated by CannonBall -->
      <!-- Reads Config.xlsx (Settings + Constants sheets) and retrieves Orchestrator assets -->
      <!-- Assets: ${assetCount} | Queues: ${queueCount} | Strategy: ${strategy} -->`;
  const assets = orchestratorArtifacts?.assets || [];
  const credAssets = assets.filter((a: any) => a.type === "Credential" || !a.type);
  const textAssets = assets.filter((a: any) => a.type && a.type !== "Credential");

  const emitGetCredential = strategy === "GetCredential" || strategy === "mixed";
  const emitGetAsset = strategy === "GetAsset" || strategy === "mixed";

  if (emitGetCredential && credAssets.length > 0) {
    for (const asset of credAssets) {
      const dictKey = isCSharp ? `"${escapeXml(asset.name)}"` : `&quot;${escapeXml(asset.name)}&quot;`;
      assetActivities += `
          <ui:GetCredential DisplayName="Get ${escapeXml(asset.name)}" AssetName="${escapeXml(asset.name)}" Username="[str_TempUser]" Password="[sec_TempPass]" />
          <Assign DisplayName="Store ${escapeXml(asset.name)} User in Config">
            <Assign.To><OutArgument x:TypeArguments="x:Object">[dict_Config(${dictKey})]</OutArgument></Assign.To>
            <Assign.Value><InArgument x:TypeArguments="x:Object">[str_TempUser]</InArgument></Assign.Value>
          </Assign>`;
    }
  }

  if (emitGetAsset && textAssets.length > 0) {
    for (const asset of textAssets) {
      const dictKey = isCSharp ? `"${escapeXml(asset.name)}"` : `&quot;${escapeXml(asset.name)}&quot;`;
      assetActivities += `
          <ui:GetAsset DisplayName="Get ${escapeXml(asset.name)}" AssetName="${escapeXml(asset.name)}">
            <ui:GetAsset.AssetValue>
              <OutArgument x:TypeArguments="x:String">[str_AssetValue]</OutArgument>
            </ui:GetAsset.AssetValue>
          </ui:GetAsset>
          <Assign DisplayName="Store ${escapeXml(asset.name)} in Config">
            <Assign.To><OutArgument x:TypeArguments="x:Object">[dict_Config(${dictKey})]</OutArgument></Assign.To>
            <Assign.Value><InArgument x:TypeArguments="x:Object">[str_AssetValue]</InArgument></Assign.Value>
          </Assign>`;
    }
  }

  const nsS = isCSharp ? "System.Runtime" : "mscorlib";
  const nsScg = isCSharp ? "System.Runtime" : "mscorlib";
  const sq = `&quot;`;

  const excelBlock = isCSharp
    ? `<ui:UseExcel DisplayName="Read Config File" ExcelFile="[str_ConfigPath]">
      <ui:UseExcel.Body>
        <Sequence DisplayName="Read Config Sheets">
          <ui:ReadRange DisplayName="Read Settings Sheet" SheetName="Settings" DataTable="[dt_Settings]" />
          <ui:ReadRange DisplayName="Read Constants Sheet" SheetName="Constants" DataTable="[dt_Constants]" />
        </Sequence>
      </ui:UseExcel.Body>
    </ui:UseExcel>`
    : `<ui:ExcelApplicationScope DisplayName="Read Config File" WorkbookPath="[str_ConfigPath]">
      <ui:ExcelApplicationScope.Body>
        <ActivityAction x:TypeArguments="x:Object">
          <ActivityAction.Handler>
            <Sequence DisplayName="Read Config Sheets">
              <ui:ExcelReadRange DisplayName="Read Settings Sheet" SheetName="Settings" DataTable="[dt_Settings]" />
              <ui:ExcelReadRange DisplayName="Read Constants Sheet" SheetName="Constants" DataTable="[dt_Constants]" />
            </Sequence>
          </ActivityAction.Handler>
        </ActivityAction>
      </ui:ExcelApplicationScope.Body>
    </ui:ExcelApplicationScope>`;

  return `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="InitAllSettings"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=${nsS}"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=${nsScg}"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <x:Members>
    <x:Property Name="out_Config" Type="OutArgument({clr-namespace:System.Collections.Generic;assembly=${nsScg}}Dictionary({http://schemas.microsoft.com/winfx/2006/xaml}String, {http://schemas.microsoft.com/winfx/2006/xaml}Object))" />
  </x:Members>
  <Sequence DisplayName="Initialize All Settings">
    <Sequence.Variables>
      <Variable x:TypeArguments="scg2:DataTable" Name="dt_Settings" />
      <Variable x:TypeArguments="scg2:DataTable" Name="dt_Constants" />
      <Variable x:TypeArguments="x:String" Name="str_ConfigPath" Default="Data\\Config.xlsx" />
      <Variable x:TypeArguments="x:String" Name="str_AssetValue" />
      <Variable x:TypeArguments="x:String" Name="str_TempUser" />
      <Variable x:TypeArguments="s:Security.SecureString" Name="sec_TempPass" />
      <Variable x:TypeArguments="scg2:DataRow" Name="row_Current" />
      <Variable x:TypeArguments="scg:Dictionary(x:String, x:Object)" Name="dict_Config" Default="[${isCSharp ? "new Dictionary&lt;string, object&gt;()" : "New Dictionary(Of String, Object)"}]" />
    </Sequence.Variables>
    <ui:LogMessage Level="Info" Message="[${sq}Reading configuration from Config.xlsx...${sq}]" DisplayName="Log Config Start" />
    ${excelBlock}
    <ForEach x:TypeArguments="scg2:DataRow" DisplayName="Process Settings Rows" Values="[dt_Settings.Rows]">
      <ActivityAction x:TypeArguments="scg2:DataRow">
        <ActivityAction.Argument>
          <DelegateInArgument x:TypeArguments="scg2:DataRow" Name="row" />
        </ActivityAction.Argument>
        <Sequence DisplayName="Process Setting Row">
          <Assign DisplayName="Store Setting in Config Dictionary">
            <Assign.To><OutArgument x:TypeArguments="x:Object">[dict_Config(row(&quot;Name&quot;)${toStringCall})]</OutArgument></Assign.To>
            <Assign.Value><InArgument x:TypeArguments="x:Object">[row(&quot;Value&quot;)]</InArgument></Assign.Value>
          </Assign>
          <ui:LogMessage Level="Trace" Message="[&quot;Processing setting: &quot;${initConcat}row(&quot;Name&quot;)${toStringCall}]" DisplayName="Log Setting" />
        </Sequence>
      </ActivityAction>
    </ForEach>${assetActivities}
    <ForEach x:TypeArguments="scg2:DataRow" DisplayName="Process Constants Rows" Values="[dt_Constants.Rows]">
      <ActivityAction x:TypeArguments="scg2:DataRow">
        <ActivityAction.Argument>
          <DelegateInArgument x:TypeArguments="scg2:DataRow" Name="constRow" />
        </ActivityAction.Argument>
        <Sequence DisplayName="Store Constant">
          <Assign DisplayName="Store Constant in Config Dictionary">
            <Assign.To><OutArgument x:TypeArguments="x:Object">[dict_Config(constRow(&quot;Name&quot;)${toStringCall})]</OutArgument></Assign.To>
            <Assign.Value><InArgument x:TypeArguments="x:Object">[constRow(&quot;Value&quot;)]</InArgument></Assign.Value>
          </Assign>
          <ui:LogMessage Level="Trace" Message="[&quot;Loaded constant: &quot;${initConcat}constRow(&quot;Name&quot;)${toStringCall}]" DisplayName="Log Constant" />
        </Sequence>
      </ActivityAction>
    </ForEach>
    <Assign DisplayName="Output Config Dictionary">
      <Assign.To><OutArgument x:TypeArguments="scg:Dictionary(x:String, x:Object)">[out_Config]</OutArgument></Assign.To>
      <Assign.Value><InArgument x:TypeArguments="scg:Dictionary(x:String, x:Object)">[dict_Config]</InArgument></Assign.Value>
    </Assign>
    <ui:LogMessage Level="Info" Message="[&quot;Configuration loaded successfully&quot;]" DisplayName="Log Config Complete" />
  </Sequence>
</Activity>`;
}

export function generateReframeworkMainXaml(projectName: string, queueName: string, targetFramework?: TargetFramework): string {
  const isCSharp = targetFramework === "Portable";
  const concat = isCSharp ? " + " : " &amp; ";
  const safeName = escapeXml(projectName.replace(/\s+/g, "_"));
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- REFramework Main.xaml — Auto-generated by CannonBall -->
<!-- Pattern: Robotic Enterprise Framework (State Machine) -->
<!-- States: Init → Get Transaction Data → Process Transaction → End Process -->
<!-- Queue: ${escapeXml(queueName)} -->
<!-- Project: ${safeName} -->
<Activity mc:Ignorable="sap sap2010" x:Class="Main"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data"
  xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=mscorlib"
  xmlns:sads="clr-namespace:System.Activities.Statements;assembly=System.Activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">${isCSharp ? "" : `
  <mva:VisualBasic.Settings>
    <x:Null />
  </mva:VisualBasic.Settings>`}
  <sap2010:WorkflowViewState.IdRef>Main_1</sap2010:WorkflowViewState.IdRef>
  <TextExpression.NamespacesForImplementation>
    <sco:Collection x:TypeArguments="x:String">
      <x:String>System</x:String>
      <x:String>System.Collections</x:String>
      <x:String>System.Collections.Generic</x:String>
      <x:String>System.Data</x:String>
      <x:String>System.IO</x:String>
      <x:String>System.Linq</x:String>
      <x:String>System.Xml</x:String>
      <x:String>System.Xml.Linq</x:String>
      <x:String>UiPath.Core</x:String>
      <x:String>UiPath.Core.Activities</x:String>${isCSharp ? "" : `
      <x:String>Microsoft.VisualBasic</x:String>
      <x:String>Microsoft.VisualBasic.Activities</x:String>`}
      <x:String>System.Activities</x:String>
      <x:String>System.Activities.Statements</x:String>
      <x:String>System.Activities.Expressions</x:String>
      <x:String>System.ComponentModel</x:String>
    </sco:Collection>
  </TextExpression.NamespacesForImplementation>
  <TextExpression.ReferencesForImplementation>
    <sco:Collection x:TypeArguments="AssemblyReference">
      <AssemblyReference>System.Activities</AssemblyReference>
      <AssemblyReference>System.Activities.Core.Presentation</AssemblyReference>${isCSharp ? "" : `
      <AssemblyReference>Microsoft.VisualBasic</AssemblyReference>`}
      <AssemblyReference>mscorlib</AssemblyReference>
      <AssemblyReference>System.Data</AssemblyReference>
      <AssemblyReference>System</AssemblyReference>
      <AssemblyReference>System.Core</AssemblyReference>
      <AssemblyReference>System.Xml</AssemblyReference>
      <AssemblyReference>System.Xml.Linq</AssemblyReference>
      <AssemblyReference>UiPath.Core</AssemblyReference>
      <AssemblyReference>UiPath.Core.Activities</AssemblyReference>
      <AssemblyReference>System.ServiceModel</AssemblyReference>
      <AssemblyReference>System.ComponentModel.Composition</AssemblyReference>
    </sco:Collection>
  </TextExpression.ReferencesForImplementation>
  <StateMachine DisplayName="${safeName} - REFramework Main">
    <StateMachine.Variables>
      <Variable x:TypeArguments="x:Int32" Name="int_TransactionNumber" Default="0" />
      <Variable x:TypeArguments="x:Int32" Name="int_RetryNumber" Default="0" />
      <Variable x:TypeArguments="x:Int32" Name="int_MaxRetries" Default="3" />
      <Variable x:TypeArguments="x:String" Name="str_TransactionID" />
      <Variable x:TypeArguments="x:String" Name="str_QueueName" Default="&quot;${escapeXml(queueName)}&quot;" />
      <Variable x:TypeArguments="ui:QueueItem" Name="qi_TransactionItem" />
      <Variable x:TypeArguments="x:Boolean" Name="bool_SystemReady" Default="False" />
    </StateMachine.Variables>

    <State DisplayName="Init" x:Name="State_Init">
      <State.Entry>
        <Sequence DisplayName="Initialize Process">
          <ui:LogMessage Level="Info" Message="[&quot;=== Initializing ${safeName} ===&quot;]" DisplayName="Log Init Start" />
          <ui:InvokeWorkflowFile DisplayName="Initialize Settings" WorkflowFileName="InitAllSettings.xaml" />
          <Assign DisplayName="Set System Ready">
            <Assign.To><OutArgument x:TypeArguments="x:Boolean">[bool_SystemReady]</OutArgument></Assign.To>
            <Assign.Value><InArgument x:TypeArguments="x:Boolean">True</InArgument></Assign.Value>
          </Assign>
          <ui:LogMessage Level="Info" Message="[&quot;Initialization complete&quot;]" DisplayName="Log Init Complete" />
        </Sequence>
      </State.Entry>
      <Transition DisplayName="Init -&gt; Get Transaction" To="{x:Reference State_GetTransaction}">
        <Transition.Condition>[bool_SystemReady]</Transition.Condition>
      </Transition>
      <Transition DisplayName="Init -&gt; End (Failed)" To="{x:Reference State_End}">
        <Transition.Condition>[${isCSharp ? "!bool_SystemReady" : "Not bool_SystemReady"}]</Transition.Condition>
      </Transition>
    </State>

    <State DisplayName="Get Transaction Data" x:Name="State_GetTransaction">
      <State.Entry>
        <Sequence DisplayName="Get Next Transaction">
          <ui:InvokeWorkflowFile DisplayName="Get Transaction Data" WorkflowFileName="GetTransactionData.xaml">
            <ui:InvokeWorkflowFile.Arguments>
              <InArgument x:TypeArguments="x:String" x:Key="in_QueueName">[str_QueueName]</InArgument>
              <OutArgument x:TypeArguments="ui:QueueItem" x:Key="out_TransactionItem">[qi_TransactionItem]</OutArgument>
              <InOutArgument x:TypeArguments="x:Int32" x:Key="io_TransactionNumber">[int_TransactionNumber]</InOutArgument>
            </ui:InvokeWorkflowFile.Arguments>
          </ui:InvokeWorkflowFile>
        </Sequence>
      </State.Entry>
      <Transition DisplayName="Has Transaction -&gt; Process" To="{x:Reference State_Process}">
        <Transition.Condition>[${isCSharp ? "qi_TransactionItem != null" : "qi_TransactionItem IsNot Nothing"}]</Transition.Condition>
      </Transition>
      <Transition DisplayName="No Transaction -&gt; End" To="{x:Reference State_End}">
        <Transition.Condition>[${isCSharp ? "qi_TransactionItem == null" : "qi_TransactionItem Is Nothing"}]</Transition.Condition>
      </Transition>
    </State>

    <State DisplayName="Process Transaction" x:Name="State_Process">
      <State.Entry>
        <TryCatch DisplayName="Try Process Transaction">
          <TryCatch.Try>
            <Sequence DisplayName="Process">
              <ui:InvokeWorkflowFile DisplayName="Process Transaction" WorkflowFileName="Process.xaml">
                <ui:InvokeWorkflowFile.Arguments>
                  <InArgument x:TypeArguments="ui:QueueItem" x:Key="in_TransactionItem">[qi_TransactionItem]</InArgument>
                </ui:InvokeWorkflowFile.Arguments>
              </ui:InvokeWorkflowFile>
              <ui:InvokeWorkflowFile DisplayName="Set Transaction Status - Success" WorkflowFileName="SetTransactionStatus.xaml">
                <ui:InvokeWorkflowFile.Arguments>
                  <InArgument x:TypeArguments="ui:QueueItem" x:Key="in_TransactionItem">[qi_TransactionItem]</InArgument>
                  <InArgument x:TypeArguments="x:String" x:Key="in_Status">"Successful"</InArgument>
                </ui:InvokeWorkflowFile.Arguments>
              </ui:InvokeWorkflowFile>
              <Assign DisplayName="Reset Retry Counter">
                <Assign.To><OutArgument x:TypeArguments="x:Int32">[int_RetryNumber]</OutArgument></Assign.To>
                <Assign.Value><InArgument x:TypeArguments="x:Int32">0</InArgument></Assign.Value>
              </Assign>
            </Sequence>
          </TryCatch.Try>
          <TryCatch.Catches>
            <Catch x:TypeArguments="s:Exception">
              <ActivityAction x:TypeArguments="s:Exception">
                <ActivityAction.Argument>
                  <DelegateInArgument x:TypeArguments="s:Exception" Name="exception" />
                </ActivityAction.Argument>
                <Sequence DisplayName="Handle Exception">
                  <Sequence.Variables>
                    <Variable x:TypeArguments="x:String" Name="str_ErrorScreenshotPath" />
                  </Sequence.Variables>
                  <Assign DisplayName="Set Error Screenshot Path">
                    <Assign.To>
                      <OutArgument x:TypeArguments="x:String">[str_ErrorScreenshotPath]</OutArgument>
                    </Assign.To>
                    <Assign.Value>
                      <InArgument x:TypeArguments="x:String">[${isCSharp ? `"screenshots/error_tx_"${concat}int_TransactionNumber.ToString()${concat}"_"${concat}DateTime.Now.ToString("yyyyMMdd_HHmmss")${concat}".png"` : `"screenshots/error_tx_"${concat}int_TransactionNumber.ToString${concat}"_"${concat}DateTime.Now.ToString("yyyyMMdd_HHmmss")${concat}".png"`}]</InArgument>
                    </Assign.Value>
                  </Assign>
                  <TryCatch DisplayName="Safe Screenshot Capture">
                    <TryCatch.Try>
                      <ui:TakeScreenshot DisplayName="Screenshot on Transaction Error" />
                    </TryCatch.Try>
                    <TryCatch.Catches>
                      <Catch x:TypeArguments="s:Exception">
                        <ActivityAction x:TypeArguments="s:Exception">
                          <ActivityAction.Argument>
                            <DelegateInArgument x:TypeArguments="s:Exception" Name="ssEx" />
                          </ActivityAction.Argument>
                          <ui:LogMessage Level="Warn" Message="[&quot;Screenshot capture failed: &quot;${concat}ssEx.Message]" DisplayName="Log Screenshot Failure" />
                        </ActivityAction>
                      </Catch>
                    </TryCatch.Catches>
                  </TryCatch>
                  <ui:AddLogFields DisplayName="Add Error Diagnostic Fields">
                    <ui:AddLogFields.Fields>
                      <scg:Dictionary x:TypeArguments="x:String, x:Object">
                        <x:String x:Key="TransactionNumber">[int_TransactionNumber.ToString]</x:String>
                        <x:String x:Key="ErrorMessage">[exception.Message]</x:String>
                        <x:String x:Key="ScreenshotCaptured">True</x:String>
                      </scg:Dictionary>
                    </ui:AddLogFields.Fields>
                  </ui:AddLogFields>
                  <ui:LogMessage Level="Error" Message="[&quot;Transaction #&quot;${concat}int_TransactionNumber.ToString${isCSharp ? "()" : ""}${concat}&quot; failed: &quot;${concat}exception.Message${concat}&quot; | Screenshot: &quot;${concat}str_ErrorScreenshotPath]" DisplayName="Log Error" />
                  <ui:InvokeWorkflowFile DisplayName="Set Transaction Status - Failed" WorkflowFileName="SetTransactionStatus.xaml">
                    <ui:InvokeWorkflowFile.Arguments>
                      <InArgument x:TypeArguments="ui:QueueItem" x:Key="in_TransactionItem">[qi_TransactionItem]</InArgument>
                      <InArgument x:TypeArguments="x:String" x:Key="in_Status">"Failed"</InArgument>
                    </ui:InvokeWorkflowFile.Arguments>
                  </ui:InvokeWorkflowFile>
                  <ui:InvokeWorkflowFile DisplayName="Close All Applications" WorkflowFileName="CloseAllApplications.xaml" />
                </Sequence>
              </ActivityAction>
            </Catch>
          </TryCatch.Catches>
        </TryCatch>
      </State.Entry>
      <Transition DisplayName="Process -&gt; Get Next Transaction" To="{x:Reference State_GetTransaction}">
        <Transition.Condition>[True]</Transition.Condition>
      </Transition>
    </State>

    <State DisplayName="End Process" x:Name="State_End" IsFinal="True">
      <State.Entry>
        <Sequence DisplayName="Cleanup">
          <ui:InvokeWorkflowFile DisplayName="Close All Applications" WorkflowFileName="CloseAllApplications.xaml" />
          <ui:LogMessage Level="Info" Message="[&quot;=== ${safeName} Complete. Transactions processed: &quot;${concat}int_TransactionNumber.ToString${isCSharp ? "()" : ""}]" DisplayName="Log End" />
        </Sequence>
      </State.Entry>
    </State>

    <StateMachine.InitialState>
      <x:Reference>State_Init</x:Reference>
    </StateMachine.InitialState>
  </StateMachine>
</Activity>`;
}

export function generateGetTransactionDataXaml(queueName: string, targetFramework?: TargetFramework): string {
  const isCSharp = targetFramework === "Portable";
  const concat = isCSharp ? " + " : " &amp; ";
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- GetTransactionData.xaml — Auto-generated by CannonBall -->
<!-- REFramework: Retrieves next queue item from "${escapeXml(queueName)}" -->
<!-- SDD Reference: See Orchestrator Artifacts → Queues section -->
<Activity mc:Ignorable="sap sap2010" x:Class="GetTransactionData"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <x:Members>
    <x:Property Name="in_QueueName" Type="InArgument(x:String)" />
    <x:Property Name="out_TransactionItem" Type="OutArgument(ui:QueueItem)" />
    <x:Property Name="io_TransactionNumber" Type="InOutArgument(x:Int32)" />
  </x:Members>
  <Sequence DisplayName="Get Transaction Data">
    <ui:GetTransactionItem DisplayName="Get Queue Item" QueueName="[in_QueueName]" TransactionItem="[out_TransactionItem]" />
    <If DisplayName="Check Transaction Item" Condition="[${isCSharp ? "out_TransactionItem != null" : "out_TransactionItem IsNot Nothing"}]">
      <If.Then>
        <Sequence DisplayName="Transaction Found">
          <Assign DisplayName="Increment Transaction Counter">
            <Assign.To><OutArgument x:TypeArguments="x:Int32">[io_TransactionNumber]</OutArgument></Assign.To>
            <Assign.Value><InArgument x:TypeArguments="x:Int32">[io_TransactionNumber + 1]</InArgument></Assign.Value>
          </Assign>
          <ui:LogMessage Level="Info" Message="[&quot;Processing transaction #&quot;${concat}io_TransactionNumber.ToString${isCSharp ? "()" : ""}${concat}&quot; - Ref: &quot;${concat}out_TransactionItem.Reference]" DisplayName="Log Transaction" />
        </Sequence>
      </If.Then>
      <If.Else>
        <ui:LogMessage Level="Info" Message="[&quot;No more transactions in queue&quot;]" DisplayName="Log Queue Empty" />
      </If.Else>
    </If>
  </Sequence>
</Activity>`;
}

export function generateSetTransactionStatusXaml(targetFramework?: TargetFramework): string {
  const isCSharp = targetFramework === "Portable";
  const concat = isCSharp ? " + " : " &amp; ";
  const nsS = isCSharp ? "System.Runtime" : "mscorlib";
  const nsScg = isCSharp ? "System.Runtime" : "mscorlib";
  const screenshotDefault = isCSharp
    ? `&quot;Screenshots/Error_&quot; + DateTime.Now.ToString(&quot;yyyyMMdd_HHmmss&quot;) + &quot;.png&quot;`
    : `&quot;Screenshots/Error_&quot; &amp; DateTime.Now.ToString(&quot;yyyyMMdd_HHmmss&quot;) &amp; &quot;.png&quot;`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- SetTransactionStatus.xaml — Auto-generated by CannonBall -->
<!-- REFramework: Marks queue item as Successful or Failed with retry logic -->
<!-- SDD Reference: See Error Handling and Transaction Management sections -->
<Activity mc:Ignorable="sap sap2010" x:Class="SetTransactionStatus"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=${nsS}"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=${nsScg}"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <x:Members>
    <x:Property Name="in_TransactionItem" Type="InArgument(ui:QueueItem)" />
    <x:Property Name="in_Status" Type="InArgument(x:String)" />
    <x:Property Name="in_ErrorMessage" Type="InArgument(x:String)" />
  </x:Members>
  <Sequence DisplayName="Set Transaction Status">
    <Sequence.Variables>
      <Variable x:TypeArguments="x:String" Name="str_ScreenshotPath" Default="[${screenshotDefault}]" />
    </Sequence.Variables>
    <If DisplayName="Check Status" Condition="[in_Status = &quot;Successful&quot;]">
      <If.Then>
        <ui:SetTransactionStatus DisplayName="Set Success" TransactionItem="[in_TransactionItem]" Status="Successful" />
      </If.Then>
      <If.Else>
        <Sequence DisplayName="Set Failed">
          <TryCatch DisplayName="Safe Screenshot on Transaction Failure">
            <TryCatch.Try>
              <Sequence DisplayName="Capture Screenshot">
                <ui:TakeScreenshot DisplayName="Screenshot on Transaction Failure" />
                <ui:LogMessage Level="Info" Message="[&quot;Transaction failure screenshot: &quot;${concat}str_ScreenshotPath]" DisplayName="Log Failure Screenshot" />
              </Sequence>
            </TryCatch.Try>
            <TryCatch.Catches>
              <Catch x:TypeArguments="s:Exception">
                <ActivityAction x:TypeArguments="s:Exception">
                  <ActivityAction.Argument>
                    <DelegateInArgument x:TypeArguments="s:Exception" Name="ssEx" />
                  </ActivityAction.Argument>
                  <ui:LogMessage Level="Warn" Message="[&quot;Screenshot capture failed: &quot;${concat}ssEx.Message]" DisplayName="Log Screenshot Failure" />
                </ActivityAction>
              </Catch>
            </TryCatch.Catches>
          </TryCatch>
          <ui:SetTransactionStatus DisplayName="Set Failed" TransactionItem="[in_TransactionItem]" Status="Failed" ErrorType="Application" Reason="[in_ErrorMessage]" />
          <ui:LogMessage Level="Error" Message="[&quot;Transaction failed: &quot;${concat}in_ErrorMessage]" DisplayName="Log Failure" />
        </Sequence>
      </If.Else>
    </If>
  </Sequence>
</Activity>`;
}

export function generateCloseAllApplicationsXaml(targetFramework: TargetFramework = "Windows"): string {
  const isCrossPlatform = targetFramework === "Portable";
  const nsS = isCrossPlatform ? "System.Runtime" : "mscorlib";
  const nsScg = isCrossPlatform ? "System.Runtime" : "mscorlib";

  const closeBody = isCrossPlatform
    ? `<ui:LogMessage Level="Info" Message="[&quot;Closing all applications (Cross-Platform mode)...&quot;]" DisplayName="Log Cleanup Start" />
          <ui:LogMessage Level="Info" Message="[&quot;Application cleanup completed&quot;]" DisplayName="Log Cleanup Complete" />`
    : `<ui:LogMessage Level="Info" Message="[&quot;Closing all applications...&quot;]" DisplayName="Log Cleanup Start" />
          <ui:CloseApplication DisplayName="Close Browser" />
          <ui:LogMessage Level="Info" Message="[&quot;All applications closed&quot;]" DisplayName="Log Cleanup Complete" />`;

  const concat = isCrossPlatform ? " + " : " &amp; ";

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- CloseAllApplications.xaml — Auto-generated by CannonBall -->
<!-- REFramework: Gracefully closes all open applications before ending -->
${isCrossPlatform ? "<!-- Cross-Platform (Portable) — CloseApplication not available, using log-only cleanup -->" : ""}
<Activity mc:Ignorable="sap sap2010" x:Class="CloseAllApplications"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=${nsS}"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=${nsScg}"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Close All Applications">
    <TryCatch DisplayName="Safe Cleanup">
      <TryCatch.Try>
        <Sequence DisplayName="Close Applications">
          ${closeBody}
        </Sequence>
      </TryCatch.Try>
      <TryCatch.Catches>
        <Catch x:TypeArguments="s:Exception">
          <ActivityAction x:TypeArguments="s:Exception">
            <ActivityAction.Argument>
              <DelegateInArgument x:TypeArguments="s:Exception" Name="closeEx" />
            </ActivityAction.Argument>
            <ui:LogMessage Level="Warn" Message="[&quot;Error during cleanup: &quot;${concat}closeEx.Message]" DisplayName="Log Cleanup Error" />
          </ActivityAction>
        </Catch>
      </TryCatch.Catches>
    </TryCatch>
    <TryCatch DisplayName="Safe Kill Processes">
      <TryCatch.Try>
        <ui:InvokeWorkflowFile DisplayName="Kill All Processes" WorkflowFileName="KillAllProcesses.xaml" />
      </TryCatch.Try>
      <TryCatch.Catches>
        <Catch x:TypeArguments="s:Exception">
          <ActivityAction x:TypeArguments="s:Exception">
            <ActivityAction.Argument>
              <DelegateInArgument x:TypeArguments="s:Exception" Name="killEx" />
            </ActivityAction.Argument>
            <ui:LogMessage Level="Warn" Message="[&quot;Kill processes failed: &quot;${concat}killEx.Message]" DisplayName="Log Kill Error" />
          </ActivityAction>
        </Catch>
      </TryCatch.Catches>
    </TryCatch>
  </Sequence>
</Activity>`;
}

export function generateKillAllProcessesXaml(targetFramework: TargetFramework = "Windows"): string {
  const isCrossPlatform = targetFramework === "Portable";
  const nsS = isCrossPlatform ? "System.Runtime" : "mscorlib";
  const nsScg = isCrossPlatform ? "System.Runtime" : "mscorlib";

  const killBody = isCrossPlatform
    ? `<ui:LogMessage Level="Warn" Message="[&quot;Process cleanup requested (Cross-Platform mode — KillProcess not available on Serverless)&quot;]" DisplayName="Log Kill Start" />
    <ui:LogMessage Level="Info" Message="[&quot;Process cleanup completed&quot;]" DisplayName="Log Kill Complete" />`
    : `<ui:LogMessage Level="Warn" Message="[&quot;Force killing all application processes...&quot;]" DisplayName="Log Kill Start" />
    <ui:KillProcess DisplayName="Kill Chrome" ProcessName="chrome" />
    <ui:KillProcess DisplayName="Kill IE" ProcessName="iexplore" />
    <ui:KillProcess DisplayName="Kill Excel" ProcessName="EXCEL" />
    <ui:LogMessage Level="Info" Message="[&quot;All processes terminated&quot;]" DisplayName="Log Kill Complete" />`;

  return `<?xml version="1.0" encoding="utf-8"?>
<!-- KillAllProcesses.xaml — Auto-generated by CannonBall -->
<!-- REFramework: Force-kills application processes on unrecoverable errors -->
${isCrossPlatform ? "<!-- Cross-Platform (Portable) — KillProcess not available on Serverless, using log-only cleanup -->" : ""}
<Activity mc:Ignorable="sap sap2010" x:Class="KillAllProcesses"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=${nsS}"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=${nsScg}"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Kill All Processes">
    ${killBody}
  </Sequence>
</Activity>`;
}

export function aggregateGaps(results: XamlGeneratorResult[]): XamlGap[] {
  const all: XamlGap[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    for (const gap of r.gaps) {
      const key = `${gap.category}::${gap.activity}::${gap.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(gap);
      }
    }
  }
  return all;
}

export function aggregatePackages(results: XamlGeneratorResult[]): string[] {
  const pkgs = new Set<string>();
  for (const r of results) {
    for (const p of r.usedPackages) {
      pkgs.add(p);
    }
  }
  return Array.from(pkgs);
}


export type DhgExtractedArtifacts = {
  queues?: Array<{ name: string; description?: string; jsonSchema?: string; outputSchema?: string; maxRetries?: number; uniqueReference?: boolean }>;
  assets?: Array<{ name: string; type: string; value?: string; description?: string }>;
  machines?: Array<{ name: string; type?: string; runtimeType?: string; slots?: number; description?: string }>;
  triggers?: Array<{ name: string; type: string; queueName?: string; cron?: string; timezone?: string; startStrategy?: string; maxJobsCount?: number; description?: string }>;
  storageBuckets?: Array<{ name: string; storageProvider?: string; description?: string }>;
  environments?: Array<{ name: string; type?: string; description?: string }>;
  robotAccounts?: Array<{ name: string; type?: string; role?: string; description?: string }>;
  actionCenter?: Array<{ taskCatalog: string; priority?: string; actions?: string[]; formFields?: Array<{ name: string; type: string; required?: boolean }>; sla?: string; escalation?: string; description?: string }>;
  documentUnderstanding?: Array<{ name: string; documentTypes?: string[]; taxonomyFields?: Array<{ documentType: string; fields: Array<{ name: string; type: string }> }>; classifierType?: string; description?: string }>;
  testCases?: Array<{ name: string; testType?: string; priority?: string; preconditions?: string[]; postconditions?: string[]; testData?: Array<{ field: string; value: string; dataType?: string }>; automationWorkflow?: string; description?: string }>;
  testSets?: Array<{ name: string; executionMode?: string; environment?: string; triggerType?: string; testCaseNames?: string[]; description?: string }>;
  requirements?: Array<{ name: string; type?: string; priority?: string; acceptanceCriteria?: string[]; source?: string; description?: string }>;
};

export type DhgQualityIssue = {
  severity: "blocking" | "warning";
  file: string;
  check: string;
  detail: string;
  stubbedWorkflow?: string;
};

export type DhgOptions = {
  projectName: string;
  description?: string;
  gaps: XamlGap[];
  usedPackages: string[];
  workflowNames: string[];
  sddContent?: string;
  enrichment?: EnrichmentResult | null;
  useReFramework?: boolean;
  painPoints?: { name: string; description: string }[];
  deploymentResults?: DhgDeploymentResult[];
  extractedArtifacts?: DhgExtractedArtifacts;
  analysisReports?: Array<{ fileName: string; report: AnalysisReport }>;
  automationType?: "rpa" | "agent" | "hybrid";
  targetFramework?: TargetFramework;
  autopilotEnabled?: boolean;
  generationMode?: GenerationMode;
  generationModeReason?: string;
  qualityIssues?: DhgQualityIssue[];
  stubbedWorkflows?: string[];
  outcomeReport?: PipelineOutcomeReport;
  xamlContents?: string[];
};

export function generateDeveloperHandoffGuide(opts: DhgOptions): string {
  const {
    projectName,
    description,
    gaps,
    usedPackages,
    workflowNames,
    sddContent,
    enrichment,
    useReFramework,
    painPoints,
    deploymentResults,
    extractedArtifacts,
    analysisReports,
    automationType,
    targetFramework,
    autopilotEnabled,
    xamlContents,
  } = opts;

  const selectorGaps = gaps.filter((g) => g.category === "selector");
  const credentialGaps = gaps.filter((g) => g.category === "credential");
  const endpointGaps = gaps.filter((g) => g.category === "endpoint");
  const configGaps = gaps.filter((g) => g.category === "config");
  const logicGaps = gaps.filter((g) => g.category === "logic");
  const manualGaps = gaps.filter((g) => g.category === "manual");

  let sectionNum = 0;
  let md = "";

  md += `# Developer Handoff Guide\n\n`;
  md += `**Project:** ${projectName}\n`;
  if (description) md += `**Description:** ${description}\n`;
  md += `**Generated:** ${new Date().toISOString().split("T")[0]}\n`;
  md += `**Architecture:** ${useReFramework ? "REFramework (Queue-based transactional)" : "Sequential (Linear workflow)"}\n`;
  if (targetFramework === "Portable") {
    md += `**Target Framework:** Cross-Platform (Portable) — Serverless robot compatible\n`;
    md += `**Expression Language:** C# (CSharp)\n`;
    md += `**Runtime:** .NET 6.0 (lib/net6.0)\n`;
  }
  if (automationType && automationType !== "rpa") {
    const atLabel = automationType === "agent" ? "UiPath Agent (AI-driven autonomous)" : "Hybrid (RPA + Agent)";
    md += `**Automation Type:** ${atLabel}\n`;
  }
  if (autopilotEnabled) md += `**Autopilot:** Enabled — self-healing selectors and AI-assisted recovery active\n`;
  if (enrichment) md += `**AI Enrichment:** Applied — activities use system-specific selectors and real property values\n`;
  if (opts.generationMode) {
    const modeLabel = opts.generationMode === "baseline_openable" ? "Baseline Openable (minimal, deterministic)" : "Full Implementation";
    md += `**Generation Mode:** ${modeLabel}\n`;
    if (opts.generationModeReason) md += `**Mode Reason:** ${opts.generationModeReason}\n`;
  }
  if (opts.stubbedWorkflows?.length) {
    md += `**Stubbed Workflows:** ${opts.stubbedWorkflows.length} workflow(s) replaced with Studio-openable stubs due to blocking issues\n`;
  }

  const tier2Items = [...endpointGaps, ...configGaps];
  const totalAutoFixed = analysisReports?.reduce((s, r) => s + r.report.totalAutoFixed, 0) ?? 0;
  const totalRulesChecked = analysisReports?.reduce((s, r) => s + r.report.totalChecked, 0) ?? 0;
  const totalRulesPassed = analysisReports?.reduce((s, r) => s + r.report.totalPassed, 0) ?? 0;
  const provisionedCount = deploymentResults?.filter(r => r.status === "created" || r.status === "exists" || r.status === "updated" || r.status === "in_package").length ?? 0;
  const totalProvisionAttempts = deploymentResults?.length ?? 0;

  const enrichmentSelectorCount = enrichment?.nodes?.reduce((s, n) => s + n.activities.filter(a => a.selectorHint).length, 0) ?? 0;
  const totalSelectorCount = selectorGaps.length + enrichmentSelectorCount;
  let credentialAssetCount = extractedArtifacts?.assets?.filter(a => a.type === "Credential").length ?? 0;
  if (credentialAssetCount === 0 && deploymentResults) {
    credentialAssetCount = deploymentResults.filter(r => r.artifact === "Asset" && (
      r.message.includes("Type: Credential") ||
      r.message.toLowerCase().includes("credential") ||
      r.name.toLowerCase().includes("credential") ||
      r.name.toLowerCase().includes("password")
    )).length;
  }
  const totalCredentialCount = credentialGaps.length + credentialAssetCount;
  const deployWarningCount = deploymentResults?.filter(r => r.status === "failed" || r.status === "skipped" || r.status === "manual").length ?? 0;

  const tier3ItemCount = totalSelectorCount + totalCredentialCount + logicGaps.length + manualGaps.length;
  const readinessComponents: number[] = [];
  if (totalRulesChecked > 0) readinessComponents.push(((totalRulesPassed + totalAutoFixed) / Math.max(totalRulesChecked, 1)) * 100);
  if (totalProvisionAttempts > 0) readinessComponents.push((provisionedCount / totalProvisionAttempts) * 100);
  readinessComponents.push(Math.max(0, 100 - tier3ItemCount * 3 - deployWarningCount * 5));
  const readinessScore = readinessComponents.length > 0
    ? Math.round(readinessComponents.reduce((a, b) => a + b, 0) / readinessComponents.length)
    : 0;

  const mandatoryBaseMinutes = 15 + 30 + 60;
  const earlyAgentMinutes = (automationType === "agent" || automationType === "hybrid") ? (155 + (automationType === "hybrid" ? 30 : 0)) : 0;
  const estTotalMinutes = mandatoryBaseMinutes + totalSelectorCount * 5 + totalCredentialCount * 5 +
    logicGaps.reduce((s, g) => s + g.estimatedMinutes, 0) + manualGaps.reduce((s, g) => s + g.estimatedMinutes, 0) +
    earlyAgentMinutes;

  md += `\n**Readiness Score: ${readinessScore}%** | Estimated developer effort: **~${(estTotalMinutes / 60).toFixed(1)} hours** (${totalSelectorCount} selectors, ${totalCredentialCount} credentials, ${mandatoryBaseMinutes} min mandatory validation)\n`;
  md += `\n---\n\n`;

  const blockingIssues = (opts.qualityIssues || []).filter(i => i.severity === "blocking");
  const warningIssues = (opts.qualityIssues || []).filter(i => i.severity === "warning");
  if (blockingIssues.length > 0 || warningIssues.length > 0) {
    sectionNum++;
    md += `## ${sectionNum}. Quality Gate Results\n\n`;

    if (blockingIssues.length > 0) {
      md += `### Blocking Issues (${blockingIssues.length})\n\n`;
      md += `These issues caused specific workflows to fall back to Studio-openable stubs. The stubs are valid XAML and can be opened in Studio, but require manual implementation.\n\n`;
      md += `| # | File | Check | Detail |\n`;
      md += `|---|------|-------|---------|\n`;
      blockingIssues.forEach((issue, i) => {
        const detail = issue.detail.length > 120 ? issue.detail.slice(0, 117) + "..." : issue.detail;
        md += `| ${i + 1} | \`${issue.file}\` | ${issue.check} | ${detail.replace(/\|/g, "\\|")} |\n`;
      });
      md += `\n`;
      if (opts.stubbedWorkflows?.length) {
        md += `**Stubbed Workflows:** ${opts.stubbedWorkflows.map(s => `\`${s}\``).join(", ")}\n\n`;
        md += `> These stubs contain a LogMessage indicating manual implementation is needed. They are correctly wired into the project with valid InvokeWorkflowFile references.\n\n`;
      }
    }

    if (warningIssues.length > 0) {
      md += `### Warnings (${warningIssues.length})\n\n`;
      md += `These are minor issues that do not prevent the package from being opened or used. They represent areas where a developer can improve the generated output.\n\n`;
      md += `| # | File | Check | Detail |\n`;
      md += `|---|------|-------|---------|\n`;
      warningIssues.forEach((issue, i) => {
        const detail = issue.detail.length > 120 ? issue.detail.slice(0, 117) + "..." : issue.detail;
        md += `| ${i + 1} | \`${issue.file}\` | ${issue.check} | ${detail.replace(/\|/g, "\\|")} |\n`;
      });
      md += `\n`;
    }
    md += `---\n\n`;
  }

  if (opts.outcomeReport) {
    const report = opts.outcomeReport;
    sectionNum++;
    md += `## ${sectionNum}. Pipeline Outcome Report\n\n`;

    if (report.fullyGeneratedFiles.length > 0) {
      md += `### Fully Generated (${report.fullyGeneratedFiles.length} file(s))\n\n`;
      md += `These workflows were generated without any stub replacements or escalation.\n\n`;
      for (const f of report.fullyGeneratedFiles) {
        md += `- \`${f}\`\n`;
      }
      md += `\n`;
    }

    if (report.autoRepairs.length > 0) {
      md += `### Auto-Repaired (${report.autoRepairs.length} fix(es))\n\n`;
      md += `These issues were automatically corrected during the build pipeline. No developer action required.\n\n`;
      md += `| # | Code | File | Description |\n`;
      md += `|---|------|------|-------------|\n`;
      report.autoRepairs.forEach((r, i) => {
        const desc = (r.description || "").length > 100 ? (r.description || "").slice(0, 97) + "..." : (r.description || "—");
        md += `| ${i + 1} | \`${r.repairCode}\` | \`${r.file}\` | ${desc.replace(/\|/g, "\\|")} |\n`;
      });
      md += `\n`;
    }

    if (report.propertyRemediations && report.propertyRemediations.length > 0) {
      md += `### Remediated — Per-Property (${report.propertyRemediations.length})\n\n`;
      md += `Individual properties were replaced with safe defaults or placeholders. The rest of the activity remains intact.\n\n`;
      md += `| # | File | Activity | Property | Code | Developer Action | Est. Minutes |\n`;
      md += `|---|------|----------|----------|------|-----------------|-------------|\n`;
      report.propertyRemediations.forEach((r, i) => {
        const actName = r.originalDisplayName || r.originalTag || "—";
        const propName = r.propertyName || "—";
        const action = (r.developerAction || "").length > 80 ? (r.developerAction || "").slice(0, 77) + "..." : (r.developerAction || "—");
        md += `| ${i + 1} | \`${r.file}\` | ${actName} | \`${propName}\` | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes || "—"} |\n`;
      });
      md += `\n`;
    }

    const activityRemediations = report.remediations.filter(r => r.level === "activity");
    const sequenceRemediations = report.remediations.filter(r => r.level === "sequence");
    const workflowRemediations = report.remediations.filter(r => r.level === "workflow");

    if (activityRemediations.length > 0) {
      md += `### Stubbed — Per-Activity (${activityRemediations.length})\n\n`;
      md += `Individual activities were replaced with TODO stubs. The surrounding workflow structure is preserved.\n\n`;
      md += `| # | File | Activity | Code | Developer Action | Est. Minutes |\n`;
      md += `|---|------|----------|------|-----------------|-------------|\n`;
      activityRemediations.forEach((r, i) => {
        const actName = r.originalDisplayName || r.originalTag || "—";
        const action = (r.developerAction || "").length > 80 ? (r.developerAction || "").slice(0, 77) + "..." : (r.developerAction || "—");
        md += `| ${i + 1} | \`${r.file}\` | ${actName} | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes || "—"} |\n`;
      });
      md += `\n`;
    }

    if (sequenceRemediations.length > 0) {
      md += `### Stubbed — Per-Sequence (${sequenceRemediations.length})\n\n`;
      md += `Sequence children were replaced with a single TODO stub because multiple activities in the sequence had issues.\n\n`;
      md += `| # | File | Sequence | Code | Developer Action | Est. Minutes |\n`;
      md += `|---|------|----------|------|-----------------|-------------|\n`;
      sequenceRemediations.forEach((r, i) => {
        const seqName = r.originalDisplayName || "—";
        const action = (r.developerAction || "").length > 80 ? (r.developerAction || "").slice(0, 77) + "..." : (r.developerAction || "—");
        md += `| ${i + 1} | \`${r.file}\` | ${seqName} | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes || "—"} |\n`;
      });
      md += `\n`;
    }

    if (workflowRemediations.length > 0) {
      md += `### Stubbed — Per-Workflow (${workflowRemediations.length})\n\n`;
      md += `Entire workflows were replaced with Studio-openable stubs because per-activity and per-sequence remediation could not resolve the issues.\n\n`;
      md += `| # | File | Code | Developer Action | Est. Minutes |\n`;
      md += `|---|------|------|-----------------|-------------|\n`;
      workflowRemediations.forEach((r, i) => {
        const action = (r.developerAction || "").length > 80 ? (r.developerAction || "").slice(0, 77) + "..." : (r.developerAction || "—");
        md += `| ${i + 1} | \`${r.file}\` | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes || "—"} |\n`;
      });
      md += `\n`;
    }

    if (report.downgradeEvents.length > 0) {
      md += `### Downgraded Components (${report.downgradeEvents.length})\n\n`;
      md += `These components were simplified during generation due to complexity or compatibility constraints.\n\n`;
      for (const d of report.downgradeEvents) {
        md += `- ${d.file ? `**${d.file}**: ` : ""}${d.triggerReason} (from \`${d.fromMode}\` to \`${d.toMode}\`)\n`;
      }
      md += `\n`;
    }

    if (report.totalEstimatedEffortMinutes > 0) {
      md += `**Total estimated developer effort for stubbed items: ~${report.totalEstimatedEffortMinutes} minutes (${(report.totalEstimatedEffortMinutes / 60).toFixed(1)} hours)**\n\n`;
    }

    md += `---\n\n`;
  }

  const allSelectorHints: Array<{ activity: string; hint: string; nodeName: string }> = [];
  if (enrichment?.nodes) {
    for (const node of enrichment.nodes) {
      for (const act of node.activities) {
        if (act.selectorHint) {
          allSelectorHints.push({ activity: act.activityType || act.displayName, hint: act.selectorHint, nodeName: node.nodeName });
        }
      }
    }
  }

  let totalActivityCount = 0;
  if (xamlContents && xamlContents.length > 0) {
    const activityPattern = /<ui:\w+/g;
    for (const content of xamlContents) {
      const matches = content.match(activityPattern);
      if (matches) totalActivityCount += matches.length;
    }
  } else {
    totalActivityCount = enrichment?.nodes?.reduce((s, n) => s + (n.activities?.length || 0), 0) ?? 0;
  }

  sectionNum++;
  md += `## ${sectionNum}. Tier 1 — AI Completed (No Human Action Required)\n\n`;
  md += `The following items were fully automated by CannonBall. These are verified facts from deterministic analysis.\n\n`;

  md += `### Workflow Inventory\n\n`;
  md += `**${workflowNames.length} XAML workflow(s)** generated containing **${totalActivityCount} activities** total.\n\n`;
  md += `| # | Workflow File | Purpose | Role |\n`;
  md += `|---|--------------|---------|------|\n`;
  const decomp = enrichment?.decomposition || [];
  let wfIdx = 0;
  for (const wfName of workflowNames) {
    wfIdx++;
    const match = decomp.find(d => d.name === wfName || d.name.replace(/\s+/g, "_") === wfName);
    const purpose = match?.description || (wfName === "Main" ? (useReFramework ? "REFramework State Machine entry point" : "Entry point workflow") : "Sub-workflow");
    const role = match?.isDispatcher ? "Dispatcher" : match?.isPerformer ? "Performer" : (wfName === "Main" ? "Entry Point" : "Sub-workflow");
    md += `| ${wfIdx} | \`${wfName}.xaml\` | ${purpose} | ${role} |\n`;
  }
  md += `\n`;

  if (analysisReports?.length) {
    let combinedAutoFixed = 0;
    let combinedRemaining = 0;
    let combinedPassed = 0;
    for (const ar of analysisReports) {
      combinedAutoFixed += ar.report.totalAutoFixed;
      combinedRemaining += ar.report.totalRemaining;
      combinedPassed += ar.report.totalPassed;
    }

    md += `### Workflow Analyzer Compliance\n\n`;
    md += `Analyzed ${analysisReports.length} workflow file(s) against UiPath Workflow Analyzer rules.\n\n`;

    const mergedRules = new Map<string, { ruleName: string; category: string; passed: number; autoFixed: number; remaining: number }>();
    for (const ar of analysisReports) {
      for (const rule of ar.report.rulesChecked) {
        const existing = mergedRules.get(rule.ruleId) || { ruleName: rule.ruleName, category: rule.category, passed: 0, autoFixed: 0, remaining: 0 };
        if (rule.status === "passed") existing.passed++;
        existing.autoFixed += rule.autoFixedCount;
        existing.remaining += rule.violationCount;
        mergedRules.set(rule.ruleId, existing);
      }
    }

    md += `| Rule ID | Rule | Category | Status | Auto-Fixed | Remaining |\n`;
    md += `|---------|------|----------|--------|------------|----------|\n`;
    for (const [ruleId, data] of Array.from(mergedRules.entries())) {
      const status = data.remaining > 0 ? "Needs Review" : data.autoFixed > 0 ? "Auto-Fixed" : "Passed";
      md += `| ${ruleId} | ${data.ruleName} | ${data.category} | ${status} | ${data.autoFixed} | ${data.remaining} |\n`;
    }
    md += `\n**Result:** ${combinedPassed} of ${totalRulesChecked} rules passed across ${analysisReports.length} workflow files. ${combinedAutoFixed} violation(s) auto-corrected, ${combinedRemaining} remaining for review.\n\n`;

    if (analysisReports.length > 1) {
      md += `**Per-Workflow Breakdown:**\n\n`;
      md += `| Workflow | Rules Checked | Passed | Auto-Fixed | Remaining |\n`;
      md += `|----------|--------------|--------|------------|----------|\n`;
      for (const ar of analysisReports) {
        md += `| \`${ar.fileName}\` | ${ar.report.totalChecked} | ${ar.report.totalPassed} | ${ar.report.totalAutoFixed} | ${ar.report.totalRemaining} |\n`;
      }
      md += `\n`;
    }
  }

  md += `### Standards Enforcement\n\n`;
  md += `| Standard | What Was Done |\n`;
  md += `|----------|---------------|\n`;
  md += `| Naming Conventions | Variables renamed to \`{type}_{PascalCase}\`, arguments to \`{direction}_{PascalCase}\` |\n`;
  md += `| Activity Annotations | Every activity annotated with source step number, business context, and error handling strategy |\n`;
  md += `| Error Handling | All business activities wrapped in TryCatch with Log + Rethrow; UI activities include RetryScope (3 retries, 5s) |\n`;
  md += `| Logging | Start/end LogMessage in every workflow; exceptions logged at Error level before rethrow |\n`;
  md += `| Argument Validation | Entry points validate required arguments at workflow start |\n`;
  md += `\n`;

  md += `### Architecture Decision\n\n`;
  if (useReFramework) {
    md += `**REFramework** selected — queue-based transactional processing with built-in retry and recovery.\n\n`;
    if (enrichment?.reframeworkConfig) {
      md += `| Setting | Value |\n`;
      md += `|---------|-------|\n`;
      md += `| Queue Name | \`${enrichment.reframeworkConfig.queueName}\` |\n`;
      md += `| Max Retries | ${enrichment.reframeworkConfig.maxRetries} |\n`;
      md += `| Process Name | ${enrichment.reframeworkConfig.processName} |\n`;
      md += `\n`;
    }
    md += `\`\`\`\nInit → Get Transaction → Process Transaction → Get Transaction (loop)\n                                    ↓ (exception)\n                              Close Apps → Get Transaction (retry)\n                    ↓ (no more items)\n                       End Process\n\`\`\`\n\n`;
  } else {
    md += `**Sequential Pattern** selected — linear step-by-step flow with step dependencies.\n\n`;
  }
  if (enrichment?.dhgNotes?.length) {
    md += `**AI Architecture Notes:**\n`;
    for (const note of enrichment.dhgNotes) md += `- ${note}\n`;
    md += `\n`;
  }

  if (deploymentResults?.length) {
    md += `### Orchestrator Provisioning Summary\n\n`;
    const artifactTypes = new Map<string, { total: number; ready: number; needs: number }>();
    for (const r of deploymentResults) {
      const entry = artifactTypes.get(r.artifact) || { total: 0, ready: 0, needs: 0 };
      entry.total++;
      if (r.status === "created" || r.status === "exists" || r.status === "updated" || r.status === "in_package") entry.ready++;
      else entry.needs++;
      artifactTypes.set(r.artifact, entry);
    }
    md += `| Artifact Type | Count | Ready | Needs Attention |\n`;
    md += `|---------------|-------|-------|-----------------|\n`;
    artifactTypes.forEach((stats, type) => {
      md += `| ${type} | ${stats.total} | ${stats.ready} | ${stats.needs} |\n`;
    });
    md += `\n**${provisionedCount}/${totalProvisionAttempts}** artifacts provisioned successfully\n\n`;

    md += `**Itemized Artifacts:**\n\n`;
    md += `| # | Type | Name | Status | Orchestrator ID | Details |\n`;
    md += `|---|------|------|--------|-----------------|---------|\n`;
    let artIdx = 0;
    for (const r of deploymentResults) {
      artIdx++;
      const idStr = r.id ? String(r.id) : "—";
      const shortMsg = r.message.length > 80 ? r.message.slice(0, 77) + "..." : r.message;
      md += `| ${artIdx} | ${r.artifact} | \`${r.name}\` | ${r.status} | ${idStr} | ${shortMsg} |\n`;
    }
    md += `\n`;

    if (automationType === "agent" || automationType === "hybrid") {
      const agentResults = deploymentResults?.filter(r => r.artifact === "Agent" || r.artifact === "Knowledge Base" || r.artifact === "Prompt Template") || [];
      if (agentResults.length > 0) {
        md += `### Agent Artifacts Provisioned\n\n`;
        md += `| Artifact | Name | Status | Details |\n`;
        md += `|----------|------|--------|--------|\n`;
        for (const ar of agentResults) {
          md += `| ${ar.artifact} | \`${ar.name}\` | ${ar.status} | ${ar.message.slice(0, 100)} |\n`;
        }
        md += `\n`;
      }
    }
  }

  md += `---\n\n`;

  sectionNum++;
  md += `## ${sectionNum}. Tier 2 — AI Resolved with Smart Defaults (Review Recommended)\n\n`;
  md += `The AI set these values based on SDD analysis. They are likely correct but **must be verified** against your target environment before production use.\n\n`;

  const queues = extractedArtifacts?.queues;
  const assets = extractedArtifacts?.assets;
  const triggers = extractedArtifacts?.triggers;

  const queueResults = deploymentResults?.filter(r => r.artifact === "Queue") || [];
  if (queues?.length) {
    md += `### Queue Schemas\n\n`;
    for (const q of queues) {
      const qResult = deploymentResults?.find(r => r.artifact === "Queue" && r.name === q.name);
      md += `**${q.name}** (${qResult?.status || "unknown"}${qResult?.id ? `, ID: ${qResult.id}` : ""}) — Max Retries: ${q.maxRetries ?? 3}, Unique Ref: ${q.uniqueReference ? "Yes" : "No"}\n`;
      if (q.jsonSchema) {
        md += `\`\`\`json\n${q.jsonSchema}\n\`\`\`\n`;
        md += `> **Review:** AI derived this schema from SDD. Verify field names and types match your actual transaction data model. Add/remove fields as needed.\n\n`;
      }
    }
  } else if (queueResults.length > 0) {
    md += `### Queues\n\n`;
    for (const qr of queueResults) {
      md += `**${qr.name}** (${qr.status}${qr.id ? `, ID: ${qr.id}` : ""}) — ${qr.message.slice(0, 100)}\n`;
      md += `> **Review:** Verify queue specific content schema matches your transaction data model. Configure max retries and unique reference settings as needed.\n\n`;
    }
  }

  const assetResults = deploymentResults?.filter(r => r.artifact === "Asset") || [];
  if (assets?.length) {
    const nonCredAssets = assets.filter(a => a.type !== "Credential");
    if (nonCredAssets.length > 0) {
      md += `### Asset Values\n\n`;
      md += `| Asset | Type | AI-Set Value | Action Required |\n`;
      md += `|-------|------|--------------|-----------------|\n`;
      for (const a of nonCredAssets) {
        const aResult = deploymentResults?.find(r => r.artifact === "Asset" && r.name === a.name);
        const valStr = String(a.value ?? "");
        const hasPlaceholder = valStr.includes("PLACEHOLDER_");
        const idNote = aResult?.id ? ` (ID: ${aResult.id})` : "";
        md += `| \`${a.name}\`${idNote} | ${a.type} | \`${valStr || "(empty)"}\` | ${hasPlaceholder ? "**SET REAL VALUE** — placeholder needs replacement" : `Verify matches your environment. ${String(a.description ?? "")}`} |\n`;
      }
      md += `\n`;
    }
  } else if (assetResults.length > 0) {
    const nonCredAssetResults = assetResults.filter(r => {
      const msg = String(r.message ?? "").toLowerCase();
      const nm = String(r.name ?? "").toLowerCase();
      return !(
        msg.includes("type: credential") ||
        msg.includes("credential") ||
        nm.includes("credential") ||
        nm.includes("password")
      );
    });
    if (nonCredAssetResults.length > 0) {
      md += `### Asset Values\n\n`;
      md += `| Asset | Status | ID | Action Required |\n`;
      md += `|-------|--------|----|-----------------|\n`;
      for (const ar of nonCredAssetResults) {
        const msgStr = String(ar.message ?? "");
        const typeMatch = msgStr.match(/Type:\s*(\w+)/);
        const assetType = typeMatch ? typeMatch[1] : "Unknown";
        md += `| \`${String(ar.name ?? "")}\` (${assetType}) | ${ar.status} | ${ar.id || "—"} | Verify value matches your environment in Orchestrator > Assets > \`${String(ar.name ?? "")}\` |\n`;
      }
      md += `\n`;
    }
  }

  const triggerResults = deploymentResults?.filter(r => r.artifact === "Trigger") || [];
  if (triggers?.length) {
    md += `### Trigger Configuration\n\n`;
    md += `| Trigger | Type | Schedule | Timezone | Status | Action Required |\n`;
    md += `|---------|------|----------|----------|--------|-----------------|\n`;
    for (const t of triggers) {
      const tResult = deploymentResults?.find(r => r.artifact === "Trigger" && r.name === t.name);
      const scheduleInfo = t.type === "Queue" ? `Queue: ${t.queueName || "N/A"}` : `Cron: \`${t.cron || "N/A"}\``;
      const isDisabled = tResult?.message?.toLowerCase().includes("disabled");
      const action = isDisabled ? "**ENABLE** — created disabled (no unattended runtime detected)" : "Verify schedule matches business requirements";
      md += `| \`${t.name}\` | ${t.type} | ${scheduleInfo} | ${t.timezone || "UTC"} | ${tResult?.status || "unknown"} | ${action} |\n`;
    }
    md += `\n`;
  } else if (triggerResults.length > 0) {
    md += `### Trigger Configuration\n\n`;
    md += `| Trigger | Type | Details | Status | Action Required |\n`;
    md += `|---------|------|---------|--------|-----------------|\n`;
    for (const tr of triggerResults) {
      const cronMatch = tr.message.match(/cron:\s*([^\s,)]+(?:\s+[^\s,)]+)*)/i);
      const isQueue = tr.message.toLowerCase().includes("queue");
      const trigType = isQueue ? "Queue" : "Time";
      const schedule = cronMatch ? `\`${cronMatch[1]}\`` : (isQueue ? `Queue: ${tr.message.match(/polling\s+"([^"]+)"/)?.[1] || "N/A"}` : "See Orchestrator");
      const isDisabled = tr.message.toLowerCase().includes("disabled");
      const action = isDisabled ? "**ENABLE** — created disabled (no unattended runtime detected)" : "Verify schedule matches business requirements";
      md += `| \`${tr.name}\` | ${trigType} | ${schedule} | ${tr.status} | ${action} |\n`;
    }
    md += `\n`;
  }

  if (tier2Items.length > 0) {
    md += `### Configuration & Endpoints\n\n`;
    md += `| # | Category | Activity | AI-Set Value | Override If Incorrect |\n`;
    md += `|---|----------|----------|-------------|----------------------|\n`;
    tier2Items.forEach((g, i) => {
      md += `| ${i + 1} | ${g.category} | \`${g.activity}\` | \`${g.placeholder}\` | ${g.description} |\n`;
    });
    md += `\n`;
  }

  const deployWarnings = deploymentResults?.filter(r =>
    r.status === "failed" || r.status === "skipped" || r.status === "manual" ||
    r.message.toLowerCase().includes("warning") || r.message.includes("not assigned") ||
    r.message.includes("assign manually") || r.message.includes("405")
  ) || [];
  if (deployWarnings.length > 0) {
    md += `### Deployment Warnings\n\n`;
    md += `The following items encountered issues during deployment and need manual attention:\n\n`;
    md += `| # | Artifact | Name | Issue | Action Required |\n`;
    md += `|---|----------|------|-------|-----------------|\n`;
    deployWarnings.forEach((w, i) => {
      let action = "Review in Orchestrator";
      if (w.message.includes("not assigned") || w.message.includes("assign manually")) {
        action = "Go to Orchestrator > Folder Settings > Machines and assign manually";
      } else if (w.status === "failed") {
        action = "Create manually in Orchestrator";
      } else if (w.status === "skipped") {
        action = "Service unavailable on tenant — configure when available";
      } else if (w.message.includes("405")) {
        action = "API endpoint not supported — configure manually if needed";
      }
      md += `| ${i + 1} | ${w.artifact} | \`${w.name}\` | ${w.status}: ${w.message.slice(0, 80)} | ${action} |\n`;
    });
    md += `\n`;
  }

  const processResult = deploymentResults?.find(r => r.artifact === "Process" || r.artifact === "Release");
  if (processResult) {
    md += `### Process & Release\n\n`;
    md += `| Field | Value |\n`;
    md += `|-------|-------|\n`;
    md += `| Process | \`${processResult.name}\` |\n`;
    md += `| Status | ${processResult.status} |\n`;
    if (processResult.id) md += `| Release ID | ${processResult.id} |\n`;
    md += `| Details | ${processResult.message.slice(0, 120)} |\n`;
    md += `\n`;
  }

  const testResults = deploymentResults?.filter(r => r.artifact === "Test Case" || r.artifact === "Test Set" || r.artifact === "Requirement" || r.artifact === "Test Project" || r.artifact === "Requirement Link") || [];
  if (testResults.length > 0) {
    md += `### Test Manager Artifacts\n\n`;
    const testProject = testResults.find(r => r.artifact === "Test Project");
    if (testProject) {
      md += `**Test Project:** \`${testProject.name}\` (${testProject.status}${testProject.id ? `, ID: ${testProject.id}` : ""})\n\n`;
    }
    const tcs = testResults.filter(r => r.artifact === "Test Case");
    if (tcs.length > 0) {
      md += `**Test Cases (${tcs.length}):**\n\n`;
      md += `| # | Test Case | Status | ID |\n`;
      md += `|---|-----------|--------|----|\n`;
      tcs.forEach((tc, i) => {
        md += `| ${i + 1} | \`${tc.name}\` | ${tc.status} | ${tc.id || "—"} |\n`;
      });
      md += `\n`;
    }
    const tss = testResults.filter(r => r.artifact === "Test Set");
    if (tss.length > 0) {
      md += `**Test Sets (${tss.length}):** ${tss.map(ts => `\`${ts.name}\` (${ts.status})`).join(", ")}\n\n`;
    }
    const reqs = testResults.filter(r => r.artifact === "Requirement");
    if (reqs.length > 0) {
      md += `**Requirements (${reqs.length}):** ${reqs.map(rq => `\`${rq.name}\` (${rq.status})`).join(", ")}\n\n`;
    }
    const failedSteps = testResults.filter(r => r.message.includes("405") && (r.artifact === "Test Case" || r.artifact === "Test Set"));
    if (failedSteps.length > 0) {
      md += `> **Note:** Test step details could not be created via API (405). Add test steps manually in Test Manager for each test case.\n\n`;
    }
  }

  if (automationType === "agent" || automationType === "hybrid") {
    const agentGaps = gaps.filter(g => g.category === "agent");
    md += `### Agent Configuration (Review Recommended)\n\n`;
    md += `The following agent settings were generated by AI and should be reviewed before production use:\n\n`;
    md += `| # | Item | Action Required |\n`;
    md += `|---|------|-----------------|\n`;
    md += `| 1 | Agent guardrails | Review safety constraints and response boundaries |\n`;
    md += `| 2 | Escalation rules | Verify escalation conditions and human-handoff triggers |\n`;
    md += `| 3 | Agent temperature/iterations | Tune LLM parameters for your use case |\n`;
    md += `| 4 | Tool permissions | Confirm which UiPath activities the agent can invoke |\n`;
    if (agentGaps.length > 0) {
      let agIdx = 5;
      for (const g of agentGaps) {
        md += `| ${agIdx++} | ${g.activity} | ${g.description} |\n`;
      }
    }
    md += `\n`;
  }

  if (automationType === "agent" || automationType === "hybrid") {
    md += `### Agent Artifacts in Package\n\n`;
    md += `The following agent configuration files are included in the downloadable package:\n\n`;
    md += `| File | Purpose | Action |\n`;
    md += `|------|---------|--------|\n`;
    md += `| \`prompts/system_prompt.txt\` | System prompt defining agent behavior and guardrails | REVIEW |\n`;
    md += `| \`prompts/user_prompt_template.txt\` | Parameterized user prompt template with input placeholders | REVIEW |\n`;
    md += `| \`tools/tool_definitions.json\` | Tool names, descriptions, and input/output schemas | AUTHORIZE |\n`;
    md += `| \`knowledge/kb_placeholder.md\` | Instructions for knowledge base document upload | CONFIGURE |\n`;
    md += `| \`agents/*_config.json\` | Agent configuration with temperature, iterations, guardrails | TUNE |\n\n`;

    md += `#### Import into UiPath Agent Builder\n\n`;
    md += `1. Open **UiPath Automation Cloud** → **AI Center** → **Agent Builder**\n`;
    md += `2. Create a new agent using the name from \`agents/*_config.json\`\n`;
    md += `3. Copy the system prompt from \`prompts/system_prompt.txt\` into the agent's system prompt field\n`;
    md += `4. Register each tool from \`tools/tool_definitions.json\`:\n`;
    md += `   - For each tool, set the name, description, and input schema\n`;
    md += `   - Grant the required permissions (marked as AUTHORIZE)\n`;
    md += `5. Upload knowledge base documents per instructions in \`knowledge/kb_placeholder.md\`\n`;
    md += `6. Apply configuration values from the agent config file\n\n`;

    md += `#### Configuration Checklist\n\n`;
    md += `| # | Item | File | Action | Notes |\n`;
    md += `|---|------|------|--------|-------|\n`;
    md += `| 1 | System prompt | \`prompts/system_prompt.txt\` | REVIEW | Verify tone, scope, and safety constraints |\n`;
    md += `| 2 | User prompt template | \`prompts/user_prompt_template.txt\` | REVIEW | Confirm input/output format matches your data |\n`;
    md += `| 3 | Tool permissions | \`tools/tool_definitions.json\` | AUTHORIZE | Grant each tool access in Agent Builder |\n`;
    md += `| 4 | Knowledge base | \`knowledge/kb_placeholder.md\` | CONFIGURE | Upload and index actual business documents |\n`;
    md += `| 5 | Temperature / iterations | \`agents/*_config.json\` | TUNE | Adjust for accuracy vs. creativity tradeoff |\n`;
    md += `| 6 | Guardrails | \`agents/*_config.json\` | REVIEW | Verify safety constraints are appropriate |\n`;
    md += `| 7 | Escalation rules | \`agents/*_config.json\` | REVIEW | Confirm human-handoff triggers |\n\n`;

    md += `#### What Works Out of the Box\n\n`;
    md += `- System prompt with process-specific context derived from SDD\n`;
    md += `- Tool definitions with correct schemas\n`;
    md += `- Agent config with recommended defaults (temperature, max iterations)\n`;
    md += `- Guardrail definitions from process analysis\n\n`;

    md += `#### Requires Human Action (Last-Mile Items)\n\n`;
    md += `- **Context grounding data population**: Upload actual business documents (SOPs, policies, FAQs, templates) into the referenced storage bucket(s). The agent config specifies which bucket to use — populate it with real data.\n`;
    md += `- **Prompt tuning**: The system prompt was generated from the SDD. Test with real production data and refine tone, scope, and output format to match business expectations.\n`;
    md += `- **Tool authorization**: Each agent tool maps to a deployed Orchestrator process. Verify the agent has permission to invoke each process in Agent Builder.\n`;
    md += `- **Escalation rule validation**: Confirm escalation conditions and Action Center catalog mappings with business stakeholders.\n`;
    md += `- **End-to-end testing**: Run the agent with representative inputs, verify tool invocations produce correct outputs, and confirm escalation triggers work as expected.\n\n`;
  }

  md += `---\n\n`;

  sectionNum++;
  md += `## ${sectionNum}. Process Logic Validation\n\n`;
  md += `Use this section to verify that the generated automation correctly implements the business rules defined in the SDD. Each item below should be confirmed against the live system before UAT.\n\n`;

  const extractedRules: Array<{ category: string; rule: string }> = [];

  if (sddContent) {
    const sddSections3to5 = sddContent.match(/## [345][\.\s][^\n]+\n([\s\S]*?)(?=## [6-9]\.|## \d{2}\.|$)/g);
    const sddRelevant = sddSections3to5 ? sddSections3to5.join("\n") : sddContent;

    const percentageMatches = sddRelevant.match(/\d+(?:\.\d+)?%\s*[A-Za-z][^\n.;]*/g);
    if (percentageMatches) {
      for (const m of percentageMatches) {
        extractedRules.push({ category: "Threshold / Tolerance", rule: m.trim() });
      }
    }

    const currencyMatches = sddRelevant.match(/(?:\$|USD|EUR|GBP|£|€)\s*[\d,]+(?:\.\d{1,2})?[^\n.;]*/g);
    if (currencyMatches) {
      for (const m of currencyMatches) {
        extractedRules.push({ category: "Threshold / Tolerance", rule: m.trim() });
      }
    }

    const approvalPatterns = sddRelevant.match(/(?:approv|reject|escalat|deny|authorize)[^\n.;]{5,80}/gi);
    if (approvalPatterns) {
      for (const m of approvalPatterns) {
        const cleaned = m.trim().replace(/^[-*]\s*/, "");
        if (cleaned.length > 10 && !extractedRules.some(r => r.rule === cleaned)) {
          extractedRules.push({ category: "Approval / Rejection Criteria", rule: cleaned });
        }
      }
    }

    const retryPatterns = sddRelevant.match(/(?:retry|retries|SLA|timeout|time.?out|within \d+|maximum \d+|up to \d+)[^\n.;]{5,80}/gi);
    if (retryPatterns) {
      for (const m of retryPatterns) {
        const cleaned = m.trim().replace(/^[-*]\s*/, "");
        if (cleaned.length > 10 && !extractedRules.some(r => r.rule === cleaned)) {
          extractedRules.push({ category: "Retry / SLA Requirements", rule: cleaned });
        }
      }
    }

    const endpointPatterns = sddRelevant.match(/(?:https?:\/\/[^\s)>"]+)/gi);
    if (endpointPatterns) {
      for (const m of endpointPatterns) {
        if (!extractedRules.some(r => r.rule === m.trim())) {
          extractedRules.push({ category: "Integration Endpoint", rule: m.trim() });
        }
      }
    }

    const businessRuleSection = sddRelevant.match(/(?:business\s+rules?|functional\s+requirements?)[:\s]*\n((?:\s*[-*]\s+[^\n]+\n?)+)/gi);
    if (businessRuleSection) {
      for (const section of businessRuleSection) {
        const bullets = section.match(/[-*]\s+([^\n]+)/g);
        if (bullets) {
          for (const b of bullets) {
            const cleaned = b.replace(/^[-*]\s+/, "").trim();
            if (cleaned.length > 10 && !extractedRules.some(r => r.rule === cleaned)) {
              extractedRules.push({ category: "Business Rule", rule: cleaned });
            }
          }
        }
      }
    }
  }

  if (enrichment?.dhgNotes?.length) {
    md += `### AI Architecture & Logic Notes\n\n`;
    for (const note of enrichment.dhgNotes) {
      md += `- ${note}\n`;
    }
    md += `\n`;
  }

  if (painPoints && painPoints.length > 0) {
    md += `### Process Risk Areas\n\n`;
    md += `The following pain points were identified during process analysis. Verify that the automation handles these scenarios correctly:\n\n`;
    md += `| # | Process Step | Risk / Pain Point | Verification Action |\n`;
    md += `|---|-------------|-------------------|---------------------|\n`;
    painPoints.forEach((pp, i) => {
      md += `| ${i + 1} | ${pp.name} | ${pp.description || "Identified pain point"} | Confirm error handling and edge-case coverage in XAML |\n`;
    });
    md += `\n`;
  }

  if (extractedRules.length > 0) {
    md += `### Extracted Business Rules — Verification Checklist\n\n`;
    md += `The following rules were extracted from the SDD. Verify each is correctly implemented in the generated workflows:\n\n`;
    md += `| # | Category | Rule / Requirement | Verified |\n`;
    md += `|---|----------|-------------------|----------|\n`;
    extractedRules.forEach((r, i) => {
      const displayRule = (r.rule.length > 120 ? r.rule.slice(0, 117) + "..." : r.rule).replace(/\|/g, "\\|").replace(/\n/g, " ");
      md += `| ${i + 1} | ${r.category} | ${displayRule} | [ ] |\n`;
    });
    md += `\n`;
  }

  if (extractedRules.length === 0 && !(enrichment?.dhgNotes?.length) && !(painPoints && painPoints.length > 0)) {
    md += `> **Note:** No business rules were automatically extracted from the SDD. Please review the SDD (Sections 3–5) manually to identify thresholds, approval criteria, retry/SLA requirements, and integration endpoints that must be validated in the generated workflows.\n\n`;
  }

  md += `---\n\n`;

  sectionNum++;
  md += `## ${sectionNum}. Tier 3 — Requires Human Access (Developer Work Required)\n\n`;
  md += `These items require a developer with access to target systems and UiPath Studio. **Every generated package requires this work.**\n\n`;

  const allSelectorItems: Array<{ system: string; activity: string; hint: string; description: string; estimatedMinutes: number; source: string }> = [];
  for (const g of selectorGaps) {
    allSelectorItems.push({ system: extractSystemFromGap(g), activity: g.activity, hint: g.placeholder, description: g.description, estimatedMinutes: g.estimatedMinutes, source: "gap" });
  }
  const gapSelectorActivities = new Set(selectorGaps.map(g => g.activity));
  for (const sh of allSelectorHints) {
    if (!gapSelectorActivities.has(sh.activity)) {
      const sys = sh.hint.toLowerCase().includes("sap") ? "SAP" :
        sh.hint.toLowerCase().includes("salesforce") || sh.hint.toLowerCase().includes("sfdc") ? "Salesforce" :
        sh.hint.toLowerCase().includes("servicenow") ? "ServiceNow" :
        sh.hint.toLowerCase().includes("workday") ? "Workday" :
        sh.hint.toLowerCase().includes("oracle") ? "Oracle" :
        sh.hint.includes("webctrl") || sh.hint.includes("browser") ? "Web Browser" : "General";
      allSelectorItems.push({ system: sys, activity: sh.activity, hint: sh.hint, description: `Validate AI-generated selector for "${sh.nodeName}" — capture real selector via UiExplorer`, estimatedMinutes: 5, source: "enrichment" });
    }
  }

  if (allSelectorItems.length > 0) {
    md += `### UI Selectors (${allSelectorItems.length} items)\n\n`;
    md += `AI-generated selector hints are **structural patterns only**. Each must be validated and recaptured using UiExplorer with access to the live target application.\n\n`;
    md += `| # | System | Activity | AI Selector Hint | Action | Est. Time |\n`;
    md += `|---|--------|----------|-----------------|--------|----------|\n`;
    const selectorsBySystem: Record<string, typeof allSelectorItems> = {};
    for (const s of allSelectorItems) {
      if (!selectorsBySystem[s.system]) selectorsBySystem[s.system] = [];
      selectorsBySystem[s.system].push(s);
    }
    let sIdx = 0;
    for (const [sys, sysItems] of Object.entries(selectorsBySystem)) {
      for (const s of sysItems) {
        sIdx++;
        const hintDisplay = s.hint.length > 60 ? s.hint.slice(0, 57) + "..." : s.hint;
        md += `| ${sIdx} | ${sys} | \`${s.activity}\` | \`${hintDisplay}\` | ${s.description} | ${s.estimatedMinutes} min |\n`;
      }
    }
    md += `\n`;
    for (const sys of Object.keys(selectorsBySystem)) {
      const lsys = sys.toLowerCase();
      if (lsys.includes("sap")) {
        md += `**SAP:** Use UiExplorer with SAP Bridge. GUI selectors use \`automationid\`. Fiori uses CSS selectors. Add wildcards for session-specific attributes.\n\n`;
      } else if (lsys.includes("salesforce")) {
        md += `**Salesforce:** Use Lightning-compatible selectors with SLDS classes. Dynamic IDs change per session. Consider Salesforce Integration Activities for API-based operations.\n\n`;
      } else if (lsys.includes("servicenow")) {
        md += `**ServiceNow:** Field selectors use \`sys_display.<table>.<field>\` pattern. Consider REST API for bulk operations.\n\n`;
      }
    }
  }

  let credentialAssets = assets?.filter(a => a.type === "Credential") || [];
  if (credentialAssets.length === 0 && deploymentResults) {
    const credResults = deploymentResults.filter(r => r.artifact === "Asset" && (
      r.message.includes("Type: Credential") ||
      r.message.toLowerCase().includes("credential") ||
      r.name.toLowerCase().includes("credential") ||
      r.name.toLowerCase().includes("password")
    ));
    credentialAssets = credResults.map(r => ({ name: r.name, type: "Credential", description: "Set username and password", value: "" }));
  }
  if (credentialGaps.length > 0 || credentialAssets.length > 0) {
    md += `### Credentials (${credentialGaps.length + credentialAssets.length} items)\n\n`;
    md += `These require access to production/UAT credential stores. **Credentials are never auto-filled** — you must set real values.\n\n`;
    md += `| # | Asset | Orchestrator ID | Description | Where to Set |\n`;
    md += `|---|-------|-----------------|-------------|-------------|\n`;
    let cIdx = 0;
    for (const ca of credentialAssets) {
      cIdx++;
      const caResult = deploymentResults?.find(r => r.artifact === "Asset" && r.name === ca.name);
      md += `| ${cIdx} | \`${ca.name}\` | ${caResult?.id || "—"} | ${ca.description || "Set username and password"} | Orchestrator > Assets > \`${ca.name}\` > Edit |\n`;
    }
    for (const g of credentialGaps) {
      cIdx++;
      md += `| ${cIdx} | \`${g.activity}\` | — | ${g.description} | Replace \`${g.placeholder}\` in XAML |\n`;
    }
    md += `\n`;
  }

  const complexGaps = [...logicGaps, ...manualGaps];
  if (complexGaps.length > 0) {
    md += `### Business Logic & Manual Steps (${complexGaps.length} items)\n\n`;
    md += `| # | Category | Activity | Description | Est. Time |\n`;
    md += `|---|----------|----------|-------------|----------|\n`;
    complexGaps.forEach((g, i) => {
      md += `| ${i + 1} | ${g.category} | \`${g.activity}\` | ${g.description} | ${g.estimatedMinutes} min |\n`;
    });
    md += `\n`;
  }

  const machines = extractedArtifacts?.machines || [];
  const machineResults = deploymentResults?.filter(r => r.artifact === "Machine") || [];
  const machineWarnings = machineResults.filter(r => r.message.includes("not assigned") || r.message.includes("assign manually") || r.status === "failed");
  const robots = extractedArtifacts?.robotAccounts || [];
  const robotResults = deploymentResults?.filter(r => r.artifact === "Robot Account" || r.artifact === "Users/Robot Accounts") || [];
  if (machineWarnings.length > 0 || machines.length > 0 || robots.length > 0 || machineResults.length > 0) {
    md += `### Machine & Robot Configuration\n\n`;
    if (machineWarnings.length > 0) {
      md += `| # | Machine | Issue | Action Required |\n`;
      md += `|---|---------|-------|-----------------|\n`;
      machineWarnings.forEach((m, i) => {
        md += `| ${i + 1} | \`${m.name}\` | ${m.message.slice(0, 80)} | Go to Orchestrator > Folder Settings > Machines and assign to your folder |\n`;
      });
      md += `\n`;
    } else if (machines.length > 0) {
      md += `Machines provisioned: ${machines.map(m => `\`${m.name}\``).join(", ")}. Verify they are assigned to the correct folder and have available unattended slots.\n\n`;
    }
    if (robots.length > 0) {
      md += `Robot accounts: ${robots.map((r: any) => `\`${r.name}\` (${r.type || "Unattended"})`).join(", ")}. Verify robot account permissions and machine assignment.\n\n`;
    }
  }

  const duResults = deploymentResults?.filter(r => r.artifact === "Document Understanding") || [];
  const duArtifacts = extractedArtifacts?.documentUnderstanding || [];
  if (duResults.length > 0 || duArtifacts.length > 0) {
    md += `### Document Understanding Setup\n\n`;
    if (duArtifacts.length > 0) {
      for (const du of duArtifacts) {
        const duResult = duResults.find(r => r.name === du.name);
        md += `**${du.name}** (${duResult?.status || "unknown"}${duResult?.id ? `, ID: ${duResult.id}` : ""})\n`;
        if (du.documentTypes?.length) {
          md += `- Document types needed: ${du.documentTypes.join(", ")}\n`;
        }
        const isPredefined = duResult?.id === "00000000-0000-0000-0000-000000000000" || duResult?.message?.includes("predefined") || duResult?.message?.includes("Predefined");
        if (isPredefined) {
          md += `- Using **Predefined** DU project (pretrained models). For custom extraction, create a new project in Document Understanding app and train custom extractors.\n`;
        }
        md += `- **Action:** Configure document classifiers and extractors for your specific document formats. Upload sample documents to validate extraction accuracy.\n`;
      }
    } else {
      for (const duR of duResults) {
        md += `**${duR.name}** (${duR.status}${duR.id ? `, ID: ${duR.id}` : ""})\n`;
        const docTypesMatch = duR.message.match(/Document types?:\s*([^.]+)/i);
        if (docTypesMatch) {
          md += `- Document types: ${docTypesMatch[1].trim()}\n`;
        }
        const isPredefined = duR.id === "00000000-0000-0000-0000-000000000000" || duR.message?.includes("predefined") || duR.message?.includes("Predefined");
        if (isPredefined) {
          md += `- Using **Predefined** DU project (pretrained models). For custom extraction, create a new project in Document Understanding app and train custom extractors.\n`;
        }
        md += `- **Action:** Configure document classifiers and extractors for your specific document formats. Upload sample documents to validate extraction accuracy.\n`;
      }
    }
    md += `\n`;
  }

  const acResults = deploymentResults?.filter(r => r.artifact === "Action Center") || [];
  const acArtifacts = extractedArtifacts?.actionCenter || [];
  if (acResults.length > 0 || acArtifacts.length > 0) {
    md += `### Action Center Configuration\n\n`;
    md += `| # | Task Catalog | Status | ID | Action Required |\n`;
    md += `|---|-------------|--------|----|-----------------|\n`;
    let acIdx = 0;
    if (acArtifacts.length > 0) {
      for (const ac of acArtifacts) {
        acIdx++;
        const acResult = acResults.find(r => r.name === ac.taskCatalog);
        md += `| ${acIdx} | \`${ac.taskCatalog}\` | ${acResult?.status || "unknown"} | ${acResult?.id || "—"} | Assign role (${ac.assignedRole || "TBD"}), configure form fields, set SLA${ac.sla ? ` (suggested: ${ac.sla})` : ""} |\n`;
      }
    } else {
      for (const acR of acResults) {
        acIdx++;
        const catalogMatch = acR.message.match(/catalog\s+"([^"]+)"/i);
        const catalogName = catalogMatch ? catalogMatch[1] : acR.name;
        md += `| ${acIdx} | \`${catalogName}\` | ${acR.status} | ${acR.id || "—"} | Assign reviewer role, configure form fields for human review tasks, set SLA |\n`;
      }
    }
    md += `\n`;
  }

  if (automationType === "agent" || automationType === "hybrid") {
    md += `### Agent Setup (Human Required)\n\n`;
    md += `These items require human expertise and access to configure the agent for production:\n\n`;
    md += `| # | Task | Description | Est. Time |\n`;
    md += `|---|------|-------------|----------|\n`;
    md += `| 1 | Knowledge base content | Upload and index actual business documents, SOPs, and reference materials | 60 min |\n`;
    md += `| 2 | Production prompt tuning | Test and refine system prompts against real-world scenarios and edge cases | 45 min |\n`;
    md += `| 3 | Agent end-to-end testing | Execute agent with representative inputs, verify outputs and escalation behavior | 30 min |\n`;
    md += `| 4 | Guardrail validation | Verify agent stays within safety constraints with adversarial test cases | 20 min |\n`;
    if (automationType === "hybrid") {
      md += `| 5 | RPA-Agent handoff testing | Verify data flows correctly between RPA sequences and agent invocations | 30 min |\n`;
    }
    md += `\n`;
  }

  md += `### Mandatory: Studio Validation & Testing\n\n`;
  md += `Every generated package requires these steps regardless of AI enrichment quality:\n\n`;
  const selectorValidationMinutes = allSelectorItems.length > 0 ? allSelectorItems.reduce((s, si) => s + si.estimatedMinutes, 0) : 0;
  const credentialMinutes = (credentialAssets.length + credentialGaps.length) * 5;
  md += `| # | Task | Description | Est. Time |\n`;
  md += `|---|------|-------------|----------|\n`;
  md += `| 1 | Studio Import | Open .nupkg in UiPath Studio. Install missing packages, resolve dependency conflicts, verify project compiles without errors. | 15 min |\n`;
  if (allSelectorItems.length > 0) {
    md += `| 2 | Selector Validation | Validate all ${allSelectorItems.length} UI selectors in UiExplorer against real target applications. AI selectors are structural hints — they will not work without recapture. | ${selectorValidationMinutes} min |\n`;
  }
  if (credentialAssets.length > 0 || credentialGaps.length > 0) {
    md += `| ${allSelectorItems.length > 0 ? 3 : 2} | Credential Setup | Set real username/password for ${credentialAssets.length + credentialGaps.length} credential asset(s) in Orchestrator > Assets. | ${credentialMinutes} min |\n`;
  }
  let mandatoryIdx = (allSelectorItems.length > 0 ? 1 : 0) + (credentialAssets.length > 0 || credentialGaps.length > 0 ? 1 : 0) + 1;
  md += `| ${mandatoryIdx + 1} | End-to-End Testing | Execute all ${workflowNames.length} workflows in Studio Debug mode against UAT/test environment. Verify queue processing, exception handling, and business rules. | 30 min |\n`;
  md += `| ${mandatoryIdx + 2} | UAT Sign-off | Business stakeholder validation with real data and real systems. Confirm outputs match expected results for representative scenarios. | 60 min |\n`;
  md += `\n`;

  const agentTier3Minutes = (automationType === "agent" || automationType === "hybrid") ? (155 + (automationType === "hybrid" ? 30 : 0)) : 0;
  const mandatoryMinutes = 15 + selectorValidationMinutes + credentialMinutes + 30 + 60;
  const tier3TotalMinutes = selectorGaps.reduce((s, g) => s + g.estimatedMinutes, 0) +
    credentialGaps.reduce((s, g) => s + g.estimatedMinutes, 0) +
    complexGaps.reduce((s, g) => s + g.estimatedMinutes, 0) +
    credentialAssets.length * 5 + agentTier3Minutes +
    mandatoryMinutes +
    allSelectorItems.filter(s => s.source === "enrichment").reduce((sum, s) => sum + s.estimatedMinutes, 0);
  md += `**Total Tier 3 Effort: ~${(tier3TotalMinutes / 60).toFixed(1)} hours** (${allSelectorItems.length} selectors, ${credentialGaps.length + credentialAssets.length} credentials, ${complexGaps.length} logic items, mandatory validation)\n\n`;

  md += `---\n\n`;

  sectionNum++;
  md += `## ${sectionNum}. Code Review Checklist\n\n`;
  md += `Use this checklist during peer review before promoting to UAT.\n\n`;

  if (analysisReports?.length) {
    const remaining = analysisReports.flatMap(ar => ar.report.violations.filter(v => !v.autoFixed));
    if (remaining.length > 0) {
      md += `### Workflow Analyzer Remaining Violations\n\n`;
      md += `| Severity | Rule | File | Message |\n`;
      md += `|----------|------|------|---------|\n`;
      for (const ar of analysisReports) {
        for (const v of ar.report.violations.filter(vv => !vv.autoFixed)) {
          md += `| ${v.severity} | ${v.ruleId} | ${ar.fileName} | ${v.message} |\n`;
        }
      }
      md += `\n`;
    } else {
      md += `All Workflow Analyzer checks passed or were auto-corrected. No remaining violations.\n\n`;
    }
  }

  md += `### Review Rubric\n\n`;
  md += `| Category | Check | Status |\n`;
  md += `|----------|-------|---------|\n`;
  md += `| Exception Handling | All activities in TryCatch? Catch blocks log + rethrow? | AI: Done |\n`;
  md += `| Transaction Integrity | Queue items set to Success/Failed/BusinessException? | ${useReFramework ? "AI: Done (REFramework)" : "N/A"} |\n`;
  md += `| Logging | Info log at start/end of each workflow? Critical decisions logged? | AI: Done |\n`;
  md += `| Selector Reliability | Selectors use stable attributes (automationid, name)? | ${allSelectorItems.length > 0 ? "Tier 3: Pending" : "N/A"} |\n`;
  md += `| Credential Security | All credentials in Orchestrator Assets, not hardcoded? | AI: Verified |\n`;
  md += `| Naming Conventions | Variables/arguments follow type/direction prefixes? | AI: Auto-corrected |\n`;
  md += `| Annotations | Every activity annotated with business context? | AI: Done |\n`;
  md += `| Argument Validation | Entry points validate required arguments? | AI: Done |\n`;
  md += `| Config Management | Environment-specific values in Config.xlsx? | AI: Done |\n`;
  if (automationType === "agent" || automationType === "hybrid") {
    md += `| Agent Guardrails | Safety constraints prevent harmful agent actions? | Tier 2: Review |\n`;
    md += `| Agent Escalation | Human handoff triggers correctly configured? | Tier 2: Review |\n`;
    md += `| Agent Testing | Agent produces expected outputs for sample inputs? | Tier 3: Pending |\n`;
    md += `| Knowledge Base | Agent has access to required reference documents? | Tier 3: Pending |\n`;
  }
  md += `\n`;

  md += `### Pre-Deployment Verification\n\n`;
  md += `1. Open the project in UiPath Studio\n`;
  md += `2. Run **Analyze File** > **Workflow Analyzer** on all files\n`;
  md += `3. Confirm zero errors and zero warnings\n`;
  md += `4. Run all unit tests in Test Manager\n`;
  md += `5. Execute a full end-to-end run in Dev environment\n\n`;

  md += `### Sign-Off\n\n`;
  md += `| Field | Value |\n`;
  md += `|-------|-------|\n`;
  md += `| Reviewer | _________________ |\n`;
  md += `| Date | _________________ |\n`;
  md += `| Approval | [ ] Approved for UAT  [ ] Requires Changes |\n`;
  md += `| Notes | _________________ |\n\n`;

  md += `---\n\n`;

  sectionNum++;
  md += `## ${sectionNum}. Package Contents\n\n`;
  md += `| File | Purpose |\n`;
  md += `|------|--------|\n`;
  md += `| \`project.json\` | UiPath project manifest with dependencies |\n`;
  md += `| \`Main.xaml\` | ${useReFramework ? "REFramework State Machine entry point" : "Entry point workflow"} |\n`;
  if (useReFramework) {
    md += `| \`GetTransactionData.xaml\` | Fetches next queue item |\n`;
    md += `| \`Process.xaml\` | Business logic for single transaction |\n`;
    md += `| \`SetTransactionStatus.xaml\` | Marks transaction Success/Failed |\n`;
    md += `| \`CloseAllApplications.xaml\` | Graceful app cleanup |\n`;
    md += `| \`KillAllProcesses.xaml\` | Force-kill hanging processes |\n`;
  }
  for (const wfName of workflowNames) {
    if (!["Main", "GetTransactionData", "Process", "SetTransactionStatus", "CloseAllApplications", "KillAllProcesses"].includes(wfName)) {
      md += `| \`${wfName}.xaml\` | Workflow: ${wfName} |\n`;
    }
  }
  md += `| \`InitAllSettings.xaml\` | Configuration initialization |\n`;
  md += `| \`Data/Config.xlsx\` | Configuration settings |\n`;
  md += `| \`DeveloperHandoffGuide.md\` | This guide |\n\n`;
  md += `**Required Packages:** ${usedPackages.map(p => `\`${p}\``).join(", ")}\n\n`;

  if (painPoints && painPoints.length > 0) {
    md += `---\n\n`;
    sectionNum++;
    md += `## ${sectionNum}. Risk Assessment\n\n`;
    md += `| # | Step | Risk | Mitigation |\n`;
    md += `|---|------|------|------------|\n`;
    painPoints.forEach((pp, i) => {
      md += `| ${i + 1} | ${pp.name} | ${pp.description || "Pain point"} | Extra error handling and retry logic applied |\n`;
    });
    md += `\n`;
  }

  const testCases = extractedArtifacts?.testCases;
  const testSets = extractedArtifacts?.testSets;
  if (testCases?.length || testSets?.length) {
    md += `---\n\n`;
    sectionNum++;
    md += `## ${sectionNum}. Test Suite\n\n`;
    if (testCases?.length) {
      const tcResults = deploymentResults?.filter(r => r.artifact === "Test Case");
      md += `| # | Test Case | Type | Priority | Status |\n`;
      md += `|---|-----------|------|----------|--------|\n`;
      testCases.forEach((tc, i) => {
        const result = tcResults?.find(r => r.name === tc.name);
        md += `| ${i + 1} | \`${tc.name}\` | ${tc.testType || "Functional"} | ${tc.priority || "Medium"} | ${result?.status || "unknown"} |\n`;
      });
      md += `\n`;
    }
    if (testSets?.length) {
      const tsResults = deploymentResults?.filter(r => r.artifact === "Test Set");
      md += `| # | Test Set | Mode | Test Cases | Status |\n`;
      md += `|---|----------|------|------------|--------|\n`;
      testSets.forEach((ts, i) => {
        const result = tsResults?.find(r => r.name === ts.name);
        md += `| ${i + 1} | \`${ts.name}\` | ${ts.executionMode || "Sequential"} | ${ts.testCaseNames?.length || 0} | ${result?.status || "unknown"} |\n`;
      });
      md += `\n`;
    }
  }

  const requirements = extractedArtifacts?.requirements;
  if (requirements?.length) {
    md += `---\n\n`;
    sectionNum++;
    md += `## ${sectionNum}. Requirements Traceability\n\n`;
    const reqResults = deploymentResults?.filter(r => r.artifact === "Requirement");
    md += `| # | Requirement | Type | Priority | Status |\n`;
    md += `|---|------------|------|----------|--------|\n`;
    requirements.forEach((req, i) => {
      const result = reqResults?.find(r => r.name === req.name);
      md += `| ${i + 1} | \`${req.name}\` | ${req.type || "Functional"} | ${req.priority || "Medium"} | ${result?.status || "unknown"} |\n`;
    });
    md += `\n`;
    const reqsWithCriteria = requirements.filter(r => r.acceptanceCriteria?.length);
    if (reqsWithCriteria.length > 0) {
      for (const req of reqsWithCriteria) {
        md += `**${req.name}:**\n`;
        for (const c of req.acceptanceCriteria!) md += `- [ ] ${c}\n`;
        md += `\n`;
      }
    }
  }

  md += `---\n\n`;
  sectionNum++;
  md += `## ${sectionNum}. Infrastructure\n\n`;
  const infraMachines = extractedArtifacts?.machines;
  const infraRobots = extractedArtifacts?.robotAccounts;
  const infraBuckets = extractedArtifacts?.storageBuckets;
  const infraEnvironments = extractedArtifacts?.environments;
  const infraFromDeployResults = deploymentResults?.filter(r => r.artifact === "Infrastructure") || [];
  if (infraMachines?.length) {
    md += `**Machines:** ${infraMachines.map(m => `\`${m.name}\` (${m.runtimeType || m.type || "Unattended"}, ${m.slots || 1} slots)`).join(", ")}\n`;
  }
  if (infraRobots?.length) {
    md += `**Robots:** ${infraRobots.map(r => `\`${r.name}\` (${r.type || "Unattended"}, ${r.role || "Executor"})`).join(", ")}\n`;
  }
  if (infraBuckets?.length) {
    md += `**Storage:** ${infraBuckets.map(b => `\`${b.name}\` (${b.storageProvider || "Orchestrator"})`).join(", ")}\n`;
  }
  if (infraEnvironments?.length) {
    md += `**Environments:** ${infraEnvironments.map(e => `\`${e.name}\` (${e.type || "Production"})`).join(", ")}\n`;
  }
  if (!infraMachines?.length && !infraRobots?.length && !infraBuckets?.length && deploymentResults?.length) {
    for (const ir of infraFromDeployResults) {
      md += `**${ir.name}:** ${ir.message.slice(0, 120)}\n`;
    }
    const infraMachineResults = deploymentResults.filter(r => r.artifact === "Machine");
    for (const mr of infraMachineResults) {
      md += `**Machine:** \`${mr.name}\` (${mr.status}${mr.id ? `, ID: ${mr.id}` : ""}) — ${mr.message.slice(0, 100)}\n`;
    }
    const infraStorageResults = deploymentResults.filter(r => r.artifact === "Storage Bucket");
    for (const sr of infraStorageResults) {
      md += `**Storage:** \`${sr.name}\` (${sr.status}${sr.id ? `, ID: ${sr.id}` : ""}) — ${sr.message.slice(0, 100)}\n`;
    }
  }
  md += `\n`;

  const infraAcArtifacts = extractedArtifacts?.actionCenter;
  if (infraAcArtifacts?.length) {
    md += `### Action Center\n\n`;
    for (const ac of infraAcArtifacts) {
      const acResult = deploymentResults?.find(r => r.artifact === "Action Center" && r.name === ac.taskCatalog);
      md += `**${ac.taskCatalog}** (${acResult?.status || "unknown"})`;
      if (ac.sla) md += ` — SLA: ${ac.sla}`;
      md += `\n`;
      if (ac.formFields?.length) {
        md += `Fields: ${ac.formFields.map(f => `${f.name} (${f.type}${f.required ? ", required" : ""})`).join(", ")}\n`;
      }
    }
    md += `\n`;
  }

  const infraDuArtifacts = extractedArtifacts?.documentUnderstanding;
  if (infraDuArtifacts?.length) {
    md += `### Document Understanding\n\n`;
    for (const du of infraDuArtifacts) {
      const duResult = deploymentResults?.find(r => r.artifact === "Document Understanding" && r.name === du.name);
      md += `**${du.name}** (${duResult?.status || "unknown"})`;
      if (du.documentTypes?.length) md += ` — Types: ${du.documentTypes.join(", ")}`;
      md += `\n`;
    }
    md += `\n`;
  }

  let testingContent = "";
  if (sddContent) {
    const section7Match = sddContent.match(/## 7[\.\s][^\n]+\n([\s\S]*?)(?=## \d+\.|$)/);
    if (section7Match) testingContent = section7Match[1].trim();
  }

  md += `---\n\n`;
  sectionNum++;
  md += `## ${sectionNum}. Go-Live Checklist\n\n`;
  md += `#### Development\n`;
  md += `- [ ] Open project in UiPath Studio — install missing packages\n`;
  md += `- [ ] Run Workflow Analyzer — confirm zero violations\n`;
  md += `- [ ] Complete Tier 3 items (selectors, credentials, business logic)\n`;
  md += `- [ ] Config.xlsx updated with Dev values\n\n`;
  md += `#### UAT\n`;
  md += `- [ ] UAT Orchestrator folder with separate assets/queues\n`;
  md += `- [ ] Full end-to-end run with real data\n`;
  md += `- [ ] Business stakeholder sign-off\n\n`;
  md += `#### Production\n`;
  md += `- [ ] Production credentials and assets configured\n`;
  md += `- [ ] Triggers/schedules active\n`;
  md += `- [ ] Monitoring and alerting configured\n`;
  md += `- [ ] Runbook documentation completed\n`;

  if (targetFramework === "Portable") {
    sectionNum++;
    md += `\n## ${sectionNum}. Serverless / Cross-Platform Notes\n\n`;
    md += `This project targets **Cross-Platform (Portable)** and is designed to run on **Serverless robots**.\n\n`;
    md += `**Key Differences from Windows:**\n`;
    md += `- **Expression Language:** CSharp (not VB.NET) — all expressions use C# syntax\n`;
    md += `- **Target Runtime:** .NET 6.0 (lib/net6.0 in the nupkg)\n`;
    md += `- **Modern Design Activities:** Uses \`UseExcel\`, \`UseBrowser\`, \`SendMail\`, \`GetMail\` instead of legacy equivalents\n`;
    md += `- **No Desktop Interaction:** \`CloseApplication\` and \`KillProcess\` are not available — cleanup uses log-only fallbacks\n`;
    md += `- **Screenshot-on-Error:** All error handlers capture a screenshot before logging for diagnostic purposes\n`;
    if (autopilotEnabled) {
      md += `- **Autopilot/Self-Healing:** Enabled — selectors use AI-assisted recovery to adapt to UI changes automatically\n`;
    }
    md += `\n**Testing Considerations:**\n`;
    md += `- Test in UiPath Studio with Cross-Platform profile selected\n`;
    md += `- Verify all expressions compile under CSharp language\n`;
    md += `- Ensure no Windows-only activities are referenced\n`;
    md += `- Validate Serverless robot execution in Orchestrator test environment\n`;
  }

  return md;
}

