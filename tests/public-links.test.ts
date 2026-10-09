import { describe, expect, it } from "vitest";
import { rewriteUpstreamLinks } from "../src/public-links.js";

describe("rewriteUpstreamLinks", () => {
  const upstream = "https://autoapitwo.vercel.app";
  const pub = "https://banktwo.cars.tk";

  it("rewrites fleet links to the public Banktwo host without the upstream name", () => {
    const body = JSON.stringify({
      results: [{
        id: "27817",
        _links: {
          self: { href: `${upstream}/api/v1/fleet/carids/27817?locale=en_US` },
          repair: { href: `${upstream}/api/v1/content/carids/27817/components/1?locale=en_US` },
        },
      }],
    });
    const rewritten = rewriteUpstreamLinks(body, upstream, pub);
    expect(rewritten).not.toContain("autoapitwo");
    expect(rewritten).not.toContain(upstream);
    const parsed = JSON.parse(rewritten);
    expect(parsed.results[0]._links.self.href).toBe("https://banktwo.cars.tk/v1/fleet/carids/27817?locale=en_US");
    expect(parsed.results[0]._links.repair.href).toBe(
      "https://banktwo.cars.tk/v1/content/carids/27817/resource?path=%2Fapi%2Fv1%2Fcontent%2Fcarids%2F27817%2Fcomponents%2F1&sourceQuery=locale%3Den_US",
    );
  });

  it("rewrites relative upstream paths", () => {
    const rewritten = rewriteUpstreamLinks(JSON.stringify({ href: "/api/v1/fleet/years/2024/makes" }), upstream, pub);
    expect(JSON.parse(rewritten).href).toBe("https://banktwo.cars.tk/v1/fleet/years/2024/makes");
  });
});
