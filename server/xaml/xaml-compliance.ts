import { escapeXml } from "../lib/xml-utils";
import { ACTIVITY_NAME_ALIAS_MAP } from "../uipath-activity-registry";
import { catalogService } from "../catalog/catalog-service";
import { XMLValidator } from "fast-xml-parser";
import { QualityGateError } from "../uipath-shared";

export type TargetFramework = "Windows" | "Portable";

export const XAML_INFRASTRUCTURE_TYPE_ARGUMENTS = new Set([
  "AssemblyReference",
]);


export interface PackageNamespaceInfo {
  prefix: string;
  xmlns: string;
  assembly: string;
  clrNamespace: string;
}

export const PACKAGE_NAMESPACE_MAP: Record<string, PackageNamespaceInfo> = {
  "UiPath.UIAutomation.Activities": { prefix: "ui", xmlns: "http://schemas.uipath.com/workflow/activities", clrNamespace: "UiPath.Core.Activities", assembly: "UiPath.UIAutomation.Activities" },
  "UiPath.System.Activities": { prefix: "ui", xmlns: "http://schemas.uipath.com/workflow/activities", clrNamespace: "UiPath.Core.Activities", assembly: "UiPath.System.Activities" },
  "UiPath.Web.Activities": { prefix: "uweb", xmlns: "clr-namespace:UiPath.Web.Activities;assembly=UiPath.Web.Activities", clrNamespace: "UiPath.Web.Activities", assembly: "UiPath.Web.Activities" },
  "UiPath.DataService.Activities": { prefix: "uds", xmlns: "clr-namespace:UiPath.DataService.Activities;assembly=UiPath.DataService.Activities", clrNamespace: "UiPath.DataService.Activities", assembly: "UiPath.DataService.Activities" },
  "UiPath.Persistence.Activities": { prefix: "upers", xmlns: "clr-namespace:UiPath.Persistence.Activities;assembly=UiPath.Persistence.Activities", clrNamespace: "UiPath.Persistence.Activities", assembly: "UiPath.Persistence.Activities" },
  "UiPath.Excel.Activities": { prefix: "uexcel", xmlns: "clr-namespace:UiPath.Excel.Activities;assembly=UiPath.Excel.Activities", clrNamespace: "UiPath.Excel.Activities", assembly: "UiPath.Excel.Activities" },
  "UiPath.Mail.Activities": { prefix: "umail", xmlns: "clr-namespace:UiPath.Mail.Activities;assembly=UiPath.Mail.Activities", clrNamespace: "UiPath.Mail.Activities", assembly: "UiPath.Mail.Activities" },
  "UiPath.Database.Activities": { prefix: "udb", xmlns: "clr-namespace:UiPath.Database.Activities;assembly=UiPath.Database.Activities", clrNamespace: "UiPath.Database.Activities", assembly: "UiPath.Database.Activities" },
  "UiPath.MLActivities": { prefix: "uml", xmlns: "clr-namespace:UiPath.MLActivities;assembly=UiPath.MLActivities", clrNamespace: "UiPath.MLActivities", assembly: "UiPath.MLActivities" },
  "UiPath.IntelligentOCR.Activities": { prefix: "uocr", xmlns: "clr-namespace:UiPath.IntelligentOCR.Activities;assembly=UiPath.IntelligentOCR.Activities", clrNamespace: "UiPath.IntelligentOCR.Activities", assembly: "UiPath.IntelligentOCR.Activities" },
  "System.Activities": { prefix: "", xmlns: "http://schemas.microsoft.com/netfx/2009/xaml/activities", clrNamespace: "System.Activities", assembly: "System.Activities" },
  "UiPath.PDF.Activities": { prefix: "updf", xmlns: "clr-namespace:UiPath.PDF.Activities;assembly=UiPath.PDF.Activities", clrNamespace: "UiPath.PDF.Activities", assembly: "UiPath.PDF.Activities" },
  "UiPath.Word.Activities": { prefix: "uword", xmlns: "clr-namespace:UiPath.Word.Activities;assembly=UiPath.Word.Activities", clrNamespace: "UiPath.Word.Activities", assembly: "UiPath.Word.Activities" },
  "UiPath.GSuite.Activities": { prefix: "ugs", xmlns: "clr-namespace:UiPath.GSuite.Activities;assembly=UiPath.GSuite.Activities", clrNamespace: "UiPath.GSuite.Activities", assembly: "UiPath.GSuite.Activities" },
  "UiPath.MicrosoftOffice365.Activities": { prefix: "uo365", xmlns: "clr-namespace:UiPath.MicrosoftOffice365.Activities;assembly=UiPath.MicrosoftOffice365.Activities", clrNamespace: "UiPath.MicrosoftOffice365.Activities", assembly: "UiPath.MicrosoftOffice365.Activities" },
  "UiPath.Testing.Activities": { prefix: "utest", xmlns: "clr-namespace:UiPath.Testing.Activities;assembly=UiPath.Testing.Activities", clrNamespace: "UiPath.Testing.Activities", assembly: "UiPath.Testing.Activities" },
  "UiPath.Form.Activities": { prefix: "uform", xmlns: "clr-namespace:UiPath.Form.Activities;assembly=UiPath.Form.Activities", clrNamespace: "UiPath.Form.Activities", assembly: "UiPath.Form.Activities" },
  "UiPath.Cryptography.Activities": { prefix: "ucrypt", xmlns: "clr-namespace:UiPath.Cryptography.Activities;assembly=UiPath.Cryptography.Activities", clrNamespace: "UiPath.Cryptography.Activities", assembly: "UiPath.Cryptography.Activities" },
  "UiPath.WebAPI.Activities": { prefix: "uwapi", xmlns: "clr-namespace:UiPath.WebAPI.Activities;assembly=UiPath.WebAPI.Activities", clrNamespace: "UiPath.WebAPI.Activities", assembly: "UiPath.WebAPI.Activities" },
  "UiPath.ComplexScenarios.Activities": { prefix: "ucs", xmlns: "clr-namespace:UiPath.ComplexScenarios.Activities;assembly=UiPath.ComplexScenarios.Activities", clrNamespace: "UiPath.ComplexScenarios.Activities", assembly: "UiPath.ComplexScenarios.Activities" },
  "UiPath.AmazonWebServices.Activities": { prefix: "uaws", xmlns: "clr-namespace:UiPath.AmazonWebServices.Activities;assembly=UiPath.AmazonWebServices.Activities", clrNamespace: "UiPath.AmazonWebServices.Activities", assembly: "UiPath.AmazonWebServices.Activities" },
  "UiPath.Amazon.Textract.Activities": { prefix: "utxt", xmlns: "clr-namespace:UiPath.Amazon.Textract.Activities;assembly=UiPath.Amazon.Textract.Activities", clrNamespace: "UiPath.Amazon.Textract.Activities", assembly: "UiPath.Amazon.Textract.Activities" },
  "UiPath.Amazon.Comprehend.Activities": { prefix: "ucmp", xmlns: "clr-namespace:UiPath.Amazon.Comprehend.Activities;assembly=UiPath.Amazon.Comprehend.Activities", clrNamespace: "UiPath.Amazon.Comprehend.Activities", assembly: "UiPath.Amazon.Comprehend.Activities" },
  "UiPath.Amazon.Rekognition.Activities": { prefix: "urek", xmlns: "clr-namespace:UiPath.Amazon.Rekognition.Activities;assembly=UiPath.Amazon.Rekognition.Activities", clrNamespace: "UiPath.Amazon.Rekognition.Activities", assembly: "UiPath.Amazon.Rekognition.Activities" },
  "UiPath.Azure.Activities": { prefix: "uaz", xmlns: "clr-namespace:UiPath.Azure.Activities;assembly=UiPath.Azure.Activities", clrNamespace: "UiPath.Azure.Activities", assembly: "UiPath.Azure.Activities" },
  "UiPath.AzureFormRecognizerV3.Activities": { prefix: "uafr", xmlns: "clr-namespace:UiPath.AzureFormRecognizerV3.Activities;assembly=UiPath.AzureFormRecognizerV3.Activities", clrNamespace: "UiPath.AzureFormRecognizerV3.Activities", assembly: "UiPath.AzureFormRecognizerV3.Activities" },
  "UiPath.GoogleCloud.Activities": { prefix: "ugc", xmlns: "clr-namespace:UiPath.GoogleCloud.Activities;assembly=UiPath.GoogleCloud.Activities", clrNamespace: "UiPath.GoogleCloud.Activities", assembly: "UiPath.GoogleCloud.Activities" },
  "UiPath.GoogleVision.Activities": { prefix: "ugv", xmlns: "clr-namespace:UiPath.GoogleVision.Activities;assembly=UiPath.GoogleVision.Activities", clrNamespace: "UiPath.GoogleVision.Activities", assembly: "UiPath.GoogleVision.Activities" },
  "UiPath.Salesforce.Activities": { prefix: "usf", xmlns: "clr-namespace:UiPath.Salesforce.Activities;assembly=UiPath.Salesforce.Activities", clrNamespace: "UiPath.Salesforce.Activities", assembly: "UiPath.Salesforce.Activities" },
  "UiPath.ServiceNow.Activities": { prefix: "usnow", xmlns: "clr-namespace:UiPath.ServiceNow.Activities;assembly=UiPath.ServiceNow.Activities", clrNamespace: "UiPath.ServiceNow.Activities", assembly: "UiPath.ServiceNow.Activities" },
  "UiPath.Slack.Activities": { prefix: "uslack", xmlns: "clr-namespace:UiPath.Slack.Activities;assembly=UiPath.Slack.Activities", clrNamespace: "UiPath.Slack.Activities", assembly: "UiPath.Slack.Activities" },
  "UiPath.Jira.Activities": { prefix: "ujira", xmlns: "clr-namespace:UiPath.Jira.Activities;assembly=UiPath.Jira.Activities", clrNamespace: "UiPath.Jira.Activities", assembly: "UiPath.Jira.Activities" },
  "UiPath.MicrosoftTeams.Activities": { prefix: "uteams", xmlns: "clr-namespace:UiPath.MicrosoftTeams.Activities;assembly=UiPath.MicrosoftTeams.Activities", clrNamespace: "UiPath.MicrosoftTeams.Activities", assembly: "UiPath.MicrosoftTeams.Activities" },
  "UiPath.FTP.Activities": { prefix: "uftp", xmlns: "clr-namespace:UiPath.FTP.Activities;assembly=UiPath.FTP.Activities", clrNamespace: "UiPath.FTP.Activities", assembly: "UiPath.FTP.Activities" },
  "UiPath.Presentations.Activities": { prefix: "upres", xmlns: "clr-namespace:UiPath.Presentations.Activities;assembly=UiPath.Presentations.Activities", clrNamespace: "UiPath.Presentations.Activities", assembly: "UiPath.Presentations.Activities" },
  "UiPath.Credentials.Activities": { prefix: "ucred", xmlns: "clr-namespace:UiPath.Credentials.Activities;assembly=UiPath.Credentials.Activities", clrNamespace: "UiPath.Credentials.Activities", assembly: "UiPath.Credentials.Activities" },
  "UiPath.DocumentUnderstanding.Activities": { prefix: "udu", xmlns: "clr-namespace:UiPath.DocumentUnderstanding.Activities;assembly=UiPath.DocumentUnderstanding.Activities", clrNamespace: "UiPath.DocumentUnderstanding.Activities", assembly: "UiPath.DocumentUnderstanding.Activities" },
  "UiPath.GenAI.Activities": { prefix: "ugenai", xmlns: "clr-namespace:UiPath.GenAI.Activities;assembly=UiPath.GenAI.Activities", clrNamespace: "UiPath.GenAI.Activities", assembly: "UiPath.GenAI.Activities" },
  "UiPath.IntegrationService.Activities": { prefix: "uis", xmlns: "clr-namespace:UiPath.IntegrationService.Activities;assembly=UiPath.IntegrationService.Activities", clrNamespace: "UiPath.IntegrationService.Activities", assembly: "UiPath.IntegrationService.Activities" },
  "UiPath.CommunicationsMining.Activities": { prefix: "ucm", xmlns: "clr-namespace:UiPath.CommunicationsMining.Activities;assembly=UiPath.CommunicationsMining.Activities", clrNamespace: "UiPath.CommunicationsMining.Activities", assembly: "UiPath.CommunicationsMining.Activities" },
  "UiPath.WorkflowEvents.Activities": { prefix: "uwfe", xmlns: "clr-namespace:UiPath.WorkflowEvents.Activities;assembly=UiPath.WorkflowEvents.Activities", clrNamespace: "UiPath.WorkflowEvents.Activities", assembly: "UiPath.WorkflowEvents.Activities" },
  "UiPath.Box.Activities": { prefix: "ubox", xmlns: "clr-namespace:UiPath.Box.Activities;assembly=UiPath.Box.Activities", clrNamespace: "UiPath.Box.Activities", assembly: "UiPath.Box.Activities" },
};

