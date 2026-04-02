import { db } from "./db";
import { appSettings, uipathConnections } from "@shared/schema";
import { eq } from "drizzle-orm";
import { metadataService, TOKEN_RESOURCE_TO_SERVICE } from "./catalog/metadata-service";
import type { ServiceResourceType } from "./catalog/metadata-schemas";

export class UiPathAuthError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = "UiPathAuthError";
  }
}

export type UiPathAuthConfig = {
  orgName: string;
  tenantName: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  folderId?: string;
  folderName?: string;
};

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

export type ResourceType = "OR" | "TM" | "DU" | "PM" | "DF" | "PIMS" | "IXP" | "AI";

const TOKEN_REFRESH_BUFFER_MS = 60_000;

function getTokenEndpoint(): string {
  return metadataService.getTokenEndpoint();
}

function getResourceScopesFromMetadata(resource: ResourceType): string {
  const serviceType = (TOKEN_RESOURCE_TO_SERVICE[resource] || resource) as ServiceResourceType;
  return metadataService.getMinimalScopesForServiceString(serviceType);
}

export function getDefaultOrScopes(): string {
  // UiPath confidential apps with tenant/folder role assignments authenticate
  // reliably with OR.Default for Orchestrator access.
  return "OR.Default";
}

function dedupeScopes(scopes: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const scope of scopes.map((s) => s.trim()).filter(Boolean)) {
    if (!seen.has(scope)) {
      seen.add(scope);
      result.push(scope);
    }
  }
  return result;
}

function buildOrScopeCandidates(scopeString: string): string[] {
  const requested = dedupeScopes(scopeString.split(/\s+/));
  const candidates: string[] = [];
  const requestedJoined = requested.join(" ");

  if (requested.includes("OR.Default")) {
    candidates.push("OR.Default");
  } else if (requested.some((scope) => scope.startsWith("OR."))) {
    candidates.push("OR.Default", requestedJoined);
  } else if (requestedJoined) {
    candidates.push(requestedJoined);
  } else {
    candidates.push("OR.Default");
  }

  const metadataScopes = getResourceScopesFromMetadata("OR");
  if (metadataScopes && !candidates.includes(metadataScopes)) {
    candidates.push(metadataScopes);
  }

  return candidates.filter(Boolean);
}

let cachedConfig: UiPathAuthConfig | null = null;
const tokenCache: Partial<Record<ResourceType, CachedToken>> = {};
let configLoadedAt = 0;
const CONFIG_TTL_MS = 30_000;

export function getConfigLoadedAt(): number {
  return configLoadedAt;
}

function maskClientId(clientId: string): string {
  if (clientId.length <= 6) return clientId;
  return clientId.slice(0, 6) + "..." + "*".repeat(4);
}

