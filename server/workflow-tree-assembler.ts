import type {
  WorkflowNode,
  WorkflowSpec,
  VariableDeclaration,
  ActivityNode,
  SequenceNode,
  TryCatchNode,
  IfNode,
  WhileNode,
  ForEachNode,
  RetryScopeNode,
  PropertyValue,
} from "./workflow-spec-types";
import { catalogService } from "./catalog/catalog-service";
import type { ActivityValidationResult, ValidationCorrection } from "./catalog/catalog-service";
import { buildTemplateBlock } from "./catalog/xaml-template-builder";
import type { ProcessType } from "./catalog/catalog-service";
import { escapeXml, escapeXmlExpression, normalizeXmlExpression, escapeXmlTextContent } from "./lib/xml-utils";
import { XMLValidator } from "fast-xml-parser";
import { buildExpression, isValueIntent, normalizeStringToExpression, type ValueIntent } from "./xaml/expression-builder";
import { getActivityTag, getActivityPrefixStrict } from "./xaml/xaml-compliance";
import { lintExpression } from "./xaml/vbnet-expression-linter";
import type { RemediationEntry, RemediationCode } from "./uipath-pipeline";
import { PROPERTY_REMEDIATION_ESCALATION_THRESHOLD } from "./uipath-pipeline";

export interface PropertyRemediationRecord {
  propertyName: string;
  remediationCode: RemediationCode;
  reason: string;
  originalValue: string;
  replacementValue: string;
}

export class CSharpExpressionBlockedError extends Error {
  public readonly syntaxType: string;
  public readonly expression: string;
  constructor(syntaxType: string, expression: string) {
    super(`Unconvertible C# syntax (${syntaxType}) blocked: "${expression}"`);
    this.name = "CSharpExpressionBlockedError";
    this.syntaxType = syntaxType;
    this.expression = expression;
  }
}

export interface AssemblyRemediationContext {
  fileName: string;
  propertyRemediations: RemediationEntry[];
  escalationThreshold: number;
}

const CRITICAL_WORKFLOW_NAME_PATTERNS = [
  /^main(?:\.xaml)?$/i,
  /^process(?:\.xaml)?$/i,
  /^dispatcher(?:\.xaml)?$/i,
  /^performer(?:\.xaml)?$/i,
  /^gettransactiondata(?:\.xaml)?$/i,
  /^settransactionstatus(?:\.xaml)?$/i,
  /^contactresolver(?:\.xaml)?$/i,
  /^messagecomposer(?:\.xaml)?$/i,
  /^emailsender(?:\.xaml)?$/i,
  /^calendarreader(?:\.xaml)?$/i,
  /^initallsettings(?:\.xaml)?$/i,
];

function isCriticalWorkflowName(name: string): boolean {
  const base = name.split("/").pop() || name;
  return CRITICAL_WORKFLOW_NAME_PATTERNS.some(pattern => pattern.test(base));
}

let _activeRemediationContext: AssemblyRemediationContext | null = null;

export function setRemediationContext(ctx: AssemblyRemediationContext): void {
  _activeRemediationContext = ctx;
}

export function clearRemediationContext(): AssemblyRemediationContext | null {
  const ctx = _activeRemediationContext;
  _activeRemediationContext = null;
  return ctx;
}

function recordPropertyRemediation(
  propertyName: string,
  remediationCode: RemediationCode,
  reason: string,
  activityTemplate: string,
  displayName: string,
): void {
  if (!_activeRemediationContext) return;
  _activeRemediationContext.propertyRemediations.push({
    level: "property",
    file: _activeRemediationContext.fileName,
    remediationCode,
    originalTag: activityTemplate,
    originalDisplayName: displayName,
    propertyName,
    reason,
    classifiedCheck: remediationCode,
    developerAction: `Fix property "${propertyName}" on "${displayName}" (${activityTemplate}) in ${_activeRemediationContext.fileName} — ${reason}`,
    estimatedEffortMinutes: estimatePropertyEffort(remediationCode),
  });
}

function estimatePropertyEffort(code: RemediationCode): number {
  const effortMap: Record<string, number> = {
    "STUB_PROPERTY_BAD_EXPRESSION": 10,
    "STUB_PROPERTY_MISSING_SELECTOR": 15,
    "STUB_PROPERTY_UNSUPPORTED_TYPE": 5,
    "STUB_PROPERTY_INVALID_VALUE": 5,
  };
  return effortMap[code] || 5;
}

function validatePropertyValue(
  key: string,
  value: string,
  schema: any,
  templateName: string,
): { valid: boolean; code: RemediationCode; reason: string } | null {
  if (value === "[object Object]" || value === "undefined" || value === "null") {
    return {
      valid: false,
      code: "STUB_PROPERTY_BAD_EXPRESSION",
      reason: `Property "${key}" contains serialization artifact "${value}"`,
    };
  }

  if (key.toLowerCase() === "selector" || key.toLowerCase().endsWith("selector")) {
    if (!value || value === "" || value === '""') {
      return {
        valid: false,
        code: "STUB_PROPERTY_MISSING_SELECTOR",
        reason: `Property "${key}" has empty or missing selector value`,
      };
    }
  }

  if (schema) {
    const propDef = schema.activity?.properties?.find((p: any) => p.name === key);
    if (propDef?.validValues && propDef.validValues.length > 0) {
      const normalizedValue = value.replace(/^\[|\]$/g, "").trim();
      if (!propDef.validValues.includes(normalizedValue) && !propDef.validValues.includes(value)) {
        return {
          valid: false,
          code: "STUB_PROPERTY_INVALID_VALUE",
          reason: `Property "${key}" has value "${value}" which is not in valid values: ${propDef.validValues.join(", ")}`,
        };
      }
    }
  }

  return null;
}

function getSafeDefaultForProperty(key: string, code: RemediationCode): string {
  if (code === "STUB_PROPERTY_MISSING_SELECTOR") {
    return '[TODO: Capture selector using UiExplorer]';
  }
  if (code === "STUB_PROPERTY_BAD_EXPRESSION") {
    return '[TODO: Replace with valid expression]';
  }
  if (code === "STUB_PROPERTY_INVALID_VALUE") {
    return '[TODO: Set valid value]';
  }
  return `[TODO: Fix ${key}]`;
}

const XAML_PROTECTED_STRUCTURAL_NAMES = new Set([
  "Try", "Then", "Else", "Body", "Condition", "Catches", "Finally",
  "Cases", "Default", "Values", "Username", "Password",
  "Implementation", "Variables", "Activities", "Arguments",
  "Handler", "Trigger", "Action", "Content", "Result",
  "Header", "Headers", "Branches", "Constraints",
]);

