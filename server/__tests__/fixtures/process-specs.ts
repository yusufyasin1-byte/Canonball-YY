export const simpleLinearNodes = [
  { id: "1", name: "Login to Portal", nodeType: "task", description: "Open browser and log in to the HR portal using credentials from Orchestrator assets", system: "HR Portal" },
  { id: "2", name: "Download Report", nodeType: "task", description: "Navigate to the reports section and download the monthly attendance CSV", system: "HR Portal" },
  { id: "3", name: "Save to SharePoint", nodeType: "task", description: "Upload the downloaded CSV file to the SharePoint document library", system: "SharePoint" },
];

export const simpleLinearEdges = [
  { sourceNodeId: "1", targetNodeId: "2", label: "on success" },
  { sourceNodeId: "2", targetNodeId: "3", label: "on success" },
];

export const apiDataDrivenNodes = [
  { id: "1", name: "Fetch API Token", nodeType: "task", description: "Call the OAuth2 token endpoint to obtain a bearer token for the REST API", system: "Auth API" },
  { id: "2", name: "Query Customer Records", nodeType: "task", description: "GET /api/customers with pagination, collect all records into a DataTable", system: "CRM API" },
  { id: "3", name: "Transform Records", nodeType: "task", description: "Filter and reshape the customer records, applying business rules for deduplication", system: "Internal" },
  { id: "4", name: "Write to Database", nodeType: "task", description: "Insert transformed records into the staging SQL database table using bulk insert", system: "SQL Database" },
];

export const apiDataDrivenEdges = [
  { sourceNodeId: "1", targetNodeId: "2", label: "" },
  { sourceNodeId: "2", targetNodeId: "3", label: "" },
  { sourceNodeId: "3", targetNodeId: "4", label: "" },
];

export const transactionalQueueNodes = [
  { id: "1", name: "Initialize Settings", nodeType: "task", description: "Read config from Orchestrator assets and initialize application settings", system: "Orchestrator" },
  { id: "2", name: "Get Transaction Item", nodeType: "task", description: "Get the next queue item from the InvoiceQueue in Orchestrator", system: "Orchestrator" },
  { id: "3", name: "Open Invoice App", nodeType: "task", description: "Launch the invoice processing desktop application and log in", system: "Invoice App" },
  { id: "4", name: "Process Invoice", nodeType: "task", description: "Enter invoice details from the queue item into the application form fields", system: "Invoice App" },
  { id: "5", name: "Set Transaction Status", nodeType: "task", description: "Mark the queue item as successful or failed based on processing outcome", system: "Orchestrator" },
];

export const transactionalQueueEdges = [
  { sourceNodeId: "1", targetNodeId: "2", label: "" },
  { sourceNodeId: "2", targetNodeId: "3", label: "" },
  { sourceNodeId: "3", targetNodeId: "4", label: "" },
  { sourceNodeId: "4", targetNodeId: "5", label: "" },
  { sourceNodeId: "5", targetNodeId: "2", label: "next item" },
];

export const lowConfidenceNodes = [
  { id: "1", name: "Do Something", nodeType: "task", description: "Perform the task", system: "" },
];

export const lowConfidenceEdges: any[] = [];

export const simpleLinearSdd = `# Solution Design Document - HR Report Download

## 1. Process Overview
This automation downloads monthly attendance reports from the HR portal and saves them to SharePoint.

## 4. System Architecture
The process accesses https://hr.example.com/reports and uploads to SharePoint Online.

## 9. Orchestrator Artifacts
\`\`\`orchestrator_artifacts
{
  "assets": [
    { "name": "HR_Portal_Credential", "type": "Credential", "description": "Login credentials for HR portal" }
  ],
  "queues": []
}
\`\`\`
`;

export const apiDataDrivenSdd = `# Solution Design Document - Customer Data Sync

## 1. Process Overview
This automation fetches customer records from the CRM REST API and inserts them into a staging database.

## 4. System Architecture
The process calls https://api.crm.example.com/v2/customers using OAuth2 bearer tokens.
The staging database is accessed via SQL Server connection string.

## 9. Orchestrator Artifacts
\`\`\`orchestrator_artifacts
{
  "assets": [
    { "name": "CRM_API_ClientId", "type": "Text", "value": "automation-client", "description": "OAuth2 client ID" },
    { "name": "CRM_API_Secret", "type": "Credential", "description": "OAuth2 client secret" },
    { "name": "StagingDB_Connection", "type": "Text", "value": "Server=staging-db;Database=CRM_Staging;", "description": "SQL connection string" }
  ],
  "queues": []
}
\`\`\`
`;

export const transactionalQueueSdd = `# Solution Design Document - Invoice Processing

## 1. Process Overview
This automation processes invoices from a queue using the REFramework pattern.

## 4. System Architecture
Invoices are loaded into the InvoiceQueue in Orchestrator.
The desktop invoice application is used to enter invoice data.

## 9. Orchestrator Artifacts
\`\`\`orchestrator_artifacts
{
  "assets": [
    { "name": "InvoiceApp_Credential", "type": "Credential", "description": "Login for invoice app" },
    { "name": "MaxRetryNumber", "type": "Text", "value": "3", "description": "Max retries per transaction" }
  ],
  "queues": [
    { "name": "InvoiceQueue", "description": "Queue for invoice processing transactions" }
  ]
}
\`\`\`
`;

export function makeProjectJson(
  projectName: string,
  deps: Record<string, string>,
  options?: { targetFramework?: "Windows" | "Portable"; modernBehavior?: boolean },
): string {
  const targetFramework = options?.targetFramework || "Windows";
  const modernBehavior = options?.modernBehavior !== false;
  return JSON.stringify({
    name: projectName,
    projectVersion: "1.0.0",
    description: `${projectName} automation`,
    main: "Main.xaml",
    dependencies: deps,
    toolVersion: "25.10.0",
    projectType: "Workflow",
    libraryOptions: { includeOriginalXaml: false, packageId: projectName, version: "1.0.0" },
    designOptions: { projectProfile: "Developement", outputType: "Process", modernBehavior },
    expressionLanguage: targetFramework === "Portable" ? "CSharp" : "VisualBasic",
    entryPoints: [{ filePath: "Main.xaml", uniqueId: "00000000-0000-0000-0000-000000000001", input: [], output: [] }],
    schemaVersion: "4.0",
    studioVersion: "25.10.7",
    isTemplate: false,
    templateProjectData: {},
    publishData: {},
    targetFramework,
  }, null, 2);
}

export function makeValidXaml(className: string, bodyActivities: string = ""): string {
  const body = bodyActivities || `<ui:LogMessage Level="Info" Message="[&quot;${className} executing&quot;]" DisplayName="Log ${className}" />`;
  return `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="${className}"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Data;assembly=System.Data"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="${className}">
    <Sequence.Variables />
    ${body}
  </Sequence>
</Activity>`;
}

export function makeApiDrivenXaml(): string {
  return makeValidXaml("Main", `
    <ui:HttpClient DisplayName="Call API" Endpoint="[&quot;https://api.example.com/data&quot;]" Method="GET" ResponseContent="[str_Response]" />
    <ui:DeserializeJson DisplayName="Parse Response" JsonString="[str_Response]" />
    <ui:LogMessage Level="Info" Message="[&quot;API call complete&quot;]" DisplayName="Log Result" />
  `);
}

export function makeXamlWithInvoke(invokedFile: string): string {
  return makeValidXaml("Main", `
    <ui:InvokeWorkflowFile DisplayName="Invoke Sub" WorkflowFileName="${invokedFile}" />
  `);
}
