# Changelog

This changelog captures the key release notes for the `Updated-code---solution-packager` branch so the history is visible in GitHub alongside the commits.

## 2026-04-03

### `Unreleased` - Clear repo-wide TypeScript compile debt

Added
- Stronger shared type coverage for deployment results, workflow analysis categories, recursive workflow specs, and repair metadata.

Changed
- Fixed repo-wide TypeScript shape drift across catalog validation, document exports, orchestrator provisioning, pipeline results, route payloads, workflow assembly, XAML generation, quality-gate typing, and shared process-layout utilities.
- Tightened null/undefined handling around deployment IDs and normalized newer pipeline metadata into the types expected by downstream routes.

Validated
- Repo-wide `tsc --noEmit` now passes cleanly.
- Focused Vitest reruns were attempted afterward, but the local run environment hit a separate Windows `EPERM` path issue before test discovery, so they were not used as the validation signal for this cleanup.

### `Unreleased` - Add reusable UiPath test automation artifact generation

Added
- A generic UiPath Tests project builder that turns generated test cases and test sets into a Studio-openable executable test automation pack.
- A focused regression test for the shared test automation builder.
- A dedicated backend download route for the generated UiPath test automation artifact.

Changed
- Extended the pipeline to emit a first-class `testAutomationArtifact` alongside the package and native solution outputs.
- Surfaced the generated test automation pack in artifact metadata, the artifact hub, and the UiPath package card.
- Improved `.docx` exports so PDD, SDD, and DSD content is normalized to the official UiPath template section order and includes a generated table of contents.

Validated
- Focused test automation builder tests passed.
- Existing solution-builder tests still passed after the new artifact integration.

### `Unreleased` - Add UiPath template-aligned PDD, SDD, and DSD support

Added
- A UiPath-template document helper module for canonical PDD, SDD, and DSD section structures.
- Focused tests for template prompt coverage and section normalization.
- DSD support in the solution artifact bundle so implementation documents travel with exported solutions.

Changed
- Updated document generation to use UiPath Automation Hub template-aligned prompts and normalized section output.
- Extended document routes, approvals, artifacts, exports, and UI viewers so `DSD` behaves as a first-class document type.
- Expanded chat/document parsing and artifact download flows to handle all three document types consistently.

Validated
- Focused template-helper tests passed.
- Updated solution-builder tests passed with `DSD` included in the exported solution docs.

### `Unreleased` - Add deploy-time workflow contract integrity validation

Added
- A deploy-time workflow contract integrity validator for invoked UiPath workflows.
- Focused regression coverage for non-runtime property exclusion and real invoke-contract defects.

Changed
- Extended the deployment gate to summarize contract-integrity defects alongside workflow-analyzer results.
- Reduced false positives by classifying designer and serialization-only fields separately from runtime argument contracts.

Validated
- Focused contract-integrity tests passed.
- Fresh PO generation still succeeded under the stricter deploy-time gate.

### `14c34e7` - Add Test Manager automation generation utilities

Added
- Full PO test automation generation utilities for `TC001` through `TC007`.
- A Test Manager inspection helper to verify project, case, set, and requirement state.

Changed
- Standardized the generated UiPath Tests project structure so the full PO test pack can be published and linked in Test Manager.

Validated
- Full test package generated and uploaded.
- Test Manager cases were linked to packaged automations.
- Automated TM execution was proven end to end.

### `1316f5a` - Add workflow analyzer deploy gate and TM provisioning path

Added
- A stricter deploy-time workflow analyzer gate that blocks unresolved error-level issues before push to UiPath.
- Test Manager provisioning path for projects, test cases, test sets, and requirements.

Changed
- Kept generation-time analysis lightweight while applying the stricter gate only during deployment.
- Hardened solution deploy validation against expected process, asset, queue, and storage bucket resources.

Validated
- Clean use cases still generated and deployed successfully under the stricter gate.

### `3f40082` - Add delivery recommendations and generated test cases

Added
- Delivery recommendation logic to determine whether a use case should default to `package` or `solution`.
- Generated test cases and test sets as first-class outputs.

Changed
- The default artifact/output path now follows the delivery recommendation.
- The UI now surfaces the recommended output, rationale, generated test cases, and generated test sets.

Validated
- Recommendation metadata and generated test design were exposed consistently through the server and UI.

### `c866523` - Fix AddQueueItem XAML generation for Studio Desktop

Changed
- Fixed `Add Queue Item` generation so the produced `IntakeDispatcher.xaml` opens cleanly in Studio Desktop.
- Removed invalid generated XAML shapes and aligned the queue item payload structure with UiPath-authored patterns.

Validated
- Fresh PO generation opened without the earlier `AddQueueItem` validation failures.

### `96ccfd7` - Add solution deployment validation and queue reference generation

Added
- Post-deploy validation helpers for solution resources in UiPath.

Changed
- Generated queue item references so the PO dispatcher can satisfy unique-reference queue constraints.

Validated
- Deployed solution folder contents were checked for process, queue, asset, and storage bucket presence.

### `bb85b61` - Add UiPath native solution packaging and deployment support

Added
- Native UiPath solution packaging and deployment support for CB2YY.
- Solution CLI helpers and scripts for package upload, deployment, and activation.

Changed
- Moved from a package-only path toward native UiPath Solutions deployment.

Validated
- Real UiPath solution deployment and activation were proven against the PO solution path.