const VBNET_RESERVED_WORDS = new Set([
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

export function isProtectedXamlStructuralName(name: string): boolean {
  return XAML_PROTECTED_STRUCTURAL_NAMES.has(name);
}

export function sanitizeVariableName(name: string): string {
  if (XAML_PROTECTED_STRUCTURAL_NAMES.has(name)) {
    return name;
  }
  let sanitized = name.replace(/\./g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, "_");
  sanitized = sanitized.replace(/^[0-9]+/, "");
  sanitized = sanitized.replace(/_+/g, "_");
  sanitized = sanitized.replace(/^_|_$/g, "");
  if (!sanitized) sanitized = "var1";
  if (VBNET_RESERVED_WORDS.has(sanitized.toLowerCase()) && !XAML_PROTECTED_STRUCTURAL_NAMES.has(sanitized)) {
    sanitized = `_${sanitized}`;
  }
  return sanitized;
}

export function isUnsafeVariableName(name: string): string | null {
  if (/\./.test(name)) return `contains dot(s)`;
  if (/\s/.test(name)) return `contains whitespace`;
  if (/^[0-9]/.test(name)) return `starts with a digit`;
  if (/[^a-zA-Z0-9_]/.test(name)) return `contains invalid character(s)`;
  if (VBNET_RESERVED_WORDS.has(name.toLowerCase())) return `is a VB.NET reserved word`;
  return null;
}

function mapClrType(type: string): string {
  const trimmed = type.trim();
  if (/^(x|s|scg|scg2):/.test(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower === "string" || lower === "system.string" || lower === "x:string") return "x:String";
  if (lower === "int32" || lower === "integer" || lower === "int" || lower === "system.int32" || lower === "x:int32") return "x:Int32";
  if (lower === "int64" || lower === "long" || lower === "system.int64" || lower === "x:int64") return "x:Int64";
  if (lower === "boolean" || lower === "bool" || lower === "system.boolean" || lower === "x:boolean") return "x:Boolean";
  if (lower === "double" || lower === "system.double" || lower === "x:double") return "x:Double";
  if (lower === "decimal" || lower === "system.decimal" || lower === "x:decimal") return "x:Decimal";
  if (lower === "datetime" || lower === "system.datetime" || lower === "s:datetime") return "s:DateTime";
  if (lower === "timespan" || lower === "system.timespan" || lower === "s:timespan") return "s:TimeSpan";
  if (lower === "object" || lower === "system.object" || lower === "x:object") return "x:Object";
  if (lower === "securestring" || lower === "system.security.securestring") return "s:Security.SecureString";

  if (lower.includes("datatable") && !lower.includes("dictionary")) return "scg2:DataTable";
  if (lower.includes("datarow")) return "scg2:DataRow";
  if (lower.includes("securestring")) return "s:Security.SecureString";

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

  return "x:Object";
}

function inferTypeFromDefault(defaultValue: string | undefined): string | null {
  if (!defaultValue) return null;
  const trimmed = defaultValue.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return null;
  const unquoted = trimmed.replace(/^&quot;|&quot;$/g, "").replace(/^"|"$/g, "");
  if (trimmed === "True" || trimmed === "False") return "x:Boolean";
  if (/^-?\d+$/.test(trimmed)) return "x:Int32";
  if (/^-?\d+\.\d+$/.test(trimmed)) return "x:Double";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return "x:String";
  if (trimmed.startsWith("&quot;") && trimmed.endsWith("&quot;")) return "x:String";
  if (unquoted !== trimmed && unquoted.length < trimmed.length) return "x:String";
  return null;
}

function inferAssignType(varName: string, variables: VariableDeclaration[]): string {
  const decl = variables.find(v => v.name === varName);
  if (decl) {
    const mapped = mapClrType(decl.type);
    if (mapped !== "x:Object") return mapped;
    const prefixInferred = inferTypeFromPrefix(varName);
    if (prefixInferred) return prefixInferred;
    const defaultInferred = inferTypeFromDefault(decl.default);
    if (defaultInferred) return defaultInferred;
    return mapped;
  }
  const prefixInferred = inferTypeFromPrefix(varName);
  if (prefixInferred) return prefixInferred;
  return "x:Object";
}

function inferTypeFromPrefix(varName: string): string | null {
  const normalized = (varName || "").trim();
  const stripped = normalized.replace(/^(in|out|io)_/i, "");
  const semantic = stripped.toLowerCase();
  if (/config/.test(semantic)) return "scg:Dictionary(x:String, x:Object)";
  if (/(requiresreview|enable|enabled|found|complete|success|valid|approved|review)$/i.test(stripped)) return "x:Boolean";
  if (/(count|number|total|index|retry)$/i.test(stripped)) return "x:Int32";
  if (/(date|birthdate|rundate)$/i.test(stripped)) return "s:DateTime";
  if (/(datatable|rows)$/i.test(stripped)) return "scg2:DataTable";
  if (varName.startsWith("str_")) return "x:String";
  if (varName.startsWith("int_") || varName.startsWith("num_")) return "x:Int32";
  if (varName.startsWith("bool_") || varName.startsWith("is_") || varName.startsWith("has_")) return "x:Boolean";
  if (varName.startsWith("dbl_")) return "x:Double";
  if (varName.startsWith("dec_")) return "x:Decimal";
  if (varName.startsWith("dt_")) return "scg2:DataTable";
  if (varName.startsWith("date_") || varName.startsWith("dtm_")) return "s:DateTime";
  if (varName.startsWith("dr_") || varName.startsWith("drow_")) return "scg2:DataRow";
  if (varName.startsWith("dict_")) return "scg:Dictionary(x:String, x:Object)";
  if (varName.startsWith("sec_")) return "s:Security.SecureString";
  if (varName.startsWith("ts_")) return "s:TimeSpan";
  if (varName.startsWith("obj_")) return "x:Object";
  if (/^(in|out|io)_/i.test(normalized)) return "x:String";
  return null;
}

function inferInvokeArgumentType(
  argName: string,
  rawBinding: string,
  allVariables: VariableDeclaration[],
): string {
  const binding = rawBinding.trim().replace(/^\[|\]$/g, "");
  const existingVar = allVariables.find(v => v.name === binding);
  if (existingVar) {
    return mapClrType(existingVar.type);
  }
  const bindingType = inferTypeFromPrefix(binding);
  if (bindingType) return bindingType;
  const argType = inferTypeFromPrefix(argName);
  if (argType) return argType;
  const defaultType = inferTypeFromDefault(rawBinding);
  if (defaultType) return defaultType;
  return "x:String";
}

function buildInvokeWorkflowArgumentsXml(
  props: Record<string, PropertyValue>,
  allVariables: VariableDeclaration[],
): string {
  const argEntries = Object.entries(props).filter(([key]) => /^(in|out|io)_[A-Za-z]\w*$/i.test(key));
  if (argEntries.length === 0) return "";

  const lines: string[] = [];
  lines.push(`  <ui:InvokeWorkflowFile.Arguments>`);
  for (const [argName, argValue] of argEntries) {
    const direction = argName.startsWith("out_")
      ? "OutArgument"
      : argName.startsWith("io_")
        ? "InOutArgument"
        : "InArgument";
    const rawBinding = resolvePropertyValueRaw(argValue);
    const typeArg = inferInvokeArgumentType(argName, rawBinding, allVariables);
    const serialized = direction === "InArgument"
      ? escapeXmlTextContent(normalizeXmlExpression(resolvePropertyValue(argValue)))
      : escapeXmlTextContent(normalizeXmlExpression(ensureBracketWrapped(rawBinding)));
    lines.push(`    <${direction} x:TypeArguments="${typeArg}" x:Key="${escapeXml(argName)}">${serialized}</${direction}>`);
  }
  lines.push(`  </ui:InvokeWorkflowFile.Arguments>`);
  return lines.join("\n");
}

const IMPLICIT_OUTPUT_ACTIVITY_TYPES: Record<string, { outputPropNames: string[]; defaultVar: string; defaultType: string }> = {
  "GetAsset": { outputPropNames: ["AssetValue", "Value"], defaultVar: "str_AssetValue", defaultType: "String" },
  "GetCredential": { outputPropNames: ["Username", "Password"], defaultVar: "str_Username", defaultType: "String" },
  "GetTransactionItem": { outputPropNames: ["TransactionItem"], defaultVar: "qi_TransactionItem", defaultType: "UiPath.Core.QueueItem" },
  "DeserializeJson": { outputPropNames: ["Result"], defaultVar: "obj_Result", defaultType: "Object" },
  "HttpClient": { outputPropNames: ["Result"], defaultVar: "str_ResponseBody", defaultType: "String" },
  "GetRobotAsset": { outputPropNames: ["AssetValue", "Value"], defaultVar: "str_RobotAssetValue", defaultType: "String" },
  "GetQueueItems": { outputPropNames: ["QueueItems"], defaultVar: "list_QueueItems", defaultType: "System.Collections.Generic.List(UiPath.Core.QueueItem)" },
  "AddQueueItem": { outputPropNames: ["QueueItem"], defaultVar: "qi_NewQueueItem", defaultType: "UiPath.Core.QueueItem" },
  "ReadRange": { outputPropNames: ["DataTable"], defaultVar: "dt_ExcelData", defaultType: "System.Data.DataTable" },
  "ReadCsvFile": { outputPropNames: ["DataTable"], defaultVar: "dt_CsvData", defaultType: "System.Data.DataTable" },
  "ExecuteQuery": { outputPropNames: ["DataTable"], defaultVar: "dt_QueryResult", defaultType: "System.Data.DataTable" },
  "DeserializeXml": { outputPropNames: ["XmlDocument"], defaultVar: "obj_XmlDoc", defaultType: "System.Xml.Linq.XDocument" },
  "InputDialog": { outputPropNames: ["Result"], defaultVar: "str_UserInput", defaultType: "String" },
  "MessageBox": { outputPropNames: ["ChosenButton"], defaultVar: "str_ChosenButton", defaultType: "String" },
  "GetOrchestratorJobInfo": { outputPropNames: ["JobId", "MachineName"], defaultVar: "str_JobId", defaultType: "String" },
  "ReadTextFile": { outputPropNames: ["Content"], defaultVar: "str_FileContent", defaultType: "String" },
  "SerializeJson": { outputPropNames: ["JsonString"], defaultVar: "str_JsonOutput", defaultType: "String" },
  "MatchPattern": { outputPropNames: ["Matches", "Result"], defaultVar: "obj_Matches", defaultType: "System.Text.RegularExpressions.MatchCollection" },
};

function collectImplicitOutputVariables(children: WorkflowNode[], allVariables: VariableDeclaration[]): void {
  const existingNames = new Set(allVariables.map(v => v.name));

  function scanNode(node: WorkflowNode): void {
    if (node.kind === "activity") {
      const actNode = node as ActivityNode;
      const templateName = actNode.template || "";
      const actConfig = IMPLICIT_OUTPUT_ACTIVITY_TYPES[templateName];

      if (actConfig) {
        const props = actNode.properties || {};
        const varNames: string[] = [];

        if (templateName === "GetAsset" || templateName === "GetRobotAsset") {
          const rawOutputVar = actNode.outputVar || (props.AssetValue as string) || (props.Value as string) || "";
          if (rawOutputVar && isValidOutputVariableName(rawOutputVar)) {
            varNames.push(rawOutputVar);
          } else {
            const assetName = (props.AssetName as string) || (props.assetName as string) || "";
            const assetType = (props.AssetType as string) || (props.assetType as string) || "String";
            if (assetName && !assetName.startsWith("PLACEHOLDER_")) {
              varNames.push(deriveAssetOutputVariable(assetName, assetType));
            } else {
              varNames.push("str_REVIEW_AssetOutput");
            }
          }
        } else {
          if (actNode.outputVar) {
            varNames.push(actNode.outputVar);
          }

          for (const propName of actConfig.outputPropNames) {
            const val = props[propName] || props[propName.charAt(0).toLowerCase() + propName.slice(1)];
            if (val && typeof val === "string" && /^[a-zA-Z_]\w*$/.test(val.replace(/^\[|\]$/g, ""))) {
              varNames.push(val.replace(/^\[|\]$/g, ""));
            }
          }

          if (varNames.length === 0) {
            varNames.push(actConfig.defaultVar);
          }
        }

        if (templateName === "GetCredential") {
          const usernameVar = (props.Username || props.username || "str_Username") as string;
          const passwordVar = (props.Password || props.password || "sec_Password") as string;
          const cleanUser = usernameVar.replace(/^\[|\]$/g, "");
          const cleanPass = passwordVar.replace(/^\[|\]$/g, "");
          if (!existingNames.has(cleanUser)) {
            allVariables.push({ name: cleanUser, type: "String" });
            existingNames.add(cleanUser);
          }
          if (!existingNames.has(cleanPass)) {
            allVariables.push({ name: cleanPass, type: "System.Security.SecureString" });
            existingNames.add(cleanPass);
          }
        }

        for (const varName of varNames) {
          const cleanName = varName.replace(/^\[|\]$/g, "");
          if (!cleanName || existingNames.has(cleanName)) continue;

          const PREFIX_TO_CLR: Record<string, string> = {
            "x:String": "String",
            "x:Int32": "Int32",
            "x:Boolean": "Boolean",
            "x:Double": "Double",
            "x:Decimal": "Decimal",
            "s:DateTime": "DateTime",
            "scg2:DataTable": "System.Data.DataTable",
            "scg2:DataRow": "System.Data.DataRow",
            "s:Security.SecureString": "System.Security.SecureString",
            "s:TimeSpan": "TimeSpan",
            "x:Object": "Object",
            "ui:QueueItem": "UiPath.Core.QueueItem",
          };
          const prefixType = inferTypeFromPrefix(cleanName);
          const prefixClr = prefixType ? (PREFIX_TO_CLR[prefixType] || null) : null;
          const schemaType = actConfig.defaultType;
          const isSchemaGeneric = !schemaType || schemaType === "Object" || schemaType === "x:Object";
          let varType: string;
          if (prefixClr && !isSchemaGeneric) {
            varType = prefixClr;
          } else if (prefixClr) {
            varType = prefixClr;
          } else if (!isSchemaGeneric) {
            varType = schemaType;
          } else {
            varType = "String";
          }

          allVariables.push({ name: cleanName, type: varType });
          existingNames.add(cleanName);
          console.log(`[Implicit Variable] Auto-declared "${cleanName}" (type: ${varType}) from ${templateName} activity`);
        }
      }

      if (actNode.outputVar) {
        const cleanName = actNode.outputVar.replace(/^\[|\]$/g, "");
        if (cleanName && !existingNames.has(cleanName)) {
          let varType = "Object";
          const prefixType = inferTypeFromPrefix(cleanName);
          if (prefixType) {
            const PREFIX_TO_CLR: Record<string, string> = {
              "x:String": "String", "x:Int32": "Int32", "x:Boolean": "Boolean",
              "x:Double": "Double", "x:Decimal": "Decimal", "s:DateTime": "DateTime",
              "scg2:DataTable": "System.Data.DataTable", "scg2:DataRow": "System.Data.DataRow",
              "s:Security.SecureString": "System.Security.SecureString", "s:TimeSpan": "TimeSpan",
              "x:Object": "Object", "ui:QueueItem": "UiPath.Core.QueueItem",
            };
            varType = PREFIX_TO_CLR[prefixType] || varType;
          }
          allVariables.push({ name: cleanName, type: varType });
          existingNames.add(cleanName);
          console.log(`[Implicit Variable] Auto-declared "${cleanName}" (type: ${varType}) from generic outputVar`);
        }
      }
    }

    if ("children" in node && Array.isArray((node as any).children)) {
      for (const child of (node as any).children) scanNode(child);
    }
    if ("thenChildren" in node && Array.isArray((node as any).thenChildren)) {
      for (const child of (node as any).thenChildren) scanNode(child);
    }
    if ("elseChildren" in node && Array.isArray((node as any).elseChildren)) {
      for (const child of (node as any).elseChildren) scanNode(child);
    }
    if ("tryChildren" in node && Array.isArray((node as any).tryChildren)) {
      for (const child of (node as any).tryChildren) scanNode(child);
    }
    if ("catchChildren" in node && Array.isArray((node as any).catchChildren)) {
      for (const child of (node as any).catchChildren) scanNode(child);
    }
    if ("finallyChildren" in node && Array.isArray((node as any).finallyChildren)) {
      for (const child of (node as any).finallyChildren) scanNode(child);
    }
    if ("bodyChildren" in node && Array.isArray((node as any).bodyChildren)) {
      for (const child of (node as any).bodyChildren) scanNode(child);
    }
  }

  for (const child of children) {
    scanNode(child);
  }
}

function indent(xml: string, level: number): string {
  const spaces = "  ".repeat(level);
  return xml.split("\n").map(line => line.trim() ? spaces + line : line).join("\n");
}

function ensureBracketWrapped(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) return trimmed;
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (trimmed === "True" || trimmed === "False") return trimmed;
  return `[${trimmed}]`;
}

function looksLikeVariableRef(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) return true;
  if (/^[a-zA-Z_][a-zA-Z0-9_.]+$/.test(trimmed)) return true;
  return false;
}

function looksLikeVbExpression(val: string): boolean {
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return true;
  if (trimmed.startsWith('"') || trimmed.startsWith("&quot;")) return true;
  if (trimmed === "True" || trimmed === "False" || trimmed === "Nothing" || trimmed === "null") return true;
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return true;
  if (/^(str_|int_|bool_|dbl_|dec_|obj_|dt_|ts_|drow_|qi_|sec_)/i.test(trimmed)) return true;
  if (/^[a-zA-Z_]\w*\(/.test(trimmed)) return true;
  if (/[+\-*/&=<>]/.test(trimmed) && !/[.,!?;:'"…]/.test(trimmed)) return true;
  if (/^[a-zA-Z_]\w*\.[a-zA-Z_]\w*/.test(trimmed)) return true;
  return false;
}

function looksLikeStringLiteral(val: string): boolean {
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (looksLikeVbExpression(trimmed)) return false;
  return true;
}

function isVbExpression(val: string): boolean {
  const trimmed = val.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return true;
  if (trimmed.startsWith("\"") || trimmed.startsWith("&quot;")) return true;
  if (trimmed === "True" || trimmed === "False" || trimmed === "Nothing" || trimmed === "null") return true;
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return true;
  if (/^New\s/.test(trimmed)) return true;
  if (/[()=<>&|+*/^]/.test(trimmed)) return true;
  if (/\b\w+\.\w+/.test(trimmed)) return true;
  if (/\b(AndAlso|OrElse|Not|Mod|Xor|Is|IsNot|Like)\b/.test(trimmed)) return true;
  if (trimmed.startsWith("in_") || trimmed.startsWith("out_") || trimmed.startsWith("io_")) return true;
  if (/^(str|int|bool|dbl|dec|obj|dt|ts|drow|qi|arr|dict|list|sec)_/i.test(trimmed)) return true;
  return false;
}

function wrapVariableDefault(val: string, varType: string): string {
  const trimmed = val.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (trimmed === "True" || trimmed === "False" || trimmed === "Nothing" || trimmed === "null") return trimmed;
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("\"") || trimmed.startsWith("&quot;")) return trimmed;

  if (isVbExpression(trimmed)) {
    return `[${trimmed}]`;
  }
  const typeNorm = varType.toLowerCase();
  const isStringType = typeNorm.includes("string") && !typeNorm.includes("secure");
  if (isStringType) {
    return `"${trimmed}"`;
  }
  return trimmed;
}

function smartBracketWrap(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (trimmed.startsWith("<InArgument") || trimmed.startsWith("<OutArgument")) return trimmed;
  if (/^".*"$/.test(trimmed)) return trimmed;
  if (/^'.*'$/.test(trimmed)) return trimmed;
  if (/^&quot;.*&quot;$/.test(trimmed)) return trimmed;
  if (trimmed === "True" || trimmed === "False" || trimmed === "Nothing" || trimmed === "null") return trimmed;
  if (/^[0-9]+$/.test(trimmed)) return trimmed;
  if (looksLikeStringLiteral(trimmed)) {
    const escaped = trimmed.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return `[${trimmed}]`;
}

function normalizeQuotedLiteral(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("&quot;") && trimmed.endsWith("&quot;")) {
    return `"${trimmed.slice(6, -6)}"`;
  }
  return trimmed;
}

function unwrapQuotedLiteral(val: string): string | null {
  const normalized = normalizeQuotedLiteral(val);
  if (/^".*"$/.test(normalized)) {
    return normalized.slice(1, -1).replace(/""/g, '"');
  }
  if (/^'.*'$/.test(normalized)) {
    return normalized.slice(1, -1).replace(/''/g, "'");
  }
  return null;
}

function normalizeEnumValue(val: string, validValues: string[]): string | null {
  const trimmed = normalizeQuotedLiteral(val).trim();
  if (!trimmed) return null;
  const unwrappedBracket = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  const unwrappedLiteral = unwrapQuotedLiteral(unwrappedBracket) ?? unwrappedBracket;
  const canonical = validValues.find(option => option.toLowerCase() === unwrappedLiteral.toLowerCase());
  return canonical || null;
}

export function resolvePropertyValue(value: PropertyValue): string {
  if (isValueIntent(value)) {
    const built = buildExpression(value as ValueIntent);
    return smartBracketWrap(lintAndFixVbExpression(built));
  }
  const strVal = String(value);
  return smartBracketWrap(lintAndFixVbExpression(strVal));
}

export function resolvePropertyValueRaw(value: PropertyValue): string {
  if (isValueIntent(value)) {
    return buildExpression(value as ValueIntent);
  }
  return String(value);
}

function parseEmittedXmlForValidation(xml: string): {
  tag: string;
  className: string;
  attributes: Record<string, string>;
  childNames: string[];
} | null {
  const trimmed = xml.trim();
  const openTagMatch = trimmed.match(/^<((?:[\w]+:)?[\w]+)([\s\S]*?)(?:\/>|>)/);
  if (!openTagMatch) return null;
  const tag = openTagMatch[1];
  const className = tag.includes(":") ? tag.split(":").pop()! : tag;
  const attrString = openTagMatch[2];

  const attributes: Record<string, string> = {};
  const attrRegex = /([\w]+(?:\.[\w]+)?)="([^"]*)"/g;
  let m;
  while ((m = attrRegex.exec(attrString)) !== null) {
    if (m[1].startsWith("xmlns") || m[1].includes(":")) continue;
    attributes[m[1]] = m[2];
  }

  const childNames: string[] = [];
  const childPropRegex = new RegExp(`<${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\w+)[\\s>]`, "g");
  let cm;
  while ((cm = childPropRegex.exec(trimmed)) !== null) {
    childNames.push(cm[1]);
    childNames.push(`${className}.${cm[1]}`);
  }

  return { tag, className, attributes, childNames };
}

function applyCatalogConformance(xml: string): string {
  if (!catalogService.isLoaded()) {
    try { catalogService.load(); } catch (e) { }
  }
  if (!catalogService.isLoaded()) return xml;

  const parsed = parseEmittedXmlForValidation(xml);
  if (!parsed) return xml;

  const { tag, className } = parsed;
  const templateName = className;
  const schema = catalogService.getActivitySchema(templateName);
  if (!schema) return xml;

  const validation = catalogService.validateEmittedActivity(
    tag,
    parsed.attributes,
    parsed.childNames,
  );

  if (validation.valid && validation.corrections.length === 0) return xml;

  let corrected = xml;
  for (const correction of validation.corrections) {
    if (correction.type === "move-to-child-element") {
      const propName = correction.property;
      const propVal = parsed.attributes[propName];
      if (propVal === undefined) continue;

      const wrapper = correction.argumentWrapper || "InArgument";
      const xType = correction.typeArguments || "x:String";
      const wrappedVal = escapeXmlTextContent(ensureBracketWrapped(propVal));
      const childElement = `<${tag}.${propName}>\n    <${wrapper} x:TypeArguments="${xType}">${wrappedVal}</${wrapper}>\n  </${tag}.${propName}>`;

      const escapedPropName = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedVal = propVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const selfClosingRegex = new RegExp(`(<${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s[^>]*?)${escapedPropName}="${escapedVal}"([^>]*?)\\s*\\/>`);
      if (selfClosingRegex.test(corrected)) {
        corrected = corrected.replace(selfClosingRegex, `$1$2>\n  ${childElement}\n</${tag}>`);
      } else {
        const openRegex = new RegExp(`(<${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s[^>]*?)${escapedPropName}="${escapedVal}"([^>]*?>)`);
        if (openRegex.test(corrected)) {
          corrected = corrected.replace(openRegex, `$1$2\n  ${childElement}`);
          const closingTag = `</${tag}>`;
          if (!corrected.includes(closingTag)) {
            corrected += `\n${closingTag}`;
          }
        }
      }

      console.log(`[Catalog Conformance] Moved ${tag}.${propName} from attribute to child-element at emission time`);
    } else if (correction.type === "move-to-attribute") {
      console.log(`[Catalog Conformance] Property ${tag}.${correction.property} should be attribute, not child-element (logged for review)`);
    }
  }

  corrected = corrected.replace(/\s{2,}\/?>/g, (match) => match.includes('/') ? ' />' : '>');
  corrected = corrected.replace(/<(\S+)\s+>/g, '<$1>');

  return corrected;
}

function getPropString(props: Record<string, PropertyValue>, ...keys: string[]): string {
  for (const key of keys) {
    if (props[key] !== undefined) {
      const val = props[key];
      if (isValueIntent(val)) {
        return buildExpression(val as ValueIntent);
      }
      return String(val);
    }
  }
  return "";
}

export type EmissionContext = "normal" | "mandatory-catch" | "mandatory-finally" | "inside-trycatch";

export function resolveActivityTemplate(
  node: ActivityNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType = "general",
  emissionContext: EmissionContext = "normal"
): string {
  const templateName = node.template;
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);

  if (templateName === "Assign") {
    return applyCatalogConformance(resolveAssignTemplate(node, allVariables));
  }

  if (templateName === "LogMessage") {
    const level = getPropString(props, "Level", "level") || "Info";
    const message = getPropString(props, "Message", "message") || displayName;
    let wrappedMessage: string;
    const unwrappedLiteral = unwrapQuotedLiteral(message);
    if (unwrappedLiteral !== null) {
      const escapedLiteral = unwrappedLiteral.replace(/"/g, '""');
      wrappedMessage = `["${escapedLiteral}"]`;
    } else if (looksLikeStringLiteral(message)) {
      const escapedLiteral = message.replace(/"/g, '""');
      wrappedMessage = `["${escapedLiteral}"]`;
    } else {
      wrappedMessage = smartBracketWrap(message);
    }
    return applyCatalogConformance(`<ui:LogMessage Level="${escapeXml(level)}" Message="${escapeXml(wrappedMessage)}" DisplayName="${displayName}" />`);
  }

  if (templateName === "Delay") {
    const duration = getPropString(props, "Duration", "duration") || "00:00:05";
    return applyCatalogConformance(`<Delay Duration="${escapeXml(duration)}" DisplayName="${displayName}" />`);
  }

  if (templateName === "Rethrow") {
    return applyCatalogConformance(`<Rethrow DisplayName="${displayName}" />`);
  }

  if (templateName === "InvokeWorkflowFile") {
    const fileName = getPropString(props, "WorkflowFileName", "workflowFileName") || "Workflow.xaml";
    const argsXml = buildInvokeWorkflowArgumentsXml(props, allVariables);
    if (!argsXml) {
      return applyCatalogConformance(`<ui:InvokeWorkflowFile WorkflowFileName="${escapeXml(fileName)}" DisplayName="${displayName}" />`);
    }
    return applyCatalogConformance(`<ui:InvokeWorkflowFile WorkflowFileName="${escapeXml(fileName)}" DisplayName="${displayName}">\n` +
      `${argsXml}\n` +
      `</ui:InvokeWorkflowFile>`);
  }

  if (templateName === "GetAsset") {
    return applyCatalogConformance(resolveGetAssetTemplate(node));
  }

  if (templateName === "GetCredential") {
    return applyCatalogConformance(resolveGetCredentialTemplate(node));
  }

  if (templateName === "SendSmtpMailMessage") {
    return applyCatalogConformance(resolveSendSmtpMailMessageTemplate(node));
  }

  if (templateName === "HttpClient") {
    return applyCatalogConformance(resolveHttpClientTemplate(node));
  }

  if (templateName === "ExcelApplicationScope") {
    return applyCatalogConformance(resolveExcelApplicationScopeTemplate(node, allVariables, processType, emissionContext));
  }

  if (templateName === "UseExcel") {
    return applyCatalogConformance(resolveUseExcelTemplate(node, allVariables, processType, emissionContext));
  }

  if (templateName === "DeserializeJson") {
    const input = getPropString(props, "JsonString", "jsonString", "Input") || "";
    const outputVar = node.outputVar || "obj_Result";
    const djTag = getActivityTag("DeserializeJson");
    return applyCatalogConformance(`<${djTag} DisplayName="${displayName}" JsonString="${escapeXml(input)}">\n` +
      `  <${djTag}.Result>\n` +
      `    <OutArgument x:TypeArguments="x:Object">${escapeXmlTextContent(ensureBracketWrapped(outputVar))}</OutArgument>\n` +
      `  </${djTag}.Result>\n` +
      `</${djTag}>`);
  }

  if (templateName === "Comment") {
    const text = getPropString(props, "Text", "text") || "";
    return applyCatalogConformance(`<ui:Comment Text="${escapeXml(text)}" DisplayName="${displayName}" />`);
  }

  if (!catalogService.isLoaded()) {
    try {
      catalogService.load();
    } catch (e) {
    }
  }

  const UNSUPPORTED_ACTIVITIES = new Set([
    "InvokeAgent", "DownloadFile", "UploadFile",
  ]);

  if (UNSUPPORTED_ACTIVITIES.has(templateName)) {
    const isMandatoryPath = emissionContext === "mandatory-catch" || emissionContext === "mandatory-finally";
    const isCriticalWorkflow = isCriticalWorkflowName(_activeRemediationContext?.fileName || "");
    console.warn(`[Tree Assembler] Unsupported activity "${templateName}" — "${node.displayName}"${isMandatoryPath ? " (in mandatory path)" : ""}. Emitting fallback.`);
    if (_activeRemediationContext) {
      _activeRemediationContext.propertyRemediations.push({
        level: "activity",
        file: _activeRemediationContext.fileName,
        remediationCode: "STUB_ACTIVITY_CATALOG_VIOLATION",
        originalTag: templateName,
        originalDisplayName: node.displayName,
        propertyName: isMandatoryPath ? "(unsupported-activity-mandatory-path)" : "(unsupported-activity)",
        reason: `Activity "${templateName}" is not supported — no valid catalog entry or package mapping exists. Business step "${node.displayName}" requires manual implementation.${isMandatoryPath ? " This activity is in a mandatory execution path (catch/finally block) — the workflow is BLOCKED until resolved." : ""}`,
        classifiedCheck: "UNSUPPORTED_ACTIVITY",
        developerAction: `Manually implement "${node.displayName}" using supported activities — "${templateName}" has no valid package mapping`,
        estimatedEffortMinutes: isMandatoryPath ? 45 : 30,
      });
    }
    if (isMandatoryPath || isCriticalWorkflow) {
      return `<!-- BLOCKED: Unsupported activity "${escapeXml(templateName)}" in mandatory ${emissionContext === "mandatory-catch" ? "catch" : "finally"} path — "${escapeXml(node.displayName)}" requires manual implementation -->
<ui:LogMessage Level="Error" Message="[&quot;BLOCKED: Unsupported activity &apos;${escapeXml(templateName)}&apos; in mandatory path — business step &apos;${escapeXml(node.displayName)}&apos; requires manual implementation&quot;]" DisplayName="Log Blocked Activity (${escapeXml(node.displayName)})" />
<Rethrow DisplayName="Rethrow — blocked activity &apos;${escapeXml(node.displayName)}&apos;" />`;
    }
    return `<!-- WARNING: Unsupported activity "${escapeXml(templateName)}" — "${escapeXml(node.displayName)}" requires manual implementation -->
<ui:Comment Text="[BLOCKED] Unsupported activity: ${escapeXml(templateName)}. Business step &quot;${escapeXml(node.displayName)}&quot; requires manual implementation using supported UiPath activities." DisplayName="${escapeXml(node.displayName)} (unsupported — manual implementation required)" />
<ui:LogMessage Level="Warn" Message="[&quot;WARNING: Business step &apos;${escapeXml(node.displayName)}&apos; uses unsupported activity &apos;${escapeXml(templateName)}&apos; — requires manual implementation&quot;]" DisplayName="Log Unsupported Activity Warning" />`;
  }

  if (catalogService.isLoaded()) {
    const schema = catalogService.getActivitySchema(templateName);
    if (!schema) {
      const isMandatoryPath = emissionContext === "mandatory-catch" || emissionContext === "mandatory-finally";
      const isCriticalWorkflow = isCriticalWorkflowName(_activeRemediationContext?.fileName || "");
      console.warn(`[Tree Assembler] Unknown template "${templateName}" — not in catalog${isMandatoryPath ? " (in mandatory path)" : ""}, emitting fallback`);
      if (_activeRemediationContext) {
        _activeRemediationContext.propertyRemediations.push({
          level: "activity",
          file: _activeRemediationContext.fileName,
          remediationCode: "STUB_ACTIVITY_CATALOG_VIOLATION",
          originalTag: templateName,
          originalDisplayName: node.displayName,
          propertyName: isMandatoryPath ? "(unknown-template-mandatory-path)" : "(unknown-template)",
          reason: `Activity "${templateName}" is not in the activity catalog. Business step "${node.displayName}" requires manual implementation.${isMandatoryPath ? " This activity is in a mandatory execution path — the workflow is BLOCKED until resolved." : ""}`,
          classifiedCheck: "CATALOG_VIOLATION",
          developerAction: `Verify and implement "${node.displayName}" (${templateName}) using supported activities`,
          estimatedEffortMinutes: isMandatoryPath ? 30 : 20,
        });
      }
      if (isMandatoryPath || isCriticalWorkflow) {
        return `<!-- BLOCKED: Unknown activity "${escapeXml(templateName)}" in mandatory ${emissionContext === "mandatory-catch" ? "catch" : "finally"} path — "${escapeXml(node.displayName)}" -->
<ui:LogMessage Level="Error" Message="[&quot;BLOCKED: Unknown activity &apos;${escapeXml(templateName)}&apos; in mandatory path — business step &apos;${escapeXml(node.displayName)}&apos; requires manual implementation&quot;]" DisplayName="Log Blocked Activity (${escapeXml(node.displayName)})" />
<Rethrow DisplayName="Rethrow — blocked activity &apos;${escapeXml(node.displayName)}&apos;" />`;
      }
      return `<!-- WARNING: Unknown activity template "${escapeXml(templateName)}" — "${escapeXml(node.displayName)}" not found in catalog -->
<ui:Comment Text="[BLOCKED] Unknown activity: ${escapeXml(templateName)}. Business step &quot;${escapeXml(node.displayName)}&quot; requires manual implementation." DisplayName="${escapeXml(node.displayName)} (unknown — manual implementation required)" />
<ui:LogMessage Level="Warn" Message="[&quot;WARNING: Business step &apos;${escapeXml(node.displayName)}&apos; uses unknown activity &apos;${escapeXml(templateName)}&apos; — requires manual implementation&quot;]" DisplayName="Log Unknown Activity Warning" />`;
    }
  } else {
    const isMandatoryPath = emissionContext === "mandatory-catch" || emissionContext === "mandatory-finally";
    console.error(`[Tree Assembler] Catalog not loaded — cannot resolve template "${templateName}" safely${isMandatoryPath ? " (in mandatory path)" : ""}. Emitting stub.`);
    if (_activeRemediationContext) {
      _activeRemediationContext.propertyRemediations.push({
        level: "activity",
        file: _activeRemediationContext.fileName,
        remediationCode: "STUB_ACTIVITY_CATALOG_VIOLATION",
        originalTag: templateName,
        originalDisplayName: node.displayName,
        propertyName: isMandatoryPath ? "(catalog-not-loaded-mandatory-path)" : "(catalog-not-loaded)",
        reason: `Catalog not loaded — cannot verify template "${templateName}" structure. Emitting stub to avoid schema-less degradation.${isMandatoryPath ? " This is in a mandatory execution path — workflow is BLOCKED." : ""}`,
        classifiedCheck: "CATALOG_VIOLATION",
        developerAction: `Verify and re-implement "${node.displayName}" (${templateName}) — catalog was not available at emission time`,
        estimatedEffortMinutes: isMandatoryPath ? 25 : 15,
      });
    }
    if (isMandatoryPath) {
      return `<!-- BLOCKED: Catalog not loaded for "${escapeXml(templateName)}" in mandatory ${emissionContext === "mandatory-catch" ? "catch" : "finally"} path -->
<ui:LogMessage Level="Error" Message="[&quot;BLOCKED: Activity &apos;${escapeXml(templateName)}&apos; could not be validated (catalog not loaded) in mandatory path — business step &apos;${escapeXml(node.displayName)}&apos; requires manual implementation&quot;]" DisplayName="Log Blocked Activity (${escapeXml(node.displayName)})" />
<Rethrow DisplayName="Rethrow — blocked activity &apos;${escapeXml(node.displayName)}&apos;" />`;
    }
    return `<!-- CATALOG NOT LOADED: ${escapeXml(templateName)} — "${escapeXml(node.displayName)}" -->
<ui:Comment Text="[TODO: Activity ${escapeXml(templateName)} requires catalog validation. Manual implementation required.]" DisplayName="${escapeXml(node.displayName)} (stub)" />`;
  }

  return resolveDynamicTemplate(node, processType, emissionContext);
}

function resolveAssignTemplate(node: ActivityNode, allVariables: VariableDeclaration[]): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const toRaw = props.To || props.to || node.outputVar || "obj_Result";
  const valRaw = props.Value || props.value || '""';
  const toVarName = isValueIntent(toRaw) && (toRaw as ValueIntent).type === "variable"
    ? (toRaw as ValueIntent & { type: "variable" }).name
    : isValueIntent(toRaw) ? buildExpression(toRaw as ValueIntent) : String(toRaw);
  const typeArg = inferAssignType(toVarName, allVariables);
  const wrappedTo = ensureBracketWrapped(toVarName);
  const wrappedVal = resolvePropertyValue(valRaw as PropertyValue);

  const safeToExpr = escapeXmlTextContent(normalizeXmlExpression(wrappedTo));
  let safeValExpr = escapeXmlTextContent(normalizeXmlExpression(wrappedVal));

  if (typeArg === "x:Object") {
    const valContent = safeValExpr.trim();
    const isLiteral = !(valContent.startsWith("[") && valContent.endsWith("]"));
    if (isLiteral && valContent.length > 0) {
      safeValExpr = `[${valContent}]`;
      console.warn(`[Argument Guard] Bracket-wrapping literal value "${valContent}" for x:Object Assign "${displayName}"`);
    }
  }

  return `<Assign DisplayName="${displayName}">\n` +
    `  <Assign.To>\n` +
    `    <OutArgument x:TypeArguments="${typeArg}">${safeToExpr}</OutArgument>\n` +
    `  </Assign.To>\n` +
    `  <Assign.Value>\n` +
    `    <InArgument x:TypeArguments="${typeArg}">${safeValExpr}</InArgument>\n` +
    `  </Assign.Value>\n` +
    `</Assign>`;
}

function isValidOutputVariableName(val: string): boolean {
  if (!val || val === "Nothing") return false;
  if (/[()."'\[\]]/.test(val)) return false;
  if (/^dict_\w+\(/.test(val)) return false;
  if (val.includes("dict_Config(")) return false;
  if (/\.\w+\(/.test(val)) return false;
  return /^[a-zA-Z_]\w*$/.test(val);
}

function deriveAssetOutputVariable(assetName: string, assetType: string = "String"): string {
  if (!assetName || assetName.startsWith("PLACEHOLDER_")) return "str_REVIEW_AssetOutput";
  let cleanName = assetName;
  const dotIdx = cleanName.indexOf(".");
  if (dotIdx >= 0) {
    cleanName = cleanName.substring(dotIdx + 1);
  }
  cleanName = cleanName.replace(/[^a-zA-Z0-9_]/g, "");
  if (!cleanName) return "str_REVIEW_AssetOutput";
  const typePrefix = assetType.toLowerCase().startsWith("int") ? "int_"
    : assetType.toLowerCase().startsWith("bool") ? "bool_"
    : "str_";
  return `${typePrefix}${cleanName}`;
}

function resolveGetAssetTemplate(node: ActivityNode): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const assetName = getPropString(props, "AssetName", "assetName") || "PLACEHOLDER_AssetName";
  const assetType = getPropString(props, "AssetType", "assetType") || "String";

  const rawOutputVar = node.outputVar || getPropString(props, "AssetValue", "Value");

  let outputVar: string;
  if (rawOutputVar && isValidOutputVariableName(rawOutputVar)) {
    outputVar = rawOutputVar;
  } else if (assetName && !assetName.startsWith("PLACEHOLDER_")) {
    outputVar = deriveAssetOutputVariable(assetName, assetType);
    console.log(`[GetAsset] Tier 2: derived output variable "${outputVar}" from asset name "${assetName}"`);
  } else {
    outputVar = "str_REVIEW_AssetOutput";
    console.warn(`[GetAsset] Tier 3: using stub variable "str_REVIEW_AssetOutput" for asset "${assetName}" — needs manual binding`);
    console.warn(`[DHG_REMEDIATION] GetAsset output binding unresolved: asset="${assetName}", activity="${node.displayName}", stub_var="str_REVIEW_AssetOutput" — developer must create a correctly-named output variable and bind it to this GetAsset activity`);
  }

  const outArgType = outputVar.startsWith("int_") ? "x:Int32"
    : outputVar.startsWith("bool_") ? "x:Boolean"
    : outputVar.startsWith("dbl_") ? "x:Double"
    : "x:String";

  return `<ui:GetAsset DisplayName="${displayName}" AssetName="${escapeXml(assetName)}">\n` +
    `  <ui:GetAsset.AssetValue>\n` +
    `    <OutArgument x:TypeArguments="${outArgType}">${escapeXmlTextContent(ensureBracketWrapped(outputVar))}</OutArgument>\n` +
    `  </ui:GetAsset.AssetValue>\n` +
    `</ui:GetAsset>`;
}

function resolveGetCredentialTemplate(node: ActivityNode): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const assetName = getPropString(props, "AssetName", "assetName") || "PLACEHOLDER_CredentialName";
  const usernameVar = getPropString(props, "Username", "username") || "str_Username";
  const passwordVar = getPropString(props, "Password", "password") || "sec_Password";

  return `<ui:GetCredential DisplayName="${displayName}" AssetName="${escapeXml(assetName)}">\n` +
    `  <ui:GetCredential.Username>\n` +
    `    <OutArgument x:TypeArguments="x:String">${escapeXmlTextContent(ensureBracketWrapped(usernameVar))}</OutArgument>\n` +
    `  </ui:GetCredential.Username>\n` +
    `  <ui:GetCredential.Password>\n` +
    `    <OutArgument x:TypeArguments="s:Security.SecureString">${escapeXmlTextContent(ensureBracketWrapped(passwordVar))}</OutArgument>\n` +
    `  </ui:GetCredential.Password>\n` +
    `</ui:GetCredential>`;
}

function wrapSmtpPropValue(val: string): string {
  if (!val) return val;
  return smartBracketWrap(val);
}

function resolveSendSmtpMailMessageTemplate(node: ActivityNode): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const to = getPropString(props, "To", "to") || "PLACEHOLDER_To";
  const from = getPropString(props, "From", "from");
  const subject = getPropString(props, "Subject", "subject") || "PLACEHOLDER_Subject";
  const body = getPropString(props, "Body", "body") || "PLACEHOLDER_Body";
  const server = getPropString(props, "Server", "server") || "PLACEHOLDER_SmtpServer";
  const port = getPropString(props, "Port", "port") || "587";
  const email = getPropString(props, "Email", "email");
  const password = getPropString(props, "Password", "password");
  const username = getPropString(props, "Username", "username");
  const isBodyHtml = getPropString(props, "IsBodyHtml", "isBodyHtml") || "False";

  const wrappedTo = wrapSmtpPropValue(to);
  const wrappedSubject = wrapSmtpPropValue(subject);
  const wrappedBody = wrapSmtpPropValue(body);

  let attrs = `DisplayName="${displayName}" To="${escapeXml(wrappedTo)}" Subject="${escapeXml(wrappedSubject)}" Body="${escapeXml(wrappedBody)}"`;
  attrs += ` IsBodyHtml="${escapeXml(isBodyHtml)}"`;
  attrs += ` Server="${escapeXml(server)}" Port="${escapeXml(port)}"`;
  if (from) attrs += ` From="${escapeXml(wrapSmtpPropValue(from))}"`;
  if (email) attrs += ` Email="${escapeXml(wrapSmtpPropValue(email))}"`;
  if (username) attrs += ` Username="${escapeXml(wrapSmtpPropValue(username))}"`;
  if (password) attrs += ` Password="${escapeXml(wrapSmtpPropValue(password))}"`;

  return `<ui:SendSmtpMailMessage ${attrs} />`;
}

function resolveHttpClientTemplate(node: ActivityNode): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const endpointRaw = props.Endpoint || props.endpoint || props.URL || props.url;
  if (!endpointRaw) {
    throw new Error(`[HttpClient] Activity "${node.displayName}" is missing a required Endpoint/URL property — cannot emit HttpClient without a valid endpoint.`);
  }
  const endpointResolved = resolvePropertyValueRaw(endpointRaw as PropertyValue);
  const method = getPropString(props, "Method", "method") || "GET";
  const outputVar = node.outputVar || "str_ResponseBody";
  const tag = getActivityTag("HttpClient");

  let wrappedEndpoint: string;
  if (endpointResolved.startsWith("[") && endpointResolved.endsWith("]")) {
    wrappedEndpoint = endpointResolved;
  } else if (/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/.test(endpointResolved)) {
    wrappedEndpoint = `[${endpointResolved}]`;
  } else if (/^https?:\/\//.test(endpointResolved) || endpointResolved.includes("://")) {
    wrappedEndpoint = `[&quot;${escapeXml(endpointResolved)}&quot;]`;
  } else {
    wrappedEndpoint = `[${endpointResolved}]`;
  }

  let xml = `<${tag} DisplayName="${displayName}" Endpoint="${wrappedEndpoint}" Method="${escapeXml(method)}"`;

  xml += `>\n`;

  const body = getPropString(props, "Body", "body");
  const methodUpper = method.toUpperCase();
  if (body) {
    xml += `  <${tag}.Body>\n`;
    xml += `    <InArgument x:TypeArguments="x:String">${escapeXmlTextContent(ensureBracketWrapped(body))}</InArgument>\n`;
    xml += `  </${tag}.Body>\n`;
  } else if (methodUpper === "POST" || methodUpper === "PUT" || methodUpper === "PATCH") {
    xml += `  <${tag}.Body>\n`;
    xml += `    <InArgument x:TypeArguments="x:String">[str_RequestBody]</InArgument>\n`;
    xml += `  </${tag}.Body>\n`;
  }

  const headers = getPropString(props, "Headers", "headers");
  if (headers) {
    xml += `  <${tag}.Headers>\n`;
    xml += `    <InArgument x:TypeArguments="scg:Dictionary(x:String, x:String)">${escapeXmlTextContent(ensureBracketWrapped(headers))}</InArgument>\n`;
    xml += `  </${tag}.Headers>\n`;
  } else {
    const authToken = getPropString(props, "AuthToken", "authToken", "BearerToken", "bearerToken");
    if (authToken) {
      xml += `  <${tag}.Headers>\n`;
      const safeAuthToken = escapeXmlTextContent(ensureBracketWrapped(authToken)).slice(1, -1);
      xml += `    <InArgument x:TypeArguments="scg:Dictionary(x:String, x:String)">${escapeXmlTextContent(`[New Dictionary(Of String, String) From {{"Authorization", "Bearer " & ${safeAuthToken}}}]`)}</InArgument>\n`;
      xml += `  </${tag}.Headers>\n`;
    }
  }

  xml += `  <${tag}.Result>\n`;
  xml += `    <OutArgument x:TypeArguments="x:String">${escapeXmlTextContent(ensureBracketWrapped(outputVar))}</OutArgument>\n`;
  xml += `  </${tag}.Result>\n`;
  xml += `</${tag}>`;

  return xml;
}

function resolveExcelApplicationScopeTemplate(
  node: ActivityNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  emissionContext: EmissionContext,
): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const workbookPath = getPropString(props, "WorkbookPath", "workbookPath", "FilePath", "filePath") || "PLACEHOLDER_WorkbookPath";
  const visible = getPropString(props, "Visible", "visible") || "False";
  const tag = getActivityTag("ExcelApplicationScope");

  const bodyChildren = (node as any).bodyChildren || (node as any).children || [];
  let bodyXml = "";
  if (Array.isArray(bodyChildren) && bodyChildren.length > 0) {
    bodyXml = bodyChildren
      .map((child: WorkflowNode) => assembleNode(child, allVariables, processType, 0, emissionContext))
      .join("\n");
  }
  if (!bodyXml.trim()) {
    bodyXml = `<ui:Comment Text="TODO: Add Excel activities here" DisplayName="Placeholder" />`;
  }

  return `<${tag} DisplayName="${displayName}" WorkbookPath="${escapeXml(smartBracketWrap(workbookPath))}" Visible="${escapeXml(visible)}">\n` +
    `  <${tag}.Body>\n` +
    `    <ActivityAction x:TypeArguments="x:Object">\n` +
    `      <ActivityAction.Handler>\n` +
    `        <Sequence DisplayName="Excel Scope Body">\n` +
    `          ${bodyXml}\n` +
    `        </Sequence>\n` +
    `      </ActivityAction.Handler>\n` +
    `    </ActivityAction>\n` +
    `  </${tag}.Body>\n` +
    `</${tag}>`;
}

