import fs from "node:fs";
import path from "node:path";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TableOfContents,
  TextRun,
  type ParagraphChild,
} from "docx";

type Section = {
  heading: string;
  body: string[];
};

const outputDir = process.env.UIPATH_DOC_OUTPUT_DIR
  ? path.resolve(process.env.UIPATH_DOC_OUTPUT_DIR)
  : path.resolve(process.cwd(), "simulation_output_po_invoice", "docs");
const mdPath = path.join(outputDir, "POInvoiceTestNew_DSD_AutomationHub.md");
const docxPath = path.join(outputDir, "POInvoiceTestNew_DSD_AutomationHub.docx");

const sections: Section[] = [
  {
    heading: "## 1. Purpose",
    body: [
      "This Detailed Solution Design Document (DSD) defines the implementation-oriented design for the `POInvoiceTestNew` automation. The automation validates supplier invoices submitted through Coupa, compares them to purchase orders, routes exceptions for review, and progresses valid invoices through the approval path.",
      "This document is intended for UiPath developers, support engineers, solution architects, and operational teams who need workflow-level design guidance beyond the higher-level SDD.",
    ],
  },
  {
    heading: "## 2. Automated process details",
    body: [
      "The automation monitors inbound Coupa invoice submissions, creates a transaction/work item for each eligible invoice, retrieves invoice attachments and header data, performs extraction and purchase-order validation, and determines whether the invoice can continue straight-through or must be routed to exception handling.",
      "Business outcomes implemented by the automation include: PO existence validation, 2-way match validation, tolerance checks, Action Center review for low-confidence cases, supplier messaging for invalid submissions, and persistence of audit/evidence artifacts.",
    ],
  },
  {
    heading: "## 3. Runtime guide",
    body: [
      "Execution model: unattended Windows process deployed to UiPath Orchestrator, with queue-backed transaction orchestration and solution-managed resources.",
      "Primary runtime flow: initialize settings -> create or pick up invoice work item -> retrieve invoice PDF and header data -> retrieve PO details -> validate rules -> route to approval or exception -> persist outcome and evidence.",
      "Operational dependencies: Coupa connectivity, queue availability, assets for confidence threshold/tolerance/configuration, storage bucket availability, and Action Center availability for human review scenarios.",
      "Monitoring expectations: monitor queue volume, failed jobs, Action Center task backlog, and storage bucket evidence generation. Support teams should inspect logs for invoice identifiers, Coupa retrieval status, validation outcomes, and persistence outcomes.",
    ],
  },
  {
    heading: "## 4. Architectural structure of the Master Project",
    body: [
      "The master project follows a modular workflow architecture centered on a transaction orchestration flow. `Main.xaml` acts as the entry point and delegates processing responsibilities to specialized workflows.",
      "Key components are: initialization/configuration, intake/queue dispatch, Coupa invoice retrieval, PO retrieval, review and exception handling, and audit/persistence.",
      "The solution design also includes Orchestrator-managed resources: queue `POInvoiceValidationQueue`, assets `POInvoice_ConfidenceThreshold`, `POInvoice_TolerancePercent`, `POInvoice_CoupaConnection`, `POInvoice_WebhookConnection`, and storage bucket `po-invoice-evidence`.",
    ],
  },
  {
    heading: "## 5. Master Project Runtime Details",
    body: [
      "Target framework: Windows.",
      "Robot type: unattended.",
      "Generation mode used for the verified PO package: `baseline_openable`.",
      "Key runtime assumptions: Coupa event/polling feed is available, DU extraction confidence threshold is externally configurable, tolerance percentage is externally configurable, and invoice evidence is stored for traceability.",
      "Straight-through processing occurs only when extraction confidence is sufficient, the PO exists, 2-way match passes, and the invoice amount is within the configured tolerance.",
    ],
  },
  {
    heading: "## 6. Project details",
    body: [
      "Project name: `POInvoiceTestNew`.",
      "Primary purpose: validate and route PO-backed invoices from Coupa for approval or rejection.",
      "Dependencies validated in the generated simulation output: `UiPath.System.Activities 26.2.4`, `UiPath.Excel.Activities 3.4.1`, and `UiPath.UIAutomation.Activities 25.10.28`.",
      "Generated workflow inventory: `Main.xaml`, `IntakeDispatcher.xaml`, `Retrieve_Invoice_Pdf_And_Header_Data_From_CoupaWorkflow.xaml`, `ReviewAndExceptionHandling.xaml`, `Retrieve_Po_Details_From_CoupaWorkflow.xaml`, `AuditAndPersistence.xaml`, `InitAllSettings.xaml`.",
      "Core transaction contract: each invoice transaction should carry invoice identifiers, invoice header data, extraction results, PO validation state, review state, and final disposition metadata through the workflow chain.",
    ],
  },
  {
    heading: "## 7. Project(s) workflows",
    body: [
      "`Main.xaml`: main orchestration entry point. Initializes the processing run and routes control to the appropriate downstream workflow sequence.",
      "`InitAllSettings.xaml`: loads settings/assets used during execution, including tolerance and extraction thresholds.",
      "`IntakeDispatcher.xaml`: creates or orchestrates the initial work item for a Coupa invoice submission. This is the workflow that introduces the queue reference and dispatch semantics for processing.",
      "`Retrieve_Invoice_Pdf_And_Header_Data_From_CoupaWorkflow.xaml`: retrieves the invoice attachment and header metadata required for validation and downstream extraction logic.",
      "`Retrieve_Po_Details_From_CoupaWorkflow.xaml`: retrieves the matching PO data from Coupa to support presence and 2-way match validation.",
      "`ReviewAndExceptionHandling.xaml`: routes low-confidence or invalid cases to Action Center or supplier messaging/rejection flows.",
      "`AuditAndPersistence.xaml`: records final outcome details, audit metadata, and evidence artifacts for support and reporting.",
    ],
  },
  {
    heading: "## 8. Other Details",
    body: [
      "Exception handling: invalid PO, missing PO, failed 2-way match, amount outside tolerance, low-confidence extraction, and downstream approval rejection must all be handled deterministically without silent continuation.",
      "Human-in-the-loop: low-confidence extraction scenarios create Action Center review tasks under the task catalog `POInvoiceExtractionReview` for the `AP Processor` role.",
      "Storage and evidence: invoice PDFs and extracted metadata snapshots are written to `po-invoice-evidence` for traceability and audit support.",
      "Deployment model: the automation is designed to run under a stable solution folder and solution deployment identity so upgrades reuse the same resource boundary instead of creating new folders per version.",
    ],
  },
  {
    heading: "## 9. Debugging Tips",
    body: [
      "If invoices are not progressing, first check `POInvoiceValidationQueue` for item creation and queue item state transitions.",
      "If Coupa data is missing, validate the `POInvoice_CoupaConnection` asset and confirm the integration endpoint or webhook configuration.",
      "If straight-through processing is lower than expected, review the configured confidence threshold and inspect extraction confidence outcomes in logs and Action Center tasks.",
      "If supplier messaging or rejection does not occur as expected, inspect `ReviewAndExceptionHandling.xaml` logs for decision-branch selection and invalid-case routing.",
      "If audit or evidence artifacts are missing, verify the `po-invoice-evidence` bucket configuration and inspect `AuditAndPersistence.xaml` execution logs.",
    ],
  },
  {
    heading: "## 10. Post UAT Specifications",
    body: [
      "Confirm production values for confidence threshold and tolerance assets.",
      "Confirm Action Center task catalog ownership, reviewer role assignment, and SLA expectations.",
      "Validate solution deployment in the target Orchestrator folder with process, queue, assets, and storage bucket all present.",
      "Execute at least one happy-path and one exception-path automated test from Test Manager before production release.",
      "Ensure operational support runbook includes Coupa connectivity checks, queue monitoring, Action Center backlog checks, and evidence retrieval procedures.",
    ],
  },
  {
    heading: "## 11. Glossary",
    body: [
      "Coupa: Source business platform for invoice and PO data.",
      "DU: Document Understanding, used for extracting structured fields from invoice content.",
      "2-way match: Comparison of invoice details against purchase-order details to validate commercial consistency.",
      "DOA: Delegation of Authority approval path used to route valid invoices for approval.",
      "Action Center: UiPath human-in-the-loop tasking surface for review/correction cases.",
      "Evidence bucket: UiPath storage bucket used to retain invoice files and metadata snapshots.",
    ],
  },
];