async function loadConfig(): Promise<UiPathAuthConfig | null> {
  const now = Date.now();
  if (cachedConfig && now - configLoadedAt < CONFIG_TTL_MS) {
    return cachedConfig;
  }

  const activeRows = await db.select().from(uipathConnections).where(eq(uipathConnections.isActive, true));
  if (activeRows.length > 0) {
    const row = activeRows[0];
    let scopes = (row.scopes && row.scopes.trim()) ? row.scopes.trim() : "";
    if (!scopes) {
      const settingsRows = await db.select().from(appSettings).where(eq(appSettings.key, "uipath_scopes"));
      if (settingsRows.length > 0 && settingsRows[0].value && settingsRows[0].value.trim()) {
        scopes = settingsRows[0].value.trim();
      } else {
        scopes = getDefaultOrScopes();
      }
    }
    cachedConfig = {
      orgName: row.orgName,
      tenantName: row.tenantName,
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      scopes,
      folderId: row.folderId || undefined,
      folderName: row.folderName || undefined,
    };
    configLoadedAt = now;
    return cachedConfig;
  }

  const all = await db.select().from(appSettings);
  const map = new Map(all.map((r) => [r.key, r.value]));

  const orgName = map.get("uipath_org_name");
  const tenantName = map.get("uipath_tenant_name");
  const clientId = map.get("uipath_client_id");
  const clientSecret = map.get("uipath_client_secret");
  const savedScopes = map.get("uipath_scopes");
  const scopes = (savedScopes && savedScopes.trim()) ? savedScopes.trim() : getDefaultOrScopes();
  const folderId = map.get("uipath_folder_id") || undefined;
  const folderName = map.get("uipath_folder_name") || undefined;

  if (!orgName || !tenantName || !clientId || !clientSecret) {
    const envClientId = process.env.UIPATH_CLIENT_ID;
    const envClientSecret = process.env.UIPATH_CLIENT_SECRET;
    const envOrgName = process.env.UIPATH_ORGANIZATION_ID;
    const envTenantName = process.env.UIPATH_TENANT_NAME;
    const envFolderId = process.env.UIPATH_FOLDER_ID;
    const envScopes = process.env.UIPATH_SCOPES?.trim();

    if (envClientId && envClientSecret && envOrgName && envTenantName) {
      cachedConfig = {
        orgName: envOrgName,
        tenantName: envTenantName,
        clientId: envClientId,
        clientSecret: envClientSecret,
        scopes: envScopes || getDefaultOrScopes(),
        folderId: envFolderId,
      };
      configLoadedAt = now;
      return cachedConfig;
    }
    cachedConfig = null;
    return null;
  }

  cachedConfig = { orgName, tenantName, clientId, clientSecret, scopes, folderId, folderName };
  configLoadedAt = now;
  return cachedConfig;
}

function logGrantedScopes(accessToken: string, resource: string, scopeSource: string): void {
  try {
    const jwtParts = accessToken.split(".");
    if (jwtParts.length === 3) {
      const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString("utf8"));
      const tokenScopes: string[] = typeof payload.scope === "string"
        ? payload.scope.split(" ")
        : Array.isArray(payload.scope) ? payload.scope : [];
      console.log(`[UiPath Auth] ${resource} token granted scopes: [${tokenScopes.join(", ")}] (acquired via ${scopeSource})`);
    }
  } catch (decodeErr: any) {
    console.log(`[UiPath Auth] Could not decode JWT payload for ${resource}: ${decodeErr.message}`);
  }
}

type ScopeTestResult = { label: string; scopes: string[]; ok: boolean; httpStatus: number; grantedScopes: string[] };

async function testScopeCandidate(
  config: UiPathAuthConfig,
  resource: ResourceType,
  candidate: { label: string; scopes: string[] }
): Promise<ScopeTestResult> {
  console.log(`[UiPath Auth] ${resource} pre-validation testing "${candidate.label}": [${candidate.scopes.join(", ")}]`);
  const candParams = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: candidate.scopes.join(" "),
  });
  const candController = new AbortController();
  const candTimeoutId = setTimeout(() => candController.abort(), 15000);
  try {
    const candRes = await fetch(getTokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: candParams.toString(),
      signal: candController.signal,
    });
    clearTimeout(candTimeoutId);
    if (candRes.ok) {
      const candData = await candRes.json();
      if (candData.access_token) {
        let grantedScopes: string[] = [];
        try {
          const parts = candData.access_token.split(".");
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
            grantedScopes = typeof payload.scope === "string"
              ? payload.scope.split(" ")
              : Array.isArray(payload.scope) ? payload.scope : [];
          }
        } catch { /* ignore */ }
        console.log(`[UiPath Auth] ${resource} pre-validation "${candidate.label}" SUCCEEDED, granted: [${grantedScopes.join(", ")}]`);
        return { label: candidate.label, scopes: candidate.scopes, ok: true, httpStatus: candRes.status, grantedScopes };
      }
    }
    const candText = await candRes.text().catch(() => "");
    console.log(`[UiPath Auth] ${resource} pre-validation "${candidate.label}" FAILED (${candRes.status}): ${candText.slice(0, 200)}`);
    return { label: candidate.label, scopes: candidate.scopes, ok: false, httpStatus: candRes.status, grantedScopes: [] };
  } catch (candErr: unknown) {
    clearTimeout(candTimeoutId);
    const errMsg = candErr instanceof Error ? candErr.message : "unknown";
    console.warn(`[UiPath Auth] ${resource} pre-validation "${candidate.label}" error: ${errMsg}`);
    return { label: candidate.label, scopes: candidate.scopes, ok: false, httpStatus: 0, grantedScopes: [] };
  }
}

