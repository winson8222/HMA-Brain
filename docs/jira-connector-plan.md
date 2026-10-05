# Jira connector: permissions plan and fit with Slack and Drive

[← Back to README](../README.md) · [Developer guide](developer-guide.md)

Code: `src/connectors/jira/`. It follows the Drive layout (own indexes, pure `acl.ts` / `docs.ts`, a `client.ts`, `store.ts`, `sync.ts`, `query.ts`, and a `Connector` in `index.ts`). It plugs into federated Search/Ask through the registry in `src/connectors/index.ts` and only loads when `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` are set.

```
npm run jira:doctor      # token, admin permission, schemes readable, Connect Jira set up, who's linked
npm run jira:backfill    # index every in-scope project (--reset rebuilds brain-jira only)
npm run jira:poll        # issues updated + permission changes since the last run (--watch to keep going)
```

## 1. How Jira decides who can see an issue

Jira's permission model has more layers than Slack's or Drive's:

| Layer | What it is | Who it can grant |
|---|---|---|
| **Browse Projects** | A permission in the project's *permission scheme*. You can't see any issue in a project without it. | Anyone (anonymous), any logged-in user (product access), groups, project roles, single users, project lead, the issue's reporter, the issue's assignee, user/group picker fields, Service Management customers |
| **Project roles** | Per-project membership (e.g. "Developers" in PAY). Schemes grant to roles, and each project fills the roles differently. | Users and groups |
| **Issue security level** | Optional, per issue. The person must be a member of the level **and** have Browse Projects. | Same holder types as above |
| **Comment / worklog visibility** | A single comment can be limited to a role or group. | Role or group |
| **Team-managed projects** | Simpler access settings (open / limited / private) and their own roles. They don't use shared schemes. | Roles in that project |

## 2. How the connector handles it (built)

**Core rule, unchanged: permissions are enforced before the LLM.** Labels filter inside the Elasticsearch query. Then Jira itself re-checks every hit live, as the asker.

### At index time: two labels per issue

| Field | Contents | Built from |
|---|---|---|
| `acl_container` | Who passes Browse Projects | Permission scheme grants. Project roles are expanded into their users and groups. Reporter, assignee and project lead are resolved for each issue, and so are the people or groups named in a **user/group picker field** the scheme grants (e.g. "Approvers"). Those fields are fetched with every issue in that project. |
| `restricted` + `acl_item` | The members of the issue's security level, if it has one | The security scheme's level members, resolved the same way |

Principals are namespaced by site: `jira:<site>:user:<accountId>`, `jira:<site>:group:<groupId>`, `jira:<site>:loggedin`, `jira:<site>:anyone`. Groups are keyed by **group ID**, not name, because group names can be changed.

A person may see an issue when `acl_container ∩ keys ≠ ∅` **and** (`restricted = false` **or** `acl_item ∩ keys ≠ ∅`). This is the "container and item" case the developer guide planned for. It goes in the `bool.filter` and inside the `knn.filter` (`acl.ts jiraFilter()`).

### At query time: the asker's keys come from an explicit link, not email

Each person links their own Atlassian account once with **Connect Jira** on the Connect page (`auth.ts`, `routes.ts`):

1. The signed-in person clicks Connect Jira and approves Atlassian's `read:me` scope (OAuth 2.0 3LO).
2. Atlassian returns their **account ID** (`GET api.atlassian.com/me`). The app stores only `person → account ID` in `brain-jira-state`. **Their token is never saved**: searching still runs as the service account, with Jira's own permission check for that account ID.
3. The signed OAuth `state` names who started Connect, and the callback links only if that same person is still signed in in that browser. So nobody can trick someone else into linking their Atlassian account to the wrong person.
4. One Atlassian account belongs to one person. Linking it again moves the link. Disconnect deletes the link.

`people.ts` then takes that account ID and adds its groups and whether it has product access. These are cached for 5 minutes. **Not linked means nothing from Jira** (fail closed). There is no email matching at all, so a different, hidden or renamed email doesn't matter. People known only by a workspace-scoped Slack ID can link too.

### Live re-check: Jira is the authority

Before anything is shown or given to the LLM, `POST /rest/api/3/permissions/check` asks Jira which of the matching issues the asker can `BROWSE_PROJECTS` right now. Jira evaluates its full model: schemes, roles, groups, security levels, reporter/assignee rules, custom-field grants, and deleted issues. Any error withholds every Jira hit.

This also makes the label approximations safe in one direction:

- **Labels too broad** (e.g. "any logged-in user" treated as "has some product access"): the live check removes the extra results.
- **Labels too narrow** (holder types we skip): those people miss results they could see in Jira. This is safe, just incomplete.

### What changes and how it's picked up

