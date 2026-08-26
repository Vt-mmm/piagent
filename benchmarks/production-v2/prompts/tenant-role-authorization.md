Fix `src/backend/auth.js` without changing its exported API.

`canManage(user, resource)` may return true only when the user is active, has
role `owner` or `admin`, and `user.tenantId` and `resource.tenantId` are the
same non-empty string. Missing input must be denied. Keep the change focused
and run the project verification commands.
