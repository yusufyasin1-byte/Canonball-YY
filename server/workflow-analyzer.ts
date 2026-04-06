import type { GovernancePolicy } from "./uipath-integration";

export type AnalysisViolation = {
  ruleId: string;
  ruleName: string;
  category: "naming" | "best-practice" | "usage" | "security" | "maintainability" | "reliability";
  severity: "error" | "warning" | "info";
  message: string;
  location?: string;
  autoFixed: boolean;
};

export type AnalysisReport = {
  violations: AnalysisViolation[];
  rulesChecked: AnalysisRuleSummary[];
  totalChecked: number;
  totalPassed: number;
  totalAutoFixed: number;
  totalRemaining: number;
};

export type AnalysisRuleSummary = {
  ruleId: string;
  ruleName: string;
  category: string;
  status: "passed" | "auto-fixed" | "violation" | "not-applicable";
  violationCount: number;
  autoFixedCount: number;
};

export type AnalysisProfile = "fast" | "strict";

export type WorkflowAnalysisAggregate = {
  totalFiles: number;
  totalChecked: number;
  totalPassed: number;
  totalAutoFixed: number;
  totalRemaining: number;
  remainingBySeverity: {
    error: number;
    warning: number;
    info: number;
  };
  remainingViolations: Array<AnalysisViolation & { fileName?: string }>;
};

const VARIABLE_TYPE_PREFIXES: Record<string, string> = {
  "x:String": "str",
  "x:Int32": "int",
  "x:Int64": "int",
  "x:Boolean": "bool",
  "x:Double": "dbl",
  "x:Decimal": "dec",
  "x:Object": "obj",
  "s:DateTime": "dt",
  "s:TimeSpan": "ts",
  "s:Security.SecureString": "sec",
  "scg:Dictionary(x:String, x:Object)": "dict",
  "scg:Dictionary(x:String, x:String)": "dict",
  "scg2:DataTable": "dt",
  "scg2:DataRow": "drow",
  "ui:QueueItem": "qi",
  "ui:QueueItemData": "qid",
};

const ARGUMENT_DIRECTION_PREFIXES: Record<string, string> = {
  InArgument: "in",
  OutArgument: "out",
  InOutArgument: "io",
};

const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /apikey/i,
  /api_key/i,
  /token(?!ize)/i,
  /credential/i,
  /private_key/i,
  /privatekey/i,
  /passphrase/i,
];

function toPascalCase(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

export function enforceVariableName(name: string, type: string): string {
  const prefix = VARIABLE_TYPE_PREFIXES[type];
  if (!prefix) {
    const pascal = toPascalCase(name);
    return pascal || name;
  }
  const stripped = name
    .replace(/^(str|int|bool|dbl|dec|obj|dt|ts|sec|drow|qi|qid|arr|dict|list|jobj)_/i, "");
  const pascal = toPascalCase(stripped);
  return `${prefix}_${pascal || stripped}`;
}

export function enforceArgumentName(name: string, direction: string): string {
  const prefix = ARGUMENT_DIRECTION_PREFIXES[direction] || "in";
  const stripped = name.replace(/^(in|out|io)_/i, "");
  const pascal = toPascalCase(stripped);
  return `${prefix}_${pascal || stripped}`;
}

export function enforceDisplayName(
  activityType: string,
  currentDisplayName: string,
): string {
  if (!currentDisplayName || currentDisplayName.trim() === "") {
    const typePart = activityType.replace("ui:", "").replace(/([A-Z])/g, " $1").trim();
    return typePart;
  }
  return currentDisplayName;
}

export function enforceWorkflowFileName(name: string): string {
  const clean = name.replace(/\.xaml$/i, "");
  const reserved = ["Main", "GetTransactionData", "Process", "SetTransactionStatus",
    "CloseAllApplications", "KillAllProcesses", "InitAllSettings"];
  if (reserved.includes(clean)) return `${clean}.xaml`;
  if (/^(Process_|Framework_|Util_)/.test(clean)) return `${clean}.xaml`;
  return `Process_${clean}.xaml`;
}

function extractVariables(xaml: string): Array<{ name: string; type: string; line: number }> {
  const results: Array<{ name: string; type: string; line: number }> = [];
  const pattern = /<Variable\s+x:TypeArguments="([^"]+)"\s+Name="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(xaml)) !== null) {
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    results.push({ name: match[2], type: match[1], line: lineNum });
  }
  const pattern2 = /<Variable\s+Name="([^"]+)"\s+x:TypeArguments="([^"]+)"/g;
  while ((match = pattern2.exec(xaml)) !== null) {
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    results.push({ name: match[1], type: match[2], line: lineNum });
  }
  return results;
}

function extractArguments(xaml: string): Array<{ name: string; direction: string; type: string; line: number }> {
  const results: Array<{ name: string; direction: string; type: string; line: number }> = [];
  const pattern = /<(InArgument|OutArgument|InOutArgument)\s+x:TypeArguments="([^"]+)"[^>]*Name="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(xaml)) !== null) {
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    results.push({ name: match[3], direction: match[1], type: match[2], line: lineNum });
  }
  const delPattern = /<DelegateInArgument\s+x:TypeArguments="([^"]+)"\s+Name="([^"]+)"/g;
  while ((match = delPattern.exec(xaml)) !== null) {
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    results.push({ name: match[2], direction: "DelegateInArgument", type: match[1], line: lineNum });
  }
  return results;
}

function extractDisplayNames(xaml: string): Array<{ activityType: string; displayName: string; line: number }> {
  const results: Array<{ activityType: string; displayName: string; line: number }> = [];
  const pattern = /<([A-Za-z:]+)\s[^>]*DisplayName="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(xaml)) !== null) {
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    results.push({ activityType: match[1], displayName: match[2], line: lineNum });
  }
  return results;
}

