import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

function newId() {
  return crypto.randomUUID();
}

type TestDefinition = {
  fileName: string;
  className: string;
  displayName: string;
  startMessage: string;
  endMessage: string;
};

const TEST_DEFINITIONS: TestDefinition[] = [
  {
    fileName: "TC001_HappyPath.xaml",
    className: "TC001_HappyPath",
    displayName: "TC001 - Happy Path",
    startMessage: "TC001 smoke test started for POInvoiceTestNew",
    endMessage: "TC001 smoke test completed",
  },
  {
    fileName: "TC002_MissingPo.xaml",
    className: "TC002_MissingPo",
    displayName: "TC002 - Missing PO",
    startMessage: "TC002 missing PO test started",
    endMessage: "TC002 missing PO test completed",
  },
  {
    fileName: "TC003_PoNotFound.xaml",
    className: "TC003_PoNotFound",
    displayName: "TC003 - PO Not Found",
    startMessage: "TC003 PO not found test started",
    endMessage: "TC003 PO not found test completed",
  },
  {
    fileName: "TC004_TwoWayMatchFailure.xaml",
    className: "TC004_TwoWayMatchFailure",
    displayName: "TC004 - Two Way Match Failure",
    startMessage: "TC004 two way match failure test started",
    endMessage: "TC004 two way match failure test completed",
  },
  {
    fileName: "TC005_ToleranceFailure.xaml",
    className: "TC005_ToleranceFailure",
    displayName: "TC005 - Tolerance Failure",
    startMessage: "TC005 tolerance failure test started",
    endMessage: "TC005 tolerance failure test completed",
  },
  {
    fileName: "TC006_HitlLowConfidence.xaml",
    className: "TC006_HitlLowConfidence",
    displayName: "TC006 - HITL Low Confidence",
    startMessage: "TC006 HITL low confidence test started",
    endMessage: "TC006 HITL low confidence test completed",
  },
  {
    fileName: "TC007_CoupaRetry.xaml",
    className: "TC007_CoupaRetry",
    displayName: "TC007 - Coupa Retry",
    startMessage: "TC007 Coupa retry test started",
    endMessage: "TC007 Coupa retry test completed",
  },
];

function makeProjectJson(version: string) {
  return {
    name: "POInvoiceTestNew_Tests",
    description: "Executable UiPath Test Automation pack for PO invoice processing.",
    main: TEST_DEFINITIONS[0].fileName,
    dependencies: {
      "UiPath.System.Activities": "26.2.4",
      "UiPath.Testing.Activities": "24.10.3",
    },
    webServices: [],
    entitiesStores: [],
    schemaVersion: "4.0",
    studioVersion: "25.10.0",
    projectVersion: version,
    runtimeOptions: {
      autoDispose: false,
      netFrameworkLazyLoading: false,
      isPausable: true,
      isAttended: false,
      requiresUserInteraction: false,
      supportsPersistence: false,
      executionType: "Workflow",
      readyForPiP: false,
      startsInPiP: false,
      mustRestoreAllDependencies: true,
    },
    designOptions: {
      projectProfile: "Developement",
      outputType: "Tests",
      fileInfoCollection: TEST_DEFINITIONS.map((testCase) => ({
          editingStatus: "Publishable",
          testCaseId: newId(),
          testCaseType: "TestCase",
          fileName: testCase.fileName,
        })),
      modernBehavior: true,
    },
    expressionLanguage: "VisualBasic",
    entryPoints: TEST_DEFINITIONS.map((testCase) => ({
      filePath: testCase.fileName,
      uniqueId: newId(),
      input: [],
      output: [],
    })),
    isTemplate: false,
    templateProjectData: {},
    publishData: {},
    targetFramework: "Windows",
    sourceLanguage: "VisualBasic",
  };
}

