// Operator CLI. Run via npm scripts (loads .env.local):
//   npm run admin -- tenant --id acme --name "Acme Inc" --merchant MERCHANT1,MERCHANT2
//   npm run admin -- key    --tenant acme --role admin --label "ops laptop" --days 90
//   npm run admin -- key    --tenant acme --role agent --label "shopping agent"
//   npm run admin -- revoke --tenant acme --key-id <uuid>
//   npm run admin -- add-merchant --tenant acme --merchant MERCHANT_ID
//   npm run admin -- list-keys --tenant acme
//   npm run admin -- rotate --tenant acme --key-id <uuid>      (issues a replacement, then revokes the old key)
//   npm run admin -- anchor
// Keys (and the admin TOTP secret) are printed ONCE and never stored in recoverable form
// (the TOTP seed is stored sealed with SENTINEL_MASTER_KEY).
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from "../src/lib/auth/keys.ts";
import { createTenant, registerMerchant } from "../src/lib/db/store.ts";
import { createAnchor } from "../src/lib/db/anchor.ts";
import { otpauthUri } from "../src/lib/auth/totp.ts";
import { db } from "../src/lib/db/client.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < rest.length; i += 2) flags.set(rest[i].replace(/^--/, ""), rest[i + 1] ?? "");
const need = (k: string) => {
  const v = flags.get(k);
  if (!v) { console.error(`missing --${k}`); process.exit(2); }
  return v;
};

try {
  switch (cmd) {
    case "tenant": {
      const id = need("id");
      await createTenant(id, flags.get("name") ?? id);
      for (const m of (flags.get("merchant") ?? "").split(",").filter(Boolean)) await registerMerchant(id, m);
      console.log(`tenant '${id}' created`);
      break;
    }
    case "key": {
      const role = need("role");
      if (role !== "admin" && role !== "agent") { console.error("--role must be admin|agent"); process.exit(2); }
      const days = Number(flags.get("days") ?? 0);
      const k = await createApiKey({ tenantId: need("tenant"), role, label: flags.get("label"), expiresAt: days > 0 ? new Date(Date.now() + days * 86_400_000) : undefined });
      console.log(`key id : ${k.id}\nkey    : ${k.key}   <- shown once, store it in your secret manager`);
      if (k.totpSecret) console.log(`TOTP   : ${k.totpSecret}\nURI    : ${otpauthUri(k.totpSecret, `${need("tenant")}:${flags.get("label") ?? k.id.slice(0, 8)}`)}\n(add the secret to an authenticator app now; it is not shown again)`);
      break;
    }
    case "add-merchant":
      await registerMerchant(need("tenant"), need("merchant"));
      console.log(`merchant '${need("merchant")}' registered to tenant '${need("tenant")}'`);
      break;
    case "list-keys":
      console.table((await listApiKeys(need("tenant"))).map((k) => ({ id: k.id, role: k.role, label: k.label, prefix: k.prefix, created: k.createdAt, expires: k.expiresAt, revoked: k.revokedAt, lastUsed: k.lastUsedAt })));
      break;
    case "rotate": {
      const k = await rotateApiKey(need("key-id"), need("tenant"));
      console.log(`new key id : ${k.id}\nnew key    : ${k.key}   <- shown once; the old key is now revoked`);
      if (k.totpSecret) console.log(`new TOTP   : ${k.totpSecret}   <- re-enrol in your authenticator app`);
      break;
    }
    case "revoke":
      console.log((await revokeApiKey(need("key-id"), need("tenant"))) ? "revoked" : "no active key with that id in that tenant");
      break;
    case "anchor":
      console.log(JSON.stringify(await createAnchor() ?? { anchored: false }));
      break;
    default:
      console.error("usage: admin <tenant|add-merchant|key|list-keys|rotate|revoke|anchor> [--flag value ...]");
      process.exit(2);
  }
} finally {
  await db().end().catch(() => {});
}