const EXTRA_PREFIX_ALIASES: Record<string, string> = {
  "ds": "uds",
  "datafabric": "uds",
  "ocr": "uocr",
};

const PREFIX_ALIAS_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [packageName, info] of Object.entries(PACKAGE_NAMESPACE_MAP)) {
    if (!info.prefix) continue;
    const parts = packageName.replace(/^UiPath\./, "").replace(/\.Activities$/, "").split(".");
    for (const part of parts) {
      const alias = part.toLowerCase();
      if (alias !== info.prefix && !map[alias]) {
        map[alias] = info.prefix;
      }
    }
  }
  for (const [alias, canonical] of Object.entries(EXTRA_PREFIX_ALIASES)) {
    if (!map[alias]) {
      map[alias] = canonical;
    }
  }
  return map;
})();

export function normalizeNamespaceAliases(xml: string): { xml: string; warnings: string[] } {
  const warnings: string[] = [];
  let result = xml;

  for (const [alias, canonical] of Object.entries(PREFIX_ALIAS_MAP)) {
    const aliasPattern = new RegExp(`(<\\/?)${alias}:`, "g");
    if (aliasPattern.test(result)) {
      result = result.replace(new RegExp(`(<\\/?)${alias}:`, "g"), `$1${canonical}:`);
      const hasCanonicalXmlns = new RegExp(`xmlns:${canonical}=`).test(result);
      if (hasCanonicalXmlns) {
        result = result.replace(new RegExp(`\\s*xmlns:${alias}="[^"]*"`, "g"), "");
      } else {
        result = result.replace(new RegExp(`xmlns:${alias}=`, "g"), `xmlns:${canonical}=`);
      }
      warnings.push(`Normalized namespace alias "${alias}:" to canonical prefix "${canonical}:"`);
    }
  }

  return { xml: result, warnings };
}

const SYSTEM_ACTIVITIES_NO_PREFIX = new Set([
  "Assign", "If", "TryCatch", "Sequence", "Delay", "Throw", "While", "DoWhile",
  "ForEach", "Flowchart", "FlowStep", "FlowDecision", "FlowSwitch", "Switch",
  "AddToCollection", "RemoveFromCollection", "ClearCollection", "ExistsInCollection",
  "Catch", "Rethrow",
  "State", "StateMachine", "Transition",
]);

export function getActivityPrefix(templateName: string): string {
  const result = getActivityPrefixStrict(templateName);
  if (result !== null) return result;

  throw new Error(`[XAML Compliance] getActivityPrefix("${templateName}"): no namespace mapping found — activity is unmapped. Add it to GUARANTEED_ACTIVITY_PREFIX_MAP or the activity catalog.`);
}

const GUARANTEED_ACTIVITY_PREFIX_MAP: Record<string, string> = {
  "LogMessage": "ui", "Comment": "ui", "InvokeWorkflowFile": "ui",
  "RetryScope": "ui", "ShouldRetry": "ui", "GetAsset": "ui", "GetCredential": "ui",
  "AddQueueItem": "ui", "GetTransactionItem": "ui", "SetTransactionStatus": "ui",
  "TakeScreenshot": "ui", "AddLogFields": "ui", "ReadTextFile": "ui", "WriteTextFile": "ui", "PathExists": "ui",
  "Click": "ui", "TypeInto": "ui", "GetText": "ui", "ElementExists": "ui",
  "OpenBrowser": "ui", "NavigateTo": "ui", "AttachBrowser": "ui", "AttachWindow": "ui",
  "UseApplicationBrowser": "ui", "UseBrowser": "ui", "UseApplication": "ui",
  "HttpClient": "uweb", "DeserializeJson": "uweb", "SerializeJson": "uweb",
  "SendSmtpMailMessage": "umail", "SendOutlookMailMessage": "umail", "GetImapMailMessage": "umail",
  "GetOutlookMailMessages": "umail", "SendMail": "umail", "GetMail": "umail",
  "ExcelApplicationScope": "uexcel", "UseExcel": "uexcel", "ExcelReadRange": "uexcel",
  "ExcelWriteRange": "uexcel", "ExcelWriteCell": "uexcel", "ReadRange": "uexcel", "WriteRange": "uexcel",
  "ExecuteQuery": "udb", "ExecuteNonQuery": "udb", "ConnectToDatabase": "udb",
  "CreateFormTask": "upers", "WaitForFormTaskAndResume": "upers",
  "CreateEntity": "uds", "CreateEntityRecord": "uds", "QueryEntity": "uds",
  "UpdateEntity": "uds", "DeleteEntity": "uds", "GetEntityById": "uds",
  "MLSkill": "uml", "Predict": "uml",
  "DigitizeDocument": "uocr", "ClassifyDocument": "uocr", "ExtractDocumentData": "uocr", "ValidateDocumentData": "uocr",
  "ReadPDFText": "updf", "ReadPDFWithOCR": "updf", "ExtractPDFPageRange": "updf", "MergePDF": "updf", "ExportPDFPageAsImage": "updf", "GetPDFPageCount": "updf",
  "ReadDocument": "uword", "WriteDocument": "uword", "ReplaceText": "uword", "AppendText": "uword", "InsertPicture": "uword", "ReadTable": "uword",
  "GoogleSheetsApplicationScope": "ugs", "GoogleSheetsReadRange": "ugs", "GoogleSheetsWriteRange": "ugs", "GoogleSheetsAppendRange": "ugs",
  "GoogleDriveUploadFile": "ugs", "GoogleDriveDownloadFile": "ugs", "GmailSendMessage": "ugs", "GmailGetMessages": "ugs",
  "MicrosoftOffice365Scope": "uo365", "SendMail365": "uo365", "GetMail365": "uo365", "CreateEvent365": "uo365",
  "ExcelCreateSpreadsheet": "uo365", "ExcelReadRange365": "uo365", "ExcelWriteRange365": "uo365",
  "SharePointUploadFile": "uo365", "SharePointDownloadFile": "uo365",
  "VerifyExpression": "utest", "VerifyRange": "utest", "VerifyControlAttribute": "utest", "LogAssert": "utest",
  "GivenName": "utest", "WhenName": "utest", "ThenName": "utest", "AddTestDataQueueItem": "utest",
  "CreateForm": "uform", "ShowForm": "uform", "CalloutActivities": "uform",
  "EncryptText": "ucrypt", "DecryptText": "ucrypt", "EncryptFile": "ucrypt", "DecryptFile": "ucrypt",
  "HashText": "ucrypt", "HashFile": "ucrypt", "KeyedHashText": "ucrypt",
  "HttpClientRequest": "uwapi", "DownloadFile": "uwapi",
  "MultipleAssign": "ucs", "WaitForDownload": "ucs", "RepeatUntil": "ucs",
  "BuildDataTable": "ucs", "FilterDataTable": "ucs", "SortDataTable": "ucs", "RemoveDuplicateRows": "ucs",
  "JoinDataTables": "ucs", "OutputDataTable": "ucs", "AddDataRow": "ucs", "RemoveDataRow": "ucs", "LookupDataTable": "ucs",
  "AmazonScope": "uaws", "S3UploadFile": "uaws", "S3DownloadFile": "uaws", "S3DeleteObject": "uaws", "S3ListObjects": "uaws",
  "TextractAnalyzeDocument": "utxt", "TextractDetectText": "utxt",
  "ComprehendDetectSentiment": "ucmp", "ComprehendDetectEntities": "ucmp", "ComprehendDetectKeyPhrases": "ucmp", "ComprehendDetectLanguage": "ucmp",
  "RekognitionDetectLabels": "urek", "RekognitionDetectText": "urek", "RekognitionDetectFaces": "urek",
  "AzureScope": "uaz", "AzureBlobUpload": "uaz", "AzureBlobDownload": "uaz", "AzureBlobDelete": "uaz", "AzureBlobList": "uaz",
  "FormRecognizerAnalyze": "uafr", "FormRecognizerAnalyzeLayout": "uafr",
  "GoogleCloudScope": "ugc", "GoogleCloudStorageUpload": "ugc", "GoogleCloudStorageDownload": "ugc",
  "GoogleCloudTranslateText": "ugc", "GoogleCloudNLPAnalyzeSentiment": "ugc",
  "GoogleVisionOCR": "ugv", "GoogleVisionLabelDetection": "ugv",
  "SalesforceApplicationScope": "usf", "SalesforceGetRecords": "usf", "SalesforceInsertRecords": "usf",
  "SalesforceUpdateRecords": "usf", "SalesforceDeleteRecords": "usf", "SalesforceSOQLQuery": "usf",
  "ServiceNowApplicationScope": "usnow", "ServiceNowGetRecords": "usnow", "ServiceNowCreateRecord": "usnow",
  "ServiceNowUpdateRecord": "usnow", "ServiceNowDeleteRecord": "usnow",
  "SlackScope": "uslack", "SlackSendMessage": "uslack", "SlackGetMessages": "uslack", "SlackUploadFile": "uslack",
  "JiraScope": "ujira", "JiraCreateIssue": "ujira", "JiraGetIssue": "ujira",
  "JiraUpdateIssue": "ujira", "JiraSearchIssues": "ujira", "JiraAddComment": "ujira",
  "TeamsScope": "uteams", "TeamsSendMessage": "uteams", "TeamsGetMessages": "uteams", "TeamsSendChatMessage": "uteams",
  "FTPScope": "uftp", "FTPUpload": "uftp", "FTPDownload": "uftp", "FTPDelete": "uftp", "FTPListFiles": "uftp", "FTPDirectoryExists": "uftp",
  "PresentationsApplicationScope": "upres", "AddSlide": "upres", "SetText": "upres", "ExportSlideAsImage": "upres", "ReplaceTextInSlide": "upres",
  "GetSecureCredential": "ucred", "AddCredential": "ucred", "DeleteCredential": "ucred", "RequestCredential": "ucred",
  "TaxonomyManager": "udu", "DigitizeScope": "udu", "ClassifyDocumentScope": "udu",
  "ExtractDocumentDataScope": "udu", "ValidationStation": "udu", "ExportExtractionResults": "udu",
  "UseGenAI": "ugenai", "ExtractData": "ugenai", "ClassifyText": "ugenai", "SummarizeText": "ugenai",
  "IntegrationServiceScope": "uis", "IntegrationServiceHTTPRequest": "uis", "IntegrationServiceTrigger": "uis",
  "CommunicationsMiningScope": "ucm", "AnalyzeMessage": "ucm", "UploadCommunications": "ucm",
  "RaiseAlert": "uwfe", "TriggerJob": "uwfe",
  "BoxScope": "ubox", "BoxUploadFile": "ubox", "BoxDownloadFile": "ubox", "BoxDeleteFile": "ubox", "BoxSearchFiles": "ubox",
};