async function validateScopeCandidates(
  config: UiPathAuthConfig,
  resource: ResourceType,
  serviceType: ServiceResourceType
): Promise<CachedToken | null> {
  const candidates = metadataService.getScopeCandidatesForService(serviceType, config.scopes);
  if (candidates.length === 0) return null;

  console.log(`[UiPath Auth] ${resource} scope mismatch detected — running pre-validation of ${candidates.length} candidate(s): ${candidates.map(c => `${c.label}=[${c.scopes.join(", ")}]`).join("; ")}`);

  const duPrimaryLabels = new Set(["tenant-configured", "taxonomy-api", "taxonomy-non-api", "document-manager"]);
  const primaryCandidates = resource === "DU"
    ? candidates.filter(c => duPrimaryLabels.has(c.label))
    : candidates;
  const secondaryCandidates = resource === "DU"
    ? candidates.filter(c => !duPrimaryLabels.has(c.label))
    : [];

  const allResults: ScopeTestResult[] = [];

  for (const candidate of primaryCandidates) {
    const result = await testScopeCandidate(config, resource, candidate);
    allResults.push(result);
  }

  const primarySuccessful = allResults.filter(r => r.ok);

  if (resource === "DU" && primarySuccessful.length === 0 && primaryCandidates.length > 0) {
    const evidence = primaryCandidates.map(c => {
      const r = allResults.find(r => r.label === c.label);
      return `${c.label}=[${c.scopes.join(", ")}]→HTTP ${r?.httpStatus || "err"}`;
    }).join("; ");
    console.error(`[UiPath Auth] DU BLOCKER: All ${primaryCandidates.length} primary DU scope form(s) failed. Evidence: ${evidence}`);

    for (const candidate of secondaryCandidates) {
      const result = await testScopeCandidate(config, resource, candidate);
      allResults.push(result);
      if (result.ok) {
        console.error(`[UiPath Auth] DU BLOCKER DIAGNOSTIC: Secondary candidate "${result.label}" [${result.scopes.join(", ")}] succeeded with ${result.grantedScopes.length} granted scopes — NOT used operationally per policy`);
      }
    }

    console.error(`[UiPath Auth] DU BLOCKER: Stopping DU token acquisition. Both .Api and non-.Api DU scope forms rejected by tenant. Next step: verify External Application DU scope configuration in UiPath Automation Cloud.`);
    return null;
  }

  const successful = primarySuccessful.length > 0 ? primarySuccessful : allResults.filter(r => r.ok);
  const bestCandidate = successful.length > 0
    ? successful.reduce((best, cur) => cur.grantedScopes.length > best.grantedScopes.length ? cur : best)
    : null;

  if (!bestCandidate) {
    console.warn(`[UiPath Auth] ${resource} pre-validation: all ${allResults.length} candidates failed — no working scope form found`);
    return null;
  }

  metadataService.setValidatedScopes(serviceType, bestCandidate.scopes);
  console.log(`[UiPath Auth] ${resource} pre-validation selected "${bestCandidate.label}" [${bestCandidate.scopes.join(", ")}] (${successful.length} of ${allResults.length} candidates succeeded, selected has ${bestCandidate.grantedScopes.length} granted scopes)`);

  const tokenScopes = bestCandidate.scopes.join(" ");
  const finalParams = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: tokenScopes,
  });
  const finalController = new AbortController();
  const finalTimeoutId = setTimeout(() => finalController.abort(), 15000);
  try {
    const finalRes = await fetch(getTokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: finalParams.toString(),
      signal: finalController.signal,
    });
    clearTimeout(finalTimeoutId);
    if (finalRes.ok) {
      const finalData = await finalRes.json();
      if (finalData.access_token) {
        const expiresIn = finalData.expires_in || 3600;
        const expiresAt = Date.now() + expiresIn * 1000;
        console.log(`[UiPath Auth] ${resource} token acquired via pre-validated "${bestCandidate.label}" for client ${maskClientId(config.clientId)}, expires in ${expiresIn}s`);
        logGrantedScopes(finalData.access_token, resource, `pre-validated:${bestCandidate.label}`);
        return { accessToken: finalData.access_token, expiresAt };
      }
    }
  } catch {
    clearTimeout(finalTimeoutId);
  }

  return null;
}