| Change | How it reaches the index | Gap covered by |
|---|---|---|
| Issue created or edited (text, assignee, security level) | Poll: `updated >= <cursor − 2 min>` in the service account's **time zone** (JQL dates have no offset) | Live check |
| Scheme, role member or security level member changed (doesn't touch `updated`) | Every poll re-reads each project's permission picture. If its hash changed, the whole project is relabelled. | Live check |
| Group membership changed | Asker's keys refresh within 5 min | Live check |
| Issue deleted | Reconcile sweep (`JIRA_RECONCILE_MINUTES`) diffs IDs. Backfill does too. | Live check: a deleted issue isn't browsable |
| Project permissions unreadable | Project's docs are **removed** until they can be read | n/a |
| Restricted comment | Never indexed | n/a |

### Setup requirements

- **Connect Jira OAuth app** (`JIRA_OAUTH_CLIENT_ID` / `JIRA_OAUTH_CLIENT_SECRET`): developer.atlassian.com → OAuth 2.0 integration → User identity API (`read:me`) → callback `<PUBLIC_URL>/connect/jira/callback`.
- Service account: an API token for a dedicated account (not a persona, the same lesson as Drive's admin).
- Browse on every in-scope project.
- The **Administer Jira** global permission. Without it, schemes can't be read and `permissions/check` can't be asked about other users, so every result is withheld. `jira:doctor` reports this.

## 3. Next steps (not built yet), in order

1. **Verify on the demo site.** Seed a `PAY` project (Drive's seeded runbooks already point at "the PAY Jira project") and a `SEC` project with a security level. Then confirm `permissions/check` respects security levels for the `issues` form. Capture real payloads into `fixtures/jira/`, the way Drive did.
2. **Restricted comments as their own chunks.** Give them a third label (the comment's role or group) and require all three layers, instead of dropping them.
3. ~~**User / group picker grants**~~ **Done**: `userCustomField` / `groupCustomField` grants name a field. That field's value on each issue (single or multi picker, groups by ID) becomes labels. Changing the field updates the issue's `updated` time, so the next poll relabels it.
4. **Team-managed projects.** Check what the permission-scheme endpoint returns for them on the real site. If it's unusable, map the access level instead (open → `loggedin`, limited/private → that project's role members).
5. **Jira Service Management.** Customer-portal-only access (`sd.customer.portal.only`) and organizations. Keep these out until there's a portal-user story, because agents and customers see different things.
6. **Webhooks** (`jira:issue_updated`, `jira:issue_deleted`, `project_updated`, `user_updated`, group changes) for near-real-time updates. Keep polling as the fallback, the way Drive keeps reconcile.
7. **Search as the person.** Optional. Connect Jira already uses per-person OAuth for identity. Keeping a refresh token with Jira read scopes would let the app search *as* the person instead of service account + `permissions/check`, which removes the need for Administer Jira. The cost is storing a token per person (like Slack DMs).
8. **`jira:verify`.** Issue counts and labels in Jira vs the index, per project.

## 4. Conflicts with the Slack and Drive connectors

**No blocking conflicts.** Each point below says why, or what to watch.

| Area | Assessment |
|---|---|
| **Indexes** | Separate `brain-jira` / `brain-jira-state`. Slack (`brain`) and Drive (`brain-drive`) backfills, `--reset` and reconciles never touch them, and the other way round. The kNN query names its index explicitly. Without that, kNN would run across every index. |
| **Permission labels** | Every label is prefixed `jira:<site>:`. They can't collide with `slack:<team>:`, `person:<email>` (Slack DMs) or `drive:`. Jira uses its own `jiraFilter` (two layers), so the shared `aclFilter` used by Slack and Drive is unchanged. |
| **Identity** | Linked explicitly with Connect Jira (person → Atlassian account ID), not by email, so differing emails across Slack, Google and Atlassian don't matter. The link is keyed by the same person ID as the Slack login cookie. **Watch:** Connect Jira needs the person signed in (today that's via Slack Connect). In Demo mode, each persona must sign in and connect once, or they see nothing from Jira. Drive still matches by email. |
| **Federated Search/Ask** | No changes needed. Jira is one more entry in the registry. RRF merges its ranking with the others, and the reranker and audit log handle it like any source. Each source fetches `size × 2` before the merge, so with three sources each one's share of the top results shrinks a bit. Watch answer quality, and raise the per-source fetch if Jira crowds out Slack or Drive (or the other way round). |
| **Failure isolation** | `retrieveAll` already catches per-source failures. A Jira outage or a missing admin permission marks Jira "unavailable" and returns nothing from it. Slack and Drive keep working. |
| **Embeddings** | Shares `EMBEDDING_MODEL` / `EMBEDDING_DIMS`. Changing dims needs a reset of **all three** indexes (`backfill`, `drive:backfill --reset`, `jira:backfill --reset`). |
| **Sync loops** | Each connector has its own `busy` flag and timer, and they share only Elasticsearch. Unlike `SLACK_SYNC`, several servers can run `JIRA_SYNC=on` safely (polling, idempotent writes). Jira's rate limits are separate from Google's and Slack's. |
| **Connect page** | Adds a Jira card under the Slack workspaces (shown only when the Jira connector is loaded). The Slack flow is unchanged. |
| **Env / config** | Only new `JIRA_*` variables. Nothing is renamed. `ALLOW_IMPERSONATION`, `ADMIN_TOKEN` and the audit key are shared as before. |
| **Shared code** | Connect Jira reuses `session.ts` (`sign`/`verify` for the OAuth state, `getSession` for who's signed in), as Slack's Connect does. No imports from the Drive connector. |
| **Ask prompt** | The keyword rewrite now lists "Jira" among the sources. Issue keys (`PAY-240`) get an exact-match boost in Jira's own query, so they still work if the rewrite drops them. The `answerHint` asks the model to cite issue keys. |
| **Tencent ADP answerer** (uncommitted on `adp-ask`) | Compatible. `generateAnswer` receives only already-permitted evidence, whichever source it came from. The rule that ADP must not hold its own copy of company documents applies to Jira content too. |
| **Tests** | `federated.test.ts` mocks the registry, so `pickConnectors(["jira"])` still throws there even when Jira is configured locally. |
