import { describe, it, expect } from "vitest";
import { generateInitAllSettingsXaml, makeUiPathCompliant, sanitizePropertyValue } from "../xaml-generator";
import { runQualityGate, type QualityGateInput } from "../uipath-quality-gate";
import * as fs from "fs";
import * as path from "path";

function makeProjectJson(name: string, deps: Record<string, string>): string {
  return JSON.stringify({
    name,
    projectVersion: "1.0.0",
    description: `${name} automation`,
    main: "Main.xaml",
    dependencies: deps,
    designOptions: { projectProfile: "Developement", outputType: "Process" },
    expressionLanguage: "VisualBasic",
    schemaVersion: "4.0",
    studioVersion: "25.10.7",
    targetFramework: "Windows",
  });
}

function runQG(
  xamlEntries: { name: string; content: string }[],
  deps: Record<string, string>,
  options?: Partial<QualityGateInput>,
): ReturnType<typeof runQualityGate> {
  return runQualityGate({
    xamlEntries,
    projectJsonContent: makeProjectJson("Test", deps),
    targetFramework: "Windows",
    archiveManifest: [
      ...xamlEntries.map(e => `lib/net45/${e.name.split("/").pop()}`),
      "lib/net45/project.json",
      "Test.nuspec",
    ],
    ...options,
  });
}