async function fetchNewToken(config: UiPathAuthConfig, resource: ResourceType): Promise<CachedToken> {
  const serviceType = (TOKEN_RESOURCE_TO_SERVICE[resource] || resource) as ServiceResourceType;
  const scopeSource = resource === "OR" ? "config" : metadataService.getScopeSource(serviceType);

  if (resource !== "OR" && metadataService.hasScopeMismatch(serviceType)) {
    const preValidated = await validateScopeCandidates(config, resource, serviceType);
    if (preValidated) return preValidated;
    if (resource === "DU") {
      throw new UiPathAuthError(`DU token acquisition blocked: all primary DU scope forms failed and no operational fallback is permitted. Check External Application DU scope configuration in UiPath Automation Cloud.`);
    }
  }

  const requestedScopes = resource === "OR" ? config.scopes : getResourceScopesFromMetadata(resource);
  const requestCandidates = resource === "OR" ? buildOrScopeCandidates(requestedScopes) : [requestedScopes];
  let lastFailure: { status: number; text: string } | null = null;

  for (const scopeRequest of requestCandidates) {
    console.log(`[UiPath Auth] Requesting ${resource} token with scopes [${scopeRequest}] (source: ${scopeSource})`);
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: scopeRequest,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let res: Response;
    try {
      res = await fetch(getTokenEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error && err.name === "AbortError"
        ? "Token request timed out after 15s"
        : `Token request failed: ${err instanceof Error ? err.message : "unknown"}`;
      console.error(`[UiPath Auth] ${msg} (${resource} token, client: ${maskClientId(config.clientId)})`);
      throw new UiPathAuthError(msg);
    }
    clearTimeout(timeoutId);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      lastFailure = { status: res.status, text };

      if (resource === "OR" && res.status === 400 && text.includes("invalid_scope")) {
        console.warn(`[UiPath Auth] ${resource} scope candidate [${scopeRequest}] rejected with invalid_scope; trying next candidate if available`);
        continue;
      }

      if (res.status === 400 && resource !== "OR") {
        const serviceType = (TOKEN_RESOURCE_TO_SERVICE[resource] || resource) as ServiceResourceType;
        const requestedScopeList = scopeRequest.split(" ");

        const scopeCandidates = metadataService.getScopeCandidatesForService(serviceType, config.scopes);
        const altScopes = metadataService.getAlternateScopesForService(serviceType, requestedScopeList);

        const duPrimaryLabels = new Set(["tenant-configured", "taxonomy-api", "taxonomy-non-api", "document-manager"]);
        const candidateSets: Array<{ label: string; scopes: string[] }> = [];
        for (const candidate of scopeCandidates) {
          if (resource === "DU" && !duPrimaryLabels.has(candidate.label)) continue;
          const candidateStr = candidate.scopes.join(" ");
          if (candidateStr !== scopeRequest && !candidateSets.some(c => c.scopes.join(" ") === candidateStr)) {
            candidateSets.push(candidate);
          }
        }

        if (altScopes.length > 0) {
          const altStr = altScopes.join(" ");
          if (altStr !== scopeRequest && !candidateSets.some(c => c.scopes.join(" ") === altStr)) {
            candidateSets.push({ label: "alternate-family", scopes: altScopes });
          }
        }

        console.log(`[UiPath Auth] ${resource} token failed with 400 (scopes: [${scopeRequest}], response: ${text.slice(0, 200)})`);
        if (candidateSets.length > 0) {
          console.log(`[UiPath Auth] ${resource} trying ${candidateSets.length} scope candidate(s): ${candidateSets.map(c => `${c.label}=[${c.scopes.join(", ")}]`).join("; ")}`);
        }

        for (const candidate of candidateSets) {
          console.log(`[UiPath Auth] ${resource} attempting candidate "${candidate.label}": [${candidate.scopes.join(", ")}]`);
          const candParams = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: config.clientId,
            client_secret: config.clientSecret,
            scope: candidate.scopes.join(" "),
          });
          const candController = new AbortController();
          const candTimeoutId = setTimeout(() => candController.abort(), 15000);
          try {
            const candRes = await fetch(getTokenEndpoint(), {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: candParams.toString(),
              signal: candController.signal,
            });
            clearTimeout(candTimeoutId);
            if (candRes.ok) {
              const candData = await candRes.json();
              if (candData.access_token) {
                const expiresIn = candData.expires_in || 3600;
                const expiresAt = Date.now() + expiresIn * 1000;
                metadataService.setValidatedScopes(serviceType, candidate.scopes);
                console.log(`[UiPath Auth] ${resource} token acquired via candidate "${candidate.label}" [${candidate.scopes.join(", ")}] for client ${maskClientId(config.clientId)}, expires in ${expiresIn}s`);
                logGrantedScopes(candData.access_token, resource, candidate.label);
                return { accessToken: candData.access_token, expiresAt };
              }
            } else {
              const candText = await candRes.text().catch(() => "");
              console.warn(`[UiPath Auth] ${resource} candidate "${candidate.label}" failed (${candRes.status}): ${candText.slice(0, 200)}`);
            }
          } catch (candErr: unknown) {
            clearTimeout(candTimeoutId);
            const errMsg = candErr instanceof Error ? candErr.message : "unknown";
            console.warn(`[UiPath Auth] ${resource} candidate "${candidate.label}" error: ${errMsg}`);
          }
        }
      }

      console.error(`[UiPath Auth] ${resource} token request failed (${res.status}) for client ${maskClientId(config.clientId)}: ${text.slice(0, 200)}`);
      throw new UiPathAuthError(`${resource} authentication failed (${res.status}): ${text.slice(0, 200)}`, res.status);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new UiPathAuthError(`${resource} token response missing access_token`);
    }

    const expiresIn = data.expires_in || 3600;
    const expiresAt = Date.now() + expiresIn * 1000;

    console.log(`[UiPath Auth] ${resource} token acquired for client ${maskClientId(config.clientId)}, expires in ${expiresIn}s`);

    try {
      const jwtParts = data.access_token.split(".");
      if (jwtParts.length === 3) {
        const payload = JSON.parse(Buffer.from(jwtParts[1], "base64url").toString("utf8"));
        const tokenScopes: string[] = typeof payload.scope === "string"
          ? payload.scope.split(" ")
          : Array.isArray(payload.scope) ? payload.scope : [];
        if (resource === "OR") {
          const scopeCounts = new Map<string, number>();
          for (const s of tokenScopes) {
            const prefix = s.split(".")[0];
            scopeCounts.set(prefix, (scopeCounts.get(prefix) || 0) + 1);
          }
          const summary = Array.from(scopeCounts.entries()).map(([k, v]) => `${k}=${v}`).join(", ");
          console.log(`[UiPath Auth] ${resource} token granted scopes (by prefix): ${summary}`);
        } else {
          console.log(`[UiPath Auth] ${resource} token granted scopes: [${tokenScopes.join(", ")}] (requested via ${scopeSource})`);
        }
      }
    } catch (decodeErr: any) {
      console.log(`[UiPath Auth] Could not decode JWT payload: ${decodeErr.message}`);
    }

    return { accessToken: data.access_token, expiresAt };
  }

  const fallbackStatus = lastFailure?.status || 400;
  const fallbackText = lastFailure?.text || '{"error":"invalid_scope"}';
  throw new UiPathAuthError(`${resource} authentication failed (${fallbackStatus}): ${fallbackText.slice(0, 200)}`, fallbackStatus);
}