function resolveUseExcelTemplate(
  node: ActivityNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  emissionContext: EmissionContext,
): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const excelFile = getPropString(props, "ExcelFile", "excelFile", "FilePath", "filePath") || "PLACEHOLDER_ExcelFile";
  const tag = getActivityTag("UseExcel");

  const bodyChildren = (node as any).bodyChildren || (node as any).children || [];
  let bodyXml = "";
  if (Array.isArray(bodyChildren) && bodyChildren.length > 0) {
    bodyXml = bodyChildren
      .map((child: WorkflowNode) => assembleNode(child, allVariables, processType, 0, emissionContext))
      .join("\n");
  }
  if (!bodyXml.trim()) {
    bodyXml = `<ui:Comment Text="TODO: Add Excel activities here" DisplayName="Placeholder" />`;
  }

  return `<${tag} DisplayName="${displayName}" ExcelFile="${escapeXml(smartBracketWrap(excelFile))}">\n` +
    `  <${tag}.Body>\n` +
    `    <ActivityAction x:TypeArguments="x:Object">\n` +
    `      <ActivityAction.Handler>\n` +
    `        <Sequence DisplayName="Excel Body">\n` +
    `          ${bodyXml}\n` +
    `        </Sequence>\n` +
    `      </ActivityAction.Handler>\n` +
    `    </ActivityAction>\n` +
    `  </${tag}.Body>\n` +
    `</${tag}>`;
}

