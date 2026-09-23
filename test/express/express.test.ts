import { once } from "node:events";
import type { AddressInfo, Server } from "node:net";
import express4 from "express4";
import express5 from "express5";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "../../src/adapters/memory";
import { createPermissions } from "../../src/core/create-permissions";
import type { PermissionAdapter } from "../../src/core/types";
import {
  permlyExpress,
  requireAllPermissions,
  requireAllRoles,
  requireAnyPermission,
  requireAnyRole,
  requirePermission,
  requireRole,
  type RequestLike,
} from "../../src/express";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const POSTS: Record<string, { userId: string }> = {
  "10": { userId: "2" }, // written by the editor
  "11": { userId: "9" }, // written by someone else
};

async function setupPerms(adapter: PermissionAdapter = memoryAdapter()) {
  const perms = createPermissions({
    adapter,
    permissions: ["posts.create", "posts.edit", "posts.edit.own", "posts.delete"],
    roles: ["admin", "editor", "viewer"],
  });
  await perms.sync();
  await perms.role("admin").givePermission("posts.*");
  await perms.role("editor").givePermission("posts.create", "posts.edit.own");
  await perms.user("1").assignRole("admin");
  await perms.user("2").assignRole("editor");
  await perms.user("3").assignRole("viewer");
  return perms;
}

type Perms = Awaited<ReturnType<typeof setupPerms>>;

