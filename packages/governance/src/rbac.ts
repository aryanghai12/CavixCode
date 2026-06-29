// RBAC: a small, explicit role → permission model. Roles are ordered (owner ⊃
// admin ⊃ reviewer ⊃ member); permissions are checked per action. SSO/SCIM groups
// map to these roles (see scim.ts groupRoleMap).

export type Role = "owner" | "admin" | "reviewer" | "member";

export type Permission =
  | "org:manage"
  | "billing:manage"
  | "repo:onboard"
  | "policy:edit"
  | "settings:edit"
  | "review:read"
  | "review:decide"
  | "audit:read";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["org:manage", "billing:manage", "repo:onboard", "policy:edit", "settings:edit", "review:read", "review:decide", "audit:read"],
  admin: ["repo:onboard", "policy:edit", "settings:edit", "review:read", "review:decide", "audit:read"],
  reviewer: ["review:read", "review:decide"],
  member: ["review:read"],
};

const ROLE_RANK: Record<Role, number> = { owner: 4, admin: 3, reviewer: 2, member: 1 };

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** The highest-privilege role among a user's assigned roles. */
export function effectiveRole(roles: Role[]): Role {
  return roles.reduce<Role>((best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best), "member");
}

export function requirePermission(role: Role, permission: Permission): void {
  if (!can(role, permission)) throw new Error(`forbidden: role "${role}" lacks "${permission}"`);
}
