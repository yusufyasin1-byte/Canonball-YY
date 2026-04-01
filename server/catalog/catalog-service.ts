import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { validateCatalog } from "./catalog-validator";
import { metadataService, type StudioProfile } from "./metadata-service";
export type { StudioProfile } from "./metadata-service";

export type ProcessType = "api-integration" | "document-processing" | "attended-ui" | "unattended-ui" | "orchestration" | "general";

export type FeedStatus = "verified" | "unverified";

export interface CatalogProperty {
  name: string;
  direction: "In" | "Out" | "InOut" | "None";
  clrType: string;
  xamlSyntax: "child-element" | "attribute";
  argumentWrapper: string | null;
  typeArguments: string | null;
  required: boolean;
  validValues?: string[];
  default?: string;
  addedInVersion?: string;
  removedInVersion?: string;
}

export interface CatalogActivity {
  className: string;
  displayName: string;
  browsable: boolean;
  processTypes: ProcessType[];
  properties: CatalogProperty[];
  propertiesComplete?: boolean;
}

export interface CatalogPackage {
  packageId: string;
  version?: string;
  feedStatus?: FeedStatus;
  preferredVersion?: string;
  activities: CatalogActivity[];
}

export interface ActivityCatalog {
  catalogVersion: string;
  generatedAt: string;
  lastVerifiedAt: string;
  studioVersion: string;
  packages: CatalogPackage[];
}

export interface ActivitySchema {
  activity: CatalogActivity;
  packageId: string;
  packageVersion: string;
}

export interface ValidationCorrection {
  type: "wrap-in-argument" | "move-to-attribute" | "move-to-child-element" | "add-missing-required" | "fix-invalid-value";
  property: string;
  detail: string;
  argumentWrapper?: string;
  typeArguments?: string | null;
  correctedValue?: string;
}

export interface ActivityValidationResult {
  valid: boolean;
  violations: string[];
  corrections: ValidationCorrection[];
}

export interface PaletteEntry {
  className: string;
  displayName: string;
  packageId: string;
  properties: { name: string; direction: string; required: boolean; xamlSyntax: string; validValues?: string[] }[];
}

class CatalogService {
  private catalog: ActivityCatalog | null = null;
  private activityIndex = new Map<string, ActivitySchema>();
  private packageIndex = new Map<string, CatalogPackage>();
  private clrTypeIndex = new Map<string, string>();
  private loaded = false;
  private _studioProfile: StudioProfile | null = null;
  private loadGeneration = 0;

  load(catalogPath?: string): void {
    metadataService.load();
    this._studioProfile = metadataService.getStudioProfile();

    let parsed: any = null;

    if (!catalogPath && metadataService.isActivityCatalogAvailable()) {
      parsed = metadataService.getActivityCatalogData();
    }

    if (!parsed) {
      const path = catalogPath || metadataService.getActivityCatalogPath() || join(process.cwd(), "catalog", "activity-catalog.json");
      if (!existsSync(path)) {
        console.warn(`[Activity Catalog] Catalog file not found at ${path} — catalog constraints disabled`);
        this.loaded = false;
        return;
      }
      try {
        const raw = readFileSync(path, "utf-8");
        parsed = JSON.parse(raw);
      } catch (err: any) {
        console.warn(`[Activity Catalog] Failed to load catalog: ${err.message} — catalog constraints disabled`);
        this.loaded = false;
        return;
      }
    }

    try {
      const validation = validateCatalog(parsed);
      if (!validation.valid) {
        console.warn(`[Activity Catalog] Catalog validation failed: ${validation.errors.join("; ")} — catalog constraints disabled`);
        this.loaded = false;
        return;
      }

      if (validation.warnings.length > 0) {
        console.warn(`[Activity Catalog] Catalog warnings: ${validation.warnings.join("; ")}`);
      }

      this.catalog = parsed as ActivityCatalog;
      this.buildIndices();
      this.loaded = true;
      this.loadGeneration++;

      let totalActivities = 0;
      for (const pkg of this.catalog.packages) {
        totalActivities += pkg.activities.length;
      }

      console.log(`Activity catalog loaded: v${this.catalog.catalogVersion}, ${this.catalog.packages.length} packages, ${totalActivities} activities, Studio ${this.catalog.studioVersion}`);

      this.checkVersionAlignment();
      this.checkCatalogFreshness();
    } catch (err: any) {
      console.warn(`[Activity Catalog] Failed to load catalog: ${err.message} — catalog constraints disabled`);
      this.loaded = false;
    }
  }

