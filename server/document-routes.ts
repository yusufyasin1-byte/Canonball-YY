import type { Express, Request, Response } from "express";
import { getLLM, SDD_LLM_TIMEOUT_MS } from "./lib/llm";
import { RunLogger, type StageEventListener } from "./lib/run-logger";
import { sanitizeChatForLLM } from "./lib/sanitize-chat";
import { documentStorage } from "./document-storage";
import { processMapStorage } from "./process-map-storage";
import { chatStorage } from "./replit_integrations/chat/storage";
import { storage } from "./storage";
import { getPlatformCapabilities, type PlatformCapabilityProfile, type IntegrationServiceConnection, type IntegrationServiceConnector, type ConnectorOperation } from "./uipath-integration";
import { generateUiPathPackage, generateDhg, findUiPathMessage, parseUiPathPackage, computeVersion, getCachedPipelineResult } from "./uipath-pipeline";
import { generateConfigXlsx } from "./package-assembler";
import { startUiPathGenerationRun, type TriggerSource, type RunCallbacks, type RunResult } from "./uipath-run-manager";
import { UIPATH_PROMPT, repairTruncatedPackageJson } from "./uipath-prompts";
export { UIPATH_PROMPT, repairTruncatedPackageJson };
import type { MetaValidationMode } from "./meta-validation";
import { acquireDocGenerationLock, releaseDocGenerationLock, isGenerationCancelled, consumePendingInvalidation, runCompletionCallbacks } from "./lib/doc-generation-lock";
import { evaluateTransition } from "./stage-transition";
import { approveDocument } from "./document-service";
import { escapeXml } from "./lib/xml-utils";
import { metadataService } from "./catalog/metadata-service";
import { ensureArtifactBlock, parseArtifactBlock } from "./lib/artifact-parser";
import { z } from "zod";
import type { UiPathPackage } from "./types/uipath-package";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  AlignmentType, ShadingType, ImageRun, TableOfContents,
} from "docx";
import { renderProcessMapImage } from "./process-map-renderer";
import {
  buildDsdTemplatePrompt,
  buildPddTemplatePrompt,
  buildSddTemplatePrompt,
  ensureTemplateSections,
  DSD_TEMPLATE_SECTIONS,
  PDD_TEMPLATE_SECTIONS,
  SDD_TEMPLATE_SECTIONS,
} from "./doc-templates/uipath-template-docs";
import AdmZip from "adm-zip";
import archiver from "archiver";


const PDD_PROMPT = `The SME has approved the As-Is process map. Now generate a Process Design Document. The PDD must include: 1) Executive Summary, 2) Process Scope, 3) As-Is Process Description (narrative form, referencing the steps in the map), 4) To-Be Process Description (describe the optimised automated process — how the workflow will operate once automation is applied, referencing the To-Be map steps), 5) Pain Points and Inefficiencies, 6) Automation Opportunity Assessment, 7) Assumptions and Exceptions, 8) Data and System Requirements. Write this as a professional document, not a bullet list. Be specific and use the details from our conversation.

Format your response as sections separated by "## " headings. Each section should start with "## 1. Executive Summary", "## 2. Process Scope", etc.`;

const SDD_PROMPT = `(Legacy fallback — see SDD_PROSE_PROMPT and SDD_ARTIFACTS_PROMPT for active prompts)`;

async function verifyIdeaAccess(req: Request, res: Response): Promise<string | null> {
  if (!req.session.userId) {
    res.status(401).json({ message: "Not authenticated" });
    return null;
  }
  const ideaId = req.params.ideaId as string;
  const idea = await storage.getIdea(ideaId);
  if (!idea) {
    res.status(404).json({ message: "Idea not found" });
    return null;
  }
  const user = await storage.getUser(req.session.userId);
  if (!user) {
    res.status(401).json({ message: "User not found" });
    return null;
  }
  const activeRole = (req.session.activeRole || user.role) as string;
  if (idea.ownerEmail !== user.email && activeRole !== "Admin" && activeRole !== "CoE") {
    res.status(403).json({ message: "Access denied" });
    return null;
  }
  return ideaId;
}


function buildSddProsePrompt(platformCapabilities?: string, packageRegistryContext?: string, automationType?: string): string {
  const platformContext = platformCapabilities
    ? `\n\nIMPORTANT — PLATFORM-AWARE DESIGN:\n${platformCapabilities}\n\nLeverage available services optimally. Key capabilities:\n- **Unattended/Attended**: Unattended for back-office, attended for human-assisted work\n- **AI Agents**: For intelligent decision-making and NLP-driven processes\n- **Action Center**: Human-in-the-loop approvals/validations with form schemas, SLAs, and Data Fabric entity linking\n- **Data Fabric**: Typed entities for cross-run data persistence, connecting Action Center, Apps, and workflows\n- **Apps**: Citizen-developer web UIs for input/oversight, connected to Data Fabric entities\n- **IXP**: Auto-select extraction: Classic DU for structured forms (invoices, POs), Generative Extraction for unstructured docs (contracts, reports), Communications Mining for email/message triage\n- **Integration Service**: Pre-built connectors (SAP, Salesforce, etc.) — prefer over custom HTTP\n- **Storage Buckets**: Centralized file storage\n- **AI Center**: Custom ML models\n- **Maestro**: BPMN orchestration combining service tasks, user tasks, and gateways — prefer over triggers for multi-step human+automated flows\n\nFor document processes: specify extraction approach, field mappings, and validation rules (confidence thresholds, review triggers) in the Architecture section.\nFor each available service, explain HOW it is used. For unavailable services, include a "Platform Recommendations" section with concrete benefits.`
    : "";

  return `The SME has approved the PDD. Generate the Solution Design Document for this UiPath automation. You are designing a solution that will be FULLY DEPLOYED — every artifact you specify will be automatically provisioned on the connected UiPath platform.

Think holistically about the optimal combination of UiPath platform capabilities to deliver this automation. Don't default to a simple bot — evaluate whether the process benefits from agents, human-in-the-loop steps, document processing, ML models, or other advanced capabilities.${platformContext}

CROSS-SERVICE INTEGRATION RULES (CRITICAL):
- **Action Center + Data Fabric**: When designing human-in-the-loop steps (approvals, reviews, escalations), define complete form schemas with field names, data types, validation rules, and default values. Specify SLA configurations (due time, warning threshold, escalation policy). If the approval results should persist, design a Data Fabric entity to store them and reference it from the Action Center task definition.
- **Data Fabric Entities**: For any process data that needs to persist across workflow runs, be shared between processes, or serve as a data source for Apps, define a Data Fabric entity with its complete schema (fields, types, relationships). Entity fields should match the process data model from the PDD.
- **Apps Integration**: If UiPath Apps is available, reference existing apps that serve as user-facing interfaces for manual input, oversight dashboards, or human interaction points. Apps connect to Data Fabric entities and can trigger or receive data from automation workflows.
- **Wired-Together Artifacts**: Action Center tasks should reference Data Fabric entities for result storage. Data Fabric entities should be referenced in XAML workflows for read/write operations. Apps should be linked to processes and entities in the Maestro process definitions.

Include these sections:

1) Automation Architecture Overview — describe the overall solution architecture, which UiPath services are used and why. Include a clear rationale for the chosen approach (e.g., why unattended vs attended, why Action Center for certain steps, etc.). Explain how Action Center, Data Fabric, and Apps work together in this solution. If attended robots are available, explicitly recommend attended vs unattended execution for each component with justification.
2) Process Components and Workflow Breakdown — detail each workflow/component, its purpose, and how they interconnect. Specify which execution type (unattended, attended, agent-based) each component uses. For each human-in-the-loop step, specify the complete form schema and SLA configuration. Reference existing deployed processes that can be reused if applicable.
3) UiPath Activities and Packages Required — list specific UiPath packages and activities${packageRegistryContext ? " with EXACT version numbers from the validated package registry provided below" : ""}. Include Integration Service connectors if applicable. Include UiPath.Persistence.Activities for Action Center tasks and Data Fabric HTTP activities for entity operations. When targeting Serverless (Cross-Platform) robots, use Modern Design activities only: UseExcel instead of ExcelApplicationScope, UseBrowser instead of OpenBrowser, SendMail/GetMail instead of SendSmtpMailMessage/GetImapMailMessage. Do NOT use CloseApplication or KillProcess on Serverless.
4) Integration Points and API/System Connections — all external systems, APIs, databases, and how they connect (Integration Service connectors, custom HTTP, direct DB, etc.). Include Data Fabric entity service endpoints for data persistence.
5) Exception Handling Strategy — business exceptions, system exceptions, retry logic, Action Center escalations, dead-letter handling. Include screenshot-on-error as a best practice: every TryCatch error handler should capture a screenshot before logging, especially critical for Serverless robots where no RDP is available for debugging.
6) Security Considerations — credential management via Orchestrator assets, role-based access, data encryption, audit trail
7) Test Strategy — unit tests, integration tests, UAT approach. Reference Test Manager if available
7a) Governance Compliance — if governance policies are active, include a section confirming compliance with each active policy and how the solution design adheres to naming conventions, restricted activity rules, and required error handling patterns
8) Data Model and Entity Design — define all Data Fabric entities with their complete field schemas, relationships between entities, and which workflows/Action Center tasks reference each entity

${(automationType === "agent" || automationType === "hybrid") ? `AGENT ARCHITECTURE (MANDATORY for ${automationType} automation):
Include a dedicated "## 8. Agent Architecture" section with:
- **Agent Type**: autonomous, conversational, or coded
- **Agent Identity**: name, purpose, and behavioral system prompt
- **Tool Definitions**: each tool mapped to a deployed Orchestrator process by name, with input/output argument schemas
- **Context Grounding Strategy**: storage buckets, document sources, refresh cadence, embedding model
- **Escalation Rules**: conditions mapped to Action Center task catalogs by name
- **Guardrails**: safety constraints, output validation, PII handling, max iteration limits
- **Agent Interaction Flow**: which RPA process triggers the agent, what it returns, downstream steps

` : ""}Format your response as sections separated by "## " headings. Each section should start with "## 1. Automation Architecture Overview", etc. Be comprehensive and specific. Do NOT include the Orchestrator Deployment Specification — that will be generated separately as section 9.${packageRegistryContext ? `\n\n${packageRegistryContext}\n\nPACKAGE VERSION RULES (MANDATORY):\n- For every UiPath package you reference, use the EXACT preferred version from the registry above (e.g., "UiPath.System.Activities 25.10.7").\n- Do NOT write "Latest stable", "Latest", or invent version numbers.\n- If a package is needed but NOT listed in the registry above, you MUST note: "[package name] — version not verified (not in validated registry)" instead of guessing a version.` : ""}`;
}

interface SlimArtifactsContext {
  availableServices?: string;
  activeConnections?: { connectorName: string; connectionName: string; connectionId: string }[];
  automationType?: string;
}

function buildArtifactsContext(platformProfile: PlatformCapabilityProfile): SlimArtifactsContext {
  const ctx: SlimArtifactsContext = {};

  if (platformProfile?.configured) {
    const availNames: string[] = [];
    const avail = platformProfile.available || {};
    for (const [key, val] of Object.entries(avail)) {
      if (val) availNames.push(key);
    }
    if (availNames.length > 0) {
      ctx.availableServices = availNames.map(n => `${n}: available`).join(", ");
    }
  }

  if (platformProfile?.integrationService?.available) {
    const is = platformProfile.integrationService;
    const activeConns = is.connections.filter((c: IntegrationServiceConnection) => c.status === "connected" || c.status === "active");
    if (activeConns.length > 0) {
      ctx.activeConnections = activeConns.map((c: IntegrationServiceConnection) => ({
        connectorName: c.connectorName,
        connectionName: c.name,
        connectionId: c.id,
      }));
    }
  }

  return ctx;
}

