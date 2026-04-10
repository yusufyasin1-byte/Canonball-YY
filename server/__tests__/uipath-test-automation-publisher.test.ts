import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { buildUiPathTestAutomationArtifact } from "../uipath-test-automation-builder";
import { __testUtils } from "../uipath-test-automation-publisher";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("UiPath test automation publisher", () => {
  it("writes Test Manager linkage metadata into the generated project", () => {
    const artifact = buildUiPathTestAutomationArtifact({
      projectName: "POInvoiceTestNew",
      version: "1.0.0-test",
      testCases: [
        {
          name: "TC001 - Happy Path",
          description: "Happy path coverage",
          steps: [{ action: "Run PO processing", expected: "Invoice posted" }],
        },
        {
          name: "TC002 - Missing PO",
          description: "Missing PO exception path",
          steps: [{ action: "Process invoice without PO", expected: "Exception path raised" }],
        },
      ],
      testSets: [],
    });

    expect(artifact).not.toBeNull();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb2yy-linked-tests-"));
    tempDirs.push(tmp);

    new AdmZip(artifact!.buffer).extractAllTo(tmp, true);
    const projectDir = path.join(tmp, artifact!.projectName);
    const projectJsonPath = path.join(projectDir, "project.json");

    __testUtils.patchProjectJson({
      projectJsonPath,
      artifact: artifact!,
      packageVersion: "1.0.123-test.1",
      tmProjectName: "POInvoiceTestNew",
    });

    const config = __testUtils.buildTmConfig(
      artifact!,
      artifact!.workflowMappings.map((mapping, index) => ({
        testCaseName: mapping.testCaseName,
        tmTestCaseId: String(index + 1),
        tmObjKey: `POINVOICET:${index + 1}`,
      })),
      "https://cloud.uipath.com/uipatezkzunj/DefaultTenant/testmanager_/",
    );

    const projectJson = JSON.parse(fs.readFileSync(projectJsonPath, "utf8"));
    expect(projectJson.projectVersion).toBe("1.0.123-test.1");
    expect(projectJson.publishData.packageName).toBe(artifact!.projectName);
    expect(projectJson.publishData.testManagerProjectName).toBe("POInvoiceTestNew");
    expect(projectJson.designOptions.fileInfoCollection).toHaveLength(2);
    expect(projectJson.designOptions.fileInfoCollection[0].testCaseId).toBe(artifact!.workflowMappings[0].localTestCaseId);

    expect(config.testManagerBasePath).toContain("/testmanager_/");
    expect(config.issueKeyTestcaseValues[artifact!.workflowMappings[0].localTestCaseId]).toBe("POINVOICET:1");
    expect(config.issueKeyTestcaseValues[artifact!.workflowMappings[1].localTestCaseId]).toBe("POINVOICET:2");
  });
});
