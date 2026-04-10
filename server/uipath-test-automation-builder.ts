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
  const explicit = String(testCase.automationWorkflow || "").trim();
  if (explicit) {
    return explicit.toLowerCase().endsWith(".xaml") ? explicit : `${explicit}.xaml`;
  }
  const fallbackBase = `TC${String(index + 1).padStart(3, "0")}`;
  const segments = String(testCase.name || "")
    .split(/[^A-Za-z0-9]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return `${fallbackBase}.xaml`;
  }
  const [first, ...rest] = segments;
  const normalized = [first, ...rest.map((segment) => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)].join("_");
  return `${sanitizeSegment(normalized, fallbackBase)}.xaml`;
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
  projectName: string;
  steps: UiPathTestCase["steps"];
}): string {
  const { className, displayName, projectName } = params;
  const startedMessage = limitText(`${displayName} started for ${projectName}`);
  const completedMessage = limitText(`${displayName} completed`);
  return [
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
    `    <ui:LogMessage DisplayName="Start ${escapeXml(className)}" sap2010:WorkflowViewState.IdRef="LogMessage_1" Level="Info" Message="[&quot;${escapeXml(startedMessage)}&quot;]" />`,
    `    <uta:VerifyExpression AlternativeVerificationTitle="{x:Null}" KeepScreenshots="{x:Null}" OutputMessageFormat="{x:Null}" Result="{x:Null}" ScreenshotsPath="{x:Null}" ContinueOnFailure="False" DisplayName="Verify Generated Test Placeholder" Expression="[True]" sap2010:WorkflowViewState.IdRef="VerifyExpression_1" TakeScreenshotInCaseOfFailingAssertion="False" TakeScreenshotInCaseOfSucceedingAssertion="False" />`,
    `    <ui:LogMessage DisplayName="End ${escapeXml(className)}" sap2010:WorkflowViewState.IdRef="LogMessage_2" Level="Info" Message="[&quot;${escapeXml(completedMessage)}&quot;]" />`,
    `  </Sequence>`,
    `</Activity>`,
    ``,
  ].join("\n");
}