function resolveDynamicTemplate(node: ActivityNode, processType: ProcessType, emissionContext: EmissionContext = "normal"): string {
  const props = node.properties || {};
  const displayName = escapeXml(node.displayName);
  const templateName = node.template;

  const strictPrefix = getActivityPrefixStrict(templateName);
  if (strictPrefix === null) {
    const isMandatoryPath = emissionContext === "mandatory-catch" || emissionContext === "mandatory-finally";
    console.warn(`[Tree Assembler] Activity "${templateName}" has no resolved namespace mapping — emitting as unsupported`);
    if (_activeRemediationContext) {
      _activeRemediationContext.propertyRemediations.push({
        level: "activity",
        file: _activeRemediationContext.fileName,
        remediationCode: "STUB_ACTIVITY_CATALOG_VIOLATION",
        originalTag: templateName,
        originalDisplayName: node.displayName,
        propertyName: "(unmapped-namespace)",
        reason: `Activity "${templateName}" could not be resolved to a known UiPath package namespace. Business step "${node.displayName}" requires manual implementation.${isMandatoryPath ? " This is in a mandatory execution path — workflow is BLOCKED." : ""}`,
        classifiedCheck: "UNMAPPED_NAMESPACE",
        developerAction: `Resolve namespace mapping for "${templateName}" and re-implement "${node.displayName}"`,
        estimatedEffortMinutes: isMandatoryPath ? 30 : 20,
      });
    }
    if (isMandatoryPath) {
      return `<!-- BLOCKED: Unmapped namespace for "${escapeXml(templateName)}" in mandatory path -->
<ui:LogMessage Level="Error" Message="[&quot;BLOCKED: Activity &apos;${escapeXml(templateName)}&apos; has no resolved namespace — business step &apos;${escapeXml(node.displayName)}&apos; requires manual implementation&quot;]" DisplayName="Log Unmapped Activity (${escapeXml(node.displayName)})" />
<Rethrow DisplayName="Rethrow — unmapped activity &apos;${escapeXml(node.displayName)}&apos;" />`;
    }
    return `<!-- WARNING: Unmapped namespace for "${escapeXml(templateName)}" — "${escapeXml(node.displayName)}" -->
<ui:Comment Text="[BLOCKED] Unmapped namespace: ${escapeXml(templateName)}. Business step &quot;${escapeXml(node.displayName)}&quot; requires manual namespace resolution." DisplayName="${escapeXml(node.displayName)} (unmapped namespace — manual fix required)" />
<ui:LogMessage Level="Warn" Message="[&quot;WARNING: Activity &apos;${escapeXml(templateName)}&apos; has no resolved namespace — &apos;${escapeXml(node.displayName)}&apos; requires manual implementation&quot;]" DisplayName="Log Unmapped Activity Warning" />`;
  }

  const tag = strictPrefix ? `${strictPrefix}:${templateName}` : templateName;

  const attrParts: string[] = [`DisplayName="${displayName}"`];
  const childParts: string[] = [];

  let schema: any = null;
  if (!catalogService.isLoaded()) {
    try { catalogService.load(); } catch (e) { }
  }
  if (catalogService.isLoaded()) {
    schema = catalogService.getActivitySchema(templateName);
  }

  const escalationThreshold = _activeRemediationContext?.escalationThreshold ?? PROPERTY_REMEDIATION_ESCALATION_THRESHOLD;
  const propertyFailures: PropertyRemediationRecord[] = [];
  const pendingPropertyRemediations: Array<{ propertyName: string; code: RemediationCode; reason: string }> = [];

  for (const [key, rawValue] of Object.entries(props)) {
    if (key.startsWith("_") || key === "displayName" || key === "DisplayName") continue;

    const value = isValueIntent(rawValue) ? buildExpression(rawValue as ValueIntent) : normalizeStringToExpression(String(rawValue));

    const validationResult = validatePropertyValue(key, value, schema, templateName);
    if (validationResult && _activeRemediationContext) {
      const safeDefault = getSafeDefaultForProperty(key, validationResult.code);
      propertyFailures.push({
        propertyName: key,
        remediationCode: validationResult.code,
        reason: validationResult.reason,
        originalValue: value,
        replacementValue: safeDefault,
      });
    }

    if (propertyFailures.length > escalationThreshold) {
      const isMandatoryPath = emissionContext === "mandatory-catch" || emissionContext === "mandatory-finally";
      if (_activeRemediationContext) {
        _activeRemediationContext.propertyRemediations.push({
          level: "activity",
          file: _activeRemediationContext.fileName,
          remediationCode: "STUB_ACTIVITY_PROPERTY_ESCALATION",
          originalTag: templateName,
          originalDisplayName: node.displayName,
          propertyName: isMandatoryPath ? "(escalated-mandatory-path)" : "(escalated)",
          reason: `${propertyFailures.length} properties failed validation (threshold: ${escalationThreshold}) — escalating to activity-level stub${isMandatoryPath ? ". This is in a mandatory execution path — workflow is BLOCKED." : ""}`,
          classifiedCheck: "STUB_ACTIVITY_PROPERTY_ESCALATION",
          developerAction: `Re-implement "${node.displayName}" (${templateName}) in ${_activeRemediationContext.fileName} — ${propertyFailures.length} properties failed: ${propertyFailures.map(f => f.propertyName).join(', ')}`,
          estimatedEffortMinutes: isMandatoryPath ? 30 : 20,
        });
      }
      if (isMandatoryPath) {
        return `<!-- BLOCKED: Property escalation for "${escapeXml(templateName)}" in mandatory path -->
<ui:LogMessage Level="Error" Message="[&quot;BLOCKED: Activity &apos;${escapeXml(templateName)}&apos; failed property validation in mandatory path — business step &apos;${escapeXml(node.displayName)}&apos; requires manual implementation&quot;]" DisplayName="Log Blocked Activity (${escapeXml(node.displayName)})" />
<Rethrow DisplayName="Rethrow — blocked activity &apos;${escapeXml(node.displayName)}&apos;" />`;
      }
      return `<ui:Comment Text="[TODO: Re-implement ${escapeXml(templateName)} activity — ${escapeXml(node.displayName)}. ${propertyFailures.length} properties failed validation. Original properties: ${propertyFailures.map(f => f.propertyName).join(', ')}]" DisplayName="${displayName} (stub)" />`;
    }

    let effectiveValue = value;
    if (validationResult && _activeRemediationContext) {
      const safeDefault = getSafeDefaultForProperty(key, validationResult.code);
      effectiveValue = safeDefault;
      pendingPropertyRemediations.push({
        propertyName: key,
        code: validationResult.code,
        reason: validationResult.reason,
      });
    }

    let isChildElement = false;
    if (schema) {
      const propDef = schema.activity.properties.find((p: any) => p.name === key);
      if (propDef && propDef.xamlSyntax === "child-element") {
        isChildElement = true;
        const wrapper = propDef.argumentWrapper || "InArgument";
        const typeArg = propDef.typeArguments ? ` x:TypeArguments="${propDef.typeArguments}"` : "";
        const wrappedValue = validationResult ? effectiveValue : (isValueIntent(rawValue) ? buildExpression(rawValue as ValueIntent) : smartBracketWrap(lintAndFixVbExpression(effectiveValue)));
        const safeWrappedValue = escapeXmlTextContent(wrappedValue);
        childParts.push(
          `  <${tag}.${key}>\n` +
          `    <${wrapper}${typeArg}>${safeWrappedValue}</${wrapper}>\n` +
          `  </${tag}.${key}>`
        );
      }
    }

    if (!isChildElement) {
      const propDef = schema?.activity?.properties?.find((p: any) => p.name === key);
      const enumLiteral = propDef?.validValues?.length ? normalizeEnumValue(effectiveValue, propDef.validValues) : null;
      const attrValue = enumLiteral ?? lintAndFixVbExpression(effectiveValue);
      attrParts.push(`${key}="${escapeXml(attrValue)}"`);
    }
  }

  for (const pending of pendingPropertyRemediations) {
    recordPropertyRemediation(pending.propertyName, pending.code, pending.reason, templateName, node.displayName);
  }

  if (node.outputVar) {
    const outputType = node.outputType || "x:Object";
    childParts.push(
      `  <${tag}.Result>\n` +
      `    <OutArgument x:TypeArguments="${mapClrType(outputType)}">${escapeXmlTextContent(ensureBracketWrapped(node.outputVar))}</OutArgument>\n` +
      `  </${tag}.Result>`
    );
  }

  if (childParts.length === 0) {
    return `<${tag} ${attrParts.join(" ")} />`;
  }

  return `<${tag} ${attrParts.join(" ")}>\n${childParts.join("\n")}\n</${tag}>`;
}

