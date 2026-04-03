# Changelog

This changelog captures the key release notes for the `Updated-code---solution-packager` branch so the history is visible in GitHub alongside the commits.

## 2026-04-03

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

