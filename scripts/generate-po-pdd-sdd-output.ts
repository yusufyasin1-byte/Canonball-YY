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

const pddSections: Section[] = [
  { heading: "## 1. Introduction", body: ["This Process Design Document defines the business process, scope, exceptions, and target automation behavior for the PO invoice validation and approval use case. It is aligned to the UiPath Automation Hub PDD structure and is intended for business, delivery, and automation stakeholders."] },
  { heading: "## 2. Purpose", body: ["The purpose of this automation is to reduce manual effort in validating supplier invoices submitted in Coupa, improve consistency of decisioning, and ensure valid invoices are progressed efficiently while invalid or low-confidence cases are handled in a controlled way."] },
  { heading: "## 3. Objectives", body: ["Automate invoice intake and validation against Coupa POs.", "Apply confidence, match, and tolerance rules consistently.", "Route valid invoices for approval and invalid cases for rejection or review.", "Persist evidence and audit details for operational traceability."] },
  { heading: "## 4. Key Contacts", body: ["Business owner: Accounts Payable / Invoice Operations.", "System owner: Coupa platform owner.", "Automation owner: UiPath support and delivery team.", "Human review team: AP Processor role through Action Center."] },
  { heading: "## 5. Minimum Pre-requisites for the Automation", body: ["Coupa connectivity must be available.", "Required Orchestrator resources must exist: queue, assets, storage bucket, Action Center task catalog.", "Document extraction capability must be configured with an agreed confidence threshold.", "Approval routing rules in Coupa must be available for valid invoices."] },
  { heading: "## 6. AS IS Process description", body: ["Today the invoice validation activity is manual or semi-manual: invoice data is reviewed, PO information is checked in Coupa, line and total values are compared, and approval/rejection decisions are made based on business rules."] },
  { heading: "## 7. Process Overview", body: ["The target process begins when an invoice is submitted in Coupa. The automation creates a work item, retrieves invoice and PO data, evaluates extraction confidence and business validation rules, and then either routes the invoice for approval or handles exceptions such as low confidence, PO issues, mismatch, or tolerance breach."] },
  { heading: "## 8. Applications Used", body: ["Coupa", "UiPath Orchestrator", "UiPath Action Center", "UiPath Storage Bucket", "Document Understanding / extraction capability", "Data persistence layer for audit outcomes"] },
  { heading: "## 9. AS IS Process Map", body: ["The approved As-Is process map should show the current manual review of invoice submissions, PO lookup, comparison steps, and manual progression or rejection decisions."] },
  { heading: "## 10. High Level Process Map", body: ["At a high level, the target process is: ingest invoice -> retrieve invoice and PO data -> validate -> route for approval or handle exception -> persist outcome."] },
  { heading: "## 11. Detailed Level Process Map", body: ["The detailed target process includes confidence assessment, Action Center review for low-confidence extraction, PO presence check, 2-way match validation, tolerance validation, supplier messaging, invoice rejection, Coupa approval routing, and persistence of final outcomes."] },
  { heading: "## 12. Process Statistics", body: ["Volume and SLA metrics are to be confirmed with the business. The process design assumes transaction-style handling of invoice work items and should support daily operational monitoring of queue items, exceptions, and approvals."] },
  { heading: "## 13. Detailed As Is Process Actions", body: ["1. Supplier submits invoice in Coupa.", "2. AP reviews invoice details manually.", "3. AP checks PO existence and data in Coupa.", "4. AP compares vendor, lines, and totals.", "5. AP determines whether amount is acceptable within business tolerance.", "6. AP routes valid invoices for approval or rejects/issues follow-up for invalid cases."] },
  { heading: "## 14. Exceptions Handling", body: ["Low-confidence extraction routes to AP review.", "Missing or not-found PO triggers supplier messaging and rejection path.", "2-way match failure triggers supplier messaging and rejection path.", "Amount outside tolerance triggers supplier messaging and rejection path.", "Approval rejection after routing leads to supplier notification and final rejection handling."] },
  { heading: "## 15. Input Data Description", body: ["Invoice PDF attachment.", "Invoice header metadata from Coupa.", "PO number.", "Vendor details.", "Invoice number.", "Invoice amount and line totals.", "PO header, vendor, line, and total details from Coupa."] },
  { heading: "## 16. TO BE Process description", body: ["The To-Be process is an unattended automation that ingests Coupa invoice events, validates invoice data and PO consistency, escalates low-confidence cases to human review, progresses valid invoices through approval, and rejects invalid invoices with supplier-facing messages and stored evidence."] },
  { heading: "## 17. Detailed TO BE Process Map", body: ["The To-Be map should explicitly show the straight-through route for valid invoices and the exception branches for missing PO, match failure, tolerance failure, low-confidence extraction, and approval rejection."] },
  { heading: "## 18. Parallel Initiatives", body: ["No confirmed parallel initiatives are embedded in this design. Any related Coupa process changes or extraction-model improvements should be tracked separately."] },
  { heading: "## 19. In Scope For RPA", body: ["Invoice event ingestion.", "Queue/work item creation.", "Invoice PDF and header retrieval.", "PO retrieval.", "Validation and tolerance checks.", "Action Center routing for low-confidence extraction.", "Supplier messaging and rejection routing.", "Approval progression.", "Audit and evidence persistence."] },
  { heading: "## 20. Out Of Scope for RPA", body: ["Supplier master data correction.", "PO master data cleanup.", "Manual business exception adjudication beyond routed review.", "Upstream document format redesign.", "Downstream ERP logic not included in the approved target process."] },
  { heading: "## 21. Known Business Exceptions", body: ["Missing PO number.", "PO not found in Coupa.", "2-way match failure.", "Amount outside tolerance.", "Approval rejection after routing."] },
  { heading: "## 22. Unknown Business Exceptions", body: ["Unknown exceptions should be logged and routed for operational review. They should be added to future process revisions once patterns are confirmed."] },
  { heading: "## 23. Known Applications Errors and Exceptions", body: ["Coupa connectivity failure.", "Retrieval failure for invoice or PO data.", "Action Center task creation issues.", "Storage bucket or persistence unavailability.", "Platform/configuration errors in Orchestrator resources."] },
  { heading: "## 24. Unknown Applications Errors and Exceptions", body: ["Unknown technical exceptions should be logged with invoice identifiers and operational context, then surfaced to support for triage and remediation."] },
  { heading: "## 25. Reporting", body: ["Operational reporting should include invoice volume, straight-through rate, exception categories, Action Center review volume, approval outcomes, and failure trends. Support reporting should include queue backlog, failed jobs, and missing evidence incidents."] },
  { heading: "## 26. Other", body: ["The process assumes controlled deployment under a stable solution folder and use-case identity so that supporting resources remain consistent across upgrades."] },
];

