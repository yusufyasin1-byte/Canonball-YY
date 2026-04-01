import type { ProcessType } from "./catalog-service";

export interface ActivityPropertyDef {
  name: string;
  direction: "In" | "Out" | "InOut" | "None";
  clrType: string;
  xamlSyntax: "attribute" | "child-element";
  argumentWrapper: string | null;
  typeArguments: string | null;
  required: boolean;
  validValues?: string[];
  default?: string;
}

export interface ActivityDef {
  className: string;
  displayName: string;
  browsable: boolean;
  processTypes: ProcessType[];
  properties: ActivityPropertyDef[];
  propertiesComplete?: boolean;
}

export interface PackageActivityDefs {
  packageId: string;
  activities: ActivityDef[];
}

function prop(
  name: string,
  opts: {
    dir?: "In" | "Out" | "InOut";
    type?: string;
    syntax?: "attribute" | "child-element";
    wrapper?: string | null;
    typeArgs?: string | null;
    required?: boolean;
    validValues?: string[];
    default?: string;
  } = {}
): ActivityPropertyDef {
  return {
    name,
    direction: opts.dir || "In",
    clrType: opts.type || "System.String",
    xamlSyntax: opts.syntax || "attribute",
    argumentWrapper: opts.wrapper ?? null,
    typeArguments: opts.typeArgs ?? null,
    required: opts.required || false,
    ...(opts.validValues ? { validValues: opts.validValues } : {}),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

function childProp(
  name: string,
  opts: {
    dir?: "In" | "Out";
    type?: string;
    wrapper?: string;
    typeArgs?: string;
    required?: boolean;
    validValues?: string[];
  } = {}
): ActivityPropertyDef {
  const dir = opts.dir || "In";
  return {
    name,
    direction: dir,
    clrType: opts.type || "System.String",
    xamlSyntax: "child-element",
    argumentWrapper: opts.wrapper || (dir === "Out" ? "OutArgument" : "InArgument"),
    typeArguments: opts.typeArgs || "x:String",
    required: opts.required || false,
    ...(opts.validValues ? { validValues: opts.validValues } : {}),
  };
}

const COMMON_TIMEOUT = prop("TimeoutMS", { type: "System.Int32", default: "30000" });
const COMMON_CONTINUE_ON_ERROR = prop("ContinueOnError", { type: "System.Boolean", default: "False" });

const PDF_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.PDF.Activities",
  activities: [
    {
      className: "ReadPDFText",
      displayName: "Read PDF Text",
      browsable: true,
      processTypes: ["general", "document-processing", "unattended-ui"],
      properties: [
        prop("FileName", { required: true }),
        prop("Range", { default: "All" }),
        prop("Password"),
        childProp("Text", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ReadPDFWithOCR",
      displayName: "Read PDF with OCR",
      browsable: true,
      processTypes: ["document-processing"],
      properties: [
        prop("FileName", { required: true }),
        prop("Range", { default: "All" }),
        prop("OCREngine", { required: true }),
        prop("Scale", { type: "System.Int32", default: "2" }),
        childProp("Text", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ExtractPDFPageRange",
      displayName: "Extract PDF Page Range",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("InputFilePath", { required: true }),
        prop("OutputFilePath", { required: true }),
        prop("Range", { required: true }),
        prop("Password"),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "MergePDF",
      displayName: "Merge PDF",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        childProp("InputFiles", { type: "System.String[]", wrapper: "InArgument", typeArgs: "scg:List(x:String)", required: true }),
        prop("OutputFilePath", { required: true }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ExportPDFPageAsImage",
      displayName: "Export PDF Page as Image",
      browsable: true,
      processTypes: ["document-processing"],
      properties: [
        prop("FilePath", { required: true }),
        prop("OutputFolderPath", { required: true }),
        prop("PageNumber", { type: "System.Int32", default: "1" }),
        prop("ImageFormat", { validValues: ["PNG", "JPEG", "BMP", "TIFF"], default: "PNG" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "GetPDFPageCount",
      displayName: "Get PDF Page Count",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("FileName", { required: true }),
        prop("Password"),
        childProp("PageCount", { dir: "Out", type: "System.Int32", wrapper: "OutArgument", typeArgs: "x:Int32" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
  ],
};

const WORD_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Word.Activities",
  activities: [
    {
      className: "ReadDocument",
      displayName: "Read Document",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("FilePath", { required: true }),
        childProp("Text", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "WriteDocument",
      displayName: "Write Document",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("FilePath", { required: true }),
        childProp("Text", { required: true }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ReplaceText",
      displayName: "Replace Text in Document",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("FilePath", { required: true }),
        prop("SearchText", { required: true }),
        prop("ReplaceWith", { required: true }),
        prop("ReplaceAll", { type: "System.Boolean", default: "True" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "AppendText",
      displayName: "Append Text",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("FilePath", { required: true }),
        childProp("Text", { required: true }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "InsertPicture",
      displayName: "Insert Picture",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("FilePath", { required: true }),
        prop("ImagePath", { required: true }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ReadTable",
      displayName: "Read Table from Document",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        prop("FilePath", { required: true }),
        prop("TableIndex", { type: "System.Int32", default: "0" }),
        childProp("DataTable", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
  ],
};

const GSUITE_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.GSuite.Activities",
  activities: [
    {
      className: "GoogleSheetsApplicationScope",
      displayName: "Google Sheets Application Scope",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SpreadsheetId", { required: true }),
        prop("ServiceAccountKey"),
        prop("AuthenticationType", { validValues: ["ApiKey", "OAuth2", "ServiceAccount"], default: "ServiceAccount" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "GoogleSheetsReadRange",
      displayName: "Google Sheets Read Range",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SheetName", { required: true }),
        prop("Range", { default: "A1" }),
        prop("IncludeHeaders", { type: "System.Boolean", default: "True" }),
        childProp("DataTable", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
      ],
    },
    {
      className: "GoogleSheetsWriteRange",
      displayName: "Google Sheets Write Range",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SheetName", { required: true }),
        prop("StartingCell", { default: "A1" }),
        childProp("DataTable", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        prop("IncludeHeaders", { type: "System.Boolean", default: "True" }),
      ],
    },
    {
      className: "GoogleSheetsAppendRange",
      displayName: "Google Sheets Append Range",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SheetName", { required: true }),
        childProp("DataTable", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        prop("IncludeHeaders", { type: "System.Boolean", default: "True" }),
      ],
    },
    {
      className: "GoogleDriveUploadFile",
      displayName: "Google Drive Upload File",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("FilePath", { required: true }),
        prop("FolderId"),
        prop("FileName"),
        childProp("FileId", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "GoogleDriveDownloadFile",
      displayName: "Google Drive Download File",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("FileId", { required: true }),
        prop("OutputFolder", { required: true }),
        prop("FileName"),
      ],
    },
    {
      className: "GmailSendMessage",
      displayName: "Send Gmail Message",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("To", { required: true }),
        prop("Subject", { required: true }),
        prop("Body", { required: true }),
        prop("Cc"),
        prop("Bcc"),
        prop("IsBodyHtml", { type: "System.Boolean", default: "False" }),
      ],
    },
    {
      className: "GmailGetMessages",
      displayName: "Get Gmail Messages",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("LabelFilter", { default: "INBOX" }),
        prop("MaxResults", { type: "System.Int32", default: "10" }),
        prop("SearchQuery"),
        childProp("Messages", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
  ],
};

const OFFICE365_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.MicrosoftOffice365.Activities",
  activities: [
    {
      className: "MicrosoftOffice365Scope",
      displayName: "Microsoft Office 365 Scope",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("ApplicationId", { required: true }),
        prop("TenantId", { required: true }),
        prop("AuthenticationType", { validValues: ["ApplicationPermissions", "DelegatedPermissions"], default: "ApplicationPermissions" }),
        childProp("SecretOrCertificate", { required: true }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "SendMail365",
      displayName: "Send Mail (Office 365)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        childProp("Account", { required: true }),
        childProp("To", { required: true }),
        childProp("Subject", { required: true }),
        childProp("Body", { required: true }),
        prop("IsBodyHtml", { type: "System.Boolean", default: "True" }),
        childProp("Cc"),
        childProp("Bcc"),
      ],
    },
    {
      className: "GetMail365",
      displayName: "Get Mail (Office 365)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        childProp("Account", { required: true }),
        prop("Top", { type: "System.Int32", default: "30" }),
        prop("MailFolder", { default: "Inbox" }),
        prop("OnlyUnread", { type: "System.Boolean", default: "True" }),
        childProp("Messages", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "CreateEvent365",
      displayName: "Create Calendar Event",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        childProp("Account", { required: true }),
        childProp("Subject", { required: true }),
        childProp("Body"),
        childProp("Start", { type: "System.DateTime", wrapper: "InArgument", typeArgs: "s:DateTime", required: true }),
        childProp("End", { type: "System.DateTime", wrapper: "InArgument", typeArgs: "s:DateTime", required: true }),
        childProp("Attendees"),
      ],
    },
    {
      className: "ExcelCreateSpreadsheet",
      displayName: "Create Spreadsheet (OneDrive)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        childProp("Name", { required: true }),
        prop("DriveId"),
        prop("FolderPath"),
        childProp("SpreadsheetId", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "ExcelReadRange365",
      displayName: "Read Range (Excel Online)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SpreadsheetId", { required: true }),
        prop("SheetName", { required: true }),
        prop("Range", { default: "A1" }),
        prop("HasHeaders", { type: "System.Boolean", default: "True" }),
        childProp("DataTable", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
      ],
    },
    {
      className: "ExcelWriteRange365",
      displayName: "Write Range (Excel Online)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SpreadsheetId", { required: true }),
        prop("SheetName", { required: true }),
        prop("StartingCell", { default: "A1" }),
        childProp("DataTable", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
      ],
    },
    {
      className: "SharePointUploadFile",
      displayName: "Upload File (SharePoint)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SiteUrl", { required: true }),
        prop("FolderPath", { required: true }),
        prop("LocalFilePath", { required: true }),
        prop("FileName"),
        childProp("FileUrl", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "SharePointDownloadFile",
      displayName: "Download File (SharePoint)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("SiteUrl", { required: true }),
        prop("FilePath", { required: true }),
        prop("LocalFolderPath", { required: true }),
      ],
    },
  ],
};

const PERSISTENCE_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Persistence.Activities",
  activities: [
    {
      className: "CreateFormTask",
      displayName: "Create Form Task",
      browsable: true,
      processTypes: ["general", "orchestration"],
      properties: [
        prop("TaskCatalog"),
        prop("TaskTitle"),
        prop("TaskPriority", { validValues: ["Low", "Normal", "High"], default: "Normal" }),
        childProp("TaskObject"),
        childProp("TaskData"),
      ],
    },
    {
      className: "WaitForFormTaskAndResume",
      displayName: "Wait For Form Task And Resume",
      browsable: true,
      processTypes: ["general", "orchestration"],
      properties: [
        childProp("TaskObject"),
        childProp("TaskAction", { dir: "Out" }),
        childProp("TaskOutput", { dir: "Out" }),
      ],
    },
  ],
};

const TESTING_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Testing.Activities",
  activities: [
    {
      className: "VerifyExpression",
      displayName: "Verify Expression",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Expression", { type: "System.Boolean", wrapper: "InArgument", typeArgs: "x:Boolean", required: true }),
        prop("OutputMessage"),
        prop("AlternativeVerification", { type: "System.Boolean", default: "False" }),
      ],
    },
    {
      className: "VerifyRange",
      displayName: "Verify Range",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("ExpressionValue", { type: "System.Double", wrapper: "InArgument", typeArgs: "x:Double", required: true }),
        prop("MinValue", { type: "System.Double", required: true }),
        prop("MaxValue", { type: "System.Double", required: true }),
        prop("OutputMessage"),
      ],
    },
    {
      className: "VerifyControlAttribute",
      displayName: "Verify Control Attribute",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      properties: [
        prop("AttributeName", { required: true }),
        childProp("AttributeValue", { required: true }),
        prop("Selector", { required: true }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "LogAssert",
      displayName: "Log Assert",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Expression", { type: "System.Boolean", wrapper: "InArgument", typeArgs: "x:Boolean", required: true }),
        prop("OutputMessage"),
      ],
    },
    {
      className: "GivenName",
      displayName: "Given Name",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("DisplayName", { required: true }),
      ],
    },
    {
      className: "WhenName",
      displayName: "When Name",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("DisplayName", { required: true }),
      ],
    },
    {
      className: "ThenName",
      displayName: "Then Name",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("DisplayName", { required: true }),
      ],
    },
    {
      className: "AddTestDataQueueItem",
      displayName: "Add Test Data Queue Item",
      browsable: true,
      processTypes: ["general", "orchestration"],
      properties: [
        prop("QueueName", { required: true }),
        childProp("QueueItemData", { type: "System.String", required: true }),
      ],
    },
  ],
};

const FORM_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Form.Activities",
  activities: [
    {
      className: "CreateForm",
      displayName: "Create Form",
      browsable: true,
      processTypes: ["attended-ui"],
      properties: [
        prop("FormSchemaPath", { required: true }),
        childProp("FormOutput", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
        prop("AllowMultipleSubmissions", { type: "System.Boolean", default: "False" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "ShowForm",
      displayName: "Show Form",
      browsable: true,
      processTypes: ["attended-ui"],
      properties: [
        prop("FormSchemaPath", { required: true }),
        childProp("FormFieldValues", { type: "System.Collections.Generic.Dictionary", wrapper: "InArgument", typeArgs: "scg:Dictionary(x:String,x:Object)" }),
        childProp("FormOutput", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "CalloutActivities",
      displayName: "Callout",
      browsable: true,
      processTypes: ["attended-ui"],
      properties: [
        prop("Title", { required: true }),
        prop("Message"),
        prop("Position", { validValues: ["TopLeft", "TopRight", "BottomLeft", "BottomRight", "Center"], default: "BottomRight" }),
        prop("Duration", { type: "System.Int32", default: "5000" }),
      ],
    },
  ],
};

const CRYPTOGRAPHY_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Cryptography.Activities",
  activities: [
    {
      className: "EncryptText",
      displayName: "Encrypt Text",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { required: true }),
        childProp("Key", { required: true }),
        prop("Algorithm", { validValues: ["AES", "DES", "RC2", "Rijndael", "TripleDES"], default: "AES", required: true }),
        prop("Encoding", { validValues: ["UTF-8", "Unicode", "ASCII", "UTF-32"], default: "UTF-8" }),
        childProp("Result", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "DecryptText",
      displayName: "Decrypt Text",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { required: true }),
        childProp("Key", { required: true }),
        prop("Algorithm", { validValues: ["AES", "DES", "RC2", "Rijndael", "TripleDES"], default: "AES", required: true }),
        prop("Encoding", { validValues: ["UTF-8", "Unicode", "ASCII", "UTF-32"], default: "UTF-8" }),
        childProp("Result", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "EncryptFile",
      displayName: "Encrypt File",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("InputFilePath", { required: true }),
        prop("OutputFilePath", { required: true }),
        childProp("Key", { required: true }),
        prop("Algorithm", { validValues: ["AES", "DES", "RC2", "Rijndael", "TripleDES"], default: "AES" }),
      ],
    },
    {
      className: "DecryptFile",
      displayName: "Decrypt File",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("InputFilePath", { required: true }),
        prop("OutputFilePath", { required: true }),
        childProp("Key", { required: true }),
        prop("Algorithm", { validValues: ["AES", "DES", "RC2", "Rijndael", "TripleDES"], default: "AES" }),
      ],
    },
    {
      className: "HashText",
      displayName: "Hash Text",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { required: true }),
        prop("Algorithm", { validValues: ["SHA256", "SHA384", "SHA512", "MD5", "SHA1", "RIPEMD160"], default: "SHA256", required: true }),
        prop("Encoding", { validValues: ["UTF-8", "Unicode", "ASCII", "UTF-32"], default: "UTF-8" }),
        childProp("Result", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "HashFile",
      displayName: "Hash File",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("InputFilePath", { required: true }),
        prop("Algorithm", { validValues: ["SHA256", "SHA384", "SHA512", "MD5", "SHA1", "RIPEMD160"], default: "SHA256", required: true }),
        childProp("Result", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "KeyedHashText",
      displayName: "Keyed Hash Text",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { required: true }),
        childProp("Key", { required: true }),
        prop("Algorithm", { validValues: ["HMACSHA256", "HMACSHA384", "HMACSHA512", "HMACMD5", "HMACSHA1"], default: "HMACSHA256" }),
        prop("Encoding", { validValues: ["UTF-8", "Unicode", "ASCII", "UTF-32"], default: "UTF-8" }),
        childProp("Result", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
  ],
};

const WEBAPI_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.WebAPI.Activities",
  activities: [
    {
      className: "HttpClientRequest",
      displayName: "HTTP Client Request",
      browsable: true,
      processTypes: ["api-integration", "general"],
      properties: [
        childProp("EndPoint", { required: true }),
        prop("Method", { validValues: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"], default: "GET", required: true }),
        prop("AcceptFormat", { validValues: ["JSON", "XML", "ANY"], default: "JSON" }),
        prop("BodyFormat", { validValues: ["application/json", "application/xml", "text/plain", "multipart/form-data"], default: "application/json" }),
        childProp("Body"),
        childProp("Headers", { type: "System.Collections.Generic.Dictionary", wrapper: "InArgument", typeArgs: "scg:Dictionary(x:String,x:String)" }),
        childProp("ResponseContent", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        childProp("ResponseStatus", { dir: "Out", type: "System.Int32", wrapper: "OutArgument", typeArgs: "x:Int32" }),
        childProp("ResponseHeaders", { dir: "Out", type: "System.Collections.Generic.Dictionary", wrapper: "OutArgument", typeArgs: "scg:Dictionary(x:String,x:String)" }),
        COMMON_TIMEOUT,
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "DownloadFile",
      displayName: "Download File from URL",
      browsable: true,
      processTypes: ["api-integration", "general"],
      properties: [
        childProp("URL", { required: true }),
        prop("LocalPath", { required: true }),
        prop("Overwrite", { type: "System.Boolean", default: "True" }),
        COMMON_TIMEOUT,
      ],
    },
  ],
};

const COMPLEX_SCENARIOS_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.ComplexScenarios.Activities",
  activities: [
    {
      className: "MultipleAssign",
      displayName: "Multiple Assign",
      browsable: true,
      processTypes: ["general"],
      properties: [],
    },
    {
      className: "WaitForDownload",
      displayName: "Wait for Download",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      properties: [
        prop("DownloadPath", { required: true }),
        prop("TimeoutMS", { type: "System.Int32", default: "30000" }),
        childProp("FileName", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "RepeatUntil",
      displayName: "Repeat Until",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Condition", { type: "System.Boolean", wrapper: "InArgument", typeArgs: "x:Boolean", required: true }),
        prop("MaxIterations", { type: "System.Int32", default: "100" }),
      ],
    },
    {
      className: "BuildDataTable",
      displayName: "Build Data Table",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("DataTable", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
        prop("TableInfo"),
      ],
    },
    {
      className: "FilterDataTable",
      displayName: "Filter Data Table",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("Output", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
        prop("SelectionMode", { validValues: ["Keep", "Remove"], default: "Keep" }),
      ],
    },
    {
      className: "SortDataTable",
      displayName: "Sort Data Table",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("Output", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
        prop("ColumnName", { required: true }),
        prop("Order", { validValues: ["Ascending", "Descending"], default: "Ascending" }),
      ],
    },
    {
      className: "RemoveDuplicateRows",
      displayName: "Remove Duplicate Rows",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("Output", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
      ],
    },
    {
      className: "JoinDataTables",
      displayName: "Join Data Tables",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("DataTable1", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("DataTable2", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("Output", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
        prop("JoinType", { validValues: ["Inner", "Left", "Full"], default: "Inner" }),
      ],
    },
    {
      className: "OutputDataTable",
      displayName: "Output Data Table",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Input", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("Text", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "AddDataRow",
      displayName: "Add Data Row",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("DataTable", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("ArrayRow", { type: "System.Object[]", wrapper: "InArgument", typeArgs: "scg:List(x:Object)" }),
        childProp("DataRow", { type: "System.Data.DataRow", wrapper: "InArgument", typeArgs: "scg2:DataRow" }),
      ],
    },
    {
      className: "RemoveDataRow",
      displayName: "Remove Data Row",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("DataRow", { type: "System.Data.DataRow", wrapper: "InArgument", typeArgs: "scg2:DataRow", required: true }),
      ],
    },
    {
      className: "LookupDataTable",
      displayName: "Lookup Data Table",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("DataTable", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("LookupValue", { required: true }),
        prop("LookupColumnName", { required: true }),
        prop("TargetColumnName"),
        childProp("CellValue", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        childProp("RowIndex", { dir: "Out", type: "System.Int32", wrapper: "OutArgument", typeArgs: "x:Int32" }),
      ],
    },
  ],
};

const AMAZON_S3_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.AmazonWebServices.Activities",
  activities: [
    {
      className: "AmazonScope",
      displayName: "Amazon Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("AccessKey", { required: true }),
        childProp("SecretKey", { required: true }),
        prop("Region", { required: true }),
        prop("UseSessionToken", { type: "System.Boolean", default: "False" }),
        childProp("SessionToken"),
      ],
    },
    {
      className: "S3UploadFile",
      displayName: "S3 Upload File",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("BucketName", { required: true }),
        prop("LocalFilePath", { required: true }),
        prop("Key", { required: true }),
        prop("ContentType"),
      ],
    },
    {
      className: "S3DownloadFile",
      displayName: "S3 Download File",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("BucketName", { required: true }),
        prop("Key", { required: true }),
        prop("LocalFilePath", { required: true }),
      ],
    },
    {
      className: "S3DeleteObject",
      displayName: "S3 Delete Object",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("BucketName", { required: true }),
        prop("Key", { required: true }),
      ],
    },
    {
      className: "S3ListObjects",
      displayName: "S3 List Objects",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("BucketName", { required: true }),
        prop("Prefix"),
        prop("MaxKeys", { type: "System.Int32", default: "1000" }),
        childProp("Objects", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
  ],
};

const AMAZON_TEXTRACT_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Amazon.Textract.Activities",
  activities: [
    {
      className: "TextractAnalyzeDocument",
      displayName: "Textract Analyze Document",
      browsable: true,
      processTypes: ["document-processing", "api-integration"],
      properties: [
        prop("FilePath", { required: true }),
        prop("FeatureTypes", { validValues: ["TABLES", "FORMS", "QUERIES", "SIGNATURES"], required: true }),
        childProp("Result", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "TextractDetectText",
      displayName: "Textract Detect Text",
      browsable: true,
      processTypes: ["document-processing", "api-integration"],
      properties: [
        prop("FilePath", { required: true }),
        childProp("DetectedText", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        COMMON_TIMEOUT,
      ],
    },
  ],
};

const AMAZON_COMPREHEND_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Amazon.Comprehend.Activities",
  activities: [
    {
      className: "ComprehendDetectSentiment",
      displayName: "Detect Sentiment",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Text", { required: true }),
        prop("LanguageCode", { default: "en", validValues: ["en", "es", "fr", "de", "it", "pt", "ar", "hi", "ja", "ko", "zh", "zh-TW"] }),
        childProp("Sentiment", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        childProp("SentimentScore", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "ComprehendDetectEntities",
      displayName: "Detect Entities",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Text", { required: true }),
        prop("LanguageCode", { default: "en" }),
        childProp("Entities", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "ComprehendDetectKeyPhrases",
      displayName: "Detect Key Phrases",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Text", { required: true }),
        prop("LanguageCode", { default: "en" }),
        childProp("KeyPhrases", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "ComprehendDetectLanguage",
      displayName: "Detect Language",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Text", { required: true }),
        childProp("DetectedLanguage", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
  ],
};

const AMAZON_REKOGNITION_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Amazon.Rekognition.Activities",
  activities: [
    {
      className: "RekognitionDetectLabels",
      displayName: "Detect Labels",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ImageFilePath", { required: true }),
        prop("MaxLabels", { type: "System.Int32", default: "10" }),
        prop("MinConfidence", { type: "System.Double", default: "70" }),
        childProp("Labels", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "RekognitionDetectText",
      displayName: "Detect Text in Image",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ImageFilePath", { required: true }),
        childProp("DetectedText", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "RekognitionDetectFaces",
      displayName: "Detect Faces",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ImageFilePath", { required: true }),
        childProp("FaceDetails", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
  ],
};

const AZURE_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Azure.Activities",
  activities: [
    {
      className: "AzureScope",
      displayName: "Azure Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("ClientId", { required: true }),
        childProp("ClientSecret", { required: true }),
        childProp("TenantId", { required: true }),
        prop("SubscriptionId"),
      ],
    },
    {
      className: "AzureBlobUpload",
      displayName: "Upload Blob",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ContainerName", { required: true }),
        prop("BlobName", { required: true }),
        prop("LocalFilePath", { required: true }),
        prop("ContentType"),
        prop("Overwrite", { type: "System.Boolean", default: "True" }),
      ],
    },
    {
      className: "AzureBlobDownload",
      displayName: "Download Blob",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ContainerName", { required: true }),
        prop("BlobName", { required: true }),
        prop("LocalFilePath", { required: true }),
      ],
    },
    {
      className: "AzureBlobDelete",
      displayName: "Delete Blob",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ContainerName", { required: true }),
        prop("BlobName", { required: true }),
      ],
    },
    {
      className: "AzureBlobList",
      displayName: "List Blobs",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ContainerName", { required: true }),
        prop("Prefix"),
        childProp("Blobs", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
  ],
};

const AZURE_FORM_RECOGNIZER_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.AzureFormRecognizerV3.Activities",
  activities: [
    {
      className: "FormRecognizerAnalyze",
      displayName: "Analyze Form",
      browsable: true,
      processTypes: ["document-processing", "api-integration"],
      properties: [
        prop("FilePath", { required: true }),
        prop("ModelId", { required: true }),
        childProp("Endpoint", { required: true }),
        childProp("ApiKey", { required: true }),
        childProp("Result", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "FormRecognizerAnalyzeLayout",
      displayName: "Analyze Layout",
      browsable: true,
      processTypes: ["document-processing", "api-integration"],
      properties: [
        prop("FilePath", { required: true }),
        childProp("Endpoint", { required: true }),
        childProp("ApiKey", { required: true }),
        childProp("Result", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
        COMMON_TIMEOUT,
      ],
    },
  ],
};

const GOOGLE_CLOUD_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.GoogleCloud.Activities",
  activities: [
    {
      className: "GoogleCloudScope",
      displayName: "Google Cloud Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ServiceAccountKeyPath", { required: true }),
        prop("ProjectId", { required: true }),
      ],
    },
    {
      className: "GoogleCloudStorageUpload",
      displayName: "Upload to Cloud Storage",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("BucketName", { required: true }),
        prop("LocalFilePath", { required: true }),
        prop("ObjectName", { required: true }),
        prop("ContentType"),
      ],
    },
    {
      className: "GoogleCloudStorageDownload",
      displayName: "Download from Cloud Storage",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("BucketName", { required: true }),
        prop("ObjectName", { required: true }),
        prop("LocalFilePath", { required: true }),
      ],
    },
    {
      className: "GoogleCloudTranslateText",
      displayName: "Translate Text",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Text", { required: true }),
        prop("TargetLanguage", { required: true }),
        prop("SourceLanguage"),
        childProp("TranslatedText", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "GoogleCloudNLPAnalyzeSentiment",
      displayName: "Analyze Sentiment",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Text", { required: true }),
        childProp("Score", { dir: "Out", type: "System.Double", wrapper: "OutArgument", typeArgs: "x:Double" }),
        childProp("Magnitude", { dir: "Out", type: "System.Double", wrapper: "OutArgument", typeArgs: "x:Double" }),
      ],
    },
  ],
};

const GOOGLE_VISION_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.GoogleVision.Activities",
  activities: [
    {
      className: "GoogleVisionOCR",
      displayName: "Google Vision OCR",
      browsable: true,
      processTypes: ["document-processing", "api-integration"],
      properties: [
        prop("ImagePath", { required: true }),
        prop("ApiKey"),
        prop("LanguageHints"),
        childProp("DetectedText", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "GoogleVisionLabelDetection",
      displayName: "Label Detection",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ImagePath", { required: true }),
        prop("MaxResults", { type: "System.Int32", default: "10" }),
        childProp("Labels", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
  ],
};

const SALESFORCE_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Salesforce.Activities",
  activities: [
    {
      className: "SalesforceApplicationScope",
      displayName: "Salesforce Application Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("ConsumerKey", { required: true }),
        childProp("ConsumerSecret", { required: true }),
        childProp("Username", { required: true }),
        childProp("Password", { required: true }),
        prop("SecurityToken"),
        prop("LoginUrl", { default: "https://login.salesforce.com" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "SalesforceGetRecords",
      displayName: "Get Records",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ObjectType", { required: true }),
        prop("SOQLQuery"),
        prop("MaxRecords", { type: "System.Int32", default: "200" }),
        childProp("Records", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
      ],
    },
    {
      className: "SalesforceInsertRecords",
      displayName: "Insert Records",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ObjectType", { required: true }),
        childProp("Records", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("Result", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "SalesforceUpdateRecords",
      displayName: "Update Records",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ObjectType", { required: true }),
        childProp("Records", { type: "System.Data.DataTable", wrapper: "InArgument", typeArgs: "scg2:DataTable", required: true }),
        childProp("Result", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "SalesforceDeleteRecords",
      displayName: "Delete Records",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ObjectType", { required: true }),
        childProp("RecordIds", { type: "System.Collections.Generic.List", wrapper: "InArgument", typeArgs: "scg:List(x:String)", required: true }),
        childProp("Result", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "SalesforceSOQLQuery",
      displayName: "SOQL Query",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Query", { required: true }),
        childProp("Result", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
      ],
    },
  ],
};

const SERVICENOW_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.ServiceNow.Activities",
  activities: [
    {
      className: "ServiceNowApplicationScope",
      displayName: "ServiceNow Application Scope",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        childProp("InstanceUrl", { required: true }),
        childProp("Username", { required: true }),
        childProp("Password", { required: true }),
        prop("AuthenticationType", { validValues: ["Basic", "OAuth2"], default: "Basic" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "ServiceNowGetRecords",
      displayName: "Get Records",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("TableName", { required: true }),
        prop("Query"),
        prop("Limit", { type: "System.Int32", default: "100" }),
        childProp("Records", { dir: "Out", type: "System.Data.DataTable", wrapper: "OutArgument", typeArgs: "scg2:DataTable" }),
      ],
    },
    {
      className: "ServiceNowCreateRecord",
      displayName: "Create Record",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("TableName", { required: true }),
        childProp("Fields", { type: "System.Collections.Generic.Dictionary", wrapper: "InArgument", typeArgs: "scg:Dictionary(x:String,x:String)", required: true }),
        childProp("SysId", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "ServiceNowUpdateRecord",
      displayName: "Update Record",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("TableName", { required: true }),
        prop("SysId", { required: true }),
        childProp("Fields", { type: "System.Collections.Generic.Dictionary", wrapper: "InArgument", typeArgs: "scg:Dictionary(x:String,x:String)", required: true }),
      ],
    },
    {
      className: "ServiceNowDeleteRecord",
      displayName: "Delete Record",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("TableName", { required: true }),
        prop("SysId", { required: true }),
      ],
    },
  ],
};

const SLACK_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Slack.Activities",
  activities: [
    {
      className: "SlackScope",
      displayName: "Slack Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Token", { required: true }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "SlackSendMessage",
      displayName: "Send Slack Message",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("Channel", { required: true }),
        childProp("Message", { required: true }),
        prop("AsUser", { type: "System.Boolean", default: "False" }),
        childProp("MessageTimestamp", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "SlackGetMessages",
      displayName: "Get Slack Messages",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("Channel", { required: true }),
        prop("Limit", { type: "System.Int32", default: "100" }),
        childProp("Messages", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "SlackUploadFile",
      displayName: "Upload File to Slack",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("Channel", { required: true }),
        prop("FilePath", { required: true }),
        prop("Title"),
        prop("InitialComment"),
      ],
    },
  ],
};

const JIRA_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Jira.Activities",
  activities: [
    {
      className: "JiraScope",
      displayName: "Jira Scope",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        childProp("ServerUrl", { required: true }),
        childProp("Email", { required: true }),
        childProp("ApiToken", { required: true }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "JiraCreateIssue",
      displayName: "Create Jira Issue",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("ProjectKey", { required: true }),
        prop("IssueType", { required: true, validValues: ["Bug", "Task", "Story", "Epic", "Subtask"] }),
        childProp("Summary", { required: true }),
        childProp("Description"),
        prop("Priority", { validValues: ["Highest", "High", "Medium", "Low", "Lowest"] }),
        prop("Assignee"),
        childProp("IssueKey", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "JiraGetIssue",
      displayName: "Get Jira Issue",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("IssueKey", { required: true }),
        childProp("Issue", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "JiraUpdateIssue",
      displayName: "Update Jira Issue",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("IssueKey", { required: true }),
        childProp("Summary"),
        childProp("Description"),
        prop("Status"),
        prop("Assignee"),
      ],
    },
    {
      className: "JiraSearchIssues",
      displayName: "Search Jira Issues",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        childProp("JQL", { required: true }),
        prop("MaxResults", { type: "System.Int32", default: "50" }),
        childProp("Issues", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "JiraAddComment",
      displayName: "Add Comment to Jira Issue",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("IssueKey", { required: true }),
        childProp("Comment", { required: true }),
      ],
    },
  ],
};

const TEAMS_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.MicrosoftTeams.Activities",
  activities: [
    {
      className: "TeamsScope",
      displayName: "Microsoft Teams Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("ApplicationId", { required: true }),
        childProp("TenantId", { required: true }),
        childProp("SecretOrCertificate", { required: true }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "TeamsSendMessage",
      displayName: "Send Teams Message",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("TeamId", { required: true }),
        prop("ChannelId", { required: true }),
        childProp("Message", { required: true }),
        prop("ContentType", { validValues: ["text", "html"], default: "text" }),
      ],
    },
    {
      className: "TeamsGetMessages",
      displayName: "Get Teams Messages",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("TeamId", { required: true }),
        prop("ChannelId", { required: true }),
        prop("Top", { type: "System.Int32", default: "20" }),
        childProp("Messages", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "TeamsSendChatMessage",
      displayName: "Send Chat Message",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ChatId", { required: true }),
        childProp("Message", { required: true }),
      ],
    },
  ],
};

const FTP_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.FTP.Activities",
  activities: [
    {
      className: "FTPScope",
      displayName: "FTP Scope (With FTP Session)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("Host", { required: true }),
        prop("Port", { type: "System.Int32", default: "21" }),
        prop("Username"),
        childProp("Password"),
        prop("UseSFTP", { type: "System.Boolean", default: "False" }),
        prop("UseAnonymousLogin", { type: "System.Boolean", default: "False" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "FTPUpload",
      displayName: "Upload File (FTP)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("LocalPath", { required: true }),
        prop("RemotePath", { required: true }),
        prop("Overwrite", { type: "System.Boolean", default: "True" }),
        prop("CreateFolder", { type: "System.Boolean", default: "False" }),
      ],
    },
    {
      className: "FTPDownload",
      displayName: "Download File (FTP)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("RemotePath", { required: true }),
        prop("LocalPath", { required: true }),
        prop("Overwrite", { type: "System.Boolean", default: "True" }),
      ],
    },
    {
      className: "FTPDelete",
      displayName: "Delete File (FTP)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("RemotePath", { required: true }),
      ],
    },
    {
      className: "FTPListFiles",
      displayName: "List Files (FTP)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("RemotePath"),
        childProp("Files", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
    {
      className: "FTPDirectoryExists",
      displayName: "Directory Exists (FTP)",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("RemotePath", { required: true }),
        childProp("Exists", { dir: "Out", type: "System.Boolean", wrapper: "OutArgument", typeArgs: "x:Boolean" }),
      ],
    },
  ],
};

const PRESENTATIONS_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Presentations.Activities",
  activities: [
    {
      className: "PresentationsApplicationScope",
      displayName: "Presentations Application Scope",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("PresentationPath", { required: true }),
        prop("CreateIfNotExists", { type: "System.Boolean", default: "False" }),
      ],
    },
    {
      className: "AddSlide",
      displayName: "Add Slide",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("LayoutIndex", { type: "System.Int32", default: "0" }),
      ],
    },
    {
      className: "SetText",
      displayName: "Set Text in Slide",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("SlideIndex", { type: "System.Int32", required: true }),
        prop("ShapeName", { required: true }),
        childProp("Text", { required: true }),
      ],
    },
    {
      className: "ExportSlideAsImage",
      displayName: "Export Slide as Image",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("SlideIndex", { type: "System.Int32", required: true }),
        prop("OutputPath", { required: true }),
        prop("ImageFormat", { validValues: ["PNG", "JPEG", "BMP"], default: "PNG" }),
      ],
    },
    {
      className: "ReplaceTextInSlide",
      displayName: "Replace Text in Slide",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("SlideIndex", { type: "System.Int32" }),
        prop("SearchText", { required: true }),
        prop("ReplaceWith", { required: true }),
        prop("ReplaceAll", { type: "System.Boolean", default: "True" }),
      ],
    },
  ],
};

const CREDENTIALS_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Credentials.Activities",
  activities: [
    {
      className: "GetSecureCredential",
      displayName: "Get Secure Credential",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("Target", { required: true }),
        prop("CredentialType", { validValues: ["Generic", "Windows"], default: "Generic" }),
        childProp("Username", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        childProp("Password", { dir: "Out", type: "System.Security.SecureString", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "AddCredential",
      displayName: "Add Credential",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("Target", { required: true }),
        childProp("Username", { required: true }),
        childProp("Password", { type: "System.Security.SecureString", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        prop("CredentialType", { validValues: ["Generic", "Windows"], default: "Generic" }),
        prop("Persistence", { validValues: ["Enterprise", "LocalMachine", "Session"], default: "Enterprise" }),
      ],
    },
    {
      className: "DeleteCredential",
      displayName: "Delete Credential",
      browsable: true,
      processTypes: ["general"],
      properties: [
        prop("Target", { required: true }),
        prop("CredentialType", { validValues: ["Generic", "Windows"], default: "Generic" }),
      ],
    },
    {
      className: "RequestCredential",
      displayName: "Request Credential",
      browsable: true,
      processTypes: ["attended-ui"],
      properties: [
        prop("Title"),
        childProp("Username", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        childProp("Password", { dir: "Out", type: "System.Security.SecureString", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
  ],
};

const DOCUMENT_UNDERSTANDING_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.DocumentUnderstanding.Activities",
  activities: [
    {
      className: "TaxonomyManager",
      displayName: "Taxonomy Manager",
      browsable: true,
      processTypes: ["document-processing"],
      properties: [
        prop("TaxonomyFilePath", { required: true }),
        childProp("Taxonomy", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "DigitizeScope",
      displayName: "Digitize Scope",
      browsable: true,
      processTypes: ["document-processing"],
      properties: [
        childProp("Document", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object", required: true }),
        prop("FilePath", { required: true }),
      ],
    },
    {
      className: "ClassifyDocumentScope",
      displayName: "Classify Document Scope",
      browsable: true,
      processTypes: ["document-processing"],
      properties: [
        childProp("Document", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        childProp("Taxonomy", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        childProp("ClassificationResults", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "ExtractDocumentDataScope",
      displayName: "Extract Document Data Scope",
      browsable: true,
      processTypes: ["document-processing"],
      properties: [
        childProp("Document", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        childProp("Taxonomy", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        childProp("ExtractionResults", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "ValidationStation",
      displayName: "Validation Station",
      browsable: true,
      processTypes: ["document-processing", "attended-ui"],
      properties: [
        childProp("Document", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        childProp("ExtractionResults", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        childProp("Taxonomy", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        childProp("ValidatedExtractionResults", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "ExportExtractionResults",
      displayName: "Export Extraction Results",
      browsable: true,
      processTypes: ["document-processing"],
      properties: [
        childProp("ExtractionResults", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
        prop("OutputFolderPath", { required: true }),
        prop("ExportFormat", { validValues: ["JSON", "CSV", "Excel"], default: "JSON" }),
      ],
    },
  ],
};

const GENAI_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.GenAI.Activities",
  activities: [
    {
      className: "UseGenAI",
      displayName: "Use GenAI",
      browsable: true,
      processTypes: ["general", "api-integration"],
      properties: [
        prop("ModelName", { required: true }),
        childProp("Prompt", { required: true }),
        childProp("SystemPrompt"),
        prop("MaxTokens", { type: "System.Int32", default: "4096" }),
        prop("Temperature", { type: "System.Double", default: "0.7" }),
        childProp("Response", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "ExtractData",
      displayName: "Extract Data with AI",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        childProp("Text", { required: true }),
        childProp("ExtractionSchema", { required: true }),
        childProp("Result", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "ClassifyText",
      displayName: "Classify Text with AI",
      browsable: true,
      processTypes: ["general"],
      properties: [
        childProp("Text", { required: true }),
        childProp("Categories", { required: true }),
        childProp("Result", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "SummarizeText",
      displayName: "Summarize Text with AI",
      browsable: true,
      processTypes: ["general", "document-processing"],
      properties: [
        childProp("Text", { required: true }),
        prop("MaxLength", { type: "System.Int32" }),
        childProp("Summary", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
  ],
};

const INTEGRATION_SERVICE_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.IntegrationService.Activities",
  activities: [
    {
      className: "IntegrationServiceScope",
      displayName: "Integration Service Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ConnectionId", { required: true }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "IntegrationServiceHTTPRequest",
      displayName: "Integration Service HTTP Request",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("Endpoint", { required: true }),
        prop("Method", { validValues: ["GET", "POST", "PUT", "DELETE", "PATCH"], default: "GET", required: true }),
        childProp("Body"),
        childProp("ResponseContent", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        childProp("StatusCode", { dir: "Out", type: "System.Int32", wrapper: "OutArgument", typeArgs: "x:Int32" }),
      ],
    },
    {
      className: "IntegrationServiceTrigger",
      displayName: "Integration Service Trigger",
      browsable: true,
      processTypes: ["api-integration", "orchestration"],
      properties: [
        prop("ConnectionId", { required: true }),
        prop("EventType", { required: true }),
      ],
    },
  ],
};

const COMMUNICATIONS_MINING_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.CommunicationsMining.Activities",
  activities: [
    {
      className: "CommunicationsMiningScope",
      displayName: "Communications Mining Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("ApiKey", { required: true }),
        childProp("ApiUrl", { required: true }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "AnalyzeMessage",
      displayName: "Analyze Message",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("ModelName", { required: true }),
        childProp("Message", { required: true }),
        childProp("Predictions", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object" }),
      ],
    },
    {
      className: "UploadCommunications",
      displayName: "Upload Communications",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("DatasetName", { required: true }),
        childProp("Communications", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
      ],
    },
  ],
};

const WORKFLOW_EVENTS_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.WorkflowEvents.Activities",
  activities: [
    {
      className: "RaiseAlert",
      displayName: "Raise Alert",
      browsable: true,
      processTypes: ["general", "orchestration"],
      properties: [
        prop("Severity", { validValues: ["Info", "Warn", "Error", "Fatal"], default: "Info", required: true }),
        childProp("Message", { required: true }),
        prop("Component"),
      ],
    },
    {
      className: "TriggerJob",
      displayName: "Trigger Job",
      browsable: true,
      processTypes: ["orchestration"],
      properties: [
        prop("ProcessName", { required: true }),
        prop("FolderPath"),
        prop("Strategy", { validValues: ["ModernJobsCount", "Specific", "JobsCount", "RobotGroupJobsCount"], default: "ModernJobsCount" }),
        prop("JobsCount", { type: "System.Int32", default: "1" }),
        childProp("InputArguments", { type: "System.Collections.Generic.Dictionary", wrapper: "InArgument", typeArgs: "scg:Dictionary(x:String,x:Object)" }),
      ],
    },
  ],
};

const BOX_ACTIVITIES: PackageActivityDefs = {
  packageId: "UiPath.Box.Activities",
  activities: [
    {
      className: "BoxScope",
      displayName: "Box Scope",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        childProp("ClientId", { required: true }),
        childProp("ClientSecret", { required: true }),
        prop("AuthenticationType", { validValues: ["OAuth2", "JWT"], default: "OAuth2" }),
        COMMON_TIMEOUT,
      ],
    },
    {
      className: "BoxUploadFile",
      displayName: "Upload File (Box)",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("LocalFilePath", { required: true }),
        prop("FolderId", { required: true, default: "0" }),
        prop("FileName"),
        childProp("FileId", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
      ],
    },
    {
      className: "BoxDownloadFile",
      displayName: "Download File (Box)",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("FileId", { required: true }),
        prop("LocalFolderPath", { required: true }),
      ],
    },
    {
      className: "BoxDeleteFile",
      displayName: "Delete File (Box)",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("FileId", { required: true }),
      ],
    },
    {
      className: "BoxSearchFiles",
      displayName: "Search Files (Box)",
      browsable: true,
      processTypes: ["api-integration"],
      properties: [
        prop("Query", { required: true }),
        prop("FolderScope"),
        childProp("Results", { dir: "Out", type: "System.Collections.Generic.List", wrapper: "OutArgument", typeArgs: "scg:List(x:Object)" }),
      ],
    },
  ],
};

const SYSTEM_ACTIVITIES_ENRICHED: PackageActivityDefs = {
  packageId: "UiPath.System.Activities",
  activities: [
    {
      className: "GetTransactionItem",
      displayName: "Get Transaction Item",
      browsable: true,
      processTypes: ["orchestration"],
      propertiesComplete: true,
      properties: [
        prop("QueueName", { required: false }),
        prop("FilterContent"),
        prop("Reference"),
        childProp("TransactionItem", { dir: "Out", type: "UiPath.Core.QueueItem", wrapper: "OutArgument", typeArgs: "ui:QueueItem" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "SetTransactionStatus",
      displayName: "Set Transaction Status",
      browsable: true,
      processTypes: ["orchestration"],
      propertiesComplete: true,
      properties: [
        prop("TransactionItem", { type: "UiPath.Core.QueueItem" }),
        prop("Status", { validValues: ["Successful", "Failed"] }),
        prop("ErrorType", { validValues: ["Application", "Business"] }),
        prop("Reason"),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "LogMessage",
      displayName: "Log Message",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [
        prop("Level", { validValues: ["Trace", "Info", "Warn", "Error", "Fatal"], default: "Info" }),
        prop("Message", { required: true }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "InvokeWorkflowFile",
      displayName: "Invoke Workflow File",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [
        prop("WorkflowFileName", { required: true }),
        prop("Isolated", { type: "System.Boolean", default: "False" }),
        prop("UnSafe", { type: "System.Boolean", default: "False" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "AddQueueItem",
      displayName: "Add Queue Item",
      browsable: true,
      processTypes: ["orchestration", "general"],
      propertiesComplete: true,
      properties: [
        prop("QueueName", { required: false }),
        prop("Reference"),
        prop("Priority", { validValues: ["Low", "Normal", "High"] }),
        prop("DeferDate", { type: "System.DateTime" }),
        prop("DueDate", { type: "System.DateTime" }),
        prop("ItemInformation", { type: "System.Collections.Generic.Dictionary`2[System.String,System.Object]" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "GetCredential",
      displayName: "Get Credential",
      browsable: true,
      processTypes: ["general", "orchestration"],
      propertiesComplete: true,
      properties: [
        prop("AssetName", { required: true }),
        childProp("Username", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        childProp("Password", { dir: "Out", type: "System.Security.SecureString", wrapper: "OutArgument", typeArgs: "s:SecureString" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "GetAsset",
      displayName: "Get Asset",
      browsable: true,
      processTypes: ["general", "orchestration"],
      propertiesComplete: true,
      properties: [
        prop("AssetName", { required: false }),
        childProp("AssetValue", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "AddLogFields",
      displayName: "Add Log Fields",
      browsable: true,
      processTypes: ["general", "orchestration"],
      propertiesComplete: true,
      properties: [
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ExcelApplicationScope",
      displayName: "Excel Application Scope",
      browsable: true,
      processTypes: ["general", "document-processing"],
      propertiesComplete: true,
      properties: [
        prop("WorkbookPath", { required: false }),
        prop("Visible", { type: "System.Boolean", default: "True" }),
        prop("CreateNewFile", { type: "System.Boolean", default: "False" }),
        prop("AutoSave", { type: "System.Boolean", default: "False" }),
        prop("ReadOnly", { type: "System.Boolean", default: "False" }),
        prop("Password"),
        prop("EditPassword"),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ExcelReadRange",
      displayName: "Read Range (Excel)",
      browsable: true,
      processTypes: ["general", "document-processing"],
      propertiesComplete: true,
      properties: [
        prop("SheetName", { default: "Sheet1" }),
        prop("Range"),
        prop("DataTable", { type: "System.Data.DataTable" }),
        prop("AddHeaders", { type: "System.Boolean", default: "True" }),
        prop("PreserveFormat", { type: "System.Boolean", default: "False" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "ExcelWriteRange",
      displayName: "Write Range (Excel)",
      browsable: true,
      processTypes: ["general", "document-processing"],
      propertiesComplete: true,
      properties: [
        prop("SheetName", { default: "Sheet1" }),
        prop("StartingCell", { default: "A1" }),
        prop("DataTable", { type: "System.Data.DataTable", required: true }),
        prop("AddHeaders", { type: "System.Boolean", default: "True" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
  ],
};

const UIAUTOMATION_ACTIVITIES_ENRICHED: PackageActivityDefs = {
  packageId: "UiPath.UIAutomation.Activities",
  activities: [
    {
      className: "TakeScreenshot",
      displayName: "Take Screenshot",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        childProp("Result", { dir: "Out", type: "System.Drawing.Image", wrapper: "OutArgument", typeArgs: "x:Object" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "Click",
      displayName: "Click",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        prop("ClickType", { validValues: ["CLICK_SINGLE", "CLICK_DOUBLE"], default: "CLICK_SINGLE" }),
        prop("MouseButton", { validValues: ["BTN_LEFT", "BTN_RIGHT", "BTN_MIDDLE"], default: "BTN_LEFT" }),
        prop("KeyModifiers", { validValues: ["None", "Alt", "Ctrl", "Shift", "Win"] }),
        prop("SimulateClick", { type: "System.Boolean", default: "False" }),
        prop("SendWindowMessages", { type: "System.Boolean", default: "False" }),
        COMMON_TIMEOUT,
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "TypeInto",
      displayName: "Type Into",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        prop("Text", { required: true }),
        prop("SimulateType", { type: "System.Boolean", default: "False" }),
        prop("SendWindowMessages", { type: "System.Boolean", default: "False" }),
        prop("EmptyField", { type: "System.Boolean", default: "False" }),
        prop("ClickBeforeTyping", { type: "System.Boolean", default: "True" }),
        COMMON_TIMEOUT,
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "GetText",
      displayName: "Get Text",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        childProp("Value", { dir: "Out", wrapper: "OutArgument", typeArgs: "x:String" }),
        COMMON_TIMEOUT,
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "OpenBrowser",
      displayName: "Open Browser",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        prop("Url", { required: true }),
        prop("BrowserType", { validValues: ["IE", "Firefox", "Chrome", "Edge"], default: "IE" }),
        prop("Hidden", { type: "System.Boolean", default: "False" }),
        prop("Private", { type: "System.Boolean", default: "False" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "CloseApplication",
      displayName: "Close Application",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "KillProcess",
      displayName: "Kill Process",
      browsable: true,
      processTypes: ["attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        prop("ProcessName", { required: true }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
    {
      className: "SendOutlookMailMessage",
      displayName: "Send Outlook Mail Message",
      browsable: true,
      processTypes: ["general", "attended-ui", "unattended-ui"],
      propertiesComplete: true,
      properties: [
        prop("To", { required: true }),
        prop("Subject"),
        prop("Body"),
        prop("Cc"),
        prop("Bcc"),
        prop("IsBodyHtml", { type: "System.Boolean", default: "False" }),
        prop("Account"),
        prop("IsDraft", { type: "System.Boolean", default: "False" }),
        COMMON_CONTINUE_ON_ERROR,
      ],
    },
  ],
};

const SYSTEM_CORE_ACTIVITIES_ENRICHED: PackageActivityDefs = {
  packageId: "System.Activities",
  activities: [
    {
      className: "Assign",
      displayName: "Assign",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [
        childProp("To", { dir: "Out", type: "System.Object", wrapper: "OutArgument", typeArgs: "x:Object", required: true }),
        childProp("Value", { type: "System.Object", wrapper: "InArgument", typeArgs: "x:Object", required: true }),
      ],
    },
    {
      className: "If",
      displayName: "If",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [
        prop("Condition", { type: "System.Boolean", required: true }),
      ],
    },
    {
      className: "Sequence",
      displayName: "Sequence",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [],
    },
    {
      className: "TryCatch",
      displayName: "Try Catch",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [],
    },
    {
      className: "Flowchart",
      displayName: "Flowchart",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [],
    },
    {
      className: "ForEach",
      displayName: "For Each",
      browsable: true,
      processTypes: ["general", "api-integration", "document-processing", "attended-ui", "unattended-ui", "orchestration"],
      propertiesComplete: true,
      properties: [
        childProp("Values", { type: "System.Collections.IEnumerable", wrapper: "InArgument", required: true }),
      ],
    },
  ],
};

export const ACTIVITY_DEFINITIONS_REGISTRY: PackageActivityDefs[] = [
  SYSTEM_CORE_ACTIVITIES_ENRICHED,
  SYSTEM_ACTIVITIES_ENRICHED,
  UIAUTOMATION_ACTIVITIES_ENRICHED,
  PDF_ACTIVITIES,
  WORD_ACTIVITIES,
  GSUITE_ACTIVITIES,
  OFFICE365_ACTIVITIES,
  PERSISTENCE_ACTIVITIES,
  TESTING_ACTIVITIES,
  FORM_ACTIVITIES,
  CRYPTOGRAPHY_ACTIVITIES,
  WEBAPI_ACTIVITIES,
  COMPLEX_SCENARIOS_ACTIVITIES,
  AMAZON_S3_ACTIVITIES,
  AMAZON_TEXTRACT_ACTIVITIES,
  AMAZON_COMPREHEND_ACTIVITIES,
  AMAZON_REKOGNITION_ACTIVITIES,
  AZURE_ACTIVITIES,
  AZURE_FORM_RECOGNIZER_ACTIVITIES,
  GOOGLE_CLOUD_ACTIVITIES,
  GOOGLE_VISION_ACTIVITIES,
  SALESFORCE_ACTIVITIES,
  SERVICENOW_ACTIVITIES,
  SLACK_ACTIVITIES,
  JIRA_ACTIVITIES,
  TEAMS_ACTIVITIES,
  FTP_ACTIVITIES,
  PRESENTATIONS_ACTIVITIES,
  CREDENTIALS_ACTIVITIES,
  DOCUMENT_UNDERSTANDING_ACTIVITIES,
  GENAI_ACTIVITIES,
  INTEGRATION_SERVICE_ACTIVITIES,
  COMMUNICATIONS_MINING_ACTIVITIES,
  WORKFLOW_EVENTS_ACTIVITIES,
  BOX_ACTIVITIES,
];

export function getRegistryPackageIds(): string[] {
  return ACTIVITY_DEFINITIONS_REGISTRY.map(p => p.packageId);
}

export function getRegistryActivitiesForPackage(packageId: string): ActivityDef[] | null {
  const pkg = ACTIVITY_DEFINITIONS_REGISTRY.find(p => p.packageId === packageId);
  return pkg ? pkg.activities : null;
}

export function getTotalRegistryActivityCount(): number {
  return ACTIVITY_DEFINITIONS_REGISTRY.reduce((sum, p) => sum + p.activities.length, 0);
}
