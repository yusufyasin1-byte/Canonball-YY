import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildUiPathSolutionDeployArgs,
  DEFAULT_UIPATH_SOLUTION_SCOPES,
  buildUiPathSolutionAuthArgs,
  createLocalUiPathNugetConfig,
  getDefaultUiPathCliDllPath,
  inferUiPathSolutionPackageName,
} from "../uipath-solution-cli";

describe("UiPath solution CLI helpers", () => {
  it("builds native solution auth args with the default scope set", () => {
    const args = buildUiPathSolutionAuthArgs({
      organizationName: "myorg",
      tenantName: "DefaultTenant",
      applicationId: "app-id",
      applicationSecret: "app-secret",
    });

    expect(args).toContain("https://cloud.uipath.com/");
    expect(args).toContain("DefaultTenant");
    expect(args).toContain("myorg");
    expect(args).toContain(DEFAULT_UIPATH_SOLUTION_SCOPES);
  });

  it("writes a local NuGet config with UiPath feeds", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb2-uipath-nuget-"));
    const configPath = createLocalUiPathNugetConfig(path.join(tempDir, "NuGet.Config"));
    const content = fs.readFileSync(configPath, "utf8");

    expect(content).toContain("UiPath-Official");
    expect(content).toContain("gallery.uipath.com/api/v3/index.json");
    expect(content).toContain("api.nuget.org/v3/index.json");
  });

  it("derives the solution package name from the project directory", () => {
    const packageName = inferUiPathSolutionPackageName("C:/repo/projects/POInvoiceTestNew");
    expect(packageName).toBe("POInvoiceTestNew");
  });

  it("keeps the default solution scopes aligned with the CLI docs", () => {
    expect(DEFAULT_UIPATH_SOLUTION_SCOPES).toContain("AutomationSolutions");
    expect(DEFAULT_UIPATH_SOLUTION_SCOPES).toContain("Solutions.Packages.Write");
    expect(DEFAULT_UIPATH_SOLUTION_SCOPES).toContain("Solutions.Deployments.Write");
  });

  it("resolves the default UiPath CLI path without relying on CommonJS globals", () => {
    expect(getDefaultUiPathCliDllPath()).toContain(path.join("tools", "uipath-cli", "25.10.6", "tools", "net8.0", "any", "uipcli.dll"));
  });

  it("builds deploy args that support stable parent-folder solution upgrades", () => {
    const args = buildUiPathSolutionDeployArgs({
      organizationName: "myorg",
      tenantName: "DefaultTenant",
      applicationId: "app-id",
      applicationSecret: "app-secret",
    }, {
      packageName: "Solution",
      version: "1.0.4-sim",
      deploymentName: "POInvoice",
      folderName: "POInvoice Solutions",
      parentFolderName: "CB2YY",
      traceLevel: "Information",
    }, "C:\\tools\\uipcli.dll");

    expect(args).toContain("-d");
    expect(args).toContain("POInvoice");
    expect(args).toContain("-f");
    expect(args).toContain("POInvoice Solutions");
    expect(args).toContain("--deploymentParentFolder");
    expect(args).toContain("CB2YY");
  });
});