export function getActivityPrefixStrict(templateName: string): string | null {
  if (SYSTEM_ACTIVITIES_NO_PREFIX.has(templateName)) return "";

  if (GUARANTEED_ACTIVITY_PREFIX_MAP[templateName] !== undefined) {
    return GUARANTEED_ACTIVITY_PREFIX_MAP[templateName];
  }

  if (!catalogService.isLoaded()) {
    try { catalogService.load(); } catch (e) { }
  }

  if (catalogService.isLoaded()) {
    const schema = catalogService.getActivitySchema(templateName);
    if (schema) {
      const pkgInfo = PACKAGE_NAMESPACE_MAP[schema.packageId];
      if (pkgInfo) return pkgInfo.prefix;
    }
  }

  return null;
}

export function getActivityTag(templateName: string): string {
  const strictPrefix = getActivityPrefixStrict(templateName);
  if (strictPrefix === null) {
    throw new Error(`[XAML Compliance] getActivityTag("${templateName}"): no namespace mapping found — activity is unmapped and cannot be emitted safely. Add it to GUARANTEED_ACTIVITY_PREFIX_MAP or the activity catalog.`);
  }
  return strictPrefix ? `${strictPrefix}:${templateName}` : templateName;
}

export function collectUsedPackages(xaml: string): Set<string> {
  const usedPackages = new Set<string>();

  const canonicalPrefixToPackage = new Map<string, string>();
  for (const [packageId, info] of Object.entries(PACKAGE_NAMESPACE_MAP)) {
    if (!info.prefix || info.prefix === "ui") continue;
    canonicalPrefixToPackage.set(info.prefix, packageId);
    const prefixPattern = new RegExp(`<${info.prefix}:`, "g");
    if (prefixPattern.test(xaml)) {
      usedPackages.add(packageId);
    }
  }

  for (const [alias, canonical] of Object.entries(PREFIX_ALIAS_MAP)) {
    const aliasPattern = new RegExp(`<${alias}:`, "g");
    if (aliasPattern.test(xaml)) {
      const packageId = canonicalPrefixToPackage.get(canonical);
      if (packageId) {
        usedPackages.add(packageId);
      }
    }
  }

  if (/<ui:/.test(xaml)) {
    usedPackages.add("UiPath.System.Activities");
  }

  return usedPackages;
}

export function buildDynamicXmlnsDeclarations(usedPackages: Set<string>, isCrossPlatform: boolean, existingXml?: string): string {
  const lines: string[] = [];
  const existingPrefixes = new Set<string>();

  if (existingXml) {
    const prefixPattern = /xmlns:(\w+)="/g;
    let m;
    while ((m = prefixPattern.exec(existingXml)) !== null) {
      existingPrefixes.add(m[1]);
    }
  }

  Array.from(usedPackages).forEach(packageId => {
    const info = PACKAGE_NAMESPACE_MAP[packageId];
    if (!info || !info.prefix || info.prefix === "ui" || info.prefix === "") return;
    if (existingPrefixes.has(info.prefix)) return;
    lines.push(`  xmlns:${info.prefix}="${info.xmlns}"`);
  });

  return lines.join("\n");
}

export function buildDynamicAssemblyRefs(usedPackages: Set<string>, existingXml?: string): string {
  const refs: string[] = [];
  const existingRefs = new Set<string>();

  if (existingXml) {
    const refPattern = /<AssemblyReference>([^<]+)<\/AssemblyReference>/g;
    let m;
    while ((m = refPattern.exec(existingXml)) !== null) {
      existingRefs.add(m[1]);
    }
  }

  Array.from(usedPackages).forEach(packageId => {
    const info = PACKAGE_NAMESPACE_MAP[packageId];
    if (!info) return;
    if (info.assembly === "System.Activities" || info.assembly === "UiPath.Core.Activities") return;
    if (existingRefs.has(info.assembly)) return;
    refs.push(`      <AssemblyReference>${info.assembly}</AssemblyReference>`);
  });

  if (usedPackages.has("UiPath.Web.Activities") && !existingRefs.has("Newtonsoft.Json")) {
    refs.push(`      <AssemblyReference>Newtonsoft.Json</AssemblyReference>`);
  }

  return refs.join("\n");
}

export function buildDynamicNamespaceImports(usedPackages: Set<string>): string {
  const imports: string[] = [];

  Array.from(usedPackages).forEach(packageId => {
    const info = PACKAGE_NAMESPACE_MAP[packageId];
    if (!info) return;
    if (info.clrNamespace === "System.Activities" || info.clrNamespace === "UiPath.Core.Activities") return;
    imports.push(`      <x:String>${info.clrNamespace}</x:String>`);
  });

  if (usedPackages.has("UiPath.Web.Activities")) {
    imports.push(`      <x:String>Newtonsoft.Json</x:String>`);
    imports.push(`      <x:String>Newtonsoft.Json.Linq</x:String>`);
  }

  return imports.join("\n");
}

export function ensureBracketWrapped(val: string): string {
  const trimmed = val.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (trimmed.startsWith("<InArgument") || trimmed.startsWith("<OutArgument")) return trimmed;
  return `[${trimmed}]`;
}

export function looksLikeVariableRef(val: string): boolean {
  const trimmed = val.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return false;
  if (/^[0-9]/.test(trimmed)) return false;
  if (/^".*"$/.test(trimmed)) return false;
  if (/^&quot;/.test(trimmed)) return false;
  if (trimmed === "True" || trimmed === "False" || trimmed === "Nothing" || trimmed === "null" || trimmed === "") return false;
  if (/^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/.test(trimmed)) return true;
  return false;
}

