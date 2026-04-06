import { beforeEach, describe, expect, it, vi } from "vitest";

describe("UiPath auth OR scope handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.UIPATH_CLIENT_ID;
    delete process.env.UIPATH_CLIENT_SECRET;
    delete process.env.UIPATH_ORGANIZATION_ID;
    delete process.env.UIPATH_TENANT_NAME;
    delete process.env.UIPATH_SCOPES;
  });

  it("defaults OR scopes to OR.Default", async () => {
    const auth = await import("../uipath-auth");
    expect(auth.getDefaultOrScopes()).toBe("OR.Default");
  });

  it("retries OR auth with OR.Default after invalid_scope", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_scope"}',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "token-123" }),
      });

    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("../uipath-auth");
    const token = await auth.getAccessToken({
      clientId: "171d775b-89cf-4a2f-bb19-37f9afd8c821",
      clientSecret: "secret",
      scopes: "OR.Folders.Read OR.Jobs.Read",
    });

    expect(token).toBe("token-123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]?.body).toContain("scope=OR.Default");
    expect(fetchMock.mock.calls[1]?.[1]?.body).toContain("scope=OR.Folders.Read+OR.Jobs.Read");
  });

  it("allows TM token acquisition with documented scopes even when OIDC family is missing", async () => {
    process.env.UIPATH_CLIENT_ID = "tm-client";
    process.env.UIPATH_CLIENT_SECRET = "tm-secret";
    process.env.UIPATH_ORGANIZATION_ID = "test-org";
    process.env.UIPATH_TENANT_NAME = "test-tenant";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "token-123", expires_in: 3600 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = await import("../uipath-auth");
    const metadataModule = await import("../catalog/metadata-service");

    const hasOidcSpy = vi.spyOn(metadataModule.metadataService, "hasOidcScopeFamily").mockReturnValue(false);
    const scopeCandidateSpy = vi
      .spyOn(metadataModule.metadataService, "getScopeCandidatesForService")
      .mockReturnValue([{ label: "taxonomy", scopes: ["TM.Projects.Read", "TM.TestCases.Write"] }]);
    const minimalScopeSpy = vi
      .spyOn(metadataModule.metadataService, "getMinimalScopesForServiceString")
      .mockReturnValue("TM.Projects.Read TM.TestCases.Write");

    const token = await auth.getTmToken();

    expect(token).toBe("token-123");
    expect(hasOidcSpy).toHaveBeenCalled();
    expect(scopeCandidateSpy).toHaveBeenCalled();
    expect(minimalScopeSpy).toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    const tokenCall = fetchMock.mock.calls.find((call) => String(call?.[1]?.body || "").includes("scope=TM.Projects.Read+TM.TestCases.Write"));
    expect(tokenCall).toBeTruthy();
  });
});