function buildSddArtifactsPrompt(artifactsContext?: SlimArtifactsContext): string {
  let platformContext = "";
  if (artifactsContext?.availableServices) {
    platformContext = `\n\nAVAILABLE PLATFORM SERVICES: ${artifactsContext.availableServices}\nOnly generate artifacts for services that are AVAILABLE. For unavailable services, do NOT include their artifact arrays.`;
  }
  if (artifactsContext?.activeConnections && artifactsContext.activeConnections.length > 0) {
    const connList = artifactsContext.activeConnections.map(c => `- ${c.connectorName}: "${c.connectionName}" (ID: ${c.connectionId})`).join("\n");
    platformContext += `\n\nACTIVE INTEGRATION SERVICE CONNECTIONS:\n${connList}\nUse exact connector/connection names and IDs in integrationServiceConnectors entries.`;
  }
  if (artifactsContext?.automationType) {
    platformContext += `\n\nAutomation type: ${artifactsContext.automationType}`;
  }

  return `Based on the approved PDD, generate ONLY the Orchestrator & Platform Deployment Specification (Section 9) for a UiPath automation SDD.${platformContext}

You MUST output a fenced code block tagged \`\`\`orchestrator_artifacts with a complete JSON object defining EVERY deployable artifact needed. This is machine-parsed and used to AUTO-PROVISION all artifacts on the connected UiPath platform. Every artifact you include WILL be created automatically.

Here is the EXACT format:

\`\`\`orchestrator_artifacts
{
  "queues": [
    { "name": "QueueName", "description": "Purpose", "maxRetries": 3, "uniqueReference": true }
  ],
  "assets": [
    { "name": "AssetName", "type": "Text|Integer|Bool|Credential", "value": "default value or empty", "description": "Purpose" }
  ],
  "machines": [
    { "name": "TemplateName", "type": "Unattended|Attended|Development", "slots": 1, "description": "Purpose" }
  ],
  "triggers": [
    { "name": "TriggerName", "type": "Queue|Time", "queueName": "if queue trigger", "cron": "if time trigger e.g. 0 0 9 ? * MON-FRI *", "description": "Purpose" }
  ],
  "storageBuckets": [
    { "name": "BucketName", "description": "Purpose" }
  ],
  "environments": [
    { "name": "EnvironmentName", "type": "Production|Development|Testing", "description": "Purpose" }
  ],
  "actionCenter": [
    { "taskCatalog": "CatalogName", "assignedRole": "Role", "sla": "24 hours", "escalation": "description", "description": "Purpose" }
  ],
  "documentUnderstanding": [
    { "name": "ProjectName", "documentTypes": ["Invoice", "Receipt"], "extractionApproach": "classic_du|generative|hybrid", "description": "Purpose", "taxonomyFields": [{ "documentType": "Invoice", "fields": [{ "name": "InvoiceNumber", "type": "String" }, { "name": "TotalAmount", "type": "Number" }] }], "classifierType": "ML", "validationRules": [{ "field": "TotalAmount", "rule": "confidence >= 0.85", "action": "flag_for_review" }] }
  ],
  "communicationsMining": [
    { "name": "StreamName", "sourceType": "email|chat|ticket", "description": "Purpose", "intents": ["Request", "Complaint", "Inquiry"], "entities": ["CustomerName", "OrderNumber"], "routingRules": [{ "intent": "Complaint", "action": "escalate", "target": "SeniorAgent" }] }
  ],
  "requirements": [
    { "name": "REQ-001: Requirement name", "description": "Business requirement from PDD", "source": "PDD Section X" }
  ],
  "testCases": [
    { "name": "TC001 - Test case name", "description": "What this tests", "steps": [{ "action": "Step action", "expected": "Expected result" }] }
  ],
  "testSets": [
    { "name": "Happy Path Tests", "description": "Core scenario validation", "testCaseNames": ["TC001 - Test case name"] }
  ],
  "agents": [
    {
      "name": "AgentName",
      "agentType": "autonomous|conversational|coded",
      "description": "Agent purpose and scope",
      "systemPrompt": "Full behavioral instructions for the agent",
      "tools": [
        { "name": "ToolName", "description": "What this tool does", "processReference": "Orchestrator_Process_Name", "inputArguments": { "argName": "argType" }, "outputArguments": ["resultField"] }
      ],
      "contextGrounding": {
        "storageBucket": "BucketName_from_storageBuckets_above",
        "documentSources": ["Source description"],
        "refreshStrategy": "daily|weekly|on-change",
        "embeddingModel": "model name or default"
      },
      "guardrails": ["Safety constraint"],
      "escalationRules": [
        { "condition": "When to escalate", "target": "Human role", "actionCenterCatalog": "CatalogName_from_actionCenter_above", "priority": "High" }
      ],
      "maxIterations": 10,
      "temperature": 0.3
    }
  ],
  "knowledgeBases": [
    { "name": "KBName", "description": "Purpose", "documentSources": ["Source"], "refreshFrequency": "weekly" }
  ],
  "promptTemplates": [
    { "name": "TemplateName", "description": "Purpose", "template": "Prompt with {{variable}}", "variables": ["variable"] }
  ],
  "maestroProcesses": [
    {
      "name": "ProcessName",
      "description": "End-to-end orchestrated process combining automated and human tasks",
      "serviceTasks": [
        { "name": "ServiceTaskName", "processRef": "ExactProcessNameFromOrchestrator", "description": "Automated step linked to an Orchestrator process" }
      ],
      "userTasks": [
        { "name": "UserTaskName", "actionCenterCatalog": "CatalogNameFromActionCenterAbove", "assignee": "Role or group", "description": "Human review/approval step via Action Center" }
      ],
      "gateways": [
        { "name": "GatewayName", "type": "exclusive|parallel|inclusive", "conditions": ["condition expression"], "description": "Decision or fork/join point" }
      ],
      "sequenceFlows": [
        { "from": "SourceElementName", "to": "TargetElementName", "condition": "optional condition expression" }
      ],
      "crossReferences": {
        "orchestratorProcesses": ["ExactProcessNameFromOrchestrator"],
        "actionCenterCatalogs": ["CatalogNameFromActionCenterAbove"],
        "queues": ["QueueNameFromQueuesAbove"]
      }
    }
  ],
  "integrationServiceConnectors": [
    {
      "connectorName": "ConnectorName (e.g. Gmail, SAP, Salesforce)",
      "connectionName": "ExactConnectionNameFromTenant",
      "connectionId": "connection-id",
      "usedActions": ["ExactActionName from operation catalog"],
      "usedTriggers": ["ExactTriggerName from operation catalog"],
      "description": "How this connector is used in the automation",
      "packageDependency": "UiPath.IntegrationService.Activities"
    }
  ]
}
\`\`\`

Rules:
- Include ALL artifacts needed for a fully deployed, production-ready automation.
- Every automation needs at least one queue, credentials, a machine template, and a trigger.
- For credential assets, set value to "" (empty).
- For text/integer/bool assets, provide sensible defaults.
- For queue triggers, reference the queue name defined above.
- For time triggers, use UiPath 7-field cron expressions.
- Include environments (Production at minimum).
- Include Action Center task catalogs if the solution uses human-in-the-loop.
- Include Document Understanding projects if the solution processes documents. For each DU project, specify the extractionApproach: "classic_du" for structured forms (invoices, receipts, POs), "generative" for unstructured documents (contracts, reports, correspondence), or "hybrid" for mixed document types. Include taxonomyFields with field name and type for each document type. Include validationRules with confidence thresholds and review triggers.
- Include communicationsMining streams if the solution processes emails, chat messages, or tickets. Define intents, entities to extract, and routing rules.
- Include requirements derived from PDD business rules, compliance constraints, SLAs, and acceptance criteria. Use "REQ-NNN:" prefix for traceability.
- Include test cases covering key automation scenarios (happy path, exceptions, edge cases, regression). Use "TCNNN - " prefix.
- Group test cases into logical test sets (e.g. "Happy Path Tests", "Exception Handling Tests", "Regression Tests"). Reference test case names exactly as defined above in the testCaseNames array.
- AGENT ARTIFACTS (include when automation type is agent or hybrid):
  - Each agent MUST specify agentType (autonomous, conversational, or coded).
  - Agent tools MUST reference Orchestrator processes by exact name via processReference — these are resolved to deployed process IDs during provisioning.
  - Agent contextGrounding.storageBucket MUST reference a storage bucket defined in the storageBuckets array above by exact name.
  - Agent escalationRules.actionCenterCatalog MUST reference an Action Center catalog defined in the actionCenter array above by exact taskCatalog name.
  - These cross-references are validated and wired during deployment — the agent config will contain resolved IDs for all referenced artifacts.
- Include maestroProcesses when the solution involves multi-step orchestrated workflows combining automated service tasks and human user tasks. Each maestroProcess MUST:
  - Reference exact Orchestrator process names in serviceTasks.processRef (matching processes defined in the SDD).
  - Reference exact Action Center catalog names in userTasks.actionCenterCatalog (matching catalogs defined in the actionCenter array above).
  - Define gateways for conditional routing (exclusive), parallel execution (parallel), or multi-path (inclusive).
  - Define sequenceFlows connecting all elements (serviceTasks, userTasks, gateways) in execution order.
  - Include crossReferences listing all referenced orchestratorProcesses, actionCenterCatalogs, and queues by exact name for deployment wiring.
- INTEGRATION SERVICE CONNECTOR DEPENDENCIES: When the solution uses Integration Service connectors (e.g., Gmail, SAP, Salesforce, ServiceNow), include integrationServiceConnectors entries. Each entry MUST:
  - Use the exact connectorName and connectionName from the discovered connected systems.
  - Reference exact action/trigger names from the operation catalog in usedActions/usedTriggers.
  - Always set packageDependency to "UiPath.IntegrationService.Activities".
  - These are declared as dependencies so the deployment system can validate connector availability before provisioning.
- Be comprehensive — this specification drives full automated deployment.

Output ONLY "## 9. Orchestrator & Platform Deployment Specification" followed by the fenced artifacts block and any brief supporting prose. Nothing else.`;
}


interface GenerateDocumentResult {
  content: string;
  artifactsValid?: boolean;
  artifactWarnings?: string[];
}

