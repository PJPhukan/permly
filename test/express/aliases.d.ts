// Express 4 and 5 are installed under aliases so both can be tested. They share the
// @types/express typings, which is fine for tests.
/* eslint-disable @typescript-eslint/no-require-imports */
declare module "express4" {
  import express = require("express");
  export = express;
}
declare module "express5" {
  import express = require("express");
  export = express;
}
