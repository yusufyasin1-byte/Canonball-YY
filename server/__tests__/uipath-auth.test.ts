import { beforeEach, describe, expect, it, vi } from "vitest";

describe("UiPath auth OR scope handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
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
});