async function generateDocument(ideaId: string, docType: string, onStageEvent?: StageEventListener): Promise<GenerateDocumentResult> {
  const idea = await storage.getIdea(ideaId);
  if (!idea) throw new Error("Idea not found");

  const history = await chatStorage.getMessagesByIdeaId(ideaId);
  const chatMessages = sanitizeChatForLLM(history);

  let contextPrompt = "";
  if (docType === "PDD") {
    const asIsNodes = await processMapStorage.getNodesByIdeaId(ideaId, "as-is");
    const asIsEdges = await processMapStorage.getEdgesByIdeaId(ideaId, "as-is");
    const toBeNodes = await processMapStorage.getNodesByIdeaId(ideaId, "to-be");
    const toBeEdges = await processMapStorage.getEdgesByIdeaId(ideaId, "to-be");
    const mapSummary = (nodes: any[]) => nodes.map((n) => ({ name: n.name, type: n.nodeType, role: n.role, system: n.system }));
    contextPrompt = `\n\nApproved As-Is process map:\n${JSON.stringify({ nodes: mapSummary(asIsNodes), edges: asIsEdges.map((e: any) => ({ source: e.sourceNodeId, target: e.targetNodeId, label: e.label })) })}`;
    if (toBeNodes.length > 0) {
      contextPrompt += `\n\nTo-Be process map:\n${JSON.stringify({ nodes: mapSummary(toBeNodes), edges: toBeEdges.map((e: any) => ({ source: e.sourceNodeId, target: e.targetNodeId, label: e.label })) })}`;
    }
    try {
      const platformProfile = await getPlatformCapabilities();
      if (platformProfile.configured) {
        contextPrompt += `\n\nUiPath Platform Capabilities (connected Orchestrator):\n${platformProfile.availableDescription}`;
        if (platformProfile.unavailableRecommendations) {
          contextPrompt += `\n${platformProfile.unavailableRecommendations}`;
        }
        if (platformProfile.integrationService?.available) {
          const is = platformProfile.integrationService;
          const activeConns = is.connections.filter((c: IntegrationServiceConnection) => c.status === "connected" || c.status === "active");
          if (activeConns.length > 0) {
            const connMap = new Map<string, IntegrationServiceConnection[]>();
            for (const conn of activeConns) {
              const existing = connMap.get(conn.connectorName) || [];
              existing.push(conn);
              connMap.set(conn.connectorName, existing);
            }
            let isContext = `\n\nCONNECTED ENTERPRISE SYSTEMS (Integration Service):\nThe following systems are connected via UiPath Integration Service and available for this automation:\n`;
            Array.from(connMap.entries()).forEach(([connectorName, conns]) => {
              const connDetails = conns.map((c: IntegrationServiceConnection) => {
                let detail = `"${c.name}"`;
                if (c.connectionIdentity || c.accountName) detail += ` (account: ${c.connectionIdentity || c.accountName})`;
                return detail;
              }).join(", ");
              isContext += `- **${connectorName}**: ${conns.length} connection(s) — ${connDetails}\n`;
            });
            isContext += `\nWhen describing integration points in the PDD, reference these connected systems by name. For example: "Email notifications will be sent via the Gmail connector available through Integration Service" rather than generic descriptions.`;
            contextPrompt += isContext;
          }
        }
        console.log(`[PDD] Platform capabilities injected: ${platformProfile.summary}`);
      }
    } catch (err: any) {
      console.log(`[PDD] Could not fetch platform capabilities: ${err.message}`);
    }
  } else if (docType === "SDD") {
    const pdd = await documentStorage.getLatestDocument(ideaId, "PDD");
    if (pdd) {
      contextPrompt = `\n\nHere is the approved PDD:\n${pdd.content}`;
    }
  } else if (docType === "DSD") {
    const pdd = await documentStorage.getLatestDocument(ideaId, "PDD");
    const sdd = await documentStorage.getLatestDocument(ideaId, "SDD");
    const asIsNodes = await processMapStorage.getNodesByIdeaId(ideaId, "as-is");
    const toBeNodes = await processMapStorage.getNodesByIdeaId(ideaId, "to-be");
    const asIsEdges = await processMapStorage.getEdgesByIdeaId(ideaId, "as-is");
    const toBeEdges = await processMapStorage.getEdgesByIdeaId(ideaId, "to-be");

    if (pdd) {
      contextPrompt += `\n\nApproved PDD:\n${pdd.content}`;
    }
    if (sdd) {
      contextPrompt += `\n\nApproved or latest SDD:\n${sdd.content}`;
    }

    const activeNodes = toBeNodes.length > 0 ? toBeNodes : asIsNodes;
    const activeEdges = toBeNodes.length > 0 ? toBeEdges : asIsEdges;
    if (activeNodes.length > 0) {
      contextPrompt += `\n\nProcess map context:\n${JSON.stringify({
        nodes: activeNodes.map((n) => ({
          name: n.name,
          type: n.nodeType,
          role: n.role,
          system: n.system,
          description: n.description,
        })),
        edges: activeEdges.map((e: any) => ({ source: e.sourceNodeId, target: e.targetNodeId, label: e.label })),
      })}`;
    }

    try {
      const messages = await chatStorage.getMessagesByIdeaId(ideaId);
      const uipathMsg = findUiPathMessage(messages);
      if (uipathMsg) {
        const pkg = parseUiPathPackage(uipathMsg);
        contextPrompt += `\n\nGenerated UiPath package context:\n${JSON.stringify({
          projectName: pkg.projectName,
          workflows: (pkg.workflows || []).map((wf: any) => ({ name: wf.name, description: wf.description })),
          dependencies: pkg.dependencies || [],
        })}`;
      }
    } catch (err: any) {
      console.warn(`[DSD] Could not load package context: ${err.message}`);
    }
  }

  if (docType === "SDD") {
    const sddRunId = `sdd-${ideaId}-${Date.now()}`;
    const runLogger = new RunLogger(sddRunId, "SDD", onStageEvent);

    try {
      await storage.createGenerationRun({
        ideaId,
        runId: sddRunId,
        status: "running",
        generationMode: "sdd_generation",
        triggeredBy: "manual",
      });
    } catch (e: any) {
      console.warn(`[SDD] Failed to create generation run record: ${e.message}`);
    }

    try {
    runLogger.stageStart("platform_capabilities");
    console.log("[SDD] Fetching platform capabilities for platform-aware SDD...");
    const platformProfile = await getPlatformCapabilities();
    let platformCapabilitiesText = platformProfile.configured
      ? `${platformProfile.availableDescription}\n\n${platformProfile.unavailableRecommendations}`
      : undefined;
    if (platformProfile.licenseInfo && platformCapabilitiesText) {
      const lic = platformProfile.licenseInfo;
      platformCapabilitiesText += `\n\nLICENSE ANALYSIS:\nCurrent license allocation: ${lic.summary}\n`;
      if (lic.recommendations.length > 0) {
        platformCapabilitiesText += `\nLicense optimization recommendations:\n${lic.recommendations.join("\n")}\n`;
      }
      platformCapabilitiesText += `\nInclude a "## License Analysis & Optimization" section in the SDD covering:\n1. Current license utilization and whether it supports the proposed solution\n2. Recommendations for optimal license allocation (e.g., which robot types to use, how many slots needed)\n3. Any missing license types that would be needed and the business impact of not having them`;
    }
    if (platformProfile.integrationService?.available && platformCapabilitiesText) {
      const is = platformProfile.integrationService;
      const activeConns = is.connections.filter((c: IntegrationServiceConnection) => c.status === "connected" || c.status === "active");
      if (activeConns.length > 0) {
        const connectorKeyToMeta = new Map<string, IntegrationServiceConnector>();
        for (const conn of is.connectors) {
          connectorKeyToMeta.set(conn.id, conn);
        }

        let connLines = activeConns.map((c: IntegrationServiceConnection) => {
          const meta = c.connectorKey ? connectorKeyToMeta.get(c.connectorKey) : undefined;
          let line = `- **${c.connectorName}**`;
          if (meta?.categories && meta.categories.length > 0) {
            line += ` [${meta.categories.join(", ")}]`;
          }
          line += `: connection "${c.name}" (ID: ${c.id})`;
          if (c.connectionIdentity || c.accountName) {
            line += `, account: ${c.connectionIdentity || c.accountName}`;
          }
          return line;
        }).join("\n");

        let opsCatalog = "";
        const MAX_OPS_PER_CONNECTOR = 5;
        const activeConnectorIds = Array.from(new Set(activeConns.map((c: IntegrationServiceConnection) => c.connectorId).filter(Boolean)));
        const activeConnectorKeys = Array.from(new Set(activeConns.map((c: IntegrationServiceConnection) => c.connectorKey).filter(Boolean)));
        const connectorsWithOps = is.connectors.filter((c: IntegrationServiceConnector) =>
          (activeConnectorIds.includes(c.id) || activeConnectorKeys.includes(c.id)) && c.operations && c.operations.length > 0
        );
        if (connectorsWithOps.length > 0) {
          opsCatalog = `\n\nINTEGRATION SERVICE — KEY OPERATIONS (top ${MAX_OPS_PER_CONNECTOR} per connector):\n`;
          for (const connector of connectorsWithOps) {
            const actions = connector.operations.filter((o: ConnectorOperation) => o.type === "action");
            const triggers = connector.operations.filter((o: ConnectorOperation) => o.type === "trigger");
            opsCatalog += `\n**${connector.name}** (${connector.operations.length} total operations):\n`;
            if (actions.length > 0) {
              const shown = actions.slice(0, MAX_OPS_PER_CONNECTOR);
              opsCatalog += `  Actions: ${shown.map((a: ConnectorOperation) => `"${a.name}"`).join(", ")}${actions.length > MAX_OPS_PER_CONNECTOR ? ` (+${actions.length - MAX_OPS_PER_CONNECTOR} more)` : ""}\n`;
            }
            if (triggers.length > 0) {
              const shown = triggers.slice(0, MAX_OPS_PER_CONNECTOR);
              opsCatalog += `  Triggers: ${shown.map((t: ConnectorOperation) => `"${t.name}"`).join(", ")}${triggers.length > MAX_OPS_PER_CONNECTOR ? ` (+${triggers.length - MAX_OPS_PER_CONNECTOR} more)` : ""}\n`;
            }
          }
          opsCatalog += `\nReference exact operation names above. Use UiPath.IntegrationService.Activities package. Declare connectors as dependencies in integrationServiceConnectors array.`;
        }

        platformCapabilitiesText += `\n\nINTEGRATION SERVICE — CONNECTED ENTERPRISE SYSTEMS:\nThe following Integration Service connections are ACTIVE and ready to use:\n${connLines}\n\nWhen designing integration points, you MUST use these Integration Service connectors instead of custom HTTP activities. Reference the specific connector name in the "UiPath Activities and Packages Required" section and include the UiPath.IntegrationService.Activities package. In the "Integration Points" section, specify the connector name and connection ID for each connected system.${opsCatalog}`;
      }
      if (is.connectors.length > 0 && activeConns.length === 0) {
        const connectorNames = is.connectors.slice(0, 20).map((c: IntegrationServiceConnector) => c.name).filter(Boolean).join(", ");
        platformCapabilitiesText += `\n\nINTEGRATION SERVICE:\n${is.connectors.length} connector(s) available but no active connections configured yet: ${connectorNames}.\nRecommend setting up Integration Service connections for any enterprise systems involved in this automation.`;
      }
    }
    console.log(`[SDD] Platform profile: ${platformProfile.summary}`);
    runLogger.stageEnd("platform_capabilities", "succeeded", { configured: platformProfile.configured });

    runLogger.stageStart("llm_parallel_generation");
    console.log("[SDD] Starting parallel generation (prose + artifacts)...");
    const startTime = Date.now();
    const systemPrompt = `You are a Senior Solution Architect generating formal documents for the "${idea.title}" project. You think in solution patterns (dispatcher-performer, REFramework, attended hybrid, queue-driven fan-out) and select them with deliberate rationale — not by default. You make platform trade-offs explicitly: why Orchestrator queues vs Data Fabric, why attended vs unattended, why Integration Service connectors vs custom HTTP. You design for operability — every component has a monitoring, alerting, and SLA adherence story. You consider deployment topology (on-prem vs cloud, Serverless vs classic robots) and licensing implications. Your documents are architecturally intentional, not templated. Be specific and use details from the conversation.${contextPrompt}`;

    const packageRegistryContext = metadataService.getPackageRegistryContext();
    const ideaAutomationType = (idea.automationType as string) || undefined;
    const sddProsePrompt = buildSddTemplatePrompt(platformCapabilitiesText, packageRegistryContext, ideaAutomationType);

    const slimArtifactsCtx = buildArtifactsContext(platformProfile);
    slimArtifactsCtx.automationType = ideaAutomationType;
    const sddArtifactsPrompt = buildSddArtifactsPrompt(slimArtifactsCtx);

    const artifactsSystemPrompt = `You are a Senior Solution Architect generating deployment artifacts for the "${idea.title}" project. You think in solution patterns (dispatcher-performer, REFramework, attended hybrid, queue-driven fan-out) and select them with deliberate rationale. You make platform trade-offs explicitly, design for operability (monitoring, alerting, SLA adherence), and consider deployment topology and licensing implications.${contextPrompt}\n\nIMPORTANT: Your response MUST begin immediately with the \`\`\`orchestrator_artifacts fenced code block. Do NOT include any prose, explanation, or text before the opening fence.`;

    const proseChatMessages = sanitizeChatForLLM(history, { maxMessages: 20 });

    const sddTimeout = SDD_LLM_TIMEOUT_MS;
    console.log(`[SDD] Using timeout of ${sddTimeout / 1000}s for LLM calls`);

    const [proseResult, artifactsResult] = await Promise.allSettled([
      getLLM().create({
        maxTokens: 6144,
        system: systemPrompt,
        messages: [...proseChatMessages, { role: "user", content: sddProsePrompt }],
        timeoutMs: sddTimeout,
      }),
      getLLM().create({
        maxTokens: 4096,
        system: artifactsSystemPrompt,
        messages: [{ role: "user", content: sddArtifactsPrompt }],
        timeoutMs: sddTimeout,
      }),
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const failures: string[] = [];
    if (proseResult.status === "rejected") failures.push(`prose: ${proseResult.reason?.message || "unknown error"}`);
    if (artifactsResult.status === "rejected") failures.push(`artifacts: ${artifactsResult.reason?.message || "unknown error"}`);

    if (failures.length > 0) {
      const failureDetail = failures.join("; ");
      console.error(`[SDD] Parallel generation failed after ${elapsed}s — ${failureDetail}`);
      runLogger.stageEnd("llm_parallel_generation", "failed", { elapsedSeconds: elapsed, timeoutMs: sddTimeout, failures: failureDetail });
      throw new Error(`SDD generation failed (${failureDetail})`);
    }

    const proseResponse = (proseResult as PromiseFulfilledResult<any>).value;
    const artifactsResponse = (artifactsResult as PromiseFulfilledResult<any>).value;

    console.log(`[SDD] Parallel generation completed in ${elapsed}s`);
    runLogger.stageEnd("llm_parallel_generation", "succeeded", { elapsedSeconds: elapsed, timeoutMs: sddTimeout });

    const proseText = ensureTemplateSections(proseResponse.text, SDD_TEMPLATE_SECTIONS);
    let artifactsText = artifactsResponse.text;

    if (!parseArtifactBlock(artifactsText)) {
      console.warn("[SDD] Primary artifacts call did not produce valid artifact block, retrying with directive prompt...");
      runLogger.stageStart("artifacts_retry");
      let retrySucceeded = false;
      try {
        const retryResponse = await getLLM().create({
          maxTokens: 4096,
          system: `You are a UiPath automation consultant. Output ONLY the orchestrator_artifacts fenced code block. Start your response immediately with \`\`\`orchestrator_artifacts — no prose, no explanation before or after.${contextPrompt}`,
          messages: [{
            role: "user",
            content: `Your previous attempt did not produce valid structured output. Generate ONLY the deployment artifacts block now.\n\n${sddArtifactsPrompt}`
          }],
          timeoutMs: sddTimeout,
        });
        if (parseArtifactBlock(retryResponse.text)) {
          console.log(`[SDD] Artifacts retry succeeded`);
          runLogger.recordRetry("artifacts_retry", 1);
          artifactsText = retryResponse.text;
          retrySucceeded = true;
        } else {
          console.warn(`[SDD] Artifacts retry did not produce valid block`);
          runLogger.recordRetry("artifacts_retry", 1, "Response did not produce valid artifact block");
        }
      } catch (retryErr: any) {
        console.error(`[SDD] Artifacts retry error:`, retryErr?.message);
        runLogger.recordRetry("artifacts_retry", 1, retryErr?.message || "Unknown retry error");
      }
      runLogger.stageEnd("artifacts_retry", retrySucceeded ? "succeeded" : "degraded", { retries: 1 });
    }

    runLogger.stageStart("artifact_validation");
    const ensureResult = await ensureArtifactBlock(proseText, artifactsText);

    const hasBlock = /```orchestrator_artifacts/.test(ensureResult.content);
    console.log(`[SDD] Final document: ${ensureResult.content.length} chars, has artifacts block: ${hasBlock}, artifactsValid: ${ensureResult.artifactsValid}`);
    if (!ensureResult.artifactsValid) {
      console.warn(`[SDD] Artifact validation failed: ${ensureResult.validationResult.failure} — ${ensureResult.validationResult.details}`);
      runLogger.stageEnd("artifact_validation", "degraded", {
        artifactsValid: false,
        failure: ensureResult.validationResult.failure,
      });
    } else {
      runLogger.stageEnd("artifact_validation", "succeeded", { artifactsValid: true, hasWarnings: ensureResult.artifactWarnings.length > 0 });
    }
    if (ensureResult.artifactWarnings.length > 0) {
      console.warn(`[SDD] Artifact warnings: ${ensureResult.artifactWarnings.join("; ")}`);
    }

    const outcome = runLogger.buildOutcomeSummary();
    await runLogger.flush();
    const sddFinalStatus = outcome.status === "succeeded_degraded"
      ? "completed_with_warnings"
      : outcome.status === "failed" ? "failed" : "completed";
    try {
      await storage.completeGenerationRun(sddRunId, {
        status: sddFinalStatus,
        outcomeReport: JSON.stringify(outcome),
      });
    } catch {}

    return { content: ensureResult.content, artifactsValid: ensureResult.artifactsValid, artifactWarnings: ensureResult.artifactWarnings };
    } catch (sddErr: any) {
      const runningStages = runLogger.getStages().filter(s => s.outcome === "running");
      for (const rs of runningStages) {
        runLogger.stageEnd(rs.stage, "failed", undefined, sddErr?.message);
      }
      const failOutcome = runLogger.buildOutcomeSummary({ status: "failed", errorMessage: sddErr?.message });
      await runLogger.flush();
      try {
        await storage.failGenerationRun(sddRunId, sddErr?.message || "Unknown SDD generation error");
        await storage.completeGenerationRun(sddRunId, {
          status: "failed",
          outcomeReport: JSON.stringify(failOutcome),
        });
      } catch {}
      throw sddErr;
    }
  }

  const pddRunId = `${docType.toLowerCase()}-${ideaId}-${Date.now()}`;
  const pddLogger = new RunLogger(pddRunId, docType, onStageEvent);

  try {
    await storage.createGenerationRun({
      ideaId,
      runId: pddRunId,
      status: "running",
      generationMode: `${docType.toLowerCase()}_generation`,
      triggeredBy: "manual",
    });
  } catch (e: any) {
    console.warn(`[${docType}] Failed to create generation run record: ${e.message}`);
  }

  pddLogger.stageStart("llm_generation");
  const prompt = docType === "PDD"
    ? buildPddTemplatePrompt()
    : docType === "DSD"
      ? buildDsdTemplatePrompt()
      : UIPATH_PROMPT;
  const maxTokens = 4096;
  try {
    const response = await getLLM().create({
      maxTokens: maxTokens,
      system: `You are a professional automation consultant generating formal documents for the "${idea.title}" project. Be specific and use details from the conversation.${contextPrompt}`,
      messages: [...chatMessages, { role: "user", content: prompt }],
    });
    pddLogger.stageEnd("llm_generation", "succeeded");

    const outcome = pddLogger.buildOutcomeSummary();
    await pddLogger.flush();
    try {
      await storage.completeGenerationRun(pddRunId, {
        status: "completed",
        outcomeReport: JSON.stringify(outcome),
      });
    } catch {}

    const normalizedContent = docType === "PDD"
      ? ensureTemplateSections(response.text, PDD_TEMPLATE_SECTIONS)
      : docType === "DSD"
        ? ensureTemplateSections(response.text, DSD_TEMPLATE_SECTIONS)
        : response.text;

    return { content: normalizedContent };
  } catch (docErr: any) {
    pddLogger.stageEnd("llm_generation", "failed", undefined, docErr?.message);
    const failOutcome = pddLogger.buildOutcomeSummary({ status: "failed", errorMessage: docErr?.message });
    await pddLogger.flush();
    try {
      await storage.failGenerationRun(pddRunId, docErr?.message || `${docType} generation failed`);
      await storage.completeGenerationRun(pddRunId, {
        status: "failed",
        outcomeReport: JSON.stringify(failOutcome),
      });
    } catch {}
    throw docErr;
  }
}

export function registerDocumentRoutes(app: Express): void {
  app.get("/api/ideas/:ideaId/artifacts", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    try {
      const idea = await storage.getIdea(ideaId);
      if (!idea) return res.status(404).json({ message: "Idea not found" });

      const pdd = await documentStorage.getLatestDocument(ideaId, "PDD");
      const sdd = await documentStorage.getLatestDocument(ideaId, "SDD");
      const dsd = await documentStorage.getLatestDocument(ideaId, "DSD");
      const pddApproval = await documentStorage.getApproval(ideaId, "PDD");
      const sddApproval = await documentStorage.getApproval(ideaId, "SDD");
      const dsdApproval = await documentStorage.getApproval(ideaId, "DSD");

      const asIsNodes = await processMapStorage.getNodesByIdeaId(ideaId, "as-is");
      const toBeNodes = await processMapStorage.getNodesByIdeaId(ideaId, "to-be");
      const asIsApproval = await processMapStorage.getApproval(ideaId, "as-is");
      const toBeApproval = await processMapStorage.getApproval(ideaId, "to-be");

      const messages = await chatStorage.getMessagesByIdeaId(ideaId);
      const uipathMsg = [...messages].reverse().find((m) => m.content.startsWith("[UIPATH:"));
      let uipathData: { projectName?: string; workflowCount?: number; dependencyCount?: number } | null = null;
      if (uipathMsg) {
        try {
          const pkg = JSON.parse(uipathMsg.content.slice(8, -1));
          uipathData = {
            projectName: pkg.projectName,
            workflowCount: pkg.workflows?.length || 0,
            dependencyCount: pkg.dependencies?.length || 0,
          };
        } catch {}
      }

      const artifacts = [
        {
          type: "as-is" as const,
          label: "As-Is Process Map",
          exists: asIsNodes.length > 0,
          status: asIsApproval && !asIsApproval.invalidated ? "Approved" : asIsNodes.length > 0 ? "Draft" : "Not Generated",
          version: asIsApproval?.version || null,
          nodeCount: asIsNodes.length,
        },
        {
          type: "to-be" as const,
          label: "To-Be Process Map",
          exists: toBeNodes.length > 0,
          status: toBeApproval && !toBeApproval.invalidated ? "Approved" : toBeNodes.length > 0 ? "Draft" : "Not Generated",
          version: toBeApproval?.version || null,
          nodeCount: toBeNodes.length,
        },
        {
          type: "pdd" as const,
          label: "Process Design Document",
          exists: !!pdd,
          status: pddApproval ? "Approved" : pdd ? (pdd.status === "approved" ? "Approved" : "Draft") : "Not Generated",
          version: pdd?.version || null,
        },
        {
          type: "sdd" as const,
          label: "Solution Design Document",
          exists: !!sdd,
          status: sddApproval ? "Approved" : sdd ? (sdd.status === "approved" ? "Approved" : "Draft") : "Not Generated",
          version: sdd?.version || null,
          artifactsValid: sdd?.artifactsValid ?? null,
          ...(sdd && sdd.artifactsValid === false ? { blockedReason: "Deployment artifacts are missing or invalid. Revise the SDD to regenerate artifacts." } : {}),
          ...(sdd?.artifactWarnings ? { artifactWarnings: JSON.parse(sdd.artifactWarnings) } : {}),
        },
        {
          type: "dsd" as const,
          label: "Detailed Solution Design Document",
          exists: !!dsd,
          status: dsdApproval ? "Approved" : dsd ? (dsd.status === "approved" ? "Approved" : "Draft") : "Not Generated",
          version: dsd?.version || null,
        },
        {
          type: "uipath" as const,
          label: "UiPath Solution Export (.uis)",
          exists: !!uipathMsg,
          status: uipathMsg ? "Generated" : "Not Generated",
          version: null,
          meta: uipathData ? {
            ...uipathData,
            solutionAvailable: !!getCachedPipelineResult(ideaId)?.solutionArtifact,
          } : null,
        },
        {
          type: "test-automation" as const,
          label: "UiPath Test Automation Pack",
          exists: !!getCachedPipelineResult(ideaId)?.testAutomationArtifact,
          status: getCachedPipelineResult(ideaId)?.testAutomationArtifact ? "Generated" : "Not Generated",
          version: null,
          meta: getCachedPipelineResult(ideaId)?.testAutomationArtifact ? {
            projectName: getCachedPipelineResult(ideaId)?.testAutomationArtifact?.projectName,
            workflowCount: getCachedPipelineResult(ideaId)?.testAutomationArtifact?.workflowCount,
            dependencyCount: 2,
          } : null,
        },
        {
          type: "dhg" as const,
          label: "Developer Handoff Guide",
          exists: !!uipathMsg,
          status: uipathMsg ? "Available" : "Not Generated",
          version: null,
        },
      ];

      return res.json({ artifacts });
    } catch (error) {
      console.error("Error fetching artifacts summary:", error);
      return res.status(500).json({ message: "Failed to fetch artifacts" });
    }
  });

  app.get("/api/ideas/:ideaId/uipath-artifact-meta", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    try {
      const messages = await chatStorage.getMessagesByIdeaId(ideaId);
      const uipathMsg = findUiPathMessage(messages);
      if (!uipathMsg) {
        return res.status(404).json({ message: "No UiPath artifacts found" });
      }

      let pkg: UiPathPackage;
      try {
        pkg = parseUiPathPackage(uipathMsg);
      } catch {
        return res.status(500).json({ message: "Invalid UiPath package data" });
      }

      const pipelineResult = getCachedPipelineResult(ideaId);
      const solutionManifest = pipelineResult?.solutionArtifact?.manifest;
      const recommendation = solutionManifest?.recommendation || pipelineResult?.deliveryRecommendation || null;
      const preferredFormat = recommendation?.recommendedOutput === "package" ? "package" : "solution";

      return res.json({
        projectName: pkg.projectName || "UiPathPackage",
        description: pkg.description || "",
        dependencies: pkg.dependencies || [],
        workflows: pkg.workflows || [],
        preferredFormat,
        testAutomation: pipelineResult?.testAutomationArtifact ? {
          fileName: pipelineResult.testAutomationArtifact.fileName,
          projectName: pipelineResult.testAutomationArtifact.projectName,
          version: pipelineResult.testAutomationArtifact.version,
          workflowCount: pipelineResult.testAutomationArtifact.workflowCount,
          workflowFiles: pipelineResult.testAutomationArtifact.workflowFiles,
          testCases: pipelineResult.testAutomationArtifact.testCases,
          testSets: pipelineResult.testAutomationArtifact.testSets,
        } : null,
        solution: solutionManifest ? {
          fileName: pipelineResult?.solutionArtifact?.fileName,
          solutionName: solutionManifest.solutionName,
          displayName: solutionManifest.displayName,
          version: solutionManifest.version,
          automationType: solutionManifest.automationType,
          recommendation: solutionManifest.recommendation || pipelineResult?.deliveryRecommendation || null,
          operatingModel: solutionManifest.operatingModel || null,
          releaseReadiness: solutionManifest.releaseReadiness || null,
          testRelease: solutionManifest.testRelease || null,
          reporting: solutionManifest.reporting || null,
          executiveSummary: solutionManifest.executiveSummary || null,
          testCases: solutionManifest.testCases || pipelineResult?.testCases || [],
          testSets: solutionManifest.testSets || pipelineResult?.testSets || [],
          componentCount: solutionManifest.components.length,
          components: solutionManifest.components,
          resources: solutionManifest.resources,
          deploymentSupport: solutionManifest.deploymentSupport,
        } : null,
      });
    } catch (error) {
      console.error("Error fetching UiPath artifact metadata:", error);
      return res.status(500).json({ message: "Failed to fetch UiPath artifact metadata" });
    }
  });

  app.get("/api/ideas/:ideaId/documents", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;
    const docs = await documentStorage.getDocumentsByIdea(ideaId);
    return res.json(docs);
  });

  app.get("/api/ideas/:ideaId/documents/versions/:type", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;
    const docType = req.params.type as string;
    const versions = await documentStorage.getDocumentVersions(ideaId, docType);
    return res.json(versions);
  });

  app.get("/api/ideas/:ideaId/documents/latest/:type", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;
    const docType = req.params.type as string;
    const doc = await documentStorage.getLatestDocument(ideaId, docType);
    const approval = await documentStorage.getApproval(ideaId, docType);
    return res.json({ document: doc || null, approval: approval || null });
  });

  app.post("/api/ideas/:ideaId/documents/generate", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    const { type } = req.body;
    if (!type || !["PDD", "SDD", "DSD"].includes(type)) {
      return res.status(400).json({ message: "Invalid document type" });
    }

    const lockResult = acquireDocGenerationLock(ideaId, type);
    if (!lockResult.acquired) {
      console.warn(`[Document Generate] Rejected duplicate ${type} generation for idea=${ideaId} — ${lockResult.reason}`);
      return res.status(409).json({ message: `${type} generation already in progress` });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sseWrite = (data: Record<string, unknown>) => {
      try {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
          if (typeof (res as any).flush === "function") (res as any).flush();
        }
      } catch {}
    };

    const onStageEvent: StageEventListener = (event) => {
      sseWrite({ stageEvent: event });
    };

    try {
      const existing = await documentStorage.getLatestDocument(ideaId, type);
      const version = existing ? existing.version + 1 : 1;

      if (existing && existing.status !== "approved") {
        await documentStorage.updateDocument(existing.id, { status: "superseded" });
      }

      const genResult = await generateDocument(ideaId, type, onStageEvent);

      if (isGenerationCancelled(ideaId, type)) {
        console.warn(`[Document Generate] ${type} generation for idea=${ideaId} was cancelled during execution — discarding results`);
        sseWrite({ error: true, message: `${type} generation was cancelled due to map re-approval` });
        res.end();
        return;
      }

      let content = genResult.content;
      const artifactsValid = type === "SDD" ? (genResult.artifactsValid ?? null) : null;
      const artifactWarnings = type === "SDD" && genResult.artifactWarnings?.length
        ? JSON.stringify(genResult.artifactWarnings) : null;

      const nodes = type === "PDD"
        ? await processMapStorage.getNodesByIdeaId(ideaId, "as-is")
        : [];
      const snapshot = JSON.stringify({ generatedFrom: type === "PDD" ? "as-is-map" : type === "SDD" ? "pdd" : "sdd", nodes });

      if (type === "PDD") {
        try {
          const asIsNodes = await processMapStorage.getNodesByIdeaId(ideaId, "as-is");
          const toBeNodes = await processMapStorage.getNodesByIdeaId(ideaId, "to-be");
          const ts = Date.now();

          if (asIsNodes.length > 0 && !content.includes(`/process-map/image?viewType=as-is`)) {
            const asIsImg = `\n\n![As-Is Process Map](/api/ideas/${ideaId}/process-map/image?viewType=as-is&v=${ts})`;
            const asIsHeadingMatch = content.match(/#{1,3}\s.*As[- ]Is\s+Process\s+(Description|Map)/i);
            if (asIsHeadingMatch) {
              const insertIdx = (asIsHeadingMatch.index || 0) + asIsHeadingMatch[0].length;
              content = content.slice(0, insertIdx) + asIsImg + content.slice(insertIdx);
            } else {
              content += `\n\n### As-Is Process Map${asIsImg}\n`;
            }
          }

          if (toBeNodes.length > 0 && !content.includes(`/process-map/image?viewType=to-be`)) {
            const toBeImg = `\n\n![To-Be Process Map](/api/ideas/${ideaId}/process-map/image?viewType=to-be&v=${ts})`;
            const toBeHeadingMatch = content.match(/#{1,3}\s.*To[- ]Be\s+Process\s+(Description|Map)/i);
            if (toBeHeadingMatch) {
              const insertIdx = (toBeHeadingMatch.index || 0) + toBeHeadingMatch[0].length;
              content = content.slice(0, insertIdx) + toBeImg + content.slice(insertIdx);
            } else {
              content += `\n\n### To-Be Process Map${toBeImg}\n`;
            }
          }
        } catch (imgErr: any) {
          console.warn(`[Document Generate] Could not inject process map images into PDD:`, imgErr?.message);
        }
      }

      const doc = await documentStorage.createDocument({
        ideaId,
        type,
        version,
        status: "draft",
        content,
        snapshotJson: snapshot,
        artifactsValid,
        artifactWarnings,
      });

      if (type === "SDD" && artifactsValid === false) {
        await chatStorage.createMessage(
          ideaId,
          "assistant",
          "⚠️ **SDD generated, but deployment artifacts are missing or invalid.** The document has been saved, but it cannot be approved for package generation until valid deployment artifacts are present. You can request a revision to regenerate the artifacts section."
        );
      } else if (type === "SDD" && artifactWarnings) {
        const warnings = genResult.artifactWarnings || [];
        await chatStorage.createMessage(
          ideaId,
          "assistant",
          `ℹ️ **SDD generated with minor artifact warnings.** The document is valid and can be approved, but some artifact entries have missing optional fields that will use defaults:\n${warnings.map(w => `- ${w}`).join("\n")}`
        );
      }

      await chatStorage.createMessage(
        ideaId,
        "assistant",
        `[DOC:${type}:${doc.id}]${content}`
      );

      sseWrite({ done: true, doc });
      res.end();
    } catch (error: any) {
      const msg = error?.message || error?.toString() || "Unknown error";
      console.error(`Error generating ${type}:`, msg);
      if (error?.status) console.error(`API status: ${error.status}`);
      sseWrite({ error: true, message: `Failed to generate ${type}: ${msg.slice(0, 200)}` });
      res.end();
    } finally {
      releaseDocGenerationLock(ideaId, type);
      const pending = consumePendingInvalidation(ideaId);
      if (pending) {
        console.log(`[Document Generate] Running deferred cascade invalidation for idea=${ideaId} after ${type} generation completed`);
        try {
          const { cascadeInvalidate } = await import("./cascade-invalidation");
          const existingApproval = await processMapStorage.getApproval(ideaId, pending.viewType);
          await cascadeInvalidate(ideaId, pending.viewType, existingApproval || { deferred: true }, pending.nextVersion);
        } catch (cascadeErr: any) {
          console.error(`[Document Generate] Deferred cascade invalidation failed:`, cascadeErr?.message);
        }
      }
      await runCompletionCallbacks(ideaId);
    }
  });

  app.post("/api/ideas/:ideaId/documents/:docId/approve", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    const docId = parseInt(req.params.docId as string);
    const doc = await documentStorage.getDocument(docId);
    if (!doc || doc.ideaId !== ideaId) {
      return res.status(404).json({ message: "Document not found" });
    }

    try {
      const result = await approveDocument({
        ideaId,
        docType: doc.type as "PDD" | "SDD" | "DSD",
        docId,
        userId: req.session.userId!,
        activeRole: req.session.activeRole,
      });
      if (result.alreadyApproved) {
        return res.status(400).json({ message: "Already approved" });
      }
      return res.json(result);
    } catch (err: any) {
      return res.status(400).json({ message: err.message });
    }
  });

  app.post("/api/ideas/:ideaId/documents/revise", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    const { type, revision } = req.body;
    if (!type || !revision) {
      return res.status(400).json({ message: "type and revision required" });
    }

    try {
      const currentDoc = await documentStorage.getLatestDocument(ideaId, type);
      if (!currentDoc) {
        return res.status(404).json({ message: "No document to revise" });
      }

      await chatStorage.createMessage(ideaId, "user", revision);

      const idea = await storage.getIdea(ideaId);
      if (!idea) return res.status(404).json({ message: "Idea not found" });

      const history = await chatStorage.getMessagesByIdeaId(ideaId);
      const chatMessages = sanitizeChatForLLM(history);

      const revisionPrompt = `The user has requested a revision to the ${type}. Here is the current document:\n\n${currentDoc.content}\n\nRevision request: ${revision}\n\nPlease regenerate the complete ${type} with this revision applied. Keep the same section structure (## headings). Output only the revised document.`;

      const response = await getLLM().create({
        maxTokens: 8192,
        system: `You are a professional automation consultant revising a ${type} for the "${idea.title}" project.`,
        messages: [...chatMessages, { role: "user", content: revisionPrompt }],
      });

      let content = response.text;
      let artifactsValid: boolean | null = null;
      let artifactWarnings: string | null = null;

      if (type === "SDD" && content.length > 0) {
        const ensureResult = await ensureArtifactBlock(content);
        content = ensureResult.content;
        artifactsValid = ensureResult.artifactsValid;
        artifactWarnings = ensureResult.artifactWarnings.length > 0
          ? JSON.stringify(ensureResult.artifactWarnings) : null;
      }

      await documentStorage.updateDocument(currentDoc.id, { status: "superseded" });

      const doc = await documentStorage.createDocument({
        ideaId,
        type,
        version: currentDoc.version + 1,
        status: "draft",
        content,
        snapshotJson: currentDoc.snapshotJson,
        artifactsValid,
        artifactWarnings,
      });

      await chatStorage.createMessage(
        ideaId,
        "assistant",
        `[DOC:${type}:${doc.id}]${content}`
      );

      return res.json(doc);
    } catch (error) {
      console.error(`Error revising ${type}:`, error);
      return res.status(500).json({ message: `Failed to revise ${type}` });
    }
  });

  app.post("/api/ideas/:ideaId/generate-uipath", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    const triggerSource: TriggerSource = (req.query.trigger as TriggerSource) || "manual";
    const forceRegenerate = !!req.query.force;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();

    const heartbeatInterval = setInterval(() => {
      try {
        if (res.writableEnded) { clearInterval(heartbeatInterval); return; }
        res.write(`data: ${JSON.stringify({ heartbeat: true })}\n\n`);
        if (typeof (res as any).flush === "function") (res as any).flush();
      } catch {}
    }, 15000);
    req.on("close", () => clearInterval(heartbeatInterval));

    const sendProgress = (message: string) => {
      try {
        if (res.writableEnded) return;
        res.write(`data: ${JSON.stringify({ progress: message })}\n\n`);
        if (typeof (res as any).flush === "function") (res as any).flush();
      } catch {}
    };

    let requestedMode: "baseline_openable" | "full_implementation" | undefined;
    if (req.body?.generationMode === "baseline_openable") {
      requestedMode = "baseline_openable";
    }

    let userMetaValidationMode: MetaValidationMode = "Auto";
    try {
      const storedMode = await storage.getAppSetting(`meta_validation_mode_${req.session.userId}`);
      if (storedMode === "Always" || storedMode === "Off" || storedMode === "Auto") {
        userMetaValidationMode = storedMode;
      }
    } catch {}

    function buildOutcomeSummary(outcomeReport: any) {
      if (!outcomeReport) return undefined;
      return {
        stubbedActivities: outcomeReport.remediations.filter((r: any) => r.level === "activity").length,
        stubbedSequences: outcomeReport.remediations.filter((r: any) => r.level === "sequence").length,
        stubbedWorkflows: outcomeReport.remediations.filter((r: any) => r.level === "workflow").length,
        autoRepairs: outcomeReport.autoRepairs.length,
        fullyGenerated: outcomeReport.fullyGeneratedFiles.length,
        totalEstimatedMinutes: outcomeReport.totalEstimatedEffortMinutes,
      };
    }

    const callbacks: RunCallbacks = {
      onProgress: sendProgress,
      onPipelineEvent: (event) => {
        try {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify({ pipelineEvent: event })}\n\n`);
          if (typeof (res as any).flush === "function") (res as any).flush();
          if (event.type === "completed" || event.type === "started") {
            sendProgress(event.message);
          }
        } catch {}
      },
      onMetaValidation: (event) => {
        try {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify({ metaValidation: event })}\n\n`);
        } catch {}
      },
      onComplete: (result: RunResult) => {
        try {
          if (res.writableEnded) return;
          clearInterval(heartbeatInterval);
          const outcomeSummary = result.pipelineResult?.outcomeReport
            ? buildOutcomeSummary(result.pipelineResult.outcomeReport)
            : undefined;
          res.write(`data: ${JSON.stringify({
            done: true,
            package: result.packageJson,
            status: result.status,
            warnings: result.pipelineResult?.warnings || [],
            templateComplianceScore: result.pipelineResult?.templateComplianceScore,
            outcomeSummary,
          })}\n\n`);
          res.end();
        } catch {}
      },
      onFail: (error: string, context?: Record<string, any>) => {
        try {
          if (res.writableEnded) return;
          clearInterval(heartbeatInterval);
          const payload: Record<string, any> = {
            done: false,
            status: "FAILED",
            error,
          };
          if (context?.stage) payload.stage = context.stage;
          if (context?.packageJson) payload.package = context.packageJson;
          if (context?.qualityGateWarning) {
            payload.qualityGateWarning = true;
            payload.qualityGateViolations = context.qualityGateViolations;
            payload.qualityGateSummary = context.qualityGateSummary;
          }
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
          res.end();
        } catch {}
      },
    };

    try {
      await startUiPathGenerationRun(ideaId, triggerSource, {
        generationMode: requestedMode,
        metaValidationMode: userMetaValidationMode,
        forceRegenerate,
        callbacks,
      });
    } catch (err: any) {
      clearInterval(heartbeatInterval);
      if (err.message.includes("already in progress")) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ done: false, status: "FAILED", error: err.message })}\n\n`);
          res.end();
        }
        return;
      }
      console.error("Error starting UiPath generation run:", err);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ done: false, status: "FAILED", error: err.message || "Failed to start generation" })}\n\n`);
        res.end();
      }
    }
  });

  app.get("/api/ideas/:ideaId/download-uipath", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    try {
      const sddApprovalCheck = await documentStorage.getApproval(ideaId, "SDD");
      if (!sddApprovalCheck) {
        return res.status(400).json({ message: "SDD must be approved first" });
      }

      const idea = await storage.getIdea(ideaId);
      if (!idea) return res.status(404).json({ message: "Idea not found" });

      const messages = await chatStorage.getMessagesByIdeaId(ideaId);
      const pipelineResult = getCachedPipelineResult(ideaId);
      if (!pipelineResult) {
        return res.status(404).json({
          error: "PACKAGE_NOT_BUILT",
          message: "No package has been successfully generated for this idea. Use the Generate Package action to build one first.",
        });
      }
      console.log(`[Download] Serving cached pipeline result for ${ideaId}`);

      const uipathMsg = findUiPathMessage(messages);
      if (!uipathMsg) {
        return res.status(404).json({
          error: "PACKAGE_NOT_BUILT",
          message: "No package has been successfully generated for this idea. Use the Generate Package action to build one first.",
        });
      }

      let pkg;
      try {
        pkg = parseUiPathPackage(uipathMsg);
      } catch {
        return res.status(500).json({ message: "Invalid package data" });
      }

      const requestedFormat = String(req.query.format || "").toLowerCase();
      const recommendedFormat = pipelineResult.deliveryRecommendation?.recommendedOutput === "package" ? "package" : "solution";
      const effectiveFormat = requestedFormat === "package" || requestedFormat === "solution"
        ? requestedFormat
        : recommendedFormat;

      if (effectiveFormat === "solution") {
        if (!pipelineResult.solutionArtifact?.buffer || pipelineResult.solutionArtifact.buffer.length === 0) {
          return res.status(500).json({
            error: "SOLUTION_BUNDLE_EMPTY",
            message: "Native UiPath solution export is unavailable for this build. Please regenerate the artifacts.",
          });
        }

        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Disposition", `attachment; filename="${pipelineResult.solutionArtifact.fileName}"`);
        res.end(pipelineResult.solutionArtifact.buffer);
        return;
      }

      if (!pipelineResult.packageBuffer || pipelineResult.packageBuffer.length === 0) {
        return res.status(500).json({
          error: "PACKAGE_EMPTY",
          message: "Package buffer is empty. Please regenerate the package.",
        });
      }

      const approvedSdd = await documentStorage.getDocument(sddApprovalCheck.documentId);
      const sddContent = approvedSdd?.content || "";

      const isServerless = pkg.internal?.targetFramework === "Portable" || pkg.internal?.isServerless;
      const libPrefix = isServerless ? "lib/net6.0/" : "lib/net45/";

      type ZipEntry = { name: string; content: string | Buffer };
      let zipEntries: ZipEntry[] | null = null;

      if (pipelineResult.xamlEntries && pipelineResult.xamlEntries.length > 0 && pipelineResult.archiveManifest) {
        try {
          const entries: ZipEntry[] = [];
          const xamlByBasename = new Map<string, string>();
          const xamlByFullPath = new Map<string, string>();
          for (const entry of pipelineResult.xamlEntries) {
            xamlByBasename.set(entry.name, entry.content);
            xamlByFullPath.set(entry.name, entry.content);
          }

          const nugetMetaPrefixes = ["_rels/", "package/", "[Content_Types].xml"];
          for (const archivePath of pipelineResult.archiveManifest) {
            if (nugetMetaPrefixes.some(p => archivePath.startsWith(p)) || archivePath.endsWith(".nuspec")) {
              continue;
            }
            const flatName = archivePath.startsWith(libPrefix) ? archivePath.slice(libPrefix.length) : archivePath;
            const basename = archivePath.split("/").pop() || archivePath;

            if (archivePath.endsWith(".xaml")) {
              const xamlContent = xamlByFullPath.get(archivePath) || xamlByFullPath.get(flatName) || xamlByBasename.get(basename);
              if (xamlContent) {
                entries.push({ name: flatName, content: xamlContent });
              } else {
                console.warn(`[Download] XAML entry not found in cached entries: ${archivePath}`);
              }
            } else if (archivePath.endsWith("project.json")) {
              // Fallback audit: studioVersion, expressionLanguage, targetFramework,
              // sourceLanguage all resolve from MetadataService below. Audited files:
              // - document-routes.ts: this site (was hardcoded 23.10.6/22.10.11, now MetadataService)
              // - package-assembler.ts: uses _studioProfile/_metaTarget chain, no version literals
              // - metadata-service.ts: reads from catalog JSON, no hardcoded versions
              // - studio-profile.ts: reads from catalog JSON, no hardcoded versions
              const _metaTarget = metadataService.getStudioTarget();
              if (!_metaTarget) {
                console.error("[document-routes] MetadataService has no studio target — project.json fields will use fallback defaults.");
              }
              const _resolvedFramework = _metaTarget ? (isServerless ? "Portable" : _metaTarget.targetFramework) : (isServerless ? "Portable" : "Windows");
              const _resolvedLang = _resolvedFramework === "Portable" ? "CSharp" : (_metaTarget?.expressionLanguage || "VisualBasic");
              const projectJson: Record<string, any> = {
                name: pipelineResult.projectName,
                description: pkg.description || "",
                main: "Main.xaml",
                dependencies: pipelineResult.dependencyMap || {},
                webServices: [],
                entitiesStores: [],
                schemaVersion: "4.0",
                studioVersion: _metaTarget?.version || "",
                projectVersion: "1.0.0",
                runtimeOptions: {
                  autoDispose: false,
                  netFrameworkLazyLoading: false,
                  isPausable: true,
                  isAttended: false,
                  requiresUserInteraction: false,
                  supportsPersistence: false,
                  executionType: "Workflow",
                  readyForPiP: false,
                  startsInPiP: false,
                  mustRestoreAllDependencies: true,
                },
                designOptions: {
                  projectProfile: "Developement",
                  outputType: "Process",
                  libraryOptions: { includeOriginalXaml: false, privateWorkflows: [] },
                  processOptions: { ignoredFiles: [] },
                  fileInfoCollection: [],
                  modernBehavior: true,
                },
                expressionLanguage: _resolvedLang,
                entryPoints: [{ filePath: "Main.xaml", uniqueId: "00000000-0000-0000-0000-000000000000", input: [], output: [] }],
                isTemplate: false,
                templateProjectData: {},
                publishData: {},
                targetFramework: _resolvedFramework,
                sourceLanguage: _resolvedLang,
              };
              entries.push({ name: flatName, content: JSON.stringify(projectJson, null, 2) });
            } else if (archivePath.endsWith("DeveloperHandoffGuide.md") && pipelineResult.dhgContent) {
              entries.push({ name: flatName, content: pipelineResult.dhgContent });
            } else if (archivePath.endsWith("Config.xlsx") || archivePath.endsWith("Data/Config.xlsx")) {
              const configContent = generateConfigXlsx(pipelineResult.projectName, sddContent);
              entries.push({ name: flatName, content: configContent });
            } else {
              console.warn(`[Download] Skipping non-reconstructable entry: ${archivePath}`);
            }
          }
          if (entries.length > 0 && entries.some(e => e.name === "Main.xaml" || e.name.endsWith("/Main.xaml"))) {
            zipEntries = entries;
            console.log(`[Download] Prepared ${entries.length} entries from ${pipelineResult.xamlEntries.length} cached XAML entries`);
          } else {
            console.warn(`[Download] Cache-based build produced ${entries.length} entries (missing Main.xaml) — falling back`);
          }
        } catch (entryErr: unknown) {
          const msg = entryErr instanceof Error ? entryErr.message : String(entryErr);
          console.warn(`[Download] Failed to build entries from cache: ${msg} — falling back`);
          zipEntries = null;
        }
      }

      if (!zipEntries) {
        if (!pipelineResult.packageBuffer || pipelineResult.packageBuffer.length === 0) {
          return res.status(500).json({
            error: "PACKAGE_EMPTY",
            message: "Package buffer is empty. Please regenerate the package.",
          });
        }

        try {
          const nupkgZip = new AdmZip(pipelineResult.packageBuffer);
          const nupkgEntries = nupkgZip.getEntries();
          const entries: ZipEntry[] = [];
          for (const entry of nupkgEntries) {
            if (entry.isDirectory) continue;
            const entryName: string = entry.entryName;
            if (entryName.startsWith("_rels/") || entryName.startsWith("package/") || entryName === "[Content_Types].xml" || entryName.endsWith(".nuspec")) {
              continue;
            }
            const flatName = entryName.startsWith(libPrefix) ? entryName.slice(libPrefix.length) : entryName;
            entries.push({ name: flatName, content: entry.getData() });
          }
          zipEntries = entries;
          console.log(`[Download] Built entries from nupkg buffer via adm-zip fallback`);
        } catch (zipErr: unknown) {
          const msg = zipErr instanceof Error ? zipErr.message : String(zipErr);
          console.error(`[Download] adm-zip fallback also failed: ${msg} — serving raw nupkg`);
          res.setHeader("Content-Type", "application/octet-stream");
          res.setHeader("Content-Disposition", `attachment; filename="${pkg.projectName || "UiPathPackage"}.nupkg"`);
          res.end(pipelineResult.packageBuffer);
          return;
        }
      }

      const archive = archiver("zip", { zlib: { level: 9 } });
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${pkg.projectName || "UiPathPackage"}.zip"`);
      archive.pipe(res);

      for (const entry of zipEntries) {
        archive.append(entry.content, { name: entry.name });
      }

      const autoType = idea.automationType as string || "";
      if (autoType === "agent" || autoType === "hybrid") {
        const agentName = (pkg.projectName || idea.title).replace(/\s+/g, "_");

        const systemPrompt = extractAgentPrompt(sddContent, "system", pkg);
        archive.append(systemPrompt, { name: "prompts/system_prompt.txt" });

        const userPromptTemplate = extractAgentPrompt(sddContent, "user", pkg);
        archive.append(userPromptTemplate, { name: "prompts/user_prompt_template.txt" });

        const toolDefs = extractToolDefinitions(sddContent, pkg);
        archive.append(JSON.stringify(toolDefs, null, 2), { name: "tools/tool_definitions.json" });

        const kbPlaceholder = generateKBPlaceholder(sddContent, pkg);
        archive.append(kbPlaceholder, { name: "knowledge/kb_placeholder.md" });

        const agentConfig = generateAgentConfig(agentName, sddContent, pkg);
        archive.append(JSON.stringify(agentConfig, null, 2), { name: `agents/${agentName}_config.json` });
      }

      await archive.finalize();
    } catch (error) {
      console.error("Error generating ZIP:", error);
      if (!res.headersSent) {
        return res.status(500).json({ message: "Failed to generate ZIP" });
      }
    }
  });

  app.get("/api/ideas/:ideaId/download-uipath-tests", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    try {
      const pipelineResult = getCachedPipelineResult(ideaId);
      if (!pipelineResult?.testAutomationArtifact?.buffer?.length) {
        return res.status(404).json({
          error: "TEST_AUTOMATION_NOT_BUILT",
          message: "No UiPath test automation artifact has been generated for this idea yet.",
        });
      }

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${pipelineResult.testAutomationArtifact.fileName}"`);
      res.end(pipelineResult.testAutomationArtifact.buffer);
    } catch (error) {
      console.error("Error downloading UiPath test automation artifact:", error);
      return res.status(500).json({ message: "Failed to download UiPath test automation artifact" });
    }
  });

  app.get("/api/ideas/:ideaId/dhg", async (req: Request, res: Response) => {
    const ideaId = await verifyIdeaAccess(req, res);
    if (!ideaId) return;

    try {
      const messages = await chatStorage.getMessagesByIdeaId(ideaId);
      const uipathMsg = findUiPathMessage(messages);
      if (!uipathMsg) {
        return res.status(404).json({ message: "No UiPath package found. Generate the package first." });
      }

      let pkg;
      try {
        pkg = parseUiPathPackage(uipathMsg);
      } catch {
        return res.status(500).json({ message: "Invalid package data" });
      }

      const dhgResult = await generateDhg(ideaId, pkg);
      res.json({ content: dhgResult.dhgContent, projectName: dhgResult.projectName });
    } catch (error) {
      console.error("Error generating DHG:", error);
      if (!res.headersSent) {
        return res.status(500).json({ message: "Failed to generate Developer Handoff Guide" });
      }
    }
  });

  app.get("/api/ideas/:ideaId/export", async (req: Request, res: Response) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    const ideaId = req.params.ideaId as string;

    const types = ((req.query.types as string) || "").split(",").filter(Boolean);
    const validTypes = ["as-is", "to-be", "pdd", "sdd", "dsd"];
    const requestedTypes = types.length ? types.filter(t => validTypes.includes(t.toLowerCase())) : validTypes;

    if (!requestedTypes.length) {
      return res.status(400).json({ message: "No valid document types specified. Use: as-is, to-be, pdd, sdd, dsd" });
    }

    try {
      const idea = await storage.getIdea(ideaId);
      const ideaTitle = idea?.title || "Untitled Idea";
      const docChildren: (Paragraph | Table)[] = [];

      const ORANGE = "E8450A";
      const getTemplateSectionList = (docType: string): readonly string[] | null => {
        if (docType === "PDD") return PDD_TEMPLATE_SECTIONS;
        if (docType === "SDD") return SDD_TEMPLATE_SECTIONS;
        if (docType === "DSD") return DSD_TEMPLATE_SECTIONS;
        return null;
      };

      docChildren.push(new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: `Document Export: ${ideaTitle}`, bold: true, size: 48, color: ORANGE })],
        spacing: { after: 200 },
      }));
      docChildren.push(new Paragraph({
        children: [
          new TextRun({ text: "Exported: ", bold: true, size: 20, color: "999999" }),
          new TextRun({ text: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), size: 20, color: "999999" }),
        ],
        spacing: { after: 100 },
      }));
      docChildren.push(new Paragraph({
        children: [
          new TextRun({ text: "Idea ID: ", bold: true, size: 20, color: "999999" }),
          new TextRun({ text: ideaId, size: 20, color: "999999", font: "Courier New" }),
        ],
        spacing: { after: 400 },
      }));
      docChildren.push(new Paragraph({
        children: [new TextRun({ text: "This export is generated from the CB2YY automation factory and aligned to UiPath Automation Hub document structure.", italics: true, size: 20, color: "777777" })],
        spacing: { after: 240 },
      }));
      docChildren.push(new TableOfContents("Contents", {
        hyperlink: true,
        headingStyleRange: "1-3",
      }));
      docChildren.push(new Paragraph({ spacing: { after: 260 } }));

      for (const t of requestedTypes) {
        const typeLower = t.toLowerCase();

        if (typeLower === "as-is" || typeLower === "to-be") {
          const viewType = typeLower;
          const label = typeLower === "as-is" ? "As-Is Process Map" : "To-Be Process Map";

          docChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: label, bold: true, size: 32, color: ORANGE })],
            spacing: { before: 400, after: 200 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: ORANGE } },
          }));

          const nodes = await processMapStorage.getNodesByIdeaId(ideaId, viewType);
          const edges = await processMapStorage.getEdgesByIdeaId(ideaId, viewType);

          if (!nodes.length) {
            docChildren.push(new Paragraph({
              children: [new TextRun({ text: `No ${label.toLowerCase()} data available.`, italics: true, color: "888888" })],
              spacing: { after: 200 },
            }));
            continue;
          }

          try {
            const mapImage = await renderProcessMapImage(nodes, edges, viewType);
            if (mapImage) {
              if (mapImage.pages && mapImage.pages.length > 1) {
                for (let pageIdx = 0; pageIdx < mapImage.pages.length; pageIdx++) {
                  const page = mapImage.pages[pageIdx];
                  docChildren.push(new Paragraph({
                    children: [
                      new ImageRun({
                        data: page.buffer,
                        transformation: { width: page.width, height: page.height },
                        type: "png",
                      }),
                    ],
                    spacing: { before: pageIdx === 0 ? 100 : 50, after: 50 },
                    alignment: AlignmentType.CENTER,
                  }));
                }
              } else {
                docChildren.push(new Paragraph({
                  children: [
                    new ImageRun({
                      data: mapImage.buffer,
                      transformation: { width: mapImage.width, height: mapImage.height },
                      type: "png",
                    }),
                  ],
                  spacing: { before: 100, after: 200 },
                  alignment: AlignmentType.CENTER,
                }));
              }
            } else {
              docChildren.push(new Paragraph({
                children: [new TextRun({ text: "[Process map image could not be generated]", italics: true, color: "888888" })],
                spacing: { before: 100, after: 200 },
              }));
            }
          } catch (imgErr: any) {
            console.error("[Document Export] Process map image generation failed:", imgErr.message);
            docChildren.push(new Paragraph({
              children: [new TextRun({ text: "[Process map image could not be generated]", italics: true, color: "888888" })],
              spacing: { before: 100, after: 200 },
            }));
          }

          docChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: `Process Steps (${nodes.length})`, bold: true, size: 26 })],
            spacing: { before: 200, after: 100 },
          }));

          const sortedNodes = [...nodes].sort((a, b) =>
            (a.positionY || 0) - (b.positionY || 0) || (a.positionX || 0) - (b.positionX || 0)
          );

          const tableRows: TableRow[] = [
            new TableRow({
              tableHeader: true,
              children: ["Step", "Type", "Role", "System"].map(h =>
                new TableCell({
                  width: { size: h === "Step" ? 40 : 20, type: WidthType.PERCENTAGE },
                  shading: { type: ShadingType.SOLID, fill: ORANGE, color: "FFFFFF" },
                  children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 20 })], alignment: AlignmentType.LEFT })],
                })
              ),
            }),
          ];
          for (const node of sortedNodes) {
            tableRows.push(new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: node.name || "Unnamed Step", bold: true, size: 20 })]})] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: (node.nodeType || "task").toUpperCase(), size: 18, color: "666666" })]})] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: node.role || "—", size: 20 })]})] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: node.system || "—", size: 20 })]})] }),
              ],
            }));
          }
          docChildren.push(new Table({ rows: tableRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
          docChildren.push(new Paragraph({ spacing: { after: 200 } }));

          if (edges.length) {
            docChildren.push(new Paragraph({
              heading: HeadingLevel.HEADING_2,
              children: [new TextRun({ text: `Connections (${edges.length})`, bold: true, size: 26 })],
              spacing: { before: 200, after: 100 },
            }));
            for (const edge of edges) {
              const sourceNode = nodes.find(n => n.id === edge.sourceNodeId);
              const targetNode = nodes.find(n => n.id === edge.targetNodeId);
              const sourceName = sourceNode?.name || String(edge.sourceNodeId);
              const targetName = targetNode?.name || String(edge.targetNodeId);
              const edgeLabel = edge.label ? ` [${edge.label}]` : "";
              docChildren.push(new Paragraph({
                children: [
                  new TextRun({ text: "→  ", color: ORANGE, bold: true }),
                  new TextRun({ text: `${sourceName}  →  ${targetName}${edgeLabel}`, size: 20 }),
                ],
                spacing: { after: 40 },
              }));
            }
          }

          // BPMN-style Process Flow Narrative
          if (nodes.length && edges.length) {
            docChildren.push(new Paragraph({
              heading: HeadingLevel.HEADING_2,
              children: [new TextRun({ text: "Process Flow Narrative", bold: true, size: 26 })],
              spacing: { before: 300, after: 100 },
            }));
            docChildren.push(new Paragraph({
              children: [new TextRun({ text: `The following narrative describes the ${typeLower === "as-is" ? "current (As-Is)" : "target (To-Be)"} process flow from start to completion.`, italics: true, size: 20, color: "666666" })],
              spacing: { after: 150 },
            }));

            const nodeMap = new Map(nodes.map(n => [n.id, n]));
            const outgoingEdges = new Map<number, typeof edges>();
            for (const edge of edges) {
              if (!outgoingEdges.has(edge.sourceNodeId)) {
                outgoingEdges.set(edge.sourceNodeId, []);
              }
              outgoingEdges.get(edge.sourceNodeId)!.push(edge);
            }

            const startNode = nodes.find(n => (n.nodeType || "").toLowerCase() === "start");
            const visited = new Set<number>();
            const narrativeSteps: { node: typeof nodes[0]; outEdges: typeof edges; depth: number }[] = [];

            const walkProcess = (nodeId: number, depth: number): void => {
              if (visited.has(nodeId)) return;
              visited.add(nodeId);
              const node = nodeMap.get(nodeId);
              if (!node) return;
              const out = outgoingEdges.get(nodeId) || [];
              narrativeSteps.push({ node, outEdges: out, depth });
              for (const edge of out) {
                walkProcess(edge.targetNodeId, depth + (node.nodeType === "decision" ? 1 : 0));
              }
            }

            if (startNode) {
              walkProcess(startNode.id, 0);
            } else {
              const targetIds = new Set(edges.map(e => e.targetNodeId));
              const rootNodes = nodes.filter(n => !targetIds.has(n.id));
              for (const root of rootNodes) {
                walkProcess(root.id, 0);
              }
              for (const node of sortedNodes) {
                if (!visited.has(node.id)) {
                  walkProcess(node.id, 0);
                }
              }
            }

            let stepNumber = 0;
            for (const { node, outEdges } of narrativeSteps) {
              const nType = (node.nodeType || "task").toLowerCase();

              if (nType === "start") {
                docChildren.push(new Paragraph({
                  children: [
                    new TextRun({ text: "Process Initiation: ", bold: true, size: 20 }),
                    new TextRun({ text: `The process begins at "${node.name}".`, size: 20 }),
                    ...(node.description ? [new TextRun({ text: ` ${node.description}`, size: 20, color: "555555" })] : []),
                    ...(node.role ? [new TextRun({ text: ` (Initiated by: ${node.role})`, size: 20, italics: true, color: "666666" })] : []),
                  ],
                  spacing: { after: 80 },
                }));
              } else if (nType === "end") {
                docChildren.push(new Paragraph({
                  children: [
                    new TextRun({ text: "Process Completion: ", bold: true, size: 20 }),
                    new TextRun({ text: `The process concludes at "${node.name}".`, size: 20 }),
                    ...(node.description ? [new TextRun({ text: ` ${node.description}`, size: 20, color: "555555" })] : []),
                  ],
                  spacing: { after: 80 },
                }));
              } else if (nType === "decision") {
                stepNumber++;
                const branches = outEdges.map(e => {
                  const target = nodeMap.get(e.targetNodeId);
                  return `${e.label || "Branch"}: proceed to "${target?.name || "next step"}"`;
                });
                docChildren.push(new Paragraph({
                  children: [
                    new TextRun({ text: `Step ${stepNumber} — Decision Point: `, bold: true, size: 20 }),
                    new TextRun({ text: `"${node.name}"`, bold: true, size: 20, color: ORANGE }),
                    ...(node.role ? [new TextRun({ text: ` [${node.role}]`, size: 20, italics: true, color: "666666" })] : []),
                  ],
                  spacing: { before: 60, after: 40 },
                }));
                if (node.description) {
                  docChildren.push(new Paragraph({
                    children: [new TextRun({ text: node.description, size: 20, color: "555555" })],
                    spacing: { after: 40 },
                  }));
                }
                for (const branch of branches) {
                  docChildren.push(new Paragraph({
                    children: [
                      new TextRun({ text: "    " }),
                      new TextRun({ text: "◆  ", color: ORANGE }),
                      new TextRun({ text: branch, size: 20 }),
                    ],
                    spacing: { after: 30 },
                  }));
                }
              } else {
                stepNumber++;
                const systemInfo = node.system ? ` using ${node.system}` : "";
                const roleInfo = node.role ? ` performed by ${node.role}` : "";
                docChildren.push(new Paragraph({
                  children: [
                    new TextRun({ text: `Step ${stepNumber}: `, bold: true, size: 20 }),
                    new TextRun({ text: `"${node.name}"`, bold: true, size: 20 }),
                    new TextRun({ text: `${roleInfo}${systemInfo}.`, size: 20 }),
                    ...(node.isPainPoint ? [new TextRun({ text: " [Pain Point]", bold: true, size: 20, color: "DC2626" })] : []),
                  ],
                  spacing: { before: 40, after: 40 },
                }));
                if (node.description) {
                  docChildren.push(new Paragraph({
                    children: [new TextRun({ text: node.description, size: 20, color: "555555" })],
                    spacing: { after: 40 },
                  }));
                }
                if (outEdges.length === 1 && outEdges[0].label) {
                  const target = nodeMap.get(outEdges[0].targetNodeId);
                  docChildren.push(new Paragraph({
                    children: [
                      new TextRun({ text: "    " }),
                      new TextRun({ text: `Transition [${outEdges[0].label}]: proceed to "${target?.name || "next step"}".`, size: 20, italics: true, color: "666666" }),
                    ],
                    spacing: { after: 40 },
                  }));
                }
              }
            }
          }

          // Process Assumptions
          docChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: "Process Assumptions", bold: true, size: 26 })],
            spacing: { before: 300, after: 100 },
          }));

          const painPoints = sortedNodes.filter(n => n.isPainPoint);
          const systemsUsed = Array.from(new Set(sortedNodes.map(n => n.system).filter(Boolean)));
          const rolesInvolved = Array.from(new Set(sortedNodes.map(n => n.role).filter(Boolean)));
          const decisionNodes = sortedNodes.filter(n => (n.nodeType || "").toLowerCase() === "decision");
          const nodeDescriptions = sortedNodes.filter(n => n.description && n.description.trim().length > 0);

          const assumptions: string[] = [];

          assumptions.push(`The process involves ${rolesInvolved.length || "one or more"} role${rolesInvolved.length !== 1 ? "s" : ""}: ${rolesInvolved.length ? rolesInvolved.join(", ") : "to be confirmed"}.`);

          if (systemsUsed.length > 0) {
            assumptions.push(`The process relies on the following system(s): ${systemsUsed.join(", ")}. It is assumed these systems are available and accessible.`);
          } else {
            assumptions.push("No specific systems have been identified. It is assumed the process is primarily manual or system dependencies are yet to be confirmed.");
          }

          if (decisionNodes.length > 0) {
            assumptions.push(`There ${decisionNodes.length === 1 ? "is" : "are"} ${decisionNodes.length} decision point${decisionNodes.length !== 1 ? "s" : ""} in the process. It is assumed that decision criteria are well-defined and consistently applied.`);
          }

          if (painPoints.length > 0) {
            assumptions.push(`${painPoints.length} step${painPoints.length !== 1 ? "s have" : " has"} been identified as pain point${painPoints.length !== 1 ? "s" : ""}: ${painPoints.map(p => `"${p.name}"`).join(", ")}. It is assumed these areas are candidates for improvement or automation.`);
          }

          assumptions.push("The process steps documented represent the standard flow; exception handling and edge cases may require additional detail.");
          assumptions.push("Stakeholders have validated that the process map accurately reflects current operations.");
          assumptions.push("Process volumes and frequency are assumed to be consistent with historical patterns unless otherwise stated.");

          for (const desc of nodeDescriptions) {
            if (desc.description.toLowerCase().includes("assum") || desc.description.toLowerCase().includes("note")) {
              assumptions.push(`From "${desc.name}": ${desc.description}`);
            }
          }

          for (const assumption of assumptions) {
            docChildren.push(new Paragraph({
              children: [new TextRun({ text: assumption, size: 20 })],
              bullet: { level: 0 },
              spacing: { after: 40 },
            }));
          }
          docChildren.push(new Paragraph({ spacing: { after: 200 } }));

          const mapApproval = await documentStorage.getApproval(ideaId, typeLower === "as-is" ? "as-is-map" : "to-be-map");
          docChildren.push(new Paragraph({ spacing: { before: 200 } }));
          if (mapApproval) {
            docChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "✓ Approved", bold: true, color: "22C55E", size: 22 }),
                new TextRun({ text: `  by ${mapApproval.userName} (${mapApproval.userRole})`, size: 20, color: "888888" }),
                new TextRun({ text: mapApproval.approvedAt ? `  on ${new Date(mapApproval.approvedAt).toLocaleDateString()}` : "", size: 20, color: "888888" }),
              ],
              spacing: { after: 300 },
            }));
          } else {
            docChildren.push(new Paragraph({
              children: [new TextRun({ text: "○ Not yet approved", color: "888888", size: 20 })],
              spacing: { after: 300 },
            }));
          }

        } else {
          const docType = typeLower.toUpperCase();
          const label = docType === "PDD"
            ? "Process Design Document"
            : docType === "SDD"
              ? "Solution Design Document"
              : "Detailed Solution Design Document";

          docChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: `${label} (${docType})`, bold: true, size: 32, color: ORANGE })],
            spacing: { before: 400, after: 200 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: ORANGE } },
          }));

          const allVersions = await documentStorage.getDocumentVersions(ideaId, docType);
          const latest = allVersions[0];

          if (!latest) {
            docChildren.push(new Paragraph({
              children: [new TextRun({ text: `No ${docType} has been generated yet.`, italics: true, color: "888888" })],
              spacing: { after: 200 },
            }));
            continue;
          }

          docChildren.push(new Paragraph({
            children: [
              new TextRun({ text: `Version ${latest.version}`, bold: true, size: 22 }),
              new TextRun({ text: `  |  Status: ${latest.status}`, size: 20, color: "888888" }),
              new TextRun({ text: `  |  Created: ${latest.createdAt ? new Date(latest.createdAt).toLocaleDateString() : "N/A"}`, size: 20, color: "888888" }),
            ],
            spacing: { after: 100 },
          }));

          const approval = await documentStorage.getApproval(ideaId, docType);
          if (approval) {
            docChildren.push(new Paragraph({
              children: [
                new TextRun({ text: "✓ Approved", bold: true, color: "22C55E", size: 22 }),
                new TextRun({ text: `  by ${approval.userName} (${approval.userRole})`, size: 20, color: "888888" }),
                new TextRun({ text: approval.approvedAt ? `  on ${new Date(approval.approvedAt).toLocaleDateString()}` : "", size: 20, color: "888888" }),
              ],
              spacing: { after: 200 },
            }));
          } else {
            docChildren.push(new Paragraph({
              children: [new TextRun({ text: "○ Not yet approved", color: "888888", size: 20 })],
              spacing: { after: 200 },
            }));
          }

          docChildren.push(new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun({ text: "Document Content", bold: true, size: 26 })],
            spacing: { before: 200, after: 100 },
          }));

          const normalizedContent = ensureTemplateSections(
            latest.content || "No content",
            getTemplateSectionList(docType) || [],
          );
          const content = normalizedContent;
          const lines = content.split("\n");

          docChildren.push(new Paragraph({
            children: [new TextRun({ text: `Aligned to UiPath Automation Hub ${docType} template structure`, italics: true, size: 20, color: "666666" })],
            spacing: { after: 120 },
          }));
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("## ")) {
              docChildren.push(new Paragraph({
                heading: HeadingLevel.HEADING_2,
                children: [new TextRun({ text: trimmed.replace(/^##\s+/, ""), bold: true, size: 26 })],
                spacing: { before: 200, after: 100 },
              }));
            } else if (trimmed.startsWith("### ")) {
              docChildren.push(new Paragraph({
                heading: HeadingLevel.HEADING_3,
                children: [new TextRun({ text: trimmed.replace(/^###\s+/, ""), bold: true, size: 24 })],
                spacing: { before: 150, after: 80 },
              }));
            } else if (trimmed.startsWith("# ")) {
              docChildren.push(new Paragraph({
                heading: HeadingLevel.HEADING_1,
                children: [new TextRun({ text: trimmed.replace(/^#\s+/, ""), bold: true, size: 30 })],
                spacing: { before: 250, after: 120 },
              }));
            } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
              const bulletText = trimmed.replace(/^[-*]\s+/, "");
              const runs: TextRun[] = [];
              const boldParts = bulletText.split(/(\*\*[^*]+\*\*)/);
              for (const part of boldParts) {
                if (part.startsWith("**") && part.endsWith("**")) {
                  runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 20 }));
                } else {
                  runs.push(new TextRun({ text: part, size: 20 }));
                }
              }
              docChildren.push(new Paragraph({
                children: runs,
                bullet: { level: 0 },
                spacing: { after: 40 },
              }));
            } else if (trimmed.startsWith("```")) {
              continue;
            } else if (trimmed === "") {
              docChildren.push(new Paragraph({ spacing: { after: 80 } }));
            } else {
              const runs: TextRun[] = [];
              const boldParts = trimmed.split(/(\*\*[^*]+\*\*)/);
              for (const part of boldParts) {
                if (part.startsWith("**") && part.endsWith("**")) {
                  runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 20 }));
                } else {
                  runs.push(new TextRun({ text: part, size: 20 }));
                }
              }
              docChildren.push(new Paragraph({
                children: runs,
                spacing: { after: 60 },
              }));
            }
          }

          if (allVersions.length > 1) {
            docChildren.push(new Paragraph({
              heading: HeadingLevel.HEADING_2,
              children: [new TextRun({ text: "Version History", bold: true, size: 26 })],
              spacing: { before: 300, after: 100 },
            }));
            const versionRows: TableRow[] = [
              new TableRow({
                tableHeader: true,
                children: ["Version", "Status", "Created"].map(h =>
                  new TableCell({
                    shading: { type: ShadingType.SOLID, fill: ORANGE, color: "FFFFFF" },
                    children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, color: "FFFFFF", size: 20 })] })],
                  })
                ),
              }),
            ];
            for (const v of allVersions) {
              versionRows.push(new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: `v${v.version}`, size: 20 })] })] }),
                  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: v.status, size: 20 })] })] }),
                  new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: v.createdAt ? new Date(v.createdAt).toLocaleDateString() : "N/A", size: 20 })] })] }),
                ],
              }));
            }
            docChildren.push(new Table({ rows: versionRows, width: { size: 100, type: WidthType.PERCENTAGE } }));
          }
        }
      }

      const doc = new Document({
        styles: {
          default: {
            document: {
              run: { font: "Calibri", size: 22 },
            },
          },
        },
        sections: [{
          properties: {},
          children: docChildren,
        }],
      });

      const buffer = await Packer.toBuffer(doc);
      const filename = `${ideaTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}_export_${new Date().toISOString().slice(0, 10)}.docx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(Buffer.from(buffer));
    } catch (err: any) {
      console.error("[Document Export] Error:", err.message);
      return res.status(500).json({ message: "Export failed" });
    }
  });
}


function extractSddSection(sddContent: string, heading: string): string {
  const lines = sddContent.split("\n");
  let capture = false;
  let result: string[] = [];
  for (const line of lines) {
    if (line.toLowerCase().includes(heading.toLowerCase()) && (line.startsWith("#") || line.startsWith("**"))) {
      capture = true;
      continue;
    }
    if (capture && (line.startsWith("# ") || line.startsWith("## "))) break;
    if (capture) result.push(line);
  }
  return result.join("\n").trim();
}

function extractAgentPrompt(sddContent: string, type: "system" | "user", pkg: UiPathPackage): string {
  const projectName = pkg.projectName || "Automation";
  const description = pkg.description || "";

  if (type === "system") {
    let prompt = `You are an AI agent for the "${projectName}" automation process.\n\n`;
    prompt += `## Purpose\n${description}\n\n`;

    const agentSection = extractSddSection(sddContent, "agent") || extractSddSection(sddContent, "AI");
    if (agentSection) {
      prompt += `## Context from Solution Design\n${agentSection.slice(0, 2000)}\n\n`;
    }

    prompt += `## Behavioral Guidelines\n`;
    prompt += `- Follow the process steps defined in the automation workflow\n`;
    prompt += `- Escalate to a human operator when confidence is below threshold\n`;
    prompt += `- Log all decisions and actions for audit trail\n`;
    prompt += `- Do not perform actions outside the defined scope\n\n`;

    const guardrails = pkg.agents?.[0]?.guardrails || [];
    if (guardrails.length > 0) {
      prompt += `## Guardrails\n`;
      for (const g of guardrails) prompt += `- ${g}\n`;
      prompt += `\n`;
    }

    return prompt;
  }

  let template = `## Task\nProcess the following input according to the "${projectName}" workflow.\n\n`;
  template += `## Input\n{{input_data}}\n\n`;
  template += `## Expected Output Format\n`;
  template += `Provide your response as structured JSON with the following fields:\n`;
  template += `- decision: The action decision (approve/reject/escalate)\n`;
  template += `- confidence: Confidence score (0.0 to 1.0)\n`;
  template += `- reasoning: Brief explanation of the decision\n`;
  template += `- next_steps: Array of recommended next actions\n\n`;
  template += `## Additional Context\n{{additional_context}}\n`;
  return template;
}

