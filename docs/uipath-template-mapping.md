# UiPath Template Mapping for CB2YY

This document maps CB2YY's current generated data to the official UiPath document templates:

- `PDD_AutomationHub_template.docx`
- `SDD_AutomationHub_template.docx`
- `DSD_AutomationHub_template.docx`

It is intended to be the canonical implementation guide for making CB2YY emit template-aligned documentation instead of generic markdown summaries.

## 1. Goal

CB2YY already generates several pieces of the required content:

- approved process-map context
- PDD narrative
- SDD prose
- orchestrator deployment artifacts
- UiPath package/solution metadata
- workflow/runtime analysis
- developer handoff guidance
- test cases, test sets, and requirements

The gap is structural: these outputs are not yet organized into the same section model used by UiPath's official templates.

The implementation goal is:

1. keep one shared normalized document data model inside CB2YY
2. map that model into the UiPath PDD, SDD, and DSD templates
3. use the official section order and Word styles as the presentation layer

## 2. Current CB2YY Content Sources

The main sources already available in code are:

- [C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-routes.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-routes.ts)
  - prompt-driven PDD and SDD generation
  - platform capability enrichment
  - orchestrator artifact generation
- [C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\dhg-generator.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\dhg-generator.ts)
  - workflow inventory
  - workflow contracts
  - studio compatibility
  - bind points
  - trigger recommendations
  - exception handling coverage
  - deployment checklist
  - process context / business overview
  - SDD to XAML reconciliation
  - deployment readiness
- [C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-service.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-service.ts)
  - document approval flow
  - artifact validation rules for SDD
- process map storage and rendering
  - as-is and to-be node/edge graphs
  - rendered map images
- package / solution generation pipeline
  - project/workflow names
  - dependencies
  - orchestrator resources
  - test cases / test sets / requirements

## 3. Recommended Internal Canonical Model

Before rendering any one template, CB2YY should normalize all document data into one internal model:

```ts
type CanonicalAutomationDocModel = {
  process: {
    name: string;
    summary: string;
    objective: string[];
    stakeholders: string[];
    roles: string[];
    systems: string[];
    assumptions: string[];
    prerequisites: string[];
    inScope: string[];
    outOfScope: string[];
    parallelInitiatives: string[];
  };
  asIs: {
    overview: string;
    applicationsUsed: string[];
    steps: Array<{ name: string; role?: string; system?: string; type?: string; painPoint?: string }>;
    statistics: Record<string, string | number>;
    exceptionsKnown: string[];
    exceptionsUnknown: string[];
    appErrorsKnown: string[];
    appErrorsUnknown: string[];
    diagrams: {
      highLevel?: string;
      detailed?: string;
      renderedImagePath?: string;
    };
  };
  toBe: {
    overview: string;
    steps: Array<{ name: string; type?: string; owner?: string }>;
    inScopeForRpa: string[];
    outOfScopeForRpa: string[];
    reporting: string[];
    otherNotes: string[];
    diagrams: {
      highLevel?: string;
      detailed?: string;
      renderedImagePath?: string;
    };
  };
  solution: {
    deliveryRecommendation: "package" | "solution";
    rationale: string;
    automationType?: string;
    runtimeGuide?: string;
    architectureOverview?: string;
    workflows: Array<{ name: string; purpose?: string; inputs?: string[]; outputs?: string[] }>;
    packages: Array<{ name: string; version?: string }>;
    orchestratorArtifacts: Record<string, unknown>;
    integrationPoints: string[];
    security: string[];
    exceptionStrategy: string[];
    testStrategy: string[];
    futureImprovements: string[];
    debuggingTips: string[];
    postUatSpecs: string[];
    glossary: Array<{ term: string; definition: string }>;
  };
  qa: {
    requirements: Array<{ name: string; description: string; source?: string }>;
    testCases: Array<{ name: string; description: string; steps?: Array<{ action: string; expected: string }> }>;
    testSets: Array<{ name: string; description: string; testCaseNames: string[] }>;
  };
};
```

This canonical model should become the only thing rendered into the `.docx` templates.

