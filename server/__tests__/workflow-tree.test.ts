import { describe, it, expect } from "vitest";
import { assembleNode, assembleWorkflowFromSpec, resolveActivityTemplate, lintAndFixVbExpression, CSharpExpressionBlockedError, validateContainerChildModel } from "../workflow-tree-assembler";
import { validateWorkflowSpec, type WorkflowNode, type WorkflowSpec, type ActivityNode, type VariableDeclaration } from "../workflow-spec-types";
import { makeUiPathCompliant } from "../xaml-generator";

describe("Workflow Tree Architecture", () => {
  describe("WorkflowSpec Zod Validation", () => {
    it("validates a minimal valid WorkflowSpec", () => {
      const spec = {
        name: "TestWorkflow",
        variables: [{ name: "str_Test", type: "String" }],
        rootSequence: {
          kind: "sequence" as const,
          displayName: "Main Sequence",
          children: [],
        },
      };
      const result = validateWorkflowSpec(spec);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("TestWorkflow");
        expect(result.data.variables).toHaveLength(1);
      }
    });

    it("validates a complex nested WorkflowSpec", () => {
      const spec = {
        name: "ComplexWorkflow",
        variables: [
          { name: "str_Result", type: "String" },
          { name: "int_Count", type: "Int32", default: "0" },
        ],
        rootSequence: {
          kind: "sequence" as const,
          displayName: "Main",
          children: [
            {
              kind: "tryCatch" as const,
              displayName: "Try API Call",
              tryChildren: [
                {
                  kind: "activity" as const,
                  template: "HttpClient",
                  displayName: "Call API",
                  properties: { Endpoint: "https://api.example.com" },
                  errorHandling: "none" as const,
                },
              ],
              catchChildren: [],
              finallyChildren: [],
            },
            {
              kind: "if" as const,
              displayName: "Check Result",
              condition: "str_Result IsNot Nothing",
              thenChildren: [
                {
                  kind: "activity" as const,
                  template: "LogMessage",
                  displayName: "Log Success",
                  properties: { Level: "Info", Message: '"Success"' },
                  errorHandling: "none" as const,
                },
              ],
              elseChildren: [],
            },
          ],
        },
      };
      const result = validateWorkflowSpec(spec);
      expect(result.success).toBe(true);
    });

    it("rejects WorkflowSpec missing required fields", () => {
      const invalid = { description: "no name" };
      const result = validateWorkflowSpec(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    it("rejects WorkflowSpec with invalid node kind", () => {
      const invalid = {
        name: "Test",
        rootSequence: {
          kind: "sequence",
          displayName: "Main",
          children: [{ kind: "invalidKind", displayName: "Bad" }],
        },
      };
      const result = validateWorkflowSpec(invalid);
      expect(result.success).toBe(false);
    });

    it("validates WhileNode", () => {
      const spec = {
        name: "WhileTest",
        rootSequence: {
          kind: "sequence" as const,
          displayName: "Main",
          children: [
            {
              kind: "while" as const,
              displayName: "Loop",
              condition: "int_Count < 10",
              bodyChildren: [
                {
                  kind: "activity" as const,
                  template: "LogMessage",
                  displayName: "Log",
                  properties: { Level: "Info", Message: '"Iteration"' },
                  errorHandling: "none" as const,
                },
              ],
            },
          ],
        },
      };
      const result = validateWorkflowSpec(spec);
      expect(result.success).toBe(true);
    });

    it("validates ForEachNode", () => {
      const spec = {
        name: "ForEachTest",
        rootSequence: {
          kind: "sequence" as const,
          displayName: "Main",
          children: [
            {
              kind: "forEach" as const,
              displayName: "Process Items",
              itemType: "x:String",
              valuesExpression: "arr_Items",
              iteratorName: "item",
              bodyChildren: [
                {
                  kind: "activity" as const,
                  template: "LogMessage",
                  displayName: "Log Item",
                  properties: { Level: "Info", Message: "[item]" },
                  errorHandling: "none" as const,
                },
              ],
            },
          ],
        },
      };
      const result = validateWorkflowSpec(spec);
      expect(result.success).toBe(true);
    });

    it("validates RetryScopeNode", () => {
      const spec = {
        name: "RetryTest",
        rootSequence: {
          kind: "sequence" as const,
          displayName: "Main",
          children: [
            {
              kind: "retryScope" as const,
              displayName: "Retry API Call",
              numberOfRetries: 3,
              retryInterval: "00:00:10",
              bodyChildren: [
                {
                  kind: "activity" as const,
                  template: "HttpClient",
                  displayName: "Call API",
                  properties: { Endpoint: "https://api.example.com" },
                  errorHandling: "none" as const,
                },
              ],
            },
          ],
        },
      };
      const result = validateWorkflowSpec(spec);
      expect(result.success).toBe(true);
    });
  });

  describe("assembleNode — ActivityNode", () => {
    it("assembles a LogMessage activity", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "LogMessage",
        displayName: "Log Start",
        properties: { Level: "Info", Message: '"Starting workflow"' },
        errorHandling: "none",
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<ui:LogMessage");
      expect(xml).toContain('Level="Info"');
      expect(xml).toContain('DisplayName="Log Start"');
    });

    it("wraps quoted LogMessage literals as VB string expressions", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "LogMessage",
        displayName: "Bind Point Log",
        properties: { Level: "Info", Message: '"Bind Action Center task creation for Action Center"' },
        errorHandling: "none",
      };
      const xml = assembleNode(node);
      expect(xml).toContain('Message="[&quot;Bind Action Center task creation for Action Center&quot;]"');
    });

    it("keeps enum-valued OpenBrowser BrowserType as a raw enum literal", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "OpenBrowser",
        displayName: "Open Browser",
        properties: { Url: '"https://example.com"', BrowserType: "Chrome" },
        errorHandling: "none",
      };
      const xml = assembleNode(node);
      expect(xml).toContain('BrowserType="Chrome"');
      expect(xml).not.toContain('BrowserType="[Chrome]"');
    });

    it("assembles an Assign with type inference from variables", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "Assign",
        displayName: "Set Name",
        properties: { To: "str_Name", Value: '"John"' },
        errorHandling: "none",
      };
      const vars: VariableDeclaration[] = [{ name: "str_Name", type: "String" }];
      const xml = assembleNode(node, vars);
      expect(xml).toContain('x:TypeArguments="x:String"');
      expect(xml).toContain("[str_Name]");
      expect(xml).toContain("<Assign.To>");
      expect(xml).toContain("<Assign.Value>");
    });

    it("assembles an Assign with type inference from prefix", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "Assign",
        displayName: "Set Count",
        properties: { To: "int_Count", Value: "0" },
        errorHandling: "none",
      };
      const xml = assembleNode(node);
      expect(xml).toContain('x:TypeArguments="x:Int32"');
    });

    it("assembles GetAsset with AssetValue (not Value)", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "GetAsset",
        displayName: "Get API Key",
        properties: { AssetName: "APIKey" },
        outputVar: "str_ApiKey",
        errorHandling: "none",
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<ui:GetAsset");
      expect(xml).toContain("AssetValue");
      expect(xml).not.toContain('Value="');
      expect(xml).toContain("[str_ApiKey]");
    });

    it("assembles GetCredential with proper OutArgument structure", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "GetCredential",
        displayName: "Get SMTP Creds",
        properties: { AssetName: "SmtpCredential", Username: "str_SmtpUser", Password: "sec_SmtpPass" },
        errorHandling: "none",
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<ui:GetCredential");
      expect(xml).toContain("<ui:GetCredential.Username>");
      expect(xml).toContain("<ui:GetCredential.Password>");
      expect(xml).toContain("<OutArgument");
      expect(xml).toContain("[str_SmtpUser]");
      expect(xml).toContain("[sec_SmtpPass]");
    });

    it("assembles SendSmtpMailMessage with Body property and bracket-wrapped variable references", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "SendSmtpMailMessage",
        displayName: "Send Notification",
        properties: {
          To: "str_RecipientEmail",
          From: "str_SenderEmail",
          Subject: "str_EmailSubject",
          Body: "str_EmailBody",
          Server: "smtp.example.com",
          Port: "587",
          Username: "str_SmtpUser",
          Password: "str_SmtpPass",
        },
        errorHandling: "none",
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<ui:SendSmtpMailMessage");
      expect(xml).toContain("[str_RecipientEmail]");
      expect(xml).toContain("[str_EmailSubject]");
      expect(xml).toContain("[str_EmailBody]");
      expect(xml).toContain("[str_SenderEmail]");
      expect(xml).toContain("[str_SmtpUser]");
      expect(xml).toContain("[str_SmtpPass]");
      expect(xml).toContain("From=");
      expect(xml).toContain("Username=");
      expect(xml).toContain("Password=");
      if (xml.includes("SendSmtpMailMessage.Body")) {
        expect(xml).toContain("InArgument");
      } else {
        expect(xml).toContain("Body=");
      }
    });

    it("wraps activity in TryCatch when errorHandling is catch", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "HttpClient",
        displayName: "Call API",
        properties: { Endpoint: "https://api.example.com", Method: "GET" },
        outputVar: "str_Response",
        errorHandling: "catch",
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<TryCatch");
      expect(xml).toContain("<TryCatch.Try>");
      expect(xml).toContain("<ui:HttpClient");
      expect(xml).toContain("<TryCatch.Catches>");
    });

    it("wraps activity in RetryScope when errorHandling is retry", () => {
      const node: ActivityNode = {
        kind: "activity",
        template: "HttpClient",
        displayName: "Retry API",
        properties: { Endpoint: "https://api.example.com" },
        errorHandling: "retry",
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<ui:RetryScope");
      expect(xml).toContain("<ui:HttpClient");
      expect(xml).toContain("<ui:ShouldRetry");
    });
  });

  describe("assembleNode — TryCatchNode", () => {
    it("places children inside TryCatch.Try body, not as siblings", () => {
      const node: WorkflowNode = {
        kind: "tryCatch",
        displayName: "Try Block",
        tryChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Log Inside Try",
            properties: { Level: "Info", Message: '"Inside try"' },
            errorHandling: "none",
          },
          {
            kind: "activity",
            template: "HttpClient",
            displayName: "API Call",
            properties: { Endpoint: "https://api.test.com" },
            errorHandling: "none",
          },
        ],
        catchChildren: [],
        finallyChildren: [],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<TryCatch");
      expect(xml).toContain("<TryCatch.Try>");

      const tryStart = xml.indexOf("<TryCatch.Try>");
      const tryEnd = xml.indexOf("</TryCatch.Try>");
      const tryBlock = xml.substring(tryStart, tryEnd);
      expect(tryBlock).toContain("Log Inside Try");
      expect(tryBlock).toContain("API Call");

      const afterTryCatch = xml.indexOf("</TryCatch>");
      const afterContent = xml.substring(afterTryCatch);
      expect(afterContent).not.toContain("Log Inside Try");
      expect(afterContent).not.toContain("API Call");
    });

    it("places catch children inside the Catch handler", () => {
      const node: WorkflowNode = {
        kind: "tryCatch",
        displayName: "Try With Custom Catch",
        tryChildren: [
          {
            kind: "activity",
            template: "HttpClient",
            displayName: "API Call",
            properties: { Endpoint: "https://api.test.com" },
            errorHandling: "none",
          },
        ],
        catchChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Log Error",
            properties: { Level: "Error", Message: '"Error occurred"' },
            errorHandling: "none",
          },
        ],
        finallyChildren: [],
      };
      const xml = assembleNode(node);
      const catchStart = xml.indexOf("<TryCatch.Catches>");
      const catchEnd = xml.indexOf("</TryCatch.Catches>");
      const catchBlock = xml.substring(catchStart, catchEnd);
      expect(catchBlock).toContain("Log Error");
    });

    it("places finally children inside TryCatch.Finally", () => {
      const node: WorkflowNode = {
        kind: "tryCatch",
        displayName: "Try With Finally",
        tryChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Try Action",
            properties: { Level: "Info", Message: '"Trying"' },
            errorHandling: "none",
          },
        ],
        catchChildren: [],
        finallyChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Cleanup",
            properties: { Level: "Info", Message: '"Cleaning up"' },
            errorHandling: "none",
          },
        ],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<TryCatch.Finally>");
      const finallyStart = xml.indexOf("<TryCatch.Finally>");
      const finallyEnd = xml.indexOf("</TryCatch.Finally>");
      const finallyBlock = xml.substring(finallyStart, finallyEnd);
      expect(finallyBlock).toContain("Cleanup");
    });
  });

  describe("assembleNode — IfNode", () => {
    it("places children in Then/Else branches", () => {
      const node: WorkflowNode = {
        kind: "if",
        displayName: "Check Condition",
        condition: "str_Result IsNot Nothing",
        thenChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Then Log",
            properties: { Level: "Info", Message: '"Condition true"' },
            errorHandling: "none",
          },
        ],
        elseChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Else Log",
            properties: { Level: "Warn", Message: '"Condition false"' },
            errorHandling: "none",
          },
        ],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<If");
      expect(xml).toContain("<If.Then>");
      expect(xml).toContain("<If.Else>");

      const thenStart = xml.indexOf("<If.Then>");
      const thenEnd = xml.indexOf("</If.Then>");
      const thenBlock = xml.substring(thenStart, thenEnd);
      expect(thenBlock).toContain("Then Log");
      expect(thenBlock).not.toContain("Else Log");

      const elseStart = xml.indexOf("<If.Else>");
      const elseEnd = xml.indexOf("</If.Else>");
      const elseBlock = xml.substring(elseStart, elseEnd);
      expect(elseBlock).toContain("Else Log");
      expect(elseBlock).not.toContain("Then Log");
    });

    it("omits Else block when no elseChildren", () => {
      const node: WorkflowNode = {
        kind: "if",
        displayName: "Check Only",
        condition: "bool_Flag",
        thenChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Then",
            properties: { Level: "Info", Message: '"yes"' },
            errorHandling: "none",
          },
        ],
        elseChildren: [],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<If.Then>");
      expect(xml).not.toContain("<If.Else>");
    });
  });

  describe("assembleNode — WhileNode", () => {
    it("places children in Body", () => {
      const node: WorkflowNode = {
        kind: "while",
        displayName: "Process Loop",
        condition: "int_Count &lt; 10",
        bodyChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Loop Body",
            properties: { Level: "Info", Message: '"Iteration"' },
            errorHandling: "none",
          },
          {
            kind: "activity",
            template: "Assign",
            displayName: "Increment",
            properties: { To: "int_Count", Value: "int_Count + 1" },
            errorHandling: "none",
          },
        ],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<While");
      expect(xml).toContain("<While.Body>");

      const bodyStart = xml.indexOf("<While.Body>");
      const bodyEnd = xml.indexOf("</While.Body>");
      const bodyBlock = xml.substring(bodyStart, bodyEnd);
      expect(bodyBlock).toContain("Loop Body");
      expect(bodyBlock).toContain("Increment");
    });
  });

  describe("assembleNode — ForEachNode", () => {
    it("places children in Body with iterator", () => {
      const node: WorkflowNode = {
        kind: "forEach",
        displayName: "Process Each Item",
        itemType: "x:String",
        valuesExpression: "arr_Items",
        iteratorName: "currentItem",
        bodyChildren: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Log Item",
            properties: { Level: "Info", Message: "[currentItem]" },
            errorHandling: "none",
          },
        ],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<ForEach");
      expect(xml).toContain('x:TypeArguments="x:String"');
      expect(xml).toContain('Name="currentItem"');
      expect(xml).toContain("<DelegateInArgument");
      expect(xml).toContain("Log Item");
    });
  });

  describe("assembleNode — RetryScopeNode", () => {
    it("places children as default content (no explicit .Body)", () => {
      const node: WorkflowNode = {
        kind: "retryScope",
        displayName: "Retry Operations",
        numberOfRetries: 5,
        retryInterval: "00:00:10",
        bodyChildren: [
          {
            kind: "activity",
            template: "HttpClient",
            displayName: "API Call",
            properties: { Endpoint: "https://api.test.com" },
            errorHandling: "none",
          },
        ],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<ui:RetryScope");
      expect(xml).toContain('NumberOfRetries="5"');
      expect(xml).toContain('RetryInterval="00:00:10"');
      expect(xml).not.toContain("<ui:RetryScope.Body>");
      expect(xml).toContain("<ui:ShouldRetry");
      expect(xml).toContain("API Call");
    });
  });

  describe("assembleNode — SequenceNode", () => {
    it("assembles sequence with variables", () => {
      const node: WorkflowNode = {
        kind: "sequence",
        displayName: "Inner Sequence",
        variables: [{ name: "str_Local", type: "String" }],
        children: [
          {
            kind: "activity",
            template: "LogMessage",
            displayName: "Log",
            properties: { Level: "Info", Message: '"test"' },
            errorHandling: "none",
          },
        ],
      };
      const xml = assembleNode(node);
      expect(xml).toContain("<Sequence");
      expect(xml).toContain("<Sequence.Variables>");
      expect(xml).toContain('Name="str_Local"');
      expect(xml).toContain('x:TypeArguments="x:String"');
    });
  });

  describe("assembleWorkflowFromSpec", () => {
    it("produces complete XAML with header and variables", () => {
      const spec: WorkflowSpec = {
        name: "TestWorkflow",
        variables: [
          { name: "str_Result", type: "String" },
          { name: "int_Count", type: "Int32", default: "0" },
        ],
        arguments: [],
        rootSequence: {
          kind: "sequence",
          displayName: "TestWorkflow",
          children: [
            {
              kind: "activity",
              template: "LogMessage",
              displayName: "Start",
              properties: { Level: "Info", Message: '"Starting"' },
              errorHandling: "none",
            },
          ],
        },
        useReFramework: false,
        dhgNotes: [],
        decomposition: [],
      };
      const { xaml, variables } = assembleWorkflowFromSpec(spec);
      expect(xaml).toContain('<?xml version="1.0"');
      expect(xaml).toContain('<Activity mc:Ignorable="sap sap2010"');
      expect(xaml).toContain('x:Class="TestWorkflow"');
      expect(xaml).toContain("<Sequence.Variables>");
      expect(xaml).toContain('Name="str_Result"');
      expect(xaml).toContain('Name="int_Count"');
      expect(xaml).toContain("ui:LogMessage");
      expect(variables).toHaveLength(3);
    });

    it("includes x:Members for arguments", () => {
      const spec: WorkflowSpec = {
        name: "ArgWorkflow",
        variables: [],
        arguments: [
          { name: "in_Config", direction: "InArgument", type: "x:String" },
          { name: "out_Result", direction: "OutArgument", type: "x:Boolean" },
        ],
        rootSequence: {
          kind: "sequence",
          displayName: "ArgWorkflow",
          children: [],
        },
        useReFramework: false,
        dhgNotes: [],
        decomposition: [],
      };
      const { xaml } = assembleWorkflowFromSpec(spec);
      expect(xaml).toContain("<x:Members>");
      expect(xaml).toContain('Name="in_Config"');
      expect(xaml).toContain('Type="InArgument(x:String)"');
      expect(xaml).toContain('Name="out_Result"');
      expect(xaml).toContain('Type="OutArgument(x:Boolean)"');
    });

    it("produces deeply nested hierarchical XAML", () => {
      const spec: WorkflowSpec = {
        name: "NestedWorkflow",
        variables: [
          { name: "str_ApiResponse", type: "String" },
          { name: "bool_Success", type: "Boolean", default: "False" },
        ],
        arguments: [],
        rootSequence: {
          kind: "sequence",
          displayName: "NestedWorkflow",
          children: [
            {
              kind: "tryCatch",
              displayName: "Try API Call",
              tryChildren: [
                {
                  kind: "activity",
                  template: "HttpClient",
                  displayName: "Call API",
                  properties: { Endpoint: "https://api.example.com", Method: "GET" },
                  outputVar: "str_ApiResponse",
                  errorHandling: "none",
                },
                {
                  kind: "if",
                  displayName: "Check Response",
                  condition: "str_ApiResponse IsNot Nothing",
                  thenChildren: [
                    {
                      kind: "activity",
                      template: "Assign",
                      displayName: "Set Success",
                      properties: { To: "bool_Success", Value: "True" },
                      errorHandling: "none",
                    },
                  ],
                  elseChildren: [
                    {
                      kind: "activity",
                      template: "LogMessage",
                      displayName: "Log No Response",
                      properties: { Level: "Warn", Message: '"No response received"' },
                      errorHandling: "none",
                    },
                  ],
                },
              ],
              catchChildren: [
                {
                  kind: "activity",
                  template: "LogMessage",
                  displayName: "Log API Error",
                  properties: { Level: "Error", Message: '"API call failed"' },
                  errorHandling: "none",
                },
              ],
              finallyChildren: [],
            },
          ],
        },
        useReFramework: false,
        dhgNotes: [],
        decomposition: [],
      };

      const { xaml } = assembleWorkflowFromSpec(spec);

      expect(xaml).toContain("<TryCatch");
      expect(xaml).toContain("<If");

      const tryCatchTryStart = xaml.indexOf("<TryCatch.Try>");
      const tryCatchTryEnd = xaml.indexOf("</TryCatch.Try>");
      const tryBlock = xaml.substring(tryCatchTryStart, tryCatchTryEnd);

      expect(tryBlock).toContain("<ui:HttpClient");
      expect(tryBlock).toContain("<If");

      const ifThenStart = tryBlock.indexOf("<If.Then>");
      const ifThenEnd = tryBlock.indexOf("</If.Then>");
      const thenBlock = tryBlock.substring(ifThenStart, ifThenEnd);
      expect(thenBlock).toContain("Set Success");

      const ifElseStart = tryBlock.indexOf("<If.Else>");
      const ifElseEnd = tryBlock.indexOf("</If.Else>");
      const elseBlock = tryBlock.substring(ifElseStart, ifElseEnd);
      expect(elseBlock).toContain("Log No Response");
    });
  });

  describe("Doubled OutArgument post-processor", () => {
    it("catches doubled OutArgument with whitespace between tags", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="Test"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Test">
    <Sequence.Variables>
      <Variable x:TypeArguments="x:String" Name="myVar" />
    </Sequence.Variables>
    <Assign DisplayName="Test Assign">
      <Assign.To>
        <OutArgument x:TypeArguments="x:String">
          <OutArgument x:TypeArguments="x:String">[myVar]</OutArgument>
        </OutArgument>
      </Assign.To>
      <Assign.Value>
        <InArgument x:TypeArguments="x:String">"hello"</InArgument>
      </Assign.Value>
    </Assign>
  </Sequence>
</Activity>`;
      const fixed = makeUiPathCompliant(xaml);
      const outArgCount = (fixed.match(/<OutArgument/g) || []).length;
      const closeOutArgCount = (fixed.match(/<\/OutArgument>/g) || []).length;
      expect(outArgCount).toBe(closeOutArgCount);
      expect(fixed).not.toMatch(/<OutArgument[^>]*>\s*<OutArgument/);
    });

    it("catches doubled InArgument with whitespace between tags", () => {
      const xaml = `<?xml version="1.0" encoding="utf-8"?>
<Activity mc:Ignorable="sap sap2010" x:Class="Test"
  xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities"
  xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
  xmlns:s="clr-namespace:System;assembly=mscorlib"
  xmlns:sap="http://schemas.microsoft.com/netfx/2009/xaml/activities/presentation"
  xmlns:sap2010="http://schemas.microsoft.com/netfx/2010/xaml/activities/presentation"
  xmlns:scg="clr-namespace:System.Collections.Generic;assembly=mscorlib"
  xmlns:scg2="clr-namespace:System.Data;assembly=System.Data"
  xmlns:ui="http://schemas.uipath.com/workflow/activities"
  xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
  <Sequence DisplayName="Test">
    <Sequence.Variables>
      <Variable x:TypeArguments="x:String" Name="someVal" />
    </Sequence.Variables>
    <Assign DisplayName="Test Assign">
      <Assign.To>
        <OutArgument x:TypeArguments="x:String">[someVal]</OutArgument>
      </Assign.To>
      <Assign.Value>
        <InArgument x:TypeArguments="x:String">
          <InArgument x:TypeArguments="x:String">"value"</InArgument>
        </InArgument>
      </Assign.Value>
    </Assign>
  </Sequence>
</Activity>`;
      const fixed = makeUiPathCompliant(xaml);
      expect(fixed).not.toMatch(/<InArgument[^>]*>\s*<InArgument/);
    });
  });

  describe("ui:InvokeCode is blocked", () => {
    it("InvokeCode is in the ALWAYS_BLOCKED list", async () => {
      const { isActivityAllowed } = await import("../uipath-activity-policy");
      expect(isActivityAllowed("ui:InvokeCode", "simple-linear")).toBe(false);
      expect(isActivityAllowed("ui:InvokeCode", "api-data-driven")).toBe(false);
      expect(isActivityAllowed("ui:InvokeCode", "ui-automation")).toBe(false);
      expect(isActivityAllowed("ui:InvokeCode", "transactional-queue")).toBe(false);
      expect(isActivityAllowed("ui:InvokeCode", "hybrid")).toBe(false);
    });
  });

  describe("Schema handles non-string property values", () => {
    it("accepts and normalizes numeric and boolean property values", () => {
      const spec = {
        name: "MixedTypes",
        rootSequence: {
          kind: "sequence" as const,
          displayName: "Main",
          children: [
            {
              kind: "activity" as const,
              template: "SendSmtpMailMessage",
              displayName: "Send Email",
              properties: {
                To: "user@example.com",
                Port: 587,
                IsBodyHtml: true,
                Subject: "Test",
              },
              errorHandling: "none" as const,
            },
          ],
        },
      };
      const result = validateWorkflowSpec(spec);
      expect(result.success).toBe(true);
      if (result.success) {
        const activity = result.data.rootSequence.children[0];
        if (activity.kind === "activity") {
          expect(activity.properties.Port).toBe("587");
          expect(activity.properties.IsBodyHtml).toBe("true");
        }
      }
    });
  });

  describe("Validation retry behavior", () => {
    it("returns errors array on invalid WorkflowSpec", () => {
      const invalid = { name: "" };
      const result = validateWorkflowSpec(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.some(e => e.includes("rootSequence"))).toBe(true);
      }
    });

    it("rejects empty name", () => {
      const invalid = {
        name: "",
        rootSequence: { kind: "sequence", displayName: "Main", children: [] },
      };
      const result = validateWorkflowSpec(invalid);
      expect(result.success).toBe(false);
    });
  });

  describe("Doubled Argument Normalization (parser fallback)", () => {
    it("collapses single-line doubled OutArgument via makeUiPathCompliant", () => {
      const input = `<Assign.To><OutArgument x:TypeArguments="x:String"><OutArgument x:TypeArguments="x:String">[myVar]</OutArgument></OutArgument></Assign.To>`;
      const result = makeUiPathCompliant(input);
      expect(result).not.toContain("<OutArgument x:TypeArguments=\"x:String\"><OutArgument");
      expect(result).toContain("[myVar]</OutArgument>");
    });

    it("collapses multiline doubled InArgument via makeUiPathCompliant", () => {
      const input = `<InArgument x:TypeArguments="x:String">\n  <InArgument x:TypeArguments="x:String">[inputVal]</InArgument>\n</InArgument>`;
      const result = makeUiPathCompliant(input);
      const inArgCount = (result.match(/<InArgument/g) || []).length;
      const closeCount = (result.match(/<\/InArgument>/g) || []).length;
      expect(inArgCount).toBe(1);
      expect(closeCount).toBe(1);
      expect(result).toContain("[inputVal]");
    });

    it("collapses doubled OutArgument with mixed attributes across lines", () => {
      const input = `<OutArgument>\n    <OutArgument x:TypeArguments="x:Int32">[count]</OutArgument>\n  </OutArgument>`;
      const result = makeUiPathCompliant(input);
      expect(result).toContain("x:TypeArguments");
      expect(result).toContain("[count]");
      const outArgCount = (result.match(/<OutArgument/g) || []).length;
      expect(outArgCount).toBe(1);
    });
  });

  describe("VB Expression Lint & C# Blocking", () => {
    it("blocks C# lambda with body (=> {)", () => {
      expect(() => lintAndFixVbExpression("items.Where(x => { return x.Active; })")).toThrow(CSharpExpressionBlockedError);
    });

    it("blocks C# string interpolation ($\"...\")", () => {
      expect(() => lintAndFixVbExpression('$"Hello {name}"')).toThrow(CSharpExpressionBlockedError);
    });

    it("blocks null-coalescing operator (??)", () => {
      expect(() => lintAndFixVbExpression("value ?? defaultVal")).toThrow(CSharpExpressionBlockedError);
    });

    it("blocks null-conditional access (?.)", () => {
      expect(() => lintAndFixVbExpression("obj?.Property")).toThrow(CSharpExpressionBlockedError);
    });

    it("blocks var declarations", () => {
      expect(() => lintAndFixVbExpression("var x = 5")).toThrow(CSharpExpressionBlockedError);
    });

    it("blocks C# foreach statements", () => {
      expect(() => lintAndFixVbExpression("foreach(var item in list)")).toThrow(CSharpExpressionBlockedError);
    });

    it("blocks C# using statements", () => {
      expect(() => lintAndFixVbExpression("using(var stream = new FileStream())")).toThrow(CSharpExpressionBlockedError);
    });

    it("passes through valid VB expressions unchanged", () => {
      expect(lintAndFixVbExpression("str_Input")).toBe("str_Input");
      expect(lintAndFixVbExpression('"Hello World"')).toBe('"Hello World"');
      expect(lintAndFixVbExpression("42")).toBe("42");
    });

    it("passes through empty/whitespace expressions unchanged", () => {
      expect(lintAndFixVbExpression("")).toBe("");
      expect(lintAndFixVbExpression("  ")).toBe("  ");
    });
  });

  describe("Container Child-Model Validation", () => {
    it("auto-repairs empty If.Then with placeholder", () => {
      const xaml = `<If Condition="True"><If.Then></If.Then></If>`;
      const result = validateContainerChildModel(xaml, "TestWf");
      expect(result.repairs.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    it("auto-repairs empty TryCatch.Try with placeholder", () => {
      const xaml = `<TryCatch><TryCatch.Try></TryCatch.Try></TryCatch>`;
      const result = validateContainerChildModel(xaml, "TestWf");
      expect(result.repairs.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });

    it("detects irrecoverable missing ForEach ActivityAction", () => {
      const xaml = `<ForEach x:TypeArguments="x:String" DisplayName="Loop"><Sequence /></ForEach>`;
      const result = validateContainerChildModel(xaml, "TestWf");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("ActivityAction");
    });

    it("flags lingering RetryScope.Body as irrecoverable", () => {
      const xaml = `<ui:RetryScope><ui:RetryScope.Body><Sequence /></ui:RetryScope.Body></ui:RetryScope>`;
      const result = validateContainerChildModel(xaml, "TestWf");
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain(".Body");
    });

    it("auto-repairs self-closing Transition without Condition", () => {
      const xaml = `<Transition DisplayName="Go Next" To="{x:Reference State_B}" />`;
      const result = validateContainerChildModel(xaml, "TestWf");
      expect(result.repairs.length).toBeGreaterThan(0);
      expect(result.repairedXaml).toContain("<Transition.Condition>");
      expect(result.repairedXaml).toContain("[True]");
      expect(result.errors.length).toBe(0);
    });

    it("auto-repairs open Transition with neither Condition nor Action", () => {
      const xaml = `<Transition DisplayName="Go Next" To="{x:Reference State_B}"><Sequence /></Transition>`;
      const result = validateContainerChildModel(xaml, "TestWf");
      expect(result.repairs.length).toBeGreaterThan(0);
      expect(result.repairedXaml).toContain("Transition.Condition");
    });
  });
});