function checkNaming(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];
  const variables = extractVariables(xaml);
  for (const v of variables) {
    const expected = enforceVariableName(v.name, v.type);
    if (v.name !== expected && v.name !== "exception") {
      violations.push({
        ruleId: "ST-NMG-001",
        ruleName: "Variable naming convention",
        category: "naming",
        severity: "warning",
        message: `Variable "${v.name}" should be "${expected}" (type: ${v.type})`,
        location: `line ${v.line}`,
        autoFixed: false,
      });
    }
  }

  const args = extractArguments(xaml);
  for (const a of args) {
    if (a.direction === "DelegateInArgument") continue;
    const expected = enforceArgumentName(a.name, a.direction);
    if (a.name !== expected) {
      violations.push({
        ruleId: "ST-NMG-004",
        ruleName: "Argument naming convention",
        category: "naming",
        severity: "warning",
        message: `Argument "${a.name}" should be "${expected}" (direction: ${a.direction})`,
        location: `line ${a.line}`,
        autoFixed: false,
      });
    }
  }

  const displayNames = extractDisplayNames(xaml);
  for (const dn of displayNames) {
    if (!dn.displayName || dn.displayName.trim() === "") {
      violations.push({
        ruleId: "ST-NMG-009",
        ruleName: "Activity must have DisplayName",
        category: "naming",
        severity: "warning",
        message: `Activity "${dn.activityType}" at line ${dn.line} has empty DisplayName`,
        location: `line ${dn.line}`,
        autoFixed: false,
      });
    }
  }

  return violations;
}

function checkBestPractices(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];

  const catchPattern = /<Catch\s[^>]*>[\s\S]*?<\/Catch>/g;
  let match;
  while ((match = catchPattern.exec(xaml)) !== null) {
    const catchBlock = match[0];
    const hasActivity = /<(ui:|Sequence|Assign|Rethrow|Throw|If)\s/i.test(catchBlock);
    if (!hasActivity) {
      const lineNum = xaml.substring(0, match.index).split("\n").length;
      violations.push({
        ruleId: "ST-DBP-002",
        ruleName: "Empty Catch block",
        category: "best-practice",
        severity: "error",
        message: "Catch block contains no activities — exceptions will be silently swallowed",
        location: `line ${lineNum}`,
        autoFixed: false,
      });
    }
  }

  const hasStartLog = /<ui:LogMessage[^>]*DisplayName="Log Start"/i.test(xaml) ||
    /<ui:LogMessage[^>]*Message="[^"]*Starting/i.test(xaml);
  if (!hasStartLog) {
    violations.push({
      ruleId: "ST-DBP-025",
      ruleName: "Workflow should have initial log",
      category: "best-practice",
      severity: "warning",
      message: "Workflow does not contain an initial LogMessage activity",
      autoFixed: false,
    });
  }

  const hasEndLog = /<ui:LogMessage[^>]*DisplayName="Log (Complete|End|Completion|Finish)"/i.test(xaml) ||
    /<ui:LogMessage[^>]*Message="[^"]*completed/i.test(xaml) ||
    /<ui:LogMessage[^>]*Message="[^"]*(=== .+ complete|finished|ending)/i.test(xaml);
  if (!hasEndLog) {
    violations.push({
      ruleId: "ST-DBP-025",
      ruleName: "Workflow should have final log",
      category: "best-practice",
      severity: "warning",
      message: "Workflow does not contain a final LogMessage activity",
      autoFixed: false,
    });
  }

  const hardcodedTimeouts = /<[^>]+TimeoutMS="(?!30000)[0-9]+"/g;
  while ((match = hardcodedTimeouts.exec(xaml)) !== null) {
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    const timeoutMatch = match[0].match(/TimeoutMS="([0-9]+)"/);
    const val = timeoutMatch ? timeoutMatch[1] : "unknown";
    if (val !== "30000") {
      violations.push({
        ruleId: "ST-DBP-020",
        ruleName: "Hardcoded timeout",
        category: "best-practice",
        severity: "info",
        message: `Hardcoded timeout value ${val}ms — consider using a Config variable`,
        location: `line ${lineNum}`,
        autoFixed: false,
      });
    }
  }

  const delayPattern = /<Delay\s[^>]*>/g;
  while ((match = delayPattern.exec(xaml)) !== null) {
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    violations.push({
      ruleId: "ST-DBP-006",
      ruleName: "Delay activity usage",
      category: "best-practice",
      severity: "warning",
      message: "Delay activity detected — prefer element-wait or retry patterns over fixed delays",
      location: `line ${lineNum}`,
      autoFixed: false,
    });
  }

  return violations;
}

function checkUsage(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];
  const variables = extractVariables(xaml);

  for (const v of variables) {
    const nameEscaped = v.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const usagePattern = new RegExp(`(?<!Name=")${nameEscaped}`, "g");
    const varDeclPattern = new RegExp(`<Variable[^>]*Name="${nameEscaped}"`, "g");
    const allMatches = (xaml.match(usagePattern) || []).length;
    const declMatches = (xaml.match(varDeclPattern) || []).length;
    if (allMatches <= declMatches) {
      violations.push({
        ruleId: "ST-USG-005",
        ruleName: "Unused variable",
        category: "usage",
        severity: "warning",
        message: `Variable "${v.name}" is declared but never used`,
        location: `line ${v.line}`,
        autoFixed: false,
      });
    }
  }

  let ifNestDepth = 0;
  let maxNestDepth = 0;
  const ifOpenPattern = /<If\s/g;
  const ifClosePattern = /<\/If>/g;
  let pos = 0;
  while (pos < xaml.length) {
    const nextOpen = xaml.indexOf("<If ", pos);
    const nextClose = xaml.indexOf("</If>", pos);
    if (nextOpen === -1 && nextClose === -1) break;
    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      ifNestDepth++;
      if (ifNestDepth > maxNestDepth) maxNestDepth = ifNestDepth;
      pos = nextOpen + 4;
    } else {
      ifNestDepth--;
      pos = nextClose + 5;
    }
  }
  if (maxNestDepth > 3) {
    violations.push({
      ruleId: "ST-USG-017",
      ruleName: "Deeply nested If activities",
      category: "usage",
      severity: "warning",
      message: `If nesting depth is ${maxNestDepth} (max recommended: 3) — consider refactoring into separate workflows`,
      autoFixed: false,
    });
  }

  return violations;
}

