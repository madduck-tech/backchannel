# Architecture Decision Records

| № | Решение | Статус |
|---|---|---|
| [0001](0001-foundation-conversationaly-fork.md) | Фундамент: hard fork Conversationaly в `madduck-tech/backchannel` | принято |
| [0002](0002-stt-russian-recommendation.md) | STT для русского: каталог как есть, рекомендация по языку встреч | принято |
| [0003](0003-two-stt-streams-resource-budget.md) | Два STT-потока: экземпляры моделей и бюджет ресурсов | принято |
| [0004](0004-echo-cancellation-scope.md) | Эхо: без AEC в MVP, предупреждение о динамиках, gate по остатку времени | принято |
| [0005](0005-platform-support-tiers.md) | Уровни поддержки платформ, разработка только на Linux | принято |
| [0006](0006-proactive-mode-design.md) | Проактивный режим: механика уровней | принято |
| [0007](0007-observation-schema-versioning.md) | Версионирование схемы observations | принято |
| [0008](0008-latency-targets.md) | Целевые latency Milestone 0 и способ измерения | принято |
| [0009](0009-positioning-share-protection.md) | Позиционирование: share protection, а не stealth | принято |

## Отложенные вопросы

- **Embeddings в MVP.** Knowledge требует индексации, значит дефолтная embedding-модель нужна даже если
  пользователь о ней не знает. Спека откладывает выбор embeddings (§18). Решение отложено 2026-09-01:
  вернуться при проектировании Knowledge/RAG.
