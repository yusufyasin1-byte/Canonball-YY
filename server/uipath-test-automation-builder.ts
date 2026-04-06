import crypto from "node:crypto";
import AdmZip from "adm-zip";
import type {
  UiPathTestAutomationArtifact,
  UiPathTestCase,
  UiPathTestSet,
} from "./types/uipath-solution";

function newId(): string {
  return crypto.randomUUID();
}

function sanitizeSegment(value: string, fallback: string): string {
  const cleaned = String(value || "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function makeWorkflowFileName(testCase: UiPathTestCase, index: number): string {
  const base = sanitizeSegment(testCase.name, `TC${String(index + 1).padStart(3, "0")}`);
  return `${base}.xaml`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function limitText(value: string, max = 180): string {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function makeTestCaseXaml(params: {
  className: string;
  displayName: string;
  description: string;
  steps: UiPathTestCase["steps"];
}): string {
  const { className, displayName, description, steps } = params;
  const lines: string[] = [
    `<Activity mc:Ignorable="sap sap2010" x:Class="${className}" VisualBasic.Settings="{x:Null}" sap2010:WorkflowViewState.IdRef="${className}_1" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation" xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation" xmlns:scg="clr-namespace:System.Collections.Generic;assembly=System.Private.CoreLib" xmlns:sco="clr-namespace:System.Collections.ObjectModel;assembly=System.Private.CoreLib" xmlns:ui="http://schemas.uipath.com/workflow/activities" xmlns:uta="clr-namespace:UiPath.Testing.Activities;assembly=UiPath.Testing.Activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">`,
    `  <TextExpression.NamespacesForImplementation>`,
    `    <sco:Collection x:TypeArguments="x:String">`,
    `      <x:String>GlobalConstantsNamespace</x:String>`,
    `      <x:String>GlobalVariablesNamespace</x:String>`,
    `      <x:String>Microsoft.VisualBasic</x:String>`,
    `      <x:String>Microsoft.VisualBasic.Activities</x:String>`,
    `      <x:String>System</x:String>`,
    `      <x:String>System.Collections</x:String>`,
    `      <x:String>System.Collections.Generic</x:String>`,
    `      <x:String>System.Collections.ObjectModel</x:String>`,
    `      <x:String>System.Linq</x:String>`,
    `      <x:String>UiPath.Core</x:String>`,
    `      <x:String>UiPath.Core.Activities</x:String>`,
    `      <x:String>UiPath.Testing.Activities</x:String>`,
    `      <x:String>System.Activities</x:String>`,
    `    </sco:Collection>`,
    `  </TextExpression.NamespacesForImplementation>`,
    `  <TextExpression.ReferencesForImplementation>`,
    `    <sco:Collection x:TypeArguments="AssemblyReference">`,
    `      <AssemblyReference>Microsoft.VisualBasic</AssemblyReference>`,
    `      <AssemblyReference>mscorlib</AssemblyReference>`,
    `      <AssemblyReference>System</AssemblyReference>`,
    `      <AssemblyReference>System.Activities</AssemblyReference>`,
    `      <AssemblyReference>System.ComponentModel.TypeConverter</AssemblyReference>`,
    `      <AssemblyReference>System.Linq</AssemblyReference>`,
    `      <AssemblyReference>System.ObjectModel</AssemblyReference>`,
    `      <AssemblyReference>UiPath.System.Activities</AssemblyReference>`,
    `      <AssemblyReference>UiPath.Testing.Activities</AssemblyReference>`,
    `    </sco:Collection>`,
    `  </TextExpression.ReferencesForImplementation>`,
    `  <Sequence DisplayName="${escapeXml(displayName)}" sap2010:WorkflowViewState.IdRef="Sequence_1">`,
    `    <sap:WorkflowViewStateService.ViewState>`,
    `      <scg:Dictionary x:TypeArguments="x:String, x:Object">`,
    `        <x:Boolean x:Key="IsExpanded">True</x:Boolean>`,
    `      </scg:Dictionary>`,
    `    </sap:WorkflowViewStateService.ViewState>`,
    `    <ui:LogMessage DisplayName="Start ${escapeXml(className)}" sap2010:WorkflowViewState.IdRef="LogMessage_1" Level="Info" Message="[&quot;${escapeXml(limitText(`Test started: ${displayName}`))}&quot;]" />`,
    `    <ui:CommentOut DisplayName="Scenario Description" sap2010:WorkflowViewState.IdRef="CommentOut_Description">`,
    `      <ui:CommentOut.Body>`,
    `        <Sequence DisplayName="${escapeXml(limitText(description || "Generated test scenario"))}" sap2010:WorkflowViewState.IdRef="Sequence_Description" />`,
    `      </ui:CommentOut.Body>`,
    `    </ui:CommentOut>`,
  ];

  steps.forEach((step, index) => {
    const actionText = limitText(step.action || `Execute step ${index + 1}`);
    const expectedText = limitText(step.expected || "Expected result not specified");
    lines.push(
      `    <ui:CommentOut DisplayName="Step ${index + 1}" sap2010:WorkflowViewState.IdRef="CommentOut_${index + 1}">`,
      `      <ui:CommentOut.Body>`,
      `        <Sequence DisplayName="${escapeXml(`Action: ${actionText} | Expected: ${expectedText}`)}" sap2010:WorkflowViewState.IdRef="Sequence_Step_${index + 1}" />`,
      `      </ui:CommentOut.Body>`,
      `    </ui:CommentOut>`,
    );
  });

  lines.push(
    `    <uta:VerifyExpression AlternativeVerificationTitle="{x:Null}" KeepScreenshots="{x:Null}" OutputMessageFormat="{x:Null}" Result="{x:Null}" ScreenshotsPath="{x:Null}" ContinueOnFailure="False" DisplayName="Verify Generated Test Placeholder" Expression="[True]" sap2010:WorkflowViewState.IdRef="VerifyExpression_1" TakeScreenshotInCaseOfFailingAssertion="False" TakeScreenshotInCaseOfSucceedingAssertion="False" />`,
    `    <ui:LogMessage DisplayName="End ${escapeXml(className)}" sap2010:WorkflowViewState.IdRef="LogMessage_2" Level="Info" Message="[&quot;${escapeXml(limitText(`Test completed: ${displayName}`))}&quot;]" />`,
    `  </Sequence>`,
    `</Activity>`,
    ``,
  );

  return lines.join("\n");
}

function makeProjectJson(params: {
  projectName: string;
  version: string;
  workflows: Array<{ fileName: string }>;
}): Record<string, unknown> {
  const { projectName, version, workflows } = params;
  const main = workflows[0]?.fileName || "Main.xaml";
  return {
    name: projectName,
    description: "Executable UiPath Test Automation project generated by CB2YY.",
    main,
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
      fileInfoCollection: workflows.map((workflow) => ({
        editingStatus: "Publishable",
        testCaseId: newId(),
        testCaseType: "TestCase",
        fileName: workflow.fileName,
      })),
      modernBehavior: true,
    },
    expressionLanguage: "VisualBasic",
    entryPoints: workflows.map((workflow) => ({
      filePath: workflow.fileName,
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

function renderReadme(params: {
  projectName: string;
  testCases: UiPathTestCase[];
  testSets: UiPathTestSet[];
}): string {
  const { projectName, testCases, testSets } = params;
  const lines: string[] = [
    `# ${projectName}`,
    "",
    "Generated UiPath Tests project.",
    "",
    "## Test Cases",
    "",
  ];

  testCases.forEach((testCase) => {
    lines.push(`- ${testCase.name}: ${testCase.description || "Generated scenario"}`);
  });

  if (testSets.length > 0) {
    lines.push("", "## Test Sets", "");
    testSets.forEach((testSet) => {
      lines.push(`- ${testSet.name}: ${testSet.testCaseNames.join(", ") || "No linked cases"}`);
    });
  }

  return lines.join("\n");
}

export function buildUiPathTestAutomationArtifact(params: {
  projectName: string;
  version: string;
  testCases: UiPathTestCase[];
  testSets: UiPathTestSet[];
}): UiPathTestAutomationArtifact | null {
  const { projectName, version, testCases, testSets } = params;
  if (!testCases.length) return null;

  const sanitizedProjectName = `${sanitizeSegment(projectName, "UiPathProject")}_Tests`;
  const workflows = testCases.map((testCase, index) => {
    const fileName = makeWorkflowFileName(testCase, index);
    const className = sanitizeSegment(fileName.replace(/\.xaml$/i, ""), `TC${String(index + 1).padStart(3, "0")}`);
    return {
      fileName,
      className,
      content: makeTestCaseXaml({
        className,
        displayName: testCase.name,
        description: testCase.description,
        steps: testCase.steps,
      }),
    };
  });

  const zip = new AdmZip();
  const projectRoot = sanitizedProjectName;
  zip.addFile(
    `${projectRoot}/project.json`,
    Buffer.from(JSON.stringify(makeProjectJson({ projectName: sanitizedProjectName, version, workflows }), null, 2), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/README.md`,
    Buffer.from(renderReadme({ projectName: sanitizedProjectName, testCases, testSets }), "utf8"),
  );

  workflows.forEach((workflow) => {
    zip.addFile(`${projectRoot}/${workflow.fileName}`, Buffer.from(workflow.content, "utf8"));
  });

  return {
    fileName: `${sanitizedProjectName}_${version}.zip`,
    buffer: zip.toBuffer(),
    projectName: sanitizedProjectName,
    version,
    workflowCount: workflows.length,
    workflowFiles: workflows.map((workflow) => workflow.fileName),
    testCases,
    testSets,
  };
}