export function smartBracketWrap(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  if (trimmed.startsWith("<InArgument") || trimmed.startsWith("<OutArgument")) return trimmed;
  if (/^".*"$/.test(trimmed)) return trimmed;
  if (/^'.*'$/.test(trimmed)) return trimmed;
  if (/^&quot;.*&quot;$/.test(trimmed)) return trimmed;
  if (trimmed === "True" || trimmed === "False" || trimmed === "Nothing" || trimmed === "null") return trimmed;
  if (/^[0-9]+$/.test(trimmed)) return trimmed;
  if (looksLikePlainText(trimmed)) {
    const escaped = trimmed.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return `[${trimmed}]`;
}

function looksLikePlainText(val: string): boolean {
  if (/^[a-zA-Z_]\w*\(/.test(val)) return false;
  if (/[+\-*/&=<>]/.test(val) && !/[.,!?;:'"…]/.test(val)) return false;
  if (/^[a-zA-Z_]\w*\.[a-zA-Z_]\w*/.test(val)) return false;
  if (/^(str_|int_|bool_|dbl_|dec_|obj_|dt_|ts_|drow_|qi_|sec_)/i.test(val)) return false;
  if (/\s/.test(val) || /[.,!?;:()'"…]/.test(val)) return true;
  if (/^[a-zA-Z_]\w*$/.test(val) && !/^(str_|int_|bool_|dbl_|dec_|obj_|dt_|ts_|drow_|qi_|sec_)/i.test(val)) {
    return false;
  }
  return false;
}

const UIPATH_NAMESPACES = `xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:mva="clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data"
  xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=mscorlib"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"`;

const UIPATH_CROSS_PLATFORM_NAMESPACES = `xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=System.Runtime"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=System.Runtime"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data.Common"
  xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=System.Runtime"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"`;

const UIPATH_VB_SETTINGS = `
  <mva:VisualBasic.Settings>
    <x:Null />
  </mva:VisualBasic.Settings>
  <sap2010:WorkflowViewState.IdRef>__ROOT_ID__</sap2010:WorkflowViewState.IdRef>
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
      <x:String>UiPath.Core.Activities</x:String>
      <x:String>Microsoft.VisualBasic</x:String>
      <x:String>Microsoft.VisualBasic.Activities</x:String>
      <x:String>System.Activities</x:String>
      <x:String>System.Activities.Statements</x:String>
      <x:String>System.Activities.Expressions</x:String>
    </sco:Collection>
  </TextExpression.NamespacesForImplementation>
  <TextExpression.ReferencesForImplementation>
    <sco:Collection x:TypeArguments="AssemblyReference">
      <AssemblyReference>System.Activities</AssemblyReference>
      <AssemblyReference>System.Activities.Core.Presentation</AssemblyReference>
      <AssemblyReference>Microsoft.VisualBasic</AssemblyReference>
      <AssemblyReference>mscorlib</AssemblyReference>
      <AssemblyReference>System.Data</AssemblyReference>
      <AssemblyReference>System</AssemblyReference>
      <AssemblyReference>System.Core</AssemblyReference>
      <AssemblyReference>System.Xml</AssemblyReference>
      <AssemblyReference>System.Xml.Linq</AssemblyReference>
      <AssemblyReference>UiPath.Core</AssemblyReference>
      <AssemblyReference>UiPath.Core.Activities</AssemblyReference>
    </sco:Collection>
  </TextExpression.ReferencesForImplementation>`;

const UIPATH_CSHARP_SETTINGS = `
  <sap2010:WorkflowViewState.IdRef>__ROOT_ID__</sap2010:WorkflowViewState.IdRef>
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
      <x:String>UiPath.Core.Activities</x:String>
    </sco:Collection>
  </TextExpression.NamespacesForImplementation>
  <TextExpression.ReferencesForImplementation>
    <sco:Collection x:TypeArguments="AssemblyReference">
      <AssemblyReference>System.Runtime</AssemblyReference>
      <AssemblyReference>System.Activities.Core.Presentation</AssemblyReference>
      <AssemblyReference>System.Data.Common</AssemblyReference>
      <AssemblyReference>System.Xml.Linq</AssemblyReference>
      <AssemblyReference>UiPath.Core</AssemblyReference>
      <AssemblyReference>UiPath.Core.Activities</AssemblyReference>
    </sco:Collection>
  </TextExpression.ReferencesForImplementation>`;

export function parseInvokeArgs(rawValue: string, direction: "In" | "Out" | "InOut"): string {
  const decoded = rawValue.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const cleaned = decoded.replace(/^\{\s*/, "").replace(/\s*\}$/, "").trim();
  if (!cleaned) return "";

  let result = "";
  const argType = direction === "In" ? "InArgument" : direction === "Out" ? "OutArgument" : "InOutArgument";

  const pairPattern = /(?:^|,)\s*"([^"]+)"\s*:\s*("(?:[^"\\]|\\.)*"|[^,}]+)/g;
  let m;
  while ((m = pairPattern.exec(cleaned)) !== null) {
    const key = m[1].trim();
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    if (!val.startsWith("[")) val = `[${val}]`;
    result += `                <${argType} x:TypeArguments="x:String" x:Key="${escapeXml(key)}">${escapeXml(val)}</${argType}>\n`;
  }

  if (!result) {
    const simplePairs = cleaned.split(/,\s*/);
    for (const pair of simplePairs) {
      const colonIdx = pair.indexOf(":");
      if (colonIdx < 0) continue;
      const key = pair.substring(0, colonIdx).trim().replace(/^["']|["']$/g, "");
      let val = pair.substring(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!key) continue;
      if (!val.startsWith("[")) val = `[${val}]`;
      result += `                <${argType} x:TypeArguments="x:String" x:Key="${escapeXml(key)}">${escapeXml(val)}</${argType}>\n`;
    }
  }

  return result;
}

function collapseDoubledArgumentsXmlParser(xml: string): string {
  const argTags = ["InArgument", "OutArgument", "InOutArgument"];
  const MAX_PASSES = 20;

  for (const tag of argTags) {
    let pass = 0;
    while (pass < MAX_PASSES) {
      const before = xml;
      const outerPattern = new RegExp(
        `<${tag}(\\s[^>]*)?>\\s*<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>\\s*<\\/${tag}>`,
        "g"
      );
      xml = xml.replace(outerPattern, (_match, outerAttrs, innerAttrs, content) => {
        const attrs = ((innerAttrs || outerAttrs) || "").trim();
        const trimmedContent = content.trim();
        return `<${tag}${attrs ? " " + attrs : ""}>${trimmedContent}</${tag}>`;
      });

      const outerNewlinePattern = new RegExp(
        `<${tag}(\\s[^>]*)?>\\s*\\n\\s*<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>\\s*\\n\\s*<\\/${tag}>`,
        "g"
      );
      xml = xml.replace(outerNewlinePattern, (_match, outerAttrs, innerAttrs, content) => {
        const attrs = ((innerAttrs || outerAttrs) || "").trim();
        const trimmedContent = content.trim();
        return `<${tag}${attrs ? " " + attrs : ""}>${trimmedContent}</${tag}>`;
      });

      if (xml === before) break;
      pass++;
      if (pass > 1) {
        console.log(`[XAML Compliance] collapseDoubledArguments: pass ${pass} for <${tag}> — collapsing deeply nested wrappers`);
      }
    }
  }

  for (const tag of argTags) {
    const nestedPattern = new RegExp(`<${tag}[^>]*>\\s*<${tag}[\\s\\S]*?<\\/${tag}>\\s*<\\/${tag}>`);
    if (nestedPattern.test(xml)) {
      console.warn(`[XAML Compliance] Post-collapse: nested <${tag}> still detected — applying brute-force strip`);
      let stripPass = 0;
      while (stripPass < MAX_PASSES) {
        const beforeStrip = xml;
        xml = xml.replace(new RegExp(`(<${tag}[^>]*>)\\s*<${tag}[^>]*>`, "g"), "$1");
        xml = xml.replace(new RegExp(`<\\/${tag}>\\s*(<\\/${tag}>)`, "g"), "$1");
        if (xml === beforeStrip) break;
        stripPass++;
      }

      if (nestedPattern.test(xml)) {
        const errorMsg = `[XAML Compliance] FATAL: nested <${tag}> persists after ${MAX_PASSES} collapse passes — XAML is malformed`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
    }
  }

  return xml;
}

export function normalizeAssignArgumentNesting(xml: string): string {
  const nestedOutInTo = /<Assign\.To>\s*<OutArgument([^>]*)>\s*<OutArgument[\s\S]*?<\/OutArgument>\s*<\/OutArgument>\s*<\/Assign\.To>/;
  const nestedInInValue = /<Assign\.Value>\s*<InArgument([^>]*)>\s*<InArgument[\s\S]*?<\/InArgument>\s*<\/InArgument>\s*<\/Assign\.Value>/;
  let passes = 0;
  const MAX = 20;

  while (passes < MAX && (nestedOutInTo.test(xml) || nestedInInValue.test(xml))) {
    xml = xml.replace(
      /<Assign\.To>([\s\S]*?)<\/Assign\.To>/g,
      (_match, inner) => {
        let content = inner;
        let stripped = true;
        while (stripped) {
          stripped = false;
          content = content.replace(
            /<OutArgument([^>]*)>\s*<OutArgument([^>]*)>([\s\S]*?)<\/OutArgument>\s*<\/OutArgument>/g,
            (_m: string, outerAttrs: string, innerAttrs: string, c: string) => {
              stripped = true;
              const attrs = (innerAttrs || outerAttrs).trim();
              return `<OutArgument${attrs ? " " + attrs : ""}>${c.trim()}</OutArgument>`;
            }
          );
        }
        return `<Assign.To>${content}</Assign.To>`;
      }
    );

    xml = xml.replace(
      /<Assign\.Value>([\s\S]*?)<\/Assign\.Value>/g,
      (_match, inner) => {
        let content = inner;
        let stripped = true;
        while (stripped) {
          stripped = false;
          content = content.replace(
            /<InArgument([^>]*)>\s*<InArgument([^>]*)>([\s\S]*?)<\/InArgument>\s*<\/InArgument>/g,
            (_m: string, outerAttrs: string, innerAttrs: string, c: string) => {
              stripped = true;
              const attrs = (innerAttrs || outerAttrs).trim();
              return `<InArgument${attrs ? " " + attrs : ""}>${c.trim()}</InArgument>`;
            }
          );
        }
        return `<Assign.Value>${content}</Assign.Value>`;
      }
    );

    passes++;
  }

  if (nestedOutInTo.test(xml) || nestedInInValue.test(xml)) {
    throw new Error(`[XAML Compliance] FATAL: Assign argument nesting persists after ${MAX} normalization passes — XAML is malformed`);
  }

  const assignToBlocks = xml.match(/<Assign\.To>[\s\S]*?<\/Assign\.To>/g) || [];
  for (const block of assignToBlocks) {
    const outArgCount = (block.match(/<OutArgument[\s>]/g) || []).length;
    if (outArgCount === 0) {
      throw new Error(`[XAML Compliance] Assign.To missing <OutArgument> wrapper: ${block.slice(0, 200)}`);
    }
    if (outArgCount > 1) {
      throw new Error(`[XAML Compliance] Assign.To has ${outArgCount} <OutArgument> wrappers (expected 1): ${block.slice(0, 200)}`);
    }
  }

  const assignValueBlocks = xml.match(/<Assign\.Value>[\s\S]*?<\/Assign\.Value>/g) || [];
  for (const block of assignValueBlocks) {
    const inArgCount = (block.match(/<InArgument[\s>]/g) || []).length;
    if (inArgCount === 0) {
      throw new Error(`[XAML Compliance] Assign.Value missing <InArgument> wrapper: ${block.slice(0, 200)}`);
    }
    if (inArgCount > 1) {
      throw new Error(`[XAML Compliance] Assign.Value has ${inArgCount} <InArgument> wrappers (expected 1): ${block.slice(0, 200)}`);
    }
  }

  return xml;
}

const VB_RESERVED_WORDS = new Set([
  "true", "false", "nothing", "null", "not", "and", "or", "andalso", "orelse",
  "is", "isnot", "if", "ctype", "directcast", "gettype", "typeof", "new",
  "throw", "string", "integer", "boolean", "double", "object", "datetime",
  "math", "convert", "int32", "int64", "exception", "system", "console",
  "environment", "char", "byte", "short", "long", "single", "decimal", "date",
  "timespan", "array", "type", "enum", "dictionary", "list", "cstr", "cint",
  "cdbl", "cbool", "cdate", "clng", "csng", "cdec", "cbyte", "cshort", "cchar",
  "mod", "like", "xor", "me", "mybase", "addressof", "dim", "as", "of", "from",
  "where", "select", "in", "step", "to", "byval", "byref", "optional",
  "paramarray", "handles", "implements", "inherits", "overrides", "overloads",
  "mustoverride", "mustinherit", "shared", "static", "const", "readonly",
  "writeonly", "friend", "protected", "private", "public", "return", "exit",
  "continue", "do", "loop", "until", "wend", "each", "next", "case", "end",
  "sub", "function", "property", "event", "class", "structure", "module",
  "interface", "namespace", "imports", "try", "catch", "finally", "using",
  "with", "synclock", "raiseevent", "removehandler", "addhandler", "let",
  "set", "get", "then", "else", "elseif", "for", "while", "goto", "redim",
  "preserve", "erase", "stop", "on", "error", "resume", "option", "strict",
  "explicit", "compare", "binary", "text", "cbyte",
]);

const DOTNET_MEMBERS = new Set([
  "tostring", "substring", "length", "count", "rows", "message", "stacktrace",
  "name", "reference", "min", "max", "contains", "startswith", "endswith",
  "trim", "replace", "split", "join", "format", "parse", "tryparse", "now",
  "today", "utcnow", "adddays", "addhours", "item", "value", "key", "hasvalue",
  "result", "body", "subject", "content", "equals", "compareto", "indexof",
  "lastindexof", "remove", "insert", "padleft", "padright", "tolower", "toupper",
  "toarray", "tolist", "firstordefault", "lastordefault", "any", "all", "sum",
  "average", "orderby", "groupby", "concat", "append", "clear", "add",
  "addrange", "copyto", "clone", "dispose", "close", "flush", "read", "write",
  "seek", "getbytes", "getstring", "encode", "decode", "invoke", "execute",
  "cancel", "abort", "wait", "reset", "trygetvalue", "containskey", "keys",
  "values", "empty", "isnullorempty", "isnullorwhitespace", "toint32",
  "toint64", "todouble", "toboolean", "tosingle", "todecimal", "tobyte",
  "tochar", "tostring", "gettype", "gethashcode", "referenceequals",
  "memberwise", "finalize", "op_equality", "op_inequality",
]);

const XML_PREFIXES = new Set([
  "x", "s", "scg", "scg2", "ui", "sap", "sap2010", "mc", "mva", "sco",
  "sads", "sapv", "p", "local", "xmlns", "clr",
]);

function inferVariableTypeFromBindingContext(varName: string, xml: string): string | null {
  const escapedName = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const catchPattern = new RegExp(`<Catch\\s[^>]*>\\s*<Catch\\.Action>\\s*<ActivityAction[^>]*>\\s*<ActivityAction\\.Argument>\\s*<DelegateInArgument[^>]*Name="${escapedName}"`, "s");
  if (catchPattern.test(xml)) {
    const catchTypeMatch = xml.match(new RegExp(`<Catch\\s[^>]*x:TypeArguments="([^"]+)"[^>]*>[\\s\\S]*?Name="${escapedName}"`));
    if (catchTypeMatch) {
      return catchTypeMatch[1];
    }
    return "s:Exception";
  }

  return null;
}

const KNOWN_DOTNET_TYPES = new Set([
  "string", "stringcomparer", "integer", "int32", "int64", "boolean", "double",
  "decimal", "byte", "char", "single", "object", "datetime", "timespan",
  "datatable", "datarow", "datacolumn", "dataset", "exception", "guid",
  "uri", "regex", "math", "convert", "environment", "path", "file",
  "directory", "console", "array", "list", "dictionary", "hashset",
  "queue", "stack", "tuple", "task", "thread", "encoding", "streamreader",
  "streamwriter", "xmldocument", "xmlnode", "jsonconvert", "jtoken", "jobject",
  "jarray", "activator", "type", "enumerable", "queryable",
  "stringbuilder", "memorystream", "filestream", "stopwatch",
  "cancellationtoken", "semaphore", "mutex",
]);

const DOMAIN_TERMS = new Set([
  "birthdays", "home", "personal", "work", "calendar", "events",
  "contacts", "settings", "inbox", "outbox", "drafts", "archive",
  "favorites", "categories", "labels", "tags", "notes", "tasks",
  "projects", "reports", "dashboard", "profile", "notifications",
  "messages", "files", "folders", "documents", "templates",
  "users", "groups", "roles", "permissions", "admin",
  "dispatcher", "performer", "transaction", "queue", "status",
  "config", "init", "setup", "cleanup", "process", "main",
  "retry", "exhausted", "completed", "pending", "failed",
  "yes", "no", "true", "false", "success", "error", "warning",
  "start", "stop", "open", "close", "save", "delete", "update",
  "input", "output", "result", "value", "item", "data", "name",
  "email", "password", "username", "login", "logout", "submit",
]);

const CONSTANT_PATTERNS = /^[A-Z][A-Z0-9_]+$/;

function isUnicodeEscapeFragment(token: string): boolean {
  if (/^[0-9a-fA-F]{2,5}$/.test(token)) return true;
  if (/^u[0-9a-fA-F]{4,5}$/.test(token)) return true;
  if (/^[A-Fa-f][0-9a-fA-F]{3}$/.test(token)) return true;
  return false;
}

function isExcludedToken(token: string): boolean {
  if (token.length <= 1) return true;
  const lower = token.toLowerCase();
  if (VB_RESERVED_WORDS.has(lower)) return true;
  if (DOTNET_MEMBERS.has(lower)) return true;
  if (XML_PREFIXES.has(lower)) return true;
  if (/^\d/.test(token)) return true;
  if (/^[A-Z][a-z]+[A-Z]/.test(token) === false && /^[A-Z]{2,}$/.test(token)) return true;
  if (isUnicodeEscapeFragment(token)) return true;
  if (KNOWN_DOTNET_TYPES.has(lower)) return true;
  if (DOMAIN_TERMS.has(lower)) return true;
  if (CONSTANT_PATTERNS.test(token)) return true;
  return false;
}

function findNearestEnclosingSequenceIndex(xml: string, refIndex: number): number {
  let bestIdx = -1;
  const seqPattern = /<Sequence\s[^>]*>/g;
  let sm;
  while ((sm = seqPattern.exec(xml)) !== null) {
    if (sm.index < refIndex) {
      const closeTag = "</Sequence>";
      const closeIdx = xml.indexOf(closeTag, sm.index);
      if (closeIdx === -1 || closeIdx > refIndex) {
        bestIdx = sm.index;
      }
    }
  }
  return bestIdx;
}

function ensureVariableDeclarations(xml: string): string {
  const declaredVars = new Set<string>();
  let m;

  const varDeclPattern = /<Variable\s[^>]*Name="([^"]+)"/g;
  while ((m = varDeclPattern.exec(xml)) !== null) declaredVars.add(m[1]);

  const delegatePattern = /<DelegateInArgument[^>]*Name="([^"]+)"/g;
  while ((m = delegatePattern.exec(xml)) !== null) declaredVars.add(m[1]);

  const propPattern = /<x:Property\s[^>]*Name="([^"]+)"/g;
  while ((m = propPattern.exec(xml)) !== null) declaredVars.add(m[1]);

  const argBindingPattern = /<(?:In|Out|InOut)Argument[^>]*>\s*\[?([a-zA-Z_]\w*)\]?\s*<\/(?:In|Out|InOut)Argument>/g;
  while ((m = argBindingPattern.exec(xml)) !== null) declaredVars.add(m[1]);

  const classMatch = xml.match(/x:Class="([^"]+)"/);
  const workflowSelfName = classMatch ? classMatch[1].split(".").pop() || "" : "";
  if (workflowSelfName) declaredVars.add(workflowSelfName);

  const referencedVarsWithPos = new Map<string, number>();

  const unicodeContextPattern = /[\\]u[0-9a-fA-F]{4,5}/;

  const bracketExprPattern = /\[([^\[\]]+)\]/g;
  let bracketMatch;
  while ((bracketMatch = bracketExprPattern.exec(xml)) !== null) {
    const expr = bracketMatch[1];
    if (expr.startsWith("&quot;") || expr.startsWith('"')) continue;
    if (expr.includes("xmlns") || expr.includes("clr-namespace")) continue;

    const withoutStrings = expr.replace(/&quot;[^&]*&quot;/g, "").replace(/"[^"]*"/g, "");

    if (unicodeContextPattern.test(expr) || /Regex|ChrW|Char|Replace.*u[0-9a-fA-F]/.test(expr)) continue;

    const tokens = withoutStrings.match(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g);
    if (!tokens) continue;

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (isExcludedToken(token)) continue;

      const afterToken = withoutStrings.indexOf(token) + token.length;
      const charAfter = withoutStrings[afterToken];
      if (charAfter === "(") continue;

      if (i > 0) {
        const prevToken = tokens[i - 1];
        if (prevToken === "." || withoutStrings.includes(`.${token}`)) continue;
      }

      if (token === "u" || /^u[0-9a-fA-F]{4,5}$/.test(token) || (token.length <= 5 && /^[0-9a-fA-F]+$/.test(token) && i > 0 && (tokens[i-1] === "u" || /^u[0-9a-fA-F]*$/.test(tokens[i-1])))) continue;

      if (!referencedVarsWithPos.has(token)) {
        referencedVarsWithPos.set(token, bracketMatch.index);
      }
    }
  }

  const missingVars: { name: string; type: string | null; refIndex: number }[] = [];
  for (const [varName, refIdx] of Array.from(referencedVarsWithPos)) {
    if (!declaredVars.has(varName)) {
      missingVars.push({ name: varName, type: inferVariableTypeFromBindingContext(varName, xml), refIndex: refIdx });
    }
  }

  if (missingVars.length === 0) return xml;

  const classMatch2 = xml.match(/x:Class="([^"]+)"/);
  const workflowName = classMatch2 ? classMatch2[1] : "unknown";

  const declarableVars = missingVars.filter(v => v.type !== null);
  const undeclarableVars = missingVars.filter(v => v.type === null);

  for (const v of undeclarableVars) {
    const lineNum = xml.substring(0, v.refIndex).split("\n").length;
    console.warn(`[XAML Compliance] Undeclared variable "${v.name}" at line ${lineNum} in ${workflowName} — type cannot be deterministically inferred from binding context, skipping auto-declaration (will be reported as quality gate violation)`);
  }

  if (declarableVars.length === 0) return xml;

  const seqInsertions = new Map<number, { name: string; type: string }[]>();
  for (const v of declarableVars) {
    console.log(`Auto-declared variable ${v.name} as ${v.type} in ${workflowName} (deterministic from binding context)`);
    const seqIdx = findNearestEnclosingSequenceIndex(xml, v.refIndex);
    const key = seqIdx >= 0 ? seqIdx : 0;
    if (!seqInsertions.has(key)) seqInsertions.set(key, []);
    seqInsertions.get(key)!.push({ name: v.name, type: v.type! });
  }

  const sortedKeys = Array.from(seqInsertions.keys()).sort((a, b) => b - a);

  for (const seqIdx of sortedKeys) {
    const vars = seqInsertions.get(seqIdx)!;
    const varsXml = vars.map(v =>
      `      <Variable x:TypeArguments="${v.type}" Name="${v.name}" />`
    ).join("\n");

    if (seqIdx <= 0) {
      const seqVarsPattern = /(<Sequence[^>]*>)\s*(<Sequence\.Variables>)/;
      if (seqVarsPattern.test(xml)) {
        xml = xml.replace(seqVarsPattern, (match, seqTag, varsTag) => {
          return `${seqTag}\n    ${varsTag}\n${varsXml}`;
        });
      } else {
        const firstSeqPattern = /(<Sequence\s+DisplayName="[^"]*"[^>]*>)/;
        if (firstSeqPattern.test(xml)) {
          xml = xml.replace(firstSeqPattern, (match, seqTag) => {
            return `${seqTag}\n    <Sequence.Variables>\n${varsXml}\n    </Sequence.Variables>`;
          });
        }
      }
      continue;
    }

    const seqTagEndIdx = xml.indexOf(">", seqIdx);
    if (seqTagEndIdx === -1) continue;

    const afterTag = xml.substring(seqTagEndIdx + 1);
    const existingVarsMatch = afterTag.match(/^\s*<Sequence\.Variables>/);
    if (existingVarsMatch) {
      const insertPos = seqTagEndIdx + 1 + existingVarsMatch[0].length;
      xml = xml.slice(0, insertPos) + "\n" + varsXml + xml.slice(insertPos);
    } else {
      const seqTag = xml.substring(seqIdx, seqTagEndIdx + 1);
      xml = xml.slice(0, seqTagEndIdx + 1) +
        `\n    <Sequence.Variables>\n${varsXml}\n    </Sequence.Variables>` +
        xml.slice(seqTagEndIdx + 1);
    }
  }

  return xml;
}

