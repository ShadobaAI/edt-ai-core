# Testability

Читай только после конкретного препятствия deterministic тесту. Остановись на
первом достаточном варианте:

```text
public product API
→ existing semantic fixture / public YaXUnit data API
→ supported installed YaXUnit mock for an external boundary
→ test-only seam in the profile's test extension
→ separately authorized product seam
→ unsupported
```

Ищи в `yaxunit` corpus только ещё неизвестный mock/seam API. Не повторяй уже
достаточный поиск. Test-only aliases/overrides/wrappers остаются в test owner,
минимальны, явно тестовые и не содержат бизнес-логику. Framework repository
остаётся read-only. Production seam требует самостоятельного разрешения после
оценки предыдущих вариантов; тестовый запрос его не подразумевает.