function makeProjectJson(params: {
  projectName: string;
  version: string;
  projectId: string;
  workflows: Array<{ fileName: string; localTestCaseId: string }>;
}): Record<string, unknown> {
  const { projectName, version, projectId, workflows } = params;
  const main = workflows[0]?.fileName || "Main.xaml";
  return {
    name: projectName,
    projectId,
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
        testCaseId: workflow.localTestCaseId,
        testCaseType: "TestCase",
        fileName: workflow.fileName,
      })),
      modernBehavior: true,
    },
    expressionLanguage: "VisualBasic",
    entryPoints: workflows.map((workflow) => ({
      filePath: workflow.fileName,
      uniqueId: workflow.localTestCaseId,
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

function makeTestingSettings(): Record<string, string> {
  return {
    "UiPath.Testing.Activities.Generic.KeepScreenshots": "False",
    "UiPath.Testing.Activities.Generic.ScreenshotsPath": "",
    "UiPath.Testing.Activities.VerifyActivitiesOutputFormat.VerifyExpressionOutputFormat": "",
    "UiPath.Testing.Activities.VerifyActivitiesOutputFormat.VerifyExpressionWithOperatorOutputFormat": "",
    "UiPath.Testing.Activities.VerifyActivitiesOutputFormat.VerifyControlAttributeOutputFormat": "",
    "UiPath.Testing.Activities.VerifyActivitiesOutputFormat.VerifyRangeOutputFormat": "",
  };
}

function makeSystemSettings(): Record<string, string> {
  return {
    "UiPath.System.Activities.AddDataColumn.AllowDBNull": "True",
    "UiPath.System.Activities.AddDataColumn.AutoIncrement": "False",
    "UiPath.System.Activities.AddDataColumn.MaxLength": "100",
    "UiPath.System.Activities.AddDataColumn.Unique": "False",
    "UiPath.System.Activities.ReadTextFile.Encoding": "",
    "UiPath.System.Activities.WriteTextFile.Encoding": "",
    "UiPath.System.Activities.AppendLine.Encoding": "",
    "UiPath.System.Activities.FilterDataTable.FilterRowsMode": "Keep",
    "UiPath.System.Activities.InvokeWorkflowFile.Timeout": "0",
    "UiPath.System.Activities.InvokeWorkflowFile.LogEntry": "No",
    "UiPath.System.Activities.InvokeWorkflowFile.LogExit": "No",
    "UiPath.System.Activities.LogMessage.Level": "Info",
    "UiPath.System.Activities.MessageBox.Buttons": "Ok",
    "UiPath.System.Activities.MessageBox.TopMost": "True",
    "UiPath.System.Activities.InputDialog.TopMost": "False",
    "UiPath.System.Activities.CustomInput.TopMost": "True",
    "UiPath.System.Activities.OrchestratorHTTPRequest.RelativeEndpoint": "",
    "UiPath.System.Activities.RetryScope.NumberOfRetries": "3",
    "UiPath.System.Activities.RetryScope.RetryInterval": "5000",
    "UiPath.System.Activities.RetryScope.LogRetriedExceptions": "False",
    "UiPath.System.Activities.RetryScope.RetriedExceptionsLogLevel": "Trace",
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
    if (testCase.steps.length > 0) {
      lines.push(`  Steps: ${testCase.steps.map((step) => `${step.action} => ${step.expected}`).join(" | ")}`);
    }
  });

  if (testSets.length > 0) {
    lines.push("", "## Test Sets", "");
    testSets.forEach((testSet) => {
      lines.push(`- ${testSet.name}: ${testSet.testCaseNames.join(", ") || "No linked cases"}`);
    });
  }

  return lines.join("\n");
}

function makeProjectUiproj(params: {
  projectName: string;
  mainFile: string;
}): string {
  return JSON.stringify({
    Name: params.projectName,
    ProjectType: "Tests",
    Description: "Executable UiPath Test Automation project generated by CB2YY.",
    MainFile: params.mainFile,
  }, null, 2);
}

function makeDesignJson(): string {
  return JSON.stringify({
    Tags: [],
    SeparateRuntimeDependencies: true,
    IncludeSources: true,
    ConnectorKeys: [],
  }, null, 2);
}

function makePackageBindingsMetadata(): string {
  return JSON.stringify({
    ActivityBindings: {},
  }, null, 2);
}

function makeConnectionsFactory(projectName: string): string {
  return [
    `namespace ${projectName}`,
    `{`,
    `}`,
    ``,
  ].join("\n");
}

function makeConnectionsManager(projectName: string): string {
  return [
    `using UiPath.CodedWorkflows;`,
    `using System;`,
    ``,
    `namespace ${projectName}`,
    `{`,
    `    public class ConnectionsManager`,
    `    {`,
    `        public ConnectionsManager(ICodedWorkflowsServiceContainer resolver)`,
    `        {`,
    `        }`,
    `    }`,
    `}`,
    ``,
  ].join("\n");
}

function makeBindingsV2(): string {
  return JSON.stringify({
    version: "2.0",
    resources: [],
  }, null, 2);
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
  const projectId = newId();
  const workflows = testCases.map((testCase, index) => {
    const fileName = makeWorkflowFileName(testCase, index);
    const className = sanitizeSegment(fileName.replace(/\.xaml$/i, ""), `TC${String(index + 1).padStart(3, "0")}`);
    const localTestCaseId = newId();
    return {
      testCaseName: testCase.name,
      fileName,
      className,
      localTestCaseId,
      content: makeTestCaseXaml({
        className,
        displayName: testCase.name,
        description: testCase.description,
        projectName,
        steps: testCase.steps,
      }),
    };
  });

  const zip = new AdmZip();
  const projectRoot = sanitizedProjectName;
  zip.addFile(
    `${projectRoot}/project.json`,
    Buffer.from(JSON.stringify(makeProjectJson({ projectName: sanitizedProjectName, version, projectId, workflows }), null, 2), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/project.uiproj`,
    Buffer.from(makeProjectUiproj({ projectName: sanitizedProjectName, mainFile: workflows[0]?.fileName || "Main.xaml" }), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/.project/design.json`,
    Buffer.from(makeDesignJson(), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/.project/PackageBindingsMetadata.json`,
    Buffer.from(makePackageBindingsMetadata(), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/.settings/Release/settings-82ca306a.json`,
    Buffer.from(JSON.stringify(makeTestingSettings(), null, 2), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/.settings/Release/settings-9e9290da.json`,
    Buffer.from(JSON.stringify(makeSystemSettings(), null, 2), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/.codedworkflows/ConnectionsFactory.cs`,
    Buffer.from(makeConnectionsFactory(sanitizedProjectName), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/.codedworkflows/ConnectionsManager.cs`,
    Buffer.from(makeConnectionsManager(sanitizedProjectName), "utf8"),
  );
  zip.addFile(
    `${projectRoot}/.local/content/bindings_v2.json`,
    Buffer.from(makeBindingsV2(), "utf8"),
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
    workflowMappings: workflows.map((workflow) => ({
      testCaseName: workflow.testCaseName,
      fileName: workflow.fileName,
      className: workflow.className,
      localTestCaseId: workflow.localTestCaseId,
    })),
    testCases,
    testSets,
  };
}
