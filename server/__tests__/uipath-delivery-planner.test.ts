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
    expect(recommendation.recommendedModality).toBe("unattended_robot");
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
    expect(recommendation.recommendedExecutionModel).toBe("unattended");
  });

  it("recommends Assistant for desktop-heavy attended use cases", () => {
    const pkg: UiPathPackage = {
      projectName: "DesktopHelper",
      description: "User launches the assistant and the robot clicks through a desktop application window.",
      dependencies: [],
      workflows: [{ name: "Main", description: "Use application scope and click buttons", variables: [], steps: [] }],
      internal: {
        automationType: "rpa",
      },
    };

    const recommendation = recommendUiPathDelivery({
      pkg,
      orchestratorArtifacts: {},
    });

    expect(recommendation.recommendedModality).toBe("attended_assistant");
    expect(recommendation.recommendedExecutionModel).toBe("attended");
    expect(recommendation.recommendedProducts).toContain("Assistant");
  });

  it("recommends Apps + process for human review workflows", () => {
    const pkg: UiPathPackage = {
      projectName: "ApprovalPortal",
      description: "A self-service portal form captures requests for manager approval and review.",
      dependencies: [],
      workflows: [{ name: "Main", description: "Submit request and wait for approval", variables: [], steps: [] }],
      internal: {
        automationType: "hybrid",
      },
    };

    const recommendation = recommendUiPathDelivery({
      pkg,
      orchestratorArtifacts: {
        actionCenter: [{ taskCatalog: "ManagerApproval" }],
      },
    });

    expect(recommendation.recommendedModality).toBe("app_fronted_process");
    expect(recommendation.recommendedExecutionModel).toBe("hybrid");
    expect(recommendation.recommendedProducts).toContain("Apps");
    expect(recommendation.recommendedProducts).toContain("Action Center");
  });

  it("recommends API workflow for webhook-led integrations", () => {
    const pkg: UiPathPackage = {
      projectName: "WebhookWorker",
      description: "Receives webhook events from a REST API endpoint and posts JSON responses.",
      dependencies: [],
      workflows: [{ name: "Main", description: "HTTP webhook handler", variables: [], steps: [] }],
      internal: {
        automationType: "rpa",
      },
    };

    const recommendation = recommendUiPathDelivery({
      pkg,
      orchestratorArtifacts: {
        integrationServiceConnectors: [{ connectorName: "Salesforce" }],
      },
    });

    expect(recommendation.recommendedModality).toBe("api_workflow");
    expect(recommendation.recommendedExecutionModel).toBe("unattended");
    expect(recommendation.recommendedProducts).toContain("Integration Service");
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
