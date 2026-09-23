export { createPermissions } from "./core/create-permissions";
export {
  InvalidInputError,
  PermissionDeniedError,
  PermissionNotFoundError,
  PermissionsError,
  RoleNotFoundError,
  isPermissionDeniedError,
  isPermissionsError,
} from "./core/errors";
export type { NotFoundDetails, PermissionsErrorCode } from "./core/errors";
export type {
  CacheOptions,
  GetPermissionsOptions,
  PermissionAdapter,
  Permissions,
  PermissionsConfig,
  RoleScope,
  SyncResult,
  UserAccess,
  UserId,
  UserScope,
  Wildcard,
} from "./core/types";
