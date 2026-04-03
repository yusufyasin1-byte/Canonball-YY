import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import {
  generationMetadataSchema,
  serviceEndpointsSchema,
  type GenerationMetadata,
  type ServiceEndpoints,
  type StudioTarget,
  type PackageVersionRangeEntry,
  type ServiceEndpointEntry,
  type ServiceResourceType,
  type ServiceTaxonomyEntry,
  type TaxonomyCategory,
  type TruthfulStatus,
  type RemediationGuidance,
  type TruthfulServiceStatus,
  type CapabilityTaxonomyEntry,
  type OidcScopeSnapshot,
  type OidcScopeFamily,
  SCOPE_PREFIX_TO_SERVICE,
} from "./metadata-schemas";
export type StudioProfile = {
  studioLine: string;
  studioVersion: string;
  targetFramework: "Windows" | "Portable";
  projectType: "Process" | "Library" | "TestAutomation";
  expressionLanguage: "VisualBasic" | "CSharp";
  minimumRequiredPackages: string[];
};

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const OIDC_DISCOVERY_URL = "https://cloud.uipath.com/identity_/.well-known/openid-configuration";
const OIDC_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const OIDC_SNAPSHOT_FILE = "oidc-scopes-snapshot.json";
const CAPABILITY_TAXONOMY_FILE = "capability-taxonomy.json";
const MINIMAL_OR_FALLBACK_SCOPES = ["OR.Default", "OR.Administration", "OR.Execution"];

const TRUTHFUL_STATUS_LABELS: Record<TruthfulStatus, string> = {
  available: "Available",
  endpoint_failure: "Unavailable (Not Reachable)",
  not_provisioned: "Unavailable (Service Not Provisioned)",
  auth_scope: "Unavailable (Authorization/Scope)",
  requires_dedicated_token: "Unavailable (Requires Communications Mining API Token)",
  unsupported_external_api: "Unavailable (No External App API)",
  internal_probe_error: "Error (Probe Failed)",
  unknown: "Unknown (Not Verified)",
};


export const TOKEN_RESOURCE_TO_SERVICE: Record<string, ServiceResourceType> = {
  OR: "OR", TM: "TM", DU: "DU", PM: "IDENTITY", DF: "DF", PIMS: "PIMS", IXP: "IXP", AI: "AI",
};

export const ORCHESTRATOR_ODATA_PATHS = {
  Folders: "/odata/Folders",
  Releases: "/odata/Releases",
  Processes: "/odata/Processes",
  Sessions: "/odata/Sessions",
  Machines: "/odata/Machines",
  QueueDefinitions: "/odata/QueueDefinitions",
  Assets: "/odata/Assets",
  Buckets: "/odata/Buckets",
  Environments: "/odata/Environments",
  Users: "/odata/Users",
  TaskCatalogs: "/odata/TaskCatalogs",
  TestDataQueues: "/odata/TestDataQueues",
  ProcessSchedules: "/odata/ProcessSchedules",
  GenericTasks: "/tasks/GenericTasks",
  Jobs: "/odata/Jobs",
  LicensesRuntime: "/odata/LicensesRuntime",
  LicensesNamedUser: "/odata/LicensesNamedUser",
  StartJobs: "/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs",
  GetLicense: "/odata/Settings/UiPath.Server.Configuration.OData.GetLicense",
  GetPackageVersions: (packageId: string) =>
    `/odata/Processes/UiPath.Server.Configuration.OData.GetPackageVersions(packageId='${encodeURIComponent(packageId)}')`,
  AssignUsers: "/odata/Folders/UiPath.Server.Configuration.OData.AssignUsers",
} as const;

export const ORCHESTRATOR_DIAGNOSTIC_ENTITIES: Record<string, { listPath: string; createPath: string; assignPath?: string }> = {
  QueueDefinitions: { listPath: "/odata/QueueDefinitions?$top=3", createPath: "/odata/QueueDefinitions" },
  Assets: { listPath: "/odata/Assets?$top=3", createPath: "/odata/Assets" },
  Machines: { listPath: "/odata/Machines?$top=3", createPath: "/odata/Machines" },
  Buckets: { listPath: "/odata/Buckets?$top=3", createPath: "/odata/Buckets" },
  Environments: { listPath: "/odata/Environments?$top=3", createPath: "/odata/Environments" },
  Users: { listPath: "/odata/Users?$top=5", createPath: "/odata/Users" },
  Folders: { listPath: "/odata/Folders?$top=1", createPath: "/odata/Folders", assignPath: "/odata/Folders/UiPath.Server.Configuration.OData.AssignUsers" },
  TaskCatalogs: { listPath: "/odata/TaskCatalogs?$top=1", createPath: "/odata/TaskCatalogs" },
  TestDataQueues: { listPath: "/odata/TestDataQueues?$top=3", createPath: "/odata/TestDataQueues" },
  GenericTasks: { listPath: "/tasks/GenericTasks", createPath: "/tasks/GenericTasks/CreateTask" },
};

class MetadataService {
  private generationMetadata: GenerationMetadata | null = null;
  private serviceEndpoints: ServiceEndpoints | null = null;
  private generationLoaded = false;
  private integrationLoaded = false;
  private activityCatalogLoaded = false;
  private activityCatalogPath: string | null = null;
  private activityCatalogData: any = null;
  private loadError: string | null = null;
  private lastGenRefreshSuccess: string | null = null;
  private lastGenRefreshFailure: string | null = null;
  private lastIntRefreshSuccess: string | null = null;
  private lastIntRefreshFailure: string | null = null;

  private oidcLiveScopes: OidcScopeSnapshot | null = null;
  private oidcSnapshot: OidcScopeSnapshot | null = null;
  private oidcLastRefreshAt: number = 0;
  private oidcRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private capabilityTaxonomy: CapabilityTaxonomyEntry[] | null = null;
  private activeEndpoints: Partial<Record<ServiceResourceType, string>> = {};
  private validatedScopeOverrides: Map<ServiceResourceType, string[]> = new Map();

  load(): void {
    this.loadGeneration();
    this.loadIntegration();
    this.loadActivityCatalogMetadata();
    this.loadCapabilityTaxonomy();
    this.loadOidcSnapshot();
    this.checkFreshness();
    this.warnDeprecatedEndpoints();
    this.logStatus();
    this.scheduleOidcRefresh();
  }

