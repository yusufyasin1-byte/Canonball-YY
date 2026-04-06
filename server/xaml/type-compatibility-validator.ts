import { catalogService } from "../catalog/catalog-service";
import type { QualityGateViolation } from "../uipath-quality-gate";

export interface TypeMismatchResult {
  violations: QualityGateViolation[];
  repairs: TypeRepairAction[];
  correctedEntries: { name: string; content: string }[];
}

export interface TypeRepairAction {
  file: string;
  line?: number;
  activity?: string;
  property?: string;
  expectedType?: string;
  actualType?: string;
  repairKind?: "conversion-wrap" | "variable-type-change" | "unrepairable";
  boundVariable?: string;
  detail?: string;
  repair?: string;
}

const CLR_SHORT_TO_FULL: Record<string, string> = {
  "x:String": "System.String",
  "x:Int32": "System.Int32",
  "x:Int64": "System.Int64",
  "x:Boolean": "System.Boolean",
  "x:Double": "System.Double",
  "x:Decimal": "System.Decimal",
  "x:Object": "System.Object",
  "s:DateTime": "System.DateTime",
  "s:TimeSpan": "System.TimeSpan",
  "scg2:DataTable": "System.Data.DataTable",
  "scg2:DataRow": "System.Data.DataRow",
  "s:Exception": "System.Exception",
  "s:SecureString": "System.Security.SecureString",
  "s:Security.SecureString": "System.Security.SecureString",
  "s:Net.Mail.MailMessage": "System.Net.Mail.MailMessage",
  "ui:QueueItem": "UiPath.Core.QueueItem",
  "ui:QueueItemData": "UiPath.Core.QueueItemData",
  "String": "System.String",
  "Int32": "System.Int32",
  "Int64": "System.Int64",
  "Boolean": "System.Boolean",
  "Double": "System.Double",
  "Decimal": "System.Decimal",
  "Object": "System.Object",
  "DateTime": "System.DateTime",
  "TimeSpan": "System.TimeSpan",
  "DataTable": "System.Data.DataTable",
  "DataRow": "System.Data.DataRow",
};

function normalizeClrType(typeStr: string): string {
  if (CLR_SHORT_TO_FULL[typeStr]) return CLR_SHORT_TO_FULL[typeStr];
  return typeStr;
}

const IMPLICIT_COMPATIBLE: [string, string][] = [
  ["System.Int32", "System.Int64"],
  ["System.Int32", "System.Double"],
  ["System.Int32", "System.Decimal"],
  ["System.Int64", "System.Double"],
  ["System.Int64", "System.Decimal"],
  ["System.Single", "System.Double"],
];

const GENERIC_CATALOG_TYPES = new Set(["System.Object", "Object"]);

function isGenericCatalogType(normalizedType: string): boolean {
  return GENERIC_CATALOG_TYPES.has(normalizedType);
}

export function areTypesCompatible(sourceType: string, targetType: string): boolean {
  const src = normalizeClrType(sourceType);
  const tgt = normalizeClrType(targetType);

  if (src === tgt) return true;

  if (tgt === "System.Object") return true;

  if (src === "System.Object") return false;

  for (const [from, to] of IMPLICIT_COMPATIBLE) {
    if (src === from && tgt === to) return true;
  }

  if (tgt.includes("IEnumerable") && (src.includes("List") || src.includes("Array") || src === "System.Data.DataTable")) {
    return true;
  }

  if (src === "UiPath.Core.QueueItem" && tgt === "UiPath.Core.QueueItemData") return true;

  return false;
}

export type ConversionKind = "wrap" | "variable-type-change" | "unrepairable";

export interface ConversionInfo {
  kind: ConversionKind;
  wrapper?: string;
  newType?: string;
  detail: string;
}

