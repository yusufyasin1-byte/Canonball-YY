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
    expect(artifact?.workflowMappings).toHaveLength(2);
    expect(artifact?.workflowMappings[0].localTestCaseId).toMatch(/[0-9a-f-]{36}/i);

    const zip = new AdmZip(artifact!.buffer);
    const entryNames = zip.getEntries().map((entry) => entry.entryName);

    expect(entryNames).toContain("WelcomeEmailAutomation_Tests/project.json");
    expect(entryNames.some((entry) => entry.endsWith(".xaml"))).toBe(true);
    expect(entryNames).toContain("WelcomeEmailAutomation_Tests/.settings/Release/settings-82ca306a.json");
    expect(entryNames).toContain("WelcomeEmailAutomation_Tests/.settings/Release/settings-9e9290da.json");

    const projectJson = JSON.parse(zip.readAsText("WelcomeEmailAutomation_Tests/project.json"));
    expect(projectJson.designOptions.outputType).toBe("Tests");
    expect(projectJson.entryPoints).toHaveLength(2);
    expect(projectJson.designOptions.fileInfoCollection[0].testCaseId).toBe(artifact?.workflowMappings[0].localTestCaseId);
    expect(projectJson.projectId).toMatch(/[0-9a-f-]{36}/i);
    expect(projectJson.entryPoints[0].uniqueId).toBe(artifact?.workflowMappings[0].localTestCaseId);

    const firstWorkflow = zip.readAsText(`WelcomeEmailAutomation_Tests/${artifact!.workflowFiles[0]}`);
    expect(firstWorkflow).toContain("Verify Generated Test Placeholder");
    expect(firstWorkflow).toContain("TC001 - Happy path started for WelcomeEmailAutomation");
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
