import type {
  PipelineOutcomeReport,
  RemediationEntry,
  PerWorkflowStudioCompatibility,
} from "./uipath-pipeline";
import type { DhgAnalysisResult, SddArtifactCrossReference } from "./xaml/dhg-analyzers";

export interface DhgContext {
  projectName: string;
  workflowNames: string[];
  generationMode?: "full_implementation" | "baseline_openable";
  generationModeReason?: string;
  generatedDate?: string;
  analysis?: DhgAnalysisResult;
  xamlEntries?: Array<{ name: string; content: string }>;
}

type DetectedBindPoint = {
  file: string;
  displayName: string;
  system: string;
  detail: string;
  estimatedEffortMinutes: number;
};

type BindPointSummary = {
  entries: DetectedBindPoint[];
  totalEstimatedEffortMinutes: number;
  workflowsWithBindPoints: Set<string>;
  systems: Set<string>;
};

type WorkflowContractSummary = {
  file: string;
  role: string;
  inputs: string[];
  outputs: string[];
  implementationStatus: "implemented" | "developer-bind-points" | "generated";
  developerNotes: string[];
};

function inferWorkflowRoleFromName(file: string): string {
  const normalized = file.replace(/\.xaml$/i, "").toLowerCase();
  if (normalized === "main") return "Orchestration";
  if (normalized.includes("init")) return "Initialization";
  if (normalized.includes("intake") || normalized.includes("dispatcher")) return "Intake / Dispatch";
  if (normalized.includes("entity") || normalized.includes("resolver")) return "Entity Resolution";
  if (normalized.includes("draft") || normalized.includes("composer")) return "Drafting / Composition";
  if (normalized.includes("outbound") || normalized.includes("email") || normalized.includes("communication")) return "Outbound Communication";
  if (normalized.includes("review") || normalized.includes("approval") || normalized.includes("exception")) return "Review / Exception Handling";
  if (normalized.includes("audit") || normalized.includes("persist")) return "Audit / Persistence";
  if (normalized.includes("process") || normalized.includes("performer")) return "Transaction Processing";
  return "Business Workflow";
}

function extractDeclaredArguments(content: string): { inputs: string[]; outputs: string[] } {
  const membersBlock = content.match(/<x:Members>([\s\S]*?)<\/x:Members>/i)?.[1] || "";
  const inputs: string[] = [];
  const outputs: string[] = [];
  const seen = new Set<string>();
  const memberRegex = /<x:Property\b[^>]*Name="([^"]+)"[^>]*Type="([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = memberRegex.exec(membersBlock)) !== null) {
    const name = match[1];
    const normalized = name.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    if (normalized.startsWith("out_")) {
      outputs.push(name);
    } else {
      inputs.push(name);
    }
  }
  return { inputs, outputs };
}

function summarizeWorkflowContracts(
  xamlEntries: Array<{ name: string; content: string }> | undefined,
  bindPointSummary: BindPointSummary,
): WorkflowContractSummary[] {
  if (!xamlEntries || xamlEntries.length === 0) return [];

  return xamlEntries
    .filter(entry => entry.name.toLowerCase().endsWith(".xaml"))
    .map((entry) => {
      const file = entry.name.split("/").pop() || entry.name;
      const args = extractDeclaredArguments(entry.content);
      const hasBindPoints = bindPointSummary.workflowsWithBindPoints.has(file);
      const developerNotes: string[] = [];
      if (hasBindPoints) {
        developerNotes.push("Contains system bind points that must be implemented for production.");
      }
      if (file.toLowerCase() === "main.xaml") {
        developerNotes.push("Coordinates workflow sequencing and argument flow between generated subworkflows.");
      }
      return {
        file,
        role: inferWorkflowRoleFromName(file),
        inputs: args.inputs,
        outputs: args.outputs,
        implementationStatus: hasBindPoints ? "developer-bind-points" : "generated",
        developerNotes,
      };
    });
}

function estimateBindPointEffort(system: string): number {
  const normalized = system.toLowerCase();
  if (normalized.includes("queue")) return 45;
  if (normalized.includes("action center")) return 45;
  if (normalized.includes("data service")) return 45;
  if (normalized.includes("genai")) return 40;
  if (normalized.includes("gmail")) return 30;
  if (normalized.includes("http") || normalized.includes("webhook")) return 30;
  if (normalized.includes("calendar") || normalized.includes("contacts")) return 30;
  return 25;
}

