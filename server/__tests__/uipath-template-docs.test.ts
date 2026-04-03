import { describe, expect, it } from "vitest";
import {
  buildDsdTemplatePrompt,
  buildPddTemplatePrompt,
  buildSddTemplatePrompt,
  DSD_TEMPLATE_SECTIONS,
  ensureTemplateSections,
  PDD_TEMPLATE_SECTIONS,
  SDD_TEMPLATE_SECTIONS,
} from "../doc-templates/uipath-template-docs";

describe("UiPath template document helpers", () => {
  it("includes all required PDD sections in the template prompt", () => {
    const prompt = buildPddTemplatePrompt();
    for (const section of PDD_TEMPLATE_SECTIONS) {
      expect(prompt).toContain(section);
    }
  });

  it("normalizes missing sections with completion placeholders", () => {
    const content = "## 1. Purpose\n\nDocument purpose.\n\n## 3. Runtime guide\n\nRuntime notes.";
    const normalized = ensureTemplateSections(content, SDD_TEMPLATE_SECTIONS.slice(0, 3));

    expect(normalized).toContain("## 1. Purpose\n\nDocument purpose.");
    expect(normalized).toContain("## 2. Automated process details\n\n_To be completed._");
    expect(normalized).toContain("## 3. Runtime guide\n\nRuntime notes.");
  });

  it("builds SDD and DSD prompts with their exact required sections", () => {
    const sddPrompt = buildSddTemplatePrompt("Action Center available", "UiPath.System.Activities 25.10.7", "hybrid");
    const dsdPrompt = buildDsdTemplatePrompt();

    for (const section of SDD_TEMPLATE_SECTIONS) {
      expect(sddPrompt).toContain(section);
    }
    for (const section of DSD_TEMPLATE_SECTIONS) {
      expect(dsdPrompt).toContain(section);
    }
  });
});
