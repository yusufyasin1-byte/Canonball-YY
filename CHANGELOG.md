# Changelog

This changelog captures the key release notes for the `Updated-code---solution-packager` branch so the history is visible in GitHub alongside the commits.

## 2026-04-06

### `Unreleased` - Improve UiPath portability defaults and helper scripts

Added
- More portable helper-script behavior by resolving output and package paths relative to the repo or environment variables instead of a specific Windows user profile path.

Changed
- Removed the hardcoded `DefaultTenant` default from the UiPath settings UI so tenant configuration is user-driven.
- Updated local helper scripts to derive package names, versions, and output directories from inputs/environment rather than fixed PO-specific paths.
- Replaced real-looking tenant/org test fixture values with neutral placeholders in UiPath auth tests.

Validated
- Repo-wide `tsc --noEmit` passes cleanly.
- Focused backend Vitest for `uipath-auth` passed.
- Fresh PO simulation still completed successfully, with the existing known `AddQueueItem` warning unchanged.

### `Unreleased` - Add demo-ready delivery, governance, and operations summaries

Added
- Connector-aware UiPath delivery recommendations with inferred Integration Service guidance.
- Generated operating-model, governance-pack, test-release-plan, insights-plan, and executive-summary outputs in the native solution bundle.
- Executive summary metadata surfaced through the UiPath artifact API and solution UI cards.

Changed
- Expanded the solution manifest to carry operating-model, release-readiness, reporting, test-release, and executive-summary metadata.
- Updated the artifact hub and document card views to show deployment-readiness, release-readiness, smoke-test, KPI, and executive-summary details for generated solutions.
- Strengthened delivery-planner and solution-builder tests to cover connector inference and the new demo-facing solution documents.

Validated
- Repo-wide `tsc --noEmit` passes cleanly.
- Focused backend Vitest suites for the delivery planner and solution builder passed successfully using the server test configuration.

### `Unreleased` - Add UiPath modality and execution recommendations

Added
- Delivery recommendation metadata for UiPath modality, execution model, and recommended product set.
- New planner heuristics to distinguish unattended robot, attended Assistant, app-fronted, agent-orchestrated, and API-workflow delivery patterns.

Changed
- Surfaced the richer recommendation details in the artifact hub and document card UI alongside the existing package-vs-solution guidance.
- Extended existing recommendation tests and solution-builder fixtures to cover the new modality and execution model outputs.

Validated
- Repo-wide `tsc --noEmit` passes cleanly.
- Focused Vitest suites for the delivery planner and solution builder passed successfully.

## 2026-04-03

### `Unreleased` - Add PO document export helpers

Added
- Reusable scripts to generate PO-specific PDD, SDD, and DSD outputs in both markdown and `.docx` formats.

Changed
- Standardized the PO document export path so generated outputs land under the simulation docs folder with consistent Automation Hub-style filenames.

Validated
- Generated concrete PO `PDD`, `SDD`, and `DSD` outputs successfully into the simulation output docs directory.

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
