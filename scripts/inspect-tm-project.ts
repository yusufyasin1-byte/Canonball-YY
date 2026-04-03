import { getConfig, getTestManagerBaseUrl, getTmHeaders } from "../server/uipath-auth";

async function tmFetch(path: string) {
  const config = await getConfig();
  if (!config) throw new Error("UiPath config not available");
  const base = getTestManagerBaseUrl(config);
  const headers = await getTmHeaders();
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return {
    status: res.status,
    ok: res.ok,
    data,
  };
}

function pickItems(payload: any): any[] {
  return payload?.data || payload?.value || payload?.items || (Array.isArray(payload) ? payload : []);
}

async function main() {
  const projectName = process.env.TM_PROJECT_NAME || "POInvoiceTestNew";

  const projectsRes = await tmFetch("/api/v2/Projects?$top=200");
  if (!projectsRes.ok) {
    throw new Error(`Project list failed (${projectsRes.status})`);
  }

  const projects = pickItems(projectsRes.data);
  const project = projects.find((p: any) => ((p.Name || p.name || "") as string).toLowerCase() === projectName.toLowerCase());
  if (!project) {
    throw new Error(`Project "${projectName}" not found`);
  }

  const projectId = project.Id || project.id;

  const [casesRes, setsRes, reqsRes] = await Promise.all([
    tmFetch(`/api/v2/${projectId}/testcases?$top=50`),
    tmFetch(`/api/v2/${projectId}/testsets?$top=50`),
    tmFetch(`/api/v2/${projectId}/requirements?$top=50`),
  ]);

  const cases = pickItems(casesRes.data);
  const sets = pickItems(setsRes.data);
  const reqs = pickItems(reqsRes.data);

  const firstCase = cases[0];
  const firstSet = sets[0];

  let caseDetail: any = null;
  let setDetail: any = null;
  if (firstCase) {
    const caseId = firstCase.Id || firstCase.id;
    caseDetail = await tmFetch(`/api/v2/${projectId}/testcases/${caseId}`);
  }
  if (firstSet) {
    const setId = firstSet.Id || firstSet.id;
    setDetail = await tmFetch(`/api/v2/${projectId}/testsets/${setId}`);
  }

  console.log(JSON.stringify({
    project: {
      id: projectId,
      name: project.Name || project.name,
      fields: Object.keys(project || {}),
    },
    testCases: {
      count: cases.length,
      fields: firstCase ? Object.keys(firstCase) : [],
      first: firstCase,
      detailStatus: caseDetail?.status,
      detailFields: caseDetail?.data && typeof caseDetail.data === "object" ? Object.keys(caseDetail.data) : [],
      detail: caseDetail?.data,
    },
    testSets: {
      count: sets.length,
      fields: firstSet ? Object.keys(firstSet) : [],
      first: firstSet,
      detailStatus: setDetail?.status,
      detailFields: setDetail?.data && typeof setDetail.data === "object" ? Object.keys(setDetail.data) : [],
      detail: setDetail?.data,
    },
    requirements: {
      count: reqs.length,
      fields: reqs[0] ? Object.keys(reqs[0]) : [],
      first: reqs[0] || null,
    },
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
