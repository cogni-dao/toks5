-- Reverted identity adoption (toks5 PR #59, reverted by #62). #59 ran its migrations 0033-0036 on the candidate-a database, and
-- the revert removed the files, not the objects, so that database still holds #59's agent tables and wallet-binding trigger.
-- The node-template identity migrations below (0036-0044) create the same names with a different shape and would fail on them.
-- Every statement is IF EXISTS, so this is a no-op on a database that never ran #59 (fresh, production). Nothing reads these
-- tables since the revert; the identity migrations recreate them and 0037 reseeds the internal principals.
DROP TRIGGER IF EXISTS "agent_principals_no_wallet_binding" ON "user_bindings";--> statement-breakpoint
DROP FUNCTION IF EXISTS agent_principals_refuse_wallet_binding();--> statement-breakpoint
DROP FUNCTION IF EXISTS agent_credential_state(agent_credentials);--> statement-breakpoint
DROP TABLE IF EXISTS "agent_claims" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_spawn_grants" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_credentials" CASCADE;--> statement-breakpoint
DROP FUNCTION IF EXISTS agent_credentials_require_external_principal();--> statement-breakpoint
DROP TABLE IF EXISTS "agent_roles" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "agent_principals" CASCADE;
