import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import { buildNuGetPackage } from "../server/package-assembler";
import type { UiPathPackage } from "../server/types/uipath-package";
import { selectGenerationMode } from "../server/xaml-generator";
import { catalogService } from "../server/catalog/catalog-service";

const docPath = "C:/Users/yusuf.yasin/Downloads/CannonBall/PO_Invoice_test_new_export.docx";
const outputDir = "C:/Users/yusuf.yasin/Downloads/CannonBall/simulation_output_po_invoice";

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

async function extractDocText(filePath: string): Promise<string> {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
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

function buildArtifacts() {
  return {
    queues: [
      {
        name: "POInvoiceValidationQueue",
        description: "Queue driving invoice validation work items from Coupa invoice submissions.",
        maxRetries: 3,
        uniqueReference: true,
      },
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

async function main() {
  ensureDir(outputDir);

  const sddContent = await extractDocText(docPath);
  const selectedMode = selectGenerationMode("hybrid", 0.92, catalogService.getStudioProfile());

  const pkg: UiPathPackage = {
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
      sddContent,
      automationType: "hybrid",
      processNodes: buildPoInvoiceNodes(),
      processEdges: buildPoInvoiceEdges(),
      orchestratorArtifacts: buildArtifacts(),
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
  };

  const result = await buildNuGetPackage(pkg, "1.0.0-sim", "po-invoice-sim-local", selectedMode.mode);

  const summary = {
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

  fs.writeFileSync(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(path.join(outputDir, "sdd-extracted.txt"), sddContent, "utf8");
  for (const entry of result.xamlEntries) {
    fs.writeFileSync(path.join(outputDir, entry.name), entry.content, "utf8");
  }
  if (result.projectJsonContent) {
    fs.writeFileSync(path.join(outputDir, "project.json"), result.projectJsonContent, "utf8");
  }
  fs.writeFileSync(path.join(outputDir, "archive-manifest.txt"), result.archiveManifest.join("\n"), "utf8");
  fs.writeFileSync(path.join(outputDir, "dependency-map.json"), JSON.stringify(result.dependencyMap, null, 2), "utf8");
  if (result.qualityGateResult) {
    fs.writeFileSync(path.join(outputDir, "quality-gate.json"), JSON.stringify(result.qualityGateResult, null, 2), "utf8");
  }
  fs.writeFileSync(path.join(outputDir, "build-result-meta.json"), JSON.stringify({
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