function checkMaintainability(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];

  const activityMatches = xaml.match(/<(?:ui:|sap:|Sequence\b|If\b|TryCatch\b|Switch\b|FlowDecision\b|FlowStep\b|Assign\b|Delay\b|WriteLine\b|InvokeMethod\b|InvokeWorkflowFile\b)/g) || [];
  if (activityMatches.length > 40) {
    violations.push({
      ruleId: "ST-MNT-001",
      ruleName: "Large workflow body",
      category: "maintainability",
      severity: "warning",
      message: `Workflow contains ${activityMatches.length} activities - consider decomposing into smaller workflows`,
      autoFixed: false,
    });
  }

  const commentMatches = xaml.match(/<(Annotation\.AnnotationText|sap2010:WorkflowViewState\.HintSize|TextExpression\.ReferencesForImplementation)/g) || [];
  if (activityMatches.length > 15 && commentMatches.length === 0) {
    violations.push({
      ruleId: "ST-MNT-002",
      ruleName: "Low workflow annotation coverage",
      category: "maintainability",
      severity: "info",
      message: "Workflow has substantial activity count but no annotation-style metadata was detected",
      autoFixed: false,
    });
  }

  return violations;
}

function checkReliability(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];

  const hasTryCatch = /<TryCatch\b/i.test(xaml);
  const hasRetryScope = /<ui:RetryScope\b/i.test(xaml);
  const hasGlobalCatch = /<Catch\s+/i.test(xaml);

  if (!hasTryCatch && !hasGlobalCatch) {
    violations.push({
      ruleId: "ST-REL-001",
      ruleName: "Missing exception handling block",
      category: "reliability",
      severity: "warning",
      message: "Workflow does not appear to contain TryCatch/Catch exception handling",
      autoFixed: false,
    });
  }

  const uiInteractionCount = (xaml.match(/<(ui:Click|ui:TypeInto|ui:FindElement|ui:ElementExists|ui:GetText|ui:OpenBrowser|ui:AttachBrowser|ui:UseApplicationBrowser)\b/g) || []).length;
  if (uiInteractionCount >= 3 && !hasRetryScope) {
    violations.push({
      ruleId: "ST-REL-002",
      ruleName: "UI interactions without retry pattern",
      category: "reliability",
      severity: "info",
      message: "Workflow has multiple UI interactions but no RetryScope was detected",
      autoFixed: false,
    });
  }

  return violations;
}

function collectViolations(xaml: string, profile: AnalysisProfile): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [
    ...checkNaming(xaml),
    ...checkBestPractices(xaml),
    ...checkUsage(xaml),
    ...checkSecurity(xaml),
    ...checkGovernancePolicies(xaml),
    ...checkArgumentCompleteness(xaml),
  ];

  if (profile === "strict") {
    violations.push(
      ...checkMaintainability(xaml),
      ...checkReliability(xaml),
    );
  }

  return violations;
}

function checkSecurity(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];

  const logPattern = /<ui:LogMessage[^>]*Message="([^"]+)"/g;
  let match;
  while ((match = logPattern.exec(xaml)) !== null) {
    const msgContent = match[1];
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(msgContent)) {
        const lineNum = xaml.substring(0, match.index).split("\n").length;
        violations.push({
          ruleId: "ST-SEC-004",
          ruleName: "Sensitive data in log message",
          category: "security",
          severity: "error",
          message: `LogMessage may contain sensitive data (matched: "${pattern.source}") — use SecureString or mask the value`,
          location: `line ${lineNum}`,
          autoFixed: false,
        });
        break;
      }
    }
  }

  const propPattern = /(?:Password|Secret|ApiKey|Token|Credential)="(?!{[^}]+})(?!\[)([^"]{3,})"/gi;
  while ((match = propPattern.exec(xaml)) !== null) {
    const value = match[1];
    if (value === "True" || value === "False" || value.startsWith("PLACEHOLDER_") || value.startsWith("TODO")) continue;
    const lineNum = xaml.substring(0, match.index).split("\n").length;
    violations.push({
      ruleId: "ST-SEC-005",
      ruleName: "Plaintext credential in property",
      category: "security",
      severity: "error",
      message: `Possible plaintext credential detected — use Orchestrator Asset or Windows Credential Manager`,
      location: `line ${lineNum}`,
      autoFixed: false,
    });
  }

  return violations;
}

function replaceVarInBracketExpressions(xaml: string, oldName: string, newName: string): string {
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordBoundaryPattern = new RegExp(
    `(\\[(?:[^\\[\\]]|\\[[^\\]]*\\])*)\\b${escaped}\\b((?:[^\\[\\]]|\\[[^\\]]*\\])*\\])`,
    "g"
  );
  let result = xaml;
  let prevResult = "";
  let iterations = 0;
  while (result !== prevResult && iterations < 20) {
    prevResult = result;
    result = result.replace(wordBoundaryPattern, (match, before, after) => {
      return `${before}${newName}${after}`;
    });
    iterations++;
  }
  return result;
}

