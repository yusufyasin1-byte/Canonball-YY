import { getUiPathConfig, probeServiceAvailability, type UiPathConfig, type ServiceAvailabilityMap, type AICenterSkill } from "../uipath-integration";
import { uipathFetch, isGenuineApiResponse, isValidCreation } from "../uipath-fetch";
import { getAccessToken, getToken as getSharedToken, getTmToken, invalidateTmToken, type UiPathAuthConfig } from "../uipath-auth";
import { metadataService } from "../catalog/metadata-service";
import type { DeploymentResult } from "@shared/models/deployment";
import type { OrchestratorArtifacts, AgentDef, AgentToolDef, AgentEscalationRule, AgentContextGrounding, KnowledgeBaseDef, PromptTemplateDef, MaestroProcessDef } from "./manifest-manager";

function odataEscape(value: string): string {
  return value.replace(/'/g, "''");
}

const UIPATH_DESC_MAX = 250;
function truncDesc(desc: string | undefined | null): string {
  const s = (desc || "").trim();
  if (s.length <= UIPATH_DESC_MAX) return s;
  return s.slice(0, UIPATH_DESC_MAX - 3) + "...";
}

function sanitizeCronExpression(cron: string): string {
  let parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    parts = ["0", ...parts];
  }
  if (parts.length === 6) {
    parts.push("*");
  }
  if (parts.length >= 7) {
    if (parts[3] !== "?" && parts[5] !== "?") {
      if (parts[5] === "*") {
        parts[5] = "?";
      } else if (parts[3] === "*") {
        parts[3] = "?";
      } else {
        parts[5] = "?";
      }
    }
    if (parts[3] === "?" && parts[5] === "?") {
      parts[5] = "*";
    }
  }
  return parts.slice(0, 7).join(" ");
}

function sanitizeErrorMessage(httpStatus: number, rawText: string): string {
  try {
    const parsed = JSON.parse(rawText);
    const msg = parsed.message || parsed.Message || parsed.error?.message || parsed.errorMessage;
    if (msg) return `Error ${httpStatus}: ${msg}`;
  } catch (e: any) { /* JSON parse fallback - expected for non-JSON responses */ }
  const clean = rawText.replace(/[{}"\\]/g, "").replace(/traceId:[^,]+,?/gi, "").replace(/errorCode:\d+,?/gi, "").trim();
  if (clean.length > 150) return `Error ${httpStatus}: ${clean.slice(0, 150)}...`;
  return `Error ${httpStatus}: ${clean || "Request failed"}`;
}

function generateUuid(): string {
  const hex = "0123456789abcdef";
  let uuid = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) uuid += "-";
    else if (i === 14) uuid += "4";
    else uuid += hex[Math.floor(Math.random() * 16)];
  }
  return uuid;
}

function orchBase(config: UiPathConfig): string {
  return metadataService.getServiceUrl("OR", config);
}

function headers(config: UiPathConfig, token: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (config.folderId) h["X-UIPATH-OrganizationUnitId"] = config.folderId;
  return h;
}

function parseOrchestratorResponse(text: string): { data: any; error: string | null } {
  try {
    const data = JSON.parse(text);
    if (data.errorCode || data.ErrorCode) {
      return { data, error: `${data.errorCode || data.ErrorCode}: ${data.message || data.Message || data.ErrorMessage || "Unknown error"}` };
    }
    if (data.error) {
      return { data, error: typeof data.error === "string" ? data.error : JSON.stringify(data.error) };
    }
    if (data.Response?.ErrorCode || data.Response?.errorCode) {
      const r = data.Response;
      return { data, error: `${r.ErrorCode || r.errorCode}: ${r.Message || r.message || "Nested error"}` };
    }
    if (data["odata.error"]) {
      const oe = data["odata.error"];
      return { data, error: `${oe.code || "ODataError"}: ${oe.message?.value || oe.message || "Unknown OData error"}` };
    }
    if (data.message && !data.Id && !data.id && !data.Key && !data.value) {
      if (typeof data.message === "string" && (data.message.toLowerCase().includes("error") || data.message.toLowerCase().includes("fail") || data.message.toLowerCase().includes("invalid") || data.message.toLowerCase().includes("not found"))) {
        return { data, error: data.message };
      }
    }
    return { data, error: null };
  } catch (e: any) {
    return { data: null, error: `Invalid JSON response: ${text.slice(0, 200)}` };
  }
}

/**
 * Validates a service probe response to ensure the service is genuinely available.
 * Returns true only if the response body is valid JSON with an expected structure.
 * Catches false positives from UiPath cloud gateway returning 200 for unregistered services.
 */
function isGenuineServiceResponse(responseText: string): { genuine: boolean; reason?: string } {
  if (!responseText || responseText.trim().length === 0) {
    return { genuine: false, reason: "Empty response body" };
  }
  const trimmed = responseText.trim();
  if (trimmed.startsWith("<!") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML") || trimmed.startsWith("<head")) {
    return { genuine: false, reason: "HTML response — gateway or error page, not a real service" };
  }
  try {
    const data = JSON.parse(trimmed);
    if (data.errorCode || data.ErrorCode) {
      return { genuine: false, reason: `Error in response: ${data.errorCode || data.ErrorCode}: ${data.message || data.Message || ""}` };
    }
    if (data["odata.error"]) {
      return { genuine: false, reason: `OData error: ${data["odata.error"].message?.value || data["odata.error"].code || ""}` };
    }
    if (typeof data.message === "string" && (data.message.includes("not onboarded") || data.message.includes("ServiceType"))) {
      return { genuine: false, reason: `Service not onboarded: ${data.message}` };
    }
    if (data.error && typeof data.error === "string") {
      return { genuine: false, reason: `Error: ${data.error}` };
    }
    if (data.error && typeof data.error === "object") {
      return { genuine: false, reason: `Error object: ${JSON.stringify(data.error).slice(0, 200)}` };
    }
    if (Array.isArray(data.value) || Array.isArray(data.items) || Array.isArray(data) || data.Id || data.id || data.totalCount !== undefined || data["@odata.count"] !== undefined) {
      return { genuine: true };
    }
    if (typeof data === "object" && Object.keys(data).length === 0) {
      return { genuine: false, reason: "Empty JSON object — service may not be available" };
    }
    return { genuine: true };
  } catch (e: any) {
    return { genuine: false, reason: `Non-JSON response: ${trimmed.slice(0, 100)}` };
  }
}

/**
 * Validates that a creation response actually represents a successfully created resource.
 * Checks for valid ID, hidden error codes, and ensures the response isn't a gateway artifact.
 */
function validateCreationResponse(responseText: string): { valid: boolean; data: any; error?: string } {
  try {
    const data = JSON.parse(responseText);
    if (data.errorCode || data.ErrorCode) {
      return { valid: false, data, error: `Hidden error: ${data.errorCode || data.ErrorCode}: ${data.message || data.Message || ""}` };
    }
    if (data["odata.error"]) {
      return { valid: false, data, error: `OData error in 200 response: ${data["odata.error"].message?.value || ""}` };
    }
    if (data.Response?.ErrorCode || data.Response?.errorCode) {
      const r = data.Response;
      return { valid: false, data, error: `Nested error: ${r.ErrorCode || r.errorCode}: ${r.Message || r.message || ""}` };
    }
    if (data.error && typeof data.error === "string") {
      return { valid: false, data, error: data.error };
    }
    if (data.error && typeof data.error === "object") {
      return { valid: false, data, error: JSON.stringify(data.error).slice(0, 200) };
    }
    if (typeof data.message === "string" && (data.message.includes("not onboarded") || data.message.includes("not available"))) {
      return { valid: false, data, error: data.message };
    }
    if (!data.Id && !data.id && !data.Name && !data.name && !data.Key) {
      return { valid: false, data, error: "Response missing expected fields (Id, Name, Key) — creation may not have succeeded" };
    }
    return { valid: true, data };
  } catch (e: any) {
    return { valid: false, data: null, error: `Non-JSON creation response: ${responseText.slice(0, 200)}` };
  }
}

async function verifyArtifactExists(
  base: string, hdrs: Record<string, string>,
  endpoint: string, filterField: string, name: string, label: string,
  createdId?: number | null
): Promise<{ exists: boolean; id?: number; detail?: string }> {
  try {
    if (createdId) {
      const directUrl = `${base}/odata/${endpoint}(${createdId})`;
      const directRes = await fetch(directUrl, { headers: hdrs });
      if (directRes.ok) {
        const directData = await directRes.json();
        if (directData && (directData.Id || directData.id)) {
          console.log(`[UiPath Deploy] ${label} "${name}" verified by ID ${createdId}`);
          return { exists: true, id: directData.Id || directData.id };
        }
      }
    }

    const url = `${base}/odata/${endpoint}?$filter=${filterField} eq '${odataEscape(name)}'&$top=1`;
    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) {
      return { exists: false, detail: `Verification GET returned ${res.status}` };
    }
    const data = await res.json();
    const items = data.value || [];
    if (items.length > 0) {
      const item = items[0];
      console.log(`[UiPath Deploy] ${label} "${name}" verified by name filter (ID: ${item.Id || item.id})`);
      return { exists: true, id: item.Id || item.id };
    }
    return { exists: false, detail: `${label} "${name}" not found after creation — API may have silently rejected it` };
  } catch (err: any) {
    return { exists: false, detail: `Verification failed: ${err.message}` };
  }
}

async function verifyFolderAndRelease(
  base: string, hdrs: Record<string, string>,
  releaseId: number | null, folderId: string | undefined
): Promise<{ valid: boolean; releaseKey?: string; releaseName?: string; message?: string }> {
  if (folderId) {
    try {
      const folderRes = await fetch(`${base}/odata/Folders?$filter=Id eq ${folderId}&$top=1`, { headers: hdrs });
      if (folderRes.ok) {
        const folderData = await folderRes.json();
        if (!folderData.value?.length) {
          console.warn(`[UiPath Deploy] Folder ID ${folderId} not found via Folders API — may still work via OrganizationUnitId header`);
        } else {
          console.log(`[UiPath Deploy] Folder verified: ${folderData.value[0].DisplayName} (ID: ${folderId})`);
        }
      }
    } catch (e: any) { console.warn(`[UiPath Deploy] Folder/release verify failed (non-blocking): ${e.message}`); }
  }

  if (releaseId) {
    try {
      const relRes = await fetch(`${base}/odata/Releases(${releaseId})`, { headers: hdrs });
      if (relRes.ok) {
        const relData = await relRes.json();
        console.log(`[UiPath Deploy] Release verified: ${relData.Name} (ID: ${releaseId}, Key: ${relData.Key})`);
        return { valid: true, releaseKey: relData.Key, releaseName: relData.Name };
      } else {
        const text = await relRes.text();
        console.error(`[UiPath Deploy] Release ${releaseId} verification failed: ${relRes.status} — ${text.slice(0, 200)}`);
        return { valid: false, message: `Release ID ${releaseId} not accessible (HTTP ${relRes.status}). Triggers require a valid process release.` };
      }
    } catch (err: any) {
      return { valid: false, message: `Release verification error: ${err.message}` };
    }
  }

  return { valid: true };
}

async function provisionQueues(
  base: string, hdrs: Record<string, string>,
  queues: OrchestratorArtifacts["queues"]
): Promise<DeploymentResult[]> {
  if (!queues?.length) return [];
  const results: DeploymentResult[] = [];

  for (const q of queues) {
    try {
      const checkRes = await fetch(
        `${base}/odata/QueueDefinitions?$filter=Name eq '${odataEscape(q.name)}'&$top=1`,
        { headers: hdrs }
      );
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.value?.length > 0) {
          const existing = checkData.value[0];
          const existingId = existing.Id;

          const desiredDesc = truncDesc(q.description);
          const desiredMaxRetries = q.maxRetries ?? 3;
          const desiredUniqueRef = q.uniqueReference ?? false;
          let desiredJsonSchema: string | undefined;
          if (q.jsonSchema) {
            try { JSON.parse(q.jsonSchema); desiredJsonSchema = q.jsonSchema; } catch (e: any) { /* invalid JSON schema - skip */ }
          }
          let desiredOutputSchema: string | undefined;
          if (q.outputSchema) {
            try { JSON.parse(q.outputSchema); desiredOutputSchema = q.outputSchema; } catch (e: any) { /* invalid output schema - skip */ }
          }

          const needsUpdate =
            (desiredDesc && existing.Description !== desiredDesc) ||
            (existing.MaxNumberOfRetries !== desiredMaxRetries) ||
            (existing.EnforceUniqueReference !== desiredUniqueRef) ||
            (desiredJsonSchema && existing.SpecificDataJsonSchema !== desiredJsonSchema) ||
            (desiredOutputSchema && existing.OutputDataJsonSchema !== desiredOutputSchema);

          let shouldCreate = false;
          if (needsUpdate) {
            const updateBody: Record<string, any> = {
              Name: q.name,
              Description: desiredDesc || existing.Description,
              MaxNumberOfRetries: desiredMaxRetries,
              AcceptAutomaticallyRetry: existing.AcceptAutomaticallyRetry ?? true,
              EnforceUniqueReference: desiredUniqueRef,
            };
            if (desiredJsonSchema) updateBody.SpecificDataJsonSchema = desiredJsonSchema;
            if (desiredOutputSchema) updateBody.OutputDataJsonSchema = desiredOutputSchema;

            try {
              const putRes = await fetch(`${base}/odata/QueueDefinitions(${existingId})`, {
                method: "PUT",
                headers: hdrs,
                body: JSON.stringify(updateBody),
              });
              const putText = await putRes.text();
              console.log(`[UiPath Deploy] Queue "${q.name}" UPDATE -> ${putRes.status}: ${putText.slice(0, 500)}`);

              if (putRes.ok) {
                results.push({ artifact: "Queue", name: q.name, status: "updated", message: `Updated existing queue (ID: ${existingId})`, id: existingId });
              } else if (putRes.status === 404 || putText.toLowerCase().includes("does not exist")) {
                console.log(`[UiPath Deploy] Queue "${q.name}" PUT returned 404 (ID ${existingId} likely in different folder) — falling back to create in current folder`);
                shouldCreate = true;
              } else {
                results.push({ artifact: "Queue", name: q.name, status: "failed", message: `Update failed (ID: ${existingId}): ${sanitizeErrorMessage(putRes.status, putText)}`, id: existingId });
              }
            } catch (putErr: any) {
              results.push({ artifact: "Queue", name: q.name, status: "failed", message: `Update error (ID: ${existingId}): ${putErr.message}`, id: existingId });
            }
          } else {
            results.push({ artifact: "Queue", name: q.name, status: "exists", message: `Already exists (ID: ${existingId}) — no changes needed`, id: existingId });
          }
          if (!shouldCreate) continue;
        }
      }

      const body: Record<string, any> = {
        Name: q.name,
        Description: truncDesc(q.description),
        MaxNumberOfRetries: q.maxRetries ?? 3,
        AcceptAutomaticallyRetry: true,
        EnforceUniqueReference: q.uniqueReference ?? false,
      };
      if (q.jsonSchema) {
        try {
          JSON.parse(q.jsonSchema);
          body.SpecificDataJsonSchema = q.jsonSchema;
        } catch (e: any) {
          console.warn(`[UiPath Deploy] Queue "${q.name}" has invalid jsonSchema — skipping schema attachment`);
        }
      }
      if (q.outputSchema) {
        try {
          JSON.parse(q.outputSchema);
          body.OutputDataJsonSchema = q.outputSchema;
        } catch (e: any) {
          console.warn(`[UiPath Deploy] Queue "${q.name}" has invalid outputSchema — skipping`);
        }
      }

      const res = await fetch(`${base}/odata/QueueDefinitions`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      console.log(`[UiPath Deploy] Queue "${q.name}" -> ${res.status}: ${text.slice(0, 500)}`);

      if (res.ok || res.status === 201) {
        const parsed = parseOrchestratorResponse(text);
        if (parsed.error) {
          results.push({ artifact: "Queue", name: q.name, status: "failed", message: `API returned ${res.status} but body contains error: ${parsed.error}` });
          continue;
        }
        const verify = await verifyArtifactExists(base, hdrs, "QueueDefinitions", "Name", q.name, "Queue");
        if (verify.exists) {
          results.push({ artifact: "Queue", name: q.name, status: "created", message: `Created and verified (ID: ${verify.id})`, id: verify.id });
        } else {
          results.push({ artifact: "Queue", name: q.name, status: "failed", message: `API returned ${res.status} but verification failed. ${verify.detail || ""}` });
        }
      } else if (res.status === 409 || text.includes("already exists")) {
        results.push({ artifact: "Queue", name: q.name, status: "exists", message: "Already exists" });
      } else {
        results.push({ artifact: "Queue", name: q.name, status: "failed", message: sanitizeErrorMessage(res.status, text) });
      }
    } catch (err: any) {
      results.push({ artifact: "Queue", name: q.name, status: "failed", message: err.message });
    }
  }
  return results;
}

async function provisionAssets(
  base: string, hdrs: Record<string, string>,
  assets: OrchestratorArtifacts["assets"]
): Promise<DeploymentResult[]> {
  if (!assets?.length) return [];
  const results: DeploymentResult[] = [];

  for (const a of assets) {
    try {
      const checkRes = await fetch(
        `${base}/odata/Assets?$filter=Name eq '${odataEscape(a.name)}'&$top=1`,
        { headers: hdrs }
      );
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.value?.length > 0) {
          const existing = checkData.value[0];
          const existingId = existing.Id;
          const assetTypeLower = (a.type || "Text").toLowerCase();

          if (assetTypeLower === "credential") {
            results.push({ artifact: "Asset", name: a.name, status: "exists", message: `Already exists (ID: ${existingId}). Credential assets are not auto-updated for security — update manually in Orchestrator.`, id: existingId });
            continue;
          }

          const newDesc = truncDesc(a.description);
          let needsUpdate = false;
          const changes: string[] = [];

          if (newDesc && newDesc !== (existing.Description || "")) {
            needsUpdate = true;
            changes.push("Description");
          }

          if (assetTypeLower === "integer") {
            const newVal = parseInt(a.value || "0") || 0;
            if (newVal !== (existing.IntValue ?? 0)) {
              needsUpdate = true;
              changes.push(`IntValue: ${existing.IntValue ?? 0} -> ${newVal}`);
            }
          } else if (assetTypeLower === "bool" || assetTypeLower === "boolean") {
            const newVal = a.value === "true" || a.value === "True" || a.value === "1";
            if (newVal !== (existing.BoolValue ?? false)) {
              needsUpdate = true;
              changes.push(`BoolValue: ${existing.BoolValue ?? false} -> ${newVal}`);
            }
          } else {
            const newVal = a.value || "";
            if (newVal !== (existing.StringValue || "")) {
              needsUpdate = true;
              changes.push(`StringValue changed`);
            }
          }

          if (!needsUpdate) {
            results.push({ artifact: "Asset", name: a.name, status: "exists", message: `Already exists with same values (ID: ${existingId})`, id: existingId });
            continue;
          }

          const updateBody: Record<string, any> = {
            Name: a.name,
            ValueScope: existing.ValueScope || "Global",
            Description: newDesc || existing.Description || "",
          };

          if (assetTypeLower === "integer") {
            updateBody.ValueType = "Integer";
            updateBody.IntValue = parseInt(a.value || "0") || 0;
          } else if (assetTypeLower === "bool" || assetTypeLower === "boolean") {
            updateBody.ValueType = "Bool";
            updateBody.BoolValue = a.value === "true" || a.value === "True" || a.value === "1";
          } else {
            updateBody.ValueType = "Text";
            updateBody.StringValue = a.value || "";
          }

          const updateRes = await fetch(`${base}/odata/Assets(${existingId})`, { method: "PUT", headers: hdrs, body: JSON.stringify(updateBody) });
          const updateText = await updateRes.text();
          console.log(`[UiPath Deploy] Asset "${a.name}" UPDATE -> ${updateRes.status}: ${updateText.slice(0, 500)}`);

          let shouldCreateAsset = false;
          if (updateRes.ok) {
            results.push({ artifact: "Asset", name: a.name, status: "updated", message: `Updated (ID: ${existingId}). Changes: ${changes.join(", ")}`, id: existingId });
          } else if (updateRes.status === 404 || updateText.toLowerCase().includes("does not exist")) {
            console.log(`[UiPath Deploy] Asset "${a.name}" PUT returned 404 (ID ${existingId} likely in different folder) — falling back to create in current folder`);
            shouldCreateAsset = true;
          } else {
            results.push({ artifact: "Asset", name: a.name, status: "failed", message: `Update failed: ${sanitizeErrorMessage(updateRes.status, updateText)}`, id: existingId });
          }
          if (!shouldCreateAsset) continue;
        }
      }

      const assetType = (a.type || "Text").toLowerCase();
      const body: Record<string, any> = {
        Name: a.name,
        ValueScope: "Global",
        Description: truncDesc(a.description),
      };

      if (assetType === "credential") {
        body.ValueType = "Credential";
        body.CredentialUsername = a.value || "REPLACE_ME";
        body.CredentialPassword = "REPLACE_ME";
      } else if (assetType === "integer") {
        body.ValueType = "Integer";
        body.IntValue = parseInt(a.value || "0") || 0;
      } else if (assetType === "bool" || assetType === "boolean") {
        body.ValueType = "Bool";
        body.BoolValue = a.value === "true" || a.value === "True" || a.value === "1";
      } else {
        body.ValueType = "Text";
        body.StringValue = a.value || "";
      }

      const res = await fetch(`${base}/odata/Assets`, { method: "POST", headers: hdrs, body: JSON.stringify(body) });
      const text = await res.text();
      console.log(`[UiPath Deploy] Asset "${a.name}" (${body.ValueType}) -> ${res.status}: ${text.slice(0, 500)}`);

      if (res.ok || res.status === 201) {
        const parsed = parseOrchestratorResponse(text);
        if (parsed.error) {
          results.push({ artifact: "Asset", name: a.name, status: "failed", message: `API returned ${res.status} but body contains error: ${parsed.error}` });
          continue;
        }
        const verify = await verifyArtifactExists(base, hdrs, "Assets", "Name", a.name, "Asset");
        if (verify.exists) {
          const extra = assetType === "credential" ? ". UPDATE credentials in Orchestrator > Assets." : "";
          results.push({ artifact: "Asset", name: a.name, status: "created", message: `Created and verified (ID: ${verify.id}, Type: ${body.ValueType})${extra}`, id: verify.id });
        } else {
          results.push({ artifact: "Asset", name: a.name, status: "failed", message: `API returned ${res.status} but verification failed. ${verify.detail || ""}` });
        }
      } else if (res.status === 409 || text.includes("already exists")) {
        results.push({ artifact: "Asset", name: a.name, status: "exists", message: "Already exists" });
      } else {
        results.push({ artifact: "Asset", name: a.name, status: "failed", message: sanitizeErrorMessage(res.status, text) });
      }
    } catch (err: any) {
      results.push({ artifact: "Asset", name: a.name, status: "failed", message: err.message });
    }
  }
  return results;
}

async function assignMachineToFolder(
  base: string, hdrs: Record<string, string>, machineId: number
): Promise<{ success: boolean; message: string }> {
  const folderId = hdrs["X-UIPATH-OrganizationUnitId"];
  if (!folderId) return { success: false, message: "No folder ID configured — machine not assigned to folder" };

  const endpoints = [
    {
      url: `${base}/odata/Folders/UiPath.Server.Configuration.OData.AssignMachines`,
      body: { assignments: { MachineIds: [machineId], FolderId: parseInt(folderId, 10) } },
      label: "AssignMachines (modern)",
    },
    {
      url: `${base}/odata/Folders(${folderId})/UiPath.Server.Configuration.OData.AssignMachines`,
      body: { machineIds: [machineId] },
      label: "AssignMachines (legacy path)",
    },
    {
      url: `${base}/odata/Folders(${folderId})/UiPath.Server.Configuration.OData.AssignMachines`,
      body: { assignments: { MachineIds: [machineId] } },
      label: "AssignMachines (legacy with assignments wrapper)",
    },
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(ep.body),
      });
      if (res.ok || res.status === 204) {
        console.log(`[UiPath Deploy] Machine ${machineId} assigned to folder ${folderId} via ${ep.label}`);
        return { success: true, message: `Assigned to folder ${folderId}` };
      }
      const text = await res.text();
      if (text.includes("already") || res.status === 409) {
        return { success: true, message: `Already assigned to folder ${folderId}` };
      }
      console.log(`[UiPath Deploy] Machine folder assignment via ${ep.label} -> ${res.status}: ${text.slice(0, 200)}`);
    } catch (err: any) {
      console.warn(`[UiPath Deploy] Machine folder assignment via ${ep.label} error: ${err.message}`);
    }
  }
  return { success: false, message: `Folder assignment failed via all endpoint variants` };
}

