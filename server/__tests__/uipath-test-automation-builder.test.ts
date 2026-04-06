import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { buildUiPathTestAutomationArtifact } from "../uipath-test-automation-builder";

describe("UiPath test automation builder", () => {
  it("builds a Studio-openable test automation project zip from generated test cases", () => {
    const artifact = buildUiPathTestAutomationArtifact({
      projectName: "WelcomeEmailAutomation",
      version: "1.0.20260403",
      testCases: [
        {
          name: "TC001 - Happy path",
          description: "Sends the welcome email when the new joiner is valid.",
          steps: [
            { action: "Read today's new joiners", expected: "Single eligible employee found" },
            { action: "Send welcome email", expected: "Message is sent successfully" },
          ],
        },
        {
          name: "TC002 - Missing email",
          description: "Routes the case to HR when the employee email address is absent.",
          steps: [
            { action: "Read today's new joiners", expected: "Employee record is returned" },
            { action: "Validate required email field", expected: "HR follow-up is triggered" },
          ],
        },
      ],
      testSets: [
        {
          name: "Smoke",
          description: "Core path validation",
          testCaseNames: ["TC001 - Happy path"],
        },
      ],
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.fileName).toContain("WelcomeEmailAutomation_Tests");
    expect(artifact?.workflowCount).toBe(2);
    expect(artifact?.workflowFiles).toHaveLength(2);

    const zip = new AdmZip(artifact!.buffer);
    const entryNames = zip.getEntries().map((entry) => entry.entryName);

    expect(entryNames).toContain("WelcomeEmailAutomation_Tests/project.json");
    expect(entryNames).toContain("WelcomeEmailAutomation_Tests/README.md");
    expect(entryNames.some((entry) => entry.endsWith(".xaml"))).toBe(true);

    const projectJson = JSON.parse(zip.readAsText("WelcomeEmailAutomation_Tests/project.json"));
    expect(projectJson.designOptions.outputType).toBe("Tests");
    expect(projectJson.entryPoints).toHaveLength(2);

    const readme = zip.readAsText("WelcomeEmailAutomation_Tests/README.md");
    expect(readme).toContain("TC001 - Happy path");
    expect(readme).toContain("Smoke");

    const firstWorkflow = zip.readAsText(`WelcomeEmailAutomation_Tests/${artifact!.workflowFiles[0]}`);
    expect(firstWorkflow).toContain("Verify Generated Test Placeholder");
    expect(firstWorkflow).toContain("Test started: TC001 - Happy path");
    expect(firstWorkflow).toContain("Action: Read today&apos;s new joiners");
  });

  it("returns null when there are no test cases", () => {
    const artifact = buildUiPathTestAutomationArtifact({
      projectName: "NoTests",
      version: "1.0.0",
      testCases: [],
      testSets: [],
    });

    expect(artifact).toBeNull();
  });
});
