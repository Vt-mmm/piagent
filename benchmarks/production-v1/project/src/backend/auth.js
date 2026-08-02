export function canManage(user, resource) {
  return user?.active !== false && ["owner", "admin"].includes(user?.role) && Boolean(resource);
}
