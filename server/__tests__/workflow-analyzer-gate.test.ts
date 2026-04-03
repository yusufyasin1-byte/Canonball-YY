import { describe, expect, it } from "vitest";
import {
  aggregateAnalysisReports,
  analyzeAndFix,
  shouldBlockDeploymentFromAnalysis,
  type AnalysisReport,
} from "../workflow-analyzer";

function makeReport(overrides?: Partial<AnalysisReport>): AnalysisReport {
  return {
    violations: [],
    rulesChecked: [],
    totalChecked: 0,
    totalPassed: 0,
    totalAutoFixed: 0,
    totalRemaining: 0,
    ...overrides,
  };
}

describe("workflow analyzer deployment gate", () => {
  it("blocks deployment when unresolved error violations remain", () => {
    const reports = [{
      fileName: "Main.xaml",
      report: makeReport({
        violations: [{
          ruleId: "ST-DBP-003",
          ruleName: "Empty Catch Block",
          category: "best-practice",
          severity: "error",
          message: "Catch block contains no activities",
          autoFixed: false,
        }],
        totalRemaining: 1,
      }),
    }];

    expect(shouldBlockDeploymentFromAnalysis(reports)).toBe(true);
    expect(aggregateAnalysisReports(reports).remainingBySeverity.error).toBe(1);
  });

  it("allows deployment when only warnings remain", () => {
    const reports = [{
      fileName: "Main.xaml",
      report: makeReport({
        violations: [{
          ruleId: "ST-USG-020",
          ruleName: "Minimum Log Messages",
          category: "usage",
          severity: "warning",
          message: "Workflow does not contain a final LogMessage activity",
          autoFixed: false,
        }],
        totalRemaining: 1,
      }),
    }];

    expect(shouldBlockDeploymentFromAnalysis(reports)).toBe(false);
    expect(aggregateAnalysisReports(reports).remainingBySeverity.warning).toBe(1);
  });

  it("runs stricter reliability checks only in strict profile", () => {
    const xaml = `
<Activity mc:Ignorable="sap sap2010" x:Class="Main"
 xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
 xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
 xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
 xmlns:ui="http://schemas.uipath.com/workflow/activities">
  <Sequence DisplayName="Main">
    <ui:Click DisplayName="Click One" />
    <ui:Click DisplayName="Click Two" />
    <ui:TypeInto DisplayName="Type Into" />
  </Sequence>
</Activity>`;

    const fast = analyzeAndFix(xaml, "fast").report;
    const strict = analyzeAndFix(xaml, "strict").report;

    expect(fast.violations.some((v) => v.ruleId === "ST-REL-001")).toBe(false);
    expect(strict.violations.some((v) => v.ruleId === "ST-REL-001")).toBe(true);
  });
});
