import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import AdmZip from "adm-zip";
import { buildNuGetPackage } from "../server/package-assembler";
import type { UiPathPackage } from "../server/types/uipath-package";
import { selectGenerationMode } from "../server/xaml-generator";
import { catalogService } from "../server/catalog/catalog-service";

type SimulationCase = {
  docPath: string;
  outputDir: string;
  version: string;
  cacheKey: string;
  package: UiPathPackage;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

async function extractDocText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

function buildBirthdayNodes() {
  return [
    { id: "1", name: "Daily 8:00 AM Trigger", nodeType: "start", description: "Time trigger starts unattended daily run at 08:00 AM.", system: "Orchestrator Triggers" },
    { id: "2", name: "Fetch Today's Events from Birthdays Calendar", nodeType: "task", description: "Read today's birthday events from the Birthdays calendar using Google Calendar Integration Service connector.", system: "Google Calendar (Integration Service connector)" },
    { id: "3", name: "Any Birthdays Today?", nodeType: "decision", description: "Check whether the calendar query returned any birthday events for today.", system: "Google Calendar (Integration Service connector)" },
    { id: "4", name: "Build Birthday Recipient Worklist", nodeType: "task", description: "Prepare the list of recipients for the current run and initialize run-level tracking.", system: "Orchestrator" },
    { id: "5", name: "Complete Run (No Birthdays)", nodeType: "end", description: "Complete the run with zero birthdays found.", system: "Orchestrator" },
    { id: "6", name: "Create Queue Items (One per Person)", nodeType: "task", description: "Create one queue item per birthday person in BirthdayGreetingsV9_Queue using reference format YYYYMMDD_FullName.", system: "Orchestrator Queues" },
    { id: "7", name: "Get Next Person from Queue", nodeType: "task", description: "Consume the next transaction item from BirthdayGreetingsV9_Queue.", system: "Orchestrator Queues" },
    { id: "8", name: "Lookup Contact in Google Contacts", nodeType: "task", description: "Search Google Contacts by full name to find available email addresses.", system: "Google Contacts (Integration Service connector)" },
    { id: "9", name: "Email Found?", nodeType: "decision", description: "Determine whether any Personal or Home email address was found for the contact.", system: "Google Contacts (Integration Service connector)" },
    { id: "10", name: "Select Preferred Email (Personal > Home)", nodeType: "task", description: "Apply the business rule to prefer Personal email over Home email when multiple addresses exist.", system: "Google Contacts (Integration Service connector)" },
    { id: "11", name: "Skip This Person (No Email Found)", nodeType: "task", description: "Skip the transaction with business exception NoEmailFound and persist the audit outcome.", system: "Orchestrator" },
    { id: "12", name: "Generate Personalized Birthday Message", nodeType: "task", description: "Generate a warm, funny, lightly sarcastic birthday email subject and body using UiPath GenAI Activities with JSON output.", system: "UiPath GenAI Activities" },
    { id: "13", name: "Message Quality/Safety OK?", nodeType: "decision", description: "Validate output schema, guardrails, name inclusion, and max character count from BGV9_MaxMessageChars.", system: "UiPath GenAI Activities" },
    { id: "14", name: "Send Birthday Email", nodeType: "task", description: "Send the approved birthday message through Gmail Integration Service connection ninemush@gmail.com.", system: "Gmail (Integration Service)" },
    { id: "15", name: "Create Action Center Review Task", nodeType: "task", description: "Create Action Center review task when message quality or safety validation fails and human review is enabled.", system: "Action Center" },
    { id: "16", name: "Persist Run and Message Audit", nodeType: "task", description: "Write run summary and per-recipient results to Data Service entities BirthdayGreetingRun and BirthdayGreetingMessage.", system: "Data Service" },
    { id: "17", name: "Complete Sent Outcome", nodeType: "end", description: "Complete successful sent transaction and persist final sent status.", system: "Orchestrator" },
    { id: "18", name: "Complete Pending Review Outcome", nodeType: "end", description: "Complete transaction as pending review for Action Center follow-up.", system: "Action Center" },
    { id: "19", name: "Complete Skipped Outcome", nodeType: "end", description: "Complete transaction as skipped due to missing email.", system: "Orchestrator" },
  ];
}

function buildBirthdayEdges() {
  return [
    { sourceNodeId: "1", targetNodeId: "2", label: "" },
    { sourceNodeId: "2", targetNodeId: "3", label: "" },
    { sourceNodeId: "3", targetNodeId: "4", label: "Yes" },
    { sourceNodeId: "3", targetNodeId: "5", label: "No" },
    { sourceNodeId: "4", targetNodeId: "6", label: "" },
    { sourceNodeId: "6", targetNodeId: "7", label: "" },
    { sourceNodeId: "7", targetNodeId: "8", label: "" },
    { sourceNodeId: "8", targetNodeId: "9", label: "" },
    { sourceNodeId: "9", targetNodeId: "10", label: "Yes" },
    { sourceNodeId: "9", targetNodeId: "11", label: "No" },
    { sourceNodeId: "10", targetNodeId: "12", label: "" },
    { sourceNodeId: "12", targetNodeId: "13", label: "" },
    { sourceNodeId: "13", targetNodeId: "14", label: "Pass" },
    { sourceNodeId: "13", targetNodeId: "15", label: "Fail" },
    { sourceNodeId: "14", targetNodeId: "16", label: "" },
    { sourceNodeId: "15", targetNodeId: "16", label: "" },
    { sourceNodeId: "11", targetNodeId: "16", label: "" },
    { sourceNodeId: "16", targetNodeId: "17", label: "Sent" },
    { sourceNodeId: "16", targetNodeId: "18", label: "PendingReview" },
    { sourceNodeId: "16", targetNodeId: "19", label: "SkippedNoEmail" },
  ];
}

function buildBirthdayArtifacts() {
  return {
    queues: [
      { name: "BirthdayGreetingsV9_Queue", description: "Work queue driving per-person birthday greeting transactions.", maxRetries: 3, uniqueReference: true },
    ],
    assets: [
      { name: "BGV9_Timezone", type: "Text", value: "", description: "Timezone used to compute today." },
      { name: "BGV9_MaxMessageChars", type: "Integer", value: "", description: "Maximum allowed character length for generated body." },
      { name: "BGV9_EnableHumanReview", type: "Bool", value: "", description: "Controls Action Center review path." },
      { name: "BGV9_SendRunSummaryEmail", type: "Bool", value: "", description: "Controls run summary email." },
    ],
    storageBuckets: [
      { name: "birthday-greetings-v9", description: "Stores prompt templates and run artifacts." },
    ],
    triggers: [
      { name: "BirthdayGreetingsV9_Dispatcher_Daily_0800", type: "Time", cron: "0 0 8 * * ?", description: "Runs dispatcher daily at 08:00." },
      { name: "BirthdayGreetingsV9_ResubmitReviewed_Every15Min", type: "Time", cron: "0 0/15 * * * ?", description: "Optional review resubmission trigger." },
    ],
    actionCenter: [
      { taskCatalog: "BirthdayGreetingsV9_MessageReview", assignedRole: "Reviewer" },
    ],
  };
}

function buildPoInvoiceNodes() {
  return [
    { id: "1", name: "Invoice Submitted in Coupa", nodeType: "start", description: "Supplier submits invoice PDF in Coupa.", system: "Coupa" },
    { id: "2", name: "Ingest New Invoice Event and Create Work Item", nodeType: "task", description: "Webhook or polling ingestion creates Orchestrator queue work item with invoice metadata.", system: "Orchestrator Queue" },
    { id: "3", name: "Retrieve Invoice PDF and Header Data from Coupa", nodeType: "task", description: "Retrieve invoice PDF attachment and header data from Coupa via Integration Service webhook or connector.", system: "Integration Service Coupa" },
    { id: "4", name: "Extract Key Fields from Invoice PDF", nodeType: "task", description: "Use Document Understanding to extract PO number, vendor, invoice number, amount, and line totals.", system: "Document Understanding" },
    { id: "5", name: "Extraction Confidence Sufficient", nodeType: "decision", description: "Determine whether DU extraction confidence is sufficient for straight through processing.", system: "Document Understanding" },
    { id: "6", name: "Send to AP for Review and Correction", nodeType: "task", description: "Create Action Center task for AP to review and correct low-confidence invoice extraction.", system: "Action Center" },
    { id: "7", name: "Apply AP Corrections to Work Item", nodeType: "task", description: "Apply Action Center corrections back to the case and continue processing.", system: "Action Center" },
    { id: "8", name: "Retrieve PO Details from Coupa", nodeType: "task", description: "Retrieve Coupa PO header, vendor, lines, and totals for invoice validation.", system: "Integration Service Coupa" },
    { id: "9", name: "PO Number Present and Found in Coupa", nodeType: "decision", description: "Check whether PO number exists on the invoice and is found in Coupa.", system: "Coupa" },
    { id: "10", name: "Validate Invoice vs PO 2 Way Match", nodeType: "task", description: "Validate vendor identity, lines, and totals between invoice and PO.", system: "Automation Rules" },
    { id: "11", name: "Post Supplier Message PO Not Found", nodeType: "task", description: "Post supplier-facing message in Coupa for missing or not found PO.", system: "Coupa Supplier Messaging" },
    { id: "12", name: "Match Passes Vendor Lines Totals", nodeType: "decision", description: "Decision for 2-way match success on vendor, lines, and totals.", system: "Automation Rules" },
    { id: "13", name: "Amount Within 5 Percent Tolerance", nodeType: "decision", description: "Decision for invoice amount within 5 percent tolerance versus PO.", system: "Automation Rules" },
    { id: "14", name: "Post Supplier Message PO Mismatch Details", nodeType: "task", description: "Post supplier-facing mismatch details in Coupa Supplier Messaging.", system: "Coupa Supplier Messaging" },
    { id: "15", name: "Post Supplier Message Amount Outside Tolerance", nodeType: "task", description: "Notify supplier that invoice amount is outside tolerance.", system: "Coupa Supplier Messaging" },
    { id: "16", name: "Reject Invoice in Coupa", nodeType: "task", description: "Reject invoice in Coupa so supplier resubmits a new invoice.", system: "Coupa" },
    { id: "17", name: "Route Invoice for Approval per DOA", nodeType: "task", description: "Route invoice through Coupa approval chain per DOA.", system: "Coupa" },
    { id: "18", name: "Approved in Coupa", nodeType: "decision", description: "Determine whether invoice is approved in Coupa approval chain.", system: "Coupa" },
    { id: "19", name: "Mark Invoice as Approved and Progressed", nodeType: "task", description: "Persist approved outcome and progression details in Data Service.", system: "Data Service" },
    { id: "20", name: "Post Supplier Message Invoice Not Approved", nodeType: "task", description: "Notify supplier when invoice is rejected in approval.", system: "Coupa Supplier Messaging" },
    { id: "21", name: "Invoice Rejected End", nodeType: "end", description: "Terminal rejection outcome.", system: "Coupa" },
    { id: "22", name: "Approved and Progressed End", nodeType: "end", description: "Terminal approved outcome.", system: "Coupa" },
  ];
}

function buildPoInvoiceEdges() {
  return [
    { sourceNodeId: "1", targetNodeId: "2", label: "" },
    { sourceNodeId: "2", targetNodeId: "3", label: "" },
    { sourceNodeId: "3", targetNodeId: "4", label: "" },
    { sourceNodeId: "4", targetNodeId: "5", label: "" },
    { sourceNodeId: "5", targetNodeId: "6", label: "No" },
    { sourceNodeId: "5", targetNodeId: "8", label: "Yes" },
    { sourceNodeId: "6", targetNodeId: "7", label: "" },
    { sourceNodeId: "7", targetNodeId: "8", label: "" },
    { sourceNodeId: "8", targetNodeId: "9", label: "" },
    { sourceNodeId: "9", targetNodeId: "10", label: "Yes" },
    { sourceNodeId: "9", targetNodeId: "11", label: "No" },
    { sourceNodeId: "11", targetNodeId: "16", label: "" },
    { sourceNodeId: "10", targetNodeId: "12", label: "" },
    { sourceNodeId: "12", targetNodeId: "13", label: "Yes" },
    { sourceNodeId: "12", targetNodeId: "14", label: "No" },
    { sourceNodeId: "14", targetNodeId: "16", label: "" },
    { sourceNodeId: "13", targetNodeId: "17", label: "Yes" },
    { sourceNodeId: "13", targetNodeId: "15", label: "No" },
    { sourceNodeId: "15", targetNodeId: "16", label: "" },
    { sourceNodeId: "16", targetNodeId: "21", label: "" },
    { sourceNodeId: "17", targetNodeId: "18", label: "" },
    { sourceNodeId: "18", targetNodeId: "19", label: "Yes" },
    { sourceNodeId: "18", targetNodeId: "20", label: "No" },
    { sourceNodeId: "20", targetNodeId: "16", label: "" },
    { sourceNodeId: "19", targetNodeId: "22", label: "" },
  ];
}

function buildPoInvoiceArtifacts() {
  return {
    queues: [
      { name: "POInvoiceValidationQueue", description: "Queue driving invoice validation work items from Coupa invoice submissions.", maxRetries: 3, uniqueReference: true },
    ],
    assets: [
      { name: "POInvoice_ConfidenceThreshold", type: "Integer", value: "", description: "Document Understanding confidence threshold for straight-through processing." },
      { name: "POInvoice_TolerancePercent", type: "Integer", value: "", description: "Maximum allowed percent variance between invoice and PO amount." },
      { name: "POInvoice_CoupaConnection", type: "Text", value: "", description: "Integration Service connection name for Coupa API access." },
      { name: "POInvoice_WebhookConnection", type: "Text", value: "", description: "Integration Service HTTP webhook connection name." },
    ],
    storageBuckets: [
      { name: "po-invoice-evidence", description: "Stores invoice PDFs and extracted metadata snapshots." },
    ],
    triggers: [
      { name: "POInvoice_Webhook_Ingestion", type: "Event", cron: "", description: "Creates queue items from Coupa invoice submission webhook." },
      { name: "POInvoice_Polling_Fallback_Every15Min", type: "Time", cron: "0 0/15 * * * ?", description: "Fallback polling trigger for new invoice retrieval." },
    ],
    actionCenter: [
      { taskCatalog: "POInvoiceExtractionReview", assignedRole: "AP Processor" },
    ],
  };
}

function getSimulationCase(kind: string): SimulationCase {
  if (kind === "po_invoice") {
    return {
      docPath: "C:/Users/yusuf.yasin/Downloads/CannonBall/PO_Invoice_test_new_export.docx",
      outputDir: "C:/Users/yusuf.yasin/Downloads/CannonBall/simulation_output_po_invoice",
      version: "1.0.0-sim",
      cacheKey: "po-invoice-sim-local",
      package: {
        projectName: "POInvoiceTestNew",
        description: "PO invoice validation and approval automation generated from exported documentation.",
        dependencies: [
          "UiPath.System.Activities",
          "UiPath.IntegrationService.Activities",
          "UiPath.DocumentUnderstanding.Activities",
          "UiPath.Persistence.Activities",
          "UiPath.DataService.Activities",
          "UiPath.Mail.Activities",
        ],
        workflows: [
          {
            name: "Main",
            description: "Primary PO invoice orchestration entry point.",
            variables: [],
            steps: [
              {
                activity: "Init PO Invoice Run",
                activityType: "ui:LogMessage",
                activityPackage: "UiPath.System.Activities",
                properties: { Level: "Info", Message: "\"PO invoice simulation started\"" },
                notes: "Seed entry workflow so local build has an explicit main workflow.",
              },
            ],
          },
        ],
        internal: {
          sddContent: "",
          automationType: "hybrid",
          processNodes: buildPoInvoiceNodes(),
          processEdges: buildPoInvoiceEdges(),
          orchestratorArtifacts: buildPoInvoiceArtifacts(),
          targetFramework: "Windows",
          autopilotEnabled: false,
          useReFramework: true,
          complexityTier: "complex",
          forceRebuild: true,
        },
        agents: [
          {
            description: "POInvoiceExtractionReviewAgent for document extraction correction and discrepancy triage.",
            tools: ["ExtractInvoiceFields", "LookupCoupaPO", "PostSupplierMessage"],
            guardrails: ["Preserve extracted invoice identifiers", "Do not approve invoices automatically", "Escalate low-confidence extraction to Action Center"],
            maxIterations: 2,
          },
        ],
        knowledgeBases: ["po-invoice-validation"],
      },
    };
  }

  return {
    docPath: "C:/Users/yusuf.yasin/Downloads/birthday_greetings_v9_full_export.docx",
    outputDir: "C:/Users/yusuf.yasin/Downloads/CannonBall/simulation_output_bgv9",
    version: "9.0.0-sim",
    cacheKey: "bgv9-sim-local",
    package: {
      projectName: "BirthdayGreetingsV9",
      description: "Birthday greetings hybrid unattended automation generated from full export document.",
      dependencies: [
        "UiPath.System.Activities",
        "UiPath.IntegrationService.Activities",
        "UiPath.DataService.Activities",
        "UiPath.Persistence.Activities",
        "UiPath.GenAI.Activities",
        "UiPath.GSuite.Activities",
      ],
      workflows: [
        {
          name: "Main",
          description: "Primary birthday greetings orchestration entry point.",
          variables: [],
          steps: [
            {
              activity: "Init Birthday Greetings Run",
              activityType: "ui:LogMessage",
              activityPackage: "UiPath.System.Activities",
              properties: { Level: "Info", Message: "\"BirthdayGreetingsV9 simulation started\"" },
              notes: "Seed entry workflow so local build has an explicit main workflow.",
            },
          ],
        },
      ],
      internal: {
        sddContent: "",
        automationType: "hybrid",
        processNodes: buildBirthdayNodes(),
        processEdges: buildBirthdayEdges(),
        orchestratorArtifacts: buildBirthdayArtifacts(),
        targetFramework: "Windows",
        autopilotEnabled: false,
        useReFramework: true,
        complexityTier: "complex",
        forceRebuild: true,
      },
      agents: [
        {
          description: "BGV9_MessageComposerAgent for guarded birthday message generation.",
          tools: ["LookupContactEmail", "SendGmail"],
          guardrails: ["Output JSON with subject and body only", "Avoid sensitive content", "Include recipient name"],
          maxIterations: 2,
        },
      ],
      knowledgeBases: ["birthday-greetings-v9"],
    },
  };
}

async function main() {
  const selectorPath = "C:/Users/yusuf.yasin/Downloads/CannonBall/CB2_git/scripts/simulation_case.txt";
  const selectedFromFile = fs.existsSync(selectorPath)
    ? fs.readFileSync(selectorPath, "utf8").trim().toLowerCase()
    : "";
  const kind = (selectedFromFile || process.env.SIM_CASE || "bgv9").trim().toLowerCase();
  const sim = getSimulationCase(kind);
  ensureDir(sim.outputDir);

  const sddContent = await extractDocText(sim.docPath);
  sim.package.internal = {
    ...sim.package.internal,
    sddContent,
  };

  const selectedMode = selectGenerationMode("hybrid", 0.92, catalogService.getStudioProfile());
  const result = await buildNuGetPackage(sim.package, sim.version, sim.cacheKey, selectedMode.mode);

  const summary = {
    case: kind,
    selectedMode: selectedMode.mode,
    selectedModeReason: selectedMode.reason,
    generationMode: result.generationMode,
    usedFallbackStubs: result.usedFallbackStubs,
    cacheHit: result.cacheHit ?? false,
    usedPackages: result.usedPackages,
    dependencyMap: result.dependencyMap,
    archiveManifestCount: result.archiveManifest.length,
    xamlFiles: result.xamlEntries.map(e => e.name),
    qualityGatePassed: result.qualityGateResult?.passed ?? null,
    qualityViolationCount: result.qualityGateResult?.violations?.length ?? 0,
    topViolations: (result.qualityGateResult?.violations ?? []).slice(0, 25),
  };

  fs.writeFileSync(path.join(sim.outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(path.join(sim.outputDir, "sdd-extracted.txt"), sddContent, "utf8");
  for (const entry of result.xamlEntries) {
    fs.writeFileSync(path.join(sim.outputDir, entry.name), entry.content, "utf8");
  }
  if (result.projectJsonContent) {
    fs.writeFileSync(path.join(sim.outputDir, "project.json"), result.projectJsonContent, "utf8");
  }
  const nupkgName = `${sim.package.projectName}.${sim.version}.nupkg`;
  fs.writeFileSync(path.join(sim.outputDir, nupkgName), result.buffer);
  try {
    const zip = new AdmZip(result.buffer);
    const dhgEntry = zip.getEntries().find(e => /DeveloperHandoffGuide\.md$/i.test(e.entryName));
    if (dhgEntry) {
      fs.writeFileSync(path.join(sim.outputDir, "DeveloperHandoffGuide.md"), dhgEntry.getData());
    }
  } catch (err) {
    console.warn(`Unable to extract DeveloperHandoffGuide.md from generated package: ${err instanceof Error ? err.message : String(err)}`);
  }
  fs.writeFileSync(path.join(sim.outputDir, "archive-manifest.txt"), result.archiveManifest.join("\n"), "utf8");
  fs.writeFileSync(path.join(sim.outputDir, "dependency-map.json"), JSON.stringify(result.dependencyMap, null, 2), "utf8");
  if (result.qualityGateResult) {
    fs.writeFileSync(path.join(sim.outputDir, "quality-gate.json"), JSON.stringify(result.qualityGateResult, null, 2), "utf8");
  }
  fs.writeFileSync(path.join(sim.outputDir, "build-result-meta.json"), JSON.stringify({
    gaps: result.gaps,
    referencedMLSkillNames: result.referencedMLSkillNames,
    usedAIFallback: result.usedAIFallback,
  }, null, 2), "utf8");

  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