const CONVERSION_MAP: Record<string, Record<string, ConversionInfo>> = {
  "System.String": {
    "System.Int32": { kind: "wrap", wrapper: "CInt", detail: "Wrap in CInt([var]) to convert String→Int32" },
    "System.Int64": { kind: "wrap", wrapper: "CLng", detail: "Wrap in CLng([var]) to convert String→Int64" },
    "System.Double": { kind: "wrap", wrapper: "CDbl", detail: "Wrap in CDbl([var]) to convert String→Double" },
    "System.Decimal": { kind: "wrap", wrapper: "CDec", detail: "Wrap in CDec([var]) to convert String→Decimal" },
    "System.Boolean": { kind: "wrap", wrapper: "CBool", detail: "Wrap in CBool([var]) to convert String→Boolean" },
    "System.DateTime": { kind: "wrap", wrapper: "DateTime.Parse", detail: "Wrap in DateTime.Parse([var]) to convert String→DateTime" },
    "System.Data.DataTable": { kind: "unrepairable", detail: "Cannot convert String to DataTable — requires structural change (e.g., use Read Range or Build Data Table)" },
    "System.Data.DataRow": { kind: "unrepairable", detail: "Cannot convert String to DataRow — requires structural change" },
    "System.Security.SecureString": { kind: "unrepairable", detail: "Cannot convert String to SecureString inline — use GetSecureCredential or New System.Net.NetworkCredential(\"\", [var]).SecurePassword" },
  },
  "System.Int32": {
    "System.String": { kind: "wrap", wrapper: "CStr", detail: "Wrap in CStr([var]) to convert Int32→String" },
    "System.Boolean": { kind: "wrap", wrapper: "CBool", detail: "Wrap in CBool([var]) to convert Int32→Boolean" },
  },
  "System.Int64": {
    "System.String": { kind: "wrap", wrapper: "CStr", detail: "Wrap in CStr([var]) to convert Int64→String" },
    "System.Int32": { kind: "wrap", wrapper: "CInt", detail: "Wrap in CInt([var]) to convert Int64→Int32 (may overflow)" },
  },
  "System.Double": {
    "System.String": { kind: "wrap", wrapper: "CStr", detail: "Wrap in CStr([var]) to convert Double→String" },
    "System.Int32": { kind: "wrap", wrapper: "CInt", detail: "Wrap in CInt([var]) to convert Double→Int32 (truncates)" },
    "System.Decimal": { kind: "wrap", wrapper: "CDec", detail: "Wrap in CDec([var]) to convert Double→Decimal" },
  },
  "System.Decimal": {
    "System.String": { kind: "wrap", wrapper: "CStr", detail: "Wrap in CStr([var]) to convert Decimal→String" },
    "System.Int32": { kind: "wrap", wrapper: "CInt", detail: "Wrap in CInt([var]) to convert Decimal→Int32 (truncates)" },
    "System.Double": { kind: "wrap", wrapper: "CDbl", detail: "Wrap in CDbl([var]) to convert Decimal→Double" },
  },
  "System.Boolean": {
    "System.String": { kind: "wrap", wrapper: "CStr", detail: "Wrap in CStr([var]) to convert Boolean→String" },
    "System.Int32": { kind: "wrap", wrapper: "CInt", detail: "Wrap in CInt([var]) to convert Boolean→Int32" },
  },
  "System.DateTime": {
    "System.String": { kind: "wrap", wrapper: "CStr", detail: "Wrap in CStr([var]) to convert DateTime→String" },
    "System.Int32": { kind: "unrepairable", detail: "Cannot convert DateTime to Int32 directly" },
  },
  "System.Data.DataTable": {
    "System.String": { kind: "unrepairable", detail: "Cannot convert DataTable to String — use DataTable.Rows.Count.ToString or serialize via JsonConvert" },
    "System.Int32": { kind: "unrepairable", detail: "Cannot convert DataTable to Int32 — use DataTable.Rows.Count for row count" },
  },
  "System.Object": {
    "System.Collections.Generic.IEnumerable`1[System.Object]": { kind: "unrepairable", detail: "Object variable is bound to a property expecting IEnumerable — retype the variable to the correct concrete collection type (e.g., List(Of String), DataTable) based on the upstream activity output" },
    "System.Collections.IEnumerable": { kind: "unrepairable", detail: "Object variable is bound to a property expecting IEnumerable — retype the variable to the correct concrete collection type (e.g., List(Of String), DataTable) based on the upstream activity output" },
  },
};

export function getConversion(sourceType: string, targetType: string): ConversionInfo | null {
  const src = normalizeClrType(sourceType);
  const tgt = normalizeClrType(targetType);

  if (src === tgt || areTypesCompatible(src, tgt)) return null;

  const srcConversions = CONVERSION_MAP[src];
  if (srcConversions && srcConversions[tgt]) {
    return srcConversions[tgt];
  }

  if (src === "System.Object") {
    const isConcreteCollection = tgt.includes("List") || tgt.includes("Array") ||
      tgt === "System.Data.DataTable" || tgt.includes("Dictionary") ||
      tgt.includes("Collection") || tgt.includes("Queue") || tgt.includes("Stack");
    const isGenericInterface = tgt.includes("IEnumerable") || tgt.includes("ICollection") || tgt.includes("IList");

    if (isConcreteCollection && !isGenericInterface) {
      return {
        kind: "variable-type-change",
        detail: `Object variable should be retyped to ${tgt} — deterministic retype based on activity metadata`,
      };
    }
    if (isGenericInterface) {
      return {
        kind: "unrepairable",
        detail: `Object variable is bound to a property expecting ${tgt} — retype the variable to the correct concrete collection type based on the upstream activity output`,
      };
    }
  }

  return {
    kind: "unrepairable",
    detail: `No known conversion from ${src} to ${tgt} — review the variable type or activity property`,
  };
}

interface VariableInfo {
  name: string;
  type: string;
  fullClrType: string;
  line: number;
}

interface PropertyBinding {
  activityTag: string;
  propertyName: string;
  boundVariable: string;
  direction: "In" | "Out" | "InOut" | "None";
  expectedClrType: string;
  line: number;
  matchStart: number;
  matchEnd: number;
}