function extractToolDefinitions(sddContent: string, pkg: UiPathPackage): any[] {
  const tools: any[] = [];

  const agentTools = pkg.agents?.[0]?.tools || [];
  for (const tool of agentTools) {
    if (typeof tool === "string") {
      tools.push({
        name: tool,
        description: `UiPath activity: ${tool}`,
        input_schema: { type: "object", properties: {}, required: [] },
        output_schema: { type: "object", properties: {} },
        action: "AUTHORIZE",
      });
    } else if (typeof tool === "object") {
      const typedTool = tool as {
        name?: string;
        description?: string;
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
      };
      tools.push({
        name: typedTool.name || "unknown_tool",
        description: typedTool.description || "",
        input_schema: typedTool.inputSchema || { type: "object", properties: {} },
        output_schema: typedTool.outputSchema || { type: "object", properties: {} },
        action: "AUTHORIZE",
      });
    }
  }

  if (tools.length === 0) {
    tools.push(
      { name: "read_document", description: "Read and extract content from a document", input_schema: { type: "object", properties: { document_path: { type: "string" } }, required: ["document_path"] }, output_schema: { type: "object", properties: { content: { type: "string" } } }, action: "CONFIGURE" },
      { name: "query_database", description: "Execute a read-only query against the business database", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, output_schema: { type: "object", properties: { results: { type: "array" } } }, action: "AUTHORIZE" },
      { name: "send_notification", description: "Send a notification or escalation message", input_schema: { type: "object", properties: { recipient: { type: "string" }, message: { type: "string" } }, required: ["recipient", "message"] }, output_schema: { type: "object", properties: { sent: { type: "boolean" } } }, action: "CONFIGURE" },
    );
  }

  return tools;
}