function buildMarkdown(): string {
  const intro = [
    "# POInvoiceTestNew - Detailed Solution Design Document",
    "",
    "Generated using the UiPath Automation Hub DSD template structure.",
    "",
  ];

  const body = sections.flatMap((section) => [
    section.heading,
    "",
    ...section.body,
    "",
  ]);

  return [...intro, ...body].join("\n");
}

function headingLevelFor(sectionHeading: string): HeadingLevel {
  if (/^##\s+\d+\./.test(sectionHeading)) {
    return HeadingLevel.HEADING_1;
  }
  return HeadingLevel.HEADING_2;
}

function headingText(sectionHeading: string): string {
  return sectionHeading.replace(/^##\s*/, "").trim();
}

function paragraphFromLine(line: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: line })],
    spacing: { after: 160 },
  });
}

async function main(): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });

  const markdown = buildMarkdown();
  fs.writeFileSync(mdPath, markdown, "utf8");

  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: "POInvoiceTestNew - Detailed Solution Design Document", bold: true })],
      spacing: { after: 240 },
    }),
    new Paragraph({
      children: [new TextRun({ text: "Generated using the UiPath Automation Hub DSD template structure." })],
      spacing: { after: 240 },
    }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: "Table of Contents", bold: true })],
    }),
    new Paragraph({
      children: [],
    }),
  ];

  const tocDoc = new TableOfContents("Summary", {
    hyperlink: true,
    headingStyleRange: "1-3",
  });

  const sectionParagraphs: Paragraph[] = [];
  for (const section of sections) {
    sectionParagraphs.push(
      new Paragraph({
        heading: headingLevelFor(section.heading),
        children: [new TextRun({ text: headingText(section.heading), bold: true })],
        spacing: { before: 240, after: 120 },
      })
    );
    for (const line of section.body) {
      sectionParagraphs.push(paragraphFromLine(line));
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          ...children,
          new Paragraph({
            children: [tocDoc as unknown as ParagraphChild],
          }),
          ...sectionParagraphs,
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(docxPath, buffer);

  console.log(`Generated markdown: ${mdPath}`);
  console.log(`Generated docx: ${docxPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