function extractVariableDeclarations(xamlContent: string): VariableInfo[] {
  const results: VariableInfo[] = [];
  const patterns = [
    /<Variable\s+x:TypeArguments="([^"]+)"\s+Name="([^"]+)"/g,
    /<Variable\s+Name="([^"]+)"\s+x:TypeArguments="([^"]+)"/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(xamlContent)) !== null) {
      const typeArg = pattern === patterns[0] ? match[1] : match[2];
      const name = pattern === patterns[0] ? match[2] : match[1];
      const line = xamlContent.substring(0, match.index).split("\n").length;
      const existing = results.find(r => r.name === name);
      if (!existing) {
        results.push({
          name,
          type: typeArg,
          fullClrType: normalizeClrType(typeArg),
          line,
        });
      }
    }
  }

  return results;
}

function extractPropertyBindings(
  xamlContent: string,
  fileName: string,
): PropertyBinding[] {
  const bindings: PropertyBinding[] = [];

  const activityPattern = /<((?:ui:|uweb:|uds:|upers:|uexcel:|umail:|udb:|uml:|uocr:)?[A-Z][A-Za-z]+)\s([^>]*?)(?:\/>|>)/g;
  let actMatch;
  while ((actMatch = activityPattern.exec(xamlContent)) !== null) {
    const activityTag = actMatch[1];
    const attrBlock = actMatch[2];
    const line = xamlContent.substring(0, actMatch.index).split("\n").length;

    const schema = catalogService.getActivitySchema(activityTag);
    if (!schema) continue;

    for (const prop of schema.activity.properties) {
      const attrPattern = new RegExp(`${prop.name}="\\[([^\\]]+)\\]"`, "g");
      let attrMatch;
      while ((attrMatch = attrPattern.exec(attrBlock)) !== null) {
        const varRef = attrMatch[1].trim();
        if (varRef.includes("(") || varRef.includes("+") || varRef.includes("&") || varRef.includes(".") || varRef.includes(" ")) {
          continue;
        }
        const attrBlockOffset = actMatch[0].indexOf(attrBlock);
        const absStart = actMatch.index + attrBlockOffset + attrMatch.index;
        const absEnd = absStart + attrMatch[0].length;
        bindings.push({
          activityTag,
          propertyName: prop.name,
          boundVariable: varRef,
          direction: prop.direction,
          expectedClrType: prop.clrType,
          line,
          matchStart: absStart,
          matchEnd: absEnd,
        });
      }
    }
  }

  const childPropPattern = /<([A-Za-z:]+)\.(\w+)>\s*<(In|Out|InOut)Argument[^>]*>\s*\[([^\]]+)\]\s*<\/\3Argument>\s*<\/\1\.\2>/g;
  let childMatch;
  while ((childMatch = childPropPattern.exec(xamlContent)) !== null) {
    const activityTag = childMatch[1];
    const propName = childMatch[2];
    const argDir = childMatch[3];
    const varRef = childMatch[4].trim();
    const line = xamlContent.substring(0, childMatch.index).split("\n").length;

    if (varRef.includes("(") || varRef.includes("+") || varRef.includes("&") || varRef.includes(" ")) {
      continue;
    }

    const schema = catalogService.getActivitySchema(activityTag);
    if (!schema) continue;

    const prop = schema.activity.properties.find(p => p.name === propName);
    if (!prop) continue;

    const existing = bindings.find(b =>
      b.activityTag === activityTag &&
      b.propertyName === propName &&
      b.boundVariable === varRef &&
      Math.abs(b.line - line) <= 5
    );
    if (!existing) {
      bindings.push({
        activityTag,
        propertyName: propName,
        boundVariable: varRef,
        direction: prop.direction,
        expectedClrType: prop.clrType,
        line,
        matchStart: childMatch.index,
        matchEnd: childMatch.index + childMatch[0].length,
      });
    }
  }

  return bindings;
}

function applyConversionWrapAtPosition(
  xamlContent: string,
  varName: string,
  wrapper: string,
  matchStart: number,
  matchEnd: number,
): string {
  const wrapExpr = wrapper.startsWith(".")
    ? `${varName}${wrapper}`
    : `${wrapper}(${varName})`;

  const segment = xamlContent.substring(matchStart, matchEnd);
  const wsPattern = new RegExp(`\\[\\s*${varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]`);
  const replaced = segment.replace(wsPattern, `[${wrapExpr}]`);

  return xamlContent.substring(0, matchStart) + replaced + xamlContent.substring(matchEnd);
}

function changeVariableType(
  xamlContent: string,
  varName: string,
  newTypeArg: string,
): string {
  const varEscaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const pattern1 = new RegExp(
    `(<Variable\\s+x:TypeArguments=")[^"]+("\\s+Name="${varEscaped}")`,
    "g"
  );
  xamlContent = xamlContent.replace(pattern1, `$1${newTypeArg}$2`);

  const pattern2 = new RegExp(
    `(<Variable\\s+Name="${varEscaped}"\\s+x:TypeArguments=")[^"]+(")`,
    "g"
  );
  xamlContent = xamlContent.replace(pattern2, `$1${newTypeArg}$2`);

  return xamlContent;
}

