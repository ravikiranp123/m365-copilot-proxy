# Account Profiles (Proposal)

Goal
- Allow per-user/tenant routing, quotas, and agent settings via model ID prefix: m365/<profile>/<model>.

Contract
- Clients MAY send prefixed model IDs; proxy strips the prefix for routing/tones.
- Profile name is attached to session metadata/logs for analysis.
- /v1/models MAY remain unprefixed initially; expansion to advertise prefixed IDs is optional.

Examples
- m365/ato/gpt-6.1-sol → profile=ato, model=gpt-6.1-sol
- m365/user2/gpt-6-sol → profile=user2, model=gpt-6-sol

Next
- Handler: parse profile/model; pass underlying model to tone/route; tag logs with profile.
- Optional: header override (X-M365-Profile) when clients cannot alter model IDs.