function isTokenValid(token: CachedToken | null): boolean {
  if (!token) return false;
  return Date.now() < token.expiresAt - TOKEN_REFRESH_BUFFER_MS;
}

async function getResourceToken(resource: ResourceType): Promise<string> {
  const config = await loadConfig();
  if (!config) {
    throw new UiPathAuthError("UiPath is not configured. Set credentials in Admin > Integrations.");
  }

  if (resource !== "OR" && resource !== "PIMS") {
    const serviceType = (TOKEN_RESOURCE_TO_SERVICE[resource] || resource) as ServiceResourceType;
    if (!metadataService.hasOidcScopeFamily(serviceType)) {
      throw new UiPathAuthError(`No OIDC scope family for ${resource} — dedicated token acquisition is not available`);
    }
  }
  if (resource === "PIMS" && !metadataService.hasOidcScopeFamily("PIMS" as ServiceResourceType)) {
    console.log(`[UiPath Auth] PIMS not in OIDC discovery — attempting token acquisition using configured External App scopes`);
    const pimsScopes = metadataService.getScopeCandidatesForService("PIMS" as ServiceResourceType, config.scopes);
    if (pimsScopes.length === 0) {
      const configuredPimsScopes = config.scopes.split(/\s+/).filter(s => s.startsWith("PIMS."));
      if (configuredPimsScopes.length === 0) {
        throw new UiPathAuthError(`No PIMS scopes found in OIDC discovery or External App configuration — Maestro token acquisition is not available`);
      }
    }
  }

  const cached = tokenCache[resource];
  if (isTokenValid(cached ?? null) && cached) {
    return cached.accessToken;
  }

  tokenCache[resource] = await fetchNewToken(config, resource);
  return tokenCache[resource]!.accessToken;
}

