import { randomUUID } from "crypto";
import AdmZip from "adm-zip";
import { generateConfigXlsx } from "./package-assembler";
import type { BuildResult } from "./package-assembler";
import type { IdeaContext } from "./uipath-pipeline";
import type { UiPathPackage } from "./types/uipath-package";
import type {
  UiPathNativeSolutionProjectType,
  UiPathSolutionArtifact,
  UiPathSolutionComponent,
  UiPathSolutionManifest,
  UiPathSolutionResourceSummary,
} from "./types/uipath-solution";

function sanitizeName(value: string): string {
  return (value || "UiPathSolution")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "UiPathSolution";
}

function normalizeFolderName(value: string): string {
  return (value || "UiPath Project")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "UiPath Project";
}

function resourceFileBase(value: string): string {
  return sanitizeName(value).replace(/-/g, "_") || "UiPath_Project";
}

function processPackageName(solutionName: string, projectName: string): string {
  const dots = `${solutionName}.process.${projectName}`
    .replace(/[^A-Za-z0-9]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");

  return dots || "Solution.process.UiPath.Project";
}

function summarizeResources(orchestratorArtifacts: any): UiPathSolutionResourceSummary {
  const safeArray = (value: any): any[] => Array.isArray(value) ? value : [];

  return {
    queues: safeArray(orchestratorArtifacts?.queues).map((q: any) => String(q?.name || "").trim()).filter(Boolean),
    assets: safeArray(orchestratorArtifacts?.assets).map((a: any) => String(a?.name || "").trim()).filter(Boolean),
    storageBuckets: safeArray(orchestratorArtifacts?.storageBuckets).map((s: any) => String(s?.name || "").trim()).filter(Boolean),
    actionCatalogs: safeArray(orchestratorArtifacts?.actionCatalogs).map((c: any) => String(c?.name || "").trim()).filter(Boolean),
    processes: safeArray(orchestratorArtifacts?.processes).map((p: any) => String(p?.name || "").trim()).filter(Boolean),
    integrations: safeArray(orchestratorArtifacts?.integrationServiceConnectors).map((c: any) => String(c?.name || c?.system || "").trim()).filter(Boolean),
  };
}

function buildProjectDescriptor(projectName: string): string {
  return JSON.stringify({
    ProjectType: "Process" as UiPathNativeSolutionProjectType,
    Name: projectName,
    Description: null,
    MainFile: "Main.xaml",
  }, null, 2);
}

function buildSolutionUipx(projectFolder: string, projectKey: string): string {
  return JSON.stringify({
    DocVersion: "1.0.0",
    StudioMinVersion: "2025.04.0",
    SolutionId: randomUUID(),
    Projects: [
      {
        Type: "Process" as UiPathNativeSolutionProjectType,
        ProjectRelativePath: `${projectFolder}/project.uiproj`,
        Id: projectKey,
      },
    ],
  }, null, 2);
}

function buildSolutionStorage(projectFolder: string): string {
  return JSON.stringify({
    SolutionId: randomUUID(),
    Projects: [
      {
        ProjectId: randomUUID(),
        ProjectRelativePath: `${projectFolder}/project.uiproj`,
      },
    ],
  });
}

function buildPackageResourceDescriptor(params: {
  projectName: string;
  projectKey: string;
  packageKey: string;
  folderName: string;
}): string {
  const { projectName, projectKey, packageKey, folderName } = params;

  return JSON.stringify({
    docVersion: "1.0.0",
    resource: {
      name: projectName,
      kind: "package",
      apiVersion: "orchestrator.uipath.com/v1",
      projectKey,
      isOverridable: true,
      dependencies: [],
      runtimeDependencies: [],
      files: [],
      folders: [{ fullyQualifiedName: folderName }],
      spec: {
        fileName: null,
        fileReference: null,
        name: projectName,
        description: null,
      },
      locks: [],
      key: packageKey,
    },
  }, null, 2);
}

function buildProcessResourceDescriptor(params: {
  solutionName: string;
  projectName: string;
  projectKey: string;
  packageKey: string;
  processKey: string;
  folderName: string;
  description?: string;
}): string {
  const {
    solutionName,
    projectName,
    projectKey,
    packageKey,
    processKey,
    folderName,
    description,
  } = params;

  return JSON.stringify({
    docVersion: "1.0.0",
    resource: {
      name: projectName,
      kind: "process",
      type: "process",
      apiVersion: "orchestrator.uipath.com/v1",
      projectKey,
      isOverridable: true,
      dependencies: [{ name: projectName, kind: "package" }],
      runtimeDependencies: [],
      files: [],
      folders: [{ fullyQualifiedName: folderName }],
      spec: {
        entryPointUniqueId: null,
        inputArgumentsSchema: null,
        inputArgumentsSchemaV2: null,
        type: "Process",
        name: projectName,
        description: description || null,
        package: {
          key: packageKey,
        },
        packageName: processPackageName(solutionName, projectName),
        packageVersion: null,
        entryPointName: null,
        inputArguments: "{}",
        jobPriority: "Medium",
        hiddenForAttendedUser: false,
        alwaysRunning: false,
        autoStartProcess: false,
        jobRecording: "Disabled",
        targetFrameworkValue: "Portable",
        duration: 40,
        frequency: 500,
        quality: 100,
        remoteControlAccess: "None",
        retentionAction: "Delete",
        retentionPeriod: 30,
        retentionBucketRef: null,
        staleRetentionAction: "Delete",
        staleRetentionPeriod: 180,
        staleRetentionBucketRef: null,
        entryPoints: null,
        connections: null,
        tags: [],
      },
      locks: [],
      key: processKey,
    },
  }, null, 2);
}

function addSharedResourceEnvelope(params: {
  name: string;
  kind: string;
  folderName: string;
  spec: Record<string, unknown>;
  type?: string;
}): string {
  const { name, kind, folderName, spec, type } = params;
  const resource: Record<string, unknown> = {
    name,
    kind,
    apiVersion: "orchestrator.uipath.com/v1",
    isOverridable: true,
    dependencies: [],
    runtimeDependencies: [],
    files: [],
    folders: [{ fullyQualifiedName: folderName }],
    spec,
    locks: [],
    key: randomUUID(),
  };

  if (type) {
    resource.type = type;
  }

  return JSON.stringify({
    docVersion: "1.0.0",
    resource,
  }, null, 2);
}

function mapAssetType(type: string | undefined): "Text" | "Integer" | "Bool" | "Credential" {
  const normalized = String(type || "Text").trim().toLowerCase();
  if (normalized === "credential") return "Credential";
  if (normalized === "integer" || normalized === "int" || normalized === "number") return "Integer";
  if (normalized === "bool" || normalized === "boolean") return "Bool";
  return "Text";
}

function mapAssetResourceSubtype(type: "Text" | "Integer" | "Bool" | "Credential"): string {
  switch (type) {
    case "Integer":
      return "integerAsset";
    case "Bool":
      return "boolAsset";
    case "Credential":
      return "credentialAsset";
    case "Text":
    default:
      return "stringAsset";
  }
}

function buildQueueResourceDescriptor(queue: any, folderName: string): string {
  return addSharedResourceEnvelope({
    name: queue.name,
    kind: "queue",
    folderName,
    spec: {
      name: queue.name,
      description: queue.description || null,
      enforceUniqueReference: Boolean(queue.uniqueReference),
      encrypted: Boolean(queue.encrypted),
      acceptAutomaticallyRetry: queue.autoRetry !== undefined ? Boolean(queue.autoRetry) : true,
      maxNumberOfRetries: Number.isFinite(queue.maxRetries) ? queue.maxRetries : 3,
      specificDataJsonSchema: queue.jsonSchema || null,
      outputDataJsonSchema: queue.outputSchema || null,
      analyticsDataJsonSchema: queue.analyticsSchema || null,
      slaProcessRef: null,
      slaInHours: Number.isFinite(Number(queue.slaInHours)) ? Number(queue.slaInHours) : 0,
      riskSlaInHours: Number.isFinite(Number(queue.riskSlaInHours)) ? Number(queue.riskSlaInHours) : 0,
      retentionAction: queue.retentionAction || "Delete",
      retentionPeriod: Number.isFinite(Number(queue.retentionPeriod)) ? Number(queue.retentionPeriod) : 30,
      retentionBucketRef: null,
      staleRetentionAction: queue.staleRetentionAction || "Delete",
      staleRetentionPeriod: Number.isFinite(Number(queue.staleRetentionPeriod)) ? Number(queue.staleRetentionPeriod) : 180,
      staleRetentionBucketRef: null,
      tags: [],
    },
  });
}

function buildAssetResourceDescriptor(asset: any, folderName: string): string {
  const assetType = mapAssetType(asset.type);
  const assetSubtype = mapAssetResourceSubtype(assetType);
  const normalizedTextValue = (() => {
    if (asset.value !== undefined && asset.value !== null) {
      const raw = String(asset.value);
      if (raw.trim().length > 0) return raw;
    }

    return `${asset.name}_VALUE`;
  })();
  const spec: Record<string, unknown> = {
    name: asset.name,
    description: asset.description || null,
    type: assetType,
    scope: asset.scope || "Global",
    accountMachineValues: null,
    tags: [],
  };

  if (assetType === "Text") spec.value = normalizedTextValue;
  if (assetType === "Integer") spec.value = Number.isFinite(Number(asset.value)) ? Number(asset.value) : 0;
  if (assetType === "Bool") spec.value = String(asset.value).toLowerCase() === "true";
  if (assetType === "Credential") {
    spec.value = null;
  }

  return addSharedResourceEnvelope({
    name: asset.name,
    kind: "asset",
    type: assetSubtype,
    folderName,
    spec,
  });
}

function buildStorageBucketResourceDescriptor(bucket: any, folderName: string): string {
  return addSharedResourceEnvelope({
    name: bucket.name,
    kind: "bucket",
    type: "orchestratorBucket",
    folderName,
    spec: {
      name: bucket.name,
      description: bucket.description || null,
      type: bucket.storageProvider || "Orchestrator",
      options: null,
      tags: [],
    },
  });
}

function buildSolutionResourceReferencesXaml(params: {
  queueNames: string[];
  textAssetNames: string[];
  storageBucketNames: string[];
}): string | null {
  const queueName = params.queueNames[0];
  const textAssetName = params.textAssetNames.find(Boolean);

  if (!queueName && !textAssetName) {
    return null;
  }

  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Activity mc:Ignorable="sap sap2010" x:Class="SolutionResourceReferences"',
    ' xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"',
    ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    ' xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"',
    ' xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"',
    ' xmlns:scg="clr-namespace:System.Collections.Generic;assembly=System.Private.CoreLib"',
    ' xmlns:ucas="clr-namespace:UiPath.Core.Activities.Storage;assembly=UiPath.System.Activities"',
    ' xmlns:ui="http://schemas.uipath.com/workflow/activities"',
    ' xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">',
    '  <TextExpression.NamespacesForImplementation>',
    '    <scg:List x:TypeArguments="x:String" Capacity="24">',
    '      <x:String>UiPath.Platform.ResourceHandling</x:String>',
    '      <x:String>UiPath.Core.Activities.Storage</x:String>',
    '      <x:String>UiPath.Core.Activities.Orchestrator</x:String>',
    '      <x:String>System.Activities</x:String>',
    '      <x:String>UiPath.Core.Activities</x:String>',
    '      <x:String>System</x:String>',
    '      <x:String>System.Collections.Generic</x:String>',
    '      <x:String>System.Collections</x:String>',
    '      <x:String>System.Runtime.Serialization</x:String>',
    '      <x:String>UiPath.Core</x:String>',
    '      <x:String>UiPath.Shared.Activities</x:String>',
    '      <x:String>System.Activities.Statements</x:String>',
    '      <x:String>System.Activities.Expressions</x:String>',
    '      <x:String>System.Activities.Validation</x:String>',
    '      <x:String>System.Activities.XamlIntegration</x:String>',
    '      <x:String>Microsoft.VisualBasic</x:String>',
    '      <x:String>Microsoft.VisualBasic.Activities</x:String>',
    '      <x:String>System.Data</x:String>',
    '      <x:String>System.Diagnostics</x:String>',
    '      <x:String>System.IO</x:String>',
    '      <x:String>System.Linq</x:String>',
    '      <x:String>System.Windows.Markup</x:String>',
    '      <x:String>Newtonsoft.Json</x:String>',
    '      <x:String>Newtonsoft.Json.Linq</x:String>',
    '    </scg:List>',
    '  </TextExpression.NamespacesForImplementation>',
    '  <TextExpression.ReferencesForImplementation>',
    '    <scg:List x:TypeArguments="AssemblyReference" Capacity="16">',
    '      <AssemblyReference>System.Activities</AssemblyReference>',
    '      <AssemblyReference>Microsoft.VisualBasic</AssemblyReference>',
    '      <AssemblyReference>System</AssemblyReference>',
    '      <AssemblyReference>System.Linq</AssemblyReference>',
    '      <AssemblyReference>System.Xaml</AssemblyReference>',
    '      <AssemblyReference>System.Net.Primitives</AssemblyReference>',
    '      <AssemblyReference>System.Runtime.InteropServices</AssemblyReference>',
    '      <AssemblyReference>Newtonsoft.Json</AssemblyReference>',
    '      <AssemblyReference>UiPath.System.Activities</AssemblyReference>',
    '      <AssemblyReference>System.Private.CoreLib</AssemblyReference>',
    '      <AssemblyReference>UiPath.Platform</AssemblyReference>',
    '    </scg:List>',
    '  </TextExpression.ReferencesForImplementation>',
    '  <Sequence sap:VirtualizedContainerService.HintSize="356,732" sap2010:WorkflowViewState.IdRef="Sequence_1">',
    '    <sap:WorkflowViewStateService.ViewState>',
    '      <scg:Dictionary x:TypeArguments="x:String, x:Object">',
    '        <x:Boolean x:Key="IsExpanded">True</x:Boolean>',
    '      </scg:Dictionary>',
    '    </sap:WorkflowViewStateService.ViewState>',
  ];

  if (queueName) {
    lines.push(
      `    <ui:AddQueueItem TimeoutMS="{x:Null}" DisplayName="Add Queue Item" sap2010:WorkflowViewState.IdRef="AddQueueItem_1" Priority="Normal" QueueType="${queueName}">`,
      '      <ui:AddQueueItem.ItemInformation>',
      '        <scg:Dictionary x:TypeArguments="x:String, InArgument" />',
      '      </ui:AddQueueItem.ItemInformation>',
      '    </ui:AddQueueItem>',
    );
  }

  if (textAssetName) {
    lines.push(
      `    <ui:GetRobotAsset TimeoutMS="{x:Null}" Value="{x:Null}" AssetName="${textAssetName}" CacheStrategy="None" DisplayName="Get Asset" sap2010:WorkflowViewState.IdRef="GetRobotAsset_1" />`,
    );
  }

  lines.push('  </Sequence>', '</Activity>');
  return lines.join("\n");
}

