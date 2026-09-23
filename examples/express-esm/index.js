// A tiny posts API protected by permly (ES modules / import).
// Fake auth: send the user id in an "x-user-id" header. See README.md for curl commands.
import express from "express";
import { createPermissions } from "permly";
import { memoryAdapter } from "permly/memory";
import { permlyExpress } from "permly/express";

// In-memory by default; MySQL when DATABASE_URL is set (e.g. mysql://user:pass@localhost/db).
async function createAdapter() {
  if (!process.env.DATABASE_URL) return memoryAdapter();
  const { default: mysql } = await import("mysql2/promise");
  const { mysqlAdapter, mysqlSchemaStatements } = await import("permly/mysql");
  const pool = mysql.createPool(process.env.DATABASE_URL);
  for (const statement of mysqlSchemaStatements()) await pool.query(statement);
  return mysqlAdapter(pool);
}

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

const posts = new Map([[1, { id: 1, title: "Hello permly", userId: "2" }]]);
let nextId = 2;

const app = express();
app.use(express.json());

// Fake authentication. Replace with your real auth (session, JWT, passport, ...).
app.use((req, _res, next) => {
  const id = req.get("x-user-id");
  if (id) req.user = { id };
  next();
});

const guard = permlyExpress(perms);

app.get("/posts", (_req, res) => {
  res.json([...posts.values()]);
});

app.post("/posts", guard.permission("posts.create"), (req, res) => {
  const post = { id: nextId++, title: String(req.body?.title ?? "Untitled"), userId: req.user.id };
  posts.set(post.id, post);
  res.status(201).json(post);
});

// Editors may edit their own posts ("posts.edit.own"); admins any post ("posts.edit").
app.put(
  "/posts/:id",
  guard.own("posts.edit", (req) => posts.get(Number(req.params.id))?.userId),
  (req, res) => {
    const post = posts.get(Number(req.params.id));
    post.title = String(req.body?.title ?? post.title);
    res.json(post);
  },
);

app.delete("/posts/:id", guard.permission("posts.delete"), (req, res) => {
  posts.delete(Number(req.params.id));
  res.status(204).end();
});

app.get("/admin", guard.role("admin"), (_req, res) => {
  res.json({ posts: posts.size });
});

// Unexpected errors (database down, unknown permission name, ...) end up here.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

const server = app.listen(Number(process.env.PORT ?? 3000), () => {
  console.log(`Posts API listening on http://localhost:${server.address().port}`);
});