async function getResourceHeaders(resource: ResourceType, extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  const config = await loadConfig();
  if (!config) {
    throw new UiPathAuthError("UiPath is not configured.");
  }

  const token = await getResourceToken(resource);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...extraHeaders,
  };

  if (resource === "OR" && config.folderId) {
    headers["X-UIPATH-OrganizationUnitId"] = config.folderId;
  }

  return headers;
}

export function getBaseUrl(config: UiPathAuthConfig): string {
  return metadataService.getServiceUrl("OR", config);
}

export function getTestManagerBaseUrl(config: UiPathAuthConfig): string {
  return metadataService.getServiceUrl("TM", config);
}

export function getDuBaseUrl(config: UiPathAuthConfig): string {
  return metadataService.getServiceUrl("DU", config);
}

export function getDataServiceBaseUrl(config: UiPathAuthConfig): string {
  return metadataService.getServiceUrl("DF", config);
}

export function getCloudBaseUrl(config: UiPathAuthConfig): string {
  return metadataService.getCloudBaseUrl(config);
}

export function getServiceUrl(resourceType: ServiceResourceType, config: UiPathAuthConfig): string {
  return metadataService.getServiceUrl(resourceType, config);
}

export function invalidateToken(): void {
  tokenCache.OR = undefined;
}

export function invalidateTmToken(): void {
  tokenCache.TM = undefined;
}

export function invalidateResourceToken(resource: ResourceType): void {
  tokenCache[resource] = undefined;
}

export function invalidateAllTokens(): void {
  for (const key of Object.keys(tokenCache) as ResourceType[]) {
    tokenCache[key] = undefined;
  }
}

export function invalidateConfig(): void {
  cachedConfig = null;
  configLoadedAt = 0;
  metadataService.clearValidatedScopes();
}

export async function getConfig(): Promise<UiPathAuthConfig | null> {
  return loadConfig();
}

export async function getToken(): Promise<string> {
  return getResourceToken("OR");
}

export async function getTmToken(): Promise<string> {
  return getResourceToken("TM");
}

export async function getDuToken(): Promise<string> {
  return getResourceToken("DU");
}

export async function getPmToken(): Promise<string> {
  return getResourceToken("PM");
}