function clrTypeToXamlTypeArg(clrType: string): string {
  const reverseMap: Record<string, string> = {
    "System.String": "x:String",
    "System.Int32": "x:Int32",
    "System.Int64": "x:Int64",
    "System.Boolean": "x:Boolean",
    "System.Double": "x:Double",
    "System.Decimal": "x:Decimal",
    "System.Object": "x:Object",
    "System.DateTime": "s:DateTime",
    "System.TimeSpan": "s:TimeSpan",
    "System.Data.DataTable": "scg2:DataTable",
    "System.Data.DataRow": "scg2:DataRow",
    "System.Exception": "s:Exception",
    "System.Security.SecureString": "s:SecureString",
    "UiPath.Core.QueueItem": "ui:QueueItem",
    "UiPath.Core.QueueItemData": "ui:QueueItemData",
  };
  return reverseMap[clrType] || clrType;
}

const VBNET_RESERVED = new Set([
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

export function validateTypeCompatibility(
  xamlEntries: { name: string; content: string }[],
): TypeMismatchResult {
  const violations: QualityGateViolation[] = [];
  const repairs: TypeRepairAction[] = [];
  const correctedEntries: { name: string; content: string }[] = [];

  if (!catalogService.isLoaded()) {
    return { violations, repairs, correctedEntries };
  }

  for (const entry of xamlEntries) {
    const shortName = entry.name.split("/").pop() || entry.name;
    let patchedContent = entry.content;
    let changed = false;
    const MAX_PASSES = 3;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const variables = extractVariableDeclarations(patchedContent);
      const bindings = extractPropertyBindings(patchedContent, shortName);

      const varMap = new Map<string, VariableInfo>();
      for (const v of variables) {
        varMap.set(v.name, v);
      }

      let madeChangesThisPass = false;

      if (pass === 0) {
        const outTargetsByVar = new Map<string, Set<string>>();
        for (const binding of bindings) {
          if (binding.direction !== "Out" && binding.direction !== "InOut") continue;
          const varInfo = varMap.get(binding.boundVariable);
          if (!varInfo) continue;
          const normalizedExp = normalizeClrType(binding.expectedClrType);
          if (isGenericCatalogType(normalizedExp) &&
              varInfo.fullClrType !== "System.Object" &&
              varInfo.fullClrType !== "Object") {
            continue;
          }
          if (areTypesCompatible(normalizedExp, varInfo.fullClrType)) continue;
          if (!outTargetsByVar.has(binding.boundVariable)) {
            outTargetsByVar.set(binding.boundVariable, new Set());
          }
          outTargetsByVar.get(binding.boundVariable)!.add(normalizedExp);
        }

        for (const binding of bindings) {
          if (binding.direction !== "Out" && binding.direction !== "InOut") continue;
          const varInfo = varMap.get(binding.boundVariable);
          if (!varInfo) continue;

          const normalizedExpectedOut = normalizeClrType(binding.expectedClrType);

          if (isGenericCatalogType(normalizedExpectedOut) &&
              varInfo.fullClrType !== "System.Object" &&
              varInfo.fullClrType !== "Object") {
            console.log(`[Type Compatibility] Skipping Out type-change for "${binding.boundVariable}" (${binding.activityTag}.${binding.propertyName}) — variable has concrete type ${varInfo.fullClrType}, catalog expects generic ${normalizedExpectedOut}`);
            continue;
          }

          if (areTypesCompatible(normalizedExpectedOut, varInfo.fullClrType)) continue;

          const conflictingTargets = outTargetsByVar.get(binding.boundVariable);
          if (conflictingTargets && conflictingTargets.size > 1) {
            violations.push({
              category: "accuracy",
              severity: "error",
              check: "TYPE_MISMATCH",
              file: shortName,
              detail: `Line ${binding.line}: Variable "${binding.boundVariable}" is bound to multiple Out properties with conflicting types (${Array.from(conflictingTargets).join(", ")}). Manual resolution required.`,
            });
            repairs.push({
              file: shortName,
              line: binding.line,
              activity: binding.activityTag,
              property: binding.propertyName,
              expectedType: binding.expectedClrType,
              actualType: varInfo.fullClrType,
              repairKind: "unrepairable",
              boundVariable: binding.boundVariable,
              detail: `Conflicting Out types for variable "${binding.boundVariable}": ${Array.from(conflictingTargets).join(", ")}`,
            });
            continue;
          }

          const alreadyRepaired = repairs.some(r =>
            r.file === shortName &&
            r.boundVariable === binding.boundVariable &&
            r.repairKind === "variable-type-change"
          );
          if (alreadyRepaired) continue;

          const targetTypeArg = clrTypeToXamlTypeArg(normalizedExpectedOut);
          const oldType = varInfo.type;
          const oldClrType = varInfo.fullClrType;
          patchedContent = changeVariableType(patchedContent, binding.boundVariable, targetTypeArg);
          changed = true;
          madeChangesThisPass = true;

          repairs.push({
            file: shortName,
            line: binding.line,
            activity: binding.activityTag,
            property: binding.propertyName,
            expectedType: binding.expectedClrType,
            actualType: oldClrType,
            repairKind: "variable-type-change",
            boundVariable: binding.boundVariable,
            detail: `Changed variable "${binding.boundVariable}" type from ${oldType} to ${targetTypeArg} to match ${binding.activityTag}.${binding.propertyName} output type`,
          });

          violations.push({
            category: "accuracy",
            severity: "warning",
            check: "TYPE_MISMATCH",
            file: shortName,
            detail: `Line ${binding.line}: Auto-repaired — changed variable "${binding.boundVariable}" type from ${oldType} to ${targetTypeArg} to match ${binding.activityTag}.${binding.propertyName} (${binding.expectedClrType})`,
          });
        }
      }

      const refreshedVars = extractVariableDeclarations(patchedContent);
      const refreshedVarMap = new Map<string, VariableInfo>();
      for (const v of refreshedVars) {
        refreshedVarMap.set(v.name, v);
      }

      const refreshedBindings = pass === 0 && madeChangesThisPass
        ? extractPropertyBindings(patchedContent, shortName)
        : bindings;

      interface PendingWrap {
        binding: PropertyBinding;
        conversion: ConversionInfo;
        varInfo: VariableInfo;
      }
      const pendingWraps: PendingWrap[] = [];

      for (const binding of refreshedBindings) {
        if (binding.direction === "Out" || binding.direction === "InOut") continue;
        const varInfo = refreshedVarMap.get(binding.boundVariable);
        if (!varInfo) continue;

        if (areTypesCompatible(varInfo.fullClrType, normalizeClrType(binding.expectedClrType))) continue;

        const conversion = getConversion(varInfo.fullClrType, normalizeClrType(binding.expectedClrType));
        if (!conversion) continue;

        const alreadyRepaired = repairs.some(r =>
          r.file === shortName &&
          r.property === binding.propertyName &&
          r.boundVariable === binding.boundVariable &&
          r.activity === binding.activityTag
        );
        if (alreadyRepaired) continue;

        if (conversion.kind === "wrap" && conversion.wrapper) {
          pendingWraps.push({ binding, conversion, varInfo });
        } else if (conversion.kind === "variable-type-change") {
          const normalizedExpected = normalizeClrType(binding.expectedClrType);

          if (isGenericCatalogType(normalizedExpected) &&
              varInfo.fullClrType !== "System.Object" &&
              varInfo.fullClrType !== "Object") {
            console.log(`[Type Compatibility] Skipping In type-change for "${binding.boundVariable}" — variable has concrete type ${varInfo.fullClrType}, catalog expects generic ${normalizedExpected}`);
            continue;
          }

          const isObjectToConcreteCollection = varInfo.fullClrType === "System.Object" &&
            !normalizedExpected.includes("IEnumerable") &&
            !normalizedExpected.includes("ICollection") &&
            !normalizedExpected.includes("IList") &&
            (normalizedExpected.includes("List") || normalizedExpected.includes("Array") ||
             normalizedExpected === "System.Data.DataTable" || normalizedExpected.includes("Dictionary") ||
             normalizedExpected.includes("Collection"));

          if (varInfo.fullClrType === "System.Object" && !isObjectToConcreteCollection) {
            repairs.push({
              file: shortName,
              line: binding.line,
              activity: binding.activityTag,
              property: binding.propertyName,
              expectedType: binding.expectedClrType,
              actualType: varInfo.fullClrType,
              repairKind: "unrepairable",
              boundVariable: binding.boundVariable,
              detail: `Object variable "${binding.boundVariable}" cannot be retyped to generic interface ${binding.expectedClrType} — requires a concrete collection type`,
            });

            violations.push({
              category: "accuracy",
              severity: "error",
              check: "OBJECT_TO_IENUMERABLE",
              file: shortName,
              detail: `Line ${binding.line}: Variable "${binding.boundVariable}" (System.Object) bound to ${binding.activityTag}.${binding.propertyName} (expects ${binding.expectedClrType}). Retype the variable to a concrete collection type.`,
            });
          } else {
            const targetTypeArg = clrTypeToXamlTypeArg(normalizedExpected);
            const oldType = varInfo.type;
            const oldClrType = varInfo.fullClrType;
            patchedContent = changeVariableType(patchedContent, binding.boundVariable, targetTypeArg);
            changed = true;
            madeChangesThisPass = true;

            repairs.push({
              file: shortName,
              line: binding.line,
              activity: binding.activityTag,
              property: binding.propertyName,
              expectedType: binding.expectedClrType,
              actualType: oldClrType,
              repairKind: "variable-type-change",
              boundVariable: binding.boundVariable,
              detail: `Changed variable "${binding.boundVariable}" type from ${oldType} to ${targetTypeArg} to match ${binding.activityTag}.${binding.propertyName} input type`,
            });

            violations.push({
              category: "accuracy",
              severity: "warning",
              check: "TYPE_MISMATCH",
              file: shortName,
              detail: `Line ${binding.line}: Auto-repaired — changed variable "${binding.boundVariable}" type from ${oldType} to ${targetTypeArg} to match ${binding.activityTag}.${binding.propertyName} (${binding.expectedClrType})`,
            });
          }
        } else {
          const isObjectToCollection = varInfo.fullClrType === "System.Object" &&
            (normalizeClrType(binding.expectedClrType).includes("IEnumerable") ||
             normalizeClrType(binding.expectedClrType).includes("ICollection") ||
             normalizeClrType(binding.expectedClrType).includes("IList") ||
             normalizeClrType(binding.expectedClrType).includes("List") ||
             normalizeClrType(binding.expectedClrType).includes("Array") ||
             normalizeClrType(binding.expectedClrType).includes("Collection"));

          repairs.push({
            file: shortName,
            line: binding.line,
            activity: binding.activityTag,
            property: binding.propertyName,
            expectedType: binding.expectedClrType,
            actualType: varInfo.fullClrType,
            repairKind: "unrepairable",
            boundVariable: binding.boundVariable,
            detail: conversion.detail,
          });

          violations.push({
            category: "accuracy",
            severity: isObjectToCollection ? "error" : "warning",
            check: isObjectToCollection ? "OBJECT_TO_IENUMERABLE" : "TYPE_MISMATCH",
            file: shortName,
            detail: `Line ${binding.line}: Type mismatch — variable "${binding.boundVariable}" (${varInfo.fullClrType}) bound to ${binding.activityTag}.${binding.propertyName} (expects ${binding.expectedClrType}). ${conversion.detail}`,
          });
        }
      }

      pendingWraps.sort((a, b) => b.binding.matchStart - a.binding.matchStart);
      for (const { binding, conversion, varInfo } of pendingWraps) {
        patchedContent = applyConversionWrapAtPosition(
          patchedContent,
          binding.boundVariable,
          conversion.wrapper!,
          binding.matchStart,
          binding.matchEnd,
        );
        changed = true;
        madeChangesThisPass = true;

        repairs.push({
          file: shortName,
          line: binding.line,
          activity: binding.activityTag,
          property: binding.propertyName,
          expectedType: binding.expectedClrType,
          actualType: varInfo.fullClrType,
          repairKind: "conversion-wrap",
          boundVariable: binding.boundVariable,
          detail: conversion.detail.replace("[var]", binding.boundVariable),
        });

        violations.push({
          category: "accuracy",
          severity: "warning",
          check: "TYPE_MISMATCH",
          file: shortName,
          detail: `Line ${binding.line}: Auto-repaired — ${conversion.detail.replace("[var]", binding.boundVariable)} for ${binding.activityTag}.${binding.propertyName}`,
        });
      }

      if (!madeChangesThisPass) break;
    }

    const forEachBlockPattern = /<ForEach\s[^>]*>[\s\S]*?<\/ForEach>/g;
    let feBlockMatch;
    while ((feBlockMatch = forEachBlockPattern.exec(patchedContent)) !== null) {
      const feBlock = feBlockMatch[0];
      const feBlockStart = feBlockMatch.index;
      const feTagMatch = feBlock.match(/<ForEach\s[^>]*>/);
      if (!feTagMatch) continue;
      const feTag = feTagMatch[0];
      const typeArgMatch = feTag.match(/x:TypeArguments="([^"]+)"/);
      const valuesMatch = feTag.match(/Values="\[([^\]]*)\]"/);
      if (!typeArgMatch || !valuesMatch) continue;
      const feTypeArg = typeArgMatch[1];
      const feValues = valuesMatch[1];
      const feLine = patchedContent.substring(0, feBlockStart).split("\n").length;

      const rowsMatch = feValues.match(/^(\w+)\.Rows$/i);
      const asEnumMatch = feValues.match(/^(\w+)\.AsEnumerable\(\)$/i);
      const simpleVarMatch = feValues.match(/^(\w+)$/);
      const varRef = rowsMatch?.[1] || asEnumMatch?.[1] || simpleVarMatch?.[1];

      let correctItemType: string | null = null;

      if (rowsMatch || asEnumMatch) {
        correctItemType = "scg2:DataRow";
        if (varRef) {
          const varInfo = extractVariableDeclarations(patchedContent).find(v => v.name === varRef);
          if (varInfo && normalizeClrType(varInfo.type) !== "System.Data.DataTable") {
            const escapedVarType = varInfo.type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            patchedContent = patchedContent.replace(
              new RegExp(`(<Variable\\s+x:TypeArguments=")${escapedVarType}("\\s+Name="${varRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}")`),
              `$1scg2:DataTable$2`
            );
            patchedContent = patchedContent.replace(
              new RegExp(`(<Variable\\s+Name="${varRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s+x:TypeArguments=")${escapedVarType}(")`),
              `$1scg2:DataTable$2`
            );
            changed = true;
            violations.push({
              category: "accuracy",
              severity: "warning",
              check: "FOREACH_TYPE_MISMATCH",
              file: shortName,
              detail: `Line ${feLine}: Auto-repaired — Variable "${varRef}" type changed from "${varInfo.type}" to "scg2:DataTable" because expression "${feValues}" accesses DataTable members`,
            });
          }
        }
      } else if (!rowsMatch && !asEnumMatch) {
        if (/\bdt_\w*\.Rows\b/i.test(feValues) || /\.AsEnumerable\(\)/i.test(feValues) || /\bDataTable\b.*\.Rows\b/i.test(feValues)) {
          correctItemType = "scg2:DataRow";
        }
      }

      if (!correctItemType && simpleVarMatch && varRef) {
        const varInfo = extractVariableDeclarations(patchedContent).find(v => v.name === varRef);
        if (varInfo) {
          const fullType = normalizeClrType(varInfo.type);
          if (fullType === "System.Data.DataTable") {
            correctItemType = "scg2:DataRow";
          } else {
            const listMatch = varInfo.type.match(/List\s*\(\s*Of\s+(\w+)\s*\)/i) || varInfo.type.match(/List<([^>]+)>/i);
            if (listMatch) {
              const innerType = listMatch[1].trim();
              const mapped = CLR_SHORT_TO_FULL[innerType] || CLR_SHORT_TO_FULL[`x:${innerType}`];
              if (mapped === "System.String") correctItemType = "x:String";
              else if (mapped === "System.Int32") correctItemType = "x:Int32";
              else if (mapped === "System.Object") correctItemType = "x:Object";
              else correctItemType = innerType;
            }
            const arrayMatch = varInfo.type.match(/Array\s*\(\s*Of\s+(\w+)\s*\)/i) || varInfo.type.match(/(\w+)\[\]/);
            if (!correctItemType && arrayMatch) {
              const innerType = arrayMatch[1].trim();
              const mapped = CLR_SHORT_TO_FULL[innerType] || CLR_SHORT_TO_FULL[`x:${innerType}`];
              if (mapped === "System.String") correctItemType = "x:String";
              else if (mapped === "System.Int32") correctItemType = "x:Int32";
              else if (mapped === "System.Object") correctItemType = "x:Object";
              else correctItemType = innerType;
            }
            const dictMatch = varInfo.type.match(/Dictionary\s*\(\s*Of\s+(\w+)\s*,\s*(\w+)\s*\)/i) || varInfo.type.match(/Dictionary<([^,]+),\s*([^>]+)>/i);
            if (!correctItemType && dictMatch) {
              correctItemType = `scg:KeyValuePair(${dictMatch[1].trim()}, ${dictMatch[2].trim()})`;
            }
          }
        }
      }

      if (!correctItemType && simpleVarMatch && varRef) {
        const alreadyReported = violations.some(v =>
          v.check === "OBJECT_TO_IENUMERABLE" &&
          v.file === shortName &&
          v.detail.includes(`"${varRef}"`)
        );
        if (!alreadyReported) {
          const varInfo = extractVariableDeclarations(patchedContent).find(v => v.name === varRef);
          if (varInfo) {
            const fullType = normalizeClrType(varInfo.type);
            if (fullType === "System.Object") {
              violations.push({
                category: "accuracy",
                severity: "error",
                check: "OBJECT_TO_IENUMERABLE",
                file: shortName,
                detail: `Line ${feLine}: Variable "${varRef}" (System.Object) is bound to ForEach.Values which expects IEnumerable. Cannot determine concrete collection type — retype the variable to the correct collection type (e.g., List(Of String), DataTable) or fix the upstream activity that populates it.`,
              });
            }
          }
        }
      }

      if (!correctItemType) continue;

      const actActionTypeMatch = feBlock.match(/<ActivityAction\s+x:TypeArguments="([^"]+)"/);
      const delegateTypeMatch = feBlock.match(/<DelegateInArgument\s+x:TypeArguments="([^"]+)"/);
      const actActionType = actActionTypeMatch?.[1] || null;
      const delegateType = delegateTypeMatch?.[1] || null;

      const feNorm = normalizeClrType(feTypeArg);
      const correctNorm = normalizeClrType(correctItemType);
      const actNorm = actActionType ? normalizeClrType(actActionType) : null;
      const delNorm = delegateType ? normalizeClrType(delegateType) : null;

      const feMismatch = feNorm !== correctNorm;
      const actMismatch = actNorm !== null && actNorm !== correctNorm;
      const delMismatch = delNorm !== null && delNorm !== correctNorm;

      if (feMismatch || actMismatch || delMismatch) {
        let repairedBlock = feBlock;

        if (feMismatch) {
          repairedBlock = repairedBlock.replace(
            `<ForEach ${feTag.slice(9)}`,
            `<ForEach ${feTag.slice(9)}`.replace(
              `x:TypeArguments="${feTypeArg}"`,
              `x:TypeArguments="${correctItemType}"`
            )
          );
        }

        if (actActionType && (actMismatch || feMismatch)) {
          repairedBlock = repairedBlock.replace(
            new RegExp(`<ActivityAction\\s+x:TypeArguments="${actActionType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
            `<ActivityAction x:TypeArguments="${correctItemType}"`
          );
        }

        if (delegateType && (delMismatch || feMismatch)) {
          repairedBlock = repairedBlock.replace(
            new RegExp(`<DelegateInArgument\\s+x:TypeArguments="${delegateType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
            `<DelegateInArgument x:TypeArguments="${correctItemType}"`
          );
        }

        if (repairedBlock !== feBlock) {
          patchedContent = patchedContent.substring(0, feBlockStart) + repairedBlock + patchedContent.substring(feBlockStart + feBlock.length);
          changed = true;

          const repairedParts: string[] = [];
          if (feMismatch) repairedParts.push(`ForEach "${feTypeArg}"`);
          if (actMismatch) repairedParts.push(`ActivityAction "${actActionType}"`);
          if (delMismatch) repairedParts.push(`DelegateInArgument "${delegateType}"`);

          violations.push({
            category: "accuracy",
            severity: "warning",
            check: "FOREACH_TYPE_MISMATCH",
            file: shortName,
            detail: `Line ${feLine}: Auto-repaired — coordinated type repair to "${correctItemType}" (changed: ${repairedParts.join(", ")}) because Values expression "${feValues}" iterates over a typed collection`,
          });
        }
      }
    }

    const varNamePattern = /<Variable\s+[^>]*Name="([^"]+)"/g;
    let vnMatch;
    while ((vnMatch = varNamePattern.exec(patchedContent)) !== null) {
      const vName = vnMatch[1];
      const reasons: string[] = [];
      if (/\./.test(vName)) reasons.push("contains dot(s)");
      if (/\s/.test(vName)) reasons.push("contains whitespace");
      if (/^[0-9]/.test(vName)) reasons.push("starts with a digit");
      if (/[^a-zA-Z0-9_]/.test(vName)) reasons.push("contains invalid character(s)");
      if (VBNET_RESERVED.has(vName.toLowerCase())) reasons.push("is a VB.NET reserved word");
      if (reasons.length > 0) {
        let sanitized = vName.replace(/\./g, "_");
        sanitized = sanitized.replace(/[^a-zA-Z0-9_]/g, "_");
        sanitized = sanitized.replace(/^[0-9]+/, "");
        sanitized = sanitized.replace(/_+/g, "_");
        sanitized = sanitized.replace(/^_|_$/g, "");
        if (!sanitized) sanitized = "var1";
        if (VBNET_RESERVED.has(sanitized.toLowerCase())) sanitized = `_${sanitized}`;
        let suffix = 1;
        const baseSanitized = sanitized;
        while (sanitized !== vName && patchedContent.includes(`Name="${sanitized}"`)) {
          sanitized = `${baseSanitized}_${suffix}`;
          suffix++;
        }
        if (sanitized !== vName) {
          const escapedOriginal = vName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          patchedContent = patchedContent.replace(
            new RegExp(`Name="${escapedOriginal}"`, "g"),
            `Name="${sanitized}"`,
          );
          patchedContent = patchedContent.replace(
            new RegExp(`\\[${escapedOriginal}\\]`, "g"),
            `[${sanitized}]`,
          );
          patchedContent = patchedContent.replace(
            new RegExp(`\\b${escapedOriginal}\\b`, "g"),
            sanitized,
          );
          changed = true;
          repairs.push({
            file: shortName,
            repair: `Auto-repaired variable name "${vName}" → "${sanitized}" (${reasons.join(", ")})`,
          });
        }
        violations.push({
          category: "accuracy",
          severity: "warning",
          check: "UNSAFE_VARIABLE_NAME",
          file: shortName,
          detail: `Variable "${vName}" had an invalid name — ${reasons.join(", ")}. ${sanitized !== vName ? `Auto-repaired to "${sanitized}".` : "Could not auto-repair."}`,
        });
      }
    }

    const vbNewPattern = /="\[([^\]]*)\bnew\s+([A-Z])/g;
    let vbNewMatch;
    while ((vbNewMatch = vbNewPattern.exec(patchedContent)) !== null) {
      const fullExpr = vbNewMatch[0];
      const corrected = fullExpr.replace(/\bnew\s+([A-Z])/g, "New $1");
      if (corrected !== fullExpr) {
        patchedContent = patchedContent.replace(fullExpr, corrected);
        changed = true;
        repairs.push({
          file: shortName,
          repair: `Auto-corrected lowercase "new" to "New" in VB.NET expression`,
        });
      }
    }

    if (changed) {
      correctedEntries.push({ name: entry.name, content: patchedContent });
    }
  }

  return { violations, repairs, correctedEntries };
}