for (const [label, express] of [
  ["Express 4", express4],
  ["Express 5", express5],
] as const) {
  describe(label, () => {
    let server: Server | undefined;
    let perms: Perms;
    let handlerCalls: number;

    beforeEach(async () => {
      perms = await setupPerms();
      handlerCalls = 0;
    });

    afterEach(async () => {
      if (server) await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    });

    /** Starts an app where `x-user-id` becomes req.user and `define` adds routes. */
    async function start(define: (app: ReturnType<typeof express>) => void) {
      const app = express();
      app.use((req: RequestLike, _res, next) => {
        const id = req.headers["x-user-id"];
        if (id) req.user = { id };
        next();
      });
      define(app);
      // Error handler: proves errors arrive here instead of being swallowed.
      app.use(
        (
          err: Error,
          _req: unknown,
          res: { status(c: number): { json(b: unknown): void } },
          next: unknown,
        ) => {
          void next;
          res.status(500).json({ handled: err.name, message: err.message });
        },
      );
      server = app.listen(0);
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      return async (path: string, userId?: string, init: RequestInit = {}) => {
        const headers = userId === undefined ? {} : { "x-user-id": userId };
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
        return { status: response.status, body: (await response.json()) as Json };
      };
    }

    const ok = (_req: unknown, res: { json(b: unknown): void }) => {
      handlerCalls++;
      res.json({ ok: true });
    };

    describe("simple functions", () => {
      it("responds 401 without a user", async () => {
        const get = await start((app) =>
          app.get("/", requirePermission(perms, "posts.create"), ok),
        );
        expect(await get("/")).toEqual({ status: 401, body: { error: "Unauthorized" } });
        expect(handlerCalls).toBe(0);
      });

      it("responds 403 with the missing permissions", async () => {
        const get = await start((app) => {
          app.get("/one", requirePermission(perms, "posts.delete"), ok);
          app.get("/all", requireAllPermissions(perms, ["posts.create", "posts.delete"]), ok);
          app.get("/any", requireAnyPermission(perms, ["posts.delete", "posts.edit"]), ok);
        });
        expect(await get("/one", "2")).toEqual({
          status: 403,
          body: { error: "Forbidden", missing: ["posts.delete"] },
        });
        expect((await get("/all", "2")).body.missing).toEqual(["posts.delete"]);
        expect((await get("/any", "2")).body.missing).toEqual(["posts.delete", "posts.edit"]);
        expect(handlerCalls).toBe(0);
      });

      it("calls the handler when allowed", async () => {
        const get = await start((app) => {
          app.get("/one", requirePermission(perms, "posts.create"), ok);
          app.get("/all", requireAllPermissions(perms, ["posts.create", "posts.edit.own"]), ok);
          app.get("/any", requireAnyPermission(perms, ["posts.delete", "posts.create"]), ok);
          app.get("/wild", requirePermission(perms, "posts.delete"), ok);
        });
        expect(await get("/one", "2")).toEqual({ status: 200, body: { ok: true } });
        expect((await get("/all", "2")).status).toBe(200);
        expect((await get("/any", "2")).status).toBe(200);
        expect((await get("/wild", "1")).status).toBe(200); // admin via "posts.*"
        expect(handlerCalls).toBe(4);
      });

      it("checks roles, listing missing roles on 403", async () => {
        const get = await start((app) => {
          app.get("/role", requireRole(perms, "admin"), ok);
          app.get("/any", requireAnyRole(perms, ["admin", "editor"]), ok);
          app.get("/all", requireAllRoles(perms, ["editor", "viewer"]), ok);
        });
        expect((await get("/role", "1")).status).toBe(200);
        expect(await get("/role", "2")).toEqual({
          status: 403,
          body: { error: "Forbidden", missing: ["admin"] },
        });
        expect((await get("/any", "2")).status).toBe(200);
        expect((await get("/any", "3")).body.missing).toEqual(["admin", "editor"]);
        expect((await get("/all", "2")).body.missing).toEqual(["viewer"]);
      });

      it("treats user id 0 as a user, not as missing", async () => {
        await perms.user(0).assignRole("admin");
        const get = await start((app) =>
          app.get("/", requireRole(perms, "admin", { getUserId: () => 0 }), ok),
        );
        expect((await get("/")).status).toBe(200);
      });
    });

    describe("guard factory", () => {
      it("shares options across routes, including async getUserId", async () => {
        const guard = permlyExpress(perms, {
          getUserId: async (req) => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return req.headers["x-user-id"] as string | undefined;
          },
        });
        const get = await start((app) => {
          app.get("/create", guard.permission("posts.create"), ok);
          app.get("/delete", guard.permission("posts.delete"), ok);
          app.get("/admin", guard.role("admin"), ok);
          app.get("/any", guard.anyPermission(["posts.delete", "posts.create"]), ok);
          app.get("/all", guard.allPermissions(["posts.create", "posts.delete"]), ok);
          app.get("/anyRole", guard.anyRole(["admin", "viewer"]), ok);
          app.get("/allRoles", guard.allRoles(["admin"]), ok);
        });
        expect((await get("/create", "2")).status).toBe(200);
        expect((await get("/delete", "2")).status).toBe(403);
        expect((await get("/admin")).status).toBe(401);
        expect((await get("/admin", "1")).status).toBe(200);
        expect((await get("/any", "2")).status).toBe(200);
        expect((await get("/all", "2")).body.missing).toEqual(["posts.delete"]);
        expect((await get("/anyRole", "3")).status).toBe(200);
        expect((await get("/allRoles", "3")).body.missing).toEqual(["admin"]);
      });

      it("supports custom onDenied, onUnauthenticated and onNotFound (sync or async)", async () => {
        const guard = permlyExpress(perms, {
          onUnauthenticated: (_req, res) => res.status(401).json({ login: "/login" }),
          onDenied: async (req, res, missing) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            res.status(403).json({ path: req.path, need: missing });
          },
          onNotFound: (_req, res) => res.status(404).json({ gone: true }),
        });
        const get = await start((app) => {
          app.get("/delete", guard.permission("posts.delete"), ok);
          app.put(
            "/posts/:id",
            guard.own("posts.edit", (req) => POSTS[req.params.id]?.userId),
            ok,
          );
        });
        expect(await get("/delete")).toEqual({ status: 401, body: { login: "/login" } });
        expect(await get("/delete", "2")).toEqual({
          status: 403,
          body: { path: "/delete", need: ["posts.delete"] },
        });
        expect(await get("/posts/404", "2", { method: "PUT" })).toEqual({
          status: 404,
          body: { gone: true },
        });
      });
    });

    describe("ownership", () => {
      async function startOwn() {
        const guard = permlyExpress(perms);
        let loads = 0;
        const get = await start((app) =>
          app.put(
            "/posts/:id",
            guard.own("posts.edit", async (req) => {
              loads++;
              return POSTS[req.params.id]?.userId;
            }),
            ok,
          ),
        );
        const put = (id: string, user?: string) => get(`/posts/${id}`, user, { method: "PUT" });
        return { put, loads: () => loads };
      }

      it("allows the owner with the .own permission", async () => {
        const { put } = await startOwn();
        expect(await put("10", "2")).toEqual({ status: 200, body: { ok: true } });
      });

      it("denies a non-owner with only the .own permission", async () => {
        const { put } = await startOwn();
        expect(await put("11", "2")).toEqual({
          status: 403,
          body: { error: "Forbidden", missing: ["posts.edit"] },
        });
      });

      it("allows the full permission on anyone's resource", async () => {
        const { put } = await startOwn();
        expect((await put("11", "1")).status).toBe(200);
      });

      it("responds 404 when the loader finds nothing, even for admins", async () => {
        const { put } = await startOwn();
        expect(await put("999", "1")).toEqual({ status: 404, body: { error: "Not Found" } });
      });

      it("checks authentication before loading the resource", async () => {
        const { put, loads } = await startOwn();
        expect((await put("10")).status).toBe(401);
        expect(loads()).toBe(0);
      });
    });

    describe("errors go to next(err)", () => {
      it("unknown permission in strict mode", async () => {
        const get = await start((app) =>
          app.get("/", requirePermission(perms, "posts.nope" as "posts.edit"), ok),
        );
        expect(await get("/", "2")).toEqual({
          status: 500,
          body: {
            handled: "PermissionNotFoundError",
            message: 'Permission "posts.nope" does not exist.',
          },
        });
      });

      it("database errors", async () => {
        const failing = memoryAdapter();
        const broken = await setupPerms(failing);
        failing.getUserAccess = async () => {
          throw new Error("connection lost");
        };
        broken.clearCache();
        const get = await start((app) => app.get("/", requirePermission(broken, "posts.edit"), ok));
        expect((await get("/", "2")).body).toEqual({
          handled: "Error",
          message: "connection lost",
        });
      });

      it("errors thrown by getUserId, loaders and onDenied", async () => {
        const boom = (where: string) => () => {
          throw new TypeError(`boom in ${where}`);
        };
        const get = await start((app) => {
          app.get(
            "/id",
            requirePermission(perms, "posts.edit", { getUserId: boom("getUserId") }),
            ok,
          );
          app.get("/load", permlyExpress(perms).own("posts.edit", boom("loader")), ok);
          app.get(
            "/deny",
            requirePermission(perms, "posts.delete", { onDenied: boom("onDenied") }),
            ok,
          );
        });
        expect((await get("/id", "2")).body).toEqual({
          handled: "TypeError",
          message: "boom in getUserId",
        });
        expect((await get("/load", "2")).body.message).toBe("boom in loader");
        expect((await get("/deny", "2")).body.message).toBe("boom in onDenied");
        expect(handlerCalls).toBe(0);
      });

      it("invalid user ids", async () => {
        const get = await start((app) =>
          app.get("/", requirePermission(perms, "posts.edit", { getUserId: () => 1.5 }), ok),
        );
        expect((await get("/")).body.handled).toBe("InvalidInputError");
      });
    });
  });
}

describe("setup validation (fails when routes are defined)", async () => {
  const perms = await setupPerms();
  const loose = permlyExpress as (...args: unknown[]) => unknown;

  it.each([
    [() => loose({}), "needs the object returned by createPermissions()"],
    [() => loose(perms, { getUserID: () => 1 }), 'Unknown permly/express option "getUserID"'],
    [() => loose(perms, { onDenied: "nope" }), 'option "onDenied" must be a function'],
    [() => requirePermission(perms, "" as "posts.edit"), "permission() needs a name"],
    [() => requireAnyRole(perms, []), "anyRole() needs a non-empty array"],
    [() => permlyExpress(perms).own("posts.edit", undefined as never), "needs a function"],
  ])("%#", (fn, message) => {
    expect(fn).toThrow(message);
  });
});