export async function getDfToken(): Promise<string> {
  return getResourceToken("DF");
}

export async function getHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("OR", extraHeaders);
}

export async function getTmHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("TM", extraHeaders);
}

export async function getDuHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("DU", extraHeaders);
}

export async function getPmHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("PM", extraHeaders);
}

export async function getDfHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("DF", extraHeaders);
}

export async function getIxpToken(): Promise<string> {
  return getResourceToken("IXP");
}

export async function getIxpHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("IXP", extraHeaders);
}

export async function getAiToken(): Promise<string> {
  return getResourceToken("AI");
}

export async function getAiHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("AI", extraHeaders);
}

export async function getMaestroToken(): Promise<string> {
  return getResourceToken("PIMS");
}

export async function getMaestroHeaders(extraHeaders?: Record<string, string>): Promise<Record<string, string>> {
  return getResourceHeaders("PIMS", extraHeaders);
}

export function getMaestroBaseUrl(config: UiPathAuthConfig): string {
  return metadataService.getServiceUrl("PIMS", config);
}

export function getResourceScopes(): Record<ResourceType, string> {
  const resourceTypes: ResourceType[] = ["OR", "TM", "DU", "PM", "DF", "PIMS", "IXP", "AI"];
  const result = Object.fromEntries(
    resourceTypes.map(rt => [rt, getResourceScopesFromMetadata(rt)])
  ) as Record<ResourceType, string>;
  return result;
}

export async function getAccessToken(config: { clientId: string; clientSecret: string; scopes: string }): Promise<string> {
  const tokenUrl = getTokenEndpoint();

  for (const scopeCandidate of buildOrScopeCandidates(config.scopes)) {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: scopeCandidate,
    });

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (res.ok) {
      const data = await res.json();
      return data.access_token;
    }

    const text = await res.text();
    if (!(res.status === 400 && text.includes("invalid_scope"))) {
      throw new UiPathAuthError(`UiPath auth failed (${res.status}): ${text}`, res.status);
    }
  }

  throw new UiPathAuthError(`UiPath auth failed (400): {"error":"invalid_scope"}`, 400);
}

export async function testDuScopeForms(): Promise<Array<{ label: string; scopes: string[]; httpStatus: number; ok: boolean; grantedScopes: string[]; error?: string }>> {
  const config = await loadConfig();
  if (!config) {
    return [{ label: "no-config", scopes: [], httpStatus: 0, ok: false, grantedScopes: [], error: "UiPath not configured" }];
  }

  const serviceType: ServiceResourceType = "DU";
  const candidates = metadataService.getScopeCandidatesForService(serviceType, config.scopes);
  const results: Array<{ label: string; scopes: string[]; httpStatus: number; ok: boolean; grantedScopes: string[]; error?: string }> = [];

  for (const candidate of candidates) {
    console.log(`[DU Scope Test] Testing "${candidate.label}": [${candidate.scopes.join(", ")}]`);
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      scope: candidate.scopes.join(" "),
    });
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(getTokenEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal,
      });
      clearTimeout(tid);

      if (res.ok) {
        const data = await res.json();
        let grantedScopes: string[] = [];
        if (data.access_token) {
          try {
            const parts = data.access_token.split(".");
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
              grantedScopes = typeof payload.scope === "string"
                ? payload.scope.split(" ")
                : Array.isArray(payload.scope) ? payload.scope : [];
            }
          } catch { /* ignore */ }
        }
        console.log(`[DU Scope Test] "${candidate.label}" SUCCEEDED (${res.status}), granted: [${grantedScopes.join(", ")}]`);
        results.push({ label: candidate.label, scopes: candidate.scopes, httpStatus: res.status, ok: true, grantedScopes });
      } else {
        const errText = await res.text().catch(() => "");
        console.log(`[DU Scope Test] "${candidate.label}" FAILED (${res.status}): ${errText.slice(0, 200)}`);
        results.push({ label: candidate.label, scopes: candidate.scopes, httpStatus: res.status, ok: false, grantedScopes: [], error: errText.slice(0, 200) });
      }
    } catch (err: any) {
      console.log(`[DU Scope Test] "${candidate.label}" ERROR: ${err.message}`);
      results.push({ label: candidate.label, scopes: candidate.scopes, httpStatus: 0, ok: false, grantedScopes: [], error: err.message });
    }
  }

  const duPrimaryLabels = new Set(["tenant-configured", "taxonomy-api", "taxonomy-non-api", "document-manager"]);
  const primarySuccess = results.find(r => r.ok && duPrimaryLabels.has(r.label));
  if (primarySuccess) {
    metadataService.setValidatedScopes(serviceType, primarySuccess.scopes);
    console.log(`[DU Scope Test] Validated DU scope form (primary): "${primarySuccess.label}" [${primarySuccess.scopes.join(", ")}]`);
  } else {
    const secondarySuccess = results.find(r => r.ok && !duPrimaryLabels.has(r.label));
    if (secondarySuccess) {
      console.warn(`[DU Scope Test] DU BLOCKER: Only secondary candidate "${secondarySuccess.label}" succeeded — NOT persisted per policy`);
    } else {
      console.warn(`[DU Scope Test] All DU scope candidates failed — no validated form available`);
    }
  }

  return results;
}