function autoFixNaming(xaml: string): { fixed: string; fixes: AnalysisViolation[] } {
  const fixes: AnalysisViolation[] = [];
  let fixed = xaml;

  const variables = extractVariables(fixed);
  for (const v of variables) {
    if (v.name === "exception") continue;
    const expected = enforceVariableName(v.name, v.type);
    if (v.name !== expected) {
      const nameEscaped = v.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      fixed = fixed.replace(new RegExp(`Name="${nameEscaped}"`, "g"), `Name="${expected}"`);
      fixed = fixed.replace(new RegExp(`\\[${nameEscaped}\\]`, "g"), `[${expected}]`);
      fixed = fixed.replace(new RegExp(`'\\+\\s*${nameEscaped}`, "g"), `'+ ${expected}`);
      fixed = fixed.replace(new RegExp(`${nameEscaped}\\.ToString`, "g"), `${expected}.ToString`);
      fixed = replaceVarInBracketExpressions(fixed, v.name, expected);
      fixes.push({
        ruleId: "ST-NMG-001",
        ruleName: "Variable naming convention",
        category: "naming",
        severity: "warning",
        message: `Auto-renamed variable "${v.name}" → "${expected}"`,
        location: `line ${v.line}`,
        autoFixed: true,
      });
    }
  }

  const args = extractArguments(fixed);
  for (const a of args) {
    if (a.direction === "DelegateInArgument") continue;
    const expected = enforceArgumentName(a.name, a.direction);
    if (a.name !== expected) {
      const nameEscaped = a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      fixed = fixed.replace(new RegExp(`Name="${nameEscaped}"`, "g"), `Name="${expected}"`);
      fixed = fixed.replace(new RegExp(`\\[${nameEscaped}\\]`, "g"), `[${expected}]`);
      fixed = replaceVarInBracketExpressions(fixed, a.name, expected);
      fixes.push({
        ruleId: "ST-NMG-004",
        ruleName: "Argument naming convention",
        category: "naming",
        severity: "warning",
        message: `Auto-renamed argument "${a.name}" → "${expected}"`,
        location: `line ${a.line}`,
        autoFixed: true,
      });
    }
  }

  return { fixed, fixes };
}

function autoFixEmptyCatches(xaml: string): { fixed: string; fixes: AnalysisViolation[] } {
  const fixes: AnalysisViolation[] = [];
  let fixed = xaml;

  const catchPattern = /(<Catch\s+x:TypeArguments="[^"]*">\s*<ActivityAction\s+x:TypeArguments="[^"]*">\s*<ActivityAction\.Argument>\s*<DelegateInArgument\s+x:TypeArguments="[^"]*"\s+Name="([^"]+)"\s*\/>\s*<\/ActivityAction\.Argument>)\s*(<\/ActivityAction>)/g;
  let match;
  while ((match = catchPattern.exec(fixed)) !== null) {
    const exName = match[2];
    const lineNum = fixed.substring(0, match.index).split("\n").length;
    const replacement = `${match[1]}
                  <Sequence DisplayName="Handle Exception">
                    <ui:LogMessage Level="Error" Message="'[Error] Exception caught: ' + ${exName}.Message" DisplayName="Log Exception" />
                    <Rethrow DisplayName="Rethrow Exception" />
                  </Sequence>
                ${match[3]}`;
    fixed = fixed.replace(match[0], replacement);
    fixes.push({
      ruleId: "ST-DBP-002",
      ruleName: "Empty Catch block",
      category: "best-practice",
      severity: "error",
      message: "Auto-filled empty Catch block with Log + Rethrow",
      location: `line ${lineNum}`,
      autoFixed: true,
    });
  }

  return { fixed, fixes };
}

function autoFixMissingLogs(xaml: string): { fixed: string; fixes: AnalysisViolation[] } {
  const fixes: AnalysisViolation[] = [];
  let fixed = xaml;

  const hasStartLog = /<ui:LogMessage[^>]*DisplayName="Log Start"/i.test(fixed) ||
    /<ui:LogMessage[^>]*Message="[^"]*Starting/i.test(fixed);
  const hasEndLog = /<ui:LogMessage[^>]*DisplayName="Log (Complete|End|Completion|Finish)"/i.test(fixed) ||
    /<ui:LogMessage[^>]*Message="[^"]*completed/i.test(fixed) ||
    /<ui:LogMessage[^>]*Message="[^"]*(=== .+ complete|finished|ending)/i.test(fixed);

  const classMatch = fixed.match(/x:Class="([^"]+)"/);
  const wfName = classMatch ? classMatch[1] : "Workflow";

  if (!hasStartLog) {
    const seqStart = fixed.match(/(<Sequence\s+DisplayName="[^"]*">)/);
    if (seqStart) {
      fixed = fixed.replace(
        seqStart[0],
        `${seqStart[0]}\n        <ui:LogMessage Level="Info" Message="[&quot;=== Starting: ${wfName} ===&quot;]" DisplayName="Log Start" />`
      );
      fixes.push({
        ruleId: "ST-DBP-025",
        ruleName: "Missing initial log",
        category: "best-practice",
        severity: "warning",
        message: `Auto-added initial LogMessage to workflow "${wfName}"`,
        autoFixed: true,
      });
    }
  }

  if (!hasEndLog) {
    const lastSeqClose = fixed.lastIndexOf("</Sequence>");
    if (lastSeqClose > 0) {
      const endLog = `\n        <ui:LogMessage Level="Info" Message="[&quot;=== Completed: ${wfName} ===&quot;]" DisplayName="Log Completion" />`;
      fixed = fixed.substring(0, lastSeqClose) + endLog + "\n      " + fixed.substring(lastSeqClose);
      fixes.push({
        ruleId: "ST-DBP-025",
        ruleName: "Missing final log",
        category: "best-practice",
        severity: "warning",
        message: `Auto-added final LogMessage to workflow "${wfName}"`,
        autoFixed: true,
      });
    }
  }

  return { fixed, fixes };
}