async function provisionMachines(
  base: string, hdrs: Record<string, string>,
  machines: OrchestratorArtifacts["machines"]
): Promise<DeploymentResult[]> {
  if (!machines?.length) return [];
  const results: DeploymentResult[] = [];

  for (const m of machines) {
    try {
      let machineId: number | null = null;

      const checkRes = await fetch(
        `${base}/odata/Machines?$filter=Name eq '${odataEscape(m.name)}'&$top=1`,
        { headers: hdrs }
      );
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.value?.length > 0) {
          const existing = checkData.value[0];
          machineId = existing.Id;

          const runtime = (m.runtimeType || m.type || "Unattended").toLowerCase();
          const newDesc = truncDesc(m.description);
          const newSlots = m.slots || 1;

          let desiredSlotField = "UnattendedSlots";
          if (runtime.includes("headless") || runtime.includes("unattended")) {
            desiredSlotField = "UnattendedSlots";
          } else if (runtime.includes("testautomation")) {
            desiredSlotField = "TestAutomationSlots";
          } else if (runtime.includes("nonproduction")) {
            desiredSlotField = "NonProductionSlots";
          }

          const descChanged = (existing.Description || "") !== newDesc;
          const slotsChanged = (existing[desiredSlotField] || 0) !== newSlots;

          let shouldCreateMachine = false;
          if (descChanged || slotsChanged) {
            const updateBody: Record<string, any> = {
              Name: m.name,
              Description: newDesc,
            };
            if (desiredSlotField === "UnattendedSlots") updateBody.UnattendedSlots = newSlots;
            else if (desiredSlotField === "NonProductionSlots") updateBody.NonProductionSlots = newSlots;
            else if (desiredSlotField === "TestAutomationSlots") updateBody.TestAutomationSlots = newSlots;

            try {
              const putRes = await fetch(`${base}/odata/Machines(${machineId})`, {
                method: "PUT",
                headers: hdrs,
                body: JSON.stringify(updateBody),
              });
              const putText = await putRes.text();
              console.log(`[UiPath Deploy] Machine "${m.name}" PUT update -> ${putRes.status}: ${putText.slice(0, 300)}`);

              if (putRes.ok) {
                const changes: string[] = [];
                if (descChanged) changes.push("Description");
                if (slotsChanged) changes.push(`${desiredSlotField}: ${existing[desiredSlotField] || 0} → ${newSlots}`);
                const folderAssign = await assignMachineToFolder(base, hdrs, machineId!);
                const folderNote = folderAssign.success ? folderAssign.message : `Folder assignment note: ${folderAssign.message}`;
                results.push({ artifact: "Machine", name: m.name, status: "updated", message: `Updated (ID: ${machineId}). Changed: ${changes.join(", ")}. ${folderNote}`, id: machineId ?? undefined });
                continue;
              } else if (putRes.status === 404 || putText.toLowerCase().includes("does not exist")) {
                console.log(`[UiPath Deploy] Machine "${m.name}" PUT returned 404 (ID ${machineId} likely in different folder) — falling back to create in current folder`);
                shouldCreateMachine = true;
              } else if (putRes.status === 409) {
                console.log(`[UiPath Deploy] Machine "${m.name}" PUT returned 409 (immutable field conflict) — treating as exists`);
                const folderAssign = await assignMachineToFolder(base, hdrs, machineId!);
                const folderNote = folderAssign.success ? folderAssign.message : `Folder assignment note: ${folderAssign.message}`;
                results.push({ artifact: "Machine", name: m.name, status: "exists", message: `Already exists (ID: ${machineId}, update skipped — immutable field conflict). ${folderNote}`, id: machineId ?? undefined });
                continue;
              } else {
                console.warn(`[UiPath Deploy] Machine "${m.name}" update failed (${putRes.status})`);
                results.push({ artifact: "Machine", name: m.name, status: "failed", message: `Update failed (ID: ${machineId}, ${putRes.status}): ${putText.slice(0, 200)}`, id: machineId ?? undefined });
                continue;
              }
            } catch (putErr: any) {
              console.warn(`[UiPath Deploy] Machine "${m.name}" update error: ${putErr.message}`);
              results.push({ artifact: "Machine", name: m.name, status: "failed", message: `Update error (ID: ${machineId}): ${putErr.message}`, id: machineId ?? undefined });
              continue;
            }
          }

          if (!shouldCreateMachine) {
            const folderAssign = await assignMachineToFolder(base, hdrs, machineId!);
            const folderNote = folderAssign.success
              ? folderAssign.message
              : `Not in current folder — assign manually: Orchestrator > Folder Settings > Machines. ${folderAssign.message}`;
            results.push({ artifact: "Machine", name: m.name, status: "exists", message: `Already exists at tenant level (ID: ${machineId}). ${folderNote}`, id: machineId ?? undefined });
            continue;
          }
        }
      }

      const machineType = (m.type || "Unattended").toLowerCase();
      const runtime = (m.runtimeType || m.type || "Unattended").toLowerCase();
      const body: Record<string, any> = {
        Name: m.name,
        Description: truncDesc(m.description),
        Type: "Template",
      };

      if (runtime.includes("headless") || runtime.includes("unattended")) {
        body.UnattendedSlots = m.slots || 1;
      } else if (runtime.includes("testautomation") || runtime.includes("nonproduction")) {
        body.NonProductionSlots = m.slots || 1;
      } else if (machineType.includes("unattended")) {
        body.UnattendedSlots = m.slots || 1;
      } else if (machineType.includes("attended")) {
        body.NonProductionSlots = 0;
      } else if (machineType.includes("development")) {
        body.NonProductionSlots = m.slots || 1;
      }

      const res = await fetch(`${base}/odata/Machines`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      console.log(`[UiPath Deploy] Machine "${m.name}" -> ${res.status}: ${text.slice(0, 500)}`);

      if (res.ok || res.status === 201) {
        const parsed = parseOrchestratorResponse(text);
        if (parsed.error) {
          results.push({ artifact: "Machine", name: m.name, status: "failed", message: `API returned ${res.status} but body contains error: ${parsed.error}` });
          continue;
        }
        const verify = await verifyArtifactExists(base, hdrs, "Machines", "Name", m.name, "Machine");
        if (verify.exists) {
          machineId = verify.id ? Number(verify.id) : null;
          let folderMsg = "";
          let folderOk = true;
          if (machineId) {
            const folderAssign = await assignMachineToFolder(base, hdrs, machineId);
            folderOk = folderAssign.success;
            folderMsg = folderAssign.success
              ? ` ${folderAssign.message}`
              : ` WARNING: Not assigned to folder — assign manually: Orchestrator > Folder Settings > Machines. ${folderAssign.message}`;
          }
          results.push({ artifact: "Machine", name: m.name, status: "created", message: `Created and verified (ID: ${verify.id}, Type: Template).${folderMsg}`, id: verify.id });
        } else {
          results.push({ artifact: "Machine", name: m.name, status: "failed", message: `API returned ${res.status} but verification failed. ${verify.detail || ""}` });
        }
      } else if (res.status === 409 || text.includes("already exists")) {
        results.push({ artifact: "Machine", name: m.name, status: "exists", message: "Already exists" });
      } else {
        results.push({ artifact: "Machine", name: m.name, status: "failed", message: sanitizeErrorMessage(res.status, text) });
      }
    } catch (err: any) {
      results.push({ artifact: "Machine", name: m.name, status: "failed", message: err.message });
    }
  }

  return results;
}