const sddSections: Section[] = [
  { heading: "## 1. Purpose", body: ["This Solution Design Document describes the target UiPath solution architecture for `POInvoiceTestNew`, including runtime model, workflows, dependencies, platform resources, and deployment-oriented guidance."] },
  { heading: "## 2. Automated process details", body: ["The automation validates supplier invoices submitted in Coupa by retrieving invoice and PO data, evaluating extraction confidence and business rules, routing valid invoices for approval, and managing exception/review paths for invalid or uncertain cases."] },
  { heading: "## 3. Runtime guide", body: ["Execution mode: unattended Windows automation.", "Trigger model: webhook or polling-driven intake with queue-backed processing.", "Support teams should monitor queue state, Action Center backlog, failed jobs, and evidence storage health."] },
  { heading: "## 4. Architectural structure of the Master Project", body: ["The solution is composed of a master entry workflow and specialized child workflows for initialization, intake, Coupa data retrieval, exception handling, and persistence.", "The project is designed for solution-managed deployment with Orchestrator resources encapsulated under a stable use-case deployment boundary."] },
  { heading: "## 5. Master Project Runtime Details", body: ["Target framework: Windows.", "Generation mode: baseline_openable for the verified simulation.", "Core resources: queue `POInvoiceValidationQueue`, assets `POInvoice_ConfidenceThreshold`, `POInvoice_TolerancePercent`, `POInvoice_CoupaConnection`, `POInvoice_WebhookConnection`, storage bucket `po-invoice-evidence`, Action Center task catalog `POInvoiceExtractionReview`."] },
  { heading: "## 6. Project name", body: ["Project name: `POInvoiceTestNew`."] },
  { heading: "## 7. Project(s) workflows", body: ["`Main.xaml`: orchestration entry point.", "`InitAllSettings.xaml`: configuration initialization.", "`IntakeDispatcher.xaml`: queue/work-item creation and intake orchestration.", "`Retrieve_Invoice_Pdf_And_Header_Data_From_CoupaWorkflow.xaml`: invoice and metadata retrieval.", "`Retrieve_Po_Details_From_CoupaWorkflow.xaml`: PO lookup and retrieval.", "`ReviewAndExceptionHandling.xaml`: exception routing, review, supplier messaging, and rejection.", "`AuditAndPersistence.xaml`: persistence of outcomes and evidence."] },
  { heading: "## 8. Packages", body: ["Validated package set from the simulation output: `UiPath.System.Activities 26.2.4`, `UiPath.Excel.Activities 3.4.1`, `UiPath.UIAutomation.Activities 25.10.28`. Additional package requirements should be governed through the shared package validation pipeline."] },
  { heading: "## 9. Other Details", body: ["Security: configuration values should be externalized through assets or secure connections.", "Exception handling: business and technical failures should be logged and routed deterministically.", "Testing: happy-path and exception-path test cases should be maintained in Test Manager and executed against the deployed automation."] },
  { heading: "## 10. Future Improvements", body: ["Promote hybrid-specific dependencies when connector contracts are fully proven.", "Expand automated test coverage across additional exception branches.", "Deepen reporting and support dashboards for operational analytics."] },
  { heading: "## 11. Other Remarks", body: ["The solution is intentionally designed for stable-folder upgrade behavior so the same solution deployment identity can be reused across versions."] },
  { heading: "## 12. Glossary", body: ["Coupa, DU, 2-way match, DOA, Action Center, queue reference, evidence bucket."] },
  { heading: "## 13. Orchestrator & Platform Deployment Specification", body: ["Recommended deployment target: stable solution deployment in `CB2YY Solutions`.", "Expected deployed resources: process `POInvoiceTestNew`, queue `POInvoiceValidationQueue`, four assets, storage bucket `po-invoice-evidence`.", "Deployment validation should confirm process presence, asset count, queue count, storage bucket presence, and successful activation of the expected version."] },
];