## 4. PDD Template Mapping

The current CB2YY PDD is generated from a single loose prompt in [server/document-routes.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-routes.ts), starting at the `PDD_PROMPT` definition. That prompt is too shallow for the UiPath PDD template and should be replaced by template-structured generation.

### 4.1 Section Mapping

| UiPath PDD Section | CB2YY Source Today | Current Coverage | Implementation Notes |
|---|---|---|---|
| `INTRODUCTION` | idea title + idea description + current PDD opening prose | Partial | Create a dedicated intro block from idea metadata plus approved process summary. |
| `Purpose` | current PDD prompt output | Partial | Pull from normalized `process.summary` and automation objective. |
| `Objectives` | current PDD prompt output | Partial | Convert business outcomes into explicit objective bullets. |
| `Key Contacts` | idea owner / approvers / SME / CoE context | Missing | Add structured contact capture to canonical model; currently not first-class. |
| `Minimum Pre-requisites for the Automation` | environment requirements from DHG + platform prerequisites | Partial | Reuse environment/setup insights from DHG and platform capability detection. |
| `AS IS Process description` | approved as-is map + current PDD prose | Partial | Must become template-specific section, not generic summary. |
| `Process Overview` | process steps in DHG business overview | Strong | Reuse [dhg-generator.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\dhg-generator.ts) process context and step inventory. |
| `Applications Used` | system list from process maps and DHG | Strong | Reuse identified systems/applications from process analysis. |
| `AS IS Process Map` | process-map renderer output | Strong | Embed rendered image into template placeholder. |
| `High Level Process Map` | as-is or to-be high-level diagram | Partial | Need explicit high-level variant from process-map layer. |
| `Detailed Level Process Map` | detailed as-is map | Partial | Can use existing detailed map nodes/edges; needs yFiles BPMN render. |
| `Process Statistics` | process analytics if present | Missing | Need structured stats extraction or optional section fallback. |
| `Detailed As Is Process Actions` | process steps / node topology | Strong | Can generate table from approved process steps. |
| `Exceptions Handling` | pain points + known exceptions + decision branches | Partial | Split into business exceptions and operational exceptions more clearly. |
| `Input Data Description` | extracted data/input assumptions from use case text | Partial | Needs explicit input schema capture in canonical model. |
| `TO BE Process description` | current PDD prompt output + to-be map | Partial | Must be structured to match template headings. |
| `Detailed TO BE Process Map` | to-be process-map renderer output | Strong | Embed yFiles BPMN-style to-be diagram. |
| `Parallel Initiatives` | none today | Missing | Add optional field; leave blank if unavailable. |
| `In Scope For RPA` | current PDD / SDD scope language | Partial | Needs first-class scope arrays in canonical model. |
| `Out Of Scope for RPA` | current PDD / SDD scope language | Partial | Same as above. |
| `Known Business Exceptions` | use case exceptions / test cases | Partial | Pull from business rules and exception scenarios. |
| `Unknown Business Exceptions` | generally inferred | Missing | Add standard placeholder guidance if not discoverable. |
| `Known Applications Errors and Exceptions` | system/integration exceptions | Partial | Can derive from SDD exception strategy and integration analysis. |
| `Unknown Applications Errors and Exceptions` | not captured today | Missing | Add structured placeholder with "to be confirmed during UAT". |
| `Reporting` | DHG / SDD reporting/logging discussion | Partial | Create first-class reporting section from solution design outputs. |
| `Other` | miscellaneous notes | Missing | Add low-priority catchall. |

### 4.2 PDD Implementation Guidance

The PDD should no longer be generated from a single unstructured prompt. Instead:

1. build the canonical process model from:
   - idea description
   - approved as-is map
   - approved to-be map
   - platform capability context
   - extracted roles/systems/pain points
2. render the PDD section-by-section into the UiPath template
3. inject diagrams into the template where placeholders already exist

### 4.3 PDD Code Changes Recommended

- Replace the current generic `PDD_PROMPT` flow in [server/document-routes.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-routes.ts) with:
  - `buildCanonicalPddModel(...)`
  - `renderPddTemplate(...)`