const HIGH_RISK_TEMPLATES = new Set([
  "HttpClient",
  "ExecuteQuery",
  "SendSmtpMailMessage",
  "InvokeCode",
  "StartProcess",
  "TypeInto",
  "Click",
  "GetCredential",
  "GetAsset",
  "AddQueueItem",
  "GetTransactionItem",
  "SetTransactionStatus",
  "ExcelApplicationScope",
  "UseExcel",
  "ReadRange",
  "WriteRange",
  "ReadTextFile",
  "WriteTextFile",
  "ReadCsvFile",
  "WriteCsvFile",
]);

function isHighRiskTemplate(templateName: string): boolean {
  return HIGH_RISK_TEMPLATES.has(templateName);
}

function wrapInTryCatch(innerXml: string, displayName: string): string {
  const effectiveInnerXml = innerXml.trim()
    ? innerXml
    : `<ui:Comment DisplayName="TODO: Implement try block logic" Text="This TryCatch was generated without try content — add activities here." />`;
  return `<TryCatch DisplayName="Try: ${escapeXml(displayName)}">
  <TryCatch.Try>
    <Sequence DisplayName="Try Block">
      ${effectiveInnerXml}
    </Sequence>
  </TryCatch.Try>
  <TryCatch.Catches>
    <Catch x:TypeArguments="s:Exception">
      <ActivityAction x:TypeArguments="s:Exception">
        <ActivityAction.Argument>
          <DelegateInArgument x:TypeArguments="s:Exception" Name="exception" />
        </ActivityAction.Argument>
        <Sequence DisplayName="Handle Exception">
          <ui:LogMessage Level="Error" Message="[&quot;Error in ${escapeXml(displayName)} (&quot; &amp; exception.GetType().Name &amp; &quot;): &quot; &amp; exception.Message]" DisplayName="Log Exception" />
          <Rethrow DisplayName="Rethrow Exception" />
        </Sequence>
      </ActivityAction>
    </Catch>
  </TryCatch.Catches>
</TryCatch>`;
}

function sanitizeRetryInterval(val: string): string {
  if (!val) return "00:00:05";
  const trimmed = val.trim();
  if (/^\d{2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{1,2}:\d{2}:\d{2}\.\d+$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (/^[a-zA-Z_]/.test(trimmed) && /[.()\s]/.test(trimmed)) {
    console.warn(`[RetryInterval] Bracket-wrapping VB expression: ${trimmed}`);
    return `[${trimmed}]`;
  }
  if (/^[a-zA-Z_]\w*$/.test(trimmed)) {
    console.warn(`[RetryInterval] Bracket-wrapping variable reference: ${trimmed}`);
    return `[${trimmed}]`;
  }
  console.warn(`[RetryInterval] Unrecognized value "${trimmed}" — replacing with safe default 00:00:05`);
  return "00:00:05";
}

function wrapInRetryScope(innerXml: string, displayName: string, retries: number = 3, interval: string = "00:00:05"): string {
  const safeInterval = sanitizeRetryInterval(interval);
  const effectiveInnerXml = innerXml.trim()
    ? innerXml
    : `<ui:LogMessage Level="Trace" DisplayName="TODO: Implement RetryScope body" Message="[&quot;Placeholder — RetryScope body has no activities yet&quot;]" />`;
  return `<ui:RetryScope NumberOfRetries="${retries}" RetryInterval="${safeInterval}" DisplayName="Retry: ${escapeXml(displayName)}">
  <ui:RetryScope.Condition>
    <ui:ShouldRetry />
  </ui:RetryScope.Condition>
  <Sequence DisplayName="Retry Body">
    ${effectiveInnerXml}
  </Sequence>
</ui:RetryScope>`;
}

export function assembleNode(
  node: WorkflowNode,
  allVariables: VariableDeclaration[] = [],
  processType: ProcessType = "general",
  depthLevel: number = 0,
  emissionContext: EmissionContext = "normal",
): string {
  switch (node.kind) {
    case "activity":
      return assembleActivityNode(node, allVariables, processType, emissionContext);
    case "sequence":
      return assembleSequenceNode(node, allVariables, processType, depthLevel, emissionContext);
    case "tryCatch":
      return assembleTryCatchNode(node, allVariables, processType, depthLevel, emissionContext);
    case "if":
      return assembleIfNode(node, allVariables, processType, depthLevel, emissionContext);
    case "while":
      return assembleWhileNode(node, allVariables, processType, depthLevel, emissionContext);
    case "forEach":
      return assembleForEachNode(node, allVariables, processType, depthLevel, emissionContext);
    case "retryScope":
      return assembleRetryScopeNode(node, allVariables, processType, depthLevel, emissionContext);
    default:
      return `<!-- Unknown node kind -->`;
  }
}

function assembleActivityNode(
  node: ActivityNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  emissionContext: EmissionContext = "normal",
): string {
  let xml = resolveActivityTemplate(node, allVariables, processType, emissionContext);

  if (node.errorHandling === "catch" || node.errorHandling === "escalate") {
    xml = wrapInTryCatch(xml, node.displayName);
  } else if (node.errorHandling === "retry") {
    xml = wrapInRetryScope(xml, node.displayName);
  } else if ((!node.errorHandling || node.errorHandling === "none") && isHighRiskTemplate(node.template) && emissionContext !== "inside-trycatch" && emissionContext !== "mandatory-catch" && emissionContext !== "mandatory-finally") {
    xml = wrapInTryCatch(xml, node.displayName);
  }

  return xml;
}

function assembleSequenceNode(
  node: SequenceNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  depthLevel: number,
  emissionContext: EmissionContext = "normal",
): string {
  const displayName = escapeXml(node.displayName);
  const childrenXml = node.children
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, emissionContext))
    .join("\n");

  let varsBlock = "";
  if (node.variables && node.variables.length > 0) {
    varsBlock = "  <Sequence.Variables>\n";
    for (const v of node.variables) {
      let typeAttr = mapClrType(v.type);
      if (typeAttr === "x:Object") {
        const prefixType = inferTypeFromPrefix(v.name);
        if (prefixType) {
          typeAttr = prefixType;
        } else {
          const defaultType = inferTypeFromDefault(v.default);
          if (defaultType) typeAttr = defaultType;
        }
      }
      let defaultAttr = "";
      if (v.default) {
        const isObjectType = typeAttr === "x:Object" || typeAttr.includes("System.Object");
        if (isObjectType) {
          console.warn(`[Variable Guard] Omitting Default="${v.default}" for x:Object variable "${v.name}" — UiPath does not support Literal<Object>`);
        } else {
          const wrappedDefault = wrapVariableDefault(v.default, v.type);
          defaultAttr = ` Default="${escapeXml(wrappedDefault)}"`;
        }
      }
      varsBlock += `    <Variable x:TypeArguments="${typeAttr}" Name="${escapeXml(v.name)}"${defaultAttr} />\n`;
    }
    varsBlock += "  </Sequence.Variables>\n";
  }

  return `<Sequence DisplayName="${displayName}">\n${varsBlock}  ${childrenXml}\n</Sequence>`;
}

