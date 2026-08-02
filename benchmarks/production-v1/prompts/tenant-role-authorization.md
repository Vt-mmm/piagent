Fix `src/backend/auth.js` without changing its exported API.

`canManage(user, resource)` may return true only when the user is active, has
role `owner` or `admin`, and belongs to the same non-empty tenant as the
resource. Missing input must be denied. Keep the change focused and run the
project verification commands.
