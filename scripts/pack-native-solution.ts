import path from "node:path";
import { packUiPathNativeSolution } from "../server/uipath-solution-cli";

async function main() {
  const projectPath = process.env.UIPATH_PROJECT_PATH || "";
  const version = process.env.UIPATH_SOLUTION_VERSION || "1.0.0-sim";
  const outputDir = process.env.UIPATH_SOLUTION_OUTPUT_DIR || "C:/Users/yusuf.yasin/Downloads/CannonBall/simulation_output_po_invoice/native-solution-package";

  if (!projectPath) {
    throw new Error("Set UIPATH_PROJECT_PATH to a UiPath solution workspace path or .uipx file before running native solution pack.");
  }

  const projectDir = projectPath.toLowerCase().endsWith("project.json")
    ? path.dirname(projectPath)
    : projectPath;

  const result = await packUiPathNativeSolution({
    projectPath: projectDir,
    version,
    outputDir,
    traceLevel: "Information",
  });

  console.log(JSON.stringify({
    ok: true,
    projectPath: projectDir,
    version,
    outputDir,
    packageName: result.packageName,
    packagePath: result.packagePath,
    stdout: result.stdout,
    stderr: result.stderr,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }, null, 2));
  process.exit(1);
});