const VARIABLE_PREFIX_PATTERN = /^(str_|int_|dbl_|bool_|sec_|dt_|drow_|obj_|dec_|ts_|lst_|dic_|arr_|row_|qi_)/i;

const QUOTED_EXPRESSION_PATTERNS = [
  /^"Exception\.Message"$/,
  /^"exception\.Message"$/,
  /^"Exception\.ToString\(\)"$/,
  /^"exception\.ToString\(\)"$/,
];

function fixBareVariableRefsInExpressionAttributes(xml: string): string {
  const expressionAttrs = ["Message", "Condition", "To", "Value"];

  for (const attr of expressionAttrs) {
    const pattern = new RegExp(`${attr}="([^"]*)"`, "g");
    xml = xml.replace(pattern, (match, val) => {
      if (!val || val.startsWith("[") || val.startsWith("&quot;") || val.startsWith("<")) return match;
      if (val === "True" || val === "False" || val === "Nothing" || val === "null") return match;
      if (/^[0-9]+$/.test(val)) return match;

      if (VARIABLE_PREFIX_PATTERN.test(val) && /^[a-zA-Z_]\w*(\.[a-zA-Z_]\w*)*$/.test(val)) {
        return `${attr}="[${val}]"`;
      }

      for (const qp of QUOTED_EXPRESSION_PATTERNS) {
        if (qp.test(val)) {
          const inner = val.slice(1, -1);
          return `${attr}="[${inner}]"`;
        }
      }

      return match;
    });
  }

  return xml;
}

