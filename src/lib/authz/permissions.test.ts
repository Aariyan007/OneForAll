// Unit tests for the central permission matrix (pure). The database functions enforce the same rules; their own tests
// live in supabase/tests/members_invitations_rls.sql and task_workflow_rls.sql.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAPABILITIES, ORG_ROLES, can, canChangeRole, canRemoveMember, canSuspendMember, invitableRoles, isOrgRole } from "./permissions";

const owner = { userId: "u-owner", role: "OWNER" as const };
const admin = { userId: "u-admin", role: "ADMIN" as const };
const admin2 = { userId: "u-admin2", role: "ADMIN" as const };
const member = { userId: "u-member", role: "MEMBER" as const };
const member2 = { userId: "u-member2", role: "MEMBER" as const };

describe("permission matrix", () => {
  it("knows exactly the three organization roles", () => {
    assert.deepEqual([...ORG_ROLES], ["OWNER", "ADMIN", "MEMBER"]);
    assert.ok(isOrgRole("ADMIN"));
    for (const bad of ["owner", "EMPLOYEE", "SUPERADMIN", "", null, undefined, 1]) assert.ok(!isOrgRole(bad), String(bad));
  });

  it("unknown or missing roles hold no capability (no spoofing through odd values)", () => {
    for (const capability of CAPABILITIES) {
      for (const role of [null, undefined, "", "owner", "ROOT", "OWNER ", "EMPLOYEE"]) {
        assert.equal(can(role, capability), false, `${String(role)} -> ${capability}`);
      }
    }
  });

  it("employees hold only read, own-work and comment capabilities", () => {
    const allowed = CAPABILITIES.filter((c) => can("MEMBER", c)).sort();
    assert.deepEqual(allowed, ["members.view", "org.read", "tasks.comment", "tasks.updateOwn", "workforce.editOwn"].sort());
  });

  it("admins manage work but not roles or the assignment policy", () => {
    for (const c of ["hierarchy.manage", "members.invite", "members.remove", "members.suspend", "workforce.import", "structure.import", "workforce.manage", "tasks.create", "tasks.assign", "tasks.review"] as const) {
      assert.ok(can("ADMIN", c), c);
    }
    assert.ok(!can("ADMIN", "members.changeRole"));
    assert.ok(!can("ADMIN", "org.assignmentPolicy.edit"));
  });

  it("owners hold every capability", () => {
    for (const c of CAPABILITIES) assert.ok(can("OWNER", c), c);
  });
});

describe("invitations", () => {
  it("nobody can invite an owner; admins invite employees only; employees invite nobody", () => {
    assert.deepEqual(invitableRoles("OWNER"), ["ADMIN", "MEMBER"]);
    assert.deepEqual(invitableRoles("ADMIN"), ["MEMBER"]);
    assert.deepEqual(invitableRoles("MEMBER"), []);
    assert.deepEqual(invitableRoles(null), []);
  });
});

describe("role changes", () => {
  it("only an owner changes roles, between ADMIN and MEMBER, of someone else", () => {
    assert.ok(canChangeRole(owner, member, "ADMIN"));
    assert.ok(canChangeRole(owner, admin, "MEMBER"));
    assert.ok(!canChangeRole(owner, member, "MEMBER"), "no-op change");
    assert.ok(!canChangeRole(owner, member, "OWNER"), "no ownership grant");
    assert.ok(!canChangeRole(owner, { userId: "u-owner2", role: "OWNER" }, "ADMIN"), "an owner membership is protected");
    assert.ok(!canChangeRole(owner, owner, "ADMIN"), "not on oneself");
    assert.ok(!canChangeRole(admin, member, "ADMIN"), "admins cannot promote");
    assert.ok(!canChangeRole(admin, admin, "MEMBER"));
    assert.ok(!canChangeRole(member, member, "ADMIN"), "no self-promotion");
    assert.ok(!canChangeRole(member, member2, "ADMIN"));
  });
});

describe("removal", () => {
  it("owners remove admins and employees, admins remove employees, anyone but an owner may leave", () => {
    assert.ok(canRemoveMember(owner, admin));
    assert.ok(canRemoveMember(owner, member));
    assert.ok(canRemoveMember(admin, member));
    assert.ok(!canRemoveMember(admin, admin2), "admins cannot remove admins");
    assert.ok(!canRemoveMember(admin, owner));
    assert.ok(!canRemoveMember(member, member2));
    assert.ok(canRemoveMember(member, member), "leave");
    assert.ok(canRemoveMember(admin, admin), "leave");
    assert.ok(!canRemoveMember(owner, owner), "the owner cannot leave (no ownerless organization)");
  });
});

describe("suspension", () => {
  it("owners suspend admins and employees, admins only employees", () => {
    assert.ok(canSuspendMember(owner, admin));
    assert.ok(canSuspendMember(owner, member));
    assert.ok(canSuspendMember(admin, member));
    assert.ok(!canSuspendMember(admin, admin2));
    assert.ok(!canSuspendMember(member, member2));
  });

  it("never an owner, never oneself", () => {
    assert.ok(!canSuspendMember(admin, owner));
    assert.ok(!canSuspendMember({ userId: "u-owner2", role: "OWNER" }, owner));
    assert.ok(!canSuspendMember(admin, admin));
    assert.ok(!canSuspendMember(owner, owner));
  });
});