function checkArgumentCompleteness(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];

  const bareArgPatterns2 = [
    /<Argument\s+x:TypeArguments="([^"]+)"\s+x:Name="([^"]+)"\s*\/>/g,
    /<Argument\s+x:Name="([^"]+)"\s+x:TypeArguments="([^"]+)"\s*\/>/g,
  ];
  let match;
  for (const bareArgPattern of bareArgPatterns2) {
    while ((match = bareArgPattern.exec(xaml)) !== null) {
      const argName = bareArgPattern === bareArgPatterns2[1] ? match[1] : match[2];
      const lineNum = xaml.substring(0, match.index).split("\n").length;
      violations.push({
        ruleId: "ST-ARG-001",
        ruleName: "Invalid bare Argument tag in Catch",
        category: "usage",
        severity: "error",
        message: `Bare <Argument> tag "${argName}" should be <ActivityAction.Argument><DelegateInArgument /></ActivityAction.Argument>`,
        location: `line ${lineNum}`,
        autoFixed: false,
      });
    }
  }

  const invokeBlockPattern = /<ui:InvokeWorkflowFile[^>]*WorkflowFileName="([^"]+)"[^>]*>[\s\S]*?<ui:InvokeWorkflowFile\.Arguments>([\s\S]*?)<\/ui:InvokeWorkflowFile\.Arguments>/g;
  let invokeMatch;
  while ((invokeMatch = invokeBlockPattern.exec(xaml)) !== null) {
    const fileName = invokeMatch[1];
    const argsContent = invokeMatch[2];
    const argKeyPattern = /x:Key="([^"]+)"/g;
    let keyMatch;
    const invokedArgs: string[] = [];
    while ((keyMatch = argKeyPattern.exec(argsContent)) !== null) {
      invokedArgs.push(keyMatch[1]);
    }
    for (const argName of invokedArgs) {
      const varDeclared = new RegExp(`<Variable[^>]*Name="${argName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "").test(xaml);
      const propDeclared = new RegExp(`<x:Property\\s+Name="${argName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "").test(xaml);
      if (!varDeclared && !propDeclared) {
        const lineNum = xaml.substring(0, invokeMatch.index).split("\n").length;
        violations.push({
          ruleId: "ST-ARG-002",
          ruleName: "Missing declaration for invoked argument",
          category: "usage",
          severity: "warning",
          message: `Argument "${argName}" is passed to "${fileName}" but is not declared as a Variable or x:Property in the calling workflow`,
          location: `line ${lineNum}`,
          autoFixed: false,
        });
      }
    }
  }

  const exprPattern = /\[([^\]]+)\]/g;
  const declaredVars = new Set<string>();
  const varPattern = /<Variable[^>]*Name="([^"]+)"/g;
  while ((match = varPattern.exec(xaml)) !== null) {
    declaredVars.add(match[1]);
  }
  const propPattern = /<x:Property\s+Name="([^"]+)"/g;
  while ((match = propPattern.exec(xaml)) !== null) {
    declaredVars.add(match[1]);
  }
  const delegatePattern = /<DelegateInArgument[^>]*Name="([^"]+)"/g;
  while ((match = delegatePattern.exec(xaml)) !== null) {
    declaredVars.add(match[1]);
  }
  const keywords = new Set(["True", "False", "Nothing", "null", "New", "Not", "And", "Or", "If", "String", "Integer", "Boolean", "DateTime", "Math", "Convert", "CType", "CStr", "CInt", "CDbl"]);
  const identPattern = /\b([a-zA-Z_]\w*)\b/g;
  while ((match = exprPattern.exec(xaml)) !== null) {
    const expr = match[1];
    if (expr.startsWith("&quot;") || expr.startsWith("\"")) continue;
    let idMatch;
    while ((idMatch = identPattern.exec(expr)) !== null) {
      const ident = idMatch[1];
      if (keywords.has(ident)) continue;
      if (/^[A-Z][a-z]/.test(ident) && expr.includes(`${ident}.`) && !declaredVars.has(ident)) continue;
      if (ident.startsWith("str_") || ident.startsWith("int_") || ident.startsWith("bool_") || ident.startsWith("dt_") || ident.startsWith("qi_") || ident.startsWith("obj_") || ident.startsWith("dbl_") || ident.startsWith("sec_") || ident.startsWith("io_") || ident.startsWith("in_") || ident.startsWith("out_")) {
        if (!declaredVars.has(ident)) {
          const lineNum = xaml.substring(0, match.index).split("\n").length;
          violations.push({
            ruleId: "ST-ARG-003",
            ruleName: "Undeclared variable in expression",
            category: "usage",
            severity: "warning",
            message: `Variable "${ident}" is used in an expression but not declared as a Variable or x:Property`,
            location: `line ${lineNum}`,
            autoFixed: false,
          });
        }
      }
    }
  }

  return violations;
}

function autoFixBareArguments(xaml: string): { fixed: string; fixes: AnalysisViolation[] } {
  const fixes: AnalysisViolation[] = [];
  let fixed = xaml;

  const bareArgPatterns = [
    /<Argument\s+x:TypeArguments="([^"]+)"\s+x:Name="([^"]+)"\s*\/>/g,
    /<Argument\s+x:Name="([^"]+)"\s+x:TypeArguments="([^"]+)"\s*\/>/g,
  ];

  for (const pattern of bareArgPatterns) {
    let match;
    while ((match = pattern.exec(fixed)) !== null) {
      const isReversed = pattern === bareArgPatterns[1];
      const typeArg = isReversed ? match[2] : match[1];
      const argName = isReversed ? match[1] : match[2];
      const lineNum = fixed.substring(0, match.index).split("\n").length;
      const replacement = `<ActivityAction.Argument>\n                  <DelegateInArgument x:TypeArguments="${typeArg}" Name="${argName}" />\n                </ActivityAction.Argument>`;
      fixed = fixed.replace(match[0], replacement);
      fixes.push({
        ruleId: "ST-ARG-001",
        ruleName: "Invalid bare Argument tag in Catch",
        category: "usage",
        severity: "error",
        message: `Auto-fixed bare <Argument> tag "${argName}" → <DelegateInArgument>`,
        location: `line ${lineNum}`,
        autoFixed: true,
      });
      pattern.lastIndex = 0;
    }
  }

  return { fixed, fixes };
}

