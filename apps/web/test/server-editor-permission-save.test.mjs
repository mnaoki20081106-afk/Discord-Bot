import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/ServerEditor.tsx", import.meta.url), "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`  async function ${name}`);
  const end = source.indexOf(`  async function ${nextName}`, start);
  assert.notEqual(start, -1, `${name} must exist`);
  assert.notEqual(end, -1, `${nextName} must exist after ${name}`);
  return source.slice(start, end);
}

test("main channel save persists changed role permissions", () => {
  const body = functionBody("saveExisting", "createItem");

  assert.match(
    body,
    /permissionChanged[\s\S]*persistChannelPermissions\(/,
    "the main save action must write changed role permissions"
  );
  assert.match(
    body,
    /if \(metadataChanged\)[\s\S]*\/api\/guilds\//,
    "channel metadata should still be saved when it changed"
  );
  assert.match(
    body,
    /if \(permissionChanged \|\| metadataChanged\)[\s\S]*await onRefresh\(\)/,
    "the dashboard should refresh after either kind of persisted change"
  );
});

test("permission-only main save avoids the generic channel PATCH", () => {
  const body = functionBody("saveExisting", "createItem");
  const permissionIndex = body.indexOf("persistChannelPermissions(");
  const metadataGuardIndex = body.indexOf("if (metadataChanged)");
  const genericPatchIndex = body.indexOf("await api(`/api/guilds/");

  assert.ok(permissionIndex >= 0, "permission persistence call must exist");
  assert.ok(metadataGuardIndex > permissionIndex, "metadata save must be separately guarded");
  assert.ok(genericPatchIndex > metadataGuardIndex, "generic channel PATCH must stay inside metadataChanged");
});

test("main action is labeled as saving all channel changes", () => {
  assert.match(source, /すべての変更を保存/);
});