  private loadGeneration(): void {
    const genPath = join(process.cwd(), "catalog", "generation-metadata.json");

    if (existsSync(genPath)) {
      try {
        const raw = readFileSync(genPath, "utf-8");
        const parsed = JSON.parse(raw);
        const result = generationMetadataSchema.safeParse(parsed);

        if (result.success) {
          this.generationMetadata = result.data;
          this.generationLoaded = true;
          console.log(`[MetadataService] Loaded generation-metadata.json: Studio ${result.data.studioTarget.version}, ${Object.keys(result.data.packageVersionRanges).length} packages`);
          return;
        } else {
          const errors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
          console.error(`[MetadataService] generation-metadata.json validation failed: ${errors}`);
        }
      } catch (err: any) {
        console.error(`[MetadataService] Failed to load generation-metadata.json: ${err.message}`);
      }
    } else {
      console.error(`[MetadataService] generation-metadata.json not found at ${genPath}`);
    }
  }

  private loadIntegration(): void {
    const epPath = join(process.cwd(), "catalog", "service-endpoints.json");

    if (existsSync(epPath)) {
      try {
        const raw = readFileSync(epPath, "utf-8");
        const parsed = JSON.parse(raw);
        const result = serviceEndpointsSchema.safeParse(parsed);

        if (result.success) {
          this.serviceEndpoints = result.data;
          this.integrationLoaded = true;
          this.mergeRuntimeState();
          console.log(`[MetadataService] Loaded service-endpoints.json: ${Object.keys(result.data.endpoints).length} endpoints`);
          return;
        } else {
          const errors = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
          console.warn(`[MetadataService] service-endpoints.json validation failed: ${errors} — using hardcoded fallbacks`);
        }
      } catch (err: any) {
        console.warn(`[MetadataService] Failed to load service-endpoints.json: ${err.message} — using hardcoded fallbacks`);
      }
    }

    this.integrationLoaded = false;
  }

  private mergeRuntimeState(): void {
    if (!this.serviceEndpoints) return;
    const runtimePath = join(process.cwd(), "catalog", "service-endpoints-runtime.json");
    if (!existsSync(runtimePath)) return;
    try {
      const raw = readFileSync(runtimePath, "utf-8");
      const runtime = JSON.parse(raw);
      if (runtime.endpoints) {
        for (const [key, state] of Object.entries(runtime.endpoints) as Array<[string, any]>) {
          if (this.serviceEndpoints.endpoints[key]) {
            this.serviceEndpoints.endpoints[key] = {
              ...this.serviceEndpoints.endpoints[key],
              reachabilityStatus: state.reachabilityStatus,
              lastVerifiedAt: state.lastVerifiedAt,
            };
          }
        }
      }
      if (runtime.lastRefreshedAt) {
        this.serviceEndpoints.lastRefreshedAt = runtime.lastRefreshedAt;
      }
    } catch (err: any) {
      console.warn(`[MetadataService] Failed to load runtime endpoint state: ${err.message}`);
    }
  }

  private loadActivityCatalogMetadata(): void {
    const catalogPath = join(process.cwd(), "catalog", "activity-catalog.json");
    if (existsSync(catalogPath)) {
      this.activityCatalogPath = catalogPath;
      try {
        const raw = readFileSync(catalogPath, "utf-8");
        this.activityCatalogData = JSON.parse(raw);
        this.activityCatalogLoaded = true;
      } catch (err: any) {
        console.warn(`[MetadataService] Failed to parse activity-catalog.json: ${err.message}`);
        this.activityCatalogData = null;
        this.activityCatalogLoaded = false;
      }
    } else {
      console.warn("[MetadataService] activity-catalog.json not found — activity catalog will be unavailable");
      this.activityCatalogLoaded = false;
    }
  }

  getActivityCatalogPath(): string | null {
    return this.activityCatalogPath;
  }

  getActivityCatalogData(): any {
    return this.activityCatalogData;
  }

  isActivityCatalogAvailable(): boolean {
    return this.activityCatalogLoaded;
  }

  reloadActivityCatalog(): void {
    this.activityCatalogData = null;
    this.activityCatalogLoaded = false;
    this.activityCatalogPath = null;
    this.loadActivityCatalogMetadata();
  }

  reload(family: "generation" | "integration" | "both"): void {
    if (family === "generation" || family === "both") {
      this.generationMetadata = null;
      this.generationLoaded = false;
      this.loadGeneration();
    }
    if (family === "integration" || family === "both") {
      this.serviceEndpoints = null;
      this.integrationLoaded = false;
      this.loadIntegration();
    }
    this.logStatus();
  }

  private checkFreshness(): void {
    const now = Date.now();

    if (this.generationMetadata) {
      const age = now - new Date(this.generationMetadata.lastRefreshedAt).getTime();
      if (age > THIRTY_DAYS_MS) {
        console.error(`[MetadataService] ERROR: generation-metadata.json is ${Math.floor(age / (24 * 60 * 60 * 1000))} days old (>30 days). Metadata may be severely outdated.`);
      } else if (age > SEVEN_DAYS_MS) {
        console.warn(`[MetadataService] WARNING: generation-metadata.json is ${Math.floor(age / (24 * 60 * 60 * 1000))} days old (>7 days). Consider refreshing.`);
      }
    }

    if (this.serviceEndpoints) {
      const age = now - new Date(this.serviceEndpoints.lastRefreshedAt).getTime();
      if (age > THIRTY_DAYS_MS) {
        console.error(`[MetadataService] ERROR: service-endpoints.json is ${Math.floor(age / (24 * 60 * 60 * 1000))} days old (>30 days). Endpoints may be severely outdated.`);
      } else if (age > SEVEN_DAYS_MS) {
        console.warn(`[MetadataService] WARNING: service-endpoints.json is ${Math.floor(age / (24 * 60 * 60 * 1000))} days old (>7 days). Consider refreshing.`);
      }
    }
  }

  private warnDeprecatedEndpoints(): void {
    if (!this.serviceEndpoints) return;
    for (const [key, entry] of Object.entries(this.serviceEndpoints.endpoints)) {
      if (entry.confidence === "deprecated") {
        const alt = entry.alternateUrlTemplates?.length ? ` Alternates: ${entry.alternateUrlTemplates.join(", ")}` : "";
        console.warn(`[MetadataService] DEPRECATED endpoint: ${key} (${entry.urlTemplate}).${alt}`);
      }
    }
  }

  private logStatus(): void {
    const target = this.getStudioTarget();
    if (target) {
      console.log(`[MetadataService] Studio target: ${target.version} (${target.targetFramework}/${target.expressionLanguage})`);
    }
    const pkgCount = this.generationMetadata
      ? Object.keys(this.generationMetadata.packageVersionRanges).length
      : 0;
    const epCount = this.serviceEndpoints ? Object.keys(this.serviceEndpoints.endpoints).length : 0;
    console.log(`[MetadataService] Status: ${pkgCount} packages, ${epCount} service endpoints, activity catalog: ${this.activityCatalogLoaded ? "available" : "not found"}`);
  }

  getStudioTarget(): StudioTarget | null {
    if (this.generationMetadata) {
      return this.generationMetadata.studioTarget;
    }
    return null;
  }