function assembleTryCatchNode(
  node: TryCatchNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  depthLevel: number,
  _parentEmissionContext: EmissionContext = "normal",
): string {
  const displayName = escapeXml(node.displayName);
  let tryXml = node.tryChildren
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, "inside-trycatch"))
    .join("\n");

  if (!tryXml.trim()) {
    const stepContext = node.displayName || "try block";
    const targetSystemHints: string[] = [];
    for (const child of node.tryChildren) {
      if (child.kind === "activity" && child.properties) {
        const sys = child.properties.Application || child.properties.BrowserType || child.properties.Target || child.properties.WorkflowFileName || "";
        if (sys) targetSystemHints.push(sys);
      }
    }
    const systemNote = targetSystemHints.length > 0 ? ` Target system: ${targetSystemHints.join(", ")}.` : "";
    tryXml = `<ui:Comment DisplayName="TODO: Implement ${escapeXml(stepContext)}" Text="TryCatch step &quot;${escapeXml(stepContext)}&quot; was generated without try content — implement the business logic for this step.${escapeXml(systemNote)}" />`;
  }

  const catchXml = node.catchChildren.length > 0
    ? node.catchChildren
        .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, "mandatory-catch"))
        .join("\n")
    : `<ui:LogMessage Level="Error" Message="[&quot;Error: &quot; &amp; exception.Message]" DisplayName="Log Exception" />\n<Rethrow DisplayName="Rethrow Exception" />`;

  const finallyXml = node.finallyChildren
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, "mandatory-finally"))
    .join("\n");

  let xml = `<TryCatch DisplayName="${displayName}">\n`;
  xml += `  <TryCatch.Try>\n`;
  xml += `    <Sequence DisplayName="Try Block">\n`;
  xml += `      ${tryXml}\n`;
  xml += `    </Sequence>\n`;
  xml += `  </TryCatch.Try>\n`;
  xml += `  <TryCatch.Catches>\n`;
  xml += `    <Catch x:TypeArguments="s:Exception">\n`;
  xml += `      <ActivityAction x:TypeArguments="s:Exception">\n`;
  xml += `        <ActivityAction.Argument>\n`;
  xml += `          <DelegateInArgument x:TypeArguments="s:Exception" Name="exception" />\n`;
  xml += `        </ActivityAction.Argument>\n`;
  xml += `        <Sequence DisplayName="Handle Exception">\n`;
  xml += `          ${catchXml}\n`;
  xml += `        </Sequence>\n`;
  xml += `      </ActivityAction>\n`;
  xml += `    </Catch>\n`;
  xml += `  </TryCatch.Catches>\n`;
  if (finallyXml.trim()) {
    xml += `  <TryCatch.Finally>\n`;
    xml += `    <Sequence DisplayName="Finally Block">\n`;
    xml += `      ${finallyXml}\n`;
    xml += `    </Sequence>\n`;
    xml += `  </TryCatch.Finally>\n`;
  }
  xml += `</TryCatch>`;

  return xml;
}

const CSHARP_BLOCKERS = [
  { pattern: /=>\s*\{/, desc: "C# lambda expression" },
  { pattern: /\$"/, desc: "C# string interpolation" },
  { pattern: /\?\?/, desc: "C# null coalescing operator" },
  { pattern: /\?\.\w/, desc: "C# null conditional operator" },
  { pattern: /\bvar\s+\w/, desc: "C# var keyword" },
  { pattern: /\bforeach\s*\(/, desc: "C# foreach" },
  { pattern: /\busing\s*\(/, desc: "C# using statement" },
];

export function lintAndFixVbExpression(expr: string): string {
  if (!expr || !expr.trim()) return expr;
  const trimmed = expr.trim();
  if (/^"[^"]*"$/.test(trimmed)) return expr;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return expr;
  if (trimmed === "True" || trimmed === "False" || trimmed === "Nothing") return expr;

  for (const { pattern, desc } of CSHARP_BLOCKERS) {
    if (pattern.test(trimmed)) {
      console.error(`[VB Lint BLOCKED] Expression contains unconvertible C# syntax (${desc}): "${trimmed}"`);
      throw new CSharpExpressionBlockedError(desc, trimmed);
    }
  }

  const result = lintExpression(expr);
  if (result.corrected && result.corrected !== expr) {
    console.log(`[VB Lint Pre-Emission] Auto-corrected expression: "${expr}" → "${result.corrected}"`);
    return result.corrected;
  }
  return expr;
}

function resolveConditionValue(condition: string | ValueIntent): string {
  if (isValueIntent(condition)) {
    const built = buildExpression(condition as ValueIntent);
    return escapeXmlExpression(lintAndFixVbExpression(built));
  }
  const trimmed = (condition as string).trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    const linted = lintAndFixVbExpression(inner);
    return `[${escapeXmlExpression(linted)}]`;
  }
  if (trimmed === "True" || trimmed === "False") return trimmed;
  const linted = lintAndFixVbExpression(trimmed);
  if (/[<>=]/.test(linted) || /\b(And|Or|Not|AndAlso|OrElse|Is|IsNot|Like)\b/.test(linted)) {
    return `[${escapeXmlExpression(linted)}]`;
  }
  return escapeXmlExpression(linted);
}

function assembleIfNode(
  node: IfNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  depthLevel: number,
  emissionContext: EmissionContext = "normal",
): string {
  const displayName = escapeXml(node.displayName);
  const condition = resolveConditionValue(node.condition);

  const thenXml = node.thenChildren
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, emissionContext))
    .join("\n");

  const elseXml = node.elseChildren
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, emissionContext))
    .join("\n");

  const thenContent = thenXml.trim()
    ? thenXml
    : `<ui:LogMessage Level="Trace" DisplayName="TODO: Implement Then branch" Message="[&quot;Placeholder — Then branch has no activities yet&quot;]" />`;

  let xml = `<If Condition="${condition}" DisplayName="${displayName}">\n`;
  xml += `  <If.Then>\n`;
  xml += `    <Sequence DisplayName="Then">\n`;
  xml += `      ${thenContent}\n`;
  xml += `    </Sequence>\n`;
  xml += `  </If.Then>\n`;
  if (elseXml.trim()) {
    xml += `  <If.Else>\n`;
    xml += `    <Sequence DisplayName="Else">\n`;
    xml += `      ${elseXml}\n`;
    xml += `    </Sequence>\n`;
    xml += `  </If.Else>\n`;
  }
  xml += `</If>`;

  return xml;
}

function assembleWhileNode(
  node: WhileNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  depthLevel: number,
  emissionContext: EmissionContext = "normal",
): string {
  const displayName = escapeXml(node.displayName);
  const condition = resolveConditionValue(node.condition);

  const bodyXml = node.bodyChildren
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, emissionContext))
    .join("\n");

  const bodyContent = bodyXml.trim()
    ? bodyXml
    : `<ui:LogMessage Level="Trace" DisplayName="TODO: Implement While body" Message="[&quot;Placeholder — While body has no activities yet&quot;]" />`;

  return `<While Condition="${condition}" DisplayName="${displayName}">\n` +
    `  <While.Body>\n` +
    `    <Sequence DisplayName="While Body">\n` +
    `      ${bodyContent}\n` +
    `    </Sequence>\n` +
    `  </While.Body>\n` +
    `</While>`;
}

function inferCollectionItemType(declaredType: string): string | null {
  const lower = declaredType.toLowerCase();
  if (lower.includes("datatable")) return "scg2:DataRow";

  const listMatch = declaredType.match(/List\s*\(\s*Of\s+(\w+)\s*\)/i)
    || declaredType.match(/List<([^>]+)>/i)
    || declaredType.match(/System\.Collections\.Generic\.List.*?<([^>]+)>/i);
  if (listMatch) {
    return mapClrType(listMatch[1].trim());
  }

  const arrayMatch = declaredType.match(/Array\s*\(\s*Of\s+(\w+)\s*\)/i)
    || declaredType.match(/Array<([^>]+)>/i)
    || declaredType.match(/(\w+)\[\]/);
  if (arrayMatch) {
    return mapClrType(arrayMatch[1].trim());
  }

  const dictMatch = declaredType.match(/Dictionary\s*\(\s*Of\s+(\w+)\s*,\s*(\w+)\s*\)/i)
    || declaredType.match(/Dictionary<([^,]+),\s*([^>]+)>/i);
  if (dictMatch) {
    const keyType = mapClrType(dictMatch[1].trim());
    const valType = mapClrType(dictMatch[2].trim());
    return `scg:KeyValuePair(${keyType}, ${valType})`;
  }

  const scgListMatch = declaredType.match(/^scg:List\((.+)\)$/);
  if (scgListMatch) {
    return scgListMatch[1].trim();
  }

  const scgDictMatch = declaredType.match(/^scg:Dictionary\((.+),\s*(.+)\)$/);
  if (scgDictMatch) {
    return `scg:KeyValuePair(${scgDictMatch[1].trim()}, ${scgDictMatch[2].trim()})`;
  }

  return null;
}

function inferForEachItemType(itemType: string, valuesExpression: string, allVariables: VariableDeclaration[]): string {
  const expr = valuesExpression.trim().replace(/^\[|\]$/g, "");

  const isDataTableIteration = /\bdt_\w*\.Rows\b/i.test(expr) || /\.AsEnumerable\(\)/i.test(expr)
    || /\bDataTable\b.*\.Rows\b/i.test(expr) || /^(\w+)\.Rows$/i.test(expr);

  if (isDataTableIteration) {
    return "scg2:DataRow";
  }

  let expressionInferred: string | null = null;
  const simpleVarMatch = expr.match(/^(\w+)$/);
  if (simpleVarMatch) {
    const varName = simpleVarMatch[1];
    const decl = allVariables.find(v => v.name === varName);
    if (decl) {
      expressionInferred = inferCollectionItemType(decl.type);
      if (!expressionInferred) {
        const mappedVarType = mapClrType(decl.type);
        expressionInferred = inferCollectionItemType(mappedVarType);
      }
    }
  }

  if (expressionInferred) {
    return expressionInferred;
  }

  if (itemType && itemType !== "x:Object") {
    const mappedItem = mapClrType(itemType);
    if (mappedItem === "x:String" && isDataTableIteration) {
      return "scg2:DataRow";
    }
    return mappedItem;
  }
  return itemType || "x:Object";
}

function validateForEachTypeConsistency(itemType: string, valuesExpression: string): string {
  const expr = valuesExpression.trim().replace(/^\[|\]$/g, "");
  const isDataTableIteration = /\bdt_\w*\.Rows\b/i.test(expr) || /\.AsEnumerable\(\)/i.test(expr)
    || /\bDataTable\b.*\.Rows\b/i.test(expr) || /^(\w+)\.Rows$/i.test(expr);

  if (isDataTableIteration && itemType !== "scg2:DataRow") {
    console.warn(`[ForEach Guard] Type mismatch: x:TypeArguments="${itemType}" but Values expression "${expr}" iterates DataTable rows — auto-correcting to scg2:DataRow`);
    return "scg2:DataRow";
  }

  if (itemType === "x:String" && /\.Rows\b/i.test(expr)) {
    console.warn(`[ForEach Guard] Type mismatch: x:TypeArguments="x:String" but Values expression "${expr}" appears to iterate rows — auto-correcting to scg2:DataRow`);
    return "scg2:DataRow";
  }

  return itemType;
}

function assembleForEachNode(
  node: ForEachNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  depthLevel: number,
  emissionContext: EmissionContext = "normal",
): string {
  const displayName = escapeXml(node.displayName);
  const inferredType = inferForEachItemType(node.itemType || "x:Object", node.valuesExpression, allVariables);
  const itemType = validateForEachTypeConsistency(inferredType, node.valuesExpression);
  const wrappedValues = ensureBracketWrapped(node.valuesExpression);

  const bodyXml = node.bodyChildren
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, emissionContext))
    .join("\n");

  const bodyContent = bodyXml.trim()
    ? bodyXml
    : `<ui:LogMessage Level="Trace" DisplayName="TODO: Implement ForEach body" Message="[&quot;Placeholder — ForEach body has no activities yet&quot;]" />`;

  const valuesInner = wrappedValues.startsWith("[") && wrappedValues.endsWith("]")
    ? `[${escapeXmlExpression(wrappedValues.slice(1, -1))}]`
    : escapeXmlExpression(wrappedValues);
  return `<ForEach x:TypeArguments="${itemType}" Values="${valuesInner}" DisplayName="${displayName}">\n` +
    `  <ActivityAction x:TypeArguments="${itemType}">\n` +
    `    <ActivityAction.Argument>\n` +
    `      <DelegateInArgument x:TypeArguments="${itemType}" Name="${escapeXml(node.iteratorName || "item")}" />\n` +
    `    </ActivityAction.Argument>\n` +
    `    <Sequence DisplayName="Body">\n` +
    `      ${bodyContent}\n` +
    `    </Sequence>\n` +
    `  </ActivityAction>\n` +
    `</ForEach>`;
}

function assembleRetryScopeNode(
  node: RetryScopeNode,
  allVariables: VariableDeclaration[],
  processType: ProcessType,
  depthLevel: number,
  emissionContext: EmissionContext = "normal",
): string {
  const displayName = escapeXml(node.displayName);

  const bodyXml = node.bodyChildren
    .map(child => assembleNode(child, allVariables, processType, depthLevel + 1, emissionContext))
    .join("\n");

  const bodyContent = bodyXml.trim()
    ? bodyXml
    : `<ui:LogMessage Level="Trace" DisplayName="TODO: Implement RetryScope body" Message="[&quot;Placeholder — RetryScope body has no activities yet&quot;]" />`;

  const safeInterval = sanitizeRetryInterval(node.retryInterval);
  return `<ui:RetryScope NumberOfRetries="${node.numberOfRetries}" RetryInterval="${safeInterval}" DisplayName="${displayName}">\n` +
    `  <ui:RetryScope.Condition>\n` +
    `    <ui:ShouldRetry />\n` +
    `  </ui:RetryScope.Condition>\n` +
    `  <Sequence DisplayName="Retry Body">\n` +
    `    ${bodyContent}\n` +
    `  </Sequence>\n` +
    `</ui:RetryScope>`;
}

function buildVariablesBlock(variables: VariableDeclaration[]): string {
  if (variables.length === 0) return "";
  let xml = "<Sequence.Variables>\n";
  const seen = new Set<string>();
  for (const v of variables) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    let typeAttr = mapClrType(v.type);
    if (typeAttr === "x:Object") {
      const prefixType = inferTypeFromPrefix(v.name);
      if (prefixType) {
        typeAttr = prefixType;
      } else {
        const defaultType = inferTypeFromDefault(v.default);
        if (defaultType) typeAttr = defaultType;
      }
    }
    let defaultAttr = "";
    if (v.default) {
      const isObjectType = typeAttr === "x:Object" || typeAttr.includes("System.Object");
      if (isObjectType) {
        console.warn(`[Variable Guard] Omitting Default="${v.default}" for x:Object variable "${v.name}" — UiPath does not support Literal<Object>`);
      } else {
        const wrappedDefault = wrapVariableDefault(v.default, v.type);
        defaultAttr = ` Default="${escapeXml(wrappedDefault)}"`;
      }
    }
    xml += `      <Variable x:TypeArguments="${typeAttr}" Name="${escapeXml(v.name)}"${defaultAttr} />\n`;
  }
  xml += "    </Sequence.Variables>";
  return xml;
}

function buildXMembersBlock(
  args: Array<{ name: string; direction: string; type: string }>
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
  return lines.join("\n") + "\n";
}

function collectGetCredentialNodes(node: WorkflowNode): ActivityNode[] {
  const results: ActivityNode[] = [];
  if (node.kind === "activity" && node.template === "GetCredential") {
    results.push(node);
  } else if (node.kind === "sequence") {
    for (const child of node.children) results.push(...collectGetCredentialNodes(child));
  } else if (node.kind === "tryCatch") {
    for (const child of [...node.tryChildren, ...node.catchChildren, ...node.finallyChildren]) results.push(...collectGetCredentialNodes(child));
  } else if (node.kind === "if") {
    for (const child of [...node.thenChildren, ...node.elseChildren]) results.push(...collectGetCredentialNodes(child));
  } else if (node.kind === "while" || node.kind === "forEach" || node.kind === "retryScope") {
    for (const child of node.bodyChildren) results.push(...collectGetCredentialNodes(child));
  }
  return results;
}

