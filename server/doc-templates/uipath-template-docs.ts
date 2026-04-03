export const PDD_TEMPLATE_SECTIONS = [
  "## 1. Introduction",
  "## 2. Purpose",
  "## 3. Objectives",
  "## 4. Key Contacts",
  "## 5. Minimum Pre-requisites for the Automation",
  "## 6. AS IS Process description",
  "## 7. Process Overview",
  "## 8. Applications Used",
  "## 9. AS IS Process Map",
  "## 10. High Level Process Map",
  "## 11. Detailed Level Process Map",
  "## 12. Process Statistics",
  "## 13. Detailed As Is Process Actions",
  "## 14. Exceptions Handling",
  "## 15. Input Data Description",
  "## 16. TO BE Process description",
  "## 17. Detailed TO BE Process Map",
  "## 18. Parallel Initiatives",
  "## 19. In Scope For RPA",
  "## 20. Out Of Scope for RPA",
  "## 21. Known Business Exceptions",
  "## 22. Unknown Business Exceptions",
  "## 23. Known Applications Errors and Exceptions",
  "## 24. Unknown Applications Errors and Exceptions",
  "## 25. Reporting",
  "## 26. Other",
] as const;

export const SDD_TEMPLATE_SECTIONS = [
  "## 1. Purpose",
  "## 2. Automated process details",
  "## 3. Runtime guide",
  "## 4. Architectural structure of the Master Project",
  "## 5. Master Project Runtime Details",
  "## 6. Project name",
  "## 7. Project(s) workflows",
  "## 8. Packages",
  "## 9. Other Details",
  "## 10. Future Improvements",
  "## 11. Other Remarks",
  "## 12. Glossary",
  "## 13. Orchestrator & Platform Deployment Specification",
] as const;

export const DSD_TEMPLATE_SECTIONS = [
  "## 1. Purpose",
  "## 2. Automated process details",
  "## 3. Runtime guide",
  "## 4. Architectural structure of the Master Project",
  "## 5. Master Project Runtime Details",
  "## 6. Project details",
  "## 7. Project(s) workflows",
  "## 8. Other Details",
  "## 9. Debugging Tips",
  "## 10. Post UAT Specifications",
  "## 11. Glossary",
] as const;

function buildSectionList(sections: readonly string[]): string {
  return sections.map((section) => `- ${section}`).join("\n");
}

export function buildPddTemplatePrompt(): string {
  return `Generate a UiPath Process Design Document using the official Automation Hub PDD template structure.

You MUST output the sections below exactly, in this exact order, using markdown headings that match verbatim:
${buildSectionList(PDD_TEMPLATE_SECTIONS)}

Rules:
- Write this as a professional Process Design Document, not as a casual summary.
- Be specific to the approved process context, process maps, and conversation details.
- When information is not explicitly available, state a cautious, professional assumption instead of inventing specifics.
- For process map sections, describe what the map represents and reference the approved As-Is and To-Be process maps.
- For "Parallel Initiatives" and unknown-exception sections, write a short, realistic status even if the answer is "No confirmed items at this stage."
- For "Detailed As Is Process Actions", describe the sequence of business steps clearly enough that a business analyst can review them.
- For "Input Data Description", list the business data fields and their purpose.
- For "Reporting", describe business and operational reporting expected from the automation.

Do not skip sections. If a section is thin, include a short professional statement rather than omitting it.`;
}

export function buildSddTemplatePrompt(platformCapabilities?: string, packageRegistryContext?: string, automationType?: string): string {
  const platformContext = platformCapabilities
    ? `\n\nPlatform-aware context:\n${platformCapabilities}`
    : "";
  const packageContext = packageRegistryContext
    ? `\n\nValidated package registry:\n${packageRegistryContext}`
    : "";
  const agentNote = automationType === "agent" || automationType === "hybrid"
    ? `\n\nThis use case is classified as ${automationType}. Include agent-specific architectural considerations where relevant.`
    : "";

  return `Generate a UiPath Solution Design Document using the official Automation Hub SDD template structure.${platformContext}${packageContext}${agentNote}

You MUST output the sections below exactly, in this exact order, using markdown headings that match verbatim:
${buildSectionList(SDD_TEMPLATE_SECTIONS)}

Rules:
- Keep the document solution-architecture focused, not business-justification focused.
- "Runtime guide" must describe how the automation should run in UiPath.
- "Architectural structure of the Master Project" must describe the solution shape, major components, and interaction model.
- "Master Project Runtime Details" must describe runtime model, triggers, queues, assets, storage, human-in-the-loop behavior, and operational execution guidance.
- "Project(s) workflows" must describe the purpose of each workflow/component.
- "Packages" must list UiPath dependencies and versions where known.${packageRegistryContext ? "\n- Use exact validated package versions when available. Do not invent versions." : ""}
- "Other Details" should include integration points, exception handling, security, testing, governance, and data model details as applicable.
- "Glossary" must define UiPath/platform/business terms used in the document.
- "Orchestrator & Platform Deployment Specification" must contain the deployment-oriented artifacts guidance and can reference the machine-readable artifact block produced separately.

Do not skip sections. If some information is not yet finalized, state that explicitly in a professional way.`;
}

export function buildDsdTemplatePrompt(): string {
  return `Generate a UiPath Detailed Solution Design Document using the official Automation Hub DSD template structure.

You MUST output the sections below exactly, in this exact order, using markdown headings that match verbatim:
${buildSectionList(DSD_TEMPLATE_SECTIONS)}

Rules:
- This document should be implementation and runtime oriented.
- Reuse and refine approved PDD and SDD content; do not contradict them.
- "Runtime guide" must describe execution, dependencies, operational sequence, monitoring expectations, and support handoff guidance.
- "Architectural structure of the Master Project" and "Project(s) workflows" must go deeper than the SDD and be specific about workflow roles, inputs/outputs, and interactions.
- "Project details" should include workflow inventory, contracts, dependencies, and implementation-relevant information.
- "Other Details" should capture exception handling, environmental assumptions, deployment dependencies, and quality/support notes.
- "Debugging Tips" must include practical troubleshooting guidance for UiPath developers and support staff.
- "Post UAT Specifications" must capture production-readiness or post-UAT completion items.
- "Glossary" must define technical and business terms used in the document.

Do not skip sections. If a section is not yet fully known, provide a cautious implementation note rather than omitting the section.`;
}

export function ensureTemplateSections(content: string, sections: readonly string[]): string {
  const normalized = (content || "").replace(/\r\n/g, "\n").trim();
  const pieces: string[] = [];

  for (const section of sections) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`${escaped}\\s*([\\s\\S]*?)(?=\\n##\\s+\\d+\\.|$)`, "i");
    const match = normalized.match(regex);
    const body = match?.[1]?.trim();
    pieces.push(`${section}\n\n${body && body.length > 0 ? body : "_To be completed._"}`);
  }

  return pieces.join("\n\n");
}