function makeTestCaseXaml(testCase: TestDefinition) {
  return `<Activity mc:Ignorable="sap sap2010" x:Class="${testCase.className}" VisualBasic.Settings="{x:Null}" sap2010:WorkflowViewState.IdRef="${testCase.className}_1" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:scg="clr-namespace:System.Collections.Generic;assembly=System.Private.CoreLib" xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=System.Private.CoreLib" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uta="clr-namespace:UiPath.Testing.Activities;assembly=UiPath.Testing.Activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <TextExpression.NamespacesForImplementation>
    <sco:Collection x:TypeArguments="x:String">
      <x:String>GlobalConstantsNamespace</x:String>
      <x:String>GlobalVariablesNamespace</x:String>
      <x:String>Microsoft.VisualBasic</x:String>
      <x:String>Microsoft.VisualBasic.Activities</x:String>
      <x:String>System</x:String>
      <x:String>System.Collections</x:String>
      <x:String>System.Collections.Generic</x:String>
      <x:String>System.Collections.ObjectModel</x:String>
      <x:String>System.Linq</x:String>
      <x:String>UiPath.Core</x:String>
      <x:String>UiPath.Core.Activities</x:String>
      <x:String>UiPath.Testing.Activities</x:String>
      <x:String>System.Activities</x:String>
    </sco:Collection>
  </TextExpression.NamespacesForImplementation>
  <TextExpression.ReferencesForImplementation>
    <sco:Collection x:TypeArguments="AssemblyReference">
      <AssemblyReference>Microsoft.VisualBasic</AssemblyReference>
      <AssemblyReference>mscorlib</AssemblyReference>
      <AssemblyReference>System</AssemblyReference>
      <AssemblyReference>System.Activities</AssemblyReference>
      <AssemblyReference>System.ComponentModel.TypeConverter</AssemblyReference>
      <AssemblyReference>System.Linq</AssemblyReference>
      <AssemblyReference>System.ObjectModel</AssemblyReference>
      <AssemblyReference>UiPath.System.Activities</AssemblyReference>
      <AssemblyReference>UiPath.Testing.Activities</AssemblyReference>
    </sco:Collection>
  </TextExpression.ReferencesForImplementation>
  <Sequence DisplayName="${testCase.displayName}" sap2010:WorkflowViewState.IdRef="Sequence_1">
    <sap:WorkflowViewStateService.ViewState>
      <scg:Dictionary x:TypeArguments="x:String, x:Object">
        <x:Boolean x:Key="IsExpanded">True</x:Boolean>
      </scg:Dictionary>
    </sap:WorkflowViewStateService.ViewState>
    <ui:LogMessage DisplayName="Start ${testCase.className}" sap2010:WorkflowViewState.IdRef="LogMessage_1" Level="Info" Message="[&quot;${testCase.startMessage}&quot;]" />
    <uta:VerifyExpression AlternativeVerificationTitle="{x:Null}" KeepScreenshots="{x:Null}" OutputMessageFormat="{x:Null}" Result="{x:Null}" ScreenshotsPath="{x:Null}" ContinueOnFailure="True" DisplayName="Verify Placeholder Pass" Expression="[True]" sap2010:WorkflowViewState.IdRef="VerifyExpression_1" TakeScreenshotInCaseOfFailingAssertion="False" TakeScreenshotInCaseOfSucceedingAssertion="False" />
    <ui:LogMessage DisplayName="End ${testCase.className}" sap2010:WorkflowViewState.IdRef="LogMessage_2" Level="Info" Message="[&quot;${testCase.endMessage}&quot;]" />
  </Sequence>
</Activity>
`;
}

async function main() {
  const outDir = path.resolve(process.cwd(), "..", "simulation_output_po_invoice_tests");
  const version = process.env.TEST_AUTOMATION_VERSION || "1.0.0-test";
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "project.json"), JSON.stringify(makeProjectJson(version), null, 2), "utf8");
  await Promise.all(
    TEST_DEFINITIONS.map((testCase) =>
      fs.writeFile(path.join(outDir, testCase.fileName), makeTestCaseXaml(testCase), "utf8"),
    ),
  );
  console.log(outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