function crossCheckGetCredentialVariableTypes(
  rootSequence: { children: WorkflowNode[]; variables?: VariableDeclaration[] },
  allVariables: VariableDeclaration[],
): void {
  const credNodes: ActivityNode[] = [];
  for (const child of rootSequence.children) {
    credNodes.push(...collectGetCredentialNodes(child));
  }

  for (const node of credNodes) {
    const props = node.properties || {};
    const passwordVar = (props.Password as string) || (props.password as string) || "sec_Password";
    const usernameVar = (props.Username as string) || (props.username as string) || "str_Username";

    const pwDecl = allVariables.find(v => v.name === passwordVar);
    if (pwDecl) {
      const mapped = mapClrType(pwDecl.type);
      if (mapped !== "s:Security.SecureString") {
        console.log(`[CrossCheck] Fixing variable ${passwordVar} type from ${pwDecl.type} to SecureString for GetCredential.Password`);
        pwDecl.type = "SecureString";
      }
    } else {
      allVariables.push({ name: passwordVar, type: "SecureString" });
      console.log(`[CrossCheck] Added missing variable ${passwordVar} as SecureString for GetCredential.Password`);
    }

    const unDecl = allVariables.find(v => v.name === usernameVar);
    if (!unDecl) {
      allVariables.push({ name: usernameVar, type: "String" });
      console.log(`[CrossCheck] Added missing variable ${usernameVar} as String for GetCredential.Username`);
    }
  }
}

function replaceVariableRefsInString(str: string, renameMap: Map<string, string>): string {
  let result = str;
  renameMap.forEach((newName, oldName) => {
    if (oldName === newName) return;
    const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\b${escaped}\\b`, "g"), newName);
  });
  return result;
}

function sanitizeVariableDeclarations(
  vars: VariableDeclaration[],
  renameMap: Map<string, string>,
): VariableDeclaration[] {
  const seen = new Set<string>();
  return vars.map(v => {
    const safeName = sanitizeVariableName(v.name);
    if (safeName !== v.name) {
      renameMap.set(v.name, safeName);
    }
    let finalName = safeName;
    let counter = 2;
    while (seen.has(finalName)) {
      finalName = `${safeName}_${counter}`;
      counter++;
    }
    if (finalName !== safeName && safeName !== v.name) {
      renameMap.set(v.name, finalName);
    }
    seen.add(finalName);
    return { ...v, name: finalName };
  });
}

function sanitizeNodeVariableRefs(node: WorkflowNode, renameMap: Map<string, string>): WorkflowNode {
  if (renameMap.size === 0) return node;

  if (node.kind === "activity") {
    const newProps: Record<string, PropertyValue> = {};
    for (const [k, v] of Object.entries(node.properties)) {
      if (typeof v === "string") {
        newProps[k] = replaceVariableRefsInString(v, renameMap);
      } else {
        newProps[k] = v;
      }
    }
    const newOutputVar = node.outputVar ? replaceVariableRefsInString(node.outputVar, renameMap) : node.outputVar;
    return { ...node, properties: newProps, outputVar: newOutputVar };
  }

  if (node.kind === "sequence") {
    const localVars = node.variables ? sanitizeVariableDeclarations(node.variables, renameMap) : node.variables;
    return {
      ...node,
      variables: localVars,
      children: node.children.map(c => sanitizeNodeVariableRefs(c, renameMap)),
    };
  }

  if (node.kind === "tryCatch") {
    return {
      ...node,
      tryChildren: node.tryChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
      catchChildren: node.catchChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
      finallyChildren: node.finallyChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
    };
  }

  if (node.kind === "if") {
    const newCond = typeof node.condition === "string"
      ? replaceVariableRefsInString(node.condition, renameMap)
      : node.condition;
    return {
      ...node,
      condition: newCond,
      thenChildren: node.thenChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
      elseChildren: node.elseChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
    };
  }

  if (node.kind === "while") {
    const newCond = typeof node.condition === "string"
      ? replaceVariableRefsInString(node.condition, renameMap)
      : node.condition;
    return {
      ...node,
      condition: newCond,
      bodyChildren: node.bodyChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
    };
  }

  if (node.kind === "forEach") {
    return {
      ...node,
      valuesExpression: replaceVariableRefsInString(node.valuesExpression, renameMap),
      iteratorName: sanitizeVariableName(node.iteratorName || "item"),
      bodyChildren: node.bodyChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
    };
  }

  if (node.kind === "retryScope") {
    return {
      ...node,
      bodyChildren: node.bodyChildren.map(c => sanitizeNodeVariableRefs(c, renameMap)),
    };
  }

  return node;
}

function injectTransactionItemNullGuard(activitiesXml: string, allVariables: VariableDeclaration[]): string {
  const transactionVarNames = allVariables
    .filter(v => v.type === "UiPath.Core.QueueItem" || v.type === "ui:QueueItem")
    .map(v => v.name);

  if (transactionVarNames.length === 0) {
    const defaultNames = ["qi_TransactionItem", "obj_TransactionItem", "out_TransactionItem"];
    for (const name of defaultNames) {
      if (activitiesXml.includes(`${name}.`)) {
        transactionVarNames.push(name);
      }
    }
  }

  if (transactionVarNames.length === 0) return activitiesXml;

  for (const varName of transactionVarNames) {
    const propAccessPattern = new RegExp(`${varName}\\.\\w+`);
    if (!propAccessPattern.test(activitiesXml)) continue;

    const alreadyGuarded = new RegExp(
      `Condition="\\[${varName}\\s+IsNot\\s+Nothing\\]"`,
      "i"
    ).test(activitiesXml);
    if (alreadyGuarded) continue;

    const topLevelActivities = extractTopLevelXmlElements(activitiesXml);
    if (topLevelActivities.length === 0) continue;

    const accessingElements: string[] = [];
    const nonAccessingElements: string[] = [];

    for (const elem of topLevelActivities) {
      if (propAccessPattern.test(elem)) {
        accessingElements.push(elem);
      } else {
        nonAccessingElements.push(elem);
      }
    }

    if (accessingElements.length === 0) continue;

    const guardedContent = accessingElements.join("\n    ");
    const guardedBlock =
      `<If DisplayName="Check ${varName} Not Null" Condition="[${varName} IsNot Nothing]">\n` +
      `      <If.Then>\n` +
      `        <Sequence DisplayName="${varName} Processing">\n` +
      `          ${guardedContent}\n` +
      `        </Sequence>\n` +
      `      </If.Then>\n` +
      `      <If.Else>\n` +
      `        <Sequence DisplayName="${varName} Is Null">\n` +
      `          <ui:LogMessage Level="Warn" Message="[&quot;${varName} is Nothing — skipping property access&quot;]" DisplayName="Null Guard: ${varName}" />\n` +
      `        </Sequence>\n` +
      `      </If.Else>\n` +
      `    </If>`;

    const rebuiltParts: string[] = [];
    let accessIdx = 0;
    let guardInserted = false;
    for (const elem of topLevelActivities) {
      if (propAccessPattern.test(elem)) {
        if (!guardInserted) {
          rebuiltParts.push(guardedBlock);
          guardInserted = true;
        }
        accessIdx++;
      } else {
        rebuiltParts.push(elem);
      }
    }

    activitiesXml = rebuiltParts.join("\n    ");
  }

  return activitiesXml;
}

function extractTopLevelXmlElements(xml: string): string[] {
  const elements: string[] = [];
  const trimmed = xml.trim();
  if (!trimmed) return elements;

  let i = 0;
  while (i < trimmed.length) {
    while (i < trimmed.length && trimmed[i] !== '<') i++;
    if (i >= trimmed.length) break;

    if (trimmed.substring(i, i + 4) === '<!--') {
      const commentEnd = trimmed.indexOf('-->', i + 4);
      if (commentEnd < 0) {
        elements.push(trimmed.substring(i));
        break;
      }
      elements.push(trimmed.substring(i, commentEnd + 3));
      i = commentEnd + 3;
      continue;
    }

    const tagNameMatch = trimmed.substring(i).match(/^<([a-zA-Z][\w:.]*)/);
    if (!tagNameMatch) {
      i++;
      continue;
    }

    const tagName = tagNameMatch[1];
    let depth = 0;
    let j = i;
    let foundEnd = false;

    while (j < trimmed.length) {
      const nextOpen = trimmed.indexOf('<', j);
      if (nextOpen < 0) break;

      if (trimmed[nextOpen + 1] === '/') {
        const closeTag = trimmed.substring(nextOpen).match(/^<\/([a-zA-Z][\w:.]*)\s*>/);
        if (closeTag) {
          if (depth === 0 && closeTag[1] === tagName) {
            const end = nextOpen + closeTag[0].length;
            elements.push(trimmed.substring(i, end));
            i = end;
            foundEnd = true;
            break;
          }
          if (closeTag[1] === tagName) depth--;
          j = nextOpen + closeTag[0].length;
          continue;
        }
      }

      const selfClose = trimmed.substring(nextOpen).match(/^<[a-zA-Z][\w:.]*[^>]*\/>/);
      if (selfClose && nextOpen === i && depth === 0) {
        elements.push(selfClose[0]);
        i = nextOpen + selfClose[0].length;
        foundEnd = true;
        break;
      }
      if (selfClose) {
        j = nextOpen + selfClose[0].length;
        continue;
      }

      const openTag = trimmed.substring(nextOpen).match(/^<([a-zA-Z][\w:.]*)/);
      if (openTag) {
        if (nextOpen !== i || depth > 0) {
          if (openTag[1] === tagName) depth++;
        }
        j = nextOpen + openTag[0].length;
      } else {
        j = nextOpen + 1;
      }
    }

    if (!foundEnd) {
      elements.push(trimmed.substring(i));
      break;
    }
  }

  return elements;
}

export function assembleWorkflowFromSpec(
  spec: WorkflowSpec,
  processType: ProcessType = "general",
): { xaml: string; variables: VariableDeclaration[] } {
  const workflowName = (spec.name || "Workflow").replace(/"/g, "").replace(/&quot;/g, "").replace(/\s+/g, "_");

  const renameMap = new Map<string, string>();
  const sanitizedTopVars = sanitizeVariableDeclarations(spec.variables || [], renameMap);
  const sanitizedRootVars = spec.rootSequence.variables
    ? sanitizeVariableDeclarations(spec.rootSequence.variables, renameMap)
    : undefined;
  const sanitizedRootChildren = spec.rootSequence.children.map(c => sanitizeNodeVariableRefs(c, renameMap));

  const allVariables = [...sanitizedTopVars];

  if (sanitizedRootVars) {
    for (const v of sanitizedRootVars) {
      if (!allVariables.find(av => av.name === v.name)) {
        allVariables.push(v);
      }
    }
  }

  if (!allVariables.find(v => v.name === "str_ScreenshotPath")) {
    allVariables.push({
      name: "str_ScreenshotPath",
      type: "String",
      default: '""',
    });
  }

  const sanitizedRootSequence = {
    ...spec.rootSequence,
    variables: sanitizedRootVars,
    children: sanitizedRootChildren,
  };
  crossCheckGetCredentialVariableTypes(sanitizedRootSequence, allVariables);

  collectImplicitOutputVariables(sanitizedRootChildren, allVariables);

  let activitiesXml: string;
  try {
    activitiesXml = sanitizedRootChildren
      .map(child => assembleNode(child, allVariables, processType))
      .join("\n    ");
  } catch (e) {
    if (e instanceof CSharpExpressionBlockedError) {
      console.error(`[VB Lint FATAL] Workflow "${workflowName}" blocked due to unconvertible C# expression: ${e.message}`);
      const blockedFallbackXaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${escapeXml(workflowName)}"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="${escapeXml(workflowName)}">
    <ui:Comment Text="[VB_EXPRESSION_BLOCKED] Workflow generation was blocked because an expression contained unconvertible C# syntax: ${escapeXml(e.message)}. The expression must be rewritten in VB.NET before this workflow can be generated." DisplayName="BLOCKED — C# Expression Not Convertible" />
  </Sequence>
</Activity>`;
      return { xaml: blockedFallbackXaml, variables: allVariables };
    }
    throw e;
  }

  activitiesXml = injectTransactionItemNullGuard(activitiesXml, allVariables);

  const isMainWorkflow = workflowName.toLowerCase() === "main" || workflowName.toLowerCase() === "main.xaml";
  const isInitAllSettings = workflowName.toLowerCase().includes("initallsettings");
  const wfArgs = [...(spec.arguments || [])];
  const hasDictConfigRef = !isMainWorkflow && !isInitAllSettings && activitiesXml.includes("dict_Config");
  if (hasDictConfigRef && !wfArgs.some(a => a.name === "in_Config")) {
    wfArgs.push({ name: "in_Config", direction: "InArgument", type: "scg:Dictionary(x:String, x:Object)" });
  }
  if (hasDictConfigRef && !allVariables.find(v => v.name === "dict_Config")) {
    allVariables.push({ name: "dict_Config", type: "scg:Dictionary(x:String, x:Object)", default: "[in_Config]" });
  }

  const existingArgNames = new Set(wfArgs.map(a => a.name));
  const existingVarNames = new Set(allVariables.map(v => v.name));
  const argScanXml = activitiesXml.replace(/<ui:InvokeWorkflowFile\.Arguments>[\s\S]*?<\/ui:InvokeWorkflowFile\.Arguments>/g, "");
  const argRefPattern = /\b(in_[A-Za-z]\w*|out_[A-Za-z]\w*|io_[A-Za-z]\w*)\b/g;
  let argMatch: RegExpExecArray | null;
  while ((argMatch = argRefPattern.exec(argScanXml)) !== null) {
    const argName = argMatch[1];
    if (existingArgNames.has(argName) || existingVarNames.has(argName)) continue;
    const direction = argName.startsWith("out_") ? "OutArgument"
      : argName.startsWith("io_") ? "InOutArgument"
      : "InArgument";
    const inferredType = inferTypeFromPrefix(argName) || "x:String";
    wfArgs.push({ name: argName, direction, type: inferredType });
    existingArgNames.add(argName);
    console.log(`[Argument Declaration] Tier 3 (expression scan): auto-declared ${direction} "${argName}" (${inferredType}) in "${workflowName}"`);
  }

  const variablesBlock = buildVariablesBlock(allVariables);
  const xMembersBlock = buildXMembersBlock(wfArgs);

  let xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${escapeXml(workflowName)}"
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
    ${variablesBlock}
    ${activitiesXml}
  </Sequence>
</Activity>`;

  xaml = sanitizeObjectLiteralArguments(xaml);

  xaml = deduplicateAssemblyAttributes(xaml);

  const containerResult = validateContainerChildModel(xaml, workflowName);
  xaml = containerResult.repairedXaml;
  for (const repair of containerResult.repairs) {
    console.log(`[Container Repair] ${workflowName}: ${repair}`);
  }
  if (containerResult.errors.length > 0) {
    for (const err of containerResult.errors) {
      console.error(`[Container Error] ${workflowName}: ${err}`);
    }
    const errorSummary = containerResult.errors.join("; ");
    const fallbackXaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${escapeXml(workflowName)}"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="${escapeXml(workflowName)}">
    <ui:Comment Text="[CONTAINER_VALIDATION_FAILED] Irrecoverable container structure error(s): ${escapeXml(errorSummary)}. Manual implementation required." DisplayName="Container Validation Failed — ${escapeXml(workflowName)}" />
  </Sequence>
</Activity>`;
    return { xaml: fallbackXaml, variables: allVariables };
  }

  xaml = sanitizeUnescapedAmpersands(xaml);

  const validationResult = XMLValidator.validate(xaml, { allowBooleanAttributes: true });
  if (validationResult !== true) {
    const err = validationResult.err;
    const lines = xaml.split("\n");
    const contextStart = Math.max(0, err.line - 3);
    const contextEnd = Math.min(lines.length, err.line + 2);
    const contextSnippet = lines.slice(contextStart, contextEnd)
      .map((l, i) => `  ${contextStart + i + 1}${contextStart + i + 1 === err.line ? " >>>" : "    "} ${l}`)
      .join("\n");
    console.error(`[Tree Assembler] Post-assembly XML well-formedness check FAILED for "${workflowName}": ${err.msg} at line ${err.line}, col ${err.col}\nContext:\n${contextSnippet}`);
    const fallbackXaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${escapeXml(workflowName)}"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="${escapeXml(workflowName)}">
    <ui:Comment Text="[ASSEMBLY_FAILED] Tree assembly produced malformed XML: ${escapeXml(err.msg)} at line ${err.line}, col ${err.col}. Manual implementation required." DisplayName="Assembly Failed — ${escapeXml(workflowName)}" />
  </Sequence>
</Activity>`;
    return { xaml: fallbackXaml, variables: allVariables };
  }

  return { xaml, variables: allVariables };
}

export interface ContainerValidationResult {
  repairedXaml: string;
  repairs: string[];
  errors: string[];
}

export function validateContainerChildModel(xaml: string, workflowName: string): ContainerValidationResult {
  const repairs: string[] = [];
  const errors: string[] = [];
  let patched = xaml;
  const isCriticalWorkflow = isCriticalWorkflowName(workflowName);

  patched = patched.replace(/<If\.Then>\s*<\/If\.Then>/g, () => {
    if (isCriticalWorkflow) {
      errors.push("If.Then was empty in a critical workflow — mandatory branch content is missing");
      return `<If.Then></If.Then>`;
    }
    repairs.push("If.Then was empty — injected placeholder Sequence");
    return `<If.Then><Sequence DisplayName="TODO: If.Then"><ui:Comment DisplayName="TODO" Text="If.Then was empty — implement then branch" /></Sequence></If.Then>`;
  });

  patched = patched.replace(/<If\.Else>\s*<\/If\.Else>/g, () => {
    if (isCriticalWorkflow) {
      errors.push("If.Else was empty in a critical workflow — mandatory branch content is missing");
      return `<If.Else></If.Else>`;
    }
    repairs.push("If.Else was empty — injected placeholder Sequence");
    return `<If.Else><Sequence DisplayName="TODO: If.Else"><ui:Comment DisplayName="TODO" Text="If.Else was empty — implement else branch" /></Sequence></If.Else>`;
  });

  patched = patched.replace(/<TryCatch\.Try>\s*<\/TryCatch\.Try>/g, () => {
    if (isCriticalWorkflow) {
      errors.push("TryCatch.Try was empty in a critical workflow — protected business logic is missing");
      return `<TryCatch.Try></TryCatch.Try>`;
    }
    repairs.push("TryCatch.Try was empty — injected placeholder Sequence");
    return `<TryCatch.Try><Sequence DisplayName="TODO: TryCatch.Try"><ui:Comment DisplayName="TODO" Text="TryCatch.Try was empty — implement try body" /></Sequence></TryCatch.Try>`;
  });

  const ifThenMulti = /<If\.Then>([\s\S]*?)<\/If\.Then>/g;
  let ifMatch;
  while ((ifMatch = ifThenMulti.exec(patched)) !== null) {
    const inner = ifMatch[1].trim();
    const topLevelTags = inner.match(/<(?!\/)[A-Za-z][^>]*>/g) || [];
    const directChildren = topLevelTags.filter(t => !t.startsWith("</") && !t.endsWith("/>"));
    if (directChildren.length > 1 && !inner.startsWith("<Sequence")) {
      const wrapped = `<If.Then><Sequence DisplayName="Auto-wrapped Then">${inner}</Sequence></If.Then>`;
      patched = patched.replace(ifMatch[0], wrapped);
      repairs.push("If.Then had multiple children — auto-wrapped in Sequence");
    }
  }

  const tryCatchBlocks = /<TryCatch\s[^>]*>[\s\S]*?<\/TryCatch>/g;
  let tcBlockMatch;
  while ((tcBlockMatch = tryCatchBlocks.exec(patched)) !== null) {
    const block = tcBlockMatch[0];
    if (!block.includes("<TryCatch.Catches>")) {
      const fixed = block.replace(
        /<\/TryCatch>/,
        `<TryCatch.Catches><Catch x:TypeArguments="s:Exception"><ActivityAction x:TypeArguments="s:Exception"><ActivityAction.Argument><DelegateInArgument x:TypeArguments="s:Exception" Name="exception" /></ActivityAction.Argument><Sequence DisplayName="Catch Handler"><ui:LogMessage Level="Error" DisplayName="Log Exception" Message="[exception.Message]" /></Sequence></ActivityAction></Catch></TryCatch.Catches></TryCatch>`
      );
      patched = patched.replace(block, fixed);
      repairs.push("TryCatch was missing Catches — injected default Exception catch");
    }
  }

  const forEachBlocks = /<ForEach\s[^>]*>[\s\S]*?<\/ForEach>/g;
  let feBlockMatch;
  while ((feBlockMatch = forEachBlocks.exec(patched)) !== null) {
    const block = feBlockMatch[0];
    if (!block.includes("<ActivityAction")) {
      errors.push("ForEach is missing ActivityAction child element — cannot auto-repair (irrecoverable)");
    }
  }

  const statePattern = /<State\s[^>]*DisplayName="([^"]*)"[^>]*>/g;
  let stateMatch;
  while ((stateMatch = statePattern.exec(patched)) !== null) {
    const stateName = stateMatch[1];
    const stateStart = stateMatch.index;
    const stateEnd = patched.indexOf("</State>", stateStart);
    if (stateEnd === -1) continue;
    const stateSection = patched.substring(stateStart, stateEnd + 8);
    const isFinal = /IsFinal="True"/i.test(stateMatch[0]);
    if (!isFinal && !stateSection.includes("<State.Entry>")) {
      errors.push(`State "${stateName}" is missing State.Entry element — non-final states require entry activities`);
    }
  }

  const transitionPattern = /<Transition\s[^>]*(?:\/>|>)/g;
  let transMatch;
  while ((transMatch = transitionPattern.exec(patched)) !== null) {
    const isSelfClosing = transMatch[0].endsWith("/>");
    const transStart = transMatch.index;

    if (isSelfClosing) {
      const tag = transMatch[0];
      if (!tag.includes("To=")) {
        errors.push("Transition is missing To attribute — every Transition must specify a target State");
      }
      const hasConditionAttr = /Condition="[^"]*"/.test(tag);
      if (!hasConditionAttr) {
        const displayNameMatch = tag.match(/DisplayName="([^"]*)"/);
        const dn = displayNameMatch ? displayNameMatch[1] : "Transition";
        const toMatch = tag.match(/To="([^"]*)"/);
        const toRef = toMatch ? toMatch[1] : "";
        const expanded = `<Transition DisplayName="${dn}" To="${toRef}">\n        <Transition.Condition>[True]</Transition.Condition>\n      </Transition>`;
        patched = patched.replace(tag, expanded);
        repairs.push(`Self-closing Transition "${dn}" had no Condition — expanded with [True] condition`);
      }
      continue;
    }

    const transEnd = patched.indexOf("</Transition>", transStart);
    if (transEnd === -1) continue;
    const transSection = patched.substring(transStart, transEnd + 13);
    if (!transSection.includes("To=")) {
      errors.push("Transition is missing To attribute — every Transition must specify a target State");
    }
    const hasCondition = transSection.includes("<Transition.Condition>");
    const hasAction = transSection.includes("<Transition.Action>");
    if (!hasCondition && !hasAction) {
      const displayNameMatch = transSection.match(/DisplayName="([^"]*)"/);
      const dn = displayNameMatch ? displayNameMatch[1] : "Transition";
      repairs.push(`Transition "${dn}" has neither Condition nor Action — injecting [True] condition`);
      const conditionInsert = `<Transition.Condition>[True]</Transition.Condition>\n`;
      patched = patched.replace(transMatch[0], transMatch[0] + "\n        " + conditionInsert);
    }
    if (hasCondition) {
      const condInner = transSection.match(/<Transition\.Condition>([\s\S]*?)<\/Transition\.Condition>/);
      if (condInner && !condInner[1].trim()) {
        errors.push("Transition.Condition is empty — must contain exactly one condition expression");
      }
    }
    if (hasAction) {
      const actionInner = transSection.match(/<Transition\.Action>([\s\S]*?)<\/Transition\.Action>/);
      if (actionInner && !actionInner[1].trim()) {
        repairs.push("Transition.Action was empty — injected placeholder Sequence");
        const fixed = transSection.replace(
          /<Transition\.Action>\s*<\/Transition\.Action>/,
          `<Transition.Action><Sequence DisplayName="TODO: Transition Action"><ui:Comment DisplayName="TODO" Text="Transition action was empty — implement transition logic" /></Sequence></Transition.Action>`
        );
        patched = patched.replace(transSection, fixed);
      }
    }
  }

  const tryCatchFinallyMulti = /<TryCatch\.Finally>([\s\S]*?)<\/TryCatch\.Finally>/g;
  let finMatch;
  while ((finMatch = tryCatchFinallyMulti.exec(patched)) !== null) {
    const inner = finMatch[1].trim();
    if (inner) {
      const topTags = inner.match(/<(?!\/)[A-Za-z][^/>]*(?:\/>|>)/g) || [];
      const nonSelfClosing = topTags.filter(t => !t.endsWith("/>"));
      if (nonSelfClosing.length > 1 && !inner.startsWith("<Sequence")) {
        const wrapped = `<TryCatch.Finally><Sequence DisplayName="Auto-wrapped Finally">${inner}</Sequence></TryCatch.Finally>`;
        patched = patched.replace(finMatch[0], wrapped);
        repairs.push("TryCatch.Finally had multiple children — auto-wrapped in Sequence");
      }
    }
  }

  if (patched.includes("<ui:RetryScope.Body>")) {
    errors.push("RetryScope still uses explicit .Body property element after all code paths — must use default content property");
  }

  const retryScopePattern = /<ui:RetryScope\s[^>]*>[\s\S]*?<\/ui:RetryScope>/g;
  let rsMatch;
  while ((rsMatch = retryScopePattern.exec(patched)) !== null) {
    const block = rsMatch[0];
    if (!block.includes("<ui:RetryScope.Condition>") && !block.includes("<ui:ShouldRetry")) {
      repairs.push("RetryScope is missing Condition — injecting default ShouldRetry");
      const conditionXml = `<ui:RetryScope.Condition><ui:ShouldRetry /></ui:RetryScope.Condition>`;
      const insertPoint = block.indexOf(">") + 1;
      const fixed = block.substring(0, insertPoint) + "\n    " + conditionXml + block.substring(insertPoint);
      patched = patched.replace(block, fixed);
    }
    if (!block.includes("<Sequence")) {
      if (isCriticalWorkflow) {
        errors.push("RetryScope has no Sequence body in a critical workflow — retry logic is missing");
      } else {
        repairs.push("RetryScope has no Sequence body — injecting placeholder");
        const closingTag = "</ui:RetryScope>";
        const fixed = block.replace(closingTag, `<Sequence DisplayName="TODO: RetryScope Body"><ui:Comment DisplayName="TODO" Text="RetryScope body was empty — implement retry logic" /></Sequence>\n    ${closingTag}`);
        patched = patched.replace(block, fixed);
      }
    }
  }

  if (repairs.length > 0) {
    console.log(`[Container Validation] ${workflowName}: Repaired ${repairs.length} container structure issue(s)`);
  }
  if (errors.length > 0) {
    console.error(`[Container Validation] ${workflowName}: ${errors.length} irrecoverable container error(s)`);
  }

  return { repairedXaml: patched, repairs, errors };
}

