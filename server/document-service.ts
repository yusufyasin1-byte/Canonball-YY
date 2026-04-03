import { documentStorage } from "./document-storage";
import { chatStorage } from "./replit_integrations/chat/storage";
import { storage } from "./storage";
import { evaluateTransition } from "./stage-transition";
import { parseArtifactBlockAsObject, validateArtifactBlock } from "./lib/artifact-parser";

export interface ApproveDocumentOptions {
  ideaId: string;
  docType: "PDD" | "SDD" | "DSD";
  docId?: number;
  userId: string;
  activeRole?: string;
  skipChatMessages?: boolean;
}

export interface ApproveDocumentResult {
  approval: any;
  document: any;
  transition?: any;
  alreadyApproved?: boolean;
  artifactWarnings?: string[];
}

export async function approveDocument(opts: ApproveDocumentOptions): Promise<ApproveDocumentResult> {
  const { ideaId, docType, userId, activeRole, skipChatMessages } = opts;

  const user = await storage.getUser(userId);
  if (!user) throw new Error("User not found");

  let doc;
  if (opts.docId) {
    doc = await documentStorage.getDocument(opts.docId);
    if (!doc || doc.ideaId !== ideaId) throw new Error("Document not found");
  } else {
    doc = await documentStorage.getLatestDocument(ideaId, docType);
    if (!doc) throw new Error(`No ${docType} document found`);
  }

  if (doc.status === "approved") {
    return { approval: null, document: doc, alreadyApproved: true };
  }

  let artifactWarnings: string[] = [];
  if (docType === "SDD") {
    const hasStoredValidity = doc.artifactsValid !== null && doc.artifactsValid !== undefined;
    if (hasStoredValidity && doc.artifactsValid === false) {
      throw new Error("SDD cannot be approved: deployment artifacts are missing or invalid. Please revise the SDD to regenerate the artifacts section.");
    }
    if (!hasStoredValidity) {
      const validation = validateArtifactBlock(doc.content);
      if (!validation.valid) {
        console.warn(`[Document Service] SDD approval blocked — artifact validation failed: ${validation.failure} — ${validation.details}`);
        throw new Error(`SDD cannot be approved: deployment artifacts are ${validation.failure === "missing_fence" ? "missing" : "invalid"} (${validation.details}). Please revise the SDD to regenerate the artifacts section.`);
      }
    }
    if (doc.artifactWarnings) {
      try { artifactWarnings = JSON.parse(doc.artifactWarnings); } catch {}
    }
  }

  const existingApproval = await documentStorage.getApproval(ideaId, docType);
  if (existingApproval) {
    if (existingApproval.documentId === doc.id) {
      return { approval: existingApproval, document: doc, alreadyApproved: true };
    }
    await documentStorage.deleteApproval(ideaId, docType);
    const oldDoc = await documentStorage.getDocument(existingApproval.documentId);
    if (oldDoc && oldDoc.status === "approved") {
      await documentStorage.updateDocument(oldDoc.id, { status: "superseded" });
    }
  }

  await documentStorage.updateDocument(doc.id, { status: "approved" });

  const approval = await documentStorage.createApproval({
    documentId: doc.id,
    ideaId,
    docType,
    userId: user.id,
    userRole: (activeRole || user.role) as string,
    userName: user.displayName,
  });

  if (!skipChatMessages) {
    if (docType === "PDD") {
      await chatStorage.createMessage(
        ideaId,
        "assistant",
        "PDD approved. I'll now generate the Solution Design Document (SDD)."
      );
    } else if (docType === "SDD") {
      let deployPrompt = "SDD approved. You can now generate the UiPath automation package.";
      try {
        const idea = await storage.getIdea(ideaId);
        const sddDoc = await documentStorage.getDocument(doc.id);
        let artifactSummary = "";
        if (sddDoc?.content) {
          const artifacts: any = parseArtifactBlockAsObject(sddDoc.content);
          if (artifacts) {
            const parts: string[] = [];
            if (artifacts.queues?.length) parts.push(`${artifacts.queues.length} queue(s)`);
            if (artifacts.assets?.length) parts.push(`${artifacts.assets.length} asset(s)`);
            if (artifacts.machines?.length) parts.push(`${artifacts.machines.length} machine template(s)`);
            if (artifacts.triggers?.length) parts.push(`${artifacts.triggers.length} trigger(s)`);
            if (artifacts.storageBuckets?.length) parts.push(`${artifacts.storageBuckets.length} storage bucket(s)`);
            if (artifacts.robotAccounts?.length) parts.push(`${artifacts.robotAccounts.length} robot account(s)`);
            if (artifacts.actionCenter?.length) parts.push(`${artifacts.actionCenter.length} Action Center catalog(s)`);
            if (artifacts.documentUnderstanding?.length) parts.push(`${artifacts.documentUnderstanding.length} DU project(s)`);
            if (artifacts.testCases?.length) parts.push(`${artifacts.testCases.length} test case(s)`);
            if (artifacts.testDataQueues?.length) parts.push(`${artifacts.testDataQueues.length} test data queue(s)`);
            if (artifacts.testSets?.length) parts.push(`${artifacts.testSets.length} test set(s)`);
            if (artifacts.requirements?.length) parts.push(`${artifacts.requirements.length} requirement(s)`);
            if (artifacts.agents?.length) parts.push(`${artifacts.agents.length} agent(s)`);
            if (artifacts.knowledgeBases?.length) parts.push(`${artifacts.knowledgeBases.length} knowledge base(s)`);
            if (artifacts.promptTemplates?.length) parts.push(`${artifacts.promptTemplates.length} prompt template(s)`);
            if (artifacts.folder) artifactSummary += `Target folder: **${artifacts.folder}**\n`;
            if (parts.length) artifactSummary += `Artifacts to provision: ${parts.join(", ")}`;
          }
        }
        const ideaName = idea?.title || "this automation";
        deployPrompt = `**SDD approved** for **${ideaName}**.\n\nThe Solution Design Document has been approved and the automation is ready for deployment to UiPath Orchestrator.\n\n${artifactSummary ? artifactSummary + "\n\n" : ""}This will:\n1. Generate a UiPath NuGet package\n2. Upload it to Orchestrator\n3. Create the process\n4. Auto-provision all orchestrator artifacts (queues, assets, machine templates, triggers, and more)\n\nWould you like me to **push this to UiPath now**? Just say "Push to UiPath" or "Deploy" and I'll start the deployment immediately.`;
      } catch (promptErr: any) {
        console.error("[Document Service] Failed to build SDD deploy prompt:", promptErr.message);
      }
      await chatStorage.createMessage(ideaId, "assistant", deployPrompt);
    } else if (docType === "DSD") {
      await chatStorage.createMessage(
        ideaId,
        "assistant",
        "DSD approved. The detailed implementation design is now finalized and available for developer handoff and support use."
      );
    }
  }

  let transition;
  try {
    const transitionResult = await evaluateTransition(
      ideaId,
      userId,
      user.displayName,
      activeRole || "Process SME"
    );
    if (transitionResult.transitioned) {
      transition = transitionResult;
    }
  } catch (transErr: any) {
    console.error("[Document Service] Transition evaluation failed:", transErr?.message);
  }

  return { approval, document: { ...doc, status: "approved" }, transition, ...(artifactWarnings.length > 0 ? { artifactWarnings } : {}) };
}
