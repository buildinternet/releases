-- Better Auth organization plugin ("Workspaces") — user tenancy, DELIBERATELY DISTINCT
-- from the registry `organizations` table (plural), which is the indexed vendors. The
-- SQL names differ (`organization` singular vs `organizations` plural), so D1 sees two
-- separate tables — no collision. Plus the @better-auth/stripe `subscription` table
-- (referenceId = workspace id) — the inert org-billing seam (nothing is purchasable
-- yet; see auth/index.ts buildStripePlugin `plans: []`).
--
-- Paired with workers/api/src/db/schema-auth.ts (the ci.yml schema↔migration gate
-- watches that file). Timestamps are integer epoch-ms (Better Auth's Drizzle shape);
-- the organization/member field set mirrors the plugin's schema (organization has no
-- updated_at), the subscription field set mirrors @better-auth/stripe's `subscriptions`
-- model. `member.role` is the org role (owner/admin/member), NOT `user.role`.

CREATE TABLE organization (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  metadata text,
  created_at integer NOT NULL
);

CREATE TABLE member (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  created_at integer NOT NULL
);
CREATE INDEX idx_member_organization_id ON member(organization_id);
CREATE INDEX idx_member_user_id ON member(user_id);

CREATE TABLE invitation (
  id text PRIMARY KEY NOT NULL,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  expires_at integer NOT NULL,
  created_at integer NOT NULL,
  inviter_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_invitation_organization_id ON invitation(organization_id);

CREATE TABLE subscription (
  id text PRIMARY KEY NOT NULL,
  plan text NOT NULL,
  reference_id text NOT NULL,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text NOT NULL DEFAULT 'incomplete',
  period_start integer,
  period_end integer,
  trial_start integer,
  trial_end integer,
  cancel_at_period_end integer,
  cancel_at integer,
  canceled_at integer,
  ended_at integer,
  seats integer,
  billing_interval text,
  stripe_schedule_id text
);
CREATE INDEX idx_subscription_reference_id ON subscription(reference_id);

ALTER TABLE session ADD COLUMN active_organization_id text;
ALTER TABLE user ADD COLUMN last_active_organization_id text;