  getStudioProfile(): StudioProfile | null {
    return metadataService.getStudioProfile() || this._studioProfile;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  getLoadGeneration(): number {
    return this.loadGeneration;
  }

  private checkVersionAlignment(): void {
    if (!this.catalog) return;
    const metaTarget = metadataService.getStudioTarget();
    if (!metaTarget) return;
    if (this.catalog.studioVersion !== metaTarget.version) {
      console.warn(`[Activity Catalog] WARNING: activity-catalog.json studioVersion (${this.catalog.studioVersion}) does not match MetadataService studio target (${metaTarget.version}). Version drift may cause dependency mismatches.`);
    }
  }

  private checkCatalogFreshness(): void {
    if (!this.catalog?.lastVerifiedAt) return;

    const lastVerified = new Date(this.catalog.lastVerifiedAt).getTime();
    if (isNaN(lastVerified)) return;

    const ageMs = Date.now() - lastVerified;
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

    if (ageMs > NINETY_DAYS_MS) {
      const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
      console.warn(`[Activity Catalog] WARNING: Catalog lastVerifiedAt is ${ageDays} days old (>${90} days). Consider re-verifying the catalog against NuGet feeds.`);
    }
  }

  private buildIndices(): void {
    if (!this.catalog) return;

    this.activityIndex.clear();
    this.packageIndex.clear();
    this.clrTypeIndex.clear();

    for (const pkg of this.catalog.packages) {
      if (pkg.packageId) {
        this.packageIndex.set(pkg.packageId, pkg);
      }

      for (const act of pkg.activities) {
        const metaVersion = metadataService.getPreferredVersion(pkg.packageId);
        const schema: ActivitySchema = {
          activity: act,
          packageId: pkg.packageId,
          packageVersion: metaVersion || pkg.version || "",
        };

        this.activityIndex.set(act.className, schema);

        if (pkg.packageId) {
          this.activityIndex.set(`${pkg.packageId}:${act.className}`, schema);

          for (const prop of act.properties) {
            if (prop.clrType && prop.clrType.startsWith("UiPath.") && !this.clrTypeIndex.has(prop.clrType)) {
              this.clrTypeIndex.set(prop.clrType, pkg.packageId);
            }
          }
        }
      }
    }
  }

  private resolveTag(tag: string): string {
    const stripped = tag.includes(":") ? tag.split(":").pop()! : tag;
    return stripped;
  }

  getActivitySchema(tag: string): ActivitySchema | null {
    if (!this.loaded || !this.catalog) return null;

    const direct = this.activityIndex.get(tag);
    if (direct) return direct;

    const className = this.resolveTag(tag);
    return this.activityIndex.get(className) || null;
  }

  getPackageForActivity(tag: string): string | null {
    const schema = this.getActivitySchema(tag);
    return schema?.packageId || null;
  }

  resolveTypeToPackage(clrType: string): string | null {
    if (!this.loaded || !this.catalog) return null;

    const indexed = this.clrTypeIndex.get(clrType);
    if (indexed) return indexed;

    for (const pkg of this.catalog.packages) {
      if (clrType.startsWith(pkg.packageId + ".") || clrType === pkg.packageId) {
        return pkg.packageId;
      }
    }

    if (clrType.startsWith("UiPath.")) {
      const parts = clrType.replace("UiPath.", "").split(".");
      const candidateIds: string[] = [];
      if (parts.length >= 2 && parts.includes("Activities")) {
        const actIdx = parts.indexOf("Activities");
        candidateIds.push("UiPath." + parts.slice(0, actIdx + 1).join("."));
      }
      if (parts.length >= 1) {
        candidateIds.push(`UiPath.${parts[0]}.Activities`);
      }
      for (const candidate of candidateIds) {
        if (this.packageIndex.has(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  getActivitiesForPackage(packageName: string): CatalogActivity[] {
    if (!this.loaded || !this.catalog) return [];
    const pkg = this.packageIndex.get(packageName);
    return pkg?.activities || [];
  }

  getAllActivities(): ActivitySchema[] {
    if (!this.loaded || !this.catalog) return [];

    const schemas: ActivitySchema[] = [];
    for (const pkg of this.catalog.packages) {
      const metaVersion = metadataService.getPreferredVersion(pkg.packageId);
      for (const act of pkg.activities) {
        schemas.push({
          activity: act,
          packageId: pkg.packageId,
          packageVersion: metaVersion || pkg.version || "",
        });
      }
    }
    return schemas;
  }

  buildActivityPalette(processType: ProcessType): PaletteEntry[] {
    if (!this.loaded || !this.catalog) return [];

    const entries: PaletteEntry[] = [];
    for (const pkg of this.catalog.packages) {
      for (const act of pkg.activities) {
        if (!act.browsable) continue;
        if (act.processTypes && act.processTypes.length > 0) {
          if (!act.processTypes.includes(processType) && !act.processTypes.includes("general")) {
            continue;
          }
        }

        entries.push({
          className: act.className,
          displayName: act.displayName,
          packageId: pkg.packageId,
          properties: act.properties.map(p => ({
            name: p.name,
            direction: p.direction,
            required: p.required,
            xamlSyntax: p.xamlSyntax,
            validValues: p.validValues,
          })),
        });
      }
    }

    return entries;
  }

  buildWidePalette(): PaletteEntry[] {
    if (!this.loaded || !this.catalog) return [];

    const entries: PaletteEntry[] = [];
    for (const pkg of this.catalog.packages) {
      for (const act of pkg.activities) {
        if (!act.browsable) continue;

        entries.push({
          className: act.className,
          displayName: act.displayName,
          packageId: pkg.packageId,
          properties: act.properties.map(p => ({
            name: p.name,
            direction: p.direction,
            required: p.required,
            xamlSyntax: p.xamlSyntax,
            validValues: p.validValues,
          })),
        });
      }
    }

    return entries;
  }

  getConfirmedVersion(packageName: string): string | null {
    const metaVersion = metadataService.getPreferredVersion(packageName);
    if (metaVersion) return metaVersion;
    return null;
  }

  getEnumValues(activityClassName: string, propertyName: string): string[] | null {
    const schema = this.getActivitySchema(activityClassName);
    if (!schema) return null;

    const prop = schema.activity.properties.find(p => p.name === propertyName);
    if (!prop || !prop.validValues || prop.validValues.length === 0) return null;

    return prop.validValues;
  }

  isPropertyAvailableForVersion(activityClassName: string, propertyName: string, packageVersion: string): boolean {
    const schema = this.getActivitySchema(activityClassName);
    if (!schema) return true;

    const prop = schema.activity.properties.find(p => p.name === propertyName);
    if (!prop) return false;

    if (prop.addedInVersion && this.compareVersions(packageVersion, prop.addedInVersion) < 0) {
      return false;
    }

    if (prop.removedInVersion && this.compareVersions(packageVersion, prop.removedInVersion) >= 0) {
      return false;
    }

    return true;
  }

  getPreferredVersion(packageName: string): string | null {
    return metadataService.getPreferredVersion(packageName);
  }

  getFeedStatus(packageName: string): FeedStatus | null {
    if (!this.loaded || !this.catalog) return null;
    const pkg = this.packageIndex.get(packageName);
    return pkg?.feedStatus || null;
  }

  isPackageVerified(packageName: string): boolean {
    const status = this.getFeedStatus(packageName);
    return status === "verified";
  }

  private compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    return 0;
  }

  validateEmittedActivity(
    tag: string,
    attributes: Record<string, string>,
    children: string[]
  ): ActivityValidationResult {
    const result: ActivityValidationResult = {
      valid: true,
      violations: [],
      corrections: [],
    };

    const schema = this.getActivitySchema(tag);
    if (!schema) return result;

    const FRAMEWORK_ATTRIBUTES = new Set([
      "DisplayName", "ContinueOnError", "sap2010:Annotation.AnnotationText",
      "sap2010:WorkflowViewState.IdRef", "WorkflowViewState.IdRef",
      "sap:VirtualizedContainerService.HintSize",
      "sap2010:VirtualizedContainerService.HintSize", "VirtualizedContainerService.HintSize",
      "Annotation.AnnotationText",
      "DelayAfter", "DelayBefore",
      "mc:Ignorable", "x:Class", "x:TypeArguments", "TypeArguments", "x:Name",
    ]);

    const FRAMEWORK_CHILD_ELEMENTS = new Set([
      "Variables", "VirtualizedContainerService.HintSize", "WorkflowViewState.IdRef",
      "Try", "TryCatch.Try", "Catches", "TryCatch.Catches", "Finally", "TryCatch.Finally",
      "Body", "ForEach.Body", "ParallelForEach.Body",
      "Then", "If.Then", "Else", "If.Else",
      "Cases", "Switch.Cases", "Default", "Switch.Default",
      "Condition", "While.Condition", "DoWhile.Condition",
    ]);

    const knownPropertyNames = new Set(schema.activity.properties.map(p => p.name));
    const className = tag.includes(":") ? tag.split(":").pop()! : tag;
    const normalizedChildren = children.map(child => child.includes(":") ? child.split(":").pop()! : child);
    const isComplete = schema.activity.propertiesComplete === true;

    if (isComplete) {
      for (const attrName of Object.keys(attributes)) {
        if (attrName.startsWith("xmlns")) continue;
        if (!knownPropertyNames.has(attrName) && !FRAMEWORK_ATTRIBUTES.has(attrName)) {
          result.valid = false;
          result.violations.push(`Unrecognized attribute "${attrName}" on ${tag} — not in catalog schema`);
          result.corrections.push({
            type: "remove-attribute",
            property: attrName,
            detail: `Remove unrecognized attribute "${attrName}" from ${tag}`,
          });
        }
      }

      for (const childName of normalizedChildren) {
        const simpleName = childName.includes(".") ? childName.split(".").pop()! : childName;
        if (FRAMEWORK_CHILD_ELEMENTS.has(simpleName) || FRAMEWORK_CHILD_ELEMENTS.has(childName)) continue;
        if (!knownPropertyNames.has(simpleName) && !FRAMEWORK_ATTRIBUTES.has(simpleName)) {
          result.valid = false;
          result.violations.push(`Unrecognized child property "${childName}" on ${tag} — not in catalog schema`);
        }
      }
    }

    for (const prop of schema.activity.properties) {
      const hasAttribute = prop.name in attributes;
      const hasChild = normalizedChildren.some(c => c === prop.name || c === `${className}.${prop.name}`);

      if (prop.required && !hasAttribute && !hasChild) {
        result.valid = false;
        result.violations.push(`Missing required property "${prop.name}" on ${tag}`);
        result.corrections.push({
          type: "add-missing-required",
          property: prop.name,
          detail: `Add required property "${prop.name}" (${prop.clrType}) to ${tag}`,
        });
      }

      if (prop.xamlSyntax === "child-element" && hasAttribute && !hasChild) {
        result.valid = false;
        result.violations.push(`Property "${prop.name}" on ${tag} must be a child element, not an attribute`);
        result.corrections.push({
          type: "move-to-child-element",
          property: prop.name,
          detail: `Move "${prop.name}" from attribute to child element <${tag.split(":").pop()}.${prop.name}> with ${prop.argumentWrapper || "InArgument"} wrapper`,
          argumentWrapper: prop.argumentWrapper || "InArgument",
          typeArguments: prop.typeArguments,
        });
      }

      if (prop.xamlSyntax === "child-element" && hasChild && prop.argumentWrapper && !hasAttribute) {
        result.corrections.push({
          type: "wrap-in-argument",
          property: prop.name,
          detail: `Ensure "${prop.name}" child element on ${tag} is wrapped with <${prop.argumentWrapper}> if not already`,
          argumentWrapper: prop.argumentWrapper,
          typeArguments: prop.typeArguments,
        });
      }

      if (prop.xamlSyntax === "attribute" && hasChild && !hasAttribute) {
        result.valid = false;
        result.violations.push(`Property "${prop.name}" on ${tag} is a child element but should be an attribute`);
        result.corrections.push({
          type: "move-to-attribute",
          property: prop.name,
          detail: `Move "${prop.name}" from child element to attribute on ${tag}`,
        });
      }

      if (hasAttribute && prop.validValues && prop.validValues.length > 0) {
        const currentVal = attributes[prop.name];
        if (currentVal && !prop.validValues.includes(currentVal)) {
          result.valid = false;
          result.violations.push(`ENUM_VIOLATION: Invalid value "${currentVal}" for "${prop.name}" on ${tag} — valid values: ${prop.validValues.join(", ")}. This is a generation failure — enum violations must not be auto-corrected.`);
          result.corrections.push({
            type: "fix-invalid-value",
            property: prop.name,
            detail: `GENERATION_FAILURE: "${prop.name}" value "${currentVal}" is not a valid enum value on ${tag}. Valid values: ${prop.validValues.join(", ")}`,
            correctedValue: undefined,
          });
        }
      }
    }

    return result;
  }
}

export const catalogService = new CatalogService();