describe("Task 148 — UiPath Package Generator Correctness", () => {

  describe("1. Dependency version alignment", () => {
    it("generation-metadata.json has UiPath.Web.Activities preferred 1.21.0", () => {
      const meta = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "../../catalog/generation-metadata.json"), "utf-8")
      );
      expect(meta.packageVersionRanges["UiPath.Web.Activities"].preferred).toBe("1.21.0");
    });

    it("generation-metadata.json is the single version authority", () => {
      const meta = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "../../catalog/generation-metadata.json"), "utf-8")
      );
      const metaVersion = meta.packageVersionRanges["UiPath.Web.Activities"].preferred;
      expect(metaVersion).toBe("1.21.0");
    });

    it("test fixtures use UiPath-native 'Developement' project profile spelling", () => {
      const fixtureContent = fs.readFileSync(
        path.resolve(__dirname, "./fixtures/process-specs.ts"), "utf-8"
      );
      expect(fixtureContent).toContain("Developement");
    });
  });

  describe("2. Expression emission hardening", () => {
    it("sanitizePropertyValue escapes quotes in bracket-wrapped expressions", () => {
      const result = sanitizePropertyValue("Message", "[str_Name & \" is ready\"]");
      expect(result).toBe("[str_Name &amp; &quot; is ready&quot;]");
    });

    it("sanitizePropertyValue escapes bracket expression with quotes", () => {
      const result = sanitizePropertyValue("Value", "[\"Hello World\"]");
      expect(result).toBe("[&quot;Hello World&quot;]");
    });

    it("sanitizePropertyValue strips quotes from plain strings", () => {
      const result = sanitizePropertyValue("Key", "some'quoted\"value");
      expect(result).toBe("somequotedvalue");
    });

    it("makeUiPathCompliant converts single-quoted Message to bracket expression", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="'Hello World'" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const result = makeUiPathCompliant(xml, "Windows");
      expect(result).toContain('Message="[&quot;Hello World&quot;]"');
    });

    it("makeUiPathCompliant converts concatenation expressions to canonical bracket form", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="'Value: ' &amp; str_Name" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const result = makeUiPathCompliant(xml, "Windows");
      expect(result).toContain('Message="[&quot;Value: &quot; &amp; str_Name]"');
    });

    it("makeUiPathCompliant converts nested-quote concatenation to canonical form", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="'Error: ' &amp; ex.Message &amp; ' at ' &amp; DateTime.Now.ToString" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const result = makeUiPathCompliant(xml, "Windows");
      expect(result).toContain('Message="[&quot;Error: &quot; &amp; ex.Message &amp; &quot; at &quot; &amp; DateTime.Now.ToString()]"');
    });

    it("quality gate flags unconverted single-quoted expressions as errors", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="'Unconverted single quote'" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      const malformed = result.violations.filter(v => v.check === "malformed-expression");
      expect(malformed.some(v => v.detail.includes("single-quoted"))).toBe(true);
    });
  });

  describe("3. SecureString type consistency", () => {
    it("generateInitAllSettingsXaml declares sec_TempPass as s:Security.SecureString", () => {
      const xaml = generateInitAllSettingsXaml(
        { assets: [{ name: "TestCred", type: "Credential" }], queues: [] },
        "Windows"
      );
      expect(xaml).toContain('x:TypeArguments="s:Security.SecureString" Name="sec_TempPass"');
      expect(xaml).not.toContain('x:TypeArguments="x:String" Name="sec_TempPass"');
    });

    it("makeUiPathCompliant fixes sec_ variables with wrong type", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <Sequence.Variables>
      <Variable x:TypeArguments="x:String" Name="sec_Password" />
    </Sequence.Variables>
    <ui:LogMessage Message="[&quot;test&quot;]" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const result = makeUiPathCompliant(xml, "Windows");
      expect(result).toContain('x:TypeArguments="s:Security.SecureString" Name="sec_Password"');
      expect(result).not.toContain('x:TypeArguments="x:String" Name="sec_Password"');
    });

    it("makeUiPathCompliant leaves correctly typed sec_ variables alone", () => {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <Sequence.Variables>
      <Variable x:TypeArguments="s:Security.SecureString" Name="sec_Password" />
    </Sequence.Variables>
    <ui:LogMessage Message="[&quot;test&quot;]" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const result = makeUiPathCompliant(xml, "Windows");
      expect(result).toContain('x:TypeArguments="s:Security.SecureString" Name="sec_Password"');
    });
  });

  describe("4. Quality gate — empty endpoint escalation", () => {
    it("empty HttpClient Endpoint is severity error, not warning", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:HttpClient DisplayName="Call API" Endpoint="" Method="GET" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0", "UiPath.Web.Activities": "1.21.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      const endpointViolations = result.violations.filter(v => v.check === "empty-http-endpoint");
      expect(endpointViolations.length).toBeGreaterThan(0);
      expect(endpointViolations.every(v => v.severity === "error")).toBe(true);
    });

    it("empty OpenBrowser Url is severity error, not warning", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:OpenBrowser DisplayName="Open" Url="" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      const endpointViolations = result.violations.filter(v => v.check === "empty-http-endpoint");
      expect(endpointViolations.length).toBeGreaterThan(0);
      expect(endpointViolations.every(v => v.severity === "error")).toBe(true);
    });

    it("quality gate does not pass when empty endpoints are present", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:HttpClient DisplayName="Call API" Endpoint="" Method="GET" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0", "UiPath.Web.Activities": "1.21.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      expect(result.passed).toBe(false);
      expect(result.completenessLevel).toBe("incomplete");
    });
  });

  describe("5. Malformed expression detection in quality gate", () => {
    it("detects unbalanced brackets in Message attribute", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="[str_Name" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      const malformed = result.violations.filter(v => v.check === "malformed-expression");
      expect(malformed.length).toBeGreaterThan(0);
      expect(malformed.some(v => v.severity === "error")).toBe(true);
    });

    it("detects mixed literal/expression syntax in Value attribute", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <Assign DisplayName="Set Value">
      <Assign.To><OutArgument x:TypeArguments="x:String">[str_Result]</OutArgument></Assign.To>
      <Assign.Value><InArgument x:TypeArguments="x:String" Value="Hello [str_World]" /></Assign.Value>
    </Assign>
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      const malformed = result.violations.filter(v => v.check === "malformed-expression");
      expect(malformed.length).toBeGreaterThan(0);
      expect(malformed.some(v => v.detail.includes("mixed literal/expression"))).toBe(true);
    });

    it("does not flag properly formed bracket expressions", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="[&quot;Hello &quot; &amp; str_Name]" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      const malformed = result.violations.filter(v => v.check === "malformed-expression");
      expect(malformed.length).toBe(0);
    });

    it("quality gate blocks on malformed expressions", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="[str_Name" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      expect(result.passed).toBe(false);
    });

    it("extra closing brackets are also flagged as unbalanced", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Main">
    <ui:LogMessage Message="[str_Name]]" DisplayName="Log" />
  </Sequence>
</Activity>`;
      const deps = { "UiPath.System.Activities": "25.10.0" };
      const result = runQG([{ name: "Main.xaml", content: xaml }], deps);
      const malformed = result.violations.filter(v => v.check === "malformed-expression");
      expect(malformed.length).toBeGreaterThan(0);
      expect(malformed.some(v => v.severity === "error")).toBe(true);
    });
  });
});