function summarizeBindPoints(xamlEntries?: Array<{ name: string; content: string }>): BindPointSummary {
  const entries: DetectedBindPoint[] = [];
  const workflowsWithBindPoints = new Set<string>();
  const systems = new Set<string>();
  if (!xamlEntries || xamlEntries.length === 0) {
    return { entries, totalEstimatedEffortMinutes: 0, workflowsWithBindPoints, systems };
  }

  const seen = new Set<string>();
  const logTagRegex = /<ui:LogMessage\b[^>]*\/>/gi;
  for (const entry of xamlEntries) {
    const file = entry.name.split("/").pop() || entry.name;
    const content = entry.content;
    let match: RegExpExecArray | null;
    while ((match = logTagRegex.exec(entry.content)) !== null) {
      const tag = match[0];
      const displayName = tag.match(/\bDisplayName="([^"]*Bind Point[^"]*)"/i)?.[1];
      const detail = tag.match(/\bMessage="\[&quot;([^"]*?)&quot;\]"/i)?.[1]?.replace(/&amp;/g, "&");
      if (!displayName || !detail) continue;
      const systemMatch = displayName.match(/Bind Point - (.+)$/i);
      const system = systemMatch?.[1]?.trim() || "External system";
      const systemLower = system.toLowerCase();
      const hasQueueImplementation = /<(?:ui):(?:AddQueueItem|GetTransactionItem|SetTransactionStatus)\b/i.test(content);
      const hasEmailImplementation = /<(?:ui|ugs):(?:GmailSendMessage|SendOutlookMailMessage|SendMail365)\b/i.test(content);
      const hasActionCenterImplementation = /<(?:ui|upers):(?:CreateFormTask|WaitForFormTaskAndResume|CreateTask)\b/i.test(content);
      if (systemLower.includes("queue") && hasQueueImplementation) continue;
      if ((systemLower.includes("gmail") || systemLower.includes("mail") || systemLower.includes("email")) && hasEmailImplementation) continue;
      if (systemLower.includes("action center") && hasActionCenterImplementation) continue;
      const key = `${file}::${displayName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        file,
        displayName,
        system,
        detail,
        estimatedEffortMinutes: estimateBindPointEffort(system),
      });
      workflowsWithBindPoints.add(file);
      systems.add(system);
    }
  }

  return {
    entries,
    totalEstimatedEffortMinutes: entries.reduce((sum, entry) => sum + entry.estimatedEffortMinutes, 0),
    workflowsWithBindPoints,
    systems,
  };
}

export function generateDhgFromOutcomeReport(
  report: PipelineOutcomeReport,
  context: DhgContext,
): string {
  const date = context.generatedDate || new Date().toISOString().split("T")[0];
  const bindPointSummary = summarizeBindPoints(context.xamlEntries);
  const workflowContracts = summarizeWorkflowContracts(context.xamlEntries, bindPointSummary);
  const bindPointCount = bindPointSummary.entries.length;
  let sectionNum = 0;
  let md = "";

  md += `# Developer Handoff Guide\n\n`;
  md += `**Project:** ${context.projectName}\n`;
  md += `**Generated:** ${date}\n`;
  if (context.generationMode) {
    const modeLabel = context.generationMode === "baseline_openable"
      ? "Baseline Openable (minimal, deterministic)"
      : "Full Implementation";
    md += `**Generation Mode:** ${modeLabel}\n`;
    if (context.generationModeReason) md += `**Mode Reason:** ${context.generationModeReason}\n`;
  }

  const totalPropertyRemediations = report.propertyRemediations.length;
  const totalActivityRemediations = report.remediations.filter(r => r.level === "activity").length;
  const totalSequenceRemediations = report.remediations.filter(r => r.level === "sequence").length;
  const totalStructuralLeafRemediations = report.remediations.filter(r => r.level === "structural-leaf").length;
  const totalWorkflowRemediations = report.remediations.filter(r => r.level === "workflow").length;
  const totalRemediations = totalPropertyRemediations + report.remediations.length;

  const hasStubs = totalWorkflowRemediations > 0 || totalActivityRemediations > 0 || totalSequenceRemediations > 0 || totalStructuralLeafRemediations > 0;
  const hasStructuralDefects = report.studioCompatibility?.some(
    (sc: PerWorkflowStudioCompatibility) => sc.level === "studio-blocked"
  ) ?? false;
  const transitiveDependencyWarnings = report.qualityWarnings.filter(
    w => w.check === "transitive-dependency-missing" || w.check === "error-activity-reference" || w.check === "unresolved-type-argument"
  );

  if (context.analysis) {
    const r = context.analysis.readiness;
    let adjustedPercent = r.percent;
    let adjustedRating = r.rating;
    if ((hasStubs || hasStructuralDefects) && adjustedPercent > 69) {
      adjustedPercent = Math.min(adjustedPercent, 69);
      adjustedRating = adjustedPercent >= 65 ? "Mostly Ready" : adjustedPercent >= 40 ? "Needs Work" : "Not Ready";
    }
    if (transitiveDependencyWarnings.length > 0 && adjustedPercent > 79) {
      adjustedPercent = Math.min(adjustedPercent, 79);
      adjustedRating = adjustedPercent >= 65 ? "Mostly Ready" : adjustedPercent >= 40 ? "Needs Work" : "Not Ready";
    }
    if (context.generationMode === "baseline_openable" && bindPointCount > 0) {
      adjustedPercent = Math.min(adjustedPercent, bindPointCount >= 4 ? 45 : 55);
      adjustedRating = adjustedPercent >= 40 ? "Needs Work" : "Not Ready";
    }
    md += `**Deployment Readiness:** ${adjustedRating} (${adjustedPercent}%)\n`;
  }

  md += `\n`;

  const totalEstimatedEffortMinutes = report.totalEstimatedEffortMinutes + bindPointSummary.totalEstimatedEffortMinutes;
  md += `**Total Estimated Effort: ~${totalEstimatedEffortMinutes} minutes (${(totalEstimatedEffortMinutes / 60).toFixed(1)} hours)**\n`;
  md += `**Remediations:** ${totalRemediations} total (${totalPropertyRemediations} property, ${totalActivityRemediations} activity, ${totalSequenceRemediations} sequence, ${totalStructuralLeafRemediations} structural-leaf, ${totalWorkflowRemediations} workflow)\n`;
  md += `**Auto-Repairs:** ${report.autoRepairs.length}\n`;
  md += `**Quality Warnings:** ${report.qualityWarnings.length}\n`;
  md += `\n---\n\n`;

  sectionNum++;
  md += `## ${sectionNum}. Completed Work\n\n`;
  if (report.fullyGeneratedFiles.length > 0) {
    if (context.generationMode === "baseline_openable" && bindPointCount > 0) {
      md += `The following ${report.fullyGeneratedFiles.length} workflow(s) were generated as structurally valid baseline workflows. ${bindPointSummary.workflowsWithBindPoints.size} workflow(s) still contain developer bind points for business implementation.\n\n`;
    } else {
      md += `The following ${report.fullyGeneratedFiles.length} workflow(s) were fully generated without any stub replacements or remediation:\n\n`;
    }
    for (const f of report.fullyGeneratedFiles) {
      md += `- \`${f}\`\n`;
    }
    md += `\n`;
  } else {
    md += `No workflows were generated without remediation.\n\n`;
  }

  if (context.workflowNames.length > 0) {
    md += `### Workflow Inventory\n\n`;
    md += `| # | Workflow | Status |\n`;
    md += `|---|----------|--------|\n`;
    const studioCompat = report.studioCompatibility || [];
    context.workflowNames.forEach((wf, i) => {
      const isStubbed = report.remediations.some(
        r => (r.remediationCode === "STUB_WORKFLOW_GENERATOR_FAILURE" || r.remediationCode === "STUB_WORKFLOW_BLOCKING") && (r.file === `${wf}.xaml` || r.file === wf)
      );
      const isFullyGenerated = report.fullyGeneratedFiles.some(f => f === `${wf}.xaml` || f === wf);
      const hasRemediation = [...report.remediations, ...report.propertyRemediations].some(
        r => r.file === `${wf}.xaml` || r.file === wf
      );
      const hasBindPoints = bindPointSummary.workflowsWithBindPoints.has(`${wf}.xaml`) || bindPointSummary.workflowsWithBindPoints.has(wf);
      const hasPlaceholders = report.qualityWarnings.some(
        w => w.check === "placeholder-value" && (w.file === `${wf}.xaml` || w.file === wf)
      );
      const studioEntry = studioCompat.find(
        (s: PerWorkflowStudioCompatibility) => s.file === `${wf}.xaml` || s.file === wf
      );
      const isStudioBlocked = studioEntry && studioEntry.level === "studio-blocked";

      let status: string;
      if (isStubbed || isStudioBlocked) {
        const failureSummary = studioEntry?.failureSummary;
        status = failureSummary
          ? `Structurally invalid — ${failureSummary}`
          : "Structurally invalid (not Studio-loadable)";
      } else if (hasBindPoints && context.generationMode === "baseline_openable") {
        status = "Generated with Developer Bind Points";
      } else if (isFullyGenerated) {
        status = "Fully Generated";
      } else if (hasPlaceholders) {
        status = "Generated with Placeholders";
      } else if (hasRemediation) {
        status = "Generated with Remediations";
      } else {
        status = "Generated";
      }
      md += `| ${i + 1} | \`${wf}.xaml\` | ${status} |\n`;
    });
    md += `\n`;
  }

  if (workflowContracts.length > 0) {
    md += `### Workflow Contracts\n\n`;
    md += `| # | Workflow | Role | Inputs | Outputs | Delivery Status | Developer Guidance |\n`;
    md += `|---|----------|------|--------|---------|-----------------|--------------------|\n`;
    workflowContracts.forEach((contract, i) => {
      const inputs = contract.inputs.length > 0 ? contract.inputs.join(", ") : "—";
      const outputs = contract.outputs.length > 0 ? contract.outputs.join(", ") : "—";
      const deliveryStatus = contract.implementationStatus === "developer-bind-points"
        ? "Bind points remain"
        : contract.implementationStatus === "implemented"
          ? "Implemented"
          : "Generated";
      const developerGuidance = contract.developerNotes.length > 0
        ? contract.developerNotes.join(" ")
        : "Validate role alignment and complete environment binding as needed.";
      md += `| ${i + 1} | \`${contract.file}\` | ${contract.role} | ${inputs.replace(/\|/g, "\\|")} | ${outputs.replace(/\|/g, "\\|")} | ${deliveryStatus} | ${developerGuidance.replace(/\|/g, "\\|")} |\n`;
    });
    md += `\n`;
  }

  if (report.studioCompatibility && report.studioCompatibility.length > 0) {
    md += `### Studio Compatibility\n\n`;
    md += `| # | Workflow | Compatibility | Failure Category | Blockers |\n`;
    md += `|---|----------|--------------|-----------------|----------|\n`;
    report.studioCompatibility.forEach((sc, i) => {
      const levelLabel = sc.level === "studio-clean"
        ? "Studio-openable"
        : sc.level === "studio-warnings"
          ? "Openable with warnings"
          : "Structurally invalid — not Studio-loadable";
      const categoryLabel = sc.failureCategory
        ? sc.failureCategory.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())
        : sc.level === "studio-clean" ? "—" : "Unclassified";
      const blockerSummary = sc.blockers.length > 0
        ? sc.blockers.slice(0, 3).map(b => b.length > 80 ? b.slice(0, 77) + "..." : b).join("; ").replace(/\|/g, "\\|")
        : "—";
      md += `| ${i + 1} | \`${sc.file}\` | ${levelLabel} | ${categoryLabel} | ${blockerSummary} |\n`;
    });
    const blocked = report.studioCompatibility.filter(sc => sc.level === "studio-blocked");
    const warnings = report.studioCompatibility.filter(sc => sc.level === "studio-warnings");
    const clean = report.studioCompatibility.filter(sc => sc.level === "studio-clean");
    md += `\n`;
    md += `**Summary:** ${clean.length} Studio-loadable, ${warnings.length} with warnings, ${blocked.length} not Studio-loadable\n\n`;
    if (blocked.length > 0) {
      md += `> **⚠ ${blocked.length} workflow(s) are not Studio-loadable** — they will fail to open in UiPath Studio. Address the blockers listed above before importing.\n\n`;
      const categoryCounts = new Map<string, number>();
      for (const b of blocked) {
        const cat = b.failureSummary || "Unknown";
        categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      }
      if (categoryCounts.size > 1) {
        md += `**Blocked by category:**\n`;
        for (const [cat, count] of categoryCounts) {
          md += `- ${cat}: ${count} workflow(s)\n`;
        }
        md += `\n`;
      }
    }
  }

  sectionNum++;
  md += `## ${sectionNum}. AI-Resolved with Smart Defaults\n\n`;
  if (report.autoRepairs.length > 0) {
    md += `The following ${report.autoRepairs.length} issue(s) were automatically corrected during the build pipeline. **No developer action required.**\n\n`;
    md += `| # | Code | File | Description | Est. Minutes |\n`;
    md += `|---|------|------|-------------|-------------|\n`;
    report.autoRepairs.forEach((r, i) => {
      const desc = (r.description || "").length > 100 ? (r.description || "").slice(0, 97) + "..." : (r.description || "—");
      md += `| ${i + 1} | \`${r.repairCode}\` | \`${r.file}\` | ${desc.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  } else {
    md += `No auto-repairs were applied.\n\n`;
  }

  if (report.downgradeEvents.length > 0) {
    md += `### Downgraded Components\n\n`;
    md += `| # | File | From | To | Reason | Developer Action | Est. Minutes |\n`;
    md += `|---|------|------|----|--------|-----------------|-------------|\n`;
    report.downgradeEvents.forEach((d, i) => {
      const reason = (d.triggerReason || "").length > 80 ? (d.triggerReason || "").slice(0, 77) + "..." : (d.triggerReason || "—");
      md += `| ${i + 1} | ${d.file || "—"} | \`${d.fromMode}\` | \`${d.toMode}\` | ${reason.replace(/\|/g, "\\|")} | ${d.developerAction} | ${d.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  }

  sectionNum++;
  md += `## ${sectionNum}. Manual Action Required\n\n`;

  const allRemediations = [
    ...report.propertyRemediations,
    ...report.remediations,
  ];

  if (allRemediations.length === 0 && report.qualityWarnings.length === 0) {
    md += `No manual developer action is required.\n\n`;
  }

  if (bindPointSummary.entries.length > 0) {
    md += `### Developer Implementation Bind Points (${bindPointSummary.entries.length})\n\n`;
    md += `These workflows are Studio-openable but still require system-specific implementation before production deployment.\n\n`;
    md += `| # | File | System | Bind Point | Developer Action | Est. Minutes |\n`;
    md += `|---|------|--------|------------|-----------------|-------------|\n`;
    bindPointSummary.entries.forEach((entry, i) => {
      md += `| ${i + 1} | \`${entry.file}\` | ${entry.system.replace(/\|/g, "\\|")} | ${entry.displayName.replace(/\|/g, "\\|")} | ${entry.detail.replace(/\|/g, "\\|")} | ${entry.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  }

  if (report.propertyRemediations.length > 0) {
    md += `### Property-Level Remediations (${report.propertyRemediations.length})\n\n`;
    md += `Individual properties were replaced with safe defaults/placeholders. The rest of the activity is intact.\n\n`;
    md += `| # | File | Activity | Property | Code | Developer Action | Est. Minutes |\n`;
    md += `|---|------|----------|----------|------|-----------------|-------------|\n`;
    report.propertyRemediations.forEach((r, i) => {
      const actName = r.originalDisplayName || r.originalTag || "—";
      const propName = r.propertyName || "—";
      const action = (r.developerAction || "").length > 80
        ? (r.developerAction || "").slice(0, 77) + "..."
        : (r.developerAction || "—");
      md += `| ${i + 1} | \`${r.file}\` | ${actName} | \`${propName}\` | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  }

  const activityRemediations = report.remediations.filter(r => r.level === "activity");
  if (activityRemediations.length > 0) {
    md += `### Activity-Level Stubs (${activityRemediations.length})\n\n`;
    md += `Entire activities were replaced with TODO stubs. The surrounding workflow structure is preserved.\n\n`;
    md += `| # | File | Activity | Code | Developer Action | Est. Minutes |\n`;
    md += `|---|------|----------|------|-----------------|-------------|\n`;
    activityRemediations.forEach((r, i) => {
      const actName = r.originalDisplayName || r.originalTag || "—";
      const action = (r.developerAction || "").length > 80
        ? (r.developerAction || "").slice(0, 77) + "..."
        : (r.developerAction || "—");
      md += `| ${i + 1} | \`${r.file}\` | ${actName} | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  }

  const sequenceRemediations = report.remediations.filter(r => r.level === "sequence");
  if (sequenceRemediations.length > 0) {
    md += `### Sequence-Level Stubs (${sequenceRemediations.length})\n\n`;
    md += `Sequence children were replaced with a single TODO stub because multiple activities in the sequence had issues.\n\n`;
    md += `| # | File | Sequence | Code | Developer Action | Est. Minutes |\n`;
    md += `|---|------|----------|------|-----------------|-------------|\n`;
    sequenceRemediations.forEach((r, i) => {
      const seqName = r.originalDisplayName || "—";
      const action = (r.developerAction || "").length > 80
        ? (r.developerAction || "").slice(0, 77) + "..."
        : (r.developerAction || "—");
      md += `| ${i + 1} | \`${r.file}\` | ${seqName} | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  }

  const structuralLeafRemediations = report.remediations.filter(r => r.level === "structural-leaf");
  if (structuralLeafRemediations.length > 0) {
    md += `### Structural-Leaf Stubs (${structuralLeafRemediations.length})\n\n`;
    md += `Individual leaf activities were stubbed while preserving the workflow skeleton (sequences, branches, try/catch, loops, invocations).\n\n`;
    md += `| # | File | Activity | Original Tag | Code | Developer Action | Est. Minutes |\n`;
    md += `|---|------|----------|-------------|------|-----------------|-------------|\n`;
    structuralLeafRemediations.forEach((r, i) => {
      const actName = r.originalDisplayName || "—";
      const tag = r.originalTag || "—";
      const action = (r.developerAction || "").length > 80
        ? (r.developerAction || "").slice(0, 77) + "..."
        : (r.developerAction || "—");
      md += `| ${i + 1} | \`${r.file}\` | ${actName} | \`${tag}\` | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;

    if (report.structuralPreservationMetrics && report.structuralPreservationMetrics.length > 0) {
      md += `#### Structural Preservation Metrics\n\n`;
      md += `| File | Total Activities | Preserved | Stubbed | Preservation Rate | Studio-Loadable | Preserved Structures |\n`;
      md += `|------|-----------------|-----------|---------|-------------------|----------------|---------------------|\n`;
      for (const m of report.structuralPreservationMetrics) {
        const rate = m.totalActivities > 0 ? Math.round((m.preservedActivities / m.totalActivities) * 100) : 0;
        const structures = m.preservedStructures.length > 3
          ? m.preservedStructures.slice(0, 3).join(", ") + `... (+${m.preservedStructures.length - 3})`
          : m.preservedStructures.join(", ");
        const loadableLabel = m.studioLoadable === false
          ? "No"
          : m.studioLoadable === true
            ? "Yes"
            : "Unknown";
        md += `| \`${m.file}\` | ${m.totalActivities} | ${m.preservedActivities} | ${m.stubbedActivities} | ${rate}% | ${loadableLabel} | ${structures} |\n`;
      }
      md += `\n`;
      const nonLoadable = report.structuralPreservationMetrics.filter(m => m.studioLoadable === false);
      if (nonLoadable.length > 0) {
        md += `> **⚠ ${nonLoadable.length} structurally-preserved file(s) are not Studio-loadable** despite high preservation rates. `;
        md += `XML structure is intact but Studio cannot load these files (missing Implementation/DynamicActivity). `;
        md += `These require rebuilding from scratch.\n\n`;
        for (const m of nonLoadable) {
          if (m.studioLoadableNote) {
            md += `> - \`${m.file}\`: ${m.studioLoadableNote}\n`;
          }
        }
        if (nonLoadable.some(m => m.studioLoadableNote)) md += `\n`;
      }
    }
  }

  const validationFindings = report.remediations.filter(r => r.level === "validation-finding");
  if (validationFindings.length > 0) {
    md += `### Validation Issues — Requires Manual Attention (${validationFindings.length})\n\n`;
    md += `The following issues were detected by the quality gate and require developer review. No automated remediation was applied — workflows are preserved as-generated.\n\n`;
    md += `| # | File | Check | Developer Action | Est. Minutes |\n`;
    md += `|---|------|-------|-----------------|-------------|\n`;
    validationFindings.forEach((r, i) => {
      const action = (r.developerAction || "").length > 80
        ? (r.developerAction || "").slice(0, 77) + "..."
        : (r.developerAction || "—");
      md += `| ${i + 1} | \`${r.file}\` | \`${r.classifiedCheck}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  }

  const workflowRemediations = report.remediations.filter(r => r.level === "workflow");
  if (workflowRemediations.length > 0) {
    md += `### Workflow-Level Stubs (${workflowRemediations.length})\n\n`;
    md += `Entire workflows were replaced with Studio-openable stubs (XAML was not parseable for structural preservation).\n\n`;
    md += `| # | File | Code | Developer Action | Est. Minutes |\n`;
    md += `|---|------|------|-----------------|-------------|\n`;
    workflowRemediations.forEach((r, i) => {
      const action = (r.developerAction || "").length > 80
        ? (r.developerAction || "").slice(0, 77) + "..."
        : (r.developerAction || "—");
      md += `| ${i + 1} | \`${r.file}\` | \`${r.remediationCode}\` | ${action.replace(/\|/g, "\\|")} | ${r.estimatedEffortMinutes} |\n`;
    });
    md += `\n`;
  }

  if (transitiveDependencyWarnings.length > 0) {
    md += `### Transitive Dependency Issues (${transitiveDependencyWarnings.length})\n\n`;
    md += `Activities reference packages or types that are not declared in project.json. These may cause runtime failures.\n\n`;
    md += `| # | File | Check | Detail | Est. Minutes |\n`;
    md += `|---|------|-------|--------|-------------|\n`;
    transitiveDependencyWarnings.forEach((w, i) => {
      const detail = (w.detail || "").length > 100 ? (w.detail || "").slice(0, 97) + "..." : (w.detail || "—");
      md += `| ${i + 1} | \`${w.file}\` | ${w.check} | ${detail.replace(/\|/g, "\\|")} | ${w.estimatedEffortMinutes || 10} |\n`;
    });
    md += `\n`;
  }

  if (report.qualityWarnings.length > 0) {
    const selectorWarnings = report.qualityWarnings.filter(w => w.check === "SELECTOR_PLACEHOLDER" || w.check === "SELECTOR_LOW_QUALITY");
    const nonTransitiveWarnings = report.qualityWarnings.filter(w =>
      w.check !== "SELECTOR_PLACEHOLDER" && w.check !== "SELECTOR_LOW_QUALITY" &&
      w.check !== "transitive-dependency-missing" && w.check !== "error-activity-reference" && w.check !== "unresolved-type-argument"
    );

    if (selectorWarnings.length > 0) {
      md += `### UI Selector Warnings (${selectorWarnings.length})\n\n`;
      md += `These selectors need attention to ensure reliable UI automation.\n\n`;
      md += `| # | File | Check | Business Context | Detail | Est. Minutes |\n`;
      md += `|---|------|-------|-----------------|--------|-------------|\n`;
      selectorWarnings.forEach((w, i) => {
        const detail = (w.detail || "").length > 80 ? (w.detail || "").slice(0, 77) + "..." : (w.detail || "—");
        const context = (w.businessContext || "—").length > 80
          ? (w.businessContext || "").slice(0, 77) + "..."
          : (w.businessContext || "—");
        md += `| ${i + 1} | \`${w.file}\` | ${w.check} | ${context.replace(/\|/g, "\\|")} | ${detail.replace(/\|/g, "\\|")} | ${w.estimatedEffortMinutes || 15} |\n`;
      });
      md += `\n`;
    }

    if (nonTransitiveWarnings.length > 0) {
      const placeholderWarnings = nonTransitiveWarnings.filter(w => w.check === "placeholder-value");
      const otherWarnings = nonTransitiveWarnings.filter(w => w.check !== "placeholder-value");

      if (placeholderWarnings.length > 0) {
        const handoffWarnings = placeholderWarnings.filter(w => (w as any).stubCategory !== "failure");
        const failureWarnings = placeholderWarnings.filter(w => (w as any).stubCategory === "failure");

        if (handoffWarnings.length > 0) {
          md += `### Developer Implementation Required (${handoffWarnings.length})\n\n`;
          md += `These placeholders represent intentional handoff points where developer implementation is expected.\n\n`;
          md += `| # | File | Detail | Est. Minutes |\n`;
          md += `|---|------|--------|-------------|\n`;
          handoffWarnings.forEach((w, i) => {
            const detail = (w.detail || "").length > 100 ? (w.detail || "").slice(0, 97) + "..." : (w.detail || "—");
            md += `| ${i + 1} | \`${w.file}\` | ${detail.replace(/\|/g, "\\|")} | ${w.estimatedEffortMinutes || 10} |\n`;
          });
          md += `\n`;
        }

        if (failureWarnings.length > 0) {
          md += `### Generation Failures — Pipeline Errors (${failureWarnings.length})\n\n`;
          md += `These placeholders exist because the generation pipeline could not produce the content. These should be prioritized for remediation.\n\n`;
          md += `| # | File | Detail | Est. Minutes |\n`;
          md += `|---|------|--------|-------------|\n`;
          failureWarnings.forEach((w, i) => {
            const detail = (w.detail || "").length > 100 ? (w.detail || "").slice(0, 97) + "..." : (w.detail || "—");
            md += `| ${i + 1} | \`${w.file}\` | ${detail.replace(/\|/g, "\\|")} | ${w.estimatedEffortMinutes || 15} |\n`;
          });
          md += `\n`;
        }
      }

      if (otherWarnings.length > 0) {
        md += `### Quality Warnings (${otherWarnings.length})\n\n`;
        md += `| # | File | Check | Detail | Developer Action | Est. Minutes |\n`;
        md += `|---|------|-------|--------|-----------------|-------------|\n`;
        otherWarnings.forEach((w, i) => {
          const detail = (w.detail || "").length > 100 ? (w.detail || "").slice(0, 97) + "..." : (w.detail || "—");
          const action = (w.developerAction || "").length > 80
            ? (w.developerAction || "").slice(0, 77) + "..."
            : (w.developerAction || "—");
          md += `| ${i + 1} | \`${w.file}\` | ${w.check} | ${detail.replace(/\|/g, "\\|")} | ${action.replace(/\|/g, "\\|")} | ${w.estimatedEffortMinutes} |\n`;
        });
        md += `\n`;
      }
    }
  }

  if (allRemediations.length > 0 || report.qualityWarnings.length > 0) {
    const remediationEffort = allRemediations.reduce((s, r) => s + (r.estimatedEffortMinutes || 0), 0);
    const warningEffort = report.qualityWarnings.reduce((s, w) => s + (w.estimatedEffortMinutes || 0), 0);
    const totalEffort = remediationEffort + warningEffort + bindPointSummary.totalEstimatedEffortMinutes;
    md += `**Total manual remediation effort: ~${totalEffort} minutes (${(totalEffort / 60).toFixed(1)} hours)**\n\n`;
  } else if (bindPointSummary.entries.length > 0) {
    md += `**Total manual remediation effort: ~${bindPointSummary.totalEstimatedEffortMinutes} minutes (${(bindPointSummary.totalEstimatedEffortMinutes / 60).toFixed(1)} hours)**\n\n`;
  }

  if (context.analysis) {
    if (context.analysis.upstreamContext) {
      md += generateUpstreamContextSection(context.analysis, ++sectionNum);
      if (hasProcessMapData(context.analysis)) {
        md += generateBusinessProcessOverviewSection(context.analysis, ++sectionNum);
      }
    }
    md += generateEnvironmentSetupSection(context.analysis, ++sectionNum, bindPointSummary);
    md += generateCredentialAssetSection(context.analysis, ++sectionNum);
    if (context.analysis.sddCrossReference) {
      md += generateCrossReferenceSection(context.analysis.sddCrossReference, ++sectionNum);
    }
    md += generateQueueManagementSection(context.analysis, ++sectionNum, bindPointSummary);
    md += generateExceptionCoverageSection(context.analysis, ++sectionNum);
    md += generateTriggerConfigSection(context.analysis, ++sectionNum);
    if (context.analysis.upstreamContext?.qualityWarnings && context.analysis.upstreamContext.qualityWarnings.length > 0) {
      md += generateUpstreamWarningsSection(context.analysis, ++sectionNum);
    }
    md += generatePreDeploymentChecklist(context.analysis, ++sectionNum);
    md += generateTruthfulReadinessScoreSection(context.analysis, ++sectionNum, bindPointSummary, context.generationMode);
  }

  if (report.preEmissionValidation) {
    const pev = report.preEmissionValidation;
    sectionNum++;
    md += `## ${sectionNum}. Pre-emission Spec Validation\n\n`;
    md += `Validation was performed on the WorkflowSpec tree before XAML assembly. `;
    md += `Issues caught at this stage are cheaper to fix than post-emission quality gate findings.\n\n`;
    md += `| Metric | Count |\n|---|---|\n`;
    md += `| Total activities checked | ${pev.totalActivities} |\n`;
    md += `| Valid activities | ${pev.validActivities} |\n`;
    md += `| Unknown → Comment stubs | ${pev.unknownActivities} |\n`;
    md += `| Non-catalog properties stripped | ${pev.strippedProperties} |\n`;
    md += `| Enum values auto-corrected | ${pev.enumCorrections} |\n`;
    md += `| Missing required props filled | ${pev.missingRequiredFilled} |\n`;
    md += `| Total issues | ${pev.issueCount} |\n\n`;

    const preEmissionFixCount = pev.enumCorrections + pev.strippedProperties + pev.missingRequiredFilled + pev.commentConversions;
    const postEmissionIssueCount = report.qualityWarnings.length + report.remediations.length;
    md += `### Pre-emission vs Post-emission\n\n`;
    md += `| Stage | Issues Caught/Fixed |\n|---|---|\n`;
    md += `| Pre-emission (spec validation) | ${preEmissionFixCount} auto-fixed, ${pev.issueCount} total issues |\n`;
    md += `| Post-emission (quality gate) | ${postEmissionIssueCount} warnings/remediations |\n\n`;
  }

  md += `---\n\n`;

  sectionNum++;
  md += `## ${sectionNum}. Structured Report (JSON)\n\n`;
  md += `The following JSON appendix contains the full pipeline outcome report for programmatic consumption:\n\n`;
  md += "```json\n";
  md += JSON.stringify(report, null, 2);
  md += "\n```\n";

  return md;
}

function generateEnvironmentSetupSection(analysis: DhgAnalysisResult, sectionNum: number, bindPointSummary?: BindPointSummary): string {
  const env = analysis.environmentRequirements;
  const bindSystems = bindPointSummary?.systems || new Set<string>();
  const needsOrchestrator = env.usesOrchestrator || Array.from(bindSystems).some(s => /queue|action center|orchestrator/i.test(s));
  let md = `## ${sectionNum}. Environment Setup\n\n`;

  md += `| Requirement | Value |\n`;
  md += `|---|---|\n`;
  md += `| Target Framework | ${env.needsWindowsTarget ? "Windows (required)" : "Windows or Portable"} |\n`;
  md += `| Robot Type | ${env.needsAttendedRobot ? "Attended (user interaction required)" : "Unattended"} |\n`;
  md += `| Modern Activities | ${env.usesModernActivities ? "Yes" : "No"} |\n`;
  md += `| Studio Version | ${env.studioVersion} |\n`;
  md += `| Orchestrator Connection | ${needsOrchestrator ? "Required" : "Not required"} |\n`;
  md += `| Machine Template | ${env.machineTemplate.recommendedType} |\n`;

  if (env.usesActionCenter || Array.from(bindSystems).some(s => /action center/i.test(s))) md += `| Action Center | Required |\n`;
  if (env.usesAICenter || Array.from(bindSystems).some(s => /genai/i.test(s))) md += `| AI Center | Required |\n`;
  if (env.usesDocumentUnderstanding) md += `| Document Understanding | Required |\n`;
  if (env.usesDataService || Array.from(bindSystems).some(s => /data service/i.test(s))) md += `| Data Service | Required |\n`;
  md += `\n`;

  md += `### Machine Template\n\n`;
  md += `**Recommended:** ${env.machineTemplate.recommendedType}\n`;
  md += `${env.machineTemplate.note}\n\n`;

  md += `### Orchestrator Folder Structure\n\n`;
  md += `${env.orchestratorFolderGuidance}\n\n`;

  if (env.browserExtensions.length > 0) {
    md += `### Browser Extensions\n\n`;
    md += `The following extensions must be installed on the robot machine:\n\n`;
    for (const ext of env.browserExtensions) {
      md += `- ${ext}\n`;
    }
    md += `\n`;
  }

  if (env.requiredPackages.length > 0) {
    md += `### NuGet Dependencies\n\n`;
    md += `| # | Package |\n`;
    md += `|---|--------|\n`;
    env.requiredPackages.forEach((pkg, i) => {
      md += `| ${i + 1} | \`${pkg}\` |\n`;
    });
    md += `\n`;
  }

  if (analysis.upstreamContext?.systems && analysis.upstreamContext.systems.length > 0) {
    md += `### Target Applications (from Process Map)\n\n`;
    md += `The following applications were identified from the business process map. Ensure network connectivity and access credentials are configured on the robot machine:\n\n`;
    for (const sys of analysis.upstreamContext.systems) {
      md += `- ${sys}\n`;
    }
    md += `\n`;
  }

  return md;
}

function generateCredentialAssetSection(analysis: DhgAnalysisResult, sectionNum: number): string {
  const inv = analysis.credentialInventory;
  let md = `## ${sectionNum}. Credential & Asset Inventory\n\n`;

  if (inv.entries.length === 0) {
    md += `No GetCredential/GetAsset/SetCredential/SetAsset activities detected.\n\n`;
    return md;
  }

  md += `**Total:** ${inv.entries.length} activities (${inv.hardcodedCount} hardcoded, ${inv.variableCount} variable-driven)\n\n`;

  if (inv.uniqueCredentialNames.length > 0) {
    md += `### Orchestrator Credentials to Provision\n\n`;
    md += `| # | Credential Name | Type | Consuming Activity | File | Action |\n`;
    md += `|---|----------------|------|-------------------|------|--------|\n`;
    inv.uniqueCredentialNames.forEach((name, i) => {
      const entry = inv.entries.find(e => e.assetName === name && (e.activityType === "GetCredential" || e.activityType === "SetCredential"));
      const consumer = entry?.consumingActivity || "—";
      const file = entry?.file || "—";
      const action = entry?.isHardcoded ? "Create in Orchestrator before deployment" : "Verify exists in target environment";
      md += `| ${i + 1} | \`${name}\` | Credential | ${consumer} | \`${file}\` | ${action} |\n`;
    });
    md += `\n`;
  }

  if (inv.uniqueAssetNames.length > 0) {
    md += `### Orchestrator Assets to Provision\n\n`;
    md += `| # | Asset Name | Value Type | Consuming Activity | File | Action |\n`;
    md += `|---|-----------|-----------|-------------------|------|--------|\n`;
    inv.uniqueAssetNames.forEach((name, i) => {
      const entry = inv.entries.find(e => e.assetName === name && (e.activityType === "GetAsset" || e.activityType === "SetAsset"));
      const valueType = entry?.assetValueType || "Unknown";
      const consumer = entry?.consumingActivity || "—";
      const file = entry?.file || "—";
      const action = entry?.isHardcoded ? "Create in Orchestrator before deployment" : "Verify exists in target environment";
      md += `| ${i + 1} | \`${name}\` | ${valueType} | ${consumer} | \`${file}\` | ${action} |\n`;
    });
    md += `\n`;
  }

  md += `### Detailed Usage Map\n\n`;
  md += `| File | Line | Activity | Asset/Credential | Type | Variable | Hardcoded |\n`;
  md += `|------|------|----------|-----------------|------|----------|----------|\n`;
  for (const e of inv.entries) {
    md += `| \`${e.file}\` | ${e.lineNumber} | ${e.activityType} | \`${e.assetName}\` | ${e.assetValueType} | ${e.variableName || "—"} | ${e.isHardcoded ? "Yes" : "No"} |\n`;
  }
  md += `\n`;

  if (inv.hardcodedCount > 0) {
    md += `> **Warning:** ${inv.hardcodedCount} asset/credential name(s) are hardcoded. Consider externalizing to Orchestrator Config assets for environment portability.\n\n`;
  }

  return md;
}

function generateQueueManagementSection(analysis: DhgAnalysisResult, sectionNum: number, bindPointSummary?: BindPointSummary): string {
  const q = analysis.queueManagement;
  let md = `## ${sectionNum}. Queue Management\n\n`;
  const queueBindPoints = (bindPointSummary?.entries || []).filter(entry => /queue/i.test(entry.system) || /queue/i.test(entry.displayName));

  if (q.entries.length === 0 && queueBindPoints.length === 0) {
    md += `No queue activities detected in the package.\n\n`;
    return md;
  }

  if (q.entries.length === 0 && queueBindPoints.length > 0) {
    md += `No concrete queue activities were emitted, but the generated workflows still contain queue implementation bind points.\n\n`;
    md += `| # | File | Bind Point | Developer Action |\n`;
    md += `|---|------|------------|-----------------|\n`;
    queueBindPoints.forEach((entry, i) => {
      md += `| ${i + 1} | \`${entry.file}\` | ${entry.displayName.replace(/\|/g, "\\|")} | ${entry.detail.replace(/\|/g, "\\|")} |\n`;
    });
    md += `\n`;
    return md;
  }

  md += `**Pattern:** ${q.isTransactionalPattern ? "Transactional (Dispatcher/Performer)" : "Queue usage (non-transactional)"}\n\n`;

  if (q.uniqueQueues.length > 0) {
    const sddQueueConfigs = analysis.sddCrossReference?.sddQueueConfigs || [];
    md += `### Queues to Provision\n\n`;
    md += `| # | Queue Name | Activities | Unique Reference | Auto Retry | SLA | Action |\n`;
    md += `|---|-----------|------------|-----------------|------------|-----|--------|\n`;
    q.uniqueQueues.forEach((qName, i) => {
      const activities = q.entries.filter(e => e.queueName === qName).map(e => e.activityType);
      const uniqueActs = [...new Set(activities)].join(", ");
      const isHardcoded = q.entries.some(e => e.queueName === qName && e.isHardcoded);
      const sddConfig = sddQueueConfigs.find(c => c.name === qName);
      const uniqueRef = sddConfig?.uniqueReference !== undefined
        ? (sddConfig.uniqueReference ? "Yes (SDD)" : "No (SDD)")
        : q.isTransactionalPattern ? "Recommended" : "Optional";
      const autoRetry = sddConfig?.maxRetries !== undefined
        ? `Yes (${sddConfig.maxRetries}x, SDD)`
        : q.retryPolicy.autoRetryEnabled ? `Yes (${q.retryPolicy.maxRetries}x)` : "No";
      const sla = sddConfig?.sla || "—";
      md += `| ${i + 1} | \`${qName}\` | ${uniqueActs} | ${uniqueRef} | ${autoRetry} | ${sla} | ${isHardcoded ? "Create in Orchestrator" : "Verify exists"} |\n`;
    });
    md += `\n`;
  }

  const sddOnlyQueues = (analysis.sddCrossReference?.sddQueueConfigs || [])
    .filter(c => !q.uniqueQueues.some(qn => qn.trim() === c.name.trim()));
  if (sddOnlyQueues.length > 0) {
    md += `### SDD-Defined Queues (Not Yet in XAML)\n\n`;
    md += `| # | Queue Name | Unique Reference | Max Retries | SLA | Note |\n`;
    md += `|---|-----------|-----------------|-------------|-----|------|\n`;
    sddOnlyQueues.forEach((c, i) => {
      const uniqueRef = c.uniqueReference !== undefined ? (c.uniqueReference ? "Yes" : "No") : "—";
      const retries = c.maxRetries !== undefined ? `${c.maxRetries}x` : "—";
      const sla = c.sla || "—";
      md += `| ${i + 1} | \`${c.name}\` | ${uniqueRef} | ${retries} | ${sla} | Defined in SDD but no matching XAML activity — verify implementation |\n`;
    });
    md += `\n`;
  }

  md += `### Queue Activity Summary\n\n`;
  md += `| Capability | Present |\n`;
  md += `|---|---|\n`;
  md += `| Add Queue Item | ${q.hasAddQueueItem ? "Yes" : "No"} |\n`;
  md += `| Get Transaction Item | ${q.hasGetTransaction ? "Yes" : "No"} |\n`;
  md += `| Set Transaction Status | ${q.hasSetTransactionStatus ? "Yes" : "No"} |\n`;
  md += `\n`;

  md += `### Retry Policy\n\n`;
  md += `${q.retryPolicy.note}\n\n`;

  md += `### SLA Guidance\n\n`;
  md += `${q.slaGuidance}\n\n`;

  md += `### Dead-Letter / Failed Items Handling\n\n`;
  md += `${q.deadLetterHandling}\n\n`;

  if (q.isTransactionalPattern && !q.hasAddQueueItem) {
    md += `> **Note:** This is a Performer process — a separate Dispatcher process is needed to populate the queue.\n\n`;
  }

  return md;
}

function generateExceptionCoverageSection(analysis: DhgAnalysisResult, sectionNum: number): string {
  const exc = analysis.exceptionCoverage;
  let md = `## ${sectionNum}. Exception Handling Coverage\n\n`;

  if (exc.totalActivities === 0) {
    md += `No high-risk activities detected to evaluate exception coverage.\n\n`;
    return md;
  }

  md += `**Coverage:** ${exc.coveredActivities}/${exc.totalActivities} high-risk activities inside TryCatch (${exc.coveragePercent}%)\n\n`;

  if (exc.filesWithoutTryCatch.length > 0) {
    md += `### Files Without TryCatch\n\n`;
    for (const f of exc.filesWithoutTryCatch) {
      md += `- \`${f}\`\n`;
    }
    md += `\n`;
  }

  if (exc.uncoveredHighRiskActivities.length > 0) {
    md += `### Uncovered High-Risk Activities\n\n`;
    md += `| # | Location | Activity |\n`;
    md += `|---|----------|----------|\n`;
    exc.uncoveredHighRiskActivities.forEach((desc, i) => {
      const parts = desc.split(" ");
      const location = parts[0];
      const activity = parts.slice(1).join(" ");
      md += `| ${i + 1} | \`${location}\` | ${activity} |\n`;
    });
    md += `\n`;
    md += `> **Recommendation:** Wrap these activities in TryCatch blocks with appropriate exception types (BusinessRuleException for data errors, System.Exception for general failures).\n\n`;
  }

  return md;
}

function generateTriggerConfigSection(analysis: DhgAnalysisResult, sectionNum: number): string {
  const triggers = analysis.triggerSuggestions;
  let md = `## ${sectionNum}. Trigger Configuration\n\n`;

  md += `Based on the process analysis, the following trigger configuration is recommended:\n\n`;
  md += `| # | Trigger Type | Reason | Configuration |\n`;
  md += `|---|-------------|--------|---------------|\n`;
  triggers.forEach((t, i) => {
    md += `| ${i + 1} | **${t.triggerType}** | ${t.reason} | ${t.suggestedConfig || "Configure in Orchestrator"} |\n`;
  });
  md += `\n`;

  return md;
}

function generatePreDeploymentChecklist(analysis: DhgAnalysisResult, sectionNum: number): string {
  const env = analysis.environmentRequirements;
  const cred = analysis.credentialInventory;
  const q = analysis.queueManagement;
  let md = `## ${sectionNum}. Pre-Deployment Checklist\n\n`;

  const items: Array<{ task: string; category: string; required: boolean }> = [];

  items.push({ task: "Publish package to Orchestrator feed", category: "Deployment", required: true });
  items.push({ task: "Create Process in target folder", category: "Deployment", required: true });

  if (env.usesOrchestrator) {
    items.push({ task: "Verify Orchestrator connection from robot", category: "Environment", required: true });
  }

  if (cred.uniqueCredentialNames.length > 0) {
    for (const name of cred.uniqueCredentialNames) {
      items.push({ task: `Provision credential: \`${name}\``, category: "Credentials", required: true });
    }
  }

  if (cred.uniqueAssetNames.length > 0) {
    for (const name of cred.uniqueAssetNames) {
      items.push({ task: `Provision asset: \`${name}\``, category: "Assets", required: true });
    }
  }

  if (q.uniqueQueues.length > 0) {
    for (const qName of q.uniqueQueues) {
      items.push({ task: `Create queue: \`${qName}\``, category: "Queues", required: true });
    }
  }

  if (env.browserExtensions.length > 0) {
    for (const ext of env.browserExtensions) {
      items.push({ task: `Install ${ext}`, category: "Extensions", required: true });
    }
  }

  if (env.needsAttendedRobot) {
    items.push({ task: "Configure attended robot with user session", category: "Robot", required: true });
  }

  items.push({ task: "Configure trigger (schedule/queue/API)", category: "Trigger", required: true });
  items.push({ task: "Run smoke test in target environment", category: "Testing", required: true });
  items.push({ task: "Verify logging output in Orchestrator", category: "Monitoring", required: false });

  items.push({ task: "UAT test execution completed and sign-off obtained", category: "Governance", required: true });
  items.push({ task: "Peer code review completed", category: "Governance", required: true });
  items.push({ task: "All quality gate warnings addressed or risk-accepted", category: "Governance", required: true });
  items.push({ task: "Business process owner validation obtained", category: "Governance", required: true });
  items.push({ task: "CoE approval obtained", category: "Governance", required: true });
  items.push({ task: "Production readiness assessment completed (monitoring, alerting, rollback plan documented)", category: "Governance", required: true });

  md += `| # | Category | Task | Required |\n`;
  md += `|---|----------|------|----------|\n`;
  items.forEach((item, i) => {
    md += `| ${i + 1} | ${item.category} | ${item.task} | ${item.required ? "Yes" : "Recommended"} |\n`;
  });
  md += `\n`;

  return md;
}

function generateUpstreamContextSection(analysis: DhgAnalysisResult, sectionNum: number): string {
  const ctx = analysis.upstreamContext!;
  let md = `## ${sectionNum}. Process Context (from Pipeline)\n\n`;

  if (ctx.ideaDescription) {
    md += `### Idea Description\n\n`;
    md += `${ctx.ideaDescription}\n\n`;
  }

  if (ctx.pddSummary) {
    md += `### PDD Summary\n\n`;
    md += `${ctx.pddSummary}\n\n`;
  }

  if (ctx.sddSummary) {
    md += `### SDD Summary\n\n`;
    md += `${ctx.sddSummary}\n\n`;
  }

  if (ctx.automationType) {
    md += `**Automation Type:** ${ctx.automationType}\n`;
  }
  if (ctx.automationTypeRationale) {
    md += `**Rationale:** ${ctx.automationTypeRationale}\n`;
  }
  if (ctx.feasibilityComplexity) {
    md += `**Feasibility Complexity:** ${ctx.feasibilityComplexity}\n`;
  }
  if (ctx.feasibilityEffortEstimate) {
    md += `**Effort Estimate:** ${ctx.feasibilityEffortEstimate}\n`;
  }
  if (ctx.feasibilityScore !== undefined) {
    md += `**Feasibility Score:** ${ctx.feasibilityScore}%\n`;
  }
  md += `\n`;

  return md;
}

function hasProcessMapData(analysis: DhgAnalysisResult): boolean {
  const ctx = analysis.upstreamContext;
  if (!ctx) return false;
  return !!(
    (ctx.processSteps && ctx.processSteps.length > 0) ||
    (ctx.painPoints && ctx.painPoints.length > 0) ||
    (ctx.systems && ctx.systems.length > 0) ||
    (ctx.roles && ctx.roles.length > 0)
  );
}

function generateBusinessProcessOverviewSection(analysis: DhgAnalysisResult, sectionNum: number): string {
  const ctx = analysis.upstreamContext!;
  let md = `## ${sectionNum}. Business Process Overview\n\n`;

  if (ctx.processSteps && ctx.processSteps.length > 0) {
    md += `### Process Steps\n\n`;
    md += `| # | Step | Role | System | Type | Pain Point |\n`;
    md += `|---|------|------|--------|------|------------|\n`;
    ctx.processSteps.forEach((step, i) => {
      md += `| ${i + 1} | ${step.name} | ${step.role || "—"} | ${step.system || "—"} | ${step.nodeType} | ${step.isPainPoint ? "Yes" : "—"} |\n`;
    });
    md += `\n`;
  }

  if (ctx.painPoints && ctx.painPoints.length > 0) {
    md += `### Pain Points\n\n`;
    for (const pp of ctx.painPoints) {
      md += `- ${pp}\n`;
    }
    md += `\n`;
  }

  if (ctx.systems && ctx.systems.length > 0) {
    md += `### Target Applications / Systems\n\n`;
    md += `The following applications were identified from the process map and must be accessible from the robot machine:\n\n`;
    for (const sys of ctx.systems) {
      md += `- ${sys}\n`;
    }
    md += `\n`;
  }

  if (ctx.roles && ctx.roles.length > 0) {
    md += `### User Roles Involved\n\n`;
    for (const role of ctx.roles) {
      md += `- ${role}\n`;
    }
    md += `\n`;
  }

  if (ctx.decisionBranches && ctx.decisionBranches.length > 0) {
    md += `### Decision Points (Process Map Topology)\n\n`;
    for (const db of ctx.decisionBranches) {
      md += `**${db.decisionNodeName}**\n`;
      for (const branch of db.branches) {
        md += `  - [${branch.label}] → ${branch.targetNodeName}\n`;
      }
      md += `\n`;
    }
  }

  return md;
}

function generateCrossReferenceSection(xref: SddArtifactCrossReference, sectionNum: number): string {
  let md = `## ${sectionNum}. SDD × XAML Artifact Reconciliation\n\n`;

  md += `**Summary:** ${xref.alignedCount} aligned, ${xref.sddOnlyCount} SDD-only, ${xref.xamlOnlyCount} XAML-only\n\n`;

  if (xref.sddOnlyCount > 0) {
    md += `> **Warning:** ${xref.sddOnlyCount} artifact(s) declared in the SDD were not found in the generated XAML. These must be provisioned in Orchestrator but are not referenced in code — verify the SDD spec or add the corresponding activities.\n\n`;
  }
  if (xref.xamlOnlyCount > 0) {
    md += `> **Warning:** ${xref.xamlOnlyCount} artifact(s) found in XAML are not declared in the SDD. Update the SDD orchestrator_artifacts block to include these, or the deployment manifest will be incomplete.\n\n`;
  }

  if (xref.entries.length > 0) {
    md += `| # | Name | Type | Status | SDD Config | XAML File | XAML Line |\n`;
    md += `|---|------|------|--------|-----------|----------|----------|\n`;
    xref.entries.forEach((e, i) => {
      const sddConfig = e.sddConfig ? Object.entries(e.sddConfig).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`).join(", ") : "—";
      const statusLabel = e.status === "aligned" ? "Aligned" : e.status === "sdd-only" ? "SDD Only" : "XAML Only";
      md += `| ${i + 1} | \`${e.name}\` | ${e.type} | **${statusLabel}** | ${sddConfig} | ${e.xamlFile ? `\`${e.xamlFile}\`` : "—"} | ${e.xamlLineNumber || "—"} |\n`;
    });
    md += `\n`;
  }

  return md;
}

function generateUpstreamWarningsSection(analysis: DhgAnalysisResult, sectionNum: number): string {
  const warnings = analysis.upstreamContext!.qualityWarnings!;
  let md = `## ${sectionNum}. Upstream Quality Findings\n\n`;

  md += `The following quality warnings were produced by upstream pipeline stages (selector scoring, type validation, expression linting, etc.) and should be addressed during development:\n\n`;

  const byCode = new Map<string, typeof warnings>();
  for (const w of warnings) {
    const existing = byCode.get(w.code) || [];
    existing.push(w);
    byCode.set(w.code, existing);
  }

  md += `| Code | Severity | Count | Sample Message |\n`;
  md += `|------|----------|-------|----------------|\n`;
  for (const [code, items] of byCode) {
    md += `| ${code} | ${items[0].severity} | ${items.length} | ${(items[0].message || "").slice(0, 120)}${(items[0].message || "").length > 120 ? "..." : ""} |\n`;
  }
  md += `\n`;

  return md;
}

function generateReadinessScoreSection(
  analysis: DhgAnalysisResult,
  sectionNum: number,
  bindPointSummary?: BindPointSummary,
  generationMode?: "full_implementation" | "baseline_openable",
): string {
  const r = analysis.readiness;
  const bindPointCount = bindPointSummary?.entries.length || 0;
  const baselineNeedsWork = generationMode === "baseline_openable" && bindPointCount > 0;
  const adjustedPercent = baselineNeedsWork ? Math.min(r.percent, bindPointCount >= 4 ? 45 : 55) : r.percent;
  const adjustedRating = baselineNeedsWork ? (adjustedPercent >= 40 ? "Needs Work" : "Not Ready") : r.rating;
  const sections = r.sections.map(section => ({ ...section, notes: [...section.notes] }));
  if (baselineNeedsWork) {
    const queueSection = sections.find(section => section.section === "Queue Management");
    if (queueSection) {
      queueSection.score = Math.min(queueSection.score, 3);
      queueSection.notes = queueSection.notes.filter(note => !/no queue activities/i.test(note));
      queueSection.notes.push(`Queue implementation bind points remain in ${bindPointSummary?.entries.filter(entry => /queue/i.test(entry.system) || /queue/i.test(entry.displayName)).length || 0} workflow(s)`);
    }
    const envSection = sections.find(section => section.section === "Environment Setup");
    if (envSection) {
      envSection.score = Math.min(envSection.score, 5);
      envSection.notes.push(`${bindPointCount} developer bind point(s) remain before production deployment`);
    }
    const buildQuality = sections.find(section => section.section === "Build Quality");
    if (buildQuality) {
      buildQuality.score = Math.min(buildQuality.score, 4);
      buildQuality.notes.push("Baseline workflows are Studio-openable but not fully implemented");
    }
  }
  const adjustedTotalScore = Math.round((adjustedPercent / 100) * r.maxTotalScore);
  let md = `## ${sectionNum}. Deployment Readiness Score\n\n`;

  md += `**Overall: ${r.rating} — ${r.totalScore}/${r.maxTotalScore} (${r.percent}%)**\n\n`;

  md += `| Section | Score | Notes |\n`;
  md += `|---------|-------|-------|\n`;
  if (baselineNeedsWork) {
    md += `> **Override for Baseline Mode:** This package is Studio-openable, but ${bindPointCount} developer bind point(s) still remain. Treat it as \`${adjustedRating}\`, not deployable.\n\n`;
  }
  for (const sec of sections) {
    const notes = sec.notes.join("; ");
    md += `| ${sec.section} | ${sec.score}/${sec.maxScore} | ${notes} |\n`;
  }
  md += `\n`;

  const hasBlockingDefects = analysis.hasBlockedWorkflows || sections.some(s => s.score <= 0);
  if (adjustedRating === "Not Ready" || adjustedRating === "Needs Work") {
    md += `> **Action Required:** Address the items above before deploying to production. Focus on sections with the lowest scores first.\n\n`;
  } else if (hasBlockingDefects) {
    md += `> **Action Required:** The package has blocking structural defects that must be resolved before deployment.\n\n`;
  } else if (adjustedRating === "Mostly Ready") {
    md += `> **Almost There:** A few items need attention before production deployment.\n\n`;
  } else {
    md += `> **Good to Go:** The package meets deployment readiness criteria.\n\n`;
  }

  return md;
}

function generateTruthfulReadinessScoreSection(
  analysis: DhgAnalysisResult,
  sectionNum: number,
  bindPointSummary?: BindPointSummary,
  generationMode?: "full_implementation" | "baseline_openable",
): string {
  const r = analysis.readiness;
  const bindPointCount = bindPointSummary?.entries.length || 0;
  const baselineNeedsWork = generationMode === "baseline_openable" && bindPointCount > 0;
  const adjustedPercent = baselineNeedsWork ? Math.min(r.percent, bindPointCount >= 4 ? 45 : 55) : r.percent;
  const adjustedRating = baselineNeedsWork ? (adjustedPercent >= 40 ? "Needs Work" : "Not Ready") : r.rating;
  const adjustedTotalScore = Math.round((adjustedPercent / 100) * r.maxTotalScore);
  const sections = r.sections.map(section => ({ ...section, notes: [...section.notes] }));

  if (baselineNeedsWork) {
    const queueSection = sections.find(section => section.section === "Queue Management");
    if (queueSection) {
      queueSection.score = Math.min(queueSection.score, 3);
      queueSection.notes = queueSection.notes.filter(note => !/no queue activities/i.test(note));
      queueSection.notes.push(
        `Queue implementation bind points remain in ${bindPointSummary?.entries.filter(entry => /queue/i.test(entry.system) || /queue/i.test(entry.displayName)).length || 0} workflow(s)`,
      );
    }
    const envSection = sections.find(section => section.section === "Environment Setup");
    if (envSection) {
      envSection.score = Math.min(envSection.score, 5);
      envSection.notes.push(`${bindPointCount} developer bind point(s) remain before production deployment`);
    }
    const buildQuality = sections.find(section => section.section === "Build Quality");
    if (buildQuality) {
      buildQuality.score = Math.min(buildQuality.score, 4);
      buildQuality.notes.push("Baseline workflows are Studio-openable but not fully implemented");
    }
  }

  let md = `## ${sectionNum}. Deployment Readiness Score\n\n`;
  md += `**Overall: ${adjustedRating} — ${adjustedTotalScore}/${r.maxTotalScore} (${adjustedPercent}%)**\n\n`;
  md += `| Section | Score | Notes |\n`;
  md += `|---------|-------|-------|\n`;

  if (baselineNeedsWork) {
    md += `> **Override for Baseline Mode:** This package is Studio-openable, but ${bindPointCount} developer bind point(s) still remain. Treat it as \`${adjustedRating}\`, not deployable.\n\n`;
  }

  for (const sec of sections) {
    md += `| ${sec.section} | ${sec.score}/${sec.maxScore} | ${sec.notes.join("; ")} |\n`;
  }
  md += `\n`;

  const hasBlockingDefects = analysis.hasBlockedWorkflows || sections.some(s => s.score <= 0);
  if (adjustedRating === "Not Ready" || adjustedRating === "Needs Work") {
    md += `> **Action Required:** Address the items above before deploying to production. Focus on sections with the lowest scores first.\n\n`;
  } else if (hasBlockingDefects) {
    md += `> **Action Required:** The package has blocking structural defects that must be resolved before deployment.\n\n`;
  } else if (adjustedRating === "Mostly Ready") {
    md += `> **Almost There:** A few items need attention before production deployment.\n\n`;
  } else {
    md += `> **Good to Go:** The package meets deployment readiness criteria.\n\n`;
  }

  return md;
}