export async function tryAcquireResourceToken(resource: ResourceType): Promise<{ ok: boolean; scopes: string[]; error?: string }> {
  try {
    const token = await getResourceToken(resource);
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      const scopes: string[] = typeof payload.scope === "string"
        ? payload.scope.split(" ")
        : Array.isArray(payload.scope) ? payload.scope : [];
      return { ok: true, scopes };
    }
    return { ok: true, scopes: [] };
  } catch (err: any) {
    return { ok: false, scopes: [], error: err.message };
  }
}

function detectResourceType(url: string): ResourceType {
  const { metadataService } = require("./catalog/metadata-service");
  const detected = metadataService.detectResourceTypeFromUrl(url);
  const resourceTypeMap: Record<string, ResourceType> = {
    TM: "TM", DU: "DU", DF: "DF", PM: "PM",
    IXP: "IXP", AI: "AI", PIMS: "PIMS",
  };
  return resourceTypeMap[detected] || "OR";
}

export async function healthCheck(): Promise<{ ok: boolean; message: string; latencyMs: number; tenantName?: string; folderName?: string }> {
  const start = Date.now();

  const config = await loadConfig();
  if (!config) {
    return { ok: false, message: "UiPath is not configured", latencyMs: Date.now() - start };
  }

  try {
    const token = await getToken();
    const baseUrl = getBaseUrl(config);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${baseUrl}/odata/Folders?$top=1`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const latencyMs = Date.now() - start;

    if (res.ok) {
      return {
        ok: true,
        message: `Connected to ${config.tenantName}`,
        latencyMs,
        tenantName: config.tenantName,
        folderName: config.folderName,
      };
    }

    const text = await res.text().catch(() => "");
    return {
      ok: false,
      message: `Orchestrator returned ${res.status}: ${text.slice(0, 100)}`,
      latencyMs,
      tenantName: config.tenantName,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const msg = err.name === "AbortError"
      ? "Connection timed out"
      : err instanceof UiPathAuthError
        ? err.message
        : `Connection failed: ${err.message}`;
    return { ok: false, message: msg, latencyMs };
  }
}

export async function makeAuthenticatedRequest(
  url: string,
  options: RequestInit = {},
  retryOn401 = true
): Promise<Response> {
  const resource = detectResourceType(url);
  const headers = await getResourceHeaders(resource);
  const mergedHeaders = { ...headers, ...(options.headers as Record<string, string> || {}) };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: mergedHeaders,
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err;
  }
  clearTimeout(timeoutId);

  if (res.status === 401 && retryOn401) {
    console.log(`[UiPath Auth] Got 401 on ${resource} request, refreshing token and retrying...`);
    invalidateResourceToken(resource);
    return makeAuthenticatedRequest(url, options, false);
  }

  return res;
}
