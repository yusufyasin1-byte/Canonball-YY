import { describe, expect, it } from "vitest";
import { validateContractIntegrity } from "../xaml/workflow-contract-integrity";

function makeMinimalXaml(properties: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="TestWorkflow"
 xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
 xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
 xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
 xmlns:ui="http://schemas.uipath.com/workflow/activities">
  <x:Members>
    ${properties}
  </x:Members>
  <Sequence>
    ${body}
  </Sequence>
</Activity>`;
}

describe("workflow-contract-integrity", () => {
  it("excludes designer metadata from contract matching", () => {
    const child = makeMinimalXaml(
      `<x:Property Name="in_Name" Type="InArgument(x:String)" />`,
      `<ui:LogMessage Level="Info" Message="[in_Name]" />`,
    );
    const parent = makeMinimalXaml(
      "",
      `<ui:InvokeWorkflowFile WorkflowFileName="Child.xaml" sap2010:WorkflowViewState.IdRef="InvokeWF_1" sap:VirtualizedContainerService.HintSize="200,100">
         <ui:InvokeWorkflowFile.Arguments>
           <InArgument x:TypeArguments="x:String" x:Key="in_Name">["test"]</InArgument>
         </ui:InvokeWorkflowFile.Arguments>
       </ui:InvokeWorkflowFile>`,
    );

    const result = validateContractIntegrity([
      { name: "Main.xaml", content: parent },
      { name: "Child.xaml", content: child },
    ]);

    expect(result.contractIntegrityDefects).toHaveLength(0);
    expect(result.contractExtractionExclusions.length).toBeGreaterThan(0);
    expect(result.contractIntegritySummaryMetrics.totalExcludedNonContractFields).toBeGreaterThan(0);
    expect(
      result.contractIntegritySummaryMetrics.exclusionsByCategory.view_state +
      result.contractIntegritySummaryMetrics.exclusionsByCategory.idref_reference +
      result.contractIntegritySummaryMetrics.exclusionsByCategory.layout_hint,
    ).toBeGreaterThan(0);
  });

  it("still catches a real unknown target argument", () => {
    const child = makeMinimalXaml(
      `<x:Property Name="in_ValidArg" Type="InArgument(x:String)" />`,
      `<ui:LogMessage Level="Info" Message="[in_ValidArg]" />`,
    );
    const parent = makeMinimalXaml(
      "",
      `<ui:InvokeWorkflowFile WorkflowFileName="Child.xaml">
         <ui:InvokeWorkflowFile.Arguments>
           <InArgument x:TypeArguments="x:String" x:Key="in_TrulyNonexistent">["bogus"]</InArgument>
         </ui:InvokeWorkflowFile.Arguments>
       </ui:InvokeWorkflowFile>`,
    );

    const result = validateContractIntegrity([
      { name: "Main.xaml", content: parent },
      { name: "Child.xaml", content: child },
    ]);

    expect(result.contractIntegrityDefects).toHaveLength(1);
    expect(result.contractIntegrityDefects[0].defectType).toBe("unknown_target_argument");
    expect(result.contractIntegrityDefects[0].targetArgument).toBe("in_TrulyNonexistent");
    expect(result.hasContractIntegrityIssues).toBe(true);
  });

  it("treats invoke pseudo-properties as invalid serialization", () => {
    const parent = makeMinimalXaml(
      "",
      `<ui:InvokeWorkflowFile WorkflowFileName="Child.xaml" Then="some value" />`,
    );

    const result = validateContractIntegrity([{ name: "Main.xaml", content: parent }]);

    expect(result.contractIntegrityDefects.length).toBeGreaterThan(0);
    expect(result.contractIntegrityDefects[0].defectType).toBe("invalid_invoke_serialization");
    expect(result.contractIntegritySummaryMetrics.totalInvalidInvokeSerialization).toBeGreaterThan(0);
  });
});
