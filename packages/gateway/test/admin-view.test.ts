import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { pageOf } from "../src/admin-view.ts";

describe("admin pagination", () => {
  it("builds direct page links around the current page and preserves filters", () => {
    const req = {
      baseUrl: "/admin",
      path: "/users",
      query: {
        page: "6",
        q: "active user",
        sort: "username",
        direction: "desc",
        saved: "1",
      },
    } as unknown as Request;

    const result = pageOf(
      Array.from({ length: 300 }, (_, index) => index),
      req,
    );

    expect(result.rows).toHaveLength(25);
    expect(result.pagination.pageItems).toEqual([
      {
        isPage: true,
        label: "1",
        href: "/admin/users?page=1&q=active+user&sort=username&direction=desc",
        current: false,
      },
      { gap: true },
      {
        isPage: true,
        label: "5",
        href: "/admin/users?page=5&q=active+user&sort=username&direction=desc",
        current: false,
      },
      {
        isPage: true,
        label: "6",
        href: "/admin/users?page=6&q=active+user&sort=username&direction=desc",
        current: true,
      },
      {
        isPage: true,
        label: "7",
        href: "/admin/users?page=7&q=active+user&sort=username&direction=desc",
        current: false,
      },
      { gap: true },
      {
        isPage: true,
        label: "12",
        href: "/admin/users?page=12&q=active+user&sort=username&direction=desc",
        current: false,
      },
    ]);
  });
});