async function provisionStorageBuckets(
  base: string, hdrs: Record<string, string>,
  buckets: OrchestratorArtifacts["storageBuckets"]
): Promise<DeploymentResult[]> {
  if (!buckets?.length) return [];
  const results: DeploymentResult[] = [];

  for (const b of buckets) {
    try {
      const checkRes = await fetch(
        `${base}/odata/Buckets?$filter=Name eq '${odataEscape(b.name)}'&$top=1`,
        { headers: hdrs }
      );
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.value?.length > 0) {
          const existing = checkData.value[0];
          const existingId = existing.Id;
          const newDesc = truncDesc(b.description);
          const descChanged = (existing.Description || "") !== newDesc;

          let shouldCreateBucket = false;
          if (descChanged) {
            try {
              const updateBody: Record<string, any> = {
                Name: b.name,
                Description: newDesc,
              };
              if (existing.StorageProvider) updateBody.StorageProvider = existing.StorageProvider;
              if (existing.ContentType) updateBody.ContentType = existing.ContentType;
              if (existing.ConcurrencyStamp) updateBody.ConcurrencyStamp = existing.ConcurrencyStamp;

              const putRes = await fetch(`${base}/odata/Buckets(${existingId})`, {
                method: "PUT",
                headers: hdrs,
                body: JSON.stringify(updateBody),
              });
              const putText = await putRes.text();
              console.log(`[UiPath Deploy] Bucket "${b.name}" PUT update -> ${putRes.status}: ${putText.slice(0, 300)}`);

              if (putRes.ok) {
                results.push({ artifact: "Storage Bucket", name: b.name, status: "updated", message: `Updated Description (ID: ${existingId})`, id: existingId });
                continue;
              } else if (putRes.status === 404 || putText.toLowerCase().includes("does not exist")) {
                console.log(`[UiPath Deploy] Bucket "${b.name}" PUT returned 404 (ID ${existingId} likely in different folder) — falling back to create in current folder`);
                shouldCreateBucket = true;
              } else if (putRes.status === 409) {
                console.log(`[UiPath Deploy] Bucket "${b.name}" PUT returned 409 (immutable field conflict) — treating as exists`);
                results.push({ artifact: "Storage Bucket", name: b.name, status: "exists", message: `Already exists (ID: ${existingId}, update skipped — immutable field conflict)`, id: existingId });
                continue;
              } else {
                console.warn(`[UiPath Deploy] Bucket "${b.name}" update failed (${putRes.status})`);
                results.push({ artifact: "Storage Bucket", name: b.name, status: "failed", message: `Update failed (ID: ${existingId}, ${putRes.status}): ${putText.slice(0, 200)}`, id: existingId });
                continue;
              }
            } catch (putErr: any) {
              console.warn(`[UiPath Deploy] Bucket "${b.name}" update error: ${putErr.message}`);
              results.push({ artifact: "Storage Bucket", name: b.name, status: "failed", message: `Update error (ID: ${existingId}): ${putErr.message}`, id: existingId });
              continue;
            }
          }

          if (!shouldCreateBucket) {
            results.push({ artifact: "Storage Bucket", name: b.name, status: "exists", message: `Already exists (ID: ${existingId})`, id: existingId });
            continue;
          }
        }
      }

      const preferredProvider = b.storageProvider || "Orchestrator";
      const providerOrder = [preferredProvider, ...(["Orchestrator", "Minio"].filter(p => p !== preferredProvider))];
      const bodyVariants = [
        ...providerOrder.map(provider => ({
          Name: b.name,
          Identifier: generateUuid(),
          Description: truncDesc(b.description),
          StorageProvider: provider,
        })),
        {
          Name: b.name,
          Identifier: generateUuid(),
          Description: truncDesc(b.description),
        },
      ];

      let bucketCreated = false;

      for (const body of bodyVariants) {
        const providerLabel = (body as any).StorageProvider || "default (Orchestrator built-in)";
        const res = await fetch(`${base}/odata/Buckets`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[UiPath Deploy] Bucket "${b.name}" (StorageProvider=${providerLabel}) -> ${res.status}: ${text.slice(0, 300)}`);

        if (res.ok || res.status === 201) {
          const parsed = parseOrchestratorResponse(text);
          if (parsed.error) {
            if (text.includes("StorageProvider") || text.includes("Provider") || text.includes("Identifier")) {
              continue;
            }
            results.push({ artifact: "Storage Bucket", name: b.name, status: "failed", message: `API returned ${res.status} but body contains error: ${parsed.error}` });
            bucketCreated = true;
            break;
          }
          const verify = await verifyArtifactExists(base, hdrs, "Buckets", "Name", b.name, "Storage Bucket");
          if (verify.exists) {
            results.push({ artifact: "Storage Bucket", name: b.name, status: "created", message: `Created and verified (ID: ${verify.id}, Provider: ${providerLabel})`, id: verify.id });
          } else {
            results.push({ artifact: "Storage Bucket", name: b.name, status: "failed", message: `API returned ${res.status} but verification failed. ${verify.detail || ""}` });
          }
          bucketCreated = true;
          break;
        } else if (res.status === 409 || text.includes("already exists")) {
          results.push({ artifact: "Storage Bucket", name: b.name, status: "exists", message: "Already exists" });
          bucketCreated = true;
          break;
        } else if (text.includes("StorageProvider") || text.includes("Provider") || text.includes("Identifier")) {
          continue;
        } else {
          continue;
        }
      }
      if (!bucketCreated) {
        results.push({ artifact: "Storage Bucket", name: b.name, status: "failed", message: `All body variants rejected. Check API permissions for Storage Buckets.` });
      }
    } catch (err: any) {
      results.push({ artifact: "Storage Bucket", name: b.name, status: "failed", message: err.message });
    }
  }
  return results;
}

type RuntimeDetectionResult = {
  runtimeType: string;
  verified: boolean;
  hasUnattendedSlots: boolean;
  hasServerless: boolean;
  availableTypes: string[];
  warning?: string;
};

type PreFetchedInfraData = {
  machines: InfraProbeResult['machines'];
  sessions: InfraProbeResult['sessions'];
  robots: InfraProbeResult['robots'];
};

export async function detectAvailableRuntimeType(base: string, hdrs: Record<string, string>, prefetched?: PreFetchedInfraData): Promise<RuntimeDetectionResult> {
  const result: RuntimeDetectionResult = {
    runtimeType: "Unattended",
    verified: false,
    hasUnattendedSlots: false,
    hasServerless: false,
    availableTypes: [],
  };

  let hasNonProd = false;

  try {
    let machines: any[];
    if (prefetched) {
      machines = prefetched.machines;
    } else {
      const machRes = await fetch(`${base}/odata/Machines?$top=50&$select=Id,Name,Type,UnattendedSlots,NonProductionSlots,TestAutomationSlots,HeadlessSlots`, { headers: hdrs });
      if (!machRes.ok) { machines = []; } else {
        const machData = await machRes.json();
        machines = machData.value || [];
      }
    }
    if (machines.length > 0) {
      const hasUnattended = machines.some((m: any) => (m.UnattendedSlots || m.unattendedSlots || 0) > 0);
      hasNonProd = machines.some((m: any) => (m.NonProductionSlots || m.nonProdSlots || 0) > 0);
      const hasTestAuto = machines.some((m: any) => (m.TestAutomationSlots || m.testAutomationSlots || 0) > 0);
      const hasHeadless = machines.some((m: any) => (m.HeadlessSlots || m.headlessSlots || 0) > 0);

      result.hasUnattendedSlots = hasUnattended;
      if (hasUnattended) result.availableTypes.push("Unattended");
      if (hasNonProd) result.availableTypes.push("NonProduction");
      if (hasTestAuto) result.availableTypes.push("TestAutomation");
      if (hasHeadless) result.availableTypes.push("Headless");

      if (hasUnattended) {
        result.runtimeType = "Unattended";
        result.verified = true;
        console.log(`[UiPath Deploy] Runtime detection: Found ${machines.length} machine template(s) with Unattended slots`);
      } else if (hasNonProd) {
        result.runtimeType = "NonProduction";
        result.verified = true;
        console.log(`[UiPath Deploy] Runtime detection: No Unattended slots, found NonProduction`);
      } else {
        console.warn(`[UiPath Deploy] Runtime detection: ${machines.length} machine template(s) found but NONE have Unattended or NonProduction slots`);
        result.warning = `${machines.length} machine template(s) found in folder but none have Unattended runtime slots configured. Triggers will fail until an Unattended runtime is assigned to a machine template in this folder.`;
      }
    } else {
      console.warn(`[UiPath Deploy] Runtime detection: No machine templates found in folder`);
      result.warning = "No machine templates found in this folder. Triggers require at least one machine template with Unattended runtime slots.";
    }
  } catch (err: any) {
    console.warn(`[UiPath Deploy] Machine template check failed: ${err.message}`);
  }

  try {
    let sessionValues: any[];
    if (prefetched) {
      sessionValues = prefetched.sessions;
    } else {
      const sessRes = await fetch(`${base}/odata/Sessions?$top=10&$select=RuntimeType,MachineId,MachineName`, { headers: hdrs });
      if (!sessRes.ok) { sessionValues = []; } else {
        const sessData = await sessRes.json();
        sessionValues = sessData.value || [];
      }
    }
    if (sessionValues.length > 0) {
      const types = sessionValues.map((s: any) => s.RuntimeType || s.runtimeType).filter(Boolean);
      const uniqueTypes = Array.from(new Set(types as string[]));
      result.availableTypes = Array.from(new Set([...result.availableTypes, ...uniqueTypes]));

      if (types.includes("Serverless")) {
        result.hasServerless = true;
        console.log(`[UiPath Deploy] Runtime detection: Found Serverless session(s)`);
      }

      if (types.includes("Unattended")) {
        result.hasUnattendedSlots = true;
        if (!result.verified || result.runtimeType !== "Unattended") {
          result.runtimeType = "Unattended";
          result.verified = true;
          result.warning = undefined;
        }
        console.log(`[UiPath Deploy] Runtime detection: Found active Unattended session(s)`);
      }
      if (types.includes("Production") && !result.verified) {
        result.runtimeType = "Production";
        result.verified = true;
        result.warning = undefined;
      }
    }
  } catch (e: any) { console.warn(`[UiPath Deploy] Machine template check failed: ${e.message}`); }

  try {
    let robotValues: any[];
    if (prefetched) {
      robotValues = prefetched.robots;
    } else {
      const robotRes = await fetch(`${base}/odata/Robots?$top=10&$select=Type,MachineName`, { headers: hdrs });
      if (!robotRes.ok) { robotValues = []; } else {
        const robotData = await robotRes.json();
        robotValues = robotData.value || [];
      }
    }
    if (robotValues.length > 0) {
      const types = robotValues.map((r: any) => r.Type || r.type).filter(Boolean);
      const uniqueTypes = Array.from(new Set(types as string[]));
      result.availableTypes = Array.from(new Set([...result.availableTypes, ...uniqueTypes]));

      if (types.includes("Serverless") || types.includes("ServerlessRuntime")) {
        result.hasServerless = true;
        console.log(`[UiPath Deploy] Runtime detection: Found Serverless robot(s)`);
      }

      if (types.includes("Unattended")) {
        result.hasUnattendedSlots = true;
        if (!result.verified || result.runtimeType !== "Unattended") {
          result.runtimeType = "Unattended";
          result.verified = true;
          result.warning = undefined;
        }
      }
    }
  } catch (e: any) { console.warn(`[UiPath Deploy] Robot enumeration check failed: ${e.message}`); }

  if (result.hasServerless && result.hasUnattendedSlots) {
    result.runtimeType = "Unattended";
    result.verified = true;
    result.warning = undefined;
    console.log(`[UiPath Deploy] Runtime detection: Both Serverless and Unattended available — defaulting to Unattended (caller may override)`);
  } else if (result.hasServerless && !result.hasUnattendedSlots) {
    result.runtimeType = "Serverless";
    result.verified = true;
    result.warning = undefined;
    console.log(`[UiPath Deploy] Runtime detection: Serverless available, no Unattended slots — using Serverless`);
  } else if (!result.verified && !result.hasUnattendedSlots && !result.hasServerless) {
    if (hasNonProd) {
      result.runtimeType = "NonProduction";
      result.verified = true;
    } else if (result.availableTypes.length > 0) {
      result.runtimeType = result.availableTypes[0];
      result.verified = true;
      if (!result.warning) {
        result.warning = `No Unattended or Serverless runtime found. Using "${result.availableTypes[0]}" runtime. Triggers may fail if this runtime type cannot execute scheduled jobs.`;
      }
    }
  }

  if (!result.verified) {
    result.warning = result.warning || "Could not detect any runtime types in this folder. No machine templates, active sessions, or robots were found. Triggers will be created DISABLED — enable them after configuring an Unattended runtime in Orchestrator > Folder > Machine Templates.";
  }

  return result;
}

async function provisionTriggers(
  base: string, hdrs: Record<string, string>,
  triggers: OrchestratorArtifacts["triggers"],
  releaseId: number | null,
  releaseKey: string | null,
  releaseName: string | null,
  queueResults: DeploymentResult[],
  precomputedRuntime?: RuntimeDetectionResult
): Promise<DeploymentResult[]> {
  if (!triggers?.length) return [];
  if (!releaseId) {
    return triggers.map(t => ({
      artifact: "Trigger",
      name: t.name,
      status: "failed" as const,
      message: "No valid Process (Release) found — trigger requires a release to be linked to. Retry deployment after process creation succeeds.",
    }));
  }

  const runtimeDetection = precomputedRuntime || await detectAvailableRuntimeType(base, hdrs);
  const runtimeType = runtimeDetection.runtimeType;
  const createDisabled = !runtimeDetection.verified || (!runtimeDetection.hasUnattendedSlots && !runtimeDetection.hasServerless);
  console.log(`[UiPath Deploy] Using RuntimeType: ${runtimeType}, verified: ${runtimeDetection.verified}, hasUnattendedSlots: ${runtimeDetection.hasUnattendedSlots}, hasServerless: ${runtimeDetection.hasServerless}, createDisabled: ${createDisabled}`);
  if (runtimeDetection.warning) {
    console.warn(`[UiPath Deploy] Runtime warning: ${runtimeDetection.warning}`);
  }

  const results: DeploymentResult[] = [];

  for (const t of triggers) {
    try {
      const triggerType = (t.type || "Time").toLowerCase();

      if (triggerType === "queue") {
        let alreadyExists = false;
        const checkRes = await fetch(
          `${base}/odata/QueueTriggers?$filter=Name eq '${odataEscape(t.name)}'&$top=1`,
          { headers: hdrs }
        );
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          if (checkData.value?.length > 0) {
            const existing = checkData.value[0];
            const existingId = existing.Id;
            const updateBody: Record<string, any> = {};
            let changed = false;
            const desiredJobsCount = (t.maxJobsCount && t.maxJobsCount > 0) ? t.maxJobsCount : 1;
            if (existing.JobsCount !== desiredJobsCount) { updateBody.JobsCount = desiredJobsCount; changed = true; }
            if (existing.MinNumberOfItems !== undefined && existing.MinNumberOfItems !== 1) { updateBody.MinNumberOfItems = 1; changed = true; }
            if (existing.MaxNumberOfItems !== undefined && existing.MaxNumberOfItems !== 100) { updateBody.MaxNumberOfItems = 100; changed = true; }
            if (existing.RuntimeType !== runtimeType) { updateBody.RuntimeType = runtimeType; changed = true; }
            const desiredEnabled = !createDisabled;
            if (existing.Enabled !== desiredEnabled) { updateBody.Enabled = desiredEnabled; changed = true; }
            let triggerShouldCreate = false;
            if (changed) {
              try {
                const putRes = await fetch(`${base}/odata/QueueTriggers(${existingId})`, {
                  method: "PUT",
                  headers: hdrs,
                  body: JSON.stringify({ ...existing, ...updateBody }),
                });
                const putText = await putRes.text();
                console.log(`[UiPath Deploy] Queue Trigger "${t.name}" update -> ${putRes.status}: ${putText}`);
                if (putRes.ok) {
                  const changedFields = Object.keys(updateBody).join(", ");
                  results.push({ artifact: "Trigger", name: t.name, status: "updated", message: `Updated (ID: ${existingId}). Changed: ${changedFields}`, id: existingId });
                } else if (putRes.status === 404 || putText.toLowerCase().includes("does not exist")) {
                  console.log(`[UiPath Deploy] Queue Trigger "${t.name}" PUT returned 404 (ID ${existingId} likely in different folder) — falling back to create in current folder`);
                  triggerShouldCreate = true;
                } else {
                  results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Update failed (ID: ${existingId}, ${putRes.status}): ${putText.slice(0, 200)}`, id: existingId });
                }
              } catch (upErr: any) {
                results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Update error (ID: ${existingId}): ${upErr.message}`, id: existingId });
              }
            } else {
              results.push({ artifact: "Trigger", name: t.name, status: "exists", message: `Already exists (ID: ${existingId}), no changes needed`, id: existingId });
            }
            if (!triggerShouldCreate) alreadyExists = true;
          }
        }
        if (!alreadyExists && (checkRes.status === 404 || checkRes.status === 405 || !checkRes.ok)) {
          const schedCheckRes = await fetch(
            `${base}/odata/ProcessSchedules?$filter=Name eq '${odataEscape(t.name)}'&$top=1`,
            { headers: hdrs }
          );
          if (schedCheckRes.ok) {
            const schedCheckData = await schedCheckRes.json();
            if (schedCheckData.value?.length > 0) {
              const existingSched = schedCheckData.value[0];
              const existingSchedId = existingSched.Id;
              const schedUpdateBody: Record<string, any> = {};
              let schedChanged = false;
              const desiredSchedJobsCount = (t.maxJobsCount && t.maxJobsCount > 0) ? t.maxJobsCount : 1;
              if (existingSched.JobsCount !== undefined && existingSched.JobsCount !== desiredSchedJobsCount) { schedUpdateBody.JobsCount = desiredSchedJobsCount; schedChanged = true; }
              if (existingSched.RuntimeType !== runtimeType) { schedUpdateBody.RuntimeType = runtimeType; schedChanged = true; }
              const desiredSchedEnabled = !createDisabled;
              if (existingSched.Enabled !== desiredSchedEnabled) { schedUpdateBody.Enabled = desiredSchedEnabled; schedChanged = true; }
              let schedShouldCreate = false;
              if (schedChanged) {
                try {
                  const putRes = await fetch(`${base}/odata/ProcessSchedules(${existingSchedId})`, {
                    method: "PUT",
                    headers: hdrs,
                    body: JSON.stringify({ ...existingSched, ...schedUpdateBody }),
                  });
                  const putText = await putRes.text();
                  console.log(`[UiPath Deploy] Queue Trigger (polling) "${t.name}" update -> ${putRes.status}: ${putText}`);
                  if (putRes.ok) {
                    const changedFields = Object.keys(schedUpdateBody).join(", ");
                    results.push({ artifact: "Trigger", name: t.name, status: "updated", message: `Updated queue-polling trigger (ID: ${existingSchedId}). Changed: ${changedFields}. Native queue triggers not available — polling every 5 min.`, id: existingSchedId });
                  } else if (putRes.status === 404 || putText.toLowerCase().includes("does not exist")) {
                    console.log(`[UiPath Deploy] ProcessSchedule "${t.name}" PUT returned 404 (ID ${existingSchedId} likely in different folder) — falling back to create in current folder`);
                    schedShouldCreate = true;
                  } else {
                    results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Queue-polling trigger update failed (ID: ${existingSchedId}, ${putRes.status}): ${putText.slice(0, 200)}`, id: existingSchedId });
                  }
                } catch (upErr: any) {
                  results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Queue-polling trigger update error (ID: ${existingSchedId}): ${upErr.message}`, id: existingSchedId });
                }
              } else {
                results.push({ artifact: "Trigger", name: t.name, status: "exists", message: `Already exists as queue-polling trigger (ID: ${existingSchedId}), no changes needed. Native queue triggers not available — polling every 5 min.`, id: existingSchedId });
              }
              if (!schedShouldCreate) alreadyExists = true;
            }
          }
        }
        if (alreadyExists) continue;

        let queueId: number | string | null = null;
        const qr = queueResults.find(q => q.name === t.queueName);
        if (qr?.id) {
          queueId = qr.id;
        } else if (t.queueName) {
          const qRes = await fetch(
            `${base}/odata/QueueDefinitions?$filter=Name eq '${odataEscape(t.queueName || '')}'&$top=1`,
            { headers: hdrs }
          );
          if (qRes.ok) {
            const qData = await qRes.json();
            if (qData.value?.length > 0) queueId = qData.value[0].Id;
          }
        }

        if (!queueId) {
          results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Queue "${t.queueName}" not found in Orchestrator. Ensure queue was created successfully before trigger can be linked.` });
          continue;
        }

        const body: Record<string, any> = {
          Name: t.name,
          Enabled: !createDisabled,
          ReleaseId: releaseId,
          ReleaseName: releaseName || "",
          QueueDefinitionId: queueId,
          MinNumberOfItems: 1,
          MaxNumberOfItems: 100,
          JobsCount: (t.maxJobsCount && t.maxJobsCount > 0) ? t.maxJobsCount : 1,
          RuntimeType: runtimeType,
          InputArguments: "{}",
        };

        console.log(`[UiPath Deploy] Queue Trigger "${t.name}" payload: ${JSON.stringify(body)}`);

        const res = await fetch(`${base}/odata/QueueTriggers`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[UiPath Deploy] Queue Trigger "${t.name}" -> ${res.status}: ${text}`);

        if (res.ok || res.status === 201) {
          const parsed = parseOrchestratorResponse(text);
          if (parsed.error) {
            results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `API returned ${res.status} but body contains error: ${parsed.error}` });
            continue;
          }
          const returnedId = parsed.data?.Id || parsed.data?.id;
          const verify = await verifyArtifactExists(base, hdrs, "QueueTriggers", "Name", t.name, "Queue Trigger", returnedId);
          if (verify.exists) {
            const disabledNote = createDisabled ? ` [CREATED DISABLED — ${runtimeDetection.warning || "No Unattended runtime verified"}. Enable in Orchestrator after configuring runtimes.]` : "";
            results.push({ artifact: "Trigger", name: t.name, status: "created", message: `Queue trigger created and verified (ID: ${verify.id}), linked to queue "${t.queueName}"${disabledNote}`, id: verify.id });
          } else {
            results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `API returned ${res.status} with ID ${returnedId} but verification failed — trigger not found in Orchestrator. ${verify.detail || ""}. Response: ${text.slice(0, 300)}` });
          }
        } else if (res.status === 409 || text.includes("already exists")) {
          results.push({ artifact: "Trigger", name: t.name, status: "exists", message: "Already exists" });
        } else if (res.status === 404 || res.status === 405) {
          const triggerTz = t.timezone || "UTC";
          const triggerTzIana = triggerTz === "UTC" ? "Etc/UTC" : triggerTz;
          const fallbackStrategy = t.startStrategy === "ModernJobs" ? 0 : 15;
          console.log(`[UiPath Deploy] Queue Trigger "${t.name}" — native QueueTrigger unavailable (${res.status}), falling back to polling ProcessSchedule every 5 minutes`);
          const schedBody: Record<string, any> = {
            Enabled: !createDisabled,
            Name: t.name,
            ReleaseId: releaseId,
            ReleaseName: releaseName || "",
            StartProcessCron: "0 */5 * ? * *",
            StartProcessCronDetails: JSON.stringify({ type: 5, minutely: {}, hourly: {}, daily: {}, weekly: { weekdays: [] }, monthly: { weekdays: [] }, advancedCronExpression: "0 */5 * ? * *" }),
            StartProcessCronSummary: `Queue polling for ${t.queueName} (fallback from native queue trigger)`,
            TimeZoneId: triggerTz,
            TimeZoneIana: triggerTzIana,
            StartStrategy: fallbackStrategy,
            RuntimeType: runtimeType,
            InputArguments: JSON.stringify({ QueueName: t.queueName }),
          };
          if (t.maxJobsCount && t.maxJobsCount > 0) {
            schedBody.JobsCount = t.maxJobsCount;
          }
          const schedRes = await fetch(`${base}/odata/ProcessSchedules`, { method: "POST", headers: hdrs, body: JSON.stringify(schedBody) });
          const schedText = await schedRes.text();
          console.log(`[UiPath Deploy] Queue Trigger "${t.name}" fallback to ProcessSchedule -> ${schedRes.status}: ${schedText}`);
          if (schedRes.ok || schedRes.status === 201) {
            const parsed = parseOrchestratorResponse(schedText);
            if (parsed.error) {
              results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `ProcessSchedule fallback API returned ${schedRes.status} but body contains error: ${parsed.error}` });
              continue;
            }
            const schedReturnedId = parsed.data?.Id || parsed.data?.id;
            const verify = await verifyArtifactExists(base, hdrs, "ProcessSchedules", "Name", t.name, "Scheduled Trigger", schedReturnedId);
            if (verify.exists) {
              const disabledNote = createDisabled ? ` [CREATED DISABLED — ${runtimeDetection.warning || "No Unattended runtime verified"}. Enable after configuring runtimes.]` : "";
              results.push({ artifact: "Trigger", name: t.name, status: "created", message: `Created as queue-polling trigger (ID: ${verify.id}). Native queue triggers are not available on this tenant — polling "${t.queueName}" every 5 min instead.${disabledNote}`, id: verify.id });
            } else {
              results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `ProcessSchedule fallback returned ${schedRes.status} but verification failed — trigger not found. ${verify.detail || ""}` });
            }
          } else if (schedRes.status === 409 || schedText.includes("already exists")) {
            results.push({ artifact: "Trigger", name: t.name, status: "exists", message: "Already exists as queue-polling trigger. Native queue triggers are not available on this tenant — polling every 5 min instead." });
          } else {
            results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Trigger creation failed — QueueTriggers returned ${res.status}, ProcessSchedules returned ${schedRes.status}: ${schedText.slice(0, 200)}` });
          }
        } else {
          results.push({ artifact: "Trigger", name: t.name, status: "failed", message: sanitizeErrorMessage(res.status, text) });
        }
      } else {
        const cron = sanitizeCronExpression(t.cron || "0 0 9 ? * MON-FRI *");
        const timeTz = t.timezone || "UTC";
        const timeTzIana = timeTz === "UTC" ? "Etc/UTC" : timeTz;

        const checkRes = await fetch(
          `${base}/odata/ProcessSchedules?$filter=Name eq '${odataEscape(t.name)}'&$top=1`,
          { headers: hdrs }
        );
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          if (checkData.value?.length > 0) {
            const existingTime = checkData.value[0];
            const existingTimeId = existingTime.Id;
            const timeUpdateBody: Record<string, any> = {};
            let timeChanged = false;
            if (existingTime.StartProcessCron !== cron) { timeUpdateBody.StartProcessCron = cron; timeChanged = true; }
            if (existingTime.RuntimeType !== runtimeType) { timeUpdateBody.RuntimeType = runtimeType; timeChanged = true; }
            if (existingTime.TimeZoneId !== timeTz) { timeUpdateBody.TimeZoneId = timeTz; timeUpdateBody.TimeZoneIana = timeTzIana; timeChanged = true; }
            const desiredTimeJobsCount = (t.maxJobsCount && t.maxJobsCount > 0) ? t.maxJobsCount : undefined;
            if (desiredTimeJobsCount !== undefined && existingTime.JobsCount !== desiredTimeJobsCount) { timeUpdateBody.JobsCount = desiredTimeJobsCount; timeChanged = true; }
            const desiredTimeEnabled = !createDisabled;
            if (existingTime.Enabled !== desiredTimeEnabled) { timeUpdateBody.Enabled = desiredTimeEnabled; timeChanged = true; }
            let timeShouldCreate = false;
            if (timeChanged) {
              if (timeUpdateBody.StartProcessCron) {
                timeUpdateBody.StartProcessCronDetails = JSON.stringify({
                  type: 5, minutely: {}, hourly: {}, daily: {}, weekly: { weekdays: [] }, monthly: { weekdays: [] },
                  advancedCronExpression: timeUpdateBody.StartProcessCron,
                });
              }
              try {
                const putRes = await fetch(`${base}/odata/ProcessSchedules(${existingTimeId})`, {
                  method: "PUT",
                  headers: hdrs,
                  body: JSON.stringify({ ...existingTime, ...timeUpdateBody }),
                });
                const putText = await putRes.text();
                console.log(`[UiPath Deploy] Time Trigger "${t.name}" update -> ${putRes.status}: ${putText}`);
                if (putRes.ok) {
                  const changedFields = Object.keys(timeUpdateBody).filter(k => k !== "StartProcessCronDetails" && k !== "TimeZoneIana").join(", ");
                  results.push({ artifact: "Trigger", name: t.name, status: "updated", message: `Updated (ID: ${existingTimeId}). Changed: ${changedFields}`, id: existingTimeId });
                } else if (putRes.status === 404 || putText.toLowerCase().includes("does not exist")) {
                  console.log(`[UiPath Deploy] Time Trigger "${t.name}" PUT returned 404 (ID ${existingTimeId} likely in different folder) — falling back to create in current folder`);
                  timeShouldCreate = true;
                } else {
                  results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Time trigger update failed (ID: ${existingTimeId}, ${putRes.status}): ${putText.slice(0, 200)}`, id: existingTimeId });
                }
              } catch (upErr: any) {
                results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `Time trigger update error (ID: ${existingTimeId}): ${upErr.message}`, id: existingTimeId });
              }
            } else {
              results.push({ artifact: "Trigger", name: t.name, status: "exists", message: `Already exists (ID: ${existingTimeId}), no changes needed`, id: existingTimeId });
            }
            if (!timeShouldCreate) continue;
          }
        }

        const cronDetails = JSON.stringify({
          type: 5,
          minutely: {},
          hourly: {},
          daily: {},
          weekly: { weekdays: [] },
          monthly: { weekdays: [] },
          advancedCronExpression: cron,
        });
        const baseBody: Record<string, any> = {
          Enabled: !createDisabled,
          Name: t.name,
          ReleaseId: releaseId,
          ReleaseName: releaseName || "",
          ReleaseKey: releaseKey || "",
          StartProcessCron: cron,
          StartProcessCronDetails: cronDetails,
          StartProcessCronSummary: t.description || "Scheduled trigger",
          TimeZoneId: timeTz,
          TimeZoneIana: timeTzIana,
          RuntimeType: runtimeType,
          InputArguments: "{}",
        };
        if (t.maxJobsCount && t.maxJobsCount > 0) {
          baseBody.JobsCount = t.maxJobsCount;
        }

        const preferredStrategy = t.startStrategy === "ModernJobs" ? 0 : 15;
        const strategies = [preferredStrategy, ...[15, 0, { Type: 0 }].filter(s => s !== preferredStrategy)];
        let created = false;
        for (const strategy of strategies) {
          const body = { ...baseBody, StartStrategy: strategy };
          console.log(`[UiPath Deploy] Time Trigger "${t.name}" trying StartStrategy=${JSON.stringify(strategy)}, payload: ${JSON.stringify(body)}`);

          const res = await fetch(`${base}/odata/ProcessSchedules`, {
            method: "POST",
            headers: hdrs,
            body: JSON.stringify(body),
          });
          const text = await res.text();
          console.log(`[UiPath Deploy] Time Trigger "${t.name}" -> ${res.status}: ${text}`);

          if (res.ok || res.status === 201) {
            const parsed = parseOrchestratorResponse(text);
            if (parsed.error) {
              results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `API returned ${res.status} but body contains error: ${parsed.error}` });
              created = true;
              break;
            }
            const timeReturnedId = parsed.data?.Id || parsed.data?.id;
            const verify = await verifyArtifactExists(base, hdrs, "ProcessSchedules", "Name", t.name, "Time Trigger", timeReturnedId);
            if (verify.exists) {
              const disabledNote = createDisabled ? ` [CREATED DISABLED — ${runtimeDetection.warning || "No Unattended runtime verified"}. Enable in Orchestrator after configuring runtimes.]` : "";
              results.push({ artifact: "Trigger", name: t.name, status: "created", message: `Time trigger created and verified (ID: ${verify.id}), cron: ${cron}${disabledNote}`, id: verify.id });
            } else {
              results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `API returned ${res.status} with ID ${timeReturnedId} but verification failed — trigger not found in Orchestrator. ${verify.detail || ""}. Response: ${text.slice(0, 300)}` });
            }
            created = true;
            break;
          } else if (res.status === 405) {
            results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `ProcessSchedules API returned 405 — scheduled triggers endpoint not available on this Orchestrator version. Cron: ${cron}` });
            created = true;
            break;
          } else if (res.status === 409 || text.includes("already exists")) {
            results.push({ artifact: "Trigger", name: t.name, status: "exists", message: "Already exists" });
            created = true;
            break;
          } else if (text.includes("StartStrategy")) {
            continue;
          } else {
            results.push({ artifact: "Trigger", name: t.name, status: "failed", message: sanitizeErrorMessage(res.status, text) });
            created = true;
            break;
          }
        }
        if (!created) {
          results.push({ artifact: "Trigger", name: t.name, status: "failed", message: `All StartStrategy formats rejected (tried 15, 0, {Type:0}). Check Orchestrator API version compatibility. Cron: ${cron}` });
        }
      }
    } catch (err: any) {
      results.push({ artifact: "Trigger", name: t.name, status: "failed", message: err.message });
    }
  }
  return results;
}

async function provisionEnvironments(
  base: string, hdrs: Record<string, string>,
  environments: OrchestratorArtifacts["environments"]
): Promise<DeploymentResult[]> {
  if (!environments?.length) return [];
  const results: DeploymentResult[] = [];

  let environmentsDeprecated = false;
  try {
    const probeRes = await fetch(`${base}/odata/Environments?$top=1`, { headers: hdrs });
    if (probeRes.status === 405 || probeRes.status === 404) {
      environmentsDeprecated = true;
      console.log(`[UiPath Deploy] Environments API returned ${probeRes.status} — deprecated on modern folder tenants (post Oct 2023)`);
    }
  } catch (e: any) { console.warn(`[UiPath Deploy] Environment probe failed: ${e.message}`); }

  if (environmentsDeprecated) {
    return environments.map(env => ({
      artifact: "Environment",
      name: env.name,
      status: "failed" as const,
      message: "Environments API deprecated on modern folder tenants (post Oct 2023). Modern folders use machine templates and runtime slots instead — these have been provisioned automatically if specified in the artifacts.",
    }));
  }

  for (const env of environments) {
    try {
      const checkRes = await fetch(
        `${base}/odata/Environments?$filter=Name eq '${odataEscape(env.name)}'&$top=1`,
        { headers: hdrs }
      );
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.value?.length > 0) {
          results.push({ artifact: "Environment", name: env.name, status: "exists", message: `Already exists (ID: ${checkData.value[0].Id})`, id: checkData.value[0].Id });
          continue;
        }
      } else if (checkRes.status === 405 || checkRes.status === 404) {
        results.push({ artifact: "Environment", name: env.name, status: "skipped", message: "Environments API not available (modern folders use machine templates instead)" });
        continue;
      }

      const envType = (env.type || "Production").toLowerCase();
      let typeValue = "Prod";
      if (envType.includes("dev")) typeValue = "Dev";
      else if (envType.includes("test")) typeValue = "Test";

      const bodyVariants = [
        { Name: env.name, Description: truncDesc(env.description), Type: typeValue },
        { Name: env.name, Description: truncDesc(env.description) },
      ];

      let envCreated = false;
      for (const body of bodyVariants) {
        const res = await fetch(`${base}/odata/Environments`, {
          method: "POST",
          headers: hdrs,
          body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log(`[UiPath Deploy] Environment "${env.name}" (body keys: ${Object.keys(body).join(",")}) -> ${res.status}: ${text.slice(0, 300)}`);

        if (res.status === 405 || res.status === 404) {
          results.push({ artifact: "Environment", name: env.name, status: "skipped", message: "Environments API not available (modern folders use machine templates instead)" });
          envCreated = true;
          break;
        }

        if (res.ok || res.status === 201) {
          const parsed = parseOrchestratorResponse(text);
          if (parsed.error) {
            results.push({ artifact: "Environment", name: env.name, status: "failed", message: `API returned ${res.status} but body contains error: ${parsed.error}` });
            envCreated = true;
            break;
          }
          const verify = await verifyArtifactExists(base, hdrs, "Environments", "Name", env.name, "Environment");
          if (verify.exists) {
            results.push({ artifact: "Environment", name: env.name, status: "created", message: `Created and verified (ID: ${verify.id}, Type: ${typeValue})`, id: verify.id });
          } else {
            results.push({ artifact: "Environment", name: env.name, status: "failed", message: `API returned ${res.status} but verification failed. ${verify.detail || ""}` });
          }
          envCreated = true;
          break;
        } else if (res.status === 409 || text.includes("already exists")) {
          results.push({ artifact: "Environment", name: env.name, status: "exists", message: "Already exists" });
          envCreated = true;
          break;
        } else if (text.includes("Type") && body.Type) {
          continue;
        } else {
          results.push({ artifact: "Environment", name: env.name, status: "failed", message: sanitizeErrorMessage(res.status, text) });
          envCreated = true;
          break;
        }
      }
      if (!envCreated) {
        results.push({ artifact: "Environment", name: env.name, status: "failed", message: `All body formats rejected by Environments API. Check API version.` });
      }
    } catch (err: any) {
      results.push({ artifact: "Environment", name: env.name, status: "failed", message: err.message });
    }
  }
  return results;
}

async function provisionActionCenter(
  base: string, hdrs: Record<string, string>,
  actionCenter: OrchestratorArtifacts["actionCenter"],
  config: UiPathConfig
): Promise<DeploymentResult[]> {
  if (!actionCenter?.length) return [];
  const results: DeploymentResult[] = [];

  const acHdrs: Record<string, string> = { ...hdrs, "Accept": "application/json" };
  if (config.folderId) {
    acHdrs["X-UIPATH-OrganizationUnitId"] = String(config.folderId);
  }

  const catalogUrl = `${base}/odata/TaskCatalogs`;
  const createCatalogUrl = `${base}/odata/TaskCatalogs/UiPath.Server.Configuration.OData.CreateTaskCatalog`;
  const cloudBase = metadataService.getCloudBaseUrl(config);

  console.log(`[UiPath Deploy] AC provisioning: folderId=${config.folderId || "none"}, X-UIPATH-OrganizationUnitId=${acHdrs["X-UIPATH-OrganizationUnitId"] || "not set"}`);

  let serviceAvailable = false;

  const catalogProbe = await uipathFetch(`${catalogUrl}?$top=1`, {
    headers: acHdrs, label: "AC Catalog Probe", maxRetries: 1,
  });
  if (catalogProbe.ok) {
    const genuine = isGenuineApiResponse(catalogProbe.text);
    serviceAvailable = genuine.genuine;
    console.log(`[UiPath Deploy] AC probe: status=${catalogProbe.status}, genuine=${genuine.genuine}, reason=${genuine.reason || "OK"}`);
  } else {
    console.log(`[UiPath Deploy] AC probe failed: status=${catalogProbe.status}, body=${catalogProbe.text.slice(0, 300)}`);
  }

  const orchUrl = `${cloudBase}/orchestrator_/actioncenter`;

  for (const ac of actionCenter) {
    const failureDetails: string[] = [];

    try {
      const checkResult = serviceAvailable
        ? await uipathFetch(
            `${catalogUrl}?$filter=Name eq '${odataEscape(ac.taskCatalog)}'&$top=1`,
            { headers: acHdrs, label: "AC Check", maxRetries: 1 }
          )
        : null;
      if (checkResult && checkResult.ok && checkResult.data?.value?.length > 0) {
        const existing = checkResult.data.value[0];
        let msg = `Already exists (ID: ${existing.Id || existing.id})`;
        if (ac.assignedRole) msg += `. Assigned role: ${ac.assignedRole}`;
        if (ac.sla) msg += `. SLA: ${ac.sla}`;
        results.push({ artifact: "Action Center", name: ac.taskCatalog, status: "exists", message: msg, id: existing.Id || existing.id });
        continue;
      }

      const descParts = [ac.description || ""];
      if (ac.priority) descParts.push(`Priority: ${ac.priority}`);
      if (ac.sla) descParts.push(`SLA: ${ac.sla}`);
      if (ac.slaConfig) {
        const slaParts: string[] = [];
        if (ac.slaConfig.dueInHours) slaParts.push(`Due: ${ac.slaConfig.dueInHours}h`);
        if (ac.slaConfig.warningThresholdHours) slaParts.push(`Warn: ${ac.slaConfig.warningThresholdHours}h`);
        if (ac.slaConfig.escalationPolicy) slaParts.push(`Escalation: ${ac.slaConfig.escalationPolicy}`);
        if (ac.slaConfig.autoEscalate) slaParts.push("Auto-escalate: Yes");
        if (slaParts.length > 0) descParts.push(`SLA Config: ${slaParts.join(", ")}`);
      }
      if (ac.escalation) descParts.push(`Escalation: ${ac.escalation}`);
      if (ac.actions?.length) descParts.push(`Actions: ${ac.actions.join(", ")}`);
      if (ac.dataFabricEntity) descParts.push(`Data Entity: ${ac.dataFabricEntity}`);
      if (ac.formFields?.length) {
        const fieldList = ac.formFields.map(f => {
          let desc = `${f.name} (${f.type}${f.required ? ", required" : ""}`;
          if (f.validationRule) desc += `, rule: ${f.validationRule}`;
          if (f.defaultValue) desc += `, default: ${f.defaultValue}`;
          desc += ")";
          return desc;
        }).join("; ");
        descParts.push(`Form Fields: ${fieldList}`);
      }
      const descText = truncDesc(descParts.filter(Boolean).join(" | "));

      let formSchemaJson: string | undefined;
      if (ac.formFields?.length) {
        const formSchema: Record<string, any> = {
          type: "object",
          properties: {} as Record<string, any>,
          required: [] as string[],
        };
        for (const field of ac.formFields) {
          const prop: Record<string, any> = {};
          const fieldType = (field.type || "String").toLowerCase();
          if (fieldType === "number" || fieldType === "integer" || fieldType === "int32") prop.type = "number";
          else if (fieldType === "boolean" || fieldType === "bool") prop.type = "boolean";
          else if (fieldType === "datetime" || fieldType === "date") { prop.type = "string"; prop.format = "date-time"; }
          else prop.type = "string";
          if (field.defaultValue) prop.default = field.defaultValue;
          if (field.validationRule) prop.description = `Validation: ${field.validationRule}`;
          formSchema.properties[field.name] = prop;
          if (field.required) (formSchema.required as string[]).push(field.name);
        }
        try {
          formSchemaJson = JSON.stringify(formSchema);
        } catch (e: any) { /* form schema serialization failed - skip */ }
      }

      const odataBody: Record<string, any> = { Name: ac.taskCatalog, Description: descText };
      if (formSchemaJson) odataBody.TaskFormDefinition = formSchemaJson;

      let created = false;
      let pendingResult: DeploymentResult | null = null;

      const createResult = await uipathFetch(createCatalogUrl, {
        method: "POST", headers: acHdrs,
        body: JSON.stringify(odataBody),
        label: "AC OData CreateTaskCatalog", maxRetries: 1,
      });
      console.log(`[UiPath Deploy] AC OData CreateTaskCatalog "${ac.taskCatalog}" -> ${createResult.status}: ${createResult.text.slice(0, 300)}`);

      if (createResult.ok || createResult.status === 201) {
        const creation = isValidCreation(createResult.text);
        if (creation.valid) {
          const createdId = creation.data?.Id || creation.data?.id;
          let msg = `Created (ID: ${createdId || "unknown"})`;
          if (ac.assignedRole) msg += `. Assigned role: ${ac.assignedRole}`;
          pendingResult = { artifact: "Action Center", name: ac.taskCatalog, status: "created", message: msg, id: createdId };
          created = true;
        } else {
          console.log(`[UiPath Deploy] AC OData CreateTaskCatalog returned 2xx but response body did not pass validation (${creation.error || "unknown"}) — will verify via GET`);
          pendingResult = { artifact: "Action Center", name: ac.taskCatalog, status: "created", message: "Created (pending verification)" };
          created = true;
        }
      } else if (createResult.status === 409 || createResult.text.includes("already exists")) {
        pendingResult = { artifact: "Action Center", name: ac.taskCatalog, status: "exists", message: "Already exists (detected via 409 conflict)" };
        created = true;
      } else {
        failureDetails.push(`POST ${createCatalogUrl} -> ${createResult.status}: ${createResult.text.slice(0, 300)}`);
      }

      if (created && pendingResult) {
        if (pendingResult.status === "exists") {
          results.push(pendingResult);
        } else {
          let verified = false;
          for (let verifyAttempt = 0; verifyAttempt < 3; verifyAttempt++) {
            if (verifyAttempt > 0) {
              await new Promise(r => setTimeout(r, 1500));
              console.log(`[UiPath Deploy] AC verify retry ${verifyAttempt + 1}/3 for "${ac.taskCatalog}"...`);
            }
            const verifyResult = await uipathFetch(
              `${catalogUrl}?$filter=Name eq '${odataEscape(ac.taskCatalog)}'&$top=1`,
              { headers: acHdrs, label: "AC Post-Create Verify", maxRetries: 1 }
            );
            if (verifyResult.ok && verifyResult.data?.value?.length > 0) {
              const found = verifyResult.data.value[0];
              const verifiedId = found.Id || found.id;
              console.log(`[UiPath Deploy] AC post-creation verified: "${ac.taskCatalog}" exists with ID ${verifiedId} in folder ${acHdrs["X-UIPATH-OrganizationUnitId"] || "default"}`);
              if (verifiedId && pendingResult.status === "created") {
                pendingResult.id = verifiedId;
                pendingResult.message = `Created (ID: ${verifiedId})${ac.assignedRole ? `. Assigned role: ${ac.assignedRole}` : ""}`;
              }
              results.push(pendingResult);
              verified = true;
              break;
            }
          }
          if (!verified) {
            console.log(`[UiPath Deploy] AC post-creation verification failed after 3 attempts: catalog "${ac.taskCatalog}" not found via GET — API may have returned success without creating the catalog`);
            created = false;
            failureDetails.push(`POST reported success but catalog "${ac.taskCatalog}" was not found after 3 GET verification attempts`);
          }
        }
      }

      if (!created) {
        const statusCodes = failureDetails.map(d => { const m = d.match(/-> (\d+):/); return m ? m[1] : "unknown"; });
        const statusSummary = `Task Catalog creation failed (status: ${statusCodes.join(", ") || "unknown"}). Create it manually using the steps below.`;

        const manualSteps = [
          `Open Action Center in Orchestrator: ${orchUrl}`,
          "Go to Task Catalogs",
          'Click "+ Add Task Catalog"',
          `Set Name to "${ac.taskCatalog}"`,
        ];
        if (ac.description) manualSteps.push(`Set Description to "${ac.description}"`);
        if (ac.assignedRole) manualSteps.push(`Assign role: ${ac.assignedRole}`);

        console.log(`[UiPath Deploy] AC Task Catalog "${ac.taskCatalog}" creation failed. Folder=${config.folderId || "none"}. Details: ${failureDetails.join(" | ")}`);

        results.push({
          artifact: "Action Center",
          name: ac.taskCatalog,
          status: "failed" as const,
          message: statusSummary,
          manualSteps,
        });
      }
    } catch (err: any) {
      console.log(`[UiPath Deploy] AC Task Catalog "${ac.taskCatalog}" exception: ${err.message}`);
      results.push({
        artifact: "Action Center",
        name: ac.taskCatalog,
        status: "failed",
        message: `API error: ${err.message}. Create the Task Catalog manually in Orchestrator.`,
        manualSteps: [
          `Open Action Center in Orchestrator: ${orchUrl}`,
          "Go to Task Catalogs",
          'Click "+ Add Task Catalog"',
          `Set Name to "${ac.taskCatalog}"`,
        ],
      });
    }
  }
  return results;
}

async function provisionDataFabricEntities(
  config: UiPathConfig,
  token: string,
  entities: OrchestratorArtifacts["dataFabricEntities"],
  svcAvail?: boolean
): Promise<DeploymentResult[]> {
  if (!entities?.length) return [];
  const results: DeploymentResult[] = [];

  const cloudBase = metadataService.getCloudBaseUrl(config);
  const entityServiceBase = `${cloudBase}/dataservice_/api/EntityService`;
  const hdrs: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  let serviceReachable = false;
  try {
    const probe = await fetch(`${entityServiceBase}/Entity`, { headers: hdrs });
    serviceReachable = probe.ok || probe.status === 401 || probe.status === 403;
    console.log(`[UiPath Deploy] Data Fabric Entity API probe: ${probe.status} (reachable=${serviceReachable})`);
  } catch (e: any) {
    console.log(`[UiPath Deploy] Data Fabric Entity API not reachable: ${e.message}`);
  }

  for (const entity of entities) {
    try {
      if (!serviceReachable) {
        const fieldDesc = entity.fields.map(f => `${f.name} (${f.type}${f.required ? ", required" : ""}${f.isKey ? ", key" : ""})`).join("; ");
        const refsDesc = entity.referencedBy?.length ? ` Referenced by: ${entity.referencedBy.join(", ")}` : "";
        results.push({
          artifact: "Data Fabric Entity",
          name: entity.name,
          status: "manual" as const,
          message: `Data Fabric not reachable via API. Entity schema: ${fieldDesc}.${refsDesc}`,
          manualSteps: [
            `Open Data Service in UiPath: ${cloudBase}/dataservice_`,
            `Create entity "${entity.name}"`,
            ...entity.fields.map(f => `Add field "${f.name}" (${f.type}${f.required ? ", required" : ""}${f.isKey ? ", primary key" : ""})`),
          ],
        });
        continue;
      }

      const checkRes = await fetch(`${entityServiceBase}/Entity?$filter=Name eq '${odataEscape(entity.name)}'`, { headers: hdrs });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        const items = checkData.value || checkData;
        if (Array.isArray(items) && items.length > 0) {
          const existing = items[0];
          results.push({
            artifact: "Data Fabric Entity",
            name: entity.name,
            status: "exists",
            message: `Already exists (ID: ${existing.Id || existing.id || "unknown"})`,
            id: existing.Id || existing.id,
          });
          continue;
        }
      }

      const dfFields = entity.fields.map(f => {
        const field: Record<string, any> = {
          Name: f.name,
          Type: f.type || "String",
          IsRequired: f.required ?? false,
          IsKey: f.isKey ?? false,
        };
        if (f.description) field.Description = f.description;
        return field;
      });

      const createBody = {
        Name: entity.name,
        Description: truncDesc(entity.description),
        Fields: dfFields,
      };

      const createRes = await fetch(`${entityServiceBase}/Entity`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify(createBody),
      });
      const createText = await createRes.text();
      console.log(`[UiPath Deploy] Data Fabric Entity "${entity.name}" -> ${createRes.status}: ${createText.slice(0, 300)}`);

      if (createRes.ok || createRes.status === 201) {
        let createdId: any;
        try {
          const parsed = JSON.parse(createText);
          createdId = parsed.Id || parsed.id;
        } catch (e: any) { /* JSON parse of create response - non-critical */ }
        const refsNote = entity.referencedBy?.length ? ` Referenced by: ${entity.referencedBy.join(", ")}` : "";
        results.push({
          artifact: "Data Fabric Entity",
          name: entity.name,
          status: "created",
          message: `Created with ${entity.fields.length} fields${createdId ? ` (ID: ${createdId})` : ""}.${refsNote}`,
          id: typeof createdId === "string" ? Number.parseInt(createdId, 10) : createdId,
        });
      } else if (createRes.status === 409 || createText.includes("already exists")) {
        results.push({ artifact: "Data Fabric Entity", name: entity.name, status: "exists", message: "Already exists" });
      } else {
        results.push({
          artifact: "Data Fabric Entity",
          name: entity.name,
          status: "failed",
          message: sanitizeErrorMessage(createRes.status, createText),
          manualSteps: [
            `Open Data Service: ${cloudBase}/dataservice_`,
            `Create entity "${entity.name}" with ${entity.fields.length} fields`,
          ],
        });
      }
    } catch (err: any) {
      results.push({ artifact: "Data Fabric Entity", name: entity.name, status: "failed", message: err.message });
    }
  }
  return results;
}

async function discoverAndReferenceApps(
  config: UiPathConfig,
  token: string,
  apps: OrchestratorArtifacts["apps"]
): Promise<DeploymentResult[]> {
  if (!apps?.length) return [];
  const results: DeploymentResult[] = [];

  const cloudBase = metadataService.getCloudBaseUrl(config);
  const hdrs: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  let existingApps: Array<{ id: string; name: string; description?: string }> = [];
  try {
    const appsRes = await fetch(`${cloudBase}/apps_/api/v2/apps?$top=100`, { headers: hdrs });
    if (appsRes.ok) {
      const data = await appsRes.json();
      existingApps = (data.value || data.apps || data || []).map((a: any) => ({
        id: a.Id || a.id || a.appId,
        name: a.Name || a.name || a.displayName,
        description: a.Description || a.description,
      })).filter((a: any) => a.name);
      console.log(`[UiPath Deploy] Discovered ${existingApps.length} existing UiPath Apps`);
    } else {
      const altRes = await fetch(`${cloudBase}/apps_/api/v1/apps?pageSize=100`, { headers: hdrs });
      if (altRes.ok) {
        const data = await altRes.json();
        existingApps = (data.value || data.apps || data || []).map((a: any) => ({
          id: a.Id || a.id || a.appId,
          name: a.Name || a.name || a.displayName,
          description: a.Description || a.description,
        })).filter((a: any) => a.name);
        console.log(`[UiPath Deploy] Discovered ${existingApps.length} existing UiPath Apps (v1 API)`);
      }
    }
  } catch (err: any) {
    console.log(`[UiPath Deploy] Apps discovery failed: ${err.message}`);
  }

  for (const app of apps) {
    const match = existingApps.find(
      (e) => e.name.toLowerCase() === app.name.toLowerCase() || (app.appId && e.id === app.appId)
    );

    if (match) {
      const linkedInfo: string[] = [];
      if (app.linkedProcesses?.length) linkedInfo.push(`Linked processes: ${app.linkedProcesses.join(", ")}`);
      if (app.linkedEntities?.length) linkedInfo.push(`Linked entities: ${app.linkedEntities.join(", ")}`);
      results.push({
        artifact: "App Reference",
        name: app.name,
        status: "exists",
        message: `Found existing app "${match.name}" (ID: ${match.id}). ${linkedInfo.join(". ")}`,
        id: typeof match.id === "number" ? match.id : undefined,
      });
    } else {
      const linkedInfo: string[] = [];
      if (app.linkedProcesses?.length) linkedInfo.push(`Should link to processes: ${app.linkedProcesses.join(", ")}`);
      if (app.linkedEntities?.length) linkedInfo.push(`Should link to entities: ${app.linkedEntities.join(", ")}`);
      results.push({
        artifact: "App Reference",
        name: app.name,
        status: "manual" as const,
        message: `App "${app.name}" not found. ${app.description || ""}. ${linkedInfo.join(". ")}`,
        manualSteps: [
          `Open UiPath Apps: ${cloudBase}/apps_`,
          `Create or find the app "${app.name}"`,
          ...(app.linkedProcesses?.map(p => `Link app to process "${p}"`) || []),
          ...(app.linkedEntities?.map(e => `Connect app to Data Fabric entity "${e}"`) || []),
        ],
      });
    }
  }
  return results;
}

async function provisionDocUnderstanding(
  config: UiPathConfig,
  token: string,
  du: OrchestratorArtifacts["documentUnderstanding"]
): Promise<DeploymentResult[]> {
  if (!du?.length) return [];
  const results: DeploymentResult[] = [];

  const cloudBase = metadataService.getCloudBaseUrl(config);
  const duConsoleUrl = `${cloudBase}/du_`;
  const PREDEFINED_DU_PROJECT_ID = "00000000-0000-0000-0000-000000000000";
  const PREDEFINED_DU_PROJECT_NAME = "Predefined";

  let duToken: string;
  try {
    const { getDuToken } = await import("../uipath-auth");
    duToken = await getDuToken();
    console.log("[UiPath Deploy] Using DU-scoped token for Document Understanding discovery");
  } catch (err: any) {
    console.warn(`[UiPath Deploy] DU token unavailable (${err.message}), falling back to OR token`);
    duToken = token;
  }

  const hdrs: Record<string, string> = {
    "Authorization": `Bearer ${duToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
  if (config.folderId) hdrs["X-UIPATH-OrganizationUnitId"] = config.folderId;

  const discoveryUrl = `${cloudBase}/du_/api/framework/projects?api-version=1`;

  let discoveredProjects: any[] = [];
  let discoverySuccess = false;
  try {
    const listRes = await fetch(discoveryUrl, { headers: hdrs });
    const listText = await listRes.text();
    console.log(`[UiPath Deploy] DU Discovery GET /projects -> ${listRes.status}: ${listText.slice(0, 300)}`);

    if (listRes.ok) {
      const genuineCheck = isGenuineServiceResponse(listText);
      if (genuineCheck.genuine) {
        const listData = JSON.parse(listText);
        discoveredProjects = listData.projects || listData.value || listData.items || (Array.isArray(listData) ? listData : []);
        discoverySuccess = true;
        console.log(`[UiPath Deploy] DU Discovery found ${discoveredProjects.length} project(s): ${discoveredProjects.map((p: any) => p.name || p.Name).join(", ")}`);
      }
    } else if (listRes.status === 403) {
      console.warn(`[UiPath Deploy] DU Discovery returned 403 — token scopes may be insufficient`);
    }
  } catch (err: any) {
    console.warn(`[UiPath Deploy] DU Discovery error: ${err.message}`);
  }

  if (!discoverySuccess) {
    return du.map(project => ({
      artifact: "Document Understanding",
      name: project.name,
      status: "manual" as const,
      message: `Could not access DU Discovery API. Ensure DU scopes (Du.Digitization.Api, etc.) are granted. Create/verify the DU project manually at ${duConsoleUrl}. Document types needed: ${project.documentTypes?.join(", ") || "N/A"}.`,
    }));
  }

  const defaultProject = discoveredProjects.find((p: any) => {
    const pId = (p.id || p.Id || "").toString();
    const pName = p.name || p.Name || "";
    return pId === PREDEFINED_DU_PROJECT_ID || pName === PREDEFINED_DU_PROJECT_NAME;
  });

  for (const artifact of du) {
    const exactMatch = discoveredProjects.find((p: any) => (p.name || p.Name) === artifact.name);

    if (exactMatch) {
      const projId = exactMatch.id || exactMatch.Id;
      let details = `Discovered DU project (ID: ${projId})`;

      try {
        const detailRes = await fetch(`${cloudBase}/du_/api/framework/projects/${projId}?api-version=1`, { headers: hdrs });
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          const docTypes = detailData.documentTypes || detailData.DocumentTypes || [];
          const classifiers = detailData.classifiers || detailData.Classifiers || [];
          const extractors = detailData.extractors || detailData.Extractors || [];
          const dtNames = docTypes.map((dt: any) => dt.name || dt.Name).filter(Boolean);
          const clNames = classifiers.map((c: any) => c.name || c.Name).filter(Boolean);
          const exNames = extractors.map((e: any) => e.name || e.Name).filter(Boolean);
          details += `. Document types: ${dtNames.length ? dtNames.join(", ") : "none configured"}`;
          details += `. Classifiers: ${clNames.length ? clNames.join(", ") : "none"}`;
          details += `. Extractors: ${exNames.length ? exNames.join(", ") : "none"}`;
        }
      } catch (e: any) { console.warn(`[UiPath Deploy] DU project probe parse failed: ${e.message}`); }

      const approach = artifact.extractionApproach || "classic_du";
      const approachLabel = approach === "generative" ? "Generative Extraction" : approach === "hybrid" ? "Hybrid (Classic DU + Generative)" : "Classic DU";
      const fieldSummary = artifact.taxonomyFields?.map(tf => `${tf.documentType}: ${tf.fields.map(f => f.name).join(", ")}`).join("; ") || "";
      const validationSummary = artifact.validationRules?.map(vr => `${vr.field}: ${vr.rule} → ${vr.action}`).join("; ") || "";
      details += `. Extraction approach: ${approachLabel}`;
      if (fieldSummary) details += `. Fields: ${fieldSummary}`;
      if (validationSummary) details += `. Validation: ${validationSummary}`;
      results.push({ artifact: "Document Understanding", name: artifact.name, status: "exists", message: details, id: exactMatch.id || exactMatch.Id });
      continue;
    }

    if (defaultProject) {
      const projId = defaultProject.id || defaultProject.Id;
      let details = `Linked to predefined DU project "${PREDEFINED_DU_PROJECT_NAME}" (ID: ${projId})`;

      try {
        const detailRes = await fetch(`${cloudBase}/du_/api/framework/projects/${projId}?api-version=1`, { headers: hdrs });
        if (detailRes.ok) {
          const detailData = await detailRes.json();
          const docTypes = detailData.documentTypes || detailData.DocumentTypes || [];
          const classifiers = detailData.classifiers || detailData.Classifiers || [];
          const extractors = detailData.extractors || detailData.Extractors || [];
          const dtNames = docTypes.map((dt: any) => dt.name || dt.Name).filter(Boolean);
          const clNames = classifiers.map((c: any) => c.name || c.Name).filter(Boolean);
          const exNames = extractors.map((e: any) => e.name || e.Name).filter(Boolean);
          details += `. Document types: ${dtNames.length ? dtNames.join(", ") : "none configured"}`;
          details += `. Classifiers: ${clNames.length ? clNames.join(", ") : "none"}`;
          details += `. Extractors: ${exNames.length ? exNames.join(", ") : "none"}`;
        }
      } catch (e: any) { console.warn(`[UiPath Deploy] DU existing project parse failed: ${e.message}`); }

      const approach = artifact.extractionApproach || "classic_du";
      const approachLabel = approach === "generative" ? "Generative Extraction" : approach === "hybrid" ? "Hybrid (Classic DU + Generative)" : "Classic DU";
      details += `. Extraction approach: ${approachLabel}`;
      details += `. Artifact doc types needed: ${artifact.documentTypes?.join(", ") || "N/A"}`;
      results.push({ artifact: "Document Understanding", name: artifact.name, status: "exists", message: details, id: projId });
      continue;
    }

    const approach = artifact.extractionApproach || "classic_du";
    const approachLabel = approach === "generative" ? "Generative Extraction" : approach === "hybrid" ? "Hybrid (Classic DU + Generative)" : "Classic DU";
    const fieldSummary = artifact.taxonomyFields?.map(tf => `${tf.documentType}: ${tf.fields.map(f => f.name).join(", ")}`).join("; ") || "";
    results.push({
      artifact: "Document Understanding",
      name: artifact.name,
      status: "manual" as const,
      message: `No matching DU project found. Extraction approach: ${approachLabel}. Create a project in the Document Understanding UI at ${duConsoleUrl}. Document types needed: ${artifact.documentTypes?.join(", ") || "N/A"}.${fieldSummary ? ` Fields to configure: ${fieldSummary}.` : ""} Tip: the predefined project (ID: 00000000-0000-0000-0000-000000000000) provides access to public pre-trained models.${approach === "generative" ? " For Generative Extraction, use the IXP console to configure LLM-powered extraction without pre-trained models." : ""}`,
    });
  }
  return results;
}

async function provisionCommunicationsMining(
  config: UiPathConfig,
  token: string,
  streams: OrchestratorArtifacts["communicationsMining"]
): Promise<DeploymentResult[]> {
  if (!streams?.length) return [];
  const results: DeploymentResult[] = [];

  const reinferUrl = metadataService.getServiceUrl("REINFER", config);
  const cloudBase = metadataService.getCloudBaseUrl(config);
  const cmConsoleUrl = `${cloudBase}/communicationsmining_`;

  const { getCommunicationsMiningToken } = await import("../uipath-integration");
  const cmToken = await getCommunicationsMiningToken();

  if (!cmToken) {
    for (const stream of streams) {
      const intentsSummary = stream.intents?.join(", ") || "N/A";
      const entitiesSummary = stream.entities?.join(", ") || "N/A";
      const routingSummary = stream.routingRules?.map(r => `${r.intent} → ${r.action}: ${r.target}`).join("; ") || "N/A";
      results.push({
        artifact: "Communications Mining",
        name: stream.name,
        status: "manual" as const,
        message: `Communications Mining requires a dedicated API token. Generate one from UiPath IXP > My Account > API token, then configure it in Settings > Communications Mining.`,
        manualSteps: [
          `Configure a Communications Mining API token in Settings > Communications Mining`,
          `Open Communications Mining console at ${cmConsoleUrl}`,
          `Create a new dataset named "${stream.name}" with source type: ${stream.sourceType || "email"}`,
          `Configure intent labels: ${intentsSummary}`,
          `Configure entity extraction for: ${entitiesSummary}`,
          `Set up routing rules: ${routingSummary}`,
        ],
      });
    }
    return results;
  }

  const hdrs: Record<string, string> = {
    "Authorization": `Bearer ${cmToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  let discoveredDatasets: any[] = [];
  let discoverySuccess = false;

  try {
    const listRes = await fetch(`${reinferUrl}/api/v1/datasets`, { headers: hdrs });
    const listText = await listRes.text();
    console.log(`[UiPath Deploy] Communications Mining Discovery GET /datasets -> ${listRes.status}: ${listText.slice(0, 300)}`);

    if (listRes.ok) {
      const genuineCheck = isGenuineServiceResponse(listText);
      if (genuineCheck.genuine) {
        const listData = JSON.parse(listText);
        discoveredDatasets = listData.datasets || listData.value || listData.items || (Array.isArray(listData) ? listData : []);
        discoverySuccess = true;
        console.log(`[UiPath Deploy] Communications Mining Discovery found ${discoveredDatasets.length} dataset(s)`);
      }
    }
  } catch (err: any) {
    console.warn(`[UiPath Deploy] Communications Mining Discovery error: ${err.message}`);
  }

  for (const stream of streams) {
    const intentsSummary = stream.intents?.join(", ") || "N/A";
    const entitiesSummary = stream.entities?.join(", ") || "N/A";
    const routingSummary = stream.routingRules?.map(r => `${r.intent} → ${r.action}: ${r.target}`).join("; ") || "N/A";

    if (discoverySuccess) {
      const exactMatch = discoveredDatasets.find((d: any) => (d.name || d.Name) === stream.name);
      if (exactMatch) {
        const dsId = exactMatch.id || exactMatch.Id;
        results.push({
          artifact: "Communications Mining",
          name: stream.name,
          status: "exists",
          message: `Discovered Communications Mining dataset (ID: ${dsId}). Source: ${stream.sourceType || "N/A"}. Intents: ${intentsSummary}. Entities: ${entitiesSummary}. Routing: ${routingSummary}.`,
          id: dsId,
        });
        continue;
      }
    }

    const manualSteps = [
      `Open Communications Mining console at ${cmConsoleUrl}`,
      `Create a new dataset named "${stream.name}" with source type: ${stream.sourceType || "email"}`,
      `Configure intent labels: ${intentsSummary}`,
      `Configure entity extraction for: ${entitiesSummary}`,
      `Set up routing rules: ${routingSummary}`,
      `Connect the data source and start ingesting ${stream.sourceType || "email"} streams`,
    ];

    results.push({
      artifact: "Communications Mining",
      name: stream.name,
      status: "manual" as const,
      message: `Communications Mining dataset "${stream.name}" needs manual setup. Source: ${stream.sourceType || "N/A"}. Intents: ${intentsSummary}. Entities: ${entitiesSummary}.`,
      manualSteps,
    });
  }
  return results;
}

type TestCaseProvisionResult = {
  results: DeploymentResult[];
  testCaseMap: Record<string, string | number>;
  testCaseLinks: Record<string, { id: string | number; objKey: string | null }>;
  projectId: string | number | null;
  projectName: string | null;
  projectPrefix: string | null;
  activeTmBase: string | null;
  tmHdrs: Record<string, string>;
};

async function provisionTestCases(
  config: UiPathConfig,
  mainToken: string,
  testCases: OrchestratorArtifacts["testCases"],
  processName: string,
  testDataQueues?: OrchestratorArtifacts["testDataQueues"],
  folderId?: string
): Promise<TestCaseProvisionResult> {
  const emptyResult: TestCaseProvisionResult = {
    results: [],
    testCaseMap: {},
    testCaseLinks: {},
    projectId: null,
    projectName: null,
    projectPrefix: null,
    activeTmBase: null,
    tmHdrs: {},
  };
  if (!testCases?.length && !testDataQueues?.length) return emptyResult;
  const results: DeploymentResult[] = [];
  const testCaseMap: Record<string, string | number> = {};
  const testCaseLinks: Record<string, { id: string | number; objKey: string | null }> = {};

  invalidateTmToken();
  let tmToken: string;
  try {
    tmToken = await getTmToken();
  } catch (err: any) {
    return {
      results: [{
        artifact: "Test Case",
        name: `${(testCases?.length || 0) + (testDataQueues?.length || 0)} item(s)`,
        status: "failed" as const,
        message: `Could not acquire token with TM scopes: ${err.message}. Ensure TM.* scopes are granted in the UiPath External Application.`,
      }],
      testCaseMap: {},
      testCaseLinks: {},
      projectId: null,
      projectName: null,
      projectPrefix: null,
      activeTmBase: null,
      tmHdrs: {},
    };
  }

  const tmBases = metadataService.getServiceUrlAlternates("TM", config as UiPathAuthConfig);
  const tmHdrs: Record<string, string> = {
    "Authorization": `Bearer ${tmToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };

  let activeTmBase: string | null = null;
  let projectId: string | number | null = null;
  let projectName: string | null = null;
  let projectPrefix: string | null = null;

  for (const tmBase of tmBases) {
    try {
      const projRes = await uipathFetch(`${tmBase}/api/v2/Projects?$top=200`, {
        headers: tmHdrs, label: "TM Probe Projects", maxRetries: 1,
        redirect: "manual" as any,
      });
      console.log(`[UiPath Deploy] Test Manager probe ${tmBase} -> ${projRes.status}: ${projRes.text.slice(0, 200)}`);

      if (projRes.status >= 300 && projRes.status < 400) {
        console.log(`[UiPath Deploy] Test Manager probe ${tmBase} returned redirect (${projRes.status}) — service may not be provisioned`);
        continue;
      }

      if (projRes.ok) {
        const genuineCheck = isGenuineServiceResponse(projRes.text);
        if (!genuineCheck.genuine) {
          console.log(`[UiPath Deploy] Test Manager probe returned 200 but is not genuine: ${genuineCheck.reason}`);
          continue;
        }

        activeTmBase = tmBase;
        metadataService.setResolvedServiceUrl("TM", tmBase);
        try {
          const projects = projRes.data?.data || projRes.data?.value || [];
          const normalizedProcessName = processName.replace(/_/g, " ").toLowerCase().trim();
          const strippedProcessName = processName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
          if (projects.length > 0) {
            let match = projects.find((p: any) =>
              (p.Name || p.name)?.toLowerCase().trim() === normalizedProcessName
            );
            if (!match) {
              match = projects.find((p: any) => {
                const pName = (p.Name || p.name) || "";
                const stripped = pName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
                return stripped === strippedProcessName;
              });
              if (match) {
                console.log(`[UiPath Deploy] Normalized match found (probe): project "${match.Name || match.name}" matched via stripped comparison`);
              }
            }
            if (match) {
              projectId = match.Id || match.id;
              projectName = match.Name || match.name || processName.replace(/_/g, " ");
              projectPrefix = match.Prefix || match.prefix || match.ProjectPrefix || match.projectPrefix || null;
              console.log(`[UiPath Deploy] Match found: project "${match.Name || match.name}" (ID: ${projectId}) — reusing existing project`);
              results.push({ artifact: "Test Project", name: match.Name || match.name, status: "exists", message: `Using existing project "${match.Name || match.name}" (ID: ${projectId}, Prefix: ${projectPrefix})`, id: projectId ?? undefined });
            } else {
              const projectNames = projects.map((p: any) => p.Name || p.name).join(", ");
              console.log(`[UiPath Deploy] No project match for "${normalizedProcessName}" (stripped: "${strippedProcessName}") among ${projects.length} project(s): [${projectNames}] — will create new project`);
            }
          }
        } catch (e: any) { console.warn(`[UiPath Deploy] TM project list parse failed: ${e.message}`); }
        break;
      }
      if (projRes.status === 401) {
        console.log(`[UiPath Deploy] Test Manager returned 401 — TM token may lack required scopes`);
        continue;
      }
    } catch (e: any) { continue; }
  }

  if (!activeTmBase) {
    return {
      results: [{
        artifact: "Test Case",
        name: `${(testCases?.length || 0)} test case(s)`,
        status: "skipped" as const,
        message: `Test Manager not available on this tenant. Test Manager requires an Enterprise license or the service may not be enabled.`,
      }],
      testCaseMap: {},
      testCaseLinks: {},
      projectId: null,
      projectName: null,
      projectPrefix: null,
      activeTmBase: null,
      tmHdrs: {},
    };
  }

  if (!projectId) {
    try {
      const projName = processName.replace(/_/g, " ");
      projectName = projName;
      const prefix = processName.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase() || "AUTO";
      const projBody = { name: projName, projectPrefix: prefix, description: truncDesc(`Test project for ${processName}`) };
      let createProjResult = await uipathFetch(`${activeTmBase}/api/v2/Projects`, {
        method: "POST",
        headers: tmHdrs,
        body: JSON.stringify(projBody),
        label: "TM Create Project (camelCase)",
        redirect: "manual" as any,
      });
      console.log(`[UiPath Deploy] TM Create (camelCase) -> ${createProjResult.status}: ${createProjResult.text.slice(0, 500)}`);
      if (createProjResult.status === 400 && createProjResult.text.includes("ProjectPrefix")) {
        const pascalBody = { Name: projName, ProjectPrefix: prefix, Description: truncDesc(`Test project for ${processName}`) };
        createProjResult = await uipathFetch(`${activeTmBase}/api/v2/Projects`, {
          method: "POST",
          headers: tmHdrs,
          body: JSON.stringify(pascalBody),
          label: "TM Create Project (PascalCase)",
          redirect: "manual" as any,
        });
        console.log(`[UiPath Deploy] TM Create (PascalCase retry) -> ${createProjResult.status}: ${createProjResult.text.slice(0, 500)}`);
      }
      if (createProjResult.status === 200 || createProjResult.status === 201) {
        const creation = isValidCreation(createProjResult.text);
        console.log(`[UiPath Deploy] TM Create isValidCreation result: valid=${creation.valid}, hasId=${!!(creation.data?.Id || creation.data?.id)}, error=${creation.error || "none"}`);
        if (creation.valid && (creation.data?.Id || creation.data?.id)) {
          projectId = creation.data.Id || creation.data.id;
          projectName = projName;
          projectPrefix = creation.data.Prefix || creation.data.prefix || creation.data.ProjectPrefix || creation.data.projectPrefix || prefix;

          let projectVerified = false;
          try {
            const verifyRes = await uipathFetch(`${activeTmBase}/api/v2/Projects/${projectId}`, {
              headers: tmHdrs, label: "TM Verify Project", maxRetries: 1,
              redirect: "manual" as any,
            });
            console.log(`[UiPath Deploy] Test project verification GET -> ${verifyRes.status}: ${verifyRes.text.slice(0, 200)}`);
            if (verifyRes.ok && verifyRes.data && (verifyRes.data.Id || verifyRes.data.id)) {
              projectVerified = true;
              console.log(`[UiPath Deploy] Test project "${projName}" (ID: ${projectId}) verified successfully`);
            } else {
              const verifyGenuine = isGenuineApiResponse(verifyRes.text);
              if (!verifyGenuine.genuine) {
                console.warn(`[UiPath Deploy] Test project verification returned non-genuine response: ${verifyGenuine.reason}`);
                projectId = null;
              }
            }
          } catch (verifyErr: any) {
            console.warn(`[UiPath Deploy] Test project verification error: ${verifyErr.message}`);
          }

          if (projectId) {
            results.push({ artifact: "Test Project", name: projName, status: "created", message: `Created test project "${projName}" (ID: ${projectId}, Prefix: ${projectPrefix})${projectVerified ? " — verified" : " — unverified"}`, id: typeof projectId === "string" ? Number.parseInt(projectId, 10) : projectId });
          } else {
            results.push({ artifact: "Test Project", name: projName, status: "failed", message: `Test project creation returned ${createProjResult.status} but post-creation verification failed — project ID may be invalid` });
          }
        } else {
          const itemNotFoundMatch = creation.error?.match(/itemNotFound[:\s]*(.*)/i);
          const errorDetail = itemNotFoundMatch ? `itemNotFound: ${itemNotFoundMatch[1] || "Unknown error"}` : creation.error;
          console.warn(`[UiPath Deploy] Test project creation returned ${createProjResult.status} but validation failed: ${errorDetail}`);
          results.push({ artifact: "Test Project", name: projName, status: "failed", message: `API returned ${createProjResult.status} but response validation failed: ${errorDetail}` });
        }
      } else if (createProjResult.status === 409 || createProjResult.text.includes("already exists")) {
        const conflictResponseBody = createProjResult.text.slice(0, 1000);
        const isPrefixConflict = createProjResult.text.toLowerCase().includes("prefix") && !createProjResult.text.toLowerCase().includes("name");
        console.log(`[UiPath Deploy] Test project 409 conflict — response body: ${conflictResponseBody}`);
        console.log(`[UiPath Deploy] Test project 409 conflict analysis: isPrefixConflict=${isPrefixConflict} (text contains "prefix": ${createProjResult.text.toLowerCase().includes("prefix")}, text contains "name": ${createProjResult.text.toLowerCase().includes("name")})`);

        try {
          const reListResult = await uipathFetch(`${activeTmBase}/api/v2/Projects?$top=200`, { headers: tmHdrs, label: "TM Re-list Projects", maxRetries: 1, redirect: "manual" as any });
          console.log(`[UiPath Deploy] 409 recovery re-list -> ${reListResult.status}: ${reListResult.text.slice(0, 500)}`);
          if (reListResult.ok) {
            const projects = reListResult.data?.data || reListResult.data?.value || [];
            const searchName = processName.replace(/_/g, " ").toLowerCase().trim();
            const strippedSearchName = processName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
            const pascalExpanded = processName.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().trim();

            const projectNames = projects.map((p: any) => p.Name || p.name || "(unnamed)");
            console.log(`[UiPath Deploy] 409 re-list: searching for "${searchName}" (stripped: "${strippedSearchName}", pascal-expanded: "${pascalExpanded}") among ${projects.length} project(s): [${projectNames.join(", ")}]`);

            let match = projects.find((p: any) =>
              (p.Name || p.name)?.toLowerCase().trim() === searchName
            );

            if (!match) {
              match = projects.find((p: any) => {
                const pName = (p.Name || p.name) || "";
                return pName.toLowerCase().trim() === pascalExpanded;
              });
              if (match) console.log(`[UiPath Deploy] 409 recovery: PascalCase-expanded match found: "${match.Name || match.name}"`);
            }

            if (!match) {
              match = projects.find((p: any) => {
                const pName = (p.Name || p.name) || "";
                const stripped = pName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
                return stripped === strippedSearchName;
              });
              if (match) console.log(`[UiPath Deploy] 409 recovery: normalized match found: "${match.Name || match.name}"`);
            }

            if (match) {
              projectId = match.Id || match.id;
              projectName = match.Name || match.name || projName;
              projectPrefix = match.Prefix || match.prefix || match.ProjectPrefix || match.projectPrefix || null;
              results.push({ artifact: "Test Project", name: match.Name || match.name, status: "exists", message: `Project exists (ID: ${projectId}, Prefix: ${projectPrefix})`, id: projectId ?? undefined });
            } else {
              console.log(`[UiPath Deploy] 409 re-list: no name match for "${projName}" among ${projects.length} project(s) — will attempt prefix-retry fallback`);
            }
          }
        } catch (e: any) { console.warn(`[UiPath Deploy] TM 409 recovery parse failed: ${e.message}`); }

        if (!projectId) {
          const randomSuffix = Math.random().toString(36).slice(2, 6).toUpperCase();
          const retryPrefix = (prefix.slice(0, 6) + randomSuffix).slice(0, 10);
          console.log(`[UiPath Deploy] No project match after 409 — retrying creation with modified prefix "${retryPrefix}" (fallback for possible prefix collision)`);
          try {
            const retryBody = { name: projName, projectPrefix: retryPrefix, description: truncDesc(`Test project for ${processName}`) };
            let retryResult = await uipathFetch(`${activeTmBase}/api/v2/Projects`, {
              method: "POST", headers: tmHdrs, body: JSON.stringify(retryBody),
              label: "TM Create Project (prefix retry)", redirect: "manual" as any,
            });
            console.log(`[UiPath Deploy] Prefix retry (camelCase) -> ${retryResult.status}: ${retryResult.text.slice(0, 500)}`);
            if (retryResult.status === 400 && retryResult.text.includes("ProjectPrefix")) {
              const retryBodyPascal = { Name: projName, ProjectPrefix: retryPrefix, Description: truncDesc(`Test project for ${processName}`) };
              retryResult = await uipathFetch(`${activeTmBase}/api/v2/Projects`, {
                method: "POST", headers: tmHdrs, body: JSON.stringify(retryBodyPascal),
                label: "TM Create Project (prefix retry PascalCase)", redirect: "manual" as any,
              });
              console.log(`[UiPath Deploy] Prefix retry (PascalCase) -> ${retryResult.status}: ${retryResult.text.slice(0, 500)}`);
            }
            if (retryResult.status === 200 || retryResult.status === 201) {
              const retryCreation = isValidCreation(retryResult.text);
              console.log(`[UiPath Deploy] TM Prefix retry isValidCreation result: valid=${retryCreation.valid}, hasId=${!!(retryCreation.data?.Id || retryCreation.data?.id)}, error=${retryCreation.error || "none"}`);
              if (retryCreation.valid && (retryCreation.data?.Id || retryCreation.data?.id)) {
                projectId = retryCreation.data.Id || retryCreation.data.id;
                projectName = projName;
                projectPrefix = retryCreation.data.Prefix || retryCreation.data.prefix || retryCreation.data.ProjectPrefix || retryCreation.data.projectPrefix || retryPrefix;
                results.push({ artifact: "Test Project", name: projName, status: "created", message: `Created test project "${projName}" (ID: ${projectId}, Prefix: ${projectPrefix}) after prefix-collision retry`, id: projectId ?? undefined });
              }
            }
            if (!projectId) {
              console.log(`[UiPath Deploy] Prefix retry also failed — 409 recovery exhausted`);
              results.push({ artifact: "Test Project", name: projName, status: "failed", message: `Project creation returned 409 but no name match found among existing projects, and prefix retry with "${retryPrefix}" also failed` });
            }
          } catch (retryErr: any) {
            console.warn(`[UiPath Deploy] Prefix retry failed: ${retryErr.message}`);
            results.push({ artifact: "Test Project", name: projName, status: "failed", message: `Project creation returned 409, name match failed, and prefix retry threw: ${retryErr.message}` });
          }
        }
      } else if (createProjResult.status === 403 || createProjResult.status === 401) {
        const responseExcerpt = createProjResult.text.slice(0, 500);
        const statusLabel = createProjResult.status === 403 ? "Insufficient permissions" : "Authentication failed";
        console.log(`[UiPath Deploy] Test project creation failed with ${createProjResult.status} — ${statusLabel}. Response: ${responseExcerpt}`);
        results.push({
          artifact: "Test Project",
          name: projName,
          status: "failed" as const,
          message: `${statusLabel} (HTTP ${createProjResult.status}). Ensure TM.Projects scope family is granted in the External Application. Response: ${responseExcerpt}`,
        });
      } else {
        const responseExcerpt = createProjResult.text.slice(0, 500);
        console.log(`[UiPath Deploy] Test project creation returned unexpected status ${createProjResult.status}. Response: ${responseExcerpt}`);
        results.push({
          artifact: "Test Project",
          name: projName,
          status: "failed" as const,
          message: `Project creation failed (HTTP ${createProjResult.status}). Response: ${responseExcerpt}`,
        });
      }
    } catch (err: any) {
      console.error(`[UiPath Deploy] Test project creation error:`, err);
      results.push({
        artifact: "Test Project",
        name: processName.replace(/_/g, " "),
        status: "failed" as const,
        message: `Project creation threw an error: ${err.message || String(err)}`,
      });
    }
  }

  if (!projectId) {
    const projectFailureReason = results.find(r => r.artifact === "Test Project" && r.status === "failed")?.message
      || "Unknown reason — no project creation result was recorded";
    return {
      results: [
        ...results,
        ...(testCases || []).map(tc => ({
          artifact: "Test Case" as const,
          name: tc.name,
          status: "failed" as const,
          message: `Could not find or create test project: ${projectFailureReason}`,
        })),
      ],
      testCaseMap: {},
      testCaseLinks: {},
      projectId: null,
      projectName,
      projectPrefix,
      activeTmBase,
      tmHdrs,
    };
  }

  if (testCases?.length) {
    const tmHdrsWithTenant: Record<string, string> = {
      ...tmHdrs,
      "X-UIPATH-TenantName": config.tenantName,
    };

    const mainTokenHdrs: Record<string, string> = {
      "Authorization": `Bearer ${mainToken}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-UIPATH-TenantName": config.tenantName,
    };

    let swaggerProbed = false;

    let existingTestCases: Array<{ id: string | number; name: string; objKey: string | null }> = [];
    try {
      const listRes = await uipathFetch(`${activeTmBase}/api/v2/${projectId}/testcases?$top=200`, {
        headers: tmHdrsWithTenant, label: "TM List TestCases", maxRetries: 1, redirect: "manual" as any,
      });
      if (listRes.ok && listRes.data) {
        const items = listRes.data?.data || listRes.data?.value || listRes.data?.items || [];
        existingTestCases = items
          .map((tc: any) => ({
            id: tc.Id || tc.id,
            name: tc.Name || tc.name,
            objKey: tc.ObjKey || tc.objKey || tc.Key || tc.key || (projectPrefix ? `${projectPrefix}:${tc.Id || tc.id}` : null),
          }))
          .filter((tc: any) => tc.id && tc.name);
        console.log(`[UiPath Deploy] Found ${existingTestCases.length} existing test cases in project ${projectId}`);
        for (const etc of existingTestCases) {
          testCaseMap[etc.name] = etc.id;
          testCaseLinks[etc.name] = { id: etc.id, objKey: etc.objKey };
        }
      }
    } catch (err: any) {
      console.log(`[UiPath Deploy] Could not list existing test cases: ${err.message}`);
    }

    for (const tc of testCases) {
      const existingMatch = existingTestCases.find(e => e.name.toLowerCase() === tc.name.toLowerCase());
      if (existingMatch) {
        testCaseMap[tc.name] = existingMatch.id;
        testCaseLinks[tc.name] = { id: existingMatch.id, objKey: existingMatch.objKey };
        results.push({ artifact: "Test Case", name: tc.name, status: "exists", message: `Already exists (ID: ${existingMatch.id})`, id: typeof existingMatch.id === "number" ? existingMatch.id : undefined });
        continue;
      }

      try {
        let richDesc = tc.description || "";
        if (tc.preconditions?.length) {
          richDesc += "\n\n**Preconditions:**\n" + tc.preconditions.map(p => `- ${p}`).join("\n");
        }
        if (tc.postconditions?.length) {
          richDesc += "\n\n**Postconditions:**\n" + tc.postconditions.map(p => `- ${p}`).join("\n");
        }
        if (tc.testData?.length) {
          richDesc += "\n\n**Test Data:**\n| Field | Value | Type |\n|---|---|---|";
          for (const td of tc.testData) {
            richDesc += `\n| ${td.field} | ${td.value} | ${td.dataType} |`;
          }
        }
        if (tc.automationWorkflow) {
          richDesc += `\n\n**Automation Workflow:** ${tc.automationWorkflow}`;
        }
        if (tc.expectedDuration) {
          richDesc += `\n**Expected Duration:** ${tc.expectedDuration}s`;
        }

        const camelBody: Record<string, any> = {
          name: tc.name,
          description: richDesc.slice(0, 2000),
        };
        if (tc.testType) {
          camelBody.type = tc.testType;
          camelBody.testCaseType = tc.testType;
        }
        if (tc.priority) {
          camelBody.priority = tc.priority;
        }
        if (tc.labels?.length) {
          camelBody.labels = tc.labels;
        }
        if (tc.steps?.length) {
          const camelSteps = tc.steps.map((s, idx) => ({
            stepDescription: s.action,
            expectedResult: s.expected,
            order: idx + 1,
          }));
          camelBody.testSteps = camelSteps;
          camelBody.manualSteps = camelSteps;
        }

        const pascalBody: Record<string, any> = {
          Name: tc.name,
          Description: richDesc.slice(0, 2000),
          ProjectId: projectId,
        };
        if (tc.testType) {
          pascalBody.Type = tc.testType;
          pascalBody.TestCaseType = tc.testType;
        }
        if (tc.priority) {
          pascalBody.Priority = tc.priority;
        }
        if (tc.labels?.length) {
          pascalBody.Labels = tc.labels;
        }
        if (tc.steps?.length) {
          const pascalSteps = tc.steps.map((s, idx) => ({
            StepDescription: s.action,
            ExpectedResult: s.expected,
            Order: idx + 1,
          }));
          pascalBody.TestSteps = pascalSteps;
          pascalBody.ManualSteps = pascalSteps;
        }

        const endpointAttempts: Array<{
          url: string;
          body: Record<string, any>;
          hdrs: Record<string, string>;
          label: string;
        }> = [
          {
            url: `${activeTmBase}/api/v2/${projectId}/testcases`,
            body: camelBody,
            hdrs: tmHdrsWithTenant,
            label: "V2 /{projectId}/testcases camelCase (TM token)",
          },
          {
            url: `${activeTmBase}/api/v2/${projectId}/testcases`,
            body: pascalBody,
            hdrs: tmHdrsWithTenant,
            label: "V2 /{projectId}/testcases PascalCase (TM token)",
          },
          {
            url: `${activeTmBase}/api/v2/${projectId}/testcases`,
            body: camelBody,
            hdrs: mainTokenHdrs,
            label: "V2 /{projectId}/testcases camelCase (main token)",
          },
          {
            url: `${activeTmBase}/api/v2/Projects/${projectId}/TestCases`,
            body: camelBody,
            hdrs: tmHdrsWithTenant,
            label: "Legacy /Projects/{id}/TestCases camelCase (TM token)",
          },
          {
            url: `${activeTmBase}/api/v2/Projects/${projectId}/TestCases`,
            body: pascalBody,
            hdrs: tmHdrsWithTenant,
            label: "Legacy /Projects/{id}/TestCases PascalCase (TM token)",
          },
        ];

        let created = false;
        const attemptDetails: string[] = [];

        for (const attempt of endpointAttempts) {
          try {
            const tcResult = await uipathFetch(attempt.url, {
              method: "POST",
              headers: attempt.hdrs,
              body: JSON.stringify(attempt.body),
              label: `TM TestCase: ${attempt.label}`,
              maxRetries: 1,
              redirect: "manual" as any,
            });

            console.log(`[UiPath Deploy] Test Case "${tc.name}" via ${attempt.label} -> ${tcResult.status}: ${tcResult.text.slice(0, 500)}`);
            attemptDetails.push(`${attempt.label}: HTTP ${tcResult.status}`);

            if (tcResult.status >= 300 && tcResult.status < 400) {
              attemptDetails[attemptDetails.length - 1] += ` (redirect)`;
              continue;
            }

            if (tcResult.status === 200 || tcResult.status === 201) {
              const creation = isValidCreation(tcResult.text);
              if (!creation.valid) {
                const itemNotFoundMatch = creation.error?.match(/itemNotFound[:\s]*(.*)/i);
                const errorDetail = itemNotFoundMatch
                  ? `itemNotFound: ${itemNotFoundMatch[1] || "Unknown error"} — the project ID ${projectId} may not be valid on this TM instance`
                  : creation.error;
                console.warn(`[UiPath Deploy] Test Case "${tc.name}" via ${attempt.label} got ${tcResult.status} but validation failed: ${errorDetail}`);
                attemptDetails[attemptDetails.length - 1] += ` (response invalid: ${errorDetail})`;
                continue;
              }
              const createdId = creation.data?.Id || creation.data?.id;
              const key = creation.data?.Key || creation.data?.key || null;
              const objKey = creation.data?.ObjKey || creation.data?.objKey || key || (projectPrefix && createdId ? `${projectPrefix}:${createdId}` : null);
              let msg = `Created via ${attempt.label} (ID: ${createdId}${key ? `, Key: ${key}` : ""})`;
              if (tc.labels?.length) msg += `, labels: ${tc.labels.join(", ")}`;

              if (tc.steps?.length && createdId) {
                const stepsBody = tc.steps.map((s, idx) => ({
                  stepDescription: s.action,
                  expectedResult: s.expected,
                  order: idx + 1,
                }));
                let stepsAttached = false;
                const stepsAttempts = [
                  { method: "PUT" as const, url: `${activeTmBase}/api/v2/${projectId}/teststeps/testcase/${createdId}`, body: stepsBody },
                  { method: "POST" as const, url: `${activeTmBase}/api/v2/${projectId}/teststeps/testcase/${createdId}`, body: stepsBody },
                  { method: "PUT" as const, url: `${activeTmBase}/api/v2/${projectId}/teststeps/testcase/${createdId}`, body: { testSteps: stepsBody } },
                  { method: "POST" as const, url: `${activeTmBase}/api/v2/${projectId}/teststeps/testcase/${createdId}`, body: { testSteps: stepsBody } },
                ];
                for (const sa of stepsAttempts) {
                  try {
                    const stepsRes = await uipathFetch(sa.url, {
                      method: sa.method,
                      headers: tmHdrsWithTenant,
                      body: JSON.stringify(sa.body),
                      label: `TM TestSteps ${sa.method} for ${tc.name}`,
                      maxRetries: 1,
                      redirect: "manual" as any,
                    });
                    if (stepsRes.ok) {
                      msg += `, ${tc.steps.length} manual steps attached via ${sa.method}`;
                      console.log(`[UiPath Deploy] Test steps for "${tc.name}" attached successfully via ${sa.method}`);
                      stepsAttached = true;
                      break;
                    } else {
                      console.log(`[UiPath Deploy] Test steps ${sa.method} for "${tc.name}" returned ${stepsRes.status}: ${stepsRes.text.slice(0, 200)}`);
                    }
                  } catch (stepsErr: any) {
                    console.log(`[UiPath Deploy] Test steps ${sa.method} for "${tc.name}" failed: ${stepsErr.message}`);
                  }
                }
                if (!stepsAttached) {
                  msg += `, ${tc.steps.length} steps included in creation body`;
                }
              } else if (tc.steps?.length) {
                msg += `, ${tc.steps.length} manual steps (inline)`;
              }

              results.push({ artifact: "Test Case", name: tc.name, status: "created", message: msg, id: createdId });
              if (createdId) {
                testCaseMap[tc.name] = createdId;
                testCaseLinks[tc.name] = { id: createdId, objKey };
              }
              created = true;
              break;
            } else if (tcResult.status === 409 || tcResult.text.includes("already exists")) {
              results.push({ artifact: "Test Case", name: tc.name, status: "exists", message: "Already exists" });
              created = true;
              break;
            } else if (tcResult.status === 404) {
              console.log(`[UiPath Deploy] Test Case "${tc.name}" via ${attempt.label} returned 404. Full response body: ${tcResult.text}`);
              attemptDetails[attemptDetails.length - 1] += ` (404 — ${tcResult.text.slice(0, 300)})`;
              continue;
            } else if (tcResult.status === 405) {
              console.log(`[UiPath Deploy] Test Case "${tc.name}" via ${attempt.label} returned 405. Full response body: ${tcResult.text}`);
              attemptDetails[attemptDetails.length - 1] += ` (405 method not allowed)`;
              continue;
            } else {
              attemptDetails[attemptDetails.length - 1] += ` (${tcResult.text.slice(0, 200)})`;
              continue;
            }
          } catch (attemptErr: any) {
            attemptDetails.push(`${attempt.label}: Error — ${attemptErr.message}`);
            continue;
          }
        }

        if (!created) {
          if (!swaggerProbed) {
            swaggerProbed = true;
            try {
              const swaggerUrl = `${activeTmBase}/swagger/index.html`;
              const swaggerRes = await fetch(swaggerUrl, { headers: { "Authorization": `Bearer ${tmToken}` }, redirect: "manual" as (RequestRedirect | undefined) });
              console.log(`[UiPath Deploy] Swagger probe ${swaggerUrl} -> ${swaggerRes.status}`);

              const swaggerJsonUrls = [
                `${activeTmBase}/swagger/v2/swagger.json`,
                `${activeTmBase}/swagger/swagger.json`,
              ];
              for (const sjUrl of swaggerJsonUrls) {
                try {
                  const sjRes = await fetch(sjUrl, { headers: { "Authorization": `Bearer ${tmToken}` }, redirect: "manual" as (RequestRedirect | undefined) });
                  if (sjRes.ok) {
                    const sjText = await sjRes.text();
                    const testCaseRoutes = sjText.match(/"\/api\/[^"]*[Tt]est[Cc]ase[^"]*"/g) || [];
                    console.log(`[UiPath Deploy] Swagger JSON from ${sjUrl}: found ${testCaseRoutes.length} TestCase routes: ${testCaseRoutes.join(", ")}`);
                  } else {
                    console.log(`[UiPath Deploy] Swagger JSON probe ${sjUrl} -> ${sjRes.status}`);
                  }
                } catch (e: any) { console.warn(`[UiPath Deploy] Swagger JSON parse failed: ${e.message}`); }
              }
            } catch (swaggerErr: any) {
              console.log(`[UiPath Deploy] Swagger probe failed: ${swaggerErr.message}`);
            }
          }

          results.push({
            artifact: "Test Case",
            name: tc.name,
            status: "failed" as const,
            message: `All TestCases API endpoints returned errors. Project "${processName}" (ID: ${projectId}) was created successfully. Add test cases manually: Test Manager > Projects > "${processName}" > New Test Case. The TestCases API may require TM.TestCases.Write scope or a newer Test Manager version. Attempts: ${attemptDetails.join(" | ")}`,
          });
        }
      } catch (err: any) {
        results.push({ artifact: "Test Case", name: tc.name, status: "failed", message: err.message });
      }
    }
  }

  if (testDataQueues?.length && folderId) {
    const orchBase = metadataService.getServiceUrl("OR", config);
    const orchHdrs: Record<string, string> = {
      "Authorization": `Bearer ${mainToken}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "X-UIPATH-OrganizationUnitId": folderId,
    };

    for (const tdq of testDataQueues) {
      try {
        const defaultSchema = JSON.stringify({
          type: "object",
          properties: {
            TestInput: { type: "string" },
            ExpectedOutput: { type: "string" },
            TestCategory: { type: "string" },
          },
        });
        const queueBody: Record<string, any> = {
          Name: tdq.name,
          Description: truncDesc(tdq.description),
          ContentJsonSchema: tdq.jsonSchema || defaultSchema,
        };

        const queueResult = await uipathFetch(`${orchBase}/odata/TestDataQueues`, {
          method: "POST",
          headers: orchHdrs,
          body: JSON.stringify(queueBody),
          label: "TM Create TestDataQueue",
          maxRetries: 1,
        });
        console.log(`[UiPath Deploy] TestDataQueue "${tdq.name}" -> ${queueResult.status}: ${queueResult.text.slice(0, 300)}`);

        if (queueResult.status === 200 || queueResult.status === 201) {
          const creation = isValidCreation(queueResult.text);
          const queueId = creation.data?.Id || creation.data?.id;
          results.push({ artifact: "Test Data Queue", name: tdq.name, status: "created", message: `Created (ID: ${queueId || "unknown"})`, id: queueId });

          if (queueId && tdq.items?.length) {
            try {
              const uploadResult = await uipathFetch(
                `${orchBase}/odata/TestDataQueueItems/UiPath.Server.Configuration.OData.UploadItems`,
                {
                  method: "POST",
                  headers: orchHdrs,
                  body: JSON.stringify({
                    testDataQueueId: queueId,
                    items: tdq.items.map(item => ({
                      name: item.name,
                      content: item.content,
                    })),
                  }),
                  label: "TM Upload TestDataQueueItems",
                  maxRetries: 1,
                }
              );
              if (uploadResult.ok) {
                console.log(`[UiPath Deploy] Uploaded ${tdq.items.length} items to TestDataQueue "${tdq.name}"`);
              } else {
                console.warn(`[UiPath Deploy] TestDataQueue item upload failed: ${uploadResult.status} ${uploadResult.text.slice(0, 200)}`);
              }
            } catch (uploadErr: any) {
              console.warn(`[UiPath Deploy] TestDataQueue item upload error: ${uploadErr.message}`);
            }
          }
        } else if (queueResult.status === 409 || queueResult.text.includes("already exists")) {
          results.push({ artifact: "Test Data Queue", name: tdq.name, status: "exists", message: "Already exists" });
        } else {
          results.push({ artifact: "Test Data Queue", name: tdq.name, status: "failed", message: queueResult.error || `HTTP ${queueResult.status}` });
        }
      } catch (err: any) {
        results.push({ artifact: "Test Data Queue", name: tdq.name, status: "failed", message: err.message });
      }
    }
  } else if (testDataQueues?.length && !folderId) {
    for (const tdq of testDataQueues) {
      results.push({
        artifact: "Test Data Queue",
        name: tdq.name,
        status: "failed",
        message: "No folder ID available — TestDataQueues require X-UIPATH-OrganizationUnitId header. Ensure a folder is configured.",
      });
    }
  }

  return { results, testCaseMap, testCaseLinks, projectId, projectName, projectPrefix, activeTmBase, tmHdrs };
}

async function provisionRequirements(
  activeTmBase: string,
  tmHdrs: Record<string, string>,
  projectId: string | number,
  requirements: OrchestratorArtifacts["requirements"],
  tenantName: string,
): Promise<{ results: DeploymentResult[]; requirementMap: Record<string, string | number> }> {
  if (!requirements?.length) return { results: [], requirementMap: {} };
  const results: DeploymentResult[] = [];
  const requirementMap: Record<string, string | number> = {};

  const hdrs = { ...tmHdrs, "X-UIPATH-TenantName": tenantName };

  let existingReqs: Array<{ id: string | number; name: string }> = [];
  const listEndpoints = [
    `${activeTmBase}/api/v2/${projectId}/requirements?$top=200`,
    `${activeTmBase}/api/v2/Projects/${projectId}/Requirements?$top=200`,
  ];
  for (const url of listEndpoints) {
    try {
      const listRes = await uipathFetch(url, { headers: hdrs, label: "TM List Requirements", maxRetries: 1, redirect: "manual" as any });
      if (listRes.ok && listRes.data) {
        const items = listRes.data?.data || listRes.data?.value || listRes.data?.items || [];
        existingReqs = items.map((r: any) => ({ id: r.Id || r.id, name: r.Name || r.name })).filter((r: any) => r.id && r.name);
        console.log(`[UiPath Deploy] Found ${existingReqs.length} existing requirements in project ${projectId}`);
        for (const er of existingReqs) {
          requirementMap[er.name] = er.id;
        }
        break;
      }
    } catch (e: any) { continue; }
  }

  for (const req of requirements) {
    const existingMatch = existingReqs.find(e => e.name.toLowerCase() === req.name.toLowerCase());
    if (existingMatch) {
      requirementMap[req.name] = existingMatch.id;
      results.push({ artifact: "Requirement", name: req.name, status: "exists", message: `Already exists (ID: ${existingMatch.id})` });
      continue;
    }

    const createEndpoints = [
      `${activeTmBase}/api/v2/${projectId}/requirements`,
      `${activeTmBase}/api/v2/Projects/${projectId}/Requirements`,
    ];
    let created = false;
    for (const url of createEndpoints) {
      try {
        const reqDescParts = [req.description || ""];
        if (req.type) reqDescParts.push(`Type: ${req.type}`);
        if (req.priority) reqDescParts.push(`Priority: ${req.priority}`);
        if (req.source) reqDescParts.push(`Source: ${req.source}`);
        if (req.acceptanceCriteria?.length) {
          reqDescParts.push(`Acceptance Criteria:\n${req.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`);
        }
        const body = { name: req.name, description: truncDesc(reqDescParts.filter(Boolean).join("\n")) };
        const createRes = await uipathFetch(url, {
          method: "POST", headers: hdrs, body: JSON.stringify(body),
          label: "TM Create Requirement", maxRetries: 1, redirect: "manual" as any,
        });
        console.log(`[UiPath Deploy] Requirement "${req.name}" via ${url} -> ${createRes.status}: ${createRes.text.slice(0, 300)}`);
        if (createRes.status === 200 || createRes.status === 201) {
          const creation = isValidCreation(createRes.text);
          if (creation.valid) {
            const createdId = creation.data?.Id || creation.data?.id;
            if (createdId) requirementMap[req.name] = createdId;
            results.push({ artifact: "Requirement", name: req.name, status: "created", message: `Created (ID: ${createdId})` });
            created = true;
            break;
          }
        } else if (createRes.status === 409 || createRes.text.includes("already exists")) {
          results.push({ artifact: "Requirement", name: req.name, status: "exists", message: "Already exists" });
          created = true;
          break;
        }
      } catch (e: any) { continue; }
    }
    if (!created) {
      results.push({ artifact: "Requirement", name: req.name, status: "failed", message: "All requirement creation endpoints returned errors" });
    }
  }

  return { results, requirementMap };
}

async function provisionTestSets(
  activeTmBase: string,
  tmHdrs: Record<string, string>,
  projectId: string | number,
  testSets: OrchestratorArtifacts["testSets"],
  testCaseMap: Record<string, string | number>,
  tenantName: string,
): Promise<DeploymentResult[]> {
  if (!testSets?.length) return [];
  const results: DeploymentResult[] = [];
  const hdrs = { ...tmHdrs, "X-UIPATH-TenantName": tenantName };

  let existingTestSets: Array<{ id: string | number; name: string }> = [];
  const listEndpoints = [
    `${activeTmBase}/api/v2/${projectId}/testsets?$top=200`,
    `${activeTmBase}/api/v2/Projects/${projectId}/TestSets?$top=200`,
  ];
  for (const url of listEndpoints) {
    try {
      const listRes = await uipathFetch(url, { headers: hdrs, label: "TM List TestSets", maxRetries: 1, redirect: "manual" as any });
      if (listRes.ok && listRes.data) {
        const items = listRes.data?.data || listRes.data?.value || listRes.data?.items || [];
        existingTestSets = items.map((s: any) => ({ id: s.Id || s.id, name: s.Name || s.name })).filter((s: any) => s.id && s.name);
        console.log(`[UiPath Deploy] Found ${existingTestSets.length} existing test sets in project ${projectId}`);
        break;
      }
    } catch (e: any) { continue; }
  }

  for (const ts of testSets) {
    const existingMatch = existingTestSets.find(e => e.name.toLowerCase() === ts.name.toLowerCase());
    if (existingMatch) {
      let msg = `Already exists (ID: ${existingMatch.id})`;
      if (ts.testCaseNames?.length) {
        const tcIds = ts.testCaseNames
          .map(name => testCaseMap[name])
          .filter((id): id is string | number => id !== undefined);
        if (tcIds.length > 0) {
          try {
            const assignRes = await uipathFetch(`${activeTmBase}/api/v2/${projectId}/testsets/${existingMatch.id}/assigntestcases`, {
              method: "POST", headers: hdrs,
              body: JSON.stringify(tcIds),
              label: "TM Assign TestCases to existing TestSet", maxRetries: 1, redirect: "manual" as any,
            });
            if (assignRes.ok) {
              msg += `, ${tcIds.length} test case(s) assigned`;
            } else {
              msg += `, test case assignment returned ${assignRes.status}`;
            }
          } catch (assignErr: any) {
            msg += `, assignment error: ${assignErr.message}`;
          }
        }
      }
      results.push({ artifact: "Test Set", name: ts.name, status: "exists", message: msg });
      continue;
    }

    const createEndpoints = [
      `${activeTmBase}/api/v2/${projectId}/testsets`,
      `${activeTmBase}/api/v2/Projects/${projectId}/TestSets`,
    ];
    let createdSetId: string | number | null = null;
    let created = false;
    for (const url of createEndpoints) {
      try {
        let tsDesc = ts.description || "";
        if (ts.executionMode || ts.environment || ts.triggerType) {
          const configParts: string[] = [];
          if (ts.executionMode) configParts.push(`Execution: ${ts.executionMode}`);
          if (ts.environment) configParts.push(`Environment: ${ts.environment}`);
          if (ts.triggerType) configParts.push(`Trigger: ${ts.triggerType}`);
          tsDesc += (tsDesc ? "\n\n" : "") + configParts.join(" | ");
        }
        const body = { name: ts.name, description: truncDesc(tsDesc) };
        const createRes = await uipathFetch(url, {
          method: "POST", headers: hdrs, body: JSON.stringify(body),
          label: "TM Create TestSet", maxRetries: 1, redirect: "manual" as any,
        });
        console.log(`[UiPath Deploy] Test Set "${ts.name}" via ${url} -> ${createRes.status}: ${createRes.text.slice(0, 300)}`);
        if (createRes.status === 200 || createRes.status === 201) {
          const creation = isValidCreation(createRes.text);
          if (creation.valid) {
            createdSetId = creation.data?.Id || creation.data?.id;
            let msg = `Created (ID: ${createdSetId})`;

            if (ts.testCaseNames?.length && createdSetId) {
              const tcIds = ts.testCaseNames
                .map(name => testCaseMap[name])
                .filter((id): id is string | number => id !== undefined);
              if (tcIds.length > 0) {
                try {
                  const assignRes = await uipathFetch(`${activeTmBase}/api/v2/${projectId}/testsets/${createdSetId}/assigntestcases`, {
                    method: "POST", headers: hdrs,
                    body: JSON.stringify(tcIds),
                    label: "TM Assign TestCases to TestSet", maxRetries: 1, redirect: "manual" as any,
                  });
                  if (assignRes.ok) {
                    msg += `, ${tcIds.length} test case(s) assigned`;
                    console.log(`[UiPath Deploy] Assigned ${tcIds.length} test cases to test set "${ts.name}"`);
                  } else {
                    msg += `, test case assignment failed (${assignRes.status})`;
                    console.log(`[UiPath Deploy] Test case assignment to set "${ts.name}" failed: ${assignRes.status} ${assignRes.text.slice(0, 200)}`);
                  }
                } catch (assignErr: any) {
                  msg += `, test case assignment error: ${assignErr.message}`;
                }
              } else {
                msg += `, 0/${ts.testCaseNames.length} test case names resolved to IDs`;
              }
            }

            results.push({ artifact: "Test Set", name: ts.name, status: "created", message: msg });
            created = true;
            break;
          }
        } else if (createRes.status === 409 || createRes.text.includes("already exists")) {
          results.push({ artifact: "Test Set", name: ts.name, status: "exists", message: "Already exists" });
          created = true;
          break;
        }
      } catch (e: any) { continue; }
    }
    if (!created) {
      results.push({ artifact: "Test Set", name: ts.name, status: "failed", message: "All test set creation endpoints returned errors" });
    }
  }

  return results;
}

async function linkRequirementsToTestCases(
  activeTmBase: string,
  tmHdrs: Record<string, string>,
  projectId: string | number,
  requirementMap: Record<string, string | number>,
  testCaseMap: Record<string, string | number>,
  tenantName: string,
): Promise<DeploymentResult[]> {
  const reqEntries = Object.entries(requirementMap);
  const tcIds = Object.values(testCaseMap);
  if (reqEntries.length === 0 || tcIds.length === 0) return [];

  const results: DeploymentResult[] = [];
  const hdrs = { ...tmHdrs, "X-UIPATH-TenantName": tenantName };

  for (const [reqName, reqId] of reqEntries) {
    try {
      const assignRes = await uipathFetch(`${activeTmBase}/api/v2/${projectId}/requirements/${reqId}/assigntestcases`, {
        method: "POST", headers: hdrs,
        body: JSON.stringify({ testCaseIds: tcIds }),
        label: `TM Link Requirement "${reqName}" to TestCases`, maxRetries: 1, redirect: "manual" as any,
      });
      if (assignRes.ok) {
        results.push({ artifact: "Requirement Link", name: reqName, status: "created", message: `Linked to ${tcIds.length} test case(s)` });
        console.log(`[UiPath Deploy] Linked requirement "${reqName}" (${reqId}) to ${tcIds.length} test cases`);
      } else {
        console.log(`[UiPath Deploy] Requirement link for "${reqName}" failed: ${assignRes.status} ${assignRes.text.slice(0, 200)}`);
        results.push({ artifact: "Requirement Link", name: reqName, status: "failed", message: `Link failed (${assignRes.status})` });
      }
    } catch (err: any) {
      results.push({ artifact: "Requirement Link", name: reqName, status: "failed", message: err.message });
    }
  }

  return results;
}

export type ServiceAvailability = {
  available: boolean;
  endpoint?: string;
  message: string;
};

export type InfraProbeResult = {
  machines: Array<{ id: number; name: string; type: string; unattendedSlots: number; nonProdSlots: number; testAutomationSlots: number; headlessSlots: number }>;
  users: Array<{ id: number; userName: string; type: string; rolesList: string[] }>;
  sessions: Array<{ robotName: string; machineName: string; state: string; runtimeType: string }>;
  robots: Array<{ id: number; name: string; machineName: string; type: string; userName: string }>;
  actionCenter: ServiceAvailability;
  testManager: ServiceAvailability;
};

async function preflightInfraProbe(
  base: string, hdrs: Record<string, string>, folderId?: string, config?: UiPathConfig, svcAvail?: ServiceAvailabilityMap | null
): Promise<InfraProbeResult> {
  const result: InfraProbeResult = {
    machines: [], users: [], sessions: [], robots: [],
    actionCenter: { available: false, message: "Not probed" },
    testManager: { available: false, message: "Not probed" },
  };
  const numFolderId = folderId ? parseInt(folderId, 10) : null;

  try {
    const machUrl = numFolderId
      ? `${base}/odata/Folders/UiPath.Server.Configuration.OData.GetMachinesForFolder(key=${numFolderId})?$top=100`
      : `${base}/odata/Machines?$top=100&$select=Id,Name,Type,UnattendedSlots,NonProductionSlots,TestAutomationSlots,HeadlessSlots`;
    const machRes = await fetch(machUrl, { headers: hdrs });
    if (machRes.ok) {
      const data = await machRes.json();
      result.machines = (data.value || []).map((m: any) => ({
        id: m.Id || m.id,
        name: m.Name || m.name || m.MachineName,
        type: m.Type || "Unknown",
        unattendedSlots: m.UnattendedSlots || 0,
        nonProdSlots: m.NonProductionSlots || 0,
        testAutomationSlots: m.TestAutomationSlots || 0,
        headlessSlots: m.HeadlessSlots || 0,
      }));
    }
  } catch (err: any) {
    console.warn(`[UiPath Probe] Machines probe failed: ${err.message}`);
  }

  try {
    const userUrl = numFolderId
      ? `${base}/odata/Folders/UiPath.Server.Configuration.OData.GetUsersForFolder(key=${numFolderId})?$top=100`
      : `${base}/odata/Users?$top=100&$select=Id,UserName,Type,RolesList`;
    const userRes = await fetch(userUrl, { headers: hdrs });
    if (userRes.ok) {
      const data = await userRes.json();
      result.users = (data.value || []).map((u: any) => ({
        id: u.Id || u.id,
        userName: u.UserName || u.userName || u.Name || "",
        type: u.Type || "User",
        rolesList: u.RolesList || [],
      }));
    } else {
      console.log(`[UiPath Probe] GetUsersForFolder returned ${userRes.status} — will derive user info from robots`);
    }
  } catch (err: any) {
    console.warn(`[UiPath Probe] Users probe failed: ${err.message}`);
  }

  try {
    const sessRes = await fetch(`${base}/odata/Sessions?$top=50&$select=RobotName,MachineName,State,RuntimeType`, { headers: hdrs });
    if (sessRes.ok) {
      const data = await sessRes.json();
      result.sessions = (data.value || []).map((s: any) => ({
        robotName: s.RobotName || "",
        machineName: s.MachineName || "",
        state: s.State || "Unknown",
        runtimeType: s.RuntimeType || "",
      }));
    }
  } catch (err: any) {
    console.warn(`[UiPath Probe] Sessions probe failed: ${err.message}`);
  }

  try {
    const robotRes = await fetch(`${base}/odata/Robots?$top=100&$select=Id,Name,MachineName,Type,Username`, { headers: hdrs });
    if (robotRes.ok) {
      const data = await robotRes.json();
      result.robots = (data.value || []).map((r: any) => ({
        id: r.Id || r.id,
        name: r.Name || "",
        machineName: r.MachineName || "",
        type: r.Type || "Unknown",
        userName: r.Username || r.UserName || "",
      }));
    }
  } catch (err: any) {
    console.warn(`[UiPath Probe] Robots probe failed: ${err.message}`);
  }

  if (svcAvail) {
    result.actionCenter = {
      available: svcAvail.actionCenter,
      endpoint: svcAvail.actionCenter ? "Orchestrator" : undefined,
      message: svcAvail.actionCenter ? "Action Center is licensed and available (via probeAllServices)" : "Action Center not available (via probeAllServices)",
    };
    result.testManager = {
      available: svcAvail.testManager,
      endpoint: svcAvail.testManager ? "Orchestrator" : undefined,
      message: svcAvail.testManager ? "Test Manager is licensed and available (via probeAllServices)" : "Test Manager not available (via probeAllServices)",
    };
  }

  console.log(`[UiPath Probe] Infrastructure: ${result.machines.length} machines, ${result.users.length} users, ${result.sessions.length} sessions, ${result.robots.length} robots | Action Center: ${result.actionCenter.available ? "✓" : "✗"} | Test Manager: ${result.testManager.available ? "✓" : "✗"}`);
  return result;
}

function formatInfraProbeResults(probe: InfraProbeResult): DeploymentResult[] {
  const results: DeploymentResult[] = [];

  const unattendedMachines = probe.machines.filter(m => m.unattendedSlots > 0);
  const totalUnattSlots = unattendedMachines.reduce((sum, m) => sum + m.unattendedSlots, 0);
  if (probe.machines.length > 0) {
    results.push({
      artifact: "Infrastructure",
      name: "Machine Templates",
      status: unattendedMachines.length > 0 ? "exists" : "skipped",
      message: `Found ${probe.machines.length} machine template(s) in folder${unattendedMachines.length > 0 ? ` (${totalUnattSlots} unattended slot(s) across ${unattendedMachines.length} machine(s))` : " — none have unattended slots"}.`,
    });
  } else {
    results.push({
      artifact: "Infrastructure",
      name: "Machine Templates",
      status: "skipped",
      message: "No machine templates found in folder",
    });
  }

  const robotUsers = probe.users.filter(u => u.type === "Robot" || u.userName.toLowerCase().includes("robot"));
  if (probe.users.length > 0) {
    results.push({
      artifact: "Infrastructure",
      name: "Users/Robot Accounts",
      status: robotUsers.length > 0 ? "exists" : "skipped",
      message: `Found ${probe.users.length} user(s) in folder${robotUsers.length > 0 ? ` (${robotUsers.length} robot account(s))` : ""}`,
    });
  } else if (probe.robots.length > 0) {
    const unattendedRobots = probe.robots.filter(r => r.type === "Unattended" || r.type === "NonProduction");
    results.push({
      artifact: "Infrastructure",
      name: "Users/Robot Accounts",
      status: unattendedRobots.length > 0 ? "exists" : "skipped",
      message: `Found ${probe.robots.length} robot(s)${unattendedRobots.length > 0 ? ` (${unattendedRobots.length} Unattended)` : " — none are Unattended type"}`,
    });
  } else {
    results.push({
      artifact: "Infrastructure",
      name: "Users/Robot Accounts",
      status: "skipped",
      message: "No users or robot accounts found in folder",
    });
  }

  if (probe.sessions.length > 0) {
    const activeSessions = probe.sessions.filter(s => s.state === "Available" || s.state === "Busy");
    const runtimeTypes = Array.from(new Set(probe.sessions.map(s => s.runtimeType).filter(Boolean)));
    results.push({
      artifact: "Infrastructure",
      name: "Active Sessions",
      status: activeSessions.length > 0 ? "exists" : "skipped",
      message: `Found ${probe.sessions.length} session(s) (${activeSessions.length} active). Runtime types: ${runtimeTypes.join(", ") || "N/A"}`,
    });
  }

  results.push({
    artifact: "Infrastructure",
    name: "Action Center",
    status: probe.actionCenter.available ? "exists" : "skipped",
    message: probe.actionCenter.message,
  });

  results.push({
    artifact: "Infrastructure",
    name: "Test Manager",
    status: probe.testManager.available ? "exists" : "skipped",
    message: probe.testManager.message,
  });

  return results;
}

async function getPMToken(config: UiPathConfig): Promise<string | null> {
  try {
    const { getPmToken } = await import("../uipath-auth");
    const token = await getPmToken();
    console.log("[UiPath Deploy] PM token acquired via centralized auth");
    return token;
  } catch (err: any) {
    console.warn(`[UiPath Deploy] PM token error: ${err.message}`);
    return null;
  }
}


async function provisionRobotAccounts(
  base: string, hdrs: Record<string, string>,
  config: UiPathConfig,
  robotAccounts: OrchestratorArtifacts["robotAccounts"],
  probe: InfraProbeResult
): Promise<DeploymentResult[]> {
  if (!robotAccounts?.length) return [];
  const results: DeploymentResult[] = [];

  const existingRobotUsers = probe.users.filter(u => u.type === "Robot" || u.userName.toLowerCase().includes("robot"));
  const existingRobots = probe.robots;

  for (const ra of robotAccounts) {
    const nameNorm = ra.name.toLowerCase().replace(/[\s_-]+/g, "");
    const matchingUser = existingRobotUsers.find(u =>
      u.userName.toLowerCase().replace(/[\s_-]+/g, "").includes(nameNorm) ||
      nameNorm.includes(u.userName.toLowerCase().replace(/[\s_-]+/g, ""))
    );
    const matchingRobot = existingRobots.find(r =>
      r.name.toLowerCase().replace(/[\s_-]+/g, "").includes(nameNorm) ||
      nameNorm.includes(r.name.toLowerCase().replace(/[\s_-]+/g, ""))
    );

    if (matchingUser) {
      results.push({
        artifact: "Robot Account",
        name: ra.name,
        status: "exists",
        message: `Reusing existing robot account "${matchingUser.userName}" (ID: ${matchingUser.id}) already in folder. Type: ${matchingUser.type}`,
        id: matchingUser.id,
      });
      continue;
    }
    if (matchingRobot) {
      results.push({
        artifact: "Robot Account",
        name: ra.name,
        status: "exists",
        message: `Reusing existing robot "${matchingRobot.name}" (ID: ${matchingRobot.id}) on machine "${matchingRobot.machineName}". Type: ${matchingRobot.type}`,
        id: matchingRobot.id,
      });
      continue;
    }

    if (existingRobotUsers.length > 0 && !matchingUser) {
      const firstRobot = existingRobotUsers[0];
      results.push({
        artifact: "Robot Account",
        name: ra.name,
        status: "exists",
        message: `Reusing existing robot account "${firstRobot.userName}" (ID: ${firstRobot.id}) available in folder. Type: ${firstRobot.type}`,
        id: firstRobot.id,
      });
      continue;
    }

    let created = false;

    const pmToken = await getPMToken(config);
    if (pmToken) {
      const cloudBase = metadataService.getCloudBaseUrl(config);
      const identityBase = metadataService.getServiceUrl("IDENTITY", config);
      const identityBases = [
        `${identityBase}/api/RobotAccount`,
        `${cloudBase}/identity_/api/RobotAccount`,
      ];

      for (const identityUrl of identityBases) {
        try {
          const pmHdrs = { "Authorization": `Bearer ${pmToken}`, "Content-Type": "application/json" };
          const body = { name: ra.name, displayName: ra.name, domain: "UiPath" };
          const res = await fetch(identityUrl, { method: "POST", headers: pmHdrs, body: JSON.stringify(body) });
          const text = await res.text();
          console.log(`[UiPath Deploy] Robot account "${ra.name}" via ${identityUrl} -> ${res.status}: ${text.slice(0, 300)}`);

          if (text.trimStart().startsWith("<!") || text.trimStart().startsWith("<html")) {
            console.log(`[UiPath Deploy] Robot account endpoint returned HTML at ${identityUrl} — skipping`);
            continue;
          }

          if (res.ok || res.status === 201) {
            let createdId;
            try { const parsed = JSON.parse(text); createdId = parsed.id || parsed.Id; } catch (e: any) { continue; }
            if (config.folderId) {
              try {
                const assignUrl = `${base}/odata/Folders/UiPath.Server.Configuration.OData.AssignUsers`;
                const roleName = ra.role || "Executor";
                const assignBody = { assignments: { UserIds: [createdId], RolesPerFolder: [{ FolderId: parseInt(config.folderId, 10), Roles: [{ Name: roleName }] }] } };
                await fetch(assignUrl, { method: "POST", headers: hdrs, body: JSON.stringify(assignBody) });
              } catch (err: any) {
                console.warn(`[UiPath Deploy] Robot folder assignment failed: ${err.message}`);
              }
            }
            results.push({ artifact: "Robot Account", name: ra.name, status: "created", message: `Created via identity API${createdId ? ` (ID: ${createdId})` : ""}${config.folderId ? ", assigned to folder" : ""}`, id: createdId });
            created = true;
            break;
          } else if (res.status === 409 || text.includes("already exists")) {
            results.push({ artifact: "Robot Account", name: ra.name, status: "exists", message: "Already exists in identity service" });
            created = true;
            break;
          }
        } catch (e: any) { continue; }
      }
    }

    if (!created) {
      try {
        const odataBody = { UserName: ra.name.replace(/[^A-Za-z0-9._-]/g, "_"), Name: ra.name.split(/[\s_-]/)[0] || ra.name, Surname: ra.name.split(/[\s_-]/).slice(1).join(" ") || "Robot", RolesList: ["Robot"], Type: "Robot" };
        const odataRes = await uipathFetch(`${base}/odata/Users`, { method: "POST", headers: hdrs, body: JSON.stringify(odataBody), label: "Robot OData Create", maxRetries: 1 });
        if (odataRes.ok || odataRes.status === 201) {
          const creation = isValidCreation(odataRes.text);
          const userId = creation.data?.Id || creation.data?.id;
          results.push({ artifact: "Robot Account", name: ra.name, status: "created", message: `Created via OData Users API (ID: ${userId || "unknown"})`, id: userId });
          created = true;
        } else if (odataRes.status === 409 || odataRes.text.includes("already exists")) {
          results.push({ artifact: "Robot Account", name: ra.name, status: "exists", message: "Already exists" });
          created = true;
        }
      } catch (e: any) { console.warn(`[UiPath Deploy] Robot account OData creation failed: ${e.message}`); }
    }

    if (!created) {
      console.log(`[UiPath Deploy] Robot account "${ra.name}" creation failed via Identity API and OData — searching for any existing robot account in folder to reuse`);
      let fallbackFound = false;

      if (probe.robots.length > 0) {
        const anyUnattendedRobot = probe.robots.find(r => r.type === "Unattended" || r.type === "NonProduction");
        const anyRobot = anyUnattendedRobot || probe.robots[0];
        if (anyRobot) {
          results.push({
            artifact: "Robot Account",
            name: ra.name,
            status: "exists",
            message: `Creation failed (insufficient API scopes) — reusing existing robot "${anyRobot.name}" (ID: ${anyRobot.id}, Type: ${anyRobot.type}) found in folder. This robot will be used for trigger execution.`,
            id: anyRobot.id,
          });
          fallbackFound = true;
        }
      }

      if (!fallbackFound) {
        try {
          const tenantHdrs = { ...hdrs };
          delete tenantHdrs["X-UIPATH-OrganizationUnitId"];
          const tenantRobotsRes = await fetch(`${base}/odata/Users?$filter=Type eq 'Robot'&$top=10&$select=Id,UserName,Type,RolesList`, { headers: tenantHdrs });
          if (tenantRobotsRes.ok) {
            const tenantRobotsData = await tenantRobotsRes.json();
            const tenantRobots = tenantRobotsData.value || [];
            if (tenantRobots.length > 0) {
              const tenantRobot = tenantRobots[0];
              console.log(`[UiPath Deploy] Found tenant-level robot "${tenantRobot.UserName}" (ID: ${tenantRobot.Id}) — attempting to assign to folder`);
              if (config.folderId) {
                try {
                  const assignUrl = `${base}/odata/Folders/UiPath.Server.Configuration.OData.AssignUsers`;
                  const assignBody = { assignments: { UserIds: [tenantRobot.Id], RolesPerFolder: [{ FolderId: parseInt(config.folderId, 10), Roles: [{ Name: "Executor" }] }] } };
                  const assignRes = await fetch(assignUrl, { method: "POST", headers: hdrs, body: JSON.stringify(assignBody) });
                  if (assignRes.ok || assignRes.status === 200 || assignRes.status === 204) {
                    results.push({
                      artifact: "Robot Account",
                      name: ra.name,
                      status: "exists",
                      message: `Creation failed (insufficient API scopes) — assigned existing tenant-level robot "${tenantRobot.UserName}" (ID: ${tenantRobot.Id}) to folder with Executor role.`,
                      id: tenantRobot.Id,
                    });
                    fallbackFound = true;
                  } else {
                    console.log(`[UiPath Deploy] Folder assignment for tenant robot failed: ${assignRes.status}`);
                  }
                } catch (assignErr: any) {
                  console.warn(`[UiPath Deploy] Folder assignment for tenant robot error: ${assignErr.message}`);
                }
              }
              if (!fallbackFound) {
                results.push({
                  artifact: "Robot Account",
                  name: ra.name,
                  status: "manual" as const,
                  message: `Creation failed (insufficient API scopes) — found tenant-level robot "${tenantRobot.UserName}" (ID: ${tenantRobot.Id}) but could not assign to folder automatically. Assign it manually: Orchestrator > Folder Settings > Assign Users > select "${tenantRobot.UserName}" with Executor role.`,
                  id: tenantRobot.Id,
                  manualSteps: [
                    `Go to Orchestrator > Folder Settings > Users`,
                    `Click "Assign Users" and search for "${tenantRobot.UserName}"`,
                    `Assign with "Executor" role`,
                    `Enable triggers in Orchestrator > Automations > Triggers`,
                  ],
                });
                fallbackFound = true;
              }
            }
          }
        } catch (tenantErr: any) {
          console.warn(`[UiPath Deploy] Tenant-level robot search failed: ${tenantErr.message}`);
        }
      }

      if (!fallbackFound) {
        results.push({
          artifact: "Robot Account",
          name: ra.name,
          status: "failed" as const,
          message: `Robot account creation failed and no existing robot accounts found to reuse. Tried: (1) Identity API robot creation, (2) OData Users API creation, (3) reuse existing folder robot, (4) assign tenant-level robot to folder. To fix: Create a robot account in Admin Portal > Tenant > Manage Access > Robot Accounts, then assign to the target folder with Executor role.`,
        });
      }
    }
  }

  return results;
}

function resolveAgentCrossReferences(
  agent: AgentDef,
  priorResults: DeploymentResult[],
): { resolvedTools: AgentToolDef[]; resolvedEscalation: AgentEscalationRule[]; resolvedContextGrounding: AgentContextGrounding | undefined; unresolvedRefs: string[] } {
  const unresolvedRefs: string[] = [];

  const processResultMap = new Map<string, { id?: number | string; status: string }>();
  for (const r of priorResults) {
    if (r.artifact === "Process" || r.artifact === "Release") {
      processResultMap.set(r.name, { id: r.id, status: r.status });
    }
  }

  const bucketResultMap = new Map<string, { id?: number | string; status: string }>();
  for (const r of priorResults) {
    if (r.artifact === "Storage Bucket") {
      bucketResultMap.set(r.name, { id: r.id, status: r.status });
    }
  }

  const acResultMap = new Map<string, { id?: number | string; status: string }>();
  for (const r of priorResults) {
    if (r.artifact === "Action Center" || r.artifact === "Task Catalog") {
      acResultMap.set(r.name, { id: r.id, status: r.status });
    }
  }

  const queueResultMap = new Map<string, { id?: number | string; status: string }>();
  for (const r of priorResults) {
    if (r.artifact === "Queue") {
      queueResultMap.set(r.name, { id: r.id, status: r.status });
    }
  }

  const resolvedTools: AgentToolDef[] = (agent.tools || []).map(tool => {
    const resolved = { ...tool };
    if (tool.processReference) {
      const proc = processResultMap.get(tool.processReference);
      if (proc?.id) {
        resolved.processReference = `${tool.processReference} (ID: ${proc.id})`;
      } else {
        const queueMatch = queueResultMap.get(tool.processReference);
        if (queueMatch?.id) {
          resolved.processReference = `${tool.processReference} (Queue ID: ${queueMatch.id})`;
        } else {
          unresolvedRefs.push(`Tool "${tool.name}" references process "${tool.processReference}" — not found in deployed artifacts`);
        }
      }
    }
    return resolved;
  });

  const resolvedEscalation: AgentEscalationRule[] = (agent.escalationRules || []).map(rule => {
    const resolved = { ...rule };
    if (rule.actionCenterCatalog) {
      const ac = acResultMap.get(rule.actionCenterCatalog);
      if (ac?.id) {
        resolved.actionCenterCatalog = `${rule.actionCenterCatalog} (ID: ${ac.id})`;
      } else {
        unresolvedRefs.push(`Escalation "${rule.condition}" references Action Center catalog "${rule.actionCenterCatalog}" — not found in deployed artifacts`);
      }
    }
    return resolved;
  });

  let resolvedContextGrounding: AgentContextGrounding | undefined;
  if (agent.contextGrounding) {
    resolvedContextGrounding = { ...agent.contextGrounding };
    if (agent.contextGrounding.storageBucket) {
      const bucket = bucketResultMap.get(agent.contextGrounding.storageBucket);
      if (bucket?.id) {
        resolvedContextGrounding.storageBucket = `${agent.contextGrounding.storageBucket} (ID: ${bucket.id})`;
      } else {
        unresolvedRefs.push(`Context grounding references storage bucket "${agent.contextGrounding.storageBucket}" — not found in deployed artifacts`);
      }
    }
  }

  return { resolvedTools, resolvedEscalation, resolvedContextGrounding, unresolvedRefs };
}

async function provisionAgentArtifacts(
  base: string,
  hdrs: Record<string, string>,
  agents?: AgentDef[],
  knowledgeBases?: KnowledgeBaseDef[],
  promptTemplates?: PromptTemplateDef[],
  priorResults?: DeploymentResult[],
): Promise<DeploymentResult[]> {
  const results: DeploymentResult[] = [];
  const hasAgents = (agents?.length || 0) > 0;
  const hasKBs = (knowledgeBases?.length || 0) > 0;
  const hasTemplates = (promptTemplates?.length || 0) > 0;

  if (!hasAgents && !hasKBs && !hasTemplates) return results;

  console.log(`[UiPath Deploy] Provisioning agent artifacts: ${agents?.length || 0} agents, ${knowledgeBases?.length || 0} knowledge bases, ${promptTemplates?.length || 0} prompt templates`);

  for (const kb of (knowledgeBases || [])) {
    const assetName = `AgentKB_${kb.name.replace(/\s+/g, "_")}`;
    const assetValue = JSON.stringify({
      name: kb.name,
      description: kb.description || "",
      documentSources: kb.documentSources || [],
      refreshFrequency: kb.refreshFrequency || "weekly",
      provisionedBy: "CannonBall",
      provisionedAt: new Date().toISOString(),
    });

    try {
      const checkRes = await uipathFetch(`${base}/odata/Assets?$filter=Name eq '${odataEscape(assetName)}'`, { method: "GET", headers: hdrs });
      const existing = isGenuineApiResponse(checkRes.text) ? JSON.parse(checkRes.text) : null;
      const existingId = existing?.value?.[0]?.Id;

      let shouldCreateKB = !existingId;

      if (existingId) {
        try {
          const putRes = await uipathFetch(`${base}/odata/Assets(${existingId})`, {
            method: "PUT",
            headers: { ...hdrs, "Content-Type": "application/json" },
            body: JSON.stringify({ Name: assetName, ValueType: "Text", StringValue: assetValue, Description: truncDesc(kb.description) }),
          });
          if (putRes.status >= 200 && putRes.status < 300) {
            results.push({ artifact: "Knowledge Base", name: kb.name, status: "updated", message: `Updated config asset "${assetName}" (ID: ${existingId})`, id: existingId });
          } else if (putRes.status === 404 || putRes.text.toLowerCase().includes("does not exist")) {
            console.log(`[UiPath Deploy] Knowledge Base "${kb.name}" PUT returned 404 (ID ${existingId} likely in different folder) — falling back to create in current folder`);
            shouldCreateKB = true;
          } else {
            results.push({ artifact: "Knowledge Base", name: kb.name, status: "failed", message: `Update failed (${putRes.status}): ${putRes.text.slice(0, 200)}`, id: existingId });
          }
        } catch (putErr: any) {
          results.push({ artifact: "Knowledge Base", name: kb.name, status: "failed", message: `Update error: ${putErr.message}`, id: existingId });
        }
      }

      if (shouldCreateKB) {
        const createRes = await uipathFetch(`${base}/odata/Assets`, {
          method: "POST",
          headers: { ...hdrs, "Content-Type": "application/json" },
          body: JSON.stringify({ Name: assetName, ValueType: "Text", StringValue: assetValue, Description: truncDesc(kb.description) }),
        });
        if (createRes.status >= 200 && createRes.status < 300) {
          const creation = isValidCreation(createRes.text);
          results.push({
            artifact: "Knowledge Base",
            name: kb.name,
            status: "in_package",
            message: `Config asset "${assetName}" created (ID: ${creation.data?.Id || "unknown"}). Knowledge base configuration included in downloadable package — see Handoff Guide for import steps.`,
            id: creation.data?.Id,
            manualSteps: [
              `Upload knowledge base documents to Storage Bucket or external source`,
              `Configure document indexing for agent retrieval`,
              ...(kb.documentSources?.map(ds => `Add source: ${ds}`) || []),
            ],
          });
        } else {
          results.push({ artifact: "Knowledge Base", name: kb.name, status: "failed", message: `Creation failed (${createRes.status}): ${createRes.text.slice(0, 200)}` });
        }
      }
    } catch (err: any) {
      results.push({ artifact: "Knowledge Base", name: kb.name, status: "failed", message: `Error: ${err.message}` });
    }
  }

  for (const pt of (promptTemplates || [])) {
    const assetName = `AgentPrompt_${pt.name.replace(/\s+/g, "_")}`;
    const assetValue = JSON.stringify({
      name: pt.name,
      template: pt.template || "",
      variables: pt.variables || [],
      provisionedBy: "CannonBall",
      provisionedAt: new Date().toISOString(),
    });

    try {
      const checkRes = await uipathFetch(`${base}/odata/Assets?$filter=Name eq '${odataEscape(assetName)}'`, { method: "GET", headers: hdrs });
      const existing = isGenuineApiResponse(checkRes.text) ? JSON.parse(checkRes.text) : null;
      const existingId = existing?.value?.[0]?.Id;

      let shouldCreatePT = !existingId;

      if (existingId) {
        try {
          const putRes = await uipathFetch(`${base}/odata/Assets(${existingId})`, {
            method: "PUT",
            headers: { ...hdrs, "Content-Type": "application/json" },
            body: JSON.stringify({ Name: assetName, ValueType: "Text", StringValue: assetValue, Description: truncDesc(pt.description) }),
          });
          if (putRes.status >= 200 && putRes.status < 300) {
            results.push({ artifact: "Prompt Template", name: pt.name, status: "updated", message: `Updated asset "${assetName}" (ID: ${existingId})`, id: existingId });
          } else if (putRes.status === 404 || putRes.text.toLowerCase().includes("does not exist")) {
            console.log(`[UiPath Deploy] Prompt Template "${pt.name}" PUT returned 404 (ID ${existingId} likely in different folder) — falling back to create in current folder`);
            shouldCreatePT = true;
          } else {
            results.push({ artifact: "Prompt Template", name: pt.name, status: "failed", message: `Update failed (${putRes.status}): ${putRes.text.slice(0, 200)}`, id: existingId });
          }
        } catch (putErr: any) {
          results.push({ artifact: "Prompt Template", name: pt.name, status: "failed", message: `Update error: ${putErr.message}`, id: existingId });
        }
      }

      if (shouldCreatePT) {
        const createRes = await uipathFetch(`${base}/odata/Assets`, {
          method: "POST",
          headers: { ...hdrs, "Content-Type": "application/json" },
          body: JSON.stringify({ Name: assetName, ValueType: "Text", StringValue: assetValue, Description: truncDesc(pt.description) }),
        });
        if (createRes.status >= 200 && createRes.status < 300) {
          const creation = isValidCreation(createRes.text);
          results.push({ artifact: "Prompt Template", name: pt.name, status: "in_package", message: `Config asset "${assetName}" created (ID: ${creation.data?.Id || "unknown"}). Prompt template included in downloadable package — see Handoff Guide for configuration steps.`, id: creation.data?.Id });
        } else {
          results.push({ artifact: "Prompt Template", name: pt.name, status: "failed", message: `Creation failed (${createRes.status}): ${createRes.text.slice(0, 200)}` });
        }
      }
    } catch (err: any) {
      results.push({ artifact: "Prompt Template", name: pt.name, status: "failed", message: `Error: ${err.message}` });
    }
  }

  for (const agent of (agents || [])) {
    const agentFileName = `Agent_${agent.name.replace(/\s+/g, "_")}.json`;

    const { resolvedTools, resolvedEscalation, unresolvedRefs } = resolveAgentCrossReferences(agent, priorResults || []);
    if (unresolvedRefs.length > 0) {
      console.warn(`[UiPath Deploy] Agent "${agent.name}" has ${unresolvedRefs.length} unresolved reference(s): ${unresolvedRefs.join("; ")}`);
    }

    console.log(`[UiPath Deploy] Agent "${agent.name}" exported as package file "${agentFileName}" for Agent Builder import`);

    const manualSteps = [
      `Import agent configuration file "${agentFileName}" into UiPath Agent Builder — type: ${agent.agentType || "autonomous"}`,
      `Review and tune the system prompt for production use`,
      ...(agent.contextGrounding?.storageBucket ? [`Populate context grounding data in storage bucket "${agent.contextGrounding.storageBucket}"`] : []),
      ...(agent.contextGrounding?.documentSources?.map(src => `Upload context grounding documents: ${src}`) || []),
      ...(agent.guardrails?.map(g => `Verify guardrail: ${g}`) || []),
      ...(agent.escalationRules?.map(r => `Verify escalation: ${r.condition} → ${r.target}${r.actionCenterCatalog ? ` (Action Center: ${r.actionCenterCatalog})` : ""}`) || []),
      ...(agent.knowledgeBases?.map(kb => `Connect knowledge base: ${kb}`) || []),
      ...(unresolvedRefs.length > 0 ? [`Resolve ${unresolvedRefs.length} unresolved cross-reference(s) manually`] : []),
    ];

    results.push({
      artifact: "Agent",
      name: agent.name,
      status: "in_package",
      message: `${agent.agentType || "autonomous"} agent configuration exported as "${agentFileName}" in deployment package for Agent Builder import. ${resolvedTools.length} tool(s), ${resolvedEscalation.length} escalation rule(s). Cross-refs: ${unresolvedRefs.length === 0 ? "all resolved" : `${unresolvedRefs.length} unresolved`}`,
      manualSteps,
    });
  }

  return results;
}

function extractReferencedMLSkillNames(artifacts: OrchestratorArtifacts, trackedMLSkillNames?: string[]): string[] {
  const names: string[] = [];
  if (trackedMLSkillNames && trackedMLSkillNames.length > 0) {
    for (const n of trackedMLSkillNames) {
      if (!names.includes(n)) names.push(n);
    }
  }

  const artifactStr = JSON.stringify(artifacts || {}).toLowerCase();
  const mlSkillPattern = /ml\s*skill[^"]*"([^"]+)"/gi;
  let match;
  while ((match = mlSkillPattern.exec(artifactStr)) !== null) {
    const candidate = match[1];
    if (candidate && !names.some(n => n.toLowerCase() === candidate.toLowerCase())) {
      names.push(candidate);
    }
  }

  return names;
}

async function provisionMaestroProcesses(
  config: UiPathConfig,
  maestroProcesses: OrchestratorArtifacts["maestroProcesses"],
  maestroAvailable: boolean,
  deployedArtifacts: DeploymentResult[],
): Promise<DeploymentResult[]> {
  if (!maestroProcesses?.length) return [];
  const results: DeploymentResult[] = [];

  if (!maestroAvailable) {
    for (const mp of maestroProcesses) {
      const crossRefSummary = (mp.crossReferences || []).map(cr => `${cr.artifactType}:${cr.artifactName}`).join(", ");
      const taskSummary = (mp.tasks || []).map(t => `${t.type}:${t.name}`).join(", ");
      const manualSteps = [
        `Import this Maestro process definition in UiPath Maestro: "${mp.name}"`,
        ...(mp.tasks || []).filter(t => t.type === "serviceTask" && t.processReference).map(t => `Wire service task "${t.name}" to Orchestrator process "${t.processReference}"`),
        ...(mp.tasks || []).filter(t => t.type === "userTask" && t.actionCenterCatalog).map(t => `Connect user task "${t.name}" to Action Center catalog "${t.actionCenterCatalog}"`),
        ...(mp.gateways || []).filter(g => g.conditions?.length).map(g => `Configure gateway "${g.name}" conditions: ${g.conditions!.map(c => c.expression).join(", ")}`),
        `Review and validate BPMN flow sequence and condition expressions before publishing`,
      ];
      results.push({
        artifact: "Maestro Process",
        name: mp.name,
        status: "in_package",
        message: `Maestro service not available on this tenant. Process definition generated with ${(mp.tasks || []).length} tasks, ${(mp.gateways || []).length} gateways, ${(mp.events || []).length} events.${crossRefSummary ? ` Cross-references: ${crossRefSummary}.` : ""} ${taskSummary ? `Tasks: ${taskSummary}.` : ""} See Developer Handoff Guide for manual import steps.`,
        manualSteps,
      });
    }
    return results;
  }

  let maestroToken: string;
  try {
    const { getMaestroToken } = await import("../uipath-auth");
    maestroToken = await getMaestroToken();
  } catch (err: any) {
    console.warn(`[UiPath Deploy] PIMS token acquisition failed: ${err.message} — falling back to in_package with manual import instructions`);
    for (const mp of maestroProcesses) {
      const crossRefSummary = (mp.crossReferences || []).map(cr => `${cr.artifactType}:${cr.artifactName}`).join(", ");
      const taskSummary = (mp.tasks || []).map(t => `${t.type}:${t.name}`).join(", ");
      const manualSteps = [
        `Import this Maestro process definition in UiPath Maestro: "${mp.name}"`,
        ...(mp.tasks || []).filter(t => t.type === "serviceTask" && t.processReference).map(t => `Wire service task "${t.name}" to Orchestrator process "${t.processReference}"`),
        ...(mp.tasks || []).filter(t => t.type === "userTask" && t.actionCenterCatalog).map(t => `Connect user task "${t.name}" to Action Center catalog "${t.actionCenterCatalog}"`),
        ...(mp.gateways || []).filter(g => g.conditions?.length).map(g => `Configure gateway "${g.name}" conditions: ${g.conditions!.map(c => c.expression).join(", ")}`),
        `Review and validate BPMN flow sequence and condition expressions before publishing`,
      ];
      results.push({
        artifact: "Maestro Process",
        name: mp.name,
        status: "in_package",
        message: `PIMS token not available (${err.message}). Process definition generated with ${(mp.tasks || []).length} tasks, ${(mp.gateways || []).length} gateways, ${(mp.events || []).length} events.${crossRefSummary ? ` Cross-references: ${crossRefSummary}.` : ""} ${taskSummary ? `Tasks: ${taskSummary}.` : ""} See Developer Handoff Guide for manual import steps.`,
        manualSteps,
      });
    }
    return results;
  }

  const maestroBase = metadataService.getServiceUrl("PIMS", config);
  const maestroHdrs: Record<string, string> = {
    Authorization: `Bearer ${maestroToken}`,
    "Content-Type": "application/json",
  };

  const wiredArtifactTypes = new Set(["Trigger", "Queue", "Asset", "Process", "Release", "Action Center Catalog", "Action Center Task Catalog"]);
  const processIdMap = new Map<string, number | string>();
  const actionCenterCatalogIdMap = new Map<string, number | string>();
  const queueIdMap = new Map<string, number | string>();
  for (const dr of deployedArtifacts) {
    if (dr.id && (dr.status === "created" || dr.status === "exists" || dr.status === "updated") && wiredArtifactTypes.has(dr.artifact)) {
      processIdMap.set(dr.name, dr.id);
      if (dr.artifact === "Action Center Catalog" || dr.artifact === "Action Center Task Catalog") {
        actionCenterCatalogIdMap.set(dr.name, dr.id);
      }
      if (dr.artifact === "Queue") {
        queueIdMap.set(dr.name, dr.id);
      }
    }
  }

  for (const mp of maestroProcesses) {
    try {
      const resolvedTasks = (mp.tasks || []).map(t => {
        const resolved: Record<string, any> = {
          id: t.id,
          name: t.name,
          type: t.type,
          description: t.description || "",
        };
        if (t.type === "serviceTask" && t.processReference) {
          resolved.processReference = t.processReference;
          const refId = processIdMap.get(t.processReference);
          if (refId) resolved.processReferenceId = refId;
        }
        if (t.type === "userTask") {
          if (t.actionCenterCatalog) {
            resolved.actionCenterCatalog = t.actionCenterCatalog;
            const catalogId = actionCenterCatalogIdMap.get(t.actionCenterCatalog);
            if (catalogId) resolved.actionCenterCatalogId = catalogId;
          }
          if (t.formFields) resolved.formFields = t.formFields;
        }
        return resolved;
      });

      const processDefBody = {
        name: mp.name,
        description: truncDesc(mp.description),
        definition: {
          tasks: resolvedTasks,
          gateways: (mp.gateways || []).map(g => ({
            id: g.id,
            name: g.name,
            type: g.type,
            conditions: g.conditions || [],
          })),
          events: (mp.events || []).map(e => ({
            id: e.id,
            name: e.name,
            type: e.type,
            trigger: e.trigger || "none",
            timerDefinition: e.timerDefinition,
            description: e.description || "",
          })),
          sequenceFlows: (mp.sequenceFlows || []).map(sf => ({
            id: sf.id,
            sourceRef: sf.sourceRef,
            targetRef: sf.targetRef,
            conditionExpression: sf.conditionExpression,
            label: sf.label,
          })),
        },
        crossReferences: (mp.crossReferences || []).map(cr => {
          const resolved: Record<string, any> = { ...cr };
          if (cr.artifactName) {
            const resolvedId = processIdMap.get(cr.artifactName) || actionCenterCatalogIdMap.get(cr.artifactName) || queueIdMap.get(cr.artifactName);
            if (resolvedId) resolved.resolvedId = resolvedId;
          }
          return resolved;
        }),
        provisionedBy: "CannonBall",
        provisionedAt: new Date().toISOString(),
      };

      const checkRes = await fetch(`${maestroBase}/api/v1/process-definitions?$filter=name eq '${odataEscape(mp.name)}'&$top=1`, {
        headers: maestroHdrs,
      }).catch(() => null);

      let existingId: string | number | null = null;
      if (checkRes && checkRes.ok) {
        try {
          const checkData = await checkRes.json();
          if (checkData.value?.length > 0 || (Array.isArray(checkData) && checkData.length > 0)) {
            const existing = checkData.value?.[0] || checkData[0];
            existingId = existing.id || existing.Id;
          }
        } catch (e: any) { console.warn(`[UiPath Deploy] Maestro existing process check failed: ${e.message}`); }
      }

      if (existingId) {
        const putRes = await fetch(`${maestroBase}/api/v1/process-definitions/${existingId}`, {
          method: "PUT",
          headers: maestroHdrs,
          body: JSON.stringify(processDefBody),
        });
        const putText = await putRes.text();
        console.log(`[UiPath Deploy] Maestro process "${mp.name}" UPDATE -> ${putRes.status}: ${putText.slice(0, 500)}`);

        if (putRes.ok) {
          results.push({ artifact: "Maestro Process", name: mp.name, status: "updated", message: `Updated existing Maestro process definition (ID: ${existingId})`, id: existingId });
        } else {
          results.push({ artifact: "Maestro Process", name: mp.name, status: "failed", message: `Update failed: ${sanitizeErrorMessage(putRes.status, putText)}`, id: existingId });
        }
      } else {
        const createRes = await fetch(`${maestroBase}/api/v1/process-definitions`, {
          method: "POST",
          headers: maestroHdrs,
          body: JSON.stringify(processDefBody),
        });
        const createText = await createRes.text();
        console.log(`[UiPath Deploy] Maestro process "${mp.name}" CREATE -> ${createRes.status}: ${createText.slice(0, 500)}`);

        if (createRes.ok || createRes.status === 201) {
          let createdId: string | number | undefined;
          try {
            const created = JSON.parse(createText);
            createdId = created.id || created.Id;
          } catch (e: any) { /* Maestro create response parse - non-critical */ }
          results.push({
            artifact: "Maestro Process",
            name: mp.name,
            status: "created",
            message: `Created Maestro process definition${createdId ? ` (ID: ${createdId})` : ""} with ${resolvedTasks.length} tasks, ${(mp.gateways || []).length} gateways, ${(mp.events || []).length} events`,
            id: typeof createdId === "string" ? Number.parseInt(createdId, 10) : createdId,
          });
        } else if (createRes.status === 409 || createText.includes("already exists")) {
          results.push({ artifact: "Maestro Process", name: mp.name, status: "exists", message: "Process definition already exists in Maestro" });
        } else {
          results.push({ artifact: "Maestro Process", name: mp.name, status: "failed", message: sanitizeErrorMessage(createRes.status, createText) });
        }
      }
    } catch (err: any) {
      results.push({ artifact: "Maestro Process", name: mp.name, status: "failed", message: `Error: ${err.message}` });
    }
  }

  return results;
}

export async function deployAllArtifacts(
  artifacts: OrchestratorArtifacts,
  releaseId: number | null,
  releaseKey: string | null,
  releaseName: string | null = null,
  onProgress?: (step: string) => void,
  trackedMLSkillNames?: string[]
): Promise<{
  results: DeploymentResult[];
  summary: string;
  serviceLimitations?: Array<{ service: string; status: "limited" | "unavailable" | "unknown"; reason: string }>;
  testManagerContext?: {
    projectId: string;
    projectName: string;
    projectPrefix: string | null;
    activeTmBase: string;
    testCases: Array<{ name: string; id: string; objKey: string | null }>;
  };
}> {
  const config = await getUiPathConfig();
  if (!config) {
    return { results: [], summary: "UiPath is not configured." };
  }

  const allResults: DeploymentResult[] = [];

  try {
    const token = await getAccessToken(config);
    const base = orchBase(config);
    const hdrs = headers(config, token);

    console.log(`[UiPath Deploy] Starting full deployment with pre-flight infrastructure probe...`);
    onProgress?.("Validating folder and release...");

    const validation = await verifyFolderAndRelease(base, hdrs, releaseId, config.folderId);
    if (!validation.valid) {
      console.error(`[UiPath Deploy] Pre-deployment validation failed: ${validation.message}`);
      return { results: [], summary: `Pre-deployment validation failed: ${validation.message}` };
    }
    if (validation.releaseKey) releaseKey = validation.releaseKey;
    if (validation.releaseName) releaseName = validation.releaseName;

    onProgress?.("Probing service availability...");
    let svcAvail: ServiceAvailabilityMap | null = null;
    try {
      svcAvail = await probeServiceAvailability();
      console.log(`[UiPath Deploy] Service availability: AC=${svcAvail.actionCenter}, TM=${svcAvail.testManager}, DU=${svcAvail.documentUnderstanding}, GenExtract=${svcAvail.generativeExtraction}, CommsMining=${svcAvail.communicationsMining}, DS=${svcAvail.dataService}, PM=${svcAvail.platformManagement}, Env=${svcAvail.environments}, Trig=${svcAvail.triggers}, Agents=${svcAvail.agents}, AI=${svcAvail.aiCenter}, Maestro=${svcAvail.maestro}`);
    } catch (e: any) { console.warn(`[UiPath Deploy] Service availability probe failed (non-critical): ${e.message}`); }

    const referencedSkillNames = extractReferencedMLSkillNames(artifacts, trackedMLSkillNames);
    if (referencedSkillNames.length > 0 && svcAvail?.aiCenter && svcAvail.aiCenterSkills && svcAvail.aiCenterSkills.length > 0) {
      onProgress?.(`Validating ${referencedSkillNames.length} referenced AI Center ML Skill(s)...`);
      const deployed: string[] = [];
      const notDeployed: string[] = [];
      for (const refName of referencedSkillNames) {
        const matchedSkill = svcAvail.aiCenterSkills.find(s => s.name.toLowerCase() === refName.toLowerCase());
        if (!matchedSkill) {
          notDeployed.push(`${refName} [not found on tenant]`);
          allResults.push({
            artifact: "AI Skill Validation",
            name: refName,
            status: "failed",
            message: `Referenced ML Skill "${refName}" was not found on the tenant. Create and deploy it in AI Center.`,
          });
          onProgress?.(`AI Skill "${refName}" — NOT found on tenant`);
          continue;
        }
        const statusLower = matchedSkill.status.toLowerCase();
        const isDeployed = statusLower === "deployed" || statusLower === "available";
        if (isDeployed) {
          deployed.push(matchedSkill.name);
        } else {
          notDeployed.push(`${matchedSkill.name} [${matchedSkill.status}]`);
        }
        allResults.push({
          artifact: "AI Skill Validation",
          name: matchedSkill.name,
          status: isDeployed ? "exists" : "failed",
          message: isDeployed
            ? `Referenced ML Skill "${matchedSkill.name}" is deployed and accessible (package: ${matchedSkill.mlPackageName || "N/A"}, input: ${matchedSkill.inputType || "N/A"}, output: ${matchedSkill.outputType || "N/A"})`
            : `Referenced ML Skill "${matchedSkill.name}" is NOT deployed (status: ${matchedSkill.status}). Deploy it in AI Center before the automation can invoke it.`,
        });
        onProgress?.(`AI Skill "${matchedSkill.name}" — ${isDeployed ? "deployed" : "NOT deployed (" + matchedSkill.status + ")"}`);
      }
      console.log(`[UiPath Deploy] AI Center validation (referenced only): ${deployed.length} deployed (${deployed.join(", ")}), ${notDeployed.length} not deployed (${notDeployed.join(", ")})`);
    } else if (referencedSkillNames.length > 0 && svcAvail && !svcAvail.aiCenter) {
      for (const refName of referencedSkillNames) {
        allResults.push({
          artifact: "AI Skill Validation",
          name: refName,
          status: "failed",
          message: `Referenced ML Skill "${refName}" cannot be validated — AI Center is not accessible on this tenant.`,
        });
      }
      console.log("[UiPath Deploy] AI Center not available but XAML references ML Skills — validation failed");
    } else if (referencedSkillNames.length === 0) {
      console.log("[UiPath Deploy] No ML Skills referenced in artifacts — skipping AI Center validation");
    }

    onProgress?.("Running infrastructure probe...");
    const infraProbe = await preflightInfraProbe(base, hdrs, config.folderId, config, svcAvail);
    const infraResults = formatInfraProbeResults(infraProbe);
    allResults.push(...infraResults);

    onProgress?.("Detecting runtime strategy...");
    const earlyInfraData: PreFetchedInfraData = { machines: infraProbe.machines, sessions: infraProbe.sessions, robots: infraProbe.robots };
    const earlyRuntimeCheck = await detectAvailableRuntimeType(base, hdrs, earlyInfraData);

    const useServerless = earlyRuntimeCheck.hasServerless;

    if (useServerless) {
      console.log(`[UiPath Deploy] Runtime strategy: Serverless detected — auto-selecting Serverless (zero config), skipping machine template and robot account provisioning`);
    } else if (earlyRuntimeCheck.verified && earlyRuntimeCheck.hasUnattendedSlots) {
      console.log(`[UiPath Deploy] Runtime strategy: Unattended runtime already verified in folder`);
    } else {
      console.log(`[UiPath Deploy] Runtime strategy: Unattended — will provision machine templates and robot accounts`);
    }

    onProgress?.("Provisioning infrastructure artifacts...");
    const skipMachines = useServerless;
    const skipRobots = useServerless;
    const [queueResults, bucketResults, assetResults, machineResults, envResults, robotResults] = await Promise.all([
      provisionQueues(base, hdrs, artifacts.queues),
      provisionStorageBuckets(base, hdrs, artifacts.storageBuckets),
      provisionAssets(base, hdrs, artifacts.assets),
      skipMachines
        ? Promise.resolve([{ artifact: "Machine Template", name: `${(artifacts.machines || []).length || 0} machine(s)`, status: "skipped" as const, message: "Serverless runtime detected — machine template provisioning not required. Machines are auto-managed by the cloud infrastructure." }])
        : provisionMachines(base, hdrs, artifacts.machines),
      (svcAvail && !svcAvail.environments && (artifacts.environments?.length || 0) > 0)
        ? Promise.resolve([{ artifact: "Environment", name: `${artifacts.environments!.length} environment(s)`, status: "skipped" as const, message: "Environments API not available on modern folder tenants (deprecated Oct 2023). Modern folders use machine templates and runtime slots instead. No action needed." }])
        : provisionEnvironments(base, hdrs, artifacts.environments),
      skipRobots
        ? Promise.resolve((artifacts.robotAccounts || []).length > 0 ? [{ artifact: "Robot Account", name: `${artifacts.robotAccounts!.length} robot account(s)`, status: "skipped" as const, message: "Serverless runtime detected — robot account provisioning not required. Jobs execute in cloud-managed Serverless containers." }] : [])
        : provisionRobotAccounts(base, hdrs, config, artifacts.robotAccounts, infraProbe),
    ]);
    allResults.push(...queueResults, ...bucketResults, ...assetResults, ...machineResults, ...envResults, ...robotResults);
    for (const r of [...queueResults, ...bucketResults, ...assetResults, ...machineResults, ...envResults, ...robotResults]) {
      onProgress?.(`${r.artifact} "${r.name}" — ${r.status}`);
    }

    onProgress?.("Verifying execution readiness...");
    let runtimeCheck: RuntimeDetectionResult;
    if (useServerless) {
      runtimeCheck = { ...earlyRuntimeCheck, runtimeType: "Serverless", verified: true, hasServerless: true };
    } else {
      const postProvisionProbe = await preflightInfraProbe(base, hdrs, config.folderId, config, svcAvail);
      const freshInfraData: PreFetchedInfraData = { machines: postProvisionProbe.machines, sessions: postProvisionProbe.sessions, robots: postProvisionProbe.robots };
      runtimeCheck = await detectAvailableRuntimeType(base, hdrs, freshInfraData);

      if (!runtimeCheck.verified || (!runtimeCheck.hasUnattendedSlots && !runtimeCheck.hasServerless)) {
        console.log(`[UiPath Deploy] Post-provisioning runtime check failed — attempting remediation re-check`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        const remediationCheck = await detectAvailableRuntimeType(base, hdrs);
        if (remediationCheck.verified && (remediationCheck.hasUnattendedSlots || remediationCheck.hasServerless)) {
          console.log(`[UiPath Deploy] Remediation re-check succeeded: runtime type "${remediationCheck.runtimeType}" now verified`);
          runtimeCheck = remediationCheck;
        } else {
          console.log(`[UiPath Deploy] Remediation re-check also failed — triggers will be created DISABLED`);
        }
      }
    }

    const executionReady = runtimeCheck.verified && (runtimeCheck.hasUnattendedSlots || runtimeCheck.hasServerless);
    const runtimeDiagnostics: string[] = [];

    if (executionReady) {
      if (runtimeCheck.runtimeType === "Serverless") {
        runtimeDiagnostics.push("Serverless runtime verified");
        runtimeDiagnostics.push("Triggers will be created ENABLED with RuntimeType \"Serverless\"");
        runtimeDiagnostics.push("Jobs will execute in cloud-managed containers — no machine or robot configuration needed");
      } else {
        runtimeDiagnostics.push(`${runtimeCheck.runtimeType} runtime verified`);
        runtimeDiagnostics.push(`Triggers will be created ENABLED with RuntimeType "${runtimeCheck.runtimeType}"`);
        runtimeDiagnostics.push("Jobs will execute on machine templates with Unattended slots in this folder");
      }
    } else {
      runtimeDiagnostics.push("No verified runtime detected after provisioning");
      const machineCreated = machineResults.some(r => r.status === "created" || r.status === "exists");
      const robotCreated = robotResults.some(r => r.status === "created" || r.status === "exists");
      const robotFailed = robotResults.some(r => r.status === "failed");
      const robotManual = robotResults.some(r => r.status === "manual");
      if (!machineCreated) runtimeDiagnostics.push("Issue: No machine template with Unattended slots found in folder");
      if (machineCreated && !robotCreated) runtimeDiagnostics.push("Issue: Machine template exists but no robot account is assigned to the folder");
      if (robotFailed) runtimeDiagnostics.push("Issue: Robot account creation failed — assign a robot account manually in Admin Portal > Tenant > Manage Access > Robot Accounts");
      if (robotManual) runtimeDiagnostics.push("Issue: A tenant-level robot account was found but needs manual assignment to this folder — see Robot Account manual steps above");
      runtimeDiagnostics.push("Triggers will be created DISABLED until a working Unattended runtime is configured");
    }

    allResults.push({
      artifact: "Runtime Check",
      name: `${runtimeCheck.runtimeType} Runtime`,
      status: executionReady ? "exists" : "failed",
      message: runtimeDiagnostics.join(". ") + ".",
    });

    onProgress?.("Provisioning services and test infrastructure...");

    const triggerPromise = (svcAvail && !svcAvail.triggers && (artifacts.triggers?.length || 0) > 0)
      ? Promise.resolve([{ artifact: "Trigger", name: `${artifacts.triggers!.length} trigger(s)`, status: "skipped" as const, message: "Triggers API not available on this tenant." }])
      : provisionTriggers(base, hdrs, artifacts.triggers, releaseId, releaseKey, releaseName, queueResults, runtimeCheck);

    if ((artifacts.actionCenter?.length || 0) > 0) {
      if (svcAvail && !svcAvail.actionCenter) {
        console.log("[UiPath Deploy] Probe says Action Center unavailable, but attempting provisioning anyway...");
      }
      console.log(`[UiPath Deploy] Provisioning ${artifacts.actionCenter!.length} Action Center task catalog(s): ${artifacts.actionCenter!.map(a => a.taskCatalog).join(", ")}`);
    } else {
      console.log("[UiPath Deploy] No Action Center artifacts extracted from SDD — skipping AC provisioning");
    }
    if (svcAvail && !svcAvail.documentUnderstanding && (artifacts.documentUnderstanding?.length || 0) > 0) {
      console.log("[UiPath Deploy] Probe says DU unavailable, but attempting provisioning anyway...");
    }
    if ((artifacts.communicationsMining?.length || 0) > 0) {
      if (svcAvail && !svcAvail.communicationsMining) {
        console.log("[UiPath Deploy] Probe says Communications Mining unavailable, but attempting provisioning anyway...");
      }
      console.log(`[UiPath Deploy] Provisioning ${artifacts.communicationsMining!.length} Communications Mining stream(s): ${artifacts.communicationsMining!.map(s => s.name).join(", ")}`);
    }
    if (svcAvail && !svcAvail.testManager && ((artifacts.testCases?.length || 0) > 0 || (artifacts.testDataQueues?.length || 0) > 0)) {
      console.log("[UiPath Deploy] Probe says Test Manager unavailable, but attempting provisioning anyway...");
    }
    if ((artifacts.dataFabricEntities?.length || 0) > 0) {
      console.log(`[UiPath Deploy] Provisioning ${artifacts.dataFabricEntities!.length} Data Fabric entity(ies): ${artifacts.dataFabricEntities!.map(e => e.name).join(", ")}`);
    }
    if ((artifacts.apps?.length || 0) > 0) {
      console.log(`[UiPath Deploy] Discovering/referencing ${artifacts.apps!.length} App(s): ${artifacts.apps!.map(a => a.name).join(", ")}`);
    }

    const [triggerResults, actionCenterResults, duResults, cmResults, testProvision, dfResults, appResults] = await Promise.all([
      triggerPromise,
      provisionActionCenter(base, hdrs, artifacts.actionCenter, config),
      provisionDocUnderstanding(config, token, artifacts.documentUnderstanding),
      provisionCommunicationsMining(config, token, artifacts.communicationsMining),
      provisionTestCases(config, token, artifacts.testCases, releaseName || "Automation", artifacts.testDataQueues, config.folderId),
      provisionDataFabricEntities(config, token, artifacts.dataFabricEntities, svcAvail?.dataService),
      discoverAndReferenceApps(config, token, artifacts.apps),
    ]);
    allResults.push(...triggerResults, ...actionCenterResults, ...duResults, ...cmResults, ...testProvision.results, ...dfResults, ...appResults);
    for (const r of [...triggerResults, ...actionCenterResults, ...duResults, ...cmResults, ...testProvision.results, ...dfResults, ...appResults]) {
      onProgress?.(`${r.artifact} "${r.name}" — ${r.status}`);
    }

    onProgress?.("Provisioning agent configurations...");
    const agentResults = await provisionAgentArtifacts(base, hdrs, artifacts.agents, artifacts.knowledgeBases, artifacts.promptTemplates, allResults);
    allResults.push(...agentResults);
    for (const r of agentResults) {
      onProgress?.(`${r.artifact} "${r.name}" — ${r.status}`);
    }

    if (testProvision.activeTmBase && testProvision.projectId) {
      onProgress?.("Provisioning test sets and requirements...");
      const [reqProvision, testSetResults] = await Promise.all([
        provisionRequirements(
          testProvision.activeTmBase, testProvision.tmHdrs, testProvision.projectId,
          artifacts.requirements, config.tenantName,
        ),
        provisionTestSets(
          testProvision.activeTmBase, testProvision.tmHdrs, testProvision.projectId,
          artifacts.testSets, testProvision.testCaseMap, config.tenantName,
        ),
      ]);
      allResults.push(...reqProvision.results, ...testSetResults);
      for (const r of [...reqProvision.results, ...testSetResults]) onProgress?.(`${r.artifact} "${r.name}" — ${r.status}`);

      if (Object.keys(reqProvision.requirementMap).length > 0 && Object.keys(testProvision.testCaseMap).length > 0) {
        onProgress?.("Linking requirements to test cases...");
        const linkResults = await linkRequirementsToTestCases(
          testProvision.activeTmBase, testProvision.tmHdrs, testProvision.projectId,
          reqProvision.requirementMap, testProvision.testCaseMap, config.tenantName,
        );
        allResults.push(...linkResults);
      }
    } else if ((artifacts.requirements?.length || 0) > 0 || (artifacts.testSets?.length || 0) > 0) {
      if (artifacts.requirements?.length) {
        allResults.push({ artifact: "Requirement", name: `${artifacts.requirements.length} requirement(s)`, status: "skipped", message: "Test Manager project not available — requirements require an active TM project" });
      }
      if (artifacts.testSets?.length) {
        allResults.push({ artifact: "Test Set", name: `${artifacts.testSets.length} test set(s)`, status: "skipped", message: "Test Manager project not available — test sets require an active TM project" });
      }
    }

    if ((artifacts.maestroProcesses?.length || 0) > 0) {
      onProgress?.("Provisioning Maestro process definitions...");
      const maestroAvailable = svcAvail?.maestro ?? false;
      console.log(`[UiPath Deploy] Provisioning ${artifacts.maestroProcesses!.length} Maestro process definition(s), service available: ${maestroAvailable}`);
      const maestroResults = await provisionMaestroProcesses(config, artifacts.maestroProcesses, maestroAvailable, allResults);
      allResults.push(...maestroResults);
      for (const r of maestroResults) {
        onProgress?.(`${r.artifact} "${r.name}" — ${r.status}`);
      }
    }

    const created = allResults.filter(r => r.status === "created").length;
    const updated = allResults.filter(r => r.status === "updated").length;
    const existed = allResults.filter(r => r.status === "exists").length;
    const failed = allResults.filter(r => r.status === "failed").length;
    const skipped = allResults.filter(r => r.status === "skipped").length;
    const inPackage = allResults.filter(r => r.status === "in_package").length;

    let summary = `Deployment complete: ${created} created, ${updated} updated, ${existed} already existed`;
    if (inPackage > 0) summary += `, ${inPackage} in downloadable package`;
    if (skipped > 0) summary += `, ${skipped} skipped (service unavailable)`;
    if (failed > 0) summary += `, ${failed} failed`;

    console.log(`[UiPath Deploy] ${summary}`);

    const serviceLimitations: Array<{ service: string; status: "limited" | "unavailable" | "unknown"; reason: string }> = [];
    if (svcAvail?.serviceDetails) {
      const SERVICE_LABELS: Record<string, string> = {
        orchestrator: "Orchestrator", actionCenter: "Action Center", testManager: "Test Manager",
        documentUnderstanding: "Document Understanding", generativeExtraction: "Generative Extraction",
        communicationsMining: "Communications Mining", dataService: "Data Service",
        agents: "Agents", maestro: "Maestro", integrationService: "Integration Service",
        aiCenter: "AI Center", apps: "Apps",
      };
      const SERVICE_TO_ARTIFACT_CHECK: Record<string, () => boolean> = {
        orchestrator: () => true,
        actionCenter: () => (artifacts.actionCenter?.length || 0) > 0,
        testManager: () => (artifacts.testCases?.length || 0) > 0 || (artifacts.testSets?.length || 0) > 0 || (artifacts.requirements?.length || 0) > 0,
        documentUnderstanding: () => (artifacts.documentUnderstanding?.length || 0) > 0,
        generativeExtraction: () => (artifacts.documentUnderstanding?.length || 0) > 0,
        communicationsMining: () => (artifacts.communicationsMining?.length || 0) > 0,
        dataService: () => (artifacts.dataFabricEntities?.length || 0) > 0,
        agents: () => (artifacts.agents?.length || 0) > 0,
        maestro: () => (artifacts.maestroProcesses?.length || 0) > 0,
        integrationService: () => false,
        aiCenter: () => false,
        apps: () => (artifacts.apps?.length || 0) > 0,
      };
      for (const [key, detail] of Object.entries(svcAvail.serviceDetails)) {
        if (detail.status === "limited" || detail.status === "unavailable" || detail.status === "unknown") {
          const hasArtifacts = SERVICE_TO_ARTIFACT_CHECK[key];
          if (hasArtifacts !== undefined && !hasArtifacts()) continue;
          if (hasArtifacts === undefined) continue;
          const label = SERVICE_LABELS[key] || key;
          serviceLimitations.push({
            service: label,
            status: detail.status === "unknown" ? "unknown" : detail.status,
            reason: detail.status === "limited"
              ? `Detected with limited confidence (${detail.evidence})`
              : detail.status === "unavailable"
                ? `Not reachable on this tenant (${detail.evidence})`
                : `Could not determine availability (${detail.evidence})`,
          });
        }
      }
    }

    const testManagerContext = testProvision.activeTmBase && testProvision.projectId
      ? {
          projectId: String(testProvision.projectId),
          projectName: testProvision.projectName || releaseName || "Automation",
          projectPrefix: testProvision.projectPrefix,
          activeTmBase: testProvision.activeTmBase,
          testCases: Object.entries(testProvision.testCaseLinks).map(([name, link]) => ({
            name,
            id: String(link.id),
            objKey: link.objKey,
          })),
        }
      : undefined;

    return {
      results: allResults,
      summary,
      serviceLimitations: serviceLimitations.length > 0 ? serviceLimitations : undefined,
      testManagerContext,
    };
  } catch (err: any) {
    console.error(`[UiPath Deploy] Fatal error:`, err.message);
    return { results: allResults, summary: `Deployment failed: ${err.message}` };
  }
}

export function formatDeploymentReport(results: DeploymentResult[]): string {
  if (results.length === 0) return "";

  const lines: string[] = ["\n---\n**Orchestrator Deployment Report**\n"];

  const infraResults = results.filter(r => r.artifact === "Infrastructure");
  const runtimeChecks = results.filter(r => r.artifact === "Runtime Check");
  const deployResults = results.filter(r => r.artifact !== "Runtime Check" && r.artifact !== "Infrastructure");

  const statusIcon = (s: string) => {
    switch (s) {
      case "created": return "✅";
      case "exists": return "🔵";
      case "updated": return "🔄";
      case "in_package": return "📦";
      case "skipped": return "⚠️";
      case "manual": return "🔧";
      case "failed": return "❌";
      default: return "•";
    }
  };

  if (infraResults.length > 0) {
    lines.push("**Pre-flight Infrastructure Check:**");
    for (const ir of infraResults) {
      lines.push(`${statusIcon(ir.status)} ${ir.name} — ${ir.message}`);
    }
    lines.push("");
  }

  if (runtimeChecks.length > 0) {
    for (const rc of runtimeChecks) {
      if (rc.status === "exists") {
        lines.push(`✅ **Runtime Strategy: ${rc.name}** — ${rc.message}`);
        lines.push("");
      } else if (rc.status === "failed") {
        lines.push(`⚠️ **Runtime Configuration Issue:** ${rc.message}`);
        lines.push(`> Triggers have been created DISABLED. To enable unattended execution:`);
        lines.push(`> 1. Go to Orchestrator > your folder > Machine Templates — ensure at least one template has Unattended slots`);
        lines.push(`> 2. Go to Admin Portal > Tenant > Manage Access > Robot Accounts — ensure a robot account exists and is assigned to this folder`);
        lines.push(`> 3. Verify the robot account appears in Orchestrator > Folder Settings > Users with Executor role`);
        lines.push(`> 4. Enable the triggers in Orchestrator > Automations > Triggers`);
        lines.push("");
      }
    }
  }

  const grouped: Record<string, DeploymentResult[]> = {};
  for (const r of deployResults) {
    if (!grouped[r.artifact]) grouped[r.artifact] = [];
    grouped[r.artifact].push(r);
  }

  for (const [artifact, items] of Object.entries(grouped)) {
    lines.push(`**${artifact}s:**`);
    for (const item of items) {
      lines.push(`${statusIcon(item.status)} ${item.name} — ${item.message}`);
      if (item.status === "manual" && item.manualSteps?.length) {
        lines.push(`  **Manual Setup Steps:**`);
        for (let i = 0; i < item.manualSteps.length; i++) {
          lines.push(`  ${i + 1}. ${item.manualSteps[i]}`);
        }
      }
    }
    lines.push("");
  }

  const created = deployResults.filter(r => r.status === "created").length;
  const failed = deployResults.filter(r => r.status === "failed").length;
  const skipped = deployResults.filter(r => r.status === "skipped").length;
  const manual = deployResults.filter(r => r.status === "manual").length;
  const hasRuntimeIssue = runtimeChecks.some(r => r.status === "failed");

  if (failed > 0) {
    lines.push(`**${failed} item(s) failed** — check permissions and retry from Orchestrator.`);
  }
  if (manual > 0) {
    lines.push(`**${manual} item(s) require manual setup** — expand each item above for step-by-step instructions.`);
  }
  if (skipped > 0) {
    lines.push(`**${skipped} item(s) skipped** — these services are not available on your tenant.`);
  }
  const hasServerlessRuntime = runtimeChecks.some(r => r.status === "exists" && r.name.includes("Serverless"));
  const hasVerifiedRuntime = runtimeChecks.some(r => r.status === "exists");

  if (hasRuntimeIssue) {
    lines.push("**Action Required:** No verified runtime detected. See the Runtime Configuration Issue above for step-by-step remediation.");
  }
  if (created > 0 && failed === 0 && skipped === 0 && manual === 0 && !hasRuntimeIssue && hasVerifiedRuntime) {
    if (hasServerlessRuntime) {
      lines.push("**Automation is execution-ready** — all artifacts provisioned, triggers are ENABLED with Serverless runtime, and jobs will fire on schedule.");
    } else {
      lines.push("**Automation is execution-ready** — all artifacts provisioned, triggers are ENABLED, and jobs will fire on schedule.");
    }
  } else if (created > 0 && failed === 0 && !hasRuntimeIssue) {
    const readyNote = hasVerifiedRuntime ? " Automation is execution-ready — triggers are ENABLED and will fire on schedule." : "";
    lines.push("Core artifacts provisioned successfully." + (manual > 0 ? " Manual items have step-by-step instructions above." : "") + (skipped > 0 ? " Skipped items are not available on your tenant." : "") + readyNote);
  }

  return lines.join("\n");
}