function deduplicateAssemblyAttributes(xaml: string): string {
  let dedupCount = 0;
  const result = xaml.replace(/<([a-zA-Z_][\w.:]*)((?:\s+[\w.:]+\s*=\s*"[^"]*")+)\s*(\/?>)/g, (match, tagName, attrsBlock, closing) => {
    const attrPattern = /([\w.:]+)\s*=\s*"([^"]*)"/g;
    const seen = new Map<string, string>();
    const order: string[] = [];
    let hasDup = false;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrsBlock)) !== null) {
      const name = attrMatch[1];
      const value = attrMatch[2];
      if (seen.has(name)) {
        hasDup = true;
      } else {
        order.push(name);
      }
      if (!seen.has(name)) {
        seen.set(name, value);
      }
    }
    if (!hasDup) return match;
    dedupCount++;
    const rebuiltAttrs = order.map(n => `${n}="${seen.get(n)}"`).join(" ");
    return `<${tagName} ${rebuiltAttrs} ${closing}`.replace(/\s+(\/?>) *$/, ` $1`);
  });
  if (dedupCount > 0) {
    console.log(`[Tree Assembler] Deduplicated attributes in ${dedupCount} element(s) before well-formedness check`);
  }
  return result;
}

function sanitizeUnescapedAmpersands(xaml: string): string {
  let sanitized = xaml;
  let fixCount = 0;

  sanitized = sanitized.replace(/="([^"]*)"/g, (_match, attrVal: string) => {
    const fixed = attrVal.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, "&amp;");
    if (fixed !== attrVal) fixCount++;
    return `="${fixed}"`;
  });

  sanitized = sanitized.replace(/>([^<]+)</g, (_match, textContent: string) => {
    const fixed = textContent.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, "&amp;");
    if (fixed !== textContent) fixCount++;
    return `>${fixed}<`;
  });

  if (fixCount > 0) {
    console.warn(`[XML Sanitizer] Fixed ${fixCount} unescaped ampersand(s) in assembled XAML`);
  }

  return sanitized;
}

function sanitizeObjectLiteralArguments(xaml: string): string {
  return xaml.replace(
    /(<(?:In|Out|InOut)Argument\s+x:TypeArguments="x:Object"(?:\s+[^>]*)?>)([^<]+)(<\/(?:In|Out|InOut)Argument>)/g,
    (_match, openTag, content, closeTag) => {
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
