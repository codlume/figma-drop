# Repository settings snapshot

Read-only queries run 2026-11-08T15:39:22Z with the owner's gh session. No setting was changed.

$ gh api repos/codlume/figma-drop --jq '{owner_type:.owner.type,visibility,default_branch,allow_squash_merge,allow_merge_commit,allow_rebase_merge,allow_auto_merge,delete_branch_on_merge}'

```json
{
  "allow_auto_merge": false,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "allow_squash_merge": true,
  "default_branch": "main",
  "delete_branch_on_merge": false,
  "owner_type": "Organization",
  "visibility": "public"
}
```

$ gh api repos/codlume/figma-drop/actions/permissions

```json
{ "enabled": true, "allowed_actions": "all", "sha_pinning_required": false }
```

$ gh api repos/codlume/figma-drop/actions/permissions/workflow

```json
{ "default_workflow_permissions": "write", "can_approve_pull_request_reviews": true }
```

$ gh api repos/codlume/figma-drop/branches/main/protection

```json
{
  "message": "Branch not protected",
  "documentation_url": "https://docs.github.com/rest/branches/branch-protection#get-branch-protection",
  "status": "404"
}
```

$ gh api repos/codlume/figma-drop/rulesets

```json
[]
```

$ gh api repos/codlume/figma-drop/rules/branches/main

```json
[]
```

$ gh api repos/codlume/figma-drop/actions/secrets --jq {total_count}

```json
{ "total_count": 0 }
```

$ gh api repos/codlume/figma-drop/actions/variables --jq {total_count}

```json
{ "total_count": 0 }
```

$ gh api repos/codlume/figma-drop/environments --jq {total_count}

```json
{ "total_count": 0 }
```

$ gh api orgs/codlume/actions/permissions/workflow

```json
{
  "message": "You must be an org admin or have the actions policies fine-grained permission.",
  "documentation_url": "https://docs.github.com/rest/actions/permissions#get-default-workflow-permissions-for-an-organization",
  "status": "403"
}
```

$ gh api repos/codlume/figma-drop/commits/17a7e188ff69ef341af17b554f0aaa5d7f8ee090/check-runs --jq ...

```json
{"app":"github-actions","conclusion":"success","name":"plan","title":null}
{"app":"github-actions","conclusion":"success","name":"package","title":null}
{"app":"macroscopeapp","conclusion":"skipped","name":"Macroscope - Correctness Check","title":"Review skipped — billing issue"}
```

The org-level workflow policy is unreadable with this token (403). The repo-level `can_approve_pull_request_reviews: true` is the effective repo value. No branch protection, ruleset, or required check exists. Macroscope skipped for a billing issue, so it is not a completed correctness review.
