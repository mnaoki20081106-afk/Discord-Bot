import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

function sliceBetween(startText, endText) {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  assert.notEqual(start, -1, `missing start: ${startText}`);
  assert.notEqual(end, -1, `missing end: ${endText}`);
  return source.slice(start, end);
}

test("single-channel permission writes obtain a Security maintenance lease", () => {
  const route = sliceBetween(
    "const channelPermissionMatch=url.pathname.match(",
    "const channelItemMatch=url.pathname.match("
  );

  assert.match(
    route,
    /await requireGuild\(request,env,guildId\)/,
    "permission writes must use requireGuild so the dashboard_edit lease is opened"
  );
});

test("Discord 403 permission writes recover Main Bot access through Security Bot", () => {
  const route = sliceBetween(
    "const channelPermissionMatch=url.pathname.match(",
    "const channelItemMatch=url.pathname.match("
  );

  assert.match(route, /writeResponse\.status===403/);
  assert.match(route, /repairMainBotChannelAccessViaSecurity/);
  assert.match(route, /applyChannelRolePermissionsFast/);
  assert.match(route, /security-bot-repair-readback/);
});

test("Security access repair is constrained to the current guild and channel", () => {
  const helper = sliceBetween(
    "async function repairMainBotChannelAccessViaSecurity(",
    "async function requireGuild("
  );

  assert.match(
    helper,
    /\/internal\/guilds\/\$\{guildId\}\/main-bot\/channels\/\$\{channelId\}\/access/
  );
  assert.match(helper, /method:"POST"/);
});


test("ticket creation remains available when the Security bridge is offline", () => {
  const route = sliceBetween(
    'if(id==="ticket:create"){',
    'if(id==="ticket:close"){'
  );

  assert.doesNotMatch(
    route,
    /requireMainSecurityLease/,
    "non-destructive ticket creation must not depend on Security availability"
  );
  assert.match(route, /createTicketFromInteraction/);
});

test("deferred Discord permission failures surface an actionable message", () => {
  const helper = sliceBetween(
    "function deferredInteractionErrorMessage(",
    "async function failDeferredInteraction("
  );

  assert.match(helper, /error\.status===403/);
  assert.match(helper, /チャンネルの管理/);
});