- Keep the LLM only for prose expansion of specific sections, not for the full document shape.

## 5. SDD Template Mapping

The current CB2YY SDD is closer to the target than the PDD because it already splits:

- prose generation
- deployment artifact generation

However, it still does not align cleanly to the UiPath SDD template headings.

### 5.1 Section Mapping

| UiPath SDD Section | CB2YY Source Today | Current Coverage | Implementation Notes |
|---|---|---|---|
| `Purpose` | current SDD prose output | Strong | Can be directly mapped from solution summary. |
| `Automated process details` | current SDD prose + PDD context | Strong | Should include process overview, triggers, actors, systems. |
| `Runtime guide` | DHG runtime/deployment guidance | Strong | Reuse runtime and execution guidance from DHG. |
| `Architectural structure of the Master Project` | current SDD architecture section + workflow/package metadata | Strong | Reuse package/solution architecture plus workflow list. |
| `Master Project Runtime Details` | orchestrator artifacts + machine/runtime guidance | Strong | Map to triggers, robot type, queues, assets, buckets, folder strategy. |
| `Project name` | package/solution metadata | Strong | Direct mapping. |
| `Project(s) workflows` | workflow inventory + contracts from DHG | Strong | Reuse workflow inventory and contract summaries. |
| `Packages` | dependency/package registry context | Strong | Reuse exact package list and versions. |
| `Architectural structure of the Master Project` (duplicate heading in template) | same as architecture + resource topology | Strong | Can split into logical and deployment architecture subsections. |
| `Other Details` | integration points, security, test strategy | Strong | Already generated conceptually; needs deterministic section placement. |
| `Future Improvements` | current SDD prompt already asks for this | Partial | Capture as explicit array in canonical model. |
| `Other Remarks` | miscellaneous deployment notes | Partial | Low-priority catchall. |
| `Glossary` | none today | Missing | Add glossary generation from platform/services terminology. |

### 5.2 SDD Implementation Guidance

The current SDD flow in [server/document-routes.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-routes.ts) is already the best foundation to keep:

- `buildSddProsePrompt(...)`
- `buildSddArtifactsPrompt(...)`
- artifact validation via `ensureArtifactBlock(...)`

What should change is the output structure:

1. generate canonical `solution` data
2. render template-aligned SDD sections
3. append or embed orchestrator artifacts in a dedicated appendix or deployment-spec section

### 5.3 SDD Code Changes Recommended

- keep the artifact generation path
- replace freeform prose with template-shaped generation:
  - `buildCanonicalSddModel(...)`
  - `renderSddTemplate(...)`
- preserve the artifact fence internally for machine parsing, but do not make the user-facing SDD read like a mixed prose/JSON document

## 6. DSD Template Mapping

CB2YY does not currently have a first-class DSD generator. The closest current source is the Developer Handoff Guide generated in [server/dhg-generator.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\dhg-generator.ts).

That means the DSD mapping is the most important structural upgrade.

### 6.1 Section Mapping

| UiPath DSD Section | CB2YY Source Today | Current Coverage | Implementation Notes |
|---|---|---|---|
| `Purpose` | DHG intro + process context | Strong | Easy mapping. |
| `Automated process details` | DHG process context + business overview | Strong | Reuse process overview and workflow purpose details. |
| `Runtime guide` | DHG pre-deployment checklist + trigger config + environment requirements | Strong | Very close already. |
| `Architectural structure of the Master Project` | DHG workflow inventory + workflow contracts + solution/package metadata | Strong | Direct mapping with better formatting. |
| `Master Project Runtime Details` | queues, triggers, machine templates, exception coverage, deployment readiness | Strong | Already available across DHG sections. |
| `Project details` | workflow contracts, studio compatibility, package metadata | Strong | Already generated; needs cleaner organization. |
| `Project(s) workflows` | workflow inventory + per-workflow contracts | Strong | Direct mapping. |
| `Other Details` | quality findings, cross-reference findings, deployment constraints | Strong | Use DHG findings sections here. |
| `Debugging Tips` | not explicit today, but can be derived from DHG findings and compatibility guidance | Partial | Add deterministic debugging-tips generation. |
| `Post UAT Specifications` | post-deployment checklist + readiness notes | Partial | Add structured UAT/post-UAT outputs. |
| `Glossary` | none today | Missing | Add generated glossary. |

