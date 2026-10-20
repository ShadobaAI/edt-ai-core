---
name: task-orchestration
description: Use for bounded independent workstreams and read-only review on complex 1C tasks.
---

# Task orchestration

Применяй для независимых исследований/работ, сложных, архитектурных или H
изменений и существенной пользы свежего reviewer. Соблюдай выбор пользователя
о делегировании; простое scoped изменение не требует workers.

Каждому worker передай только `goal`, `scope`, `known_facts`, `constraints`,
`authoritative_sources`, `expected_output`, профиль выбранного каталога и точные
repository/authority bindings. Запроси `conclusion`, `evidence`, `risks`, `unknowns`.
Не импортируй полный transcript и не расширяй mutation scope через найденную
зависимость. Production/tests одного репозитория сохраняют отдельное владение;
разные репозитории — отдельно разрешённые границы записи.

Для H/public API, schema, сложной логики и межкомпонентных изменений нужен свежий
read-only reviewer по [контракту результата](references/reviewer.md). Он не
исправляет находки и не считает runtime pass доказательством норм. Исправление
происходит в implementation phase с повторной проверкой затронутого результата.
Durable выводы сохраняй в owning SDD/ADR/docs по проектным инструкциям;
handoff между задачами/разработчиками содержит только bounded evidence.

Если делегирование недоступно или пользователь его запретил, не подменяй
независимое ревью self-review: выполни доступные проверки и отметь этот gate как
невыполненный. Это не отменяет разрешённую независимую часть работы и не даёт
права объявить полную приёмку H.
