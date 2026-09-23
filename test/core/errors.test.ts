import { describe, expect, it } from "vitest";
import {
  InvalidInputError,
  PermissionDeniedError,
  PermissionNotFoundError,
  PermissionsError,
  RoleNotFoundError,
  isPermissionDeniedError,
  isPermissionsError,
} from "../../src/core/errors";
import { levenshtein, suggest } from "../../src/core/similarity";

describe("error classes", () => {
  it("have names, codes and details", () => {
    const denied = new PermissionDeniedError(["posts.edit"]);
    expect(denied).toBeInstanceOf(PermissionsError);
    expect(denied).toBeInstanceOf(Error);
    expect(denied.name).toBe("PermissionDeniedError");
    expect(denied.code).toBe("PERMISSION_DENIED");
    expect(denied.missing).toEqual(["posts.edit"]);

    const role = new RoleNotFoundError("admn", { suggestion: "admin" });
    expect(role.role).toBe("admn");
    expect(role.suggestion).toBe("admin");
    expect(role.code).toBe("ROLE_NOT_FOUND");

    expect(new PermissionNotFoundError("x").code).toBe("PERMISSION_NOT_FOUND");
    expect(new InvalidInputError("bad").code).toBe("INVALID_INPUT");
  });
});

describe("brand helpers", () => {
  it("recognise permly errors", () => {
    expect(isPermissionsError(new InvalidInputError("x"))).toBe(true);
    expect(isPermissionDeniedError(new PermissionDeniedError(["a"]))).toBe(true);
    expect(isPermissionDeniedError(new RoleNotFoundError("a"))).toBe(false);
  });

  it("reject everything else", () => {
    for (const value of [new Error("x"), null, undefined, "PERMISSION_DENIED", 42, {}]) {
      expect(isPermissionsError(value)).toBe(false);
      expect(isPermissionDeniedError(value)).toBe(false);
    }
  });

  it("work across package copies, where instanceof fails", () => {
    // What an error from a second copy of permly (e.g. CJS vs ESM) looks like to this copy.
    class OtherCopyError extends Error {}
    const foreign = new OtherCopyError("denied");
    Object.defineProperty(foreign, Symbol.for("permly.error"), { value: "PERMISSION_DENIED" });

    expect(foreign instanceof PermissionDeniedError).toBe(false);
    expect(isPermissionsError(foreign)).toBe(true);
    expect(isPermissionDeniedError(foreign)).toBe(true);
  });
});

describe("suggestions", () => {
  it("levenshtein", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "")).toBe(3);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("suggests close names only", () => {
    const names = ["posts.edit", "posts.create", "users.ban"];
    expect(suggest("posts.edt", names)).toBe("posts.edit");
    expect(suggest("Posts.Edit", names)).toBe("posts.edit");
    expect(suggest("billing.refund", names)).toBeUndefined();
    expect(suggest("x", [])).toBeUndefined();
  });
});
