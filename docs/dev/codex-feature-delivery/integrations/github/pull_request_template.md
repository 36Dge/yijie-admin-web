## Feature Delivery

- Feature Package: <!-- repository-relative path, for example docs/features/FEAT-001-example -->
- Required Gate: <!-- G3 or G4, matching .feature-delivery.yaml.ci.required_gate -->
- Authorization Decision: <!-- exact Decision ID covering this change -->
- Evidence: <!-- relevant immutable Evidence IDs/URIs -->

## Change summary

<!-- Describe the user-visible outcome and the exact repository/path scope. -->

## Verification

- [ ] The Feature Package manifest, Evidence ledger and Decision ledger validate.
- [ ] Changed paths are exactly covered by the current authorization.
- [ ] Commands and tool versions match `.feature-delivery.yaml.tooling` or are explicitly documented as project-specific exceptions.
- [ ] Boundary, migration, security, data and release impacts are declared when applicable.
- [ ] No approval private key, secret, mutable artifact reference or real sensitive data is included.
- [ ] Runtime TCB/governance changes are isolated and use the protected out-of-band digest flow.

## Reviewer notes

<!-- Record residual risks, follow-ups and the appropriate Gate owner. -->
