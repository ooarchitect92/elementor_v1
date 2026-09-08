# Engineering rules for humans and coding agents

Start with `docs/team/START_HERE.md` and the F/P/G/S work-package IDs. Scope each branch/PR to a work package.
Preserve existing frontend components and behavior unless the task explicitly changes them. Never rename
or replace the 16k-line editor wholesale. Verify every file/function against the checkout before citing it.

Do not expose draft APIs as public published-site APIs. A tenant ID from a header/body is not authority;
resolve a verified session and persisted membership first. Do not log tokens, passwords, raw lead data,
or connection URLs. Do not modify customer WordPress content without approved version/ownership checks.

No runtime DDL, automatic production `db push`, implicit production migrations, or test credentials in source.
No fake successful CRM/SFTP/webhook results. Unsupported actions must remain explicitly unsupported.
A successful broker send is not a successful business operation. Durable outcome precedes consumer ACK.
Unknown external outcomes go to reconciliation, not blind retry. Fence stale workers using DB leases.

Run `npm run check` and PHP foundation checks for this increment. Run service integration and applicable
legacy tests when changing those areas. Tests using fake transport ports are not live broker verification.
Record commands, results, environment and limitations in release evidence. Do not claim a whole work
package complete based on a folder, interface or passing unit test. Never enable placeholder workers.

Review changes in PRs. Do not force-push, rewrite protected history, assign people without their handles,
or merge/deploy automatically merely because a scaffold exists. Preserve the source's license obligations.