const ALL_RULES: Array<{ ruleId: string; ruleName: string; category: string }> = [
  { ruleId: "ST-NMG-001", ruleName: "Variable naming convention", category: "naming" },
  { ruleId: "ST-NMG-004", ruleName: "Argument naming convention", category: "naming" },
  { ruleId: "ST-NMG-009", ruleName: "Activity must have DisplayName", category: "naming" },
  { ruleId: "ST-DBP-002", ruleName: "Empty Catch block", category: "best-practice" },
  { ruleId: "ST-DBP-006", ruleName: "Delay activity usage", category: "best-practice" },
  { ruleId: "ST-DBP-020", ruleName: "Hardcoded timeout", category: "best-practice" },
  { ruleId: "ST-DBP-025", ruleName: "Workflow start/end logging", category: "best-practice" },
  { ruleId: "ST-USG-005", ruleName: "Unused variable", category: "usage" },
  { ruleId: "ST-USG-017", ruleName: "Deeply nested If activities", category: "usage" },
  { ruleId: "ST-SEC-004", ruleName: "Sensitive data in log message", category: "security" },
  { ruleId: "ST-SEC-005", ruleName: "Plaintext credential in property", category: "security" },
  { ruleId: "ST-ARG-001", ruleName: "Invalid bare Argument tag in Catch", category: "usage" },
  { ruleId: "ST-ARG-002", ruleName: "Missing declaration for invoked argument", category: "usage" },
  { ruleId: "ST-ARG-003", ruleName: "Undeclared variable in expression", category: "usage" },
  { ruleId: "ST-MNT-001", ruleName: "Large workflow body", category: "maintainability" },
  { ruleId: "ST-MNT-002", ruleName: "Low workflow annotation coverage", category: "maintainability" },
  { ruleId: "ST-REL-001", ruleName: "Missing exception handling block", category: "reliability" },
  { ruleId: "ST-REL-002", ruleName: "UI interactions without retry pattern", category: "reliability" },
];

let _governancePolicies: GovernancePolicy[] = [];

export function setGovernancePolicies(policies: GovernancePolicy[]): void {
  _governancePolicies = policies;
}

export function getGovernancePolicies(): GovernancePolicy[] {
  return _governancePolicies;
}

function checkGovernancePolicies(xaml: string): AnalysisViolation[] {
  const violations: AnalysisViolation[] = [];

  for (const policy of _governancePolicies) {
    if (policy.type === "activity-restriction" && policy.restrictedActivities?.length) {
      for (const activity of policy.restrictedActivities) {
        const escaped = activity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`<${escaped}[\\s/>]`, "gi");
        let match;
        while ((match = pattern.exec(xaml)) !== null) {
          const lineNum = xaml.substring(0, match.index).split("\n").length;
          violations.push({
            ruleId: `GOV-${policy.id}`,
            ruleName: `Governance: ${policy.name}`,
            category: "best-practice",
            severity: policy.severity,
            message: `Activity "${activity}" is restricted by governance policy "${policy.name}"${policy.description ? `: ${policy.description}` : ""}`,
            location: `line ${lineNum}`,
            autoFixed: false,
          });
        }
      }
    }

    if (policy.type === "naming" && policy.pattern) {
      try {
        const regex = new RegExp(policy.pattern);
        const variables = extractVariables(xaml);
        for (const v of variables) {
          if (!regex.test(v.name)) {
            violations.push({
              ruleId: `GOV-${policy.id}`,
              ruleName: `Governance: ${policy.name}`,
              category: "naming",
              severity: policy.severity,
              message: `Variable "${v.name}" does not match governance naming pattern "${policy.pattern}" (policy: ${policy.name})`,
              location: `line ${v.line}`,
              autoFixed: false,
            });
          }
        }
      } catch {}
    }

    if (policy.type === "error-handling" && policy.requiredPatterns?.length) {
      for (const requiredPattern of policy.requiredPatterns) {
        try {
          const regex = new RegExp(requiredPattern, "i");
          if (!regex.test(xaml)) {
            violations.push({
              ruleId: `GOV-${policy.id}`,
              ruleName: `Governance: ${policy.name}`,
              category: "best-practice",
              severity: policy.severity,
              message: `Required pattern "${requiredPattern}" not found (governance policy: ${policy.name})`,
              autoFixed: false,
            });
          }
        } catch {}
      }
    }

    if (policy.type === "security") {
      if (policy.pattern) {
        try {
          const regex = new RegExp(policy.pattern, "gi");
          let match;
          while ((match = regex.exec(xaml)) !== null) {
            const lineNum = xaml.substring(0, match.index).split("\n").length;
            violations.push({
              ruleId: `GOV-${policy.id}`,
              ruleName: `Governance: ${policy.name}`,
              category: "security",
              severity: policy.severity,
              message: `Security governance violation: ${policy.description || policy.name}`,
              location: `line ${lineNum}`,
              autoFixed: false,
            });
          }
        } catch {}
      }
    }
  }

  return violations;
}

function buildRuleSummaries(violations: AnalysisViolation[]): AnalysisRuleSummary[] {
  const summaries = ALL_RULES.map((rule) => {
    const ruleViolations = violations.filter((v) => v.ruleId === rule.ruleId);
    const autoFixed = ruleViolations.filter((v) => v.autoFixed).length;
    const remaining = ruleViolations.filter((v) => !v.autoFixed).length;
    let status: AnalysisRuleSummary["status"];
    if (ruleViolations.length === 0) status = "passed";
    else if (remaining === 0 && autoFixed > 0) status = "auto-fixed";
    else status = "violation";
    return {
      ruleId: rule.ruleId,
      ruleName: rule.ruleName,
      category: rule.category,
      status,
      violationCount: remaining,
      autoFixedCount: autoFixed,
    };
  });

  const govRuleIds = new Set<string>();
  for (const v of violations) {
    if (v.ruleId.startsWith("GOV-") && !govRuleIds.has(v.ruleId)) {
      govRuleIds.add(v.ruleId);
      const ruleViolations = violations.filter((vv) => vv.ruleId === v.ruleId);
      const autoFixed = ruleViolations.filter((vv) => vv.autoFixed).length;
      const remaining = ruleViolations.filter((vv) => !vv.autoFixed).length;
      summaries.push({
        ruleId: v.ruleId,
        ruleName: v.ruleName,
        category: v.category,
        status: remaining > 0 ? "violation" : autoFixed > 0 ? "auto-fixed" : "passed",
        violationCount: remaining,
        autoFixedCount: autoFixed,
      });
    }
  }

  if (_governancePolicies.length > 0) {
    for (const policy of _governancePolicies) {
      const govId = `GOV-${policy.id}`;
      if (!govRuleIds.has(govId)) {
        summaries.push({
          ruleId: govId,
          ruleName: `Governance: ${policy.name}`,
          category: policy.type === "naming" ? "naming" : policy.type === "security" ? "security" : "best-practice",
          status: "passed",
          violationCount: 0,
          autoFixedCount: 0,
        });
      }
    }
  }

  return summaries;
}

