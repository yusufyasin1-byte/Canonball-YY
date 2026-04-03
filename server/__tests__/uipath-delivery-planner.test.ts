import { describe, expect, it } from "vitest";
import { extractUiPathTestDesign, recommendUiPathDelivery } from "../uipath-delivery-planner";
import type { UiPathPackage } from "../types/uipath-package";

describe("UiPath delivery planner", () => {
  it("recommends a solution when shared resources are present", () => {
    const pkg: UiPathPackage = {
      projectName: "InvoiceAutomation",
      description: "",
      dependencies: [],
      workflows: [{ name: "Main", description: "", variables: [], steps: [] }],
      internal: {
        automationType: "rpa",
      },
    };

    const recommendation = recommendUiPathDelivery({
      pkg,
      orchestratorArtifacts: {
        queues: [{ name: "InvoiceQueue" }],
        assets: [{ name: "ApiKey" }],
      },
    });

    expect(recommendation.recommendedOutput).toBe("solution");
    expect(recommendation.signals.sharedResourceCount).toBe(2);
  });

  it("keeps simple single-project automations as packages", () => {
    const pkg: UiPathPackage = {
      projectName: "SimpleAutomation",
      description: "",
      dependencies: [],
      workflows: [{ name: "Main", description: "", variables: [], steps: [] }],
      internal: {
        automationType: "rpa",
      },
    };

    const recommendation = recommendUiPathDelivery({
      pkg,
      orchestratorArtifacts: {},
    });

    expect(recommendation.recommendedOutput).toBe("package");
  });

  it("extracts normalized test cases and sets from orchestrator artifacts", () => {
    const testDesign = extractUiPathTestDesign({
      testCases: [
        {
          name: "TC001 - Happy path",
          description: "Validates invoice path",
          steps: [{ action: "Submit", expected: "Accepted" }],
        },
      ],
      testSets: [
        {
          name: "Smoke",
          description: "Core checks",
          testCaseNames: ["TC001 - Happy path"],
        },
      ],
    });

    expect(testDesign.testCases).toHaveLength(1);
    expect(testDesign.testCases[0].steps[0].expected).toBe("Accepted");
    expect(testDesign.testSets[0].testCaseNames).toEqual(["TC001 - Happy path"]);
  });
});