  getStudioProfile(): StudioProfile | null {
    if (this.generationMetadata) {
      return {
        studioLine: this.generationMetadata.studioTarget.line,
        studioVersion: this.generationMetadata.studioTarget.version,
        targetFramework: this.generationMetadata.studioTarget.targetFramework,
        projectType: this.generationMetadata.studioTarget.projectType,
        expressionLanguage: this.generationMetadata.studioTarget.expressionLanguage,
        minimumRequiredPackages: this.generationMetadata.minimumRequiredPackages,
      };
    }
    return null;
  }

  getPackageVersionRange(pkgName: string): PackageVersionRangeEntry | null {
    if (this.generationMetadata) {
      return this.generationMetadata.packageVersionRanges[pkgName] || null;
    }
    return null;
  }

  getPreferredVersion(pkgName: string): string | null {
    const range = this.getPackageVersionRange(pkgName);
    return range?.preferred || null;
  }

  isVersionPreferred(pkgName: string, version: string): boolean {
    const preferred = this.getPreferredVersion(pkgName);
    if (!preferred) return false;
    const cleanVersion = version.replace(/^\[/, "").replace(/[,)\]]/g, "").trim();
    const vMatch = cleanVersion.match(/^(\d+\.\d+(\.\d+){0,2})/);
    if (!vMatch) return false;
    return vMatch[1] === preferred;
  }

  getValidatedVersion(pkgName: string): string | null {
    return this.getPreferredVersion(pkgName);
  }

  private resolvedServiceUrls: Partial<Record<ServiceResourceType, string>> = {};
  private inMemoryReachability: Partial<Record<ServiceResourceType, "reachable" | "limited" | "unreachable" | "unknown">> = {};

  getServiceUrl(resourceType: ServiceResourceType, config: { orgName: string; tenantName: string }): string {
    const active = this.activeEndpoints[resourceType];
    if (active) {
      return active
        .replace("{orgName}", config.orgName)
        .replace("{tenantName}", config.tenantName);
    }
    const resolved = this.resolvedServiceUrls[resourceType];
    if (resolved) {
      return resolved
        .replace("{orgName}", config.orgName)
        .replace("{tenantName}", config.tenantName);
    }
    if (this.serviceEndpoints?.endpoints[resourceType]) {
      const entry = this.serviceEndpoints.endpoints[resourceType];
      return entry.urlTemplate
        .replace("{orgName}", config.orgName)
        .replace("{tenantName}", config.tenantName);
    }
    const base = `https://cloud.uipath.com/${config.orgName}/${config.tenantName}`;
    console.warn(`[MetadataService] No curated endpoint for ${resourceType} — using generic base URL`);
    return base;
  }

  getServiceUrlAlternates(resourceType: ServiceResourceType, config: { orgName: string; tenantName: string }): string[] {
    const primary = this.getServiceUrl(resourceType, config);
    const urls = [primary];
    if (this.serviceEndpoints?.endpoints[resourceType]) {
      const entry = this.serviceEndpoints.endpoints[resourceType];
      if (entry.alternateUrlTemplates) {
        for (const alt of entry.alternateUrlTemplates) {
          const resolved = alt
            .replace("{orgName}", config.orgName)
            .replace("{tenantName}", config.tenantName);
          if (!urls.includes(resolved)) {
            urls.push(resolved);
          }
        }
      }
    }
    return urls;
  }

  setResolvedServiceUrl(resourceType: ServiceResourceType, url: string): void {
    this.resolvedServiceUrls[resourceType] = url;
  }

  updateServiceReachability(resourceType: ServiceResourceType, status: "reachable" | "limited" | "unreachable" | "unknown"): void {
    this.inMemoryReachability[resourceType] = status;
    this.persistRuntimeReachability(resourceType, status);
  }

  private persistRuntimeReachability(resourceType: string, status: string): void {
    const runtimePath = join(process.cwd(), "catalog", "service-endpoints-runtime.json");
    try {
      let runtime: any = {};
      if (existsSync(runtimePath)) {
        runtime = JSON.parse(readFileSync(runtimePath, "utf-8"));
      }
      if (!runtime.endpoints) runtime.endpoints = {};
      const now = new Date().toISOString();
      const key = resourceType;
      runtime.endpoints[key] = {
        ...(runtime.endpoints[key] || {}),
        reachabilityStatus: status,
        lastVerifiedAt: now,
      };
      runtime.lastRefreshedAt = now;
      writeFileSync(runtimePath, JSON.stringify(runtime, null, 2));
    } catch { }
  }

  private markOidcStale(reason: string): void {
    const now = new Date().toISOString();
    if (this.oidcLiveScopes && !this.oidcLiveScopes.isStale) {
      this.oidcLiveScopes.isStale = true;
      this.oidcLiveScopes.staleSince = now;
      console.warn(`[MetadataService] Marked live OIDC scopes as stale (${reason})`);
    }
    if (this.oidcSnapshot && !this.oidcSnapshot.isStale) {
      this.oidcSnapshot.isStale = true;
      this.oidcSnapshot.staleSince = now;
      console.warn(`[MetadataService] Marked OIDC snapshot as stale — using last-known-good (${reason})`);
    }
  }

  getServiceScopes(resourceType: ServiceResourceType): string[] {
    return this.getScopesForService(resourceType);
  }

  getServiceScopesString(resourceType: ServiceResourceType): string {
    return this.getScopesForServiceString(resourceType);
  }

  getServiceConfidence(resourceType: ServiceResourceType): "official" | "inferred" | "deprecated" | "unknown" {
    if (this.serviceEndpoints?.endpoints[resourceType]) {
      return this.serviceEndpoints.endpoints[resourceType].confidence;
    }
    return "unknown";
  }

  getServiceReachability(resourceType: ServiceResourceType): "reachable" | "limited" | "unreachable" | "unknown" {
    const inMem = this.inMemoryReachability[resourceType];
    if (inMem) return inMem;
    if (this.serviceEndpoints?.endpoints[resourceType]) {
      return this.serviceEndpoints.endpoints[resourceType].reachabilityStatus;
    }
    return "unknown";
  }

  clearReachability(): void {
    this.inMemoryReachability = {};
    this.resolvedServiceUrls = {};
    this.activeEndpoints = {};
  }

  getServiceTaxonomy(): ServiceTaxonomyEntry[] {
    const taxonomy = this.getCapabilityTaxonomy();
    return taxonomy.map(e => ({
      flagKey: e.flagKey,
      serviceResourceType: e.serviceResourceType,
      displayName: e.displayName,
      category: e.category as TaxonomyCategory,
      parentService: e.parentService,
      uiSection: e.uiSection,
      defaultRemediationTemplate: e.defaultRemediationTemplate,
    }));
  }

  getTaxonomyEntry(flagKey: string): ServiceTaxonomyEntry | null {
    const entry = this.getCapabilityTaxonomyEntry(flagKey);
    if (!entry) return null;
    return {
      flagKey: entry.flagKey,
      serviceResourceType: entry.serviceResourceType,
      displayName: entry.displayName,
      category: entry.category as TaxonomyCategory,
      parentService: entry.parentService,
      uiSection: entry.uiSection,
      defaultRemediationTemplate: entry.defaultRemediationTemplate,
    };
  }

  getTaxonomyByCategory(category: TaxonomyCategory): ServiceTaxonomyEntry[] {
    return this.getServiceTaxonomy().filter(e => e.category === category);
  }

  getTaxonomyHierarchy(): {
    services: ServiceTaxonomyEntry[];
    products: ServiceTaxonomyEntry[];
    capabilities: (ServiceTaxonomyEntry & { parentEntry?: ServiceTaxonomyEntry })[];
    observations: ServiceTaxonomyEntry[];
    infrastructure: ServiceTaxonomyEntry[];
  } {
    const taxonomy = this.getServiceTaxonomy();
    const services = taxonomy.filter(e => e.category === "service");
    const products = taxonomy.filter(e => e.category === "product");
    const capabilities = taxonomy.filter(e => e.category === "capability").map(cap => ({
      ...cap,
      parentEntry: taxonomy.find(s => s.flagKey === cap.parentService),
    }));
    const observations = taxonomy.filter(e => e.category === "observation");
    const infrastructure = taxonomy.filter(e => e.category === "infrastructure");
    return { services, products, capabilities, observations, infrastructure };
  }

  getFlagToServiceType(): Record<string, ServiceResourceType> {
    const map: Record<string, ServiceResourceType> = {};
    for (const entry of this.getCapabilityTaxonomy()) {
      map[entry.flagKey] = entry.serviceResourceType;
    }
    return map;
  }

  detectResourceTypeFromUrl(url: string): string {
    const TOKEN_RESOURCE_BY_SERVICE: Record<string, string> = {
      TM: "TM", DU: "DU", DF: "DF", IDENTITY: "PM",
      IXP: "IXP", AI: "AI", PIMS: "PIMS",
    };
    for (const entry of this.getCapabilityTaxonomy()) {
      if (entry.urlPathPatterns) {
        for (const pattern of entry.urlPathPatterns) {
          if (url.includes(pattern)) {
            if (entry.serviceResourceType === "IDENTITY" && url.includes("/connect/")) continue;
            return entry.probeConfig?.tokenResource
              || TOKEN_RESOURCE_BY_SERVICE[entry.serviceResourceType]
              || "OR";
          }
        }
      }
    }
    return "OR";
  }

  getDisplayName(flagKey: string): string {
    const entry = this.getTaxonomyEntry(flagKey);
    return entry?.displayName || flagKey;
  }

  getTruthfulStatusLabel(status: TruthfulStatus): string {
    return TRUTHFUL_STATUS_LABELS[status] || status;
  }

  deriveTruthfulStatus(
    flagKey: string,
    isAvailable: boolean,
    httpStatus?: number | null,
    probeError?: string | null,
  ): TruthfulStatus {
    const entry = this.getTaxonomyEntry(flagKey);
    if (!entry) return "unknown";

    const confidence = this.getServiceConfidence(entry.serviceResourceType);

    if (isAvailable) return "available";

    if (!isAvailable) {
      const unsupportedExternalApiServices = new Set([
        "automationStore", "apps", "assistant",
      ]);
      if (unsupportedExternalApiServices.has(flagKey)) {
        return "unsupported_external_api";
      }

      if (httpStatus === 401 || httpStatus === 403) return "auth_scope";
      if (httpStatus === 404) return "not_provisioned";
      if (httpStatus && httpStatus >= 500) return "endpoint_failure";

      if (probeError) {
        if (probeError.includes("not provisioned") || probeError.includes("missing scopes")) {
          return "not_provisioned";
        }
        return "internal_probe_error";
      }

      if (httpStatus === null || httpStatus === undefined) {
        if (confidence === "inferred") return "unknown";
        return "endpoint_failure";
      }
      return "unknown";
    }

    return "unknown";
  }

  buildRemediationGuidance(
    flagKey: string,
    status: TruthfulStatus,
    httpStatus?: number | null,
    endpoint?: string,
    errorMessage?: string,
  ): RemediationGuidance | undefined {
    if (status === "available") return undefined;

    const entry = this.getTaxonomyEntry(flagKey);
    if (!entry) return undefined;

    const template = entry.defaultRemediationTemplate;
    const evidence: string[] = [];
    if (httpStatus) evidence.push(`HTTP ${httpStatus}`);
    if (endpoint) evidence.push(`Endpoint: ${endpoint}`);
    if (errorMessage) evidence.push(errorMessage);

    if (template) {
      return {
        ...template,
        technicalEvidence: evidence.length > 0 ? evidence.join(" | ") : undefined,
      };
    }

    const defaultReasons: Record<TruthfulStatus, string> = {
      available: "",
      endpoint_failure: "Service endpoint could not be reached. This may be temporary.",
      not_provisioned: "This service is not enabled on your tenant.",
      auth_scope: "Your app credentials don't have permission for this service.",
      requires_dedicated_token: "This service requires a dedicated API token. Configure it in Settings.",
      unsupported_external_api: "This service does not support External Application API access.",
      internal_probe_error: "An internal error occurred while probing this service.",
      unknown: "This service hasn't been verified yet.",
    };

    return {
      reason: defaultReasons[status] || "Service status could not be determined.",
      actionOwner: "not-actionable",
      recommendedStep: "Run a connection test to check availability.",
      technicalEvidence: evidence.length > 0 ? evidence.join(" | ") : undefined,
    };
  }

  private static readonly VALID_PROBE_STRATEGIES = new Set(["own-endpoint", "parent-api", "observation", "none"]);
  private static readonly VALID_API_SUPPORT = new Set(["documented", "undocumented", "none"]);
  private static readonly VALID_CATEGORIES = new Set(["service", "capability", "product", "observation", "infrastructure"]);

  private validateTaxonomyEntry(entry: CapabilityTaxonomyEntry, index: number): string[] {
    const errors: string[] = [];
    if (!entry.flagKey) errors.push(`[${index}] missing flagKey`);
    if (!MetadataService.VALID_PROBE_STRATEGIES.has(entry.probeStrategy)) {
      errors.push(`[${index}] "${entry.flagKey}": invalid probeStrategy "${entry.probeStrategy}" (valid: ${Array.from(MetadataService.VALID_PROBE_STRATEGIES).join(", ")})`);
    }
    if (!MetadataService.VALID_API_SUPPORT.has(entry.apiSupport)) {
      errors.push(`[${index}] "${entry.flagKey}": invalid apiSupport "${entry.apiSupport}"`);
    }
    if (!MetadataService.VALID_CATEGORIES.has(entry.category)) {
      errors.push(`[${index}] "${entry.flagKey}": invalid category "${entry.category}"`);
    }
    if (entry.probeStrategy === "own-endpoint" && !entry.probeConfig && !entry.customProbeHandler) {
      errors.push(`[${index}] "${entry.flagKey}": probeStrategy=own-endpoint requires probeConfig or customProbeHandler`);
    }
    if ((entry.apiSupport === "none") && entry.probeStrategy === "own-endpoint") {
      errors.push(`[${index}] "${entry.flagKey}": apiSupport=none is incompatible with probeStrategy=own-endpoint`);
    }
    return errors;
  }

  private loadCapabilityTaxonomy(): void {
    const taxonomyPath = join(process.cwd(), "catalog", CAPABILITY_TAXONOMY_FILE);
    if (existsSync(taxonomyPath)) {
      try {
        const raw = readFileSync(taxonomyPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const allErrors: string[] = [];
          for (let i = 0; i < parsed.length; i++) {
            allErrors.push(...this.validateTaxonomyEntry(parsed[i], i));
          }
          if (allErrors.length > 0) {
            console.error(`[MetadataService] Taxonomy validation errors:\n  ${allErrors.join("\n  ")}`);
          }
          this.capabilityTaxonomy = (parsed as CapabilityTaxonomyEntry[]).map(entry => ({
            ...entry,
            authModel: entry.authModel || "oauth",
          }));
          console.log(`[MetadataService] Loaded ${CAPABILITY_TAXONOMY_FILE}: ${this.capabilityTaxonomy.length} entries (${allErrors.length} validation warnings)`);
          return;
        }
      } catch (err: any) {
        console.warn(`[MetadataService] Failed to load ${CAPABILITY_TAXONOMY_FILE}: ${err.message}`);
      }
    }
    console.log(`[MetadataService] ${CAPABILITY_TAXONOMY_FILE} not found — using embedded taxonomy`);
  }

  private loadOidcSnapshot(): void {
    const snapshotPath = join(process.cwd(), "catalog", OIDC_SNAPSHOT_FILE);
    if (existsSync(snapshotPath)) {
      try {
        const raw = readFileSync(snapshotPath, "utf-8");
        const parsed = JSON.parse(raw) as OidcScopeSnapshot;
        if (parsed.scopeFamilies && parsed.fetchedAt) {
          this.oidcSnapshot = parsed;
          const age = Date.now() - new Date(parsed.fetchedAt).getTime();
          if (age > SEVEN_DAYS_MS) {
            this.oidcSnapshot.isStale = true;
            this.oidcSnapshot.staleSince = this.oidcSnapshot.staleSince || new Date().toISOString();
            console.warn(`[MetadataService] OIDC snapshot is stale (age: ${Math.round(age / 3600000)}h)`);
          }
          console.log(`[MetadataService] Loaded OIDC scope snapshot: ${Object.keys(parsed.scopeFamilies).length} families`);
        }
      } catch (err: any) {
        console.warn(`[MetadataService] Failed to load OIDC snapshot: ${err.message}`);
      }
    }
  }

  private persistOidcSnapshot(snapshot: OidcScopeSnapshot): void {
    try {
      const snapshotPath = join(process.cwd(), "catalog", OIDC_SNAPSHOT_FILE);
      const stagingPath = `${snapshotPath}.tmp`;
      writeFileSync(stagingPath, JSON.stringify(snapshot, null, 2), "utf-8");
      renameSync(stagingPath, snapshotPath);
    } catch (err: any) {
      console.warn(`[MetadataService] Failed to persist OIDC snapshot: ${err.message}`);
    }
  }

  async refreshFromOIDC(): Promise<{ success: boolean; familyCount: number; message: string }> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(OIDC_DISCOVERY_URL, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const msg = `OIDC discovery returned ${res.status}`;
        console.warn(`[MetadataService] ${msg}`);
        this.markOidcStale("OIDC refresh failed: " + msg);
        return { success: false, familyCount: 0, message: msg };
      }

      const data = await res.json() as { scopes_supported?: string[] };
      const rawScopes = data.scopes_supported;
      if (!rawScopes || !Array.isArray(rawScopes)) {
        const msg = "OIDC discovery response missing scopes_supported";
        console.warn(`[MetadataService] ${msg}`);
        this.markOidcStale("OIDC refresh failed: " + msg);
        return { success: false, familyCount: 0, message: msg };
      }

      const families: Record<string, OidcScopeFamily> = {};
      for (const scope of rawScopes) {
        if (scope === "openid" || scope === "profile" || scope === "email" || scope === "offline_access") continue;
        const dotIdx = scope.indexOf(".");
        if (dotIdx === -1) continue;
        const prefix = scope.substring(0, dotIdx);
        if (!families[prefix]) {
          families[prefix] = {
            prefix,
            scopes: [],
            mappedServiceResourceType: SCOPE_PREFIX_TO_SERVICE[prefix],
          };
        }
        families[prefix].scopes.push(scope);
      }

      const snapshot: OidcScopeSnapshot = {
        fetchedAt: new Date().toISOString(),
        source: OIDC_DISCOVERY_URL,
        scopeFamilies: families,
        rawScopesSupported: rawScopes,
        isStale: false,
      };

      this.oidcLiveScopes = snapshot;
      this.oidcSnapshot = snapshot;
      this.oidcLastRefreshAt = Date.now();
      this.persistOidcSnapshot(snapshot);

      const familyCount = Object.keys(families).length;
      console.log(`[MetadataService] OIDC discovery: ${familyCount} scope families, ${rawScopes.length} total scopes`);

      const mappedFamilies = Object.entries(families)
        .filter(([, f]) => f.mappedServiceResourceType)
        .map(([prefix, f]) => `${prefix}→${f.mappedServiceResourceType}(${f.scopes.length})`)
        .join(", ");
      console.log(`[MetadataService] OIDC mapped families: ${mappedFamilies}`);

      return { success: true, familyCount, message: `Discovered ${familyCount} scope families from OIDC` };
    } catch (err: any) {
      const msg = err.name === "AbortError"
        ? "OIDC discovery timed out"
        : `OIDC discovery failed: ${err.message}`;
      console.warn(`[MetadataService] ${msg}`);
      this.markOidcStale(msg);
      return { success: false, familyCount: 0, message: msg };
    }
  }

  private scheduleOidcRefresh(): void {
    if (this.oidcRefreshInterval) {
      clearInterval(this.oidcRefreshInterval);
    }
    this.oidcRefreshInterval = setInterval(async () => {
      console.log("[MetadataService] Scheduled OIDC refresh...");
      await this.refreshFromOIDC();
    }, OIDC_REFRESH_INTERVAL_MS);
    this.oidcRefreshInterval.unref?.();

    this.refreshFromOIDC().catch(err => {
      console.warn(`[MetadataService] Initial OIDC refresh failed: ${err?.message || "unknown"}`);
    });
  }

  stopOidcRefresh(): void {
    if (this.oidcRefreshInterval) {
      clearInterval(this.oidcRefreshInterval);
      this.oidcRefreshInterval = null;
    }
  }

  private getMinimalTokenScopes(resourceType: ServiceResourceType): string[] {
    const taxonomy = this.getCapabilityTaxonomy();
    for (const entry of taxonomy) {
      if (entry.serviceResourceType === resourceType && entry.minimalScopes && entry.minimalScopes.length > 0) {
        return entry.minimalScopes;
      }
    }
    return [];
  }

  setValidatedScopes(resourceType: ServiceResourceType, scopes: string[]): void {
    this.validatedScopeOverrides.set(resourceType, scopes);
    console.log(`[MetadataService] Runtime-validated scopes for ${resourceType}: [${scopes.join(", ")}]`);
  }

  getValidatedScopes(resourceType: ServiceResourceType): string[] | null {
    return this.validatedScopeOverrides.get(resourceType) || null;
  }

  clearValidatedScopes(): void {
    if (this.validatedScopeOverrides.size > 0) {
      console.log(`[MetadataService] Clearing ${this.validatedScopeOverrides.size} runtime-validated scope override(s) (config/tenant change)`);
      this.validatedScopeOverrides.clear();
    }
  }

  getScopeCandidatesForService(resourceType: ServiceResourceType, savedConfigScopes?: string): Array<{ label: string; scopes: string[] }> {
    const candidates: Array<{ label: string; scopes: string[] }> = [];
    const taxonomyScopes = this.getMinimalTokenScopes(resourceType);
    const oidcScopes = this.getFullOidcScopesForService(resourceType);

    const taxEntry = this.getCapabilityTaxonomy().find(e => e.serviceResourceType === resourceType && e.scopeFamily);
    const scopePrefix = taxEntry?.scopeFamily;

    if (savedConfigScopes && scopePrefix) {
      const savedTokens = savedConfigScopes.split(/\s+/).filter(s => s.startsWith(scopePrefix + "."));
      if (savedTokens.length > 0) {
        candidates.push({ label: "tenant-configured", scopes: savedTokens });
      }
    }

    if (taxonomyScopes.length > 0) {
      candidates.push({ label: "taxonomy-api", scopes: taxonomyScopes });
    }

    if (taxonomyScopes.length > 0) {
      const nonApiForm = taxonomyScopes.map(s => s.replace(/\.Api$/, ""));
      if (nonApiForm.some((s, i) => s !== taxonomyScopes[i])) {
        candidates.push({ label: "taxonomy-non-api", scopes: nonApiForm });
      }
    }

    if (resourceType === "DU") {
      const docMgrScope = "Du.DocumentManager.Document";
      const hasDocMgr = candidates.some(c => c.scopes.includes(docMgrScope));
      if (!hasDocMgr) {
        candidates.push({ label: "document-manager", scopes: [docMgrScope] });
      }
    }

    if (oidcScopes.length > 0) {
      candidates.push({ label: "oidc-discovered", scopes: oidcScopes });
    }

    return candidates;
  }

  hasScopeMismatch(resourceType: ServiceResourceType): boolean {
    const source = this.getScopeSource(resourceType);
    return source === "oidc-live-mismatch" || source === "oidc-snapshot-mismatch";
  }

  getScopesForService(resourceType: ServiceResourceType): string[] {
    const validated = this.validatedScopeOverrides.get(resourceType);
    if (validated && validated.length > 0) return validated;

    const fullScopes = this.getFullOidcScopesForService(resourceType);
    if (fullScopes.length > 0) return fullScopes;

    const baseline = this.getMinimalTokenScopes(resourceType);
    if (baseline.length > 0) return baseline;

    if (resourceType === "OR") return MINIMAL_OR_FALLBACK_SCOPES;

    return [];
  }

  getMinimalScopesForService(resourceType: ServiceResourceType): string[] {
    const validated = this.validatedScopeOverrides.get(resourceType);
    if (validated && validated.length > 0) return validated;

    if (this.oidcLiveScopes) {
      const oidcMinimal = this.pickMinimalFromOidc(resourceType, this.oidcLiveScopes);
      if (oidcMinimal.length > 0) return oidcMinimal;
    }

    if (this.oidcSnapshot) {
      const oidcMinimal = this.pickMinimalFromOidc(resourceType, this.oidcSnapshot);
      if (oidcMinimal.length > 0) return oidcMinimal;
    }

    const baseline = this.getMinimalTokenScopes(resourceType);
    if (baseline.length > 0) return baseline;

    if (resourceType === "OR") return MINIMAL_OR_FALLBACK_SCOPES;

    return [];
  }

  getScopeSource(resourceType: ServiceResourceType): "oidc-live" | "oidc-snapshot" | "oidc-live-mismatch" | "oidc-snapshot-mismatch" | "baseline" | "fallback" | "none" | "runtime-validated" {
    if (this.validatedScopeOverrides.has(resourceType)) return "runtime-validated";
    const minimal = this.getMinimalTokenScopes(resourceType);
    if (this.oidcLiveScopes) {
      const oidcScopes = this.findOidcScopesForService(resourceType, this.oidcLiveScopes);
      if (oidcScopes.length > 0) {
        if (minimal.length > 0) {
          const validated = minimal.filter(s => oidcScopes.includes(s));
          if (validated.length === 0) return "oidc-live-mismatch";
        }
        return "oidc-live";
      }
    }
    if (this.oidcSnapshot) {
      const oidcScopes = this.findOidcScopesForService(resourceType, this.oidcSnapshot);
      if (oidcScopes.length > 0) {
        if (minimal.length > 0) {
          const validated = minimal.filter(s => oidcScopes.includes(s));
          if (validated.length === 0) return "oidc-snapshot-mismatch";
        }
        return "oidc-snapshot";
      }
    }
    if (minimal.length > 0) return "baseline";
    if (resourceType === "OR") return "fallback";
    return "none";
  }

  private pickMinimalFromOidc(resourceType: ServiceResourceType, snapshot: OidcScopeSnapshot): string[] {
    const fullFamily = this.findOidcScopesForService(resourceType, snapshot);
    if (fullFamily.length === 0) return [];
    const minimal = this.getMinimalTokenScopes(resourceType);
    if (minimal.length > 0) {
      const validated = minimal.filter(s => fullFamily.includes(s));
      if (validated.length > 0) return validated;
      console.log(`[MetadataService] Scope mismatch for ${resourceType}: taxonomy scopes [${minimal.join(", ")}] not found in OIDC discovery [${fullFamily.join(", ")}] — deferring to OIDC-discovered scopes (will validate at runtime via scope candidates)`);
    }
    const defaultScope = fullFamily.find(s => s.endsWith(".Default"));
    if (defaultScope) return [defaultScope];
    const readScope = fullFamily.find(s => s.endsWith(".Read"));
    if (readScope) return [readScope];
    return [fullFamily[0]];
  }

  getFullOidcScopesForService(resourceType: ServiceResourceType): string[] {
    if (this.oidcLiveScopes) {
      const scopes = this.findOidcScopesForService(resourceType, this.oidcLiveScopes);
      if (scopes.length > 0) return scopes;
    }

    if (this.oidcSnapshot) {
      const scopes = this.findOidcScopesForService(resourceType, this.oidcSnapshot);
      if (scopes.length > 0) return scopes;
    }

    return [];
  }

  getScopesForServiceString(resourceType: ServiceResourceType): string {
    return this.getScopesForService(resourceType).join(" ");
  }

  getMinimalScopesForServiceString(resourceType: ServiceResourceType): string {
    return this.getMinimalScopesForService(resourceType).join(" ");
  }

  getAlternateScopesForService(resourceType: ServiceResourceType, excludeScopes: string[]): string[] {
    const allFamilies = this.findAllOidcFamiliesForService(resourceType);
    if (allFamilies.length <= 1) return [];
    for (const family of allFamilies) {
      const hasOverlap = family.scopes.some(s => excludeScopes.includes(s));
      if (!hasOverlap) {
        const minimal = this.getMinimalTokenScopes(resourceType);
        const validated = minimal.filter(s => family.scopes.includes(s));
        if (validated.length > 0) return validated;
        const defaultScope = family.scopes.find(s => s.endsWith(".Default"));
        if (defaultScope) return [defaultScope];
        const readScope = family.scopes.find(s => s.endsWith(".Read"));
        if (readScope) return [readScope];
        return [family.scopes[0]];
      }
    }
    return [];
  }

  private findOidcScopesForService(resourceType: ServiceResourceType, snapshot: OidcScopeSnapshot): string[] {
    const taxonomy = this.getCapabilityTaxonomy();
    const taxEntry = taxonomy.find(e => e.serviceResourceType === resourceType && e.scopeFamily);
    const preferredPrefix = taxEntry?.scopeFamily;

    let firstMatch: string[] | null = null;
    for (const [, family] of Object.entries(snapshot.scopeFamilies)) {
      if (family.mappedServiceResourceType === resourceType) {
        if (preferredPrefix && family.prefix === preferredPrefix) {
          return family.scopes;
        }
        if (!firstMatch) {
          firstMatch = family.scopes;
        }
      }
    }
    return firstMatch || [];
  }

  findAllOidcFamiliesForService(resourceType: ServiceResourceType, snapshot?: OidcScopeSnapshot): Array<{ prefix: string; scopes: string[] }> {
    const snap = snapshot || this.oidcLiveScopes || this.oidcSnapshot;
    if (!snap) return [];
    const families: Array<{ prefix: string; scopes: string[] }> = [];
    for (const [, family] of Object.entries(snap.scopeFamilies)) {
      if (family.mappedServiceResourceType === resourceType) {
        families.push({ prefix: family.prefix, scopes: family.scopes });
      }
    }
    return families;
  }

  getOidcStatus(): {
    hasLiveScopes: boolean;
    hasSnapshot: boolean;
    isStale: boolean;
    lastRefreshedAt: number;
    familyCount: number;
    staleSince?: string;
    scopeFamilies?: Record<string, { prefix: string; scopeCount: number; mappedService?: ServiceResourceType }>;
  } {
    const activeSource = this.oidcLiveScopes || this.oidcSnapshot;
    const families: Record<string, { prefix: string; scopeCount: number; mappedService?: ServiceResourceType }> = {};
    if (activeSource) {
      for (const [key, fam] of Object.entries(activeSource.scopeFamilies)) {
        families[key] = {
          prefix: fam.prefix,
          scopeCount: fam.scopes.length,
          mappedService: fam.mappedServiceResourceType,
        };
      }
    }
    return {
      hasLiveScopes: !!this.oidcLiveScopes,
      hasSnapshot: !!this.oidcSnapshot,
      isStale: activeSource?.isStale ?? true,
      lastRefreshedAt: this.oidcLastRefreshAt,
      familyCount: activeSource ? Object.keys(activeSource.scopeFamilies).length : 0,
      staleSince: activeSource?.staleSince,
      scopeFamilies: Object.keys(families).length > 0 ? families : undefined,
    };
  }

  getOidcValidScopes(): string[] {
    const activeSource = this.oidcLiveScopes || this.oidcSnapshot;
    return activeSource?.rawScopesSupported || [];
  }

  hasOidcScopeFamily(resourceType: ServiceResourceType): boolean {
    if (this.oidcLiveScopes) {
      if (this.findOidcScopesForService(resourceType, this.oidcLiveScopes).length > 0) return true;
    }
    if (this.oidcSnapshot) {
      if (this.findOidcScopesForService(resourceType, this.oidcSnapshot).length > 0) return true;
    }
    return false;
  }

  getCapabilityTaxonomy(): CapabilityTaxonomyEntry[] {
    return this.capabilityTaxonomy || [];
  }

  getCapabilityTaxonomyEntry(flagKey: string): CapabilityTaxonomyEntry | undefined {
    return this.getCapabilityTaxonomy().find(e => e.flagKey === flagKey);
  }

  getScopeGuidance(flagKey: string): string {
    const entry = this.getCapabilityTaxonomyEntry(flagKey);
    if (!entry) return "";
    const scopes = entry.minimalScopes;
    if (scopes && scopes.length > 0) return scopes.join(", ");
    const rem = entry.defaultRemediationTemplate;
    if (rem?.recommendedStep) return rem.recommendedStep;
    return "";
  }

  getRemediationStep(flagKey: string): string {
    const entry = this.getCapabilityTaxonomyEntry(flagKey);
    return entry?.defaultRemediationTemplate?.recommendedStep || "";
  }

  tryAlternateEndpoints(resourceType: ServiceResourceType, config: { orgName: string; tenantName: string }): string[] {
    const alternates = this.getServiceUrlAlternates(resourceType, config);
    const activeUrl = this.activeEndpoints[resourceType];
    if (activeUrl) {
      const resolved = activeUrl.replace("{orgName}", config.orgName).replace("{tenantName}", config.tenantName);
      return [resolved, ...alternates.filter(u => u !== resolved)];
    }
    return alternates;
  }

  setActiveEndpoint(resourceType: ServiceResourceType, url: string): void {
    this.activeEndpoints[resourceType] = url;
    console.log(`[MetadataService] Active endpoint for ${resourceType} switched to: ${url}`);
  }

  getActiveEndpoint(resourceType: ServiceResourceType): string | undefined {
    return this.activeEndpoints[resourceType];
  }

  checkEndpointDeprecation(resourceType: ServiceResourceType): { deprecated: boolean; notes?: string } {
    const entry = this.serviceEndpoints?.endpoints[resourceType];
    if (!entry) return { deprecated: false };
    if (entry.confidence === "deprecated") {
      return { deprecated: true, notes: entry.deprecationNotes || "This endpoint is deprecated." };
    }
    return { deprecated: false };
  }

  getTokenEndpoint(): string {
    if (this.serviceEndpoints) {
      return this.serviceEndpoints.tokenEndpoint;
    }
    return "https://cloud.uipath.com/identity_/connect/token";
  }

  getCloudBaseUrl(config: { orgName: string; tenantName: string }): string {
    return `https://cloud.uipath.com/${config.orgName}/${config.tenantName}`;
  }

  getStatus(): {
    generation: {
      loaded: boolean;
      source: "generation-metadata" | "none";
      studioTarget: StudioTarget | null;
      packageCount: number;
      lastRefreshedAt: string | null;
      lastVerifiedAt: string | null;
      stalenessLevel: "fresh" | "stale" | "critical" | "unknown";
      lastRefreshSuccessAt: string | null;
      lastRefreshFailureAt: string | null;
      packages: Record<string, { preferred: string; lastVerifiedAt: string; verificationSource: string }>;
    };
    integration: {
      loaded: boolean;
      endpointCount: number;
      lastRefreshedAt: string | null;
      lastVerifiedAt: string | null;
      stalenessLevel: "fresh" | "stale" | "critical" | "unknown";
      lastRefreshSuccessAt: string | null;
      lastRefreshFailureAt: string | null;
      endpoints: Record<string, { confidence: string; reachabilityStatus: string; lastVerifiedAt: string }>;
    };
  } {
    const now = Date.now();

    let genStaleness: "fresh" | "stale" | "critical" | "unknown" = "unknown";
    let genLastRefreshed: string | null = null;
    let genLastVerified: string | null = null;
    let genSource: "generation-metadata" | "none" = "none";

    if (this.generationMetadata) {
      genSource = "generation-metadata";
      genLastRefreshed = this.generationMetadata.lastRefreshedAt;
      genLastVerified = this.generationMetadata.lastVerifiedAt;
      const age = now - new Date(genLastRefreshed).getTime();
      genStaleness = age > THIRTY_DAYS_MS ? "critical" : age > SEVEN_DAYS_MS ? "stale" : "fresh";
    }

    let intStaleness: "fresh" | "stale" | "critical" | "unknown" = "unknown";
    let intLastRefreshed: string | null = null;
    let intLastVerified: string | null = null;
    const endpointDetails: Record<string, { confidence: string; reachabilityStatus: string; lastVerifiedAt: string }> = {};

    if (this.serviceEndpoints) {
      intLastRefreshed = this.serviceEndpoints.lastRefreshedAt;
      intLastVerified = this.serviceEndpoints.lastVerifiedAt;
      const age = now - new Date(intLastRefreshed).getTime();
      intStaleness = age > THIRTY_DAYS_MS ? "critical" : age > SEVEN_DAYS_MS ? "stale" : "fresh";
      for (const [key, ep] of Object.entries(this.serviceEndpoints.endpoints)) {
        endpointDetails[key] = {
          confidence: ep.confidence,
          reachabilityStatus: ep.reachabilityStatus,
          lastVerifiedAt: ep.lastVerifiedAt,
        };
      }
    }

    const packageDetails: Record<string, { preferred: string; lastVerifiedAt: string; verificationSource: string }> = {};
    if (this.generationMetadata) {
      for (const [pkg, entry] of Object.entries(this.generationMetadata.packageVersionRanges)) {
        packageDetails[pkg] = {
          preferred: entry.preferred,
          lastVerifiedAt: entry.lastVerifiedAt,
          verificationSource: entry.verificationSource,
        };
      }
    }

    return {
      generation: {
        loaded: this.generationLoaded,
        source: genSource,
        studioTarget: this.getStudioTarget(),
        packageCount: this.generationMetadata
          ? Object.keys(this.generationMetadata.packageVersionRanges).length
          : 0,
        lastRefreshedAt: genLastRefreshed,
        lastVerifiedAt: genLastVerified,
        stalenessLevel: genStaleness,
        lastRefreshSuccessAt: this.lastGenRefreshSuccess,
        lastRefreshFailureAt: this.lastGenRefreshFailure,
        packages: packageDetails,
      },
      integration: {
        loaded: this.integrationLoaded,
        endpointCount: this.serviceEndpoints ? Object.keys(this.serviceEndpoints.endpoints).length : 0,
        lastRefreshedAt: intLastRefreshed,
        lastVerifiedAt: intLastVerified,
        stalenessLevel: intStaleness,
        lastRefreshSuccessAt: this.lastIntRefreshSuccess,
        lastRefreshFailureAt: this.lastIntRefreshFailure,
        endpoints: endpointDetails,
      },
    };
  }

  isGenerationLoaded(): boolean {
    return this.generationLoaded;
  }

  isIntegrationLoaded(): boolean {
    return this.integrationLoaded;
  }

  recordRefreshResult(family: "generation" | "integration", success: boolean): void {
    const now = new Date().toISOString();
    if (family === "generation") {
      if (success) this.lastGenRefreshSuccess = now;
      else this.lastGenRefreshFailure = now;
    } else {
      if (success) this.lastIntRefreshSuccess = now;
      else this.lastIntRefreshFailure = now;
    }
  }

  getGenerationMetadataRaw(): GenerationMetadata | null {
    return this.generationMetadata;
  }

  getServiceEndpointsRaw(): ServiceEndpoints | null {
    return this.serviceEndpoints;
  }

  getPackageRegistryContext(): string {
    const entries: { name: string; preferred: string; verifiedAt: string }[] = [];

    if (this.generationMetadata) {
      for (const [pkg, entry] of Object.entries(this.generationMetadata.packageVersionRanges)) {
        entries.push({
          name: pkg,
          preferred: entry.preferred,
          verifiedAt: entry.lastVerifiedAt,
        });
      }
    }

    if (entries.length === 0) {
      return "";
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    const lines = entries.map(e => `- ${e.name} ${e.preferred} (verified ${e.verifiedAt})`);
    return `VALIDATED PACKAGE REGISTRY (${entries.length} packages):\n${lines.join("\n")}`;
  }
}

export const metadataService = new MetadataService();