export function analyzeXaml(xamlContent: string, profile: AnalysisProfile = "fast"): AnalysisReport {
  const violations = collectViolations(xamlContent, profile);

  const ruleSummaries = buildRuleSummaries(violations);

  return {
    violations,
    rulesChecked: ruleSummaries,
    totalChecked: ruleSummaries.length,
    totalPassed: ruleSummaries.filter((r) => r.status === "passed").length,
    totalAutoFixed: 0,
    totalRemaining: violations.length,
  };
}

function deduplicateVariableDeclarations(xaml: string): string {
  const varsBlockPattern = /(<(?:Sequence|StateMachine)\.Variables>)([\s\S]*?)(<\/(?:Sequence|StateMachine)\.Variables>)/g;
  return xaml.replace(varsBlockPattern, (match, openTag, content, closeTag) => {
    const varPattern = /<Variable\s+[^>]*\bName="([^"]+)"[^>]*\/>/g;
    const seen = new Set<string>();
    const deduped = content.replace(varPattern, (varMatch: string, name: string) => {
      if (seen.has(name)) {
        return "";
      }
      seen.add(name);
      return varMatch;
    });
    return `${openTag}${deduped}${closeTag}`;
  });
}

export function analyzeAndFix(xamlContent: string, profile: AnalysisProfile = "fast"): { fixed: string; report: AnalysisReport } {
  const allViolations: AnalysisViolation[] = [];

  const bareArgResult = autoFixBareArguments(xamlContent);
  let fixed = bareArgResult.fixed;
  allViolations.push(...bareArgResult.fixes);

  const namingResult = autoFixNaming(fixed);
  fixed = namingResult.fixed;
  allViolations.push(...namingResult.fixes);

  fixed = deduplicateVariableDeclarations(fixed);

  const catchResult = autoFixEmptyCatches(fixed);
  fixed = catchResult.fixed;
  allViolations.push(...catchResult.fixes);

  const logResult = autoFixMissingLogs(fixed);
  fixed = logResult.fixed;
  allViolations.push(...logResult.fixes);

  const postFixViolations = collectViolations(fixed, profile);
  allViolations.push(...postFixViolations);

  const ruleSummaries = buildRuleSummaries(allViolations);
  const autoFixedCount = allViolations.filter((v) => v.autoFixed).length;
  const remainingCount = allViolations.filter((v) => !v.autoFixed).length;

  return {
    fixed,
    report: {
      violations: allViolations,
      rulesChecked: ruleSummaries,
      totalChecked: ruleSummaries.length,
      totalPassed: ruleSummaries.filter((r) => r.status === "passed").length,
      totalAutoFixed: autoFixedCount,
      totalRemaining: remainingCount,
    },
  };
}

export function formatAnalysisReportMarkdown(report: AnalysisReport): string {
  let md = "";

  md += `### Workflow Analyzer Compliance\n\n`;
  md += `| Rule ID | Rule Name | Category | Status | Auto-Fixed | Remaining |\n`;
  md += `|---------|-----------|----------|--------|------------|----------|\n`;

  for (const rule of report.rulesChecked) {
    const statusIcon = rule.status === "passed" ? "Passed" :
      rule.status === "auto-fixed" ? "Auto-Fixed" : "Needs Review";
    md += `| ${rule.ruleId} | ${rule.ruleName} | ${rule.category} | ${statusIcon} | ${rule.autoFixedCount} | ${rule.violationCount} |\n`;
  }

  md += `\n**Summary:** ${report.totalChecked} rules checked, ${report.totalPassed} passed, ${report.totalAutoFixed} auto-fixed, ${report.totalRemaining} remaining\n\n`;

  const remaining = report.violations.filter((v) => !v.autoFixed);
  if (remaining.length > 0) {
    md += `### Remaining Violations (Require Manual Review)\n\n`;
    md += `| Severity | Rule | Message | Location |\n`;
    md += `|----------|------|---------|----------|\n`;
    for (const v of remaining) {
      md += `| ${v.severity} | ${v.ruleId} | ${v.message} | ${v.location || "—"} |\n`;
    }
    md += `\n`;
  }

  const autoFixed = report.violations.filter((v) => v.autoFixed);
  if (autoFixed.length > 0) {
    md += `### Auto-Corrected Items\n\n`;
    for (const v of autoFixed) {
      md += `- **${v.ruleId}**: ${v.message}\n`;
    }
    md += `\n`;
  }

  return md;
}

export function aggregateAnalysisReports(
  reports: Array<{ fileName: string; report: AnalysisReport }>,
): WorkflowAnalysisAggregate {
  const remainingViolations = reports.flatMap(({ fileName, report }) =>
    report.violations
      .filter((violation) => !violation.autoFixed)
      .map((violation) => ({ ...violation, fileName })),
  );

  return {
    totalFiles: reports.length,
    totalChecked: reports.reduce((sum, entry) => sum + entry.report.totalChecked, 0),
    totalPassed: reports.reduce((sum, entry) => sum + entry.report.totalPassed, 0),
    totalAutoFixed: reports.reduce((sum, entry) => sum + entry.report.totalAutoFixed, 0),
    totalRemaining: reports.reduce((sum, entry) => sum + entry.report.totalRemaining, 0),
    remainingBySeverity: {
      error: remainingViolations.filter((v) => v.severity === "error").length,
      warning: remainingViolations.filter((v) => v.severity === "warning").length,
      info: remainingViolations.filter((v) => v.severity === "info").length,
    },
    remainingViolations,
  };
}