### 6.2 DSD Implementation Guidance

The DSD should be treated as the formalized version of the DHG plus runtime architecture details.

Recommended approach:

1. refactor `dhg-generator.ts` so it can output a structured DSD model instead of only markdown
2. create:
   - `buildCanonicalDsdModel(...)`
   - `renderDsdTemplate(...)`
3. preserve DHG markdown as an engineering artifact if useful, but make the DSD the primary customer-facing implementation document

## 7. Process Map Rendering Standard

The user explicitly requested yFiles BPMN style going forward.

That means:

- As-Is and To-Be diagrams should be rendered in a BPMN-like style
- the same renderer should be used for:
  - PDD map sections
  - exported process-map images
  - any embedded doc visuals

Implementation note:

- the current process map layer already supports rendering images
- the renderer should be updated or wrapped so that the final embedded images follow a BPMN-like presentation standard

## 8. Recommended Build Order

To minimize risk and maximize reuse, the implementation order should be:

### Phase 1: Canonical model

Create a shared document-model builder that assembles:

- process metadata
- as-is / to-be structures
- workflow inventory
- orchestrator artifacts
- QA assets
- runtime/deployment guidance

### Phase 2: PDD template renderer

Implement first because:

- it is the most business-facing
- its inputs are already mostly available from maps + idea context
- it sets the pattern for template rendering

### Phase 3: SDD template renderer

Implement second because:

- current SDD generation is already strong
- it mostly needs structural remapping and docx template rendering

### Phase 4: DSD template renderer

Implement third by refactoring DHG outputs into:

- formal DSD sections
- debugging tips
- post-UAT support guidance

## 9. Specific Code Recommendations

### 9.1 New modules to add

- `server/doc-templates/canonical-doc-model.ts`
- `server/doc-templates/pdd-template-renderer.ts`
- `server/doc-templates/sdd-template-renderer.ts`
- `server/doc-templates/dsd-template-renderer.ts`
- `server/doc-templates/template-loader.ts`

### 9.2 Existing modules to refactor

- [C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-routes.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\document-routes.ts)
  - keep approval, storage, artifact validation, and route orchestration
  - remove responsibility for raw document shape
- [C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\dhg-generator.ts](C:\Users\yusuf.yasin\Downloads\CannonBall\CB2_git\server\dhg-generator.ts)
  - split into:
    - structured data extractor
    - markdown handoff renderer
    - future DSD renderer input builder

## 10. Minimum Viable Mapping Rules

If CB2YY needs an incremental rollout instead of a full rewrite, use these minimum rules:

1. PDD generation must follow the UiPath PDD section order exactly.
2. SDD generation must separate:
   - prose sections
   - runtime/deployment sections
   - artifacts appendix
3. DSD generation may initially reuse DHG data, but must output the UiPath DSD section headings exactly.
4. All three docs should use the UiPath template Word styles.
5. Process maps embedded in PDD must use yFiles BPMN-style visuals.

## 11. Practical Status Assessment

### Already strong

- SDD content depth
- orchestrator artifact generation
- workflow/runtime analysis
- developer handoff/runtime content
- requirements / test cases / test sets

### Partially ready

- PDD business narrative
- scope and exception sections
- reporting sections
- runtime guide content

### Missing / needs explicit implementation

- key contacts
- process statistics
- parallel initiatives
- structured glossary generation
- first-class DSD document generation
- docx template rendering by section instead of freeform prose

## 12. Bottom Line

CB2YY already has most of the raw content needed to populate the UiPath PDD, SDD, and DSD templates.

The main missing capability is not content generation, but structured rendering:

- normalize the data once
- map it section-by-section
- render it into the official templates

That is the path that should now be treated as the default document architecture for CB2YY.