const XAML_MARKUP_EXTENSION_PATTERN = /^\{(?:\w+:\w+|Binding|StaticResource|DynamicResource|TemplateBinding|RelativeSource)\b/;

function isXamlMarkupExtension(value: string): boolean {
  return XAML_MARKUP_EXTENSION_PATTERN.test(value.trim());
}

export function sanitizeXmlArtifacts(xml: string): string {
  xml = xml.replace(/="([^"]*?[^}\]])(\}+)"/g, (match, val, braces) => {
    if (isXamlMarkupExtension(val)) return match;
    if (/\[.*\]/.test(val + braces)) return match;
    if (/New\s+Dictionary|From\s*\{/.test(val)) return match;
    console.log(`[XAML Compliance] Removed stray } from attribute value`);
    return `="${val}"`;
  });

  xml = xml.replace(/"([^"]*?)"\s*\}(?=\s|>|\/)/g, (match, val) => {
    if (isXamlMarkupExtension(val)) return match;
    if (/\[.*\]/.test(match)) return match;
    return `"${val}"`;
  });

  xml = xml.replace(/\s+[a-zA-Z_][\w]*="No auto-correction[^"]*"/g, "");
  xml = xml.replace(/\s+[a-zA-Z_][\w]*="[^"]*;\s*(?:do not|must not|should not|cannot)[^"]*"/gi, "");

  return xml;
}

function injectDynamicNamespaceDeclarations(xml: string, isCrossPlatform: boolean): string {
  const usedPackages = collectUsedPackages(xml);

  const hasNewtonsoftTypes = /JObject|JToken|JArray|JsonConvert|Newtonsoft/i.test(xml);
  if (hasNewtonsoftTypes) {
    usedPackages.add("UiPath.Web.Activities");
  }

  const additionalXmlns = buildDynamicXmlnsDeclarations(usedPackages, isCrossPlatform, xml);
  const additionalAssemblyRefs = buildDynamicAssemblyRefs(usedPackages, xml);
  const additionalNamespaceImports = buildDynamicNamespaceImports(usedPackages);

  if (additionalXmlns) {
    const xmlnsInsertPoint = xml.indexOf('xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"');
    if (xmlnsInsertPoint >= 0) {
      const insertAfter = xmlnsInsertPoint + 'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"'.length;
      xml = xml.slice(0, insertAfter) + "\n" + additionalXmlns + xml.slice(insertAfter);
    }
  }

  if (additionalAssemblyRefs) {
    const refsCloseTag = "</sco:Collection>\n  </TextExpression.ReferencesForImplementation>";
    const refsIdx = xml.indexOf(refsCloseTag);
    if (refsIdx >= 0) {
      xml = xml.slice(0, refsIdx) + additionalAssemblyRefs + "\n" + xml.slice(refsIdx);
    }
  }

  if (additionalNamespaceImports) {
    const importsCloseTag = "</sco:Collection>\n  </TextExpression.NamespacesForImplementation>";
    const importsIdx = xml.indexOf(importsCloseTag);
    if (importsIdx >= 0) {
      xml = xml.slice(0, importsIdx) + additionalNamespaceImports + "\n" + xml.slice(importsIdx);
    }
  }

  return xml;
}

const APPROVED_XMLNS_MAPPINGS: Record<string, { validUris: string[] }> = {
  "ui": { validUris: ["http://schemas.uipath.com/workflow/activities"] },
  "x": { validUris: ["http://schemas.microsoft.com/winfx/2006/xaml"] },
  "mc": { validUris: ["http://schemas.openxmlformats.org/markup-compatibility/2006"] },
  "s": { validUris: ["clr-namespace:System;assembly=mscorlib", "clr-namespace:System;assembly=System.Runtime"] },
  "sap": { validUris: ["http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"] },
  "sap2010": { validUris: ["http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"] },
  "scg": { validUris: ["clr-namespace:System.Collections.Generic;assembly=mscorlib", "clr-namespace:System.Collections.Generic;assembly=System.Runtime"] },
  "scg2": { validUris: ["clr-namespace:System.Data;assembly=System.Data", "clr-namespace:System.Data;assembly=System.Data.Common"] },
  "sco": { validUris: ["clr-namespace:System.Collections.ObjectModel;assembly=mscorlib", "clr-namespace:System.Collections.ObjectModel;assembly=System.Runtime"] },
  "mva": { validUris: ["clr-namespace:Microsoft.VisualBasic.Activities;assembly=System.Activities"] },
};

for (const [, info] of Object.entries(PACKAGE_NAMESPACE_MAP)) {
  if (info.prefix && info.prefix !== "" && !APPROVED_XMLNS_MAPPINGS[info.prefix]) {
    APPROVED_XMLNS_MAPPINGS[info.prefix] = { validUris: [info.xmlns] };
  }
}

const DATETIME_FORMAT_SAFE_PREFIXES = new Set(["HH", "MM", "ss", "dd", "yyyy", "mm", "hh"]);

function stripAttributeValuesAndTextContent(xml: string): string {
  let result = "";
  let i = 0;
  while (i < xml.length) {
    if (xml.startsWith("<!--", i)) {
      const commentEnd = xml.indexOf("-->", i + 4);
      if (commentEnd === -1) {
        break;
      }
      i = commentEnd + 3;
      continue;
    }
    if (xml[i] === "<") {
      const tagEnd = xml.indexOf(">", i);
      if (tagEnd === -1) {
        result += xml.slice(i);
        break;
      }
      const tagContent = xml.slice(i, tagEnd + 1);
      let cleaned = "";
      let j = 0;
      while (j < tagContent.length) {
        if (tagContent[j] === '"') {
          cleaned += '"';
          j++;
          while (j < tagContent.length && tagContent[j] !== '"') j++;
          if (j < tagContent.length) {
            cleaned += '"';
            j++;
          }
        } else if (tagContent[j] === "'") {
          cleaned += "'";
          j++;
          while (j < tagContent.length && tagContent[j] !== "'") j++;
          if (j < tagContent.length) {
            cleaned += "'";
            j++;
          }
        } else {
          cleaned += tagContent[j];
          j++;
        }
      }
      result += cleaned;
      i = tagEnd + 1;
    } else {
      const nextTag = xml.indexOf("<", i);
      if (nextTag === -1) {
        break;
      }
      i = nextTag;
    }
  }
  return result;
}

