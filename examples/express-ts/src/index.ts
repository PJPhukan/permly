// A tiny posts API protected by permly (TypeScript).
// Fake auth: send the user id in an "x-user-id" header. See README.md for curl commands.
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import { createPermissions, type PermissionAdapter } from "permly";
import { memoryAdapter } from "permly/memory";
import { permlyExpress } from "permly/express";

// Tell Express's types about the user our auth middleware sets.
declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string };
  }
}

interface Post {
  id: number;
  title: string;
  userId: string;
}

// In-memory by default; MySQL when DATABASE_URL is set (e.g. mysql://user:pass@localhost/db).
async function createAdapter(): Promise<PermissionAdapter> {
  const url = process.env.DATABASE_URL;
  if (!url) return memoryAdapter();
  const { default: mysql } = await import("mysql2/promise");
  const { mysqlAdapter, mysqlSchemaStatements } = await import("permly/mysql");
  const pool = mysql.createPool(url);
  for (const statement of mysqlSchemaStatements()) await pool.query(statement);
  return mysqlAdapter(pool);
}

// The name lists give autocomplete, and typos are compile errors:
// guard.permission("posts.edt") does not compile.
const perms = createPermissions({
  adapter: await createAdapter(),
  permissions: ["posts.create", "posts.edit", "posts.edit.own", "posts.delete"],
  roles: ["admin", "editor", "viewer"],
});

// Safe to run on every start.
await perms.sync();
await perms.role("admin").givePermission("posts.*");
await perms.role("editor").givePermission("posts.create", "posts.edit.own");

// Demo users: 1 = admin, 2 and 3 = editors, 4 = viewer.
await perms.user(1).syncRoles(["admin"]);
await perms.user(2).syncRoles(["editor"]);
await perms.user(3).syncRoles(["editor"]);
await perms.user(4).syncRoles(["viewer"]);

const posts = new Map<number, Post>([[1, { id: 1, title: "Hello permly", userId: "2" }]]);
let nextId = 2;

const app = express();
app.use(express.json());

// Fake authentication. Replace with your real auth (session, JWT, passport, ...).
app.use((req: Request, _res: Response, next: NextFunction) => {
  const id = req.get("x-user-id");
  if (id) req.user = { id };
  next();
});

const guard = permlyExpress(perms, { getUserId: (req: Request) => req.user?.id });

app.get("/posts", (_req, res) => {
  res.json([...posts.values()]);
});

app.post("/posts", guard.permission("posts.create"), (req: Request, res: Response) => {
  const body = req.body as { title?: unknown } | undefined;
  const post: Post = {
    id: nextId++,
    title: String(body?.title ?? "Untitled"),
    userId: req.user!.id,
  };
  posts.set(post.id, post);
  res.status(201).json(post);
});

// Editors may edit their own posts ("posts.edit.own"); admins any post ("posts.edit").
app.put(
  "/posts/:id",
  guard.own("posts.edit", (req) => posts.get(Number(req.params.id))?.userId),
  (req: Request<{ id: string }>, res: Response) => {
    const post = posts.get(Number(req.params.id))!; // the guard already answered 404 if missing
    const body = req.body as { title?: unknown } | undefined;
    post.title = String(body?.title ?? post.title);
    res.json(post);
  },
);

app.delete(
  "/posts/:id",
  guard.permission("posts.delete"),
  (req: Request<{ id: string }>, res: Response) => {
    posts.delete(Number(req.params.id));
    res.status(204).end();
  },
);

app.get("/admin", guard.role("admin"), (_req, res) => {
  res.json({ posts: posts.size });
});

// Unexpected errors (database down, unknown permission name, ...) end up here.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  const { port } = server.address() as AddressInfo;
  console.log(`Posts API listening on http://localhost:${port}`);
});
