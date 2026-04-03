import fs from "node:fs";
import path from "node:path";
import { parseArtifactsFromSDD, extractArtifactsWithLLM, deployAllArtifacts } from "../server/uipath-deploy";

type TestManagerArtifacts = {
  testCases?: any[];
  testDataQueues?: any[];
  requirements?: any[];
  testSets?: any[];
};

function extractTestManagerArtifacts(artifacts: any): TestManagerArtifacts {
  return {
    ...(Array.isArray(artifacts?.testCases) && artifacts.testCases.length > 0 ? { testCases: artifacts.testCases } : {}),
    ...(Array.isArray(artifacts?.testDataQueues) && artifacts.testDataQueues.length > 0 ? { testDataQueues: artifacts.testDataQueues } : {}),
    ...(Array.isArray(artifacts?.requirements) && artifacts.requirements.length > 0 ? { requirements: artifacts.requirements } : {}),
    ...(Array.isArray(artifacts?.testSets) && artifacts.testSets.length > 0 ? { testSets: artifacts.testSets } : {}),
  };
}

function hasTestManagerArtifacts(artifacts: TestManagerArtifacts): boolean {
  return (
    (artifacts.testCases?.length || 0) > 0 ||
    (artifacts.testDataQueues?.length || 0) > 0 ||
    (artifacts.requirements?.length || 0) > 0 ||
    (artifacts.testSets?.length || 0) > 0
  );
}

async function main() {
  const sourcePath = process.env.UIPATH_TEST_ARTIFACTS_SOURCE || "";
  const processName = process.env.UIPATH_PROCESS_NAME || "Automation";

  if (!sourcePath) {
    throw new Error("Set UIPATH_TEST_ARTIFACTS_SOURCE to an extracted SDD text file before provisioning Test Manager artifacts.");
  }

  const resolvedSource = path.resolve(sourcePath);
  const content = fs.readFileSync(resolvedSource, "utf8");

  let extractedArtifacts = parseArtifactsFromSDD(content);
  if (!extractedArtifacts) {
    extractedArtifacts = await extractArtifactsWithLLM(content);
  }

  const testManagerArtifacts = extractTestManagerArtifacts(extractedArtifacts || {});
  if (!hasTestManagerArtifacts(testManagerArtifacts)) {
    console.log(JSON.stringify({
      ok: true,
      message: "No Test Manager artifacts were found in the source document.",
      sourcePath: resolvedSource,
      processName,
      artifactCounts: {
        testCases: 0,
        testDataQueues: 0,
        requirements: 0,
        testSets: 0,
      },
    }, null, 2));
    return;
  }

  const result = await deployAllArtifacts(
    testManagerArtifacts,
    null,
    null,
    processName,
  );

  console.log(JSON.stringify({
    ok: true,
    sourcePath: resolvedSource,
    processName,
    artifactCounts: {
      testCases: testManagerArtifacts.testCases?.length || 0,
      testDataQueues: testManagerArtifacts.testDataQueues?.length || 0,
      requirements: testManagerArtifacts.requirements?.length || 0,
      testSets: testManagerArtifacts.testSets?.length || 0,
    },
    result,
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