export function validateNamespacePrefixes(xml: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const declaredPrefixes = new Map<string, string>();
  const xmlnsPattern = /xmlns:([a-zA-Z][a-zA-Z0-9]*)="([^"]+)"/g;
  let m;
  while ((m = xmlnsPattern.exec(xml)) !== null) {
    declaredPrefixes.set(m[1], m[2]);
  }

  const strippedXml = stripAttributeValuesAndTextContent(xml);

  const usedPrefixes = new Set<string>();
  const tagPrefixPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*):/g;
  while ((m = tagPrefixPattern.exec(strippedXml)) !== null) {
    usedPrefixes.add(m[1]);
  }

  const attrPrefixPattern = /\s([a-zA-Z][a-zA-Z0-9]*):[a-zA-Z]/g;
  while ((m = attrPrefixPattern.exec(strippedXml)) !== null) {
    if (m[1] !== "xmlns") {
      usedPrefixes.add(m[1]);
    }
  }

  Array.from(usedPrefixes).forEach(prefix => {
    if (prefix === "xml") return;
    if (DATETIME_FORMAT_SAFE_PREFIXES.has(prefix)) return;
    if (!declaredPrefixes.has(prefix)) {
      errors.push(`Namespace prefix "${prefix}" is used in activity tags but has no corresponding xmlns declaration`);
      return;
    }

    const declaredUri = declaredPrefixes.get(prefix)!;
    const approved = APPROVED_XMLNS_MAPPINGS[prefix];
    if (approved) {
      if (!approved.validUris.includes(declaredUri)) {
        errors.push(`Namespace prefix "${prefix}" is declared with URI "${declaredUri}" which does not match any approved CLR namespace mapping. Expected one of: ${approved.validUris.join(", ")}`);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

export function validateActivityTagSemantics(xml: string): { valid: boolean; errors: string[]; warnings: string[]; repairedXml: string } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let repairedXml = xml;

  const activityTagPattern = /<([a-zA-Z][a-zA-Z0-9]*):([A-Z][a-zA-Z0-9]*)[\s>\/]/g;
  let m;
  const checkedTags = new Set<string>();

  while ((m = activityTagPattern.exec(xml)) !== null) {
    const emittedPrefix = m[1];
    const activityName = m[2];
    const tagKey = `${emittedPrefix}:${activityName}`;

    if (checkedTags.has(tagKey)) continue;
    checkedTags.add(tagKey);

    if (["x", "s", "scg", "scg2", "sco", "sap", "sap2010", "mva", "mc"].includes(emittedPrefix)) continue;

    if (SYSTEM_ACTIVITIES_NO_PREFIX.has(activityName)) {
      const escaped = activityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      repairedXml = repairedXml.replace(new RegExp(`<${emittedPrefix}:${escaped}(\\s|>|\\/)`, "g"), `<${activityName}$1`);
      repairedXml = repairedXml.replace(new RegExp(`<\\/${emittedPrefix}:${escaped}>`, "g"), `</${activityName}>`);
      repairedXml = repairedXml.replace(new RegExp(`<${emittedPrefix}:${escaped}\\.`, "g"), `<${activityName}.`);
      repairedXml = repairedXml.replace(new RegExp(`<\\/${emittedPrefix}:${escaped}\\.`, "g"), `</${activityName}.`);
      warnings.push(`Activity "${activityName}" had prefix "${emittedPrefix}:" auto-corrected to no prefix (System.Activities type)`);
      continue;
    }

    const strictPrefix = getActivityPrefixStrict(activityName);
    if (strictPrefix === null) {
      if (emittedPrefix === "ui") {
        warnings.push(`Activity "${activityName}" has no catalog mapping — emitted with default ui: prefix (may be incorrect)`);
      }
      continue;
    }

    if (strictPrefix !== emittedPrefix) {
      const escaped = activityName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const targetTag = strictPrefix ? `${strictPrefix}:${activityName}` : activityName;
      repairedXml = repairedXml.replace(new RegExp(`<${emittedPrefix}:${escaped}(\\s|>|\\/)`, "g"), `<${targetTag}$1`);
      repairedXml = repairedXml.replace(new RegExp(`<\\/${emittedPrefix}:${escaped}>`, "g"), `</${targetTag}>`);
      repairedXml = repairedXml.replace(new RegExp(`<${emittedPrefix}:${escaped}\\.`, "g"), `<${targetTag}.`);
      repairedXml = repairedXml.replace(new RegExp(`<\\/${emittedPrefix}:${escaped}\\.`, "g"), `</${targetTag}.`);
      warnings.push(`Activity "${activityName}" had prefix "${emittedPrefix}:" auto-corrected to "${strictPrefix || "(no prefix)"}:" (catalog prefix mismatch)`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, repairedXml };
}

export function validateXmlWellFormedness(xml: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const result = XMLValidator.validate(xml, {
    allowBooleanAttributes: true,
  });

  if (result !== true) {
    const errObj = result as { err: { code: string; msg: string; line: number; col: number } };
    if (errObj.err) {
      errors.push(`XML well-formedness error at line ${errObj.err.line}, col ${errObj.err.col}: ${errObj.err.msg} (code: ${errObj.err.code})`);
    } else {
      errors.push(`XML well-formedness validation failed with unknown error`);
    }
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeXaml(rawXaml: string, targetFramework: TargetFramework = "Windows"): string {
  let idCounter = 0;
  const viewStateEntries: { id: string; width: number; height: number }[] = [];
  const isCrossPlatform = targetFramework === "Portable";

  for (const [aliasName, canonicalName] of Object.entries(ACTIVITY_NAME_ALIAS_MAP)) {
    const escapedAlias = aliasName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rawXaml = rawXaml.replace(new RegExp(`<${escapedAlias}(\\s|>|\\/)`, "g"), `<${canonicalName}$1`);
    rawXaml = rawXaml.replace(new RegExp(`</${escapedAlias}>`, "g"), `</${canonicalName}>`);
  }

  function nextId(prefix: string): string {
    idCounter++;
    return `${prefix}_${idCounter}`;
  }

  function getHintSize(tag: string): { w: number; h: number } {
    if (tag.startsWith("Sequence") || tag.startsWith("StateMachine")) return { w: 400, h: 300 };
    if (tag.startsWith("If")) return { w: 400, h: 280 };
    if (tag.startsWith("TryCatch")) return { w: 400, h: 260 };
    if (tag.startsWith("ForEach")) return { w: 400, h: 240 };
    if (tag.startsWith("State")) return { w: 300, h: 200 };
    if (tag.startsWith("Transition")) return { w: 200, h: 60 };
    return { w: 334, h: 90 };
  }

  let xml = rawXaml;

  const isStateMachineWorkflow = /<Activity[\s\S]*?>\s*(?:<[^>]*>\s*)*<StateMachine[\s>]/.test(xml) ||
    (/<StateMachine\s/.test(xml) && /<State\s/.test(xml) && /<Transition\s/.test(xml));

  if (!isStateMachineWorkflow) {
    const targetNamespaces = isCrossPlatform ? UIPATH_CROSS_PLATFORM_NAMESPACES : UIPATH_NAMESPACES;
    const oldNsBlock = xml.match(/xmlns="http:\/\/schemas\.microsoft\.com\/netfx\/2009\/xaml\/activities"[\s\S]*?xmlns:x="http:\/\/schemas\.microsoft\.com\/winfx\/2006\/xaml"/);
    if (oldNsBlock) {
      xml = xml.replace(oldNsBlock[0], targetNamespaces);
    }
  }

  const classMatch = xml.match(/x:Class="([^"]+)"/);
  const className = classMatch ? classMatch[1].replace(/[^A-Za-z0-9_]/g, "") : "Workflow";
  const rootId = nextId(className);

  const activityTagPattern = /<(Sequence|If|TryCatch|ForEach|Assign|State|StateMachine|Transition|Flowchart|FlowStep|FlowDecision|[a-zA-Z]+:[A-Za-z]+)\s+((?:[^>]*?\s+)?)DisplayName="([^"]*)"([^>]*?)(\s*\/?>)/g;
  xml = xml.replace(activityTagPattern, (match, tag, preAttrs, displayName, rest, closing) => {
    if (preAttrs.includes("WorkflowViewState.IdRef") || rest.includes("WorkflowViewState.IdRef")) return match;
    const prefix = tag.replace(/^[a-zA-Z]+:/, "").replace(/[^A-Za-z]/g, "");
    const id = nextId(prefix);
    const hint = getHintSize(tag);
    viewStateEntries.push({ id, width: hint.w, height: hint.h });
    const pre = preAttrs ? `${preAttrs}` : "";
    return `<${tag} ${pre}DisplayName="${displayName}" sap2010:WorkflowViewState.IdRef="${id}" sap:VirtualizedContainerService.HintSize="${hint.w},${hint.h}"${rest}${closing}`;
  });

  const firstChildMatch = xml.match(/<(Sequence|StateMachine|Flowchart)\s+DisplayName="[^"]*"/);
  if (firstChildMatch) {
    const rootHint = firstChildMatch[1] === "StateMachine" ? { w: 600, h: 500 } : firstChildMatch[1] === "Flowchart" ? { w: 600, h: 400 } : { w: 500, h: 400 };
    viewStateEntries.push({ id: rootId, width: rootHint.w, height: rootHint.h });
  }

  if (!isStateMachineWorkflow) {
    const settingsBlock = isCrossPlatform
      ? UIPATH_CSHARP_SETTINGS.replace("__ROOT_ID__", rootId)
      : UIPATH_VB_SETTINGS.replace("__ROOT_ID__", rootId);

    const alreadyHasSettings = /VisualBasic\.Settings|TextExpression\.NamespacesForImplementation/.test(xml);
    const firstTag = xml.match(/<(Sequence|StateMachine|Flowchart)\s/);
    if (firstTag && firstTag.index !== undefined && !alreadyHasSettings) {
      xml = xml.slice(0, firstTag.index) + settingsBlock + "\n  " + xml.slice(firstTag.index);
    }
  }

  xml = xml.replace(/scg:DataTable/g, "scg2:DataTable");
  xml = xml.replace(/scg:DataRow/g, "scg2:DataRow");


  xml = xml.replace(/<Variable\s+x:TypeArguments="([^"]*?)"\s+Name="(sec_[^"]*?)"\s*\/>/g, (match, typeArg, varName) => {
    if (typeArg !== "s:Security.SecureString") {
      console.log(`[Compliance] Fixing sec_ variable ${varName} type from ${typeArg} to s:Security.SecureString`);
      return `<Variable x:TypeArguments="s:Security.SecureString" Name="${varName}" />`;
    }
    return match;
  });
  xml = xml.replace(/<Variable\s+Name="(sec_[^"]*?)"\s+x:TypeArguments="([^"]*?)"\s*\/>/g, (match, varName, typeArg) => {
    if (typeArg !== "s:Security.SecureString") {
      console.log(`[Compliance] Fixing sec_ variable ${varName} type from ${typeArg} to s:Security.SecureString (reversed attrs)`);
      return `<Variable x:TypeArguments="s:Security.SecureString" Name="${varName}" />`;
    }
    return match;
  });

  xml = xml.replace(/<sap:WorkflowViewState\.ViewStateManager>[\s\S]*?<\/sap:WorkflowViewState\.ViewStateManager>/g, "");
  xml = xml.replace(/<WorkflowViewState\.ViewStateManager>[\s\S]*?<\/WorkflowViewState\.ViewStateManager>/g, "");


  xml = xml.replace(/\.ToString(?!\()/g, ".ToString()");

  if (isCrossPlatform) {
    xml = xml.replace(/Condition="\[(\w+) IsNot Nothing\]"/g, 'Condition="[$1 != null]"');
    xml = xml.replace(/Condition="\[(\w+) Is Nothing\]"/g, 'Condition="[$1 == null]"');
    xml = xml.replace(/Condition="\[Not (\w+)\]"/g, 'Condition="[!$1]"');

    xml = xml.replace(/Condition="\[(\w+) = &quot;([^&]*)&quot;\]"/g, 'Condition="[$1 == &quot;$2&quot;]"');

    xml = xml.replace(/ &amp; /g, " + ");
  }

  xml = sanitizeXmlArtifacts(xml);

  const KNOWN_PREFIXED_ACTIVITIES = [
    "InvokeWorkflowFile", "RetryScope", "AddQueueItem", "GetTransactionItem",
    "SetTransactionStatus", "LogMessage", "GetCredential", "GetAsset",
    "TakeScreenshot", "AddLogFields", "Comment", "ShouldRetry",
    "ReadTextFile", "WriteTextFile", "PathExists",
    "HttpClient", "DeserializeJson", "SerializeJson",
    "SendSmtpMailMessage", "SendOutlookMailMessage", "GetImapMailMessage",
    "GetOutlookMailMessages", "SendMail", "GetMail",
    "ExcelApplicationScope", "UseExcel", "ExcelReadRange", "ExcelWriteRange",
    "ExcelWriteCell", "ReadRange", "WriteRange",
    "ExecuteQuery", "ExecuteNonQuery", "ConnectToDatabase",
    "ElementExists", "Click", "TypeInto", "GetText", "OpenBrowser",
    "NavigateTo", "AttachBrowser", "AttachWindow", "UseApplicationBrowser",
    "UseBrowser", "UseApplication",
    "CreateFormTask", "WaitForFormTaskAndResume",
    "CreateEntity", "CreateEntityRecord", "QueryEntity", "UpdateEntity",
    "DeleteEntity", "GetEntityById",
    "MLSkill", "Predict",
    "DigitizeDocument", "ClassifyDocument", "ExtractDocumentData", "ValidateDocumentData",
  ];

  for (const actName of KNOWN_PREFIXED_ACTIVITIES) {
    const prefix = getActivityPrefix(actName);
    if (!prefix) continue;

    const noPrefixOpen = new RegExp(`<(?![a-zA-Z]+:)${actName}(\\s|>|\\/)`, "g");
    xml = xml.replace(noPrefixOpen, `<${prefix}:${actName}$1`);
    const noPrefixClose = new RegExp(`<\\/(?![a-zA-Z]+:)${actName}>`, "g");
    xml = xml.replace(noPrefixClose, `</${prefix}:${actName}>`);

    if (prefix !== "ui") {
      const wrongUiOpen = new RegExp(`<ui:${actName}(\\s|>|\\/)`, "g");
      xml = xml.replace(wrongUiOpen, `<${prefix}:${actName}$1`);
      const wrongUiClose = new RegExp(`<\\/ui:${actName}>`, "g");
      xml = xml.replace(wrongUiClose, `</${prefix}:${actName}>`);
      const wrongUiProp = new RegExp(`<ui:${actName}\\.`, "g");
      xml = xml.replace(wrongUiProp, `<${prefix}:${actName}.`);
      const wrongUiPropClose = new RegExp(`<\\/ui:${actName}\\.`, "g");
      xml = xml.replace(wrongUiPropClose, `</${prefix}:${actName}.`);
    }
  }

  const openingTagPrefixes = new Map<string, string>();
  const openTagPrefixPattern = /<([a-zA-Z]+):([A-Za-z]+(?:\.[A-Za-z]+)*)[\s>\/]/g;
  let otm;
  while ((otm = openTagPrefixPattern.exec(xml)) !== null) {
    const prefix = otm[1];
    const localName = otm[2];
    if (!openingTagPrefixes.has(localName)) {
      openingTagPrefixes.set(localName, prefix);
    }
  }
  xml = xml.replace(/<\/([A-Za-z]+(?:\.[A-Za-z]+)+)>/g, (match, localName) => {
    const expectedPrefix = openingTagPrefixes.get(localName);
    if (expectedPrefix) {
      return `</${expectedPrefix}:${localName}>`;
    }
    const baseName = localName.split(".")[0];
    const basePrefix = openingTagPrefixes.get(baseName);
    if (basePrefix) {
      return `</${basePrefix}:${localName}>`;
    }
    const strictPrefix = getActivityPrefixStrict(baseName);
    if (strictPrefix) {
      return `</${strictPrefix}:${localName}>`;
    }
    return match;
  });

  xml = xml.replace(/<(ui:(?:While|RetryScope))\s+([^>]*?)\/>/g, (match, tag, attrs) => {
    if (tag === "ui:While") {
      return `<${tag} ${attrs}>
              <${tag}.Body>
                <Sequence DisplayName="While Body" />
              </${tag}.Body>
            </${tag}>`;
    }
    return `<${tag} ${attrs}>
              <${tag}.Body>
                <Sequence DisplayName="Retry Body" />
              </${tag}.Body>
              <${tag}.Condition>
                <ui:ShouldRetry />
              </${tag}.Condition>
            </${tag}>`;
  });

  xml = xml.replace(/<(While)\s+([^>]*?)\/>/g, (match, tag, attrs) => {
    return `<${tag} ${attrs}>
              <${tag}.Body>
                <Sequence DisplayName="While Body" />
              </${tag}.Body>
            </${tag}>`;
  });
  xml = xml.replace(/<(RetryScope)\s+([^>]*?)\/>/g, (match, tag, attrs) => {
    return `<ui:${tag} ${attrs}>
              <ui:${tag}.Body>
                <Sequence DisplayName="Retry Body" />
              </ui:${tag}.Body>
              <ui:${tag}.Condition>
                <ui:ShouldRetry />
              </ui:${tag}.Condition>
            </ui:${tag}>`;
  });

  xml = xml.replace(/<ui:InvokeWorkflowFile\s([^>]*?)Input="([^"]*)"([^>]*?)(\/?>)/g, (match, before, inputVal, after, closing) => {
    let argElements = parseInvokeArgs(inputVal, "In");
    const outputMatch = (before + after).match(/Output="([^"]*)"/);
    if (outputMatch) {
      argElements += parseInvokeArgs(outputMatch[1], "Out");
      before = before.replace(/\s*Output="[^"]*"/, "");
      after = after.replace(/\s*Output="[^"]*"/, "");
    }
    if (argElements) {
      const attrs = (before + after).trim();
      return `<ui:InvokeWorkflowFile ${attrs}>\n              <ui:InvokeWorkflowFile.Arguments>\n${argElements}              </ui:InvokeWorkflowFile.Arguments>\n            </ui:InvokeWorkflowFile>`;
    }
    return `<ui:InvokeWorkflowFile ${(before + after).trim()}${closing}`;
  });
  xml = xml.replace(/<ui:InvokeWorkflowFile\s([^>]*?)Output="([^"]*)"([^>]*?)(\/?>)/g, (match, before, outputVal, after, closing) => {
    if (match.includes("InvokeWorkflowFile.Arguments")) return match;
    const argElements = parseInvokeArgs(outputVal, "Out");
    if (argElements) {
      const attrs = (before + after).trim();
      return `<ui:InvokeWorkflowFile ${attrs}>\n              <ui:InvokeWorkflowFile.Arguments>\n${argElements}              </ui:InvokeWorkflowFile.Arguments>\n            </ui:InvokeWorkflowFile>`;
    }
    return `<ui:InvokeWorkflowFile ${(before + after).trim()}${closing}`;
  });

  xml = xml.replace(/<ui:TakeScreenshot\s+([^>]*?)OutputPath="([^"]*)"([^>]*?)\/>/g, (_match, before, _outputPathVal, after) => {
    const attrs = (before + after).trim();
    return `<ui:TakeScreenshot ${attrs} />`;
  });
  xml = xml.replace(/<ui:TakeScreenshot\s+([^>]*?)FileName="([^"]*)"([^>]*?)\/>/g, (_match, before, _fileNameVal, after) => {
    const attrs = (before + after).trim();
    return `<ui:TakeScreenshot ${attrs} />`;
  });



  xml = xml.replace(/<(InArgument|OutArgument)([^>]*)>\s*<\1([^>]*)>([^<]*)<\/\1>\s*<\/\1>/g, (_m, tag, outerAttrs, innerAttrs, content) => {
    const attrs = (innerAttrs || outerAttrs).trim();
    return `<${tag}${attrs ? " " + attrs : ""}>${content}</${tag}>`;
  });

  xml = xml.replace(/<(InArgument|OutArgument)([^>]*)>\s*\n\s*<\1([^>]*)>([^<]*)<\/\1>\s*\n\s*<\/\1>/g, (_m, tag, outerAttrs, innerAttrs, content) => {
    const attrs = (innerAttrs || outerAttrs).trim();
    return `<${tag}${attrs ? " " + attrs : ""}>${content}</${tag}>`;
  });

  xml = collapseDoubledArgumentsXmlParser(xml);

  xml = fixBareVariableRefsInExpressionAttributes(xml);

  xml = ensureVariableDeclarations(xml);

  xml = xml.replace(/WorkflowFileName="Workflows\\([^"]+)"/g, 'WorkflowFileName="$1"');
  xml = xml.replace(/WorkflowFileName="Workflows\/([^"]+)"/g, 'WorkflowFileName="$1"');
  xml = xml.replace(/WorkflowFileName="([^"]+)"/g, (_match: string, p1: string) => {
    const cleaned = p1.replace(/\\/g, "/").replace(/^[./]+/, "");
    return `WorkflowFileName="${cleaned}"`;
  });


  for (const sysActivity of Array.from(SYSTEM_ACTIVITIES_NO_PREFIX)) {
    const escaped = sysActivity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    xml = xml.replace(new RegExp(`<ui:${escaped}(\\s|>|\\/)`, "g"), `<${sysActivity}$1`);
    xml = xml.replace(new RegExp(`<\\/ui:${escaped}>`, "g"), `</${sysActivity}>`);
    xml = xml.replace(new RegExp(`<ui:${escaped}\\.`, "g"), `<${sysActivity}.`);
    xml = xml.replace(new RegExp(`<\\/ui:${escaped}\\.`, "g"), `</${sysActivity}.`);
  }

  const aliasNormalization = normalizeNamespaceAliases(xml);
  if (aliasNormalization.warnings.length > 0) {
    xml = aliasNormalization.xml;
    for (const warn of aliasNormalization.warnings) {
      console.warn(`[XAML Compliance] Alias normalization: ${warn}`);
    }
  }

  const semanticValidation = validateActivityTagSemantics(xml);
  if (semanticValidation.repairedXml !== xml) {
    console.log(`[XAML Compliance] Auto-repaired activity prefix mismatches`);
    xml = semanticValidation.repairedXml;
  }
  if (semanticValidation.warnings.length > 0) {
    for (const warn of semanticValidation.warnings) {
      console.warn(`[XAML Compliance] Activity tag warning: ${warn}`);
    }
  }
  if (!semanticValidation.valid) {
    for (const err of semanticValidation.errors) {
      console.error(`[XAML Compliance] Activity tag semantic error: ${err}`);
    }
    throw new Error(`XAML activity tag semantic validation failed: ${semanticValidation.errors.join("; ")}`);
  }

  xml = injectDynamicNamespaceDeclarations(xml, isCrossPlatform);

  const nsValidation = validateNamespacePrefixes(xml);
  if (!nsValidation.valid) {
    for (const err of nsValidation.errors) {
      console.error(`[XAML Compliance] Namespace validation: ${err}`);
    }
    const nsMessage = `XAML namespace validation failed: ${nsValidation.errors.join("; ")}`;
    console.warn(`[XAML Compliance] Namespace failure will trigger auto-downgrade path: ${nsMessage}`);
    throw new QualityGateError(nsMessage, {
      passed: false,
      violations: nsValidation.errors.map(e => ({
        check: "namespace-prefix-undeclared",
        severity: "error" as const,
        category: "completeness" as const,
        file: "Main.xaml",
        detail: e,
      })),
      positiveEvidence: [],
      typeRepairs: [],
      completenessLevel: "incomplete" as const,
      readiness: "NEEDS_ATTENTION" as const,
      summary: {
        blockedPatterns: 0,
        completenessErrors: nsValidation.errors.length,
        completenessWarnings: 0,
        accuracyErrors: 0,
        accuracyWarnings: 0,
        runtimeSafetyErrors: 0,
        runtimeSafetyWarnings: 0,
        logicLocationWarnings: 0,
        totalErrors: nsValidation.errors.length,
        totalWarnings: 0,
      },
    });
  }

  xml = normalizeAssignArgumentNesting(xml);

  xml = deduplicateXmlAttributes(xml);

  xml = fillEmptyContainers(xml);

  const xmlValidation = validateXmlWellFormedness(xml);
  if (!xmlValidation.valid) {
    for (const err of xmlValidation.errors) {
      console.error(`[XAML Compliance] XML well-formedness: ${err}`);
    }
    throw new Error(`XAML XML well-formedness validation failed: ${xmlValidation.errors.join("; ")}`);
  }

  return xml;
}

