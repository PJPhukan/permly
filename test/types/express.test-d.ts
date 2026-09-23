import express, { type NextFunction, type Request, type Response } from "express";
import { describe, expectTypeOf, it } from "vitest";
import { memoryAdapter } from "../../src/adapters/memory";
import { createPermissions } from "../../src/core/create-permissions";
import {
  permlyExpress,
  requireAnyPermission,
  requirePermission,
  requireRole,
  type Middleware,
} from "../../src/express";

const perms = createPermissions({
  adapter: memoryAdapter(),
  permissions: ["posts.create", "posts.edit", "posts.edit.own"],
  roles: ["admin", "editor"],
});

const app = express();
const handler = (_req: Request, res: Response) => void res.json({ ok: true });

describe("fits Express route signatures", () => {
  it("simple functions and guards are valid middleware", () => {
    app.get("/a", requirePermission(perms, "posts.edit"), handler);
    app.get("/b", requireAnyPermission(perms, ["posts.edit", "posts.create"]), handler);
    app.get("/c", requireRole(perms, "admin"), handler);

    const guard = permlyExpress(perms);
    const owners = new Map<string, number>();
    app.put(
      "/posts/:id",
      guard.own("posts.edit", (req) => owners.get(String(req.params.id))),
      handler,
    );
    app.use(guard.role("editor"));
  });

  it("works with a typed request and Express's own Response type in callbacks", () => {
    interface AuthedRequest extends Request {
      session: { userId?: number };
    }
    const guard = permlyExpress(perms, {
      getUserId: (req: AuthedRequest) => req.session.userId,
      onDenied: (_req: AuthedRequest, res: Response, missing) => {
        expectTypeOf(missing).toEqualTypeOf<string[]>();
        res.status(403).send("nope");
      },
    });
    expectTypeOf(guard.permission("posts.edit")).toEqualTypeOf<Middleware<AuthedRequest>>();
    // Assignable to a handler for that request type (Express itself only knows about `session`
    // if you add it to its Request type via declaration merging, as usual).
    const typed: (req: AuthedRequest, res: Response, next: NextFunction) => void =
      guard.permission("posts.edit");
    void typed;
  });

  it("the loose default request type still lets loaders read anything", () => {
    permlyExpress(perms).own("posts.edit", (req) => req.anything?.goes);
  });
});

describe("autocomplete and typo errors", () => {
  it("rejects unknown names", () => {
    const guard = permlyExpress(perms);
    // @ts-expect-error misspelled permission
    guard.permission("posts.edt");
    // @ts-expect-error misspelled role
    guard.role("admn");
    // @ts-expect-error wildcards are for granting, not checking
    guard.permission("posts.*");
    // @ts-expect-error misspelled permission
    requirePermission(perms, "posts.delete");
    // @ts-expect-error misspelled role
    requireRole(perms, "viewer");
  });

  it("the loader must return an owner id", () => {
    const guard = permlyExpress(perms);
    guard.own("posts.edit", async () => 42);
    guard.own("posts.edit", () => null);
    // @ts-expect-error an object is not an owner id
    guard.own("posts.edit", () => ({ id: 1 }));
  });
});
