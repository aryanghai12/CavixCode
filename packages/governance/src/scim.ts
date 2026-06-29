import { randomUUID } from "node:crypto";
import { effectiveRole, type Role } from "./rbac.ts";

// SCIM 2.0-style provisioning. The IdP pushes users/groups; Cavix maps IdP groups
// to RBAC roles. Deactivation is a soft-delete (active=false) per SCIM — the user
// keeps their audit history but loses access.

export interface ScimUser {
  id: string;
  userName: string;
  externalId?: string;
  active: boolean;
  displayName?: string;
  emails: string[];
  groups: string[];
}

export interface ScimGroup {
  id: string;
  displayName: string;
  members: string[];
}

export interface ProvisionInput {
  userName: string;
  externalId?: string;
  active?: boolean;
  displayName?: string;
  emails?: string[];
  groups?: string[];
}

export class IdentityStore {
  private users = new Map<string, ScimUser>();
  private groups = new Map<string, ScimGroup>();
  private byUserName = new Map<string, string>();
  private byExternalId = new Map<string, string>();
  private readonly groupRoleMap: Record<string, Role>;

  constructor(groupRoleMap: Record<string, Role> = {}) {
    this.groupRoleMap = groupRoleMap;
  }

  /** Create or update a user (idempotent on externalId, else userName). */
  provisionUser(input: ProvisionInput): ScimUser {
    const existingId = (input.externalId && this.byExternalId.get(input.externalId)) || this.byUserName.get(input.userName);
    const user: ScimUser = {
      id: existingId ?? `usr_${randomUUID().slice(0, 8)}`,
      userName: input.userName,
      externalId: input.externalId,
      active: input.active ?? true,
      displayName: input.displayName,
      emails: input.emails ?? [],
      groups: input.groups ?? (existingId ? this.users.get(existingId)!.groups : []),
    };
    this.users.set(user.id, user);
    this.byUserName.set(user.userName, user.id);
    if (user.externalId) this.byExternalId.set(user.externalId, user.id);
    return user;
  }

  deactivateUser(id: string): void {
    const u = this.users.get(id);
    if (u) u.active = false;
  }

  getUser(id: string): ScimUser | undefined {
    return this.users.get(id);
  }
  findByUserName(userName: string): ScimUser | undefined {
    const id = this.byUserName.get(userName);
    return id ? this.users.get(id) : undefined;
  }
  listUsers(activeOnly = false): ScimUser[] {
    const all = [...this.users.values()];
    return activeOnly ? all.filter((u) => u.active) : all;
  }

  createGroup(displayName: string): ScimGroup {
    const g: ScimGroup = { id: `grp_${randomUUID().slice(0, 8)}`, displayName, members: [] };
    this.groups.set(g.id, g);
    return g;
  }
  setUserGroups(userId: string, groups: string[]): void {
    const u = this.users.get(userId);
    if (u) u.groups = groups;
  }

  /** The RBAC roles a user holds, derived from their IdP groups. */
  rolesFor(userId: string): Role[] {
    const u = this.users.get(userId);
    if (!u || !u.active) return [];
    const roles = u.groups.map((g) => this.groupRoleMap[g]).filter((r): r is Role => !!r);
    return roles.length ? roles : ["member"];
  }

  /** The single effective role (highest privilege) for access decisions. */
  effectiveRoleFor(userId: string): Role {
    return effectiveRole(this.rolesFor(userId));
  }
}
