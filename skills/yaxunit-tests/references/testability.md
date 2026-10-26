# Testability

Read only after a specific obstacle to deterministic testing. Stop at the first
sufficient option:

```text
public product API
→ existing semantic fixture / public YaXUnit data API
→ supported installed YaXUnit mock for an external boundary
→ test-only seam in the profile's test extension
→ separately authorized product seam
→ unsupported
```

Search the `yaxunit` corpus only for unknown mock/seam APIs. Do not repeat already
sufficient searches. Test-only aliases/overrides/wrappers remain in the test owner,
minimal, explicitly test-specific and without business logic. The framework
repository remains read-only. Production seams need separate permission after
assessing earlier options; test requests do not imply it.