function deduplicateXmlAttributes(xml: string): string {
  let totalDedupCount = 0;
  xml = xml.replace(/<([a-zA-Z_][\w.:]*)((?:\s+[\w.:]+\s*=\s*"[^"]*")+)\s*(\/?>)/g, (match, tagName, attrsBlock, closing) => {
    const attrPattern = /([\w.:]+)\s*=\s*"([^"]*)"/g;
    const seen = new Map<string, string>();
    const order: string[] = [];
    let localDupCount = 0;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attrsBlock)) !== null) {
      const name = attrMatch[1];
      const value = attrMatch[2];
      if (seen.has(name)) {
        localDupCount++;
      } else {
        order.push(name);
      }
      seen.set(name, value);
    }
    if (localDupCount === 0) return match;
    totalDedupCount += localDupCount;
    const rebuiltAttrs = order.map(n => `${n}="${seen.get(n)}"`).join(" ");
    return `<${tagName} ${rebuiltAttrs} ${closing}`.replace(/\s+(\/?>) *$/, ` $1`);
  });
  if (totalDedupCount > 0) {
    console.log(`[XAML Compliance] Deduplicated ${totalDedupCount} duplicate XML attribute(s)`);
  }
  return xml;
}

function fillEmptyContainers(xml: string): string {
  const hasUiNs = /xmlns:ui\s*=/.test(xml);
  const placeholder = hasUiNs
    ? `<ui:LogMessage Level="Warn" Message="[&quot;Placeholder: no activities generated for this container&quot;]" DisplayName="Placeholder — implement logic" />`
    : `<WriteLine Text="Placeholder: no activities generated for this container — implement logic" DisplayName="Placeholder — implement logic" />`;

  xml = xml.replace(
    /(<Sequence\s[^>]*>)\s*(<\/Sequence>)/g,
    (_, open: string, close: string) => `${open}\n      ${placeholder}\n    ${close}`
  );

  xml = xml.replace(
    /(<Sequence\s[^>]*>)\s*(<Sequence\.Variables\s*\/>)\s*(<\/Sequence>)/g,
    (_, open: string, vars: string, close: string) => `${open}\n      ${vars}\n      ${placeholder}\n    ${close}`
  );

  return xml;
}