export function shouldBlockDeploymentFromAnalysis(
  reports: Array<{ fileName: string; report: AnalysisReport }>,
): boolean {
  const aggregate = aggregateAnalysisReports(reports);
  return aggregate.remainingBySeverity.error > 0;
}

export function formatDeploymentGateMarkdown(
  reports: Array<{ fileName: string; report: AnalysisReport }>,
): string {
  const aggregate = aggregateAnalysisReports(reports);
  let md = `### Workflow Analyzer Deployment Gate\n\n`;
  md += `Analyzed ${aggregate.totalFiles} workflow file(s). `;
  md += `Remaining violations: ${aggregate.totalRemaining} `;
  md += `(errors: ${aggregate.remainingBySeverity.error}, warnings: ${aggregate.remainingBySeverity.warning}, info: ${aggregate.remainingBySeverity.info}).\n\n`;

  if (aggregate.remainingViolations.length === 0) {
    md += `All remaining Workflow Analyzer issues were auto-corrected or cleared. Deployment is allowed.\n`;
    return md;
  }

  md += `| Severity | Rule ID | File | Message | Location |\n`;
  md += `|---|---|---|---|---|\n`;
  for (const violation of aggregate.remainingViolations) {
    md += `| ${violation.severity} | ${violation.ruleId} | ${violation.fileName || "—"} | ${violation.message} | ${violation.location || "—"} |\n`;
  }

  md += `\n`;
  if (aggregate.remainingBySeverity.error > 0) {
    md += `Deployment should be blocked because unresolved error-level Workflow Analyzer violations remain.\n`;
  } else {
    md += `Deployment may proceed because only warning/info-level Workflow Analyzer violations remain.\n`;
  }

  return md;
}

export function generateAnnotationText(opts: {
  stepNumber?: number;
  stepName?: string;
  businessContext?: string;
  errorStrategy?: string;
  placeholders?: string[];
  aiReasoning?: string;
}): string {
  const parts: string[] = [];
  if (opts.stepNumber !== undefined && opts.stepName) {
    parts.push(`[Step ${opts.stepNumber}] ${opts.stepName}`);
  }
  if (opts.businessContext) {
    parts.push(`Business Context: ${opts.businessContext}`);
  }
  if (opts.errorStrategy) {
    parts.push(`Error Handling: ${opts.errorStrategy}`);
  }
  if (opts.placeholders?.length) {
    parts.push(`Action Required: Replace ${opts.placeholders.join(", ")}`);
  }
  if (opts.aiReasoning) {
    parts.push(`AI Reasoning: ${opts.aiReasoning}`);
  }
  return parts.join("\n");
}

export function generateArgumentValidationXaml(
  args: Array<{ name: string; direction: string; type: string; required?: boolean }>,
  workflowName: string,
): string {
  const inArgs = args.filter((a) => a.direction === "InArgument" || a.direction === "InOutArgument");
  if (inArgs.length === 0) return "";

  let xml = `
        <Sequence DisplayName="Validate Arguments"
          sap2010:Annotation.AnnotationText="Auto-generated argument validation — ensures all required inputs are provided before execution begins">`;

  xml += `
          <ui:LogMessage Level="Trace" Message="'[${workflowName}] Validating ${inArgs.length} input argument(s)...'" DisplayName="Log Argument Validation Start" />`;

  for (const arg of inArgs) {
    const typeLower = arg.type.toLowerCase();
    const isSensitive = SENSITIVE_PATTERNS.some((p) => p.test(arg.name));

    if (typeLower.includes("string") || typeLower === "x:string") {
      xml += `
          <If DisplayName="Validate ${arg.name}" Condition="[String.IsNullOrWhiteSpace(${arg.name})]">
            <If.Then>
              <Throw DisplayName="Throw: ${arg.name} required" Exception="[New BusinessRuleException(&quot;Required argument '${arg.name}' is null or empty&quot;)]" />
            </If.Then>
            <If.Else>
              <ui:LogMessage Level="Trace" Message="'[${workflowName}] ${arg.name} = ${isSensitive ? "****" : `' + ${arg.name}`}'" DisplayName="Log ${arg.name}" />
            </If.Else>
          </If>`;
    } else if (typeLower.includes("datatable") || typeLower === "scg2:datatable") {
      xml += `
          <If DisplayName="Validate ${arg.name}" Condition="[${arg.name} Is Nothing]">
            <If.Then>
              <Throw DisplayName="Throw: ${arg.name} required" Exception="[New BusinessRuleException(&quot;Required argument '${arg.name}' is Nothing (DataTable expected)&quot;)]" />
            </If.Then>
            <If.Else>
              <ui:LogMessage Level="Trace" Message="'[${workflowName}] ${arg.name} has ' + ${arg.name}.Rows.Count.ToString() + ' rows'" DisplayName="Log ${arg.name}" />
            </If.Else>
          </If>`;
    } else if (typeLower.includes("object") || typeLower === "x:object") {
      xml += `
          <If DisplayName="Validate ${arg.name}" Condition="[${arg.name} Is Nothing]">
            <If.Then>
              <Throw DisplayName="Throw: ${arg.name} required" Exception="[New BusinessRuleException(&quot;Required argument '${arg.name}' is Nothing&quot;)]" />
            </If.Then>
            <If.Else>
              <ui:LogMessage Level="Trace" Message="'[${workflowName}] ${arg.name} provided'" DisplayName="Log ${arg.name}" />
            </If.Else>
          </If>`;
    } else {
      xml += `
          <ui:LogMessage Level="Trace" Message="'[${workflowName}] ${arg.name} = ${isSensitive ? "****" : `' + ${arg.name}.ToString()`}'" DisplayName="Log ${arg.name}" />`;
    }
  }

  xml += `
          <ui:LogMessage Level="Trace" Message="'[${workflowName}] All arguments validated successfully'" DisplayName="Log Validation Complete" />
        </Sequence>`;

  return xml;
}
