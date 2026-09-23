# Express + permly (CommonJS)

Plain JavaScript using `require()`. A tiny posts API with fake authentication: the user id comes from an
`x-user-id` header.

```sh
npm install
npm start
```

Inside the permly repo, build it first with `npm run build` in the repo root (the example
installs it from `../..`). In your own project, just `npm install permly`.

The server listens on port 3000 (set `PORT` to change it). Permissions are kept in memory.
To use MySQL instead, set `DATABASE_URL`; the tables are created on startup:

```sh
DATABASE_URL=mysql://user:password@localhost:3306/mydb npm start
```

## Users and permissions

| User | Role   | Can                                          |
| ---- | ------ | -------------------------------------------- |
| 1    | admin  | everything (`posts.*`)                       |
| 2, 3 | editor | `posts.create`, `posts.edit.own` (own posts) |
| 4    | viewer | nothing (reading posts is public)            |

Post 1 belongs to user 2.

## Try it

```sh
# Public
curl localhost:3000/posts

# 401: no user
curl -i -X POST localhost:3000/posts
# {"error":"Unauthorized"}

# 403: a viewer can't create posts
curl -i -X POST localhost:3000/posts -H "x-user-id: 4"
# {"error":"Forbidden","missing":["posts.create"]}

# 201: an editor can
curl -i -X POST localhost:3000/posts -H "x-user-id: 2" -H "content-type: application/json" -d '{"title":"Hi"}'

# 200: editors can edit their own post...
curl -i -X PUT localhost:3000/posts/1 -H "x-user-id: 2" -H "content-type: application/json" -d '{"title":"Edited"}'

# 403: ...but not someone else's
curl -i -X PUT localhost:3000/posts/1 -H "x-user-id: 3"
# {"error":"Forbidden","missing":["posts.edit"]}

# 404: the post doesn't exist
curl -i -X PUT localhost:3000/posts/999 -H "x-user-id: 1"

# 403 / 200: admin area
curl -i localhost:3000/admin -H "x-user-id: 2"
curl -i localhost:3000/admin -H "x-user-id: 1"
```