export function buildUiPathSolutionArtifact(params: {
  pkg: UiPathPackage;
  buildResult: BuildResult;
  packageBuffer: Buffer;
  projectName: string;
  dhgContent?: string;
  ctx: IdeaContext;
  version: string;
}): UiPathSolutionArtifact {
  const {
    pkg,
    buildResult,
    projectName,
    dhgContent,
    ctx,
    version,
  } = params;

  const projectFolder = normalizeFolderName(projectName);
  const solutionName = sanitizeName(`${projectName}_Solution`);
  const uiFolderName = "solution_folder";
  const projectKey = randomUUID();
  const packageKey = randomUUID();
  const processKey = randomUUID();
  const orchestratorArtifacts = pkg.internal?.orchestratorArtifacts || pkg.internal?.extractedArtifacts || {};
  const resources = summarizeResources(orchestratorArtifacts);

  const components: UiPathSolutionComponent[] = [
    {
      type: "rpa_project",
      name: projectName,
      path: `${projectFolder}/project.uiproj`,
      description: pkg.description || `${projectName} automation project`,
    },
    {
      type: "resource_manifest",
      name: "PackageResource",
      path: `resources/${uiFolderName}/package/${resourceFileBase(projectName)}.json`,
      description: "Native UiPath package resource descriptor for the solution export",
    },
    {
      type: "resource_manifest",
      name: "ProcessResource",
      path: `resources/${uiFolderName}/process/process/${resourceFileBase(projectName)}.json`,
      description: "Native UiPath process resource descriptor for the solution export",
    },
  ];

  if (ctx.sdd?.content) {
    components.push({
      type: "documentation",
      name: "SDD",
      path: `${projectFolder}/docs/SDD.md`,
      description: "Approved or latest Solution Design Document used during generation",
    });
  }
  if (ctx.pdd?.content) {
    components.push({
      type: "documentation",
      name: "PDD",
      path: `${projectFolder}/docs/PDD.md`,
      description: "Latest Process Design Document used during generation",
    });
  }

  const queues = Array.isArray(orchestratorArtifacts?.queues) ? orchestratorArtifacts.queues : [];
  for (const queue of queues) {
    if (!queue?.name) continue;
    components.push({
      type: "resource_manifest",
      name: `Queue:${queue.name}`,
      path: `resources/${uiFolderName}/queue/${resourceFileBase(queue.name)}.json`,
      description: "Native UiPath queue resource descriptor",
    });
  }

  const assets = Array.isArray(orchestratorArtifacts?.assets) ? orchestratorArtifacts.assets : [];
  for (const asset of assets) {
    if (!asset?.name) continue;
    const assetSubtype = mapAssetResourceSubtype(mapAssetType(asset.type));
    components.push({
      type: "resource_manifest",
      name: `Asset:${asset.name}`,
      path: `resources/${uiFolderName}/asset/${assetSubtype}/${resourceFileBase(asset.name)}.json`,
      description: "Native UiPath asset resource descriptor",
    });
  }

  const storageBuckets = Array.isArray(orchestratorArtifacts?.storageBuckets) ? orchestratorArtifacts.storageBuckets : [];
  for (const bucket of storageBuckets) {
    if (!bucket?.name) continue;
    components.push({
      type: "resource_manifest",
      name: `StorageBucket:${bucket.name}`,
      path: `resources/${uiFolderName}/bucket/orchestratorBucket/${resourceFileBase(bucket.name)}.json`,
      description: "Native UiPath storage bucket resource descriptor",
    });
  }

  const resourceReferenceXaml = buildSolutionResourceReferencesXaml({
    queueNames: queues.map((queue) => String(queue?.name || "")).filter(Boolean),
    textAssetNames: assets
      .filter((asset) => mapAssetType(asset?.type) === "Text")
      .map((asset) => String(asset?.name || ""))
      .filter(Boolean),
    storageBucketNames: storageBuckets.map((bucket) => String(bucket?.name || "")).filter(Boolean),
  });

  const manifest: UiPathSolutionManifest = {
    schemaVersion: "1.0",
    solutionName,
    displayName: `${projectName} Solution`,
    version,
    generatedAt: new Date().toISOString(),
    sourceProjectName: projectName,
    automationType: pkg.internal?.automationType || "rpa",
    deliveryMode: "native_uis",
    deploymentSupport: {
      packageDeploySupported: true,
      solutionDeploySupported: "manual_or_cli",
      notes: [
        "This artifact is exported as a native UiPath Studio Web .uis container.",
        "To appear under UiPath Solutions, deploy it through UiPath's solution upload/deploy/activate flow rather than the package upload API.",
      ],
    },
    components,
    resources,
  };

  const zip = new AdmZip();
  zip.addFile("Solution.uipx", Buffer.from(buildSolutionUipx(projectFolder, projectKey), "utf8"));
  zip.addFile("SolutionStorage.json", Buffer.from(buildSolutionStorage(projectFolder), "utf8"));
  zip.addFile(`${projectFolder}/project.uiproj`, Buffer.from(buildProjectDescriptor(projectName), "utf8"));

  for (const entry of buildResult.xamlEntries) {
    const entryName = String(entry.name || "").replace(/^\/+/, "");
    if (!entryName) continue;
    zip.addFile(`${projectFolder}/${entryName}`, Buffer.from(entry.content, "utf8"));
  }

  if (buildResult.projectJsonContent) {
    zip.addFile(`${projectFolder}/project.json`, Buffer.from(buildResult.projectJsonContent, "utf8"));
  }

  if (resourceReferenceXaml) {
    zip.addFile(`${projectFolder}/SolutionResourceReferences.xaml`, Buffer.from(resourceReferenceXaml, "utf8"));
  }

  const sddContent = ctx.sdd?.content || "";
  const configContent = generateConfigXlsx(projectName, sddContent, orchestratorArtifacts);
  zip.addFile(`${projectFolder}/Data/Config.xlsx`, Buffer.from(configContent, "utf8"));

  if (dhgContent) {
    zip.addFile(`${projectFolder}/DeveloperHandoffGuide.md`, Buffer.from(dhgContent, "utf8"));
  }
  if (ctx.sdd?.content) {
    zip.addFile(`${projectFolder}/docs/SDD.md`, Buffer.from(ctx.sdd.content, "utf8"));
  }
  if (ctx.pdd?.content) {
    zip.addFile(`${projectFolder}/docs/PDD.md`, Buffer.from(ctx.pdd.content, "utf8"));
  }

  const resourceBase = resourceFileBase(projectName);
  zip.addFile(
    `resources/${uiFolderName}/package/${resourceBase}.json`,
    Buffer.from(buildPackageResourceDescriptor({
      projectName,
      projectKey,
      packageKey,
      folderName: uiFolderName,
    }), "utf8"),
  );
  zip.addFile(
    `resources/${uiFolderName}/process/process/${resourceBase}.json`,
    Buffer.from(buildProcessResourceDescriptor({
      solutionName,
      projectName,
      projectKey,
      packageKey,
      processKey,
      folderName: uiFolderName,
      description: pkg.description,
    }), "utf8"),
  );

  for (const queue of queues) {
    if (!queue?.name) continue;
    zip.addFile(
      `resources/${uiFolderName}/queue/${resourceFileBase(queue.name)}.json`,
      Buffer.from(buildQueueResourceDescriptor(queue, uiFolderName), "utf8"),
    );
  }

  for (const asset of assets) {
    if (!asset?.name) continue;
    const assetSubtype = mapAssetResourceSubtype(mapAssetType(asset.type));
    zip.addFile(
      `resources/${uiFolderName}/asset/${assetSubtype}/${resourceFileBase(asset.name)}.json`,
      Buffer.from(buildAssetResourceDescriptor(asset, uiFolderName), "utf8"),
    );
  }

  for (const bucket of storageBuckets) {
    if (!bucket?.name) continue;
    zip.addFile(
      `resources/${uiFolderName}/bucket/orchestratorBucket/${resourceFileBase(bucket.name)}.json`,
      Buffer.from(buildStorageBucketResourceDescriptor(bucket, uiFolderName), "utf8"),
    );
  }

  return {
    fileName: `${solutionName}.${version}.uis`,
    buffer: zip.toBuffer(),
    manifest,
    components,
  };
}