function generateKBPlaceholder(sddContent: string, pkg: UiPathPackage): string {
  const projectName = pkg.projectName || "Automation";
  let md = `# Knowledge Base — ${projectName}\n\n`;
  md += `This folder should contain the documents the agent needs for retrieval-augmented generation (RAG).\n\n`;
  md += `## Recommended Documents\n\n`;

  const kbs = pkg.knowledgeBases || pkg.agents?.[0]?.knowledgeBases || [];
  if (kbs.length > 0) {
    for (const kb of kbs) {
      const name = typeof kb === "string" ? kb : kb.name || kb;
      md += `- ${name}\n`;
    }
  } else {
    md += `- Standard Operating Procedures (SOPs) for ${projectName}\n`;
    md += `- Business rules and exception handling documentation\n`;
    md += `- Reference data tables and lookup values\n`;
    md += `- Previous process execution logs and examples\n`;
  }

  md += `\n## Setup Steps\n\n`;
  md += `1. Upload documents to the UiPath AI Center knowledge base\n`;
  md += `2. Configure indexing and chunking strategy\n`;
  md += `3. Test retrieval with representative queries\n`;
  md += `4. Verify agent can cite relevant document sections\n`;
  return md;
}

function generateAgentConfig(agentName: string, sddContent: string, pkg: UiPathPackage): any {
  const agent = pkg.agents?.[0] || {};
  return {
    name: agentName,
    description: agent.description || pkg.description || "",
    systemPromptFile: "prompts/system_prompt.txt",
    userPromptTemplateFile: "prompts/user_prompt_template.txt",
    toolDefinitionsFile: "tools/tool_definitions.json",
    knowledgeBaseFolder: "knowledge/",
    configuration: {
      temperature: { value: agent.temperature ?? 0.3, action: "TUNE" },
      maxIterations: { value: agent.maxIterations || 10, action: "TUNE" },
      model: { value: "gpt-4o", action: "CONFIGURE" },
      escalationThreshold: { value: 0.7, action: "TUNE" },
    },
    guardrails: (agent.guardrails || []).map((g: string) => ({ rule: g, action: "REVIEW" })),
    escalationRules: (agent.escalationRules || []).map((r: any) => ({
      condition: typeof r === "string" ? r : r.condition,
      target: typeof r === "string" ? "human_operator" : r.target,
      action: "REVIEW",
    })),
    tools: (agent.tools || []).map((t: any) => ({
      name: typeof t === "string" ? t : t.name,
      action: "AUTHORIZE",
    })),
    provisionedBy: "CannonBall",
    importInstructions: "Import this configuration into UiPath Agent Builder. See DeveloperHandoffGuide.md Section 2a for step-by-step instructions.",
  };
}
