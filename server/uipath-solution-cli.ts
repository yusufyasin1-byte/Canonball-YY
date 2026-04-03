import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const MODULE_DIRNAME = path.dirname(fileURLToPath(import.meta.url));

function resolveFirstExistingPath(candidates: string[], description: string): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`${description} not found. Checked: ${candidates.join(", ")}`);
}

function getCandidateRepoRoots(repoRoot: string): string[] {
  const cwdRoot = process.cwd();
  return Array.from(new Set([
    path.resolve(repoRoot),
    path.resolve(repoRoot, ".."),
    path.resolve(cwdRoot),
    path.resolve(cwdRoot, ".."),
  ]));
}

export const DEFAULT_UIPATH_SOLUTION_SCOPES = [
  "AutomationSolutions",
  "Solutions.Deployments",
  "Solutions.Deployments.Read",
  "Solutions.Deployments.Write",
  "Solutions.Packages",
  "Solutions.Packages.Read",
  "Solutions.Packages.Write",
].join(" ");

export const DEFAULT_UIPATH_ORCHESTRATOR_URL = "https://cloud.uipath.com/";
export const UIPATH_OFFICIAL_NUGET_FEED = "https://pkgs.dev.azure.com/uipath/Public.Feeds/_packaging/UiPath-Official/nuget/v3/index.json";
export const UIPATH_MARKETPLACE_NUGET_FEED = "https://gallery.uipath.com/api/v3/index.json";

export type UiPathSolutionCliAuth = {
  organizationName: string;
  tenantName: string;
  applicationId: string;
  applicationSecret: string;
  orchestratorUrl?: string;
  applicationScope?: string;
};

export type UiPathSolutionPackOptions = {
  projectPath: string;
  version: string;
  outputDir: string;
  dotnetPath?: string;
  cliDllPath?: string;
  nugetConfigPath?: string;
  traceLevel?: "None" | "Critical" | "Error" | "Warning" | "Information" | "Verbose";
};

export type UiPathSolutionPackageRef = {
  packageName: string;
  version: string;
  packagePath: string;
};

function resolveUiPathSolutionPackInput(projectPath: string): { packTargetPath: string; packageName: string } {
  const resolved = path.resolve(projectPath);
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;

  if (stat?.isFile()) {
    if (path.basename(resolved).toLowerCase() !== "solution.uipx") {
      throw new Error(`Expected a Solution.uipx file for native solution pack, got ${resolved}`);
    }
    return {
      packTargetPath: resolved,
      packageName: path.basename(path.dirname(resolved)),
    };
  }

  const solutionUipxPath = path.join(resolved, "Solution.uipx");
  if (fs.existsSync(solutionUipxPath)) {
    return {
      packTargetPath: solutionUipxPath,
      packageName: path.basename(resolved),
    };
  }

  throw new Error(`UiPath Solution.uipx not found in ${resolved}`);
}

export type UiPathSolutionDeployOptions = {
  packageName: string;
  version: string;
  deploymentName: string;
  folderName: string;
  parentFolderName?: string;
  dotnetPath?: string;
  cliDllPath?: string;
  traceLevel?: "None" | "Critical" | "Error" | "Warning" | "Information" | "Verbose";
};

export type UiPathSolutionExpectedResources = {
  processes?: string[];
  assets?: string[];
  queues?: string[];
  buckets?: string[];
};

export type UiPathSolutionFolderSnapshot = {
  processes: string[];
  assets: string[];
  queues: string[];
  buckets: string[];
};

export type UiPathSolutionFolderValidationResult = {
  ok: boolean;
  folderId: string;
  folderName: string;
  actual: UiPathSolutionFolderSnapshot;
  missing: UiPathSolutionExpectedResources;
};

export type UiPathSolutionFolderValidationOptions = UiPathSolutionExpectedResources & {
  folderName?: string;
  folderId?: string;
};

function odataEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeUiPathResourceNames(values: string[] | undefined): string[] {
  return Array.from(new Set((values || []).map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function missingUiPathResourceNames(actual: string[], expected: string[] | undefined): string[] {
  const actualSet = new Set(normalizeUiPathResourceNames(actual).map((value) => value.toLowerCase()));
  return normalizeUiPathResourceNames(expected).filter((value) => !actualSet.has(value.toLowerCase()));
}

export function diffUiPathSolutionFolderResources(
  actual: UiPathSolutionFolderSnapshot,
  expected: UiPathSolutionExpectedResources,
): UiPathSolutionFolderValidationResult["missing"] {
  return {
    processes: missingUiPathResourceNames(actual.processes, expected.processes),
    assets: missingUiPathResourceNames(actual.assets, expected.assets),
    queues: missingUiPathResourceNames(actual.queues, expected.queues),
    buckets: missingUiPathResourceNames(actual.buckets, expected.buckets),
  };
}

function buildUiPathOrchestratorBaseUrl(auth: UiPathSolutionCliAuth): string {
  const root = (auth.orchestratorUrl || DEFAULT_UIPATH_ORCHESTRATOR_URL).replace(/\/+$/, "");
  return `${root}/${auth.organizationName}/${auth.tenantName}/orchestrator_`;
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`UiPath request failed (${response.status}) for ${url}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function fetchUiPathFolderSnapshot(
  auth: UiPathSolutionCliAuth,
  folderId: string,
): Promise<UiPathSolutionFolderSnapshot> {
  const baseUrl = buildUiPathOrchestratorBaseUrl(auth);
  const tokenHeaders = {
    Authorization: `Bearer ${await import("./uipath-auth").then((m) => m.getAccessToken({
      clientId: auth.applicationId,
      clientSecret: auth.applicationSecret,
      scopes: auth.applicationScope || "OR.Default",
    }))}`,
    "Content-Type": "application/json",
    "X-UIPATH-OrganizationUnitId": folderId,
  };

  const [processes, assets, queues, buckets] = await Promise.all([
    fetchJson(`${baseUrl}/odata/Releases?$top=200&$select=Name`, tokenHeaders),
    fetchJson(`${baseUrl}/odata/Assets?$top=200&$select=Name`, tokenHeaders),
    fetchJson(`${baseUrl}/odata/QueueDefinitions?$top=200&$select=Name`, tokenHeaders),
    fetchJson(`${baseUrl}/odata/Buckets?$top=200&$select=Name`, tokenHeaders),
  ]);

  return {
    processes: normalizeUiPathResourceNames((processes?.value || []).map((item: any) => item.Name)),
    assets: normalizeUiPathResourceNames((assets?.value || []).map((item: any) => item.Name)),
    queues: normalizeUiPathResourceNames((queues?.value || []).map((item: any) => item.Name)),
    buckets: normalizeUiPathResourceNames((buckets?.value || []).map((item: any) => item.Name)),
  };
}

export async function validateUiPathSolutionFolderResources(
  auth: UiPathSolutionCliAuth,
  options: UiPathSolutionFolderValidationOptions,
): Promise<UiPathSolutionFolderValidationResult> {
  const baseUrl = buildUiPathOrchestratorBaseUrl(auth);
  const accessToken = await import("./uipath-auth").then((m) => m.getAccessToken({
    clientId: auth.applicationId,
    clientSecret: auth.applicationSecret,
    scopes: auth.applicationScope || "OR.Default",
  }));
  const rootHeaders = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  let folderId = options.folderId || "";
  let folderName = options.folderName || "";

  if (!folderId && !folderName) {
    throw new Error("Solution folder validation requires folderId or folderName.");
  }

  if (!folderId) {
    const folderPayload = await fetchJson(
      `${baseUrl}/odata/Folders?$filter=DisplayName eq '${odataEscape(folderName)}'&$top=1`,
      rootHeaders,
    );
    const match = folderPayload?.value?.[0];
    if (!match?.Id) {
      throw new Error(`UiPath solution folder "${folderName}" was not found.`);
    }
    folderId = String(match.Id);
    folderName = match.DisplayName || folderName;
  }

  const actual = await fetchUiPathFolderSnapshot(auth, folderId);
  const missing = diffUiPathSolutionFolderResources(actual, options);
  const ok = Object.values(missing).every((values) => !values || values.length === 0);

  return {
    ok,
    folderId,
    folderName,
    actual,
    missing,
  };
}

export function buildUiPathSolutionDeployArgs(
  auth: UiPathSolutionCliAuth,
  options: UiPathSolutionDeployOptions,
  cliDllPath: string,
): string[] {
  return [
    cliDllPath,
    "solution",
    "deploy",
    options.packageName,
    "-v", options.version,
    "-d", options.deploymentName,
    "-f", options.folderName,
    ...(options.parentFolderName ? ["--deploymentParentFolder", options.parentFolderName] : []),
    ...buildUiPathSolutionAuthArgs(auth),
    "--traceLevel", options.traceLevel || "Information",
  ];
}

export function getDefaultUiPathCliDllPath(repoRoot = path.resolve(MODULE_DIRNAME, "..")): string {
  return resolveFirstExistingPath(
    getCandidateRepoRoots(repoRoot).map((root) =>
      path.join(root, "tools", "uipath-cli", "25.10.6", "tools", "net8.0", "any", "uipcli.dll"),
    ),
    "UiPath CLI",
  );
}

export function getDefaultUiPathSolutionNugetConfigPath(repoRoot = path.resolve(MODULE_DIRNAME, "..")): string {
  return resolveFirstExistingPath(
    getCandidateRepoRoots(repoRoot).map((root) =>
      path.join(
        root,
        "tools",
        "uipath-cli",
        "25.10.6",
        "tools",
        "net8.0",
        "any",
        "SolutionPackager",
        "Tools",
        "workflowcompiler",
        "NuGet.Config",
      ),
    ),
    "UiPath solution NuGet.Config",
  );
}

export function getDefaultDotnetPath(): string {
  return process.env.DOTNET_PATH || "C:\\Program Files\\dotnet\\dotnet.exe";
}

export function buildUiPathSolutionAuthArgs(auth: UiPathSolutionCliAuth): string[] {
  return [
    "-U", auth.orchestratorUrl || DEFAULT_UIPATH_ORCHESTRATOR_URL,
    "-T", auth.tenantName,
    "-A", auth.organizationName,
    "-I", auth.applicationId,
    "-S", auth.applicationSecret,
    "--applicationScope", auth.applicationScope || DEFAULT_UIPATH_SOLUTION_SCOPES,
  ];
}

export function createLocalUiPathNugetConfig(destinationPath: string): string {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="UiPath-Official" value="${UIPATH_OFFICIAL_NUGET_FEED}" />
    <add key="Connect" value="${UIPATH_MARKETPLACE_NUGET_FEED}" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
`;
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, xml, "utf8");
  return destinationPath;
}

function findNewestZip(outputDir: string): string {
  const files = fs.readdirSync(outputDir);
  const matches = files
    .filter((file) => file.toLowerCase().endsWith(".zip"))
    .map((file) => {
      const fullPath = path.join(outputDir, file);
      return {
        file,
        fullPath,
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (matches.length === 0) {
    const nupkgFiles = files.filter((file) => file.toLowerCase().endsWith(".nupkg"));
    if (nupkgFiles.length > 0) {
      throw new Error(
        `UiPath CLI produced only package output (${nupkgFiles.join(", ")}) in ${outputDir}. ` +
        "A native solution package ZIP requires a real UiPath solution workspace or .uipx file, not just a project directory.",
      );
    }
    throw new Error(`No solution package zip was produced in ${outputDir}`);
  }

  return matches[0].fullPath;
}

export function inferUiPathSolutionPackageName(projectPath: string): string {
  return path.basename(path.resolve(projectPath));
}

export async function runUiPathCli(args: string[], options?: { dotnetPath?: string; cwd?: string }) {
  const dotnetPath = options?.dotnetPath || getDefaultDotnetPath();
  const cliDllPath = args[0];
  if (!fs.existsSync(cliDllPath)) {
    throw new Error(`UiPath CLI not found: ${cliDllPath}`);
  }

  const result = await execFileAsync(dotnetPath, args, {
    cwd: options?.cwd,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function packUiPathNativeSolution(options: UiPathSolutionPackOptions): Promise<UiPathSolutionPackageRef & { stdout: string; stderr: string; }> {
  const resolvedInput = resolveUiPathSolutionPackInput(options.projectPath);

  const cliDllPath = options.cliDllPath || getDefaultUiPathCliDllPath();
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const nugetConfigPath = options.nugetConfigPath
    || (fs.existsSync(getDefaultUiPathSolutionNugetConfigPath()) ? getDefaultUiPathSolutionNugetConfigPath() : createLocalUiPathNugetConfig(path.join(os.tmpdir(), "cb2-uipath-solution", "NuGet.Config")));

  const args = [
    cliDllPath,
    "solution",
    "pack",
    resolvedInput.packTargetPath,
    "-o", outputDir,
    "-v", options.version,
    "--nugetConfigFilePath", nugetConfigPath,
    "--traceLevel", options.traceLevel || "Information",
  ];

  const result = await runUiPathCli(args, {
    dotnetPath: options.dotnetPath,
    cwd: outputDir,
  });

  const packagePath = findNewestZip(outputDir);
  return {
    packageName: resolvedInput.packageName,
    version: options.version,
    packagePath,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function uploadUiPathNativeSolutionPackage(
  auth: UiPathSolutionCliAuth,
  packagePath: string,
  options?: { dotnetPath?: string; cliDllPath?: string; traceLevel?: "None" | "Critical" | "Error" | "Warning" | "Information" | "Verbose"; }
) {
  const cliDllPath = options?.cliDllPath || getDefaultUiPathCliDllPath();
  const args = [
    cliDllPath,
    "solution",
    "upload-package",
    path.resolve(packagePath),
    ...buildUiPathSolutionAuthArgs(auth),
    "--traceLevel", options?.traceLevel || "Information",
  ];

  return runUiPathCli(args, { dotnetPath: options?.dotnetPath });
}

export async function deployUiPathNativeSolution(
  auth: UiPathSolutionCliAuth,
  options: UiPathSolutionDeployOptions,
) {
  const cliDllPath = options.cliDllPath || getDefaultUiPathCliDllPath();
  const args = buildUiPathSolutionDeployArgs(auth, options, cliDllPath);

  return runUiPathCli(args, { dotnetPath: options.dotnetPath });
}

export async function activateUiPathNativeSolution(
  auth: UiPathSolutionCliAuth,
  deploymentName: string,
  version: string,
  options?: { dotnetPath?: string; cliDllPath?: string; traceLevel?: "None" | "Critical" | "Error" | "Warning" | "Information" | "Verbose"; }
) {
  const cliDllPath = options?.cliDllPath || getDefaultUiPathCliDllPath();
  const args = [
    cliDllPath,
    "solution",
    "deploy-activate",
    deploymentName,
    "-v", version,
    ...buildUiPathSolutionAuthArgs(auth),
    "--traceLevel", options?.traceLevel || "Information",
  ];

  return runUiPathCli(args, { dotnetPath: options?.dotnetPath });
}