function buildMarkdown(title: string, sections: Section[]): string {
  return [
    `# ${title}`,
    "",
    "Generated using the UiPath Automation Hub template structure.",
    "",
    ...sections.flatMap((section) => [section.heading, "", ...section.body, ""]),
  ].join("\n");
}

function headingLevelFor(text: string): HeadingLevel {
  return /^##\s+\d+\./.test(text) ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2;
}

function headingText(text: string): string {
  return text.replace(/^##\s*/, "").trim();
}

async function writeDocSet(baseName: string, title: string, sections: Section[]): Promise<void> {
  const mdPath = path.join(outputDir, `${baseName}.md`);
  const docxPath = path.join(outputDir, `${baseName}.docx`);

  fs.writeFileSync(mdPath, buildMarkdown(title, sections), "utf8");

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
      sectionParagraphs.push(
        new Paragraph({
          children: [new TextRun({ text: line })],
          spacing: { after: 160 },
        })
      );
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            children: [new TextRun({ text: title, bold: true })],
            spacing: { after: 240 },
          }),
          new Paragraph({
            children: [new TextRun({ text: "Generated using the UiPath Automation Hub template structure." })],
            spacing: { after: 240 },
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "Table of Contents", bold: true })],
          }),
          new Paragraph({
            children: [new TableOfContents("Summary", { hyperlink: true, headingStyleRange: "1-3" }) as unknown as ParagraphChild],
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

async function main(): Promise<void> {
  fs.mkdirSync(outputDir, { recursive: true });
  await writeDocSet("POInvoiceTestNew_PDD_AutomationHub", "POInvoiceTestNew - Process Design Document", pddSections);
  await writeDocSet("POInvoiceTestNew_SDD_AutomationHub", "POInvoiceTestNew - Solution Design Document", sddSections);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
